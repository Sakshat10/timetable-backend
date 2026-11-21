// Module 11 - Phase 7F-2: PROOF that cloning keeps the draft cap and every version consistent under concurrency, on REAL PostgreSQL.
//
// Invariant:   drafts(year) + activeRuns(year) <= MAX_DRAFTS_PER_YEAR      (the clone uses the CLONE rule of the shared draft-slot helper)
//
//   K1  clone x clone                 K5  clone x edit of the source (lock changes)
//   K2  clone x enqueue               K6  clone x delete of the source
//   K3  clone x persist (held)        K7  clone x publish of the source
//   K4  reservation, then persist     K8  deadlock stress: clones, deletes, edits, enqueues and persists together
//
// The REAL clone service (TimetableVersionCloneService) is used with a large connection pool and a long lock timeout, so serialised
// clones on a remote database wait instead of answering 503 BUSY (BUSY itself is tested in the API suite).
//
// Run with   NODE_ENV=production npx tsx test-timetable-version-clone-concurrency.ts
import 'dotenv/config'; // first: the database pool is created when a module imports src/config/database.ts
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { DraftLimitReachedError, LeaseLostError, persistGeneratedVersionOnce, type PersistParams } from './src/modules/timetable-generation/timetable-generation.final-persist.js';
import { loadGenerationSnapshot } from './src/modules/timetable-generation/timetable-generation.loader.js';
import { evaluateMetrics } from './src/modules/timetable-generation/timetable-generation.metrics.js';
import { normalizeProblem } from './src/modules/timetable-generation/timetable-generation.normalizer.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { RunRepository } from './src/modules/timetable-generation/timetable-generation.run-repository.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { TimetableVersionCloneService } from './src/modules/timetable-version/timetable-version.clone-service.js';
import { TimetableVersionEditService } from './src/modules/timetable-version/timetable-version.edit-service.js';
import { VersionRuleError } from './src/modules/timetable-version/timetable-version.errors.js';
import { TimetableVersionPublishService } from './src/modules/timetable-version/timetable-version.publish-service.js';
import { TimetableVersionService } from './src/modules/timetable-version/timetable-version.service.js';
import {
  assertQueueIsEmpty, captureLogger, createWorld, destroyWorld, EXISTING_TABLES, fastConfig, fingerprint, getRun, mustEnqueue, newTableCounts, prisma, rawPrisma, ScriptedSolver, seedYear, sleep,
  solution, validEntries, waitTerminal, type SeededYear, type SolveCtx, type World,
} from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const errText = (e: unknown): string => `${(e as Error)?.message ?? e} ${(e as { code?: string })?.code ?? ''} ${JSON.stringify((e as { meta?: unknown })?.meta ?? {})}`;
const CAP = 6;
const tally = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
const deferred = <T = void>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const settledFlag = <T,>(p: Promise<T>) => { const f = { done: false }; void p.finally(() => { f.done = true; }); return f; };

const bigPool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 40, connectionTimeoutMillis: 60_000, keepAlive: true });
const big = new PrismaClient({ adapter: new PrismaPg(bigPool) });
const samplerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 3, connectionTimeoutMillis: 60_000, keepAlive: true });
const samplerDb = new PrismaClient({ adapter: new PrismaPg(samplerPool) });
const cloneSvc = new TimetableVersionCloneService({ prisma: big as never, lockTimeoutSeconds: 120 });
const editSvc = new TimetableVersionEditService(big as never);
const versionSvc = new TimetableVersionService(big as never);
const publishSvc = new TimetableVersionPublishService(big as never);
const repo = new RunRepository(big as never);

async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();
  const world: World = await createWorld('M11KC');
  const admin = { id: world.adminId, schoolId: world.schoolId };
  const savedCap = process.env.MAX_DRAFTS_PER_YEAR;
  process.env.MAX_DRAFTS_PER_YEAR = String(CAP);

  const addDrafts = async (yearId: string, n: number): Promise<void> => {
    const max = (await prisma.timetableVersion.aggregate({ where: { academicYearId: yearId }, _max: { versionNumber: true } }))._max.versionNumber ?? 0;
    await prisma.timetableVersion.createMany({
      data: Array.from({ length: n }, (_, i) => ({ schoolId: world.schoolId, academicYearId: yearId, versionNumber: max + i + 1, status: 'DRAFT' as const, solutionSource: 'BASELINE' as const, solverStatus: 'FEASIBLE' as const, weightsVersion: 'V1', inputHash: 'x', inputSnapshot: {}, metrics: {}, baselineMetrics: {} })),
    });
  };
  const counts = async (yearId: string) => (await prisma.$queryRaw<Array<{ drafts: number; active: number }>>`SELECT (SELECT count(*) FROM "timetable_versions" WHERE "academicYearId" = ${yearId} AND "status" = 'DRAFT')::int AS drafts, (SELECT count(*) FROM "timetable_generation_runs" WHERE "academicYearId" = ${yearId} AND "status" IN ('QUEUED','RUNNING'))::int AS active`)[0]!;
  const failRuns = (yearId: string) => prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "academicYearId" = ${yearId} AND "status" IN ('QUEUED','RUNNING')`;
  /** Back to: the source and its restored lock flags, plus `extra` synthetic drafts; every clone, run and published/archived version removed. */
  const reset = async (yearId: string, sourceId: string, extra: number): Promise<void> => {
    await failRuns(yearId);
    await prisma.timetableVersion.deleteMany({ where: { academicYearId: yearId, id: { not: sourceId } } });
    await prisma.timetableVersion.update({ where: { id: sourceId }, data: { status: 'DRAFT', publishedAt: null, archivedAt: null, publishedById: null, revision: 1 } });
    await prisma.timetableEntry.updateMany({ where: { versionId: sourceId }, data: { isLocked: false } });
    await addDrafts(yearId, extra);
  };
  const startSampler = (yearIds: string[]) => {
    let running = true;
    const state = { max: new Map<string, number>(yearIds.map((y) => [y, 0])), samples: 0 };
    const loop = (async () => {
      while (running) {
        try {
          const rows = await samplerDb.$queryRaw<Array<{ y: string; total: number }>>`
            SELECT y.id AS y, ((SELECT count(*) FROM "timetable_versions" v WHERE v."academicYearId" = y.id AND v."status" = 'DRAFT')
                             + (SELECT count(*) FROM "timetable_generation_runs" r WHERE r."academicYearId" = y.id AND r."status" IN ('QUEUED','RUNNING')))::int AS total
            FROM "academic_years" y WHERE y.id = ANY(${yearIds})`;
          state.samples++;
          for (const r of rows) state.max.set(r.y, Math.max(state.max.get(r.y) ?? 0, r.total));
        } catch { await sleep(200); }
      }
    })();
    return { state, stop: async () => { running = false; await loop; } };
  };
  type Outcome = 'CREATED' | 'LIMIT' | 'NOT_FOUND' | `ERROR ${string}`;
  const cloneOp = async (sourceId: string, lockMode: 'KEEP' | 'ALL' | 'NONE' = 'KEEP'): Promise<{ outcome: Outcome; id?: string; lockedCount?: number }> => {
    try {
      const r = await cloneSvc.clone(admin, sourceId, lockMode);
      return { outcome: 'CREATED', id: r.id, lockedCount: r.lockedCount };
    } catch (e) {
      if (e instanceof VersionRuleError && e.code === 'DRAFT_LIMIT_REACHED') return { outcome: 'LIMIT' };
      if ((e as { statusCode?: number })?.statusCode === 404) return { outcome: 'NOT_FOUND' };
      return { outcome: `ERROR ${errText(e).slice(0, 200)}` };
    }
  };
  const enqueueInput = (yearId: string) => ({ schoolId: world.schoolId, academicYearId: yearId, requestedById: world.adminId, options: { seed: 1, reproducible: false }, timeLimitSeconds: 10, workers: 2, sectionCount: 3 });
  const claimRun = (id: string, token: string) => prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'RUNNING'::"TimetableRunStatus", "leaseOwner" = ${token}, "leaseExpiresAt" = now() + interval '120 seconds', "heartbeatAt" = now(), "startedAt" = now(), "attempts" = "attempts" + 1, "phase" = 'CLAIMED' WHERE "id" = ${id} AND "status" = 'QUEUED'::"TimetableRunStatus"`;
  const generate = async (year: SeededYear) => {
    const solver = new ScriptedSolver((ctx: SolveCtx) => solution(ctx.problem));
    const runner = new GenerationRunner({ prisma: rawPrisma, solverClient: solver, config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: 10 }, logger: captureLogger().logger });
    const queued = await mustEnqueue(world, year);
    await runner.dispatch();
    const run = await waitTerminal(queued.id, 90_000);
    await runner.stop(5);
    if (run.status !== 'SUCCEEDED') throw new Error(`setup: generation ${run.status} ${run.failureCode}`);
    return (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: run.versionId! } }));
  };
  let problemCache: { problem: ReturnType<typeof normalizeProblem> extends infer R ? (R extends { ok: true; problem: infer P } ? P : never) : never; entries: ReturnType<typeof validEntries> } | null = null;
  const persistParams = async (year: SeededYear, runId: string, token: string, extra: Partial<PersistParams> = {}): Promise<PersistParams> => {
    if (!problemCache) { const n = normalizeProblem(await loadGenerationSnapshot(prisma, world.schoolId, year.yearId)); if (!n.ok) throw new Error('not normalisable'); problemCache = { problem: n.problem as never, entries: validEntries(n.problem) }; }
    const { problem, entries } = problemCache;
    return {
      prisma: big as never, run: { id: runId, schoolId: world.schoolId, academicYearId: year.yearId, requestedById: world.adminId }, token, problem: problem as never, entries,
      version: { solutionSource: 'CP_SAT', solverStatus: 'FEASIBLE', weightsVersion: 'V1', metrics: evaluateMetrics(problem as never, entries), baselineMetrics: evaluateMetrics(problem as never, entries), solverDiagnostics: null },
      resultSummary: {}, lockTimeoutSeconds: 60, maxDraftsPerYear: CAP, ...extra,
    };
  };
  const persistOutcome = async (p: PersistParams): Promise<string> => { try { await persistGeneratedVersionOnce(p); return 'PERSISTED'; } catch (e) { return e instanceof DraftLimitReachedError ? 'DRAFT_LIMIT' : e instanceof LeaseLostError ? 'LEASE_LOST' : `ERROR ${errText(e).slice(0, 200)}`; } };

  try {
    const year = await seedYear(world, 'clone-race', { sections: 3 });
    const V0 = await generate(year);
    const baseEntries = await prisma.timetableEntry.findMany({ where: { versionId: V0.id }, orderBy: [{ sectionId: 'asc' }, { dayOfWeek: 'asc' }, { periodNumber: 'asc' }] });
    check('setup: a real generated source of 36 lessons', baseEntries.length === 36 && V0.status === 'DRAFT');
    const fullClones = async (yearId: string): Promise<boolean> => {
      const rows = await prisma.$queryRaw<Array<{ id: string; n: bigint }>>`SELECT v."id", count(e."id") AS n FROM "timetable_versions" v LEFT JOIN "timetable_entries" e ON e."versionId" = v."id" WHERE v."academicYearId" = ${yearId} AND v."clonedFromId" IS NOT NULL GROUP BY v."id"`;
      return rows.every((r) => Number(r.n) === 36);
    };

    // =================================================================================================================
    section('K1. clone x clone (12 simultaneous clones, 1 draft, cap 6)');
    {
      await reset(year.yearId, V0.id, 0);
      const s = startSampler([year.yearId]);
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => cloneOp(V0.id, (['KEEP', 'ALL', 'NONE'] as const)[i % 3])));
      await s.stop();
      const t = tally(results.map((r) => r.outcome));
      const c = await counts(year.yearId);
      check('EXACTLY 5 clones were created and 7 refused with DRAFT_LIMIT_REACHED, no other outcome', t.CREATED === 5 && t.LIMIT === 7 && Object.keys(t).length === 2, JSON.stringify(t));
      check('the year ends with exactly 6 drafts and the sampler never saw more than 6', c.drafts === CAP && s.state.max.get(year.yearId)! <= CAP, `${JSON.stringify(c)} max=${s.state.max.get(year.yearId)} samples=${s.state.samples}`);
      const numbers = (await prisma.timetableVersion.findMany({ where: { academicYearId: year.yearId }, select: { versionNumber: true } })).map((v) => v.versionNumber).sort((a, b) => a - b);
      check('version numbers are unique and consecutive (max+1 under the slot lock never collided)', new Set(numbers).size === numbers.length && numbers.every((n, i) => i === 0 || n === numbers[i - 1]! + 1), numbers.join());
      check('every clone is COMPLETE: 36 lessons each (no partial copy)', await fullClones(year.yearId));
    }

    // =================================================================================================================
    section('K2. clone x enqueue (4 rounds, 1 enqueue against 4 clones, one slot left)');
    {
      const s = startSampler([year.yearId]);
      let bad = 0; let enqueueWon = 0; let cloneWon = 0;
      for (let round = 0; round < 4; round++) {
        await reset(year.yearId, V0.id, CAP - 2); // source + 4 synthetic = 5 drafts, one slot left
        const [enq, ...clones] = await Promise.all([repo.enqueue(enqueueInput(year.yearId), 10_000, CAP).catch((e) => ({ ok: false as const, reason: `ERROR ${errText(e).slice(0, 150)}` })), ...Array.from({ length: 4 }, () => cloneOp(V0.id))]);
        const created = clones.filter((c) => (c as { outcome: string }).outcome === 'CREATED').length;
        const c = await counts(year.yearId);
        const enqReason = enq.ok ? 'ACCEPTED' : (enq as { reason: string }).reason;
        if ((enq.ok ? 1 : 0) + created !== 1 || c.drafts + c.active !== CAP || clones.some((x) => (x as { outcome: string }).outcome.startsWith('ERROR')) || (!enq.ok && enqReason !== 'DRAFT_LIMIT_REACHED') || (enq.ok && created !== 0)) { bad++; console.log(`    round ${round}: enqueue=${enqReason} clones=${JSON.stringify(tally(clones.map((x) => (x as { outcome: string }).outcome)))} state=${JSON.stringify(c)}`); }
        if (enq.ok) enqueueWon++; else cloneWon++;
      }
      await s.stop();
      check(`all 4 rounds: exactly ONE of {the enqueue, one clone} takes the last slot, the total is exactly ${CAP} (enqueue won ${enqueueWon}, a clone won ${cloneWon}); when the enqueue wins every clone is refused`, bad === 0, `bad=${bad}`);
      check('the sampler never saw drafts + reservations above the cap', s.state.max.get(year.yearId)! <= CAP, `max=${s.state.max.get(year.yearId)}`);
    }

    // =================================================================================================================
    section('K3. clone x persist (the persist is held inside its transaction)');
    {
      await reset(year.yearId, V0.id, CAP - 2);
      const q = await repo.enqueue(enqueueInput(year.yearId), 10_000, CAP);
      if (!q.ok) throw new Error('setup: enqueue refused');
      const token = randomUUID();
      const slotHeld = deferred();
      const gate = deferred();
      const params = await persistParams(year, q.run.id, token, { hooks: { afterDraftSlotLock: async () => { slotHeld.resolve(); await gate.promise; } } });
      await claimRun(q.run.id, token);
      const s = startSampler([year.yearId]);
      const persist = persistOutcome(params);
      await Promise.race([slotHeld.promise, persist.then((o) => { throw new Error(`the persist ended before holding the slot: ${o}`); })]);
      const clones = Array.from({ length: 4 }, () => cloneOp(V0.id));
      const flags = clones.map(settledFlag);
      await sleep(2_000);
      check('while the persist holds the year and the slot, all four clones are still WAITING', flags.every((f) => !f.done));
      gate.resolve();
      const persisted = await persist;
      const results = await Promise.all(clones);
      await s.stop();
      const c = await counts(year.yearId);
      check('the persist committed: 5 -> 6 drafts and its run SUCCEEDED', persisted === 'PERSISTED' && c.drafts === CAP && c.active === 0, `${persisted} ${JSON.stringify(c)}`);
      check('then all four clones were REFUSED (they saw the 6th draft), none errored', results.every((r) => r.outcome === 'LIMIT'), JSON.stringify(tally(results.map((r) => r.outcome))));
      check('never more than 6 at any sample', s.state.max.get(year.yearId)! <= CAP, `max=${s.state.max.get(year.yearId)}`);
    }

    // =================================================================================================================
    section('K4. reservation: a clone cannot take the slot a queued run is waiting for');
    {
      await reset(year.yearId, V0.id, CAP - 3); // source + 3 synthetic = 4 drafts
      const q = await repo.enqueue(enqueueInput(year.yearId), 10_000, CAP);
      if (!q.ok) throw new Error('setup: enqueue refused');
      const token = randomUUID();
      await claimRun(q.run.id, token);
      const s = startSampler([year.yearId]);
      const results = await Promise.all(Array.from({ length: 4 }, () => cloneOp(V0.id)));
      const t = tally(results.map((r) => r.outcome));
      check('4 drafts + 1 RUNNING generation, cap 6: of four simultaneous clones exactly ONE is created (5 + 1 = 6), three refused', t.CREATED === 1 && t.LIMIT === 3, JSON.stringify(t));
      const persisted = await persistOutcome(await persistParams(year, q.run.id, token));
      const c = await counts(year.yearId);
      await s.stop();
      check('the generation then PERSISTS into its reserved slot: 6 drafts, run SUCCEEDED, no overflow', persisted === 'PERSISTED' && c.drafts === CAP && c.active === 0 && (await getRun(q.run.id)).status === 'SUCCEEDED', `${persisted} ${JSON.stringify(c)}`);
      check('the total never exceeded 6', s.state.max.get(year.yearId)! <= CAP, `max=${s.state.max.get(year.yearId)}`);
    }

    // =================================================================================================================
    section('K5. clone x edit of the source (lock changes): the copy is one consistent state');
    {
      const section0 = baseEntries.filter((e) => e.sectionId === year.sectionIds[0]).map((e) => e.id);
      let bad = 0; const seen: number[] = [];
      for (let round = 0; round < 4; round++) {
        await reset(year.yearId, V0.id, 0);
        const [edit, cl] = await Promise.all([
          (async () => { await sleep(randomInt(0, 700)); return editSvc.setLocks(world.schoolId, V0.id, { entryIds: section0, locked: true, expectedRevision: 1 }).then(() => 'OK', (e) => `ERR ${errText(e).slice(0, 120)}`); })(),
          cloneOp(V0.id, 'KEEP'),
        ]);
        const lockedInClone = cl.id ? await prisma.timetableEntry.count({ where: { versionId: cl.id, isLocked: true } }) : -1;
        seen.push(lockedInClone);
        const src = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: V0.id } });
        if (edit !== 'OK' || cl.outcome !== 'CREATED' || ![0, section0.length].includes(lockedInClone) || src.revision !== 2) { bad++; console.log(`    round ${round}: edit=${edit} clone=${cl.outcome} locked=${lockedInClone} revision=${src.revision}`); }
      }
      check(`4 rounds of a 12-lesson lock change racing a clone: both succeed, and the clone has ALL 12 locked or NONE (never a partial state): locked counts ${seen.join(',')}`, bad === 0);
    }

    // =================================================================================================================
    section('K6. clone x delete of the source');
    {
      let bad = 0; const outcomes: string[] = [];
      for (let round = 0; round < 4; round++) {
        await reset(year.yearId, V0.id, 0);
        const first = await cloneOp(V0.id); // a throwaway draft source S
        const S = first.id!;
        const [cl, del] = await Promise.all([
          cloneOp(S),
          (async () => { await sleep(randomInt(0, 900)); return versionSvc.delete(world.schoolId, S).then(() => 'DELETED', (e) => `ERR ${errText(e).slice(0, 120)}`); })(),
        ]);
        outcomes.push(`${cl.outcome}/${del}`);
        const row = cl.id ? await prisma.timetableVersion.findUnique({ where: { id: cl.id } }) : null;
        const entries = cl.id ? await prisma.timetableEntry.count({ where: { versionId: cl.id } }) : 0;
        const ok = del === 'DELETED' && ((cl.outcome === 'CREATED' && !!row && entries === 36 && row.clonedFromId === null) || (cl.outcome === 'NOT_FOUND' && !row));
        if (!ok) { bad++; console.log(`    round ${round}: clone=${cl.outcome} delete=${del} entries=${entries} clonedFromId=${row?.clonedFromId}`); }
      }
      check(`4 rounds: the source is deleted and the clone is either COMPLETE (36 lessons, clonedFromId set to null by the delete) or a clean 404 with nothing left behind (${outcomes.join(' ')})`, bad === 0);
      check('no clone anywhere is partial', await fullClones(year.yearId));
    }

    // =================================================================================================================
    section('K7. clone x publish of the source');
    {
      await reset(year.yearId, V0.id, 2);
      const [pub, ...clones] = await Promise.all([
        (async () => { await sleep(randomInt(0, 500)); return publishSvc.publish(admin, V0.id, { expectedRevision: 1, expectedPublishedVersionId: null }).then(() => 'PUBLISHED', (e) => `ERR ${errText(e).slice(0, 160)}`); })(),
        ...Array.from({ length: 3 }, () => cloneOp(V0.id)),
      ]);
      const published = await prisma.timetableVersion.count({ where: { academicYearId: year.yearId, status: 'PUBLISHED' } });
      const clonedRows = await prisma.timetableVersion.findMany({ where: { academicYearId: year.yearId, clonedFromId: V0.id } });
      const c = await counts(year.yearId);
      check('the publish succeeds, all three clones are created (3 + 3 slots fit), exactly ONE version is PUBLISHED', pub === 'PUBLISHED' && clones.every((x) => (x as { outcome: string }).outcome === 'CREATED') && published === 1, `${pub} ${JSON.stringify(tally(clones.map((x) => (x as { outcome: string }).outcome)))} published=${published}`);
      check('every clone is a DRAFT with revision 1 and 36 lessons, whether it copied the draft or the published source; none is published', clonedRows.length === 3 && clonedRows.every((v) => v.status === 'DRAFT' && v.revision === 1 && v.publishedAt === null) && (await fullClones(year.yearId)));
      check('the cap holds: drafts <= 6 after the publish freed the source\'s slot', c.drafts <= CAP, JSON.stringify(c));
    }

    // =================================================================================================================
    section('K8. Deadlock stress: clones, deletes, edits, enqueues and persists together (25 seconds, cap 4)');
    {
      const STRESS_CAP = 4; // small, so the year SATURATES and the cap is really contended (asserted below)
      process.env.MAX_DRAFTS_PER_YEAR = String(STRESS_CAP);
      await reset(year.yearId, V0.id, 0);
      const sampler = startSampler([year.yearId]);
      const errors: string[] = [];
      const events: Record<string, number> = {};
      const bump = (k: string): void => { events[k] = (events[k] ?? 0) + 1; };
      let stopping = false;
      const worker = (name: string, body: () => Promise<void>) => (async () => { while (!stopping) { try { await body(); } catch (e) { errors.push(`${name}: ${errText(e).slice(0, 220)}`); } await sleep(randomInt(0, 150)); } })();
      const anyDraft = (order: 'asc' | 'desc' = 'asc') => prisma.timetableVersion.findFirst({ where: { academicYearId: year.yearId, status: 'DRAFT' }, orderBy: { versionNumber: order } });
      const workers: Array<Promise<void>> = [];
      for (let i = 0; i < 4; i++) workers.push(worker('clone', async () => {
        const src = await anyDraft(randomInt(0, 2) === 0 ? 'asc' : 'desc');
        if (!src) return;
        const r = await cloneOp(src.id, (['KEEP', 'ALL', 'NONE'] as const)[randomInt(0, 3)]);
        bump(`clone:${r.outcome.startsWith('ERROR') ? 'ERROR' : r.outcome}`);
        if (r.outcome.startsWith('ERROR')) errors.push(`clone: ${r.outcome}`);
      }));
      // The ONLY thing that frees a draft slot in this stress is the delete worker (about 8 times in 25 s), and four clone workers poll for a free slot all the time.
      // A persist worker that merely polls every ~400 ms therefore almost never gets one (measured: 65 refused attempts per run, the freed slots all taken by clones), so
      // "a persist committed" depended on luck, not on the code under test. Freed slots are now announced, and the persist worker reacts to the announcement at once, so it
      // competes for every freed slot on equal terms with the clones (still a real race: a clone can win it, and then the persist is refused as before).
      let freedSeq = 0;
      let freedWaiters: Array<() => void> = [];
      const signalFreed = (): void => { freedSeq++; const w = freedWaiters; freedWaiters = []; for (const f of w) f(); };
      const waitFreed = (ms: number): Promise<void> => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); freedWaiters.push(() => { clearTimeout(t); resolve(); }); });
      workers.push(worker('delete', async () => { await sleep(randomInt(2_500, 4_500)); const d = await anyDraft('desc'); if (d && d.id !== V0.id) { await prisma.timetableVersion.deleteMany({ where: { id: d.id, status: 'DRAFT' } }); bump('delete'); signalFreed(); } }));
      workers.push(worker('edit', async () => {
        const d = await anyDraft('desc');
        if (!d) return;
        const es = await prisma.timetableEntry.findMany({ where: { versionId: d.id }, take: 5, select: { id: true } });
        if (es.length === 0) return;
        try { await editSvc.setLocks(world.schoolId, d.id, { entryIds: es.map((e) => e.id), locked: randomInt(0, 2) === 0, expectedRevision: d.revision }); bump('edit'); }
        catch (e) { const code = (e as { code?: string }).code; if (code === 'REVISION_CONFLICT' || code === 'VERSION_NOT_DRAFT' || code === 'BUSY' || (e as { statusCode?: number }).statusCode === 404) bump(`edit:${code ?? '404'}`); else throw e; }
      }));
      workers.push(worker('enqueue', async () => {
        const r = await repo.enqueue(enqueueInput(year.yearId), 10_000, STRESS_CAP);
        bump(`enqueue:${r.ok ? 'ACCEPTED' : r.reason}`);
        if (r.ok) { await sleep(randomInt(0, 300)); await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "id" = ${r.run.id}`; }
      }));
      workers.push((async () => {
        let seen = 0;
        while (!stopping) {
          if (seen === freedSeq) await waitFreed(300); // a slot was freed while it was busy: go straight to it
          seen = freedSeq;
          if (stopping) break;
          try {
            const q = await repo.enqueue(enqueueInput(year.yearId), 10_000, STRESS_CAP);
            if (!q.ok) { bump(`persist-enqueue:${q.reason}`); continue; }
            const tok = randomUUID();
            await claimRun(q.run.id, tok);
            const o = await persistOutcome(await persistParams(year, q.run.id, tok, { maxDraftsPerYear: STRESS_CAP }));
            bump(`persist:${o.startsWith('ERROR') ? 'ERROR' : o}`);
            if (o.startsWith('ERROR')) errors.push(`persist: ${o}`);
            if (o !== 'PERSISTED') await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "id" = ${q.run.id}`;
          } catch (e) { errors.push(`persist: ${errText(e).slice(0, 220)}`); }
        }
      })());
      await sleep(25_000);
      stopping = true;
      await Promise.all(workers);
      await sampler.stop();
      console.log(`  info: ${sampler.state.samples} cap samples, operations: ${JSON.stringify(events)}`);
      const c = await counts(year.yearId);
      check('NO DEADLOCK (SQLSTATE 40P01) occurred', !errors.some((e) => /deadlock|40P01/i.test(e)), errors.filter((e) => /deadlock|40P01/i.test(e)).slice(0, 2).join(' | '));
      check('no unexpected error of any kind (no 500-class failure, no unique violation, no lock timeout)', errors.length === 0, errors.slice(0, 4).join(' | '));
      check('every kind of operation ran: clones created AND refused, deletes, edits, enqueues accepted, persists committed', (events['clone:CREATED'] ?? 0) > 0 && (events['clone:LIMIT'] ?? 0) > 0 && (events.delete ?? 0) > 0 && (events.edit ?? 0) > 0 && (events['enqueue:ACCEPTED'] ?? 0) > 0 && (events['persist:PERSISTED'] ?? 0) > 0, JSON.stringify(events));
      check(`THE INVARIANT HELD AT EVERY SAMPLE: drafts + active runs <= ${STRESS_CAP} (max observed ${sampler.state.max.get(year.yearId)}), and the cap was actually REACHED, so the bound is not vacuous`, sampler.state.max.get(year.yearId)! <= STRESS_CAP && sampler.state.max.get(year.yearId) === STRESS_CAP && sampler.state.samples > 20);
      check('final state: within the cap, at most one active run, every clone complete, version numbers unique', c.drafts + c.active <= STRESS_CAP && c.active <= 1 && (await fullClones(year.yearId)) && (await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM (SELECT "versionNumber" FROM "timetable_versions" WHERE "academicYearId" = ${year.yearId} GROUP BY 1 HAVING count(*) > 1) d`)[0]!.n === 0, JSON.stringify(c));
    }
  } finally {
    section('Cleanup and proof that nothing existing changed');
    if (savedCap === undefined) delete process.env.MAX_DRAFTS_PER_YEAR; else process.env.MAX_DRAFTS_PER_YEAR = savedCap;
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    await sleep(200);
    check('exactly the one test school was deleted (cascade)', (await destroyWorld(world)) === 1);
    check('the new tables are back to their starting counts', JSON.stringify(await newTableCounts()) === JSON.stringify(newBefore));
    const after = await fingerprint();
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, EXISTING_TABLES.every((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h));
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11KC_' } } })) === 0);
    await big.$disconnect(); await samplerDb.$disconnect();
    await bigPool.end().catch(() => undefined); await samplerPool.end().catch(() => undefined);
  }
}

let finished = false;
process.on('exit', (code) => {
  if (!finished) { console.log(`\nRESULT: pass=${pass} fail=${fail + 1} (the process ended before the suite completed, exit ${code})`); process.exitCode = 1; }
});
main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(async () => {
    await prisma.$disconnect();
    finished = true;
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
