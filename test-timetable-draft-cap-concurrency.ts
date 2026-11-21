// Module 11 - Phase 7F-0: PROOF that the per-year draft cap cannot be exceeded under concurrency, on REAL PostgreSQL.
//
// Invariant:   drafts(year) + activeRuns(year) <= MAX_DRAFTS_PER_YEAR
//
// Every competing pair of draft-creating / reserving / freeing operations is raced for real (separate connections):
//   L  the SQL lock matrix on the actual database (which row-lock modes and advisory locks block which)
//   1  enqueue x enqueue            5  persist x clone / enqueue / publish / edit
//   2  clone x clone                6  reservation then persist (a clone cannot take the slot a queued run is waiting for)
//   3  two FOR SHARE creators       7  persist x persist, persist x recovery
//   4  clone x enqueue              8  delete x clone, delete x persist
//   9  deadlock stress: every operation at once over several years, no deadlock and the cap sampled throughout
//
// "clone" here is the 7F-2 critical section (year FOR UPDATE -> draft-slot lock -> count -> insert) exercised through the SAME shared
// helper (claimDraftSlot) the clone endpoint will use; the endpoint itself is not part of 7F-0.
//
// Run with   NODE_ENV=production npx tsx test-timetable-draft-cap-concurrency.ts
import 'dotenv/config'; // first: the database pool is created when a module imports src/config/database.ts
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '@prisma/client';
import pg from 'pg';
import { claimDraftSlot, DRAFT_SLOT_LOCK_NAMESPACE, lockDraftSlots, readDraftSlots } from './src/modules/timetable-generation/timetable-generation.draft-slots.js';
import { DraftLimitReachedError, LeaseLostError, persistGeneratedVersionOnce, type PersistParams } from './src/modules/timetable-generation/timetable-generation.final-persist.js';
import { loadGenerationSnapshot } from './src/modules/timetable-generation/timetable-generation.loader.js';
import { evaluateMetrics } from './src/modules/timetable-generation/timetable-generation.metrics.js';
import { normalizeProblem } from './src/modules/timetable-generation/timetable-generation.normalizer.js';
import { RunRepository, type RunRecord } from './src/modules/timetable-generation/timetable-generation.run-repository.js';
import {
  assertQueueIsEmpty, createWorld, destroyWorld, EXISTING_TABLES, fingerprint, getRun, newTableCounts, prisma, seedYear, sleep, validEntries, type SeededYear, type World,
} from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const errText = (e: unknown): string => `${(e as Error)?.message ?? e} ${(e as { code?: string })?.code ?? ''} ${JSON.stringify((e as { meta?: unknown })?.meta ?? {})}`;
const CAP = 20;

// A dedicated pool large enough for dozens of simultaneous transactions (the application pool is 10), and a separate one for the sampler.
const bigPool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 45, connectionTimeoutMillis: 60_000, keepAlive: true });
const big = new PrismaClient({ adapter: new PrismaPg(bigPool) });
const samplerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 3, connectionTimeoutMillis: 60_000, keepAlive: true });
const samplerDb = new PrismaClient({ adapter: new PrismaPg(samplerPool) });
const repo = new RunRepository(big as never);

const deferred = <T = void>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();
  const world: World = await createWorld('M11CC');
  const seeded: SeededYear[] = [];
  const mkSeeded = async (tag: string): Promise<SeededYear> => { const y = await seedYear(world, tag, { sections: 3 }); seeded.push(y); return y; };
  let plainN = 0;
  const plainYear = async (): Promise<string> => (await prisma.academicYear.create({ data: { schoolId: world.schoolId, name: `plain-${++plainN}-${randomUUID().slice(0, 6)}`, startDate: new Date('2031-01-01'), endDate: new Date('2031-12-31') } })).id;

  const addDrafts = async (yearId: string, n: number): Promise<void> => {
    const max = (await prisma.timetableVersion.aggregate({ where: { academicYearId: yearId }, _max: { versionNumber: true } }))._max.versionNumber ?? 0;
    await prisma.timetableVersion.createMany({
      data: Array.from({ length: n }, (_, i) => ({ schoolId: world.schoolId, academicYearId: yearId, versionNumber: max + i + 1, status: 'DRAFT' as const, solutionSource: 'BASELINE' as const, solverStatus: 'FEASIBLE' as const, weightsVersion: 'V1', inputHash: 'x', inputSnapshot: {}, metrics: {}, baselineMetrics: {} })),
    });
  };
  /** Exactly `n` drafts, no active run, whatever was there. */
  const resetYear = async (yearId: string, n: number): Promise<void> => {
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "academicYearId" = ${yearId} AND "status" IN ('QUEUED','RUNNING')`;
    await prisma.timetableVersion.deleteMany({ where: { academicYearId: yearId } });
    await addDrafts(yearId, n);
  };
  const counts = async (yearId: string) => {
    const r = await prisma.$queryRaw<Array<{ drafts: number; active: number }>>`SELECT (SELECT count(*) FROM "timetable_versions" WHERE "academicYearId" = ${yearId} AND "status" = 'DRAFT')::int AS drafts, (SELECT count(*) FROM "timetable_generation_runs" WHERE "academicYearId" = ${yearId} AND "status" IN ('QUEUED','RUNNING'))::int AS active`;
    return r[0]!;
  };

  /** Samples drafts + active runs of the given years, one statement per sample (one snapshot), on its own connections, until stopped. */
  const startSampler = (yearIds: string[]) => {
    let running = true;
    const state = { max: new Map<string, number>(yearIds.map((y) => [y, 0])), samples: 0, errors: 0 };
    const loop = (async () => {
      while (running) {
        try {
          const rows = await samplerDb.$queryRaw<Array<{ y: string; total: number }>>`
            SELECT y.id AS y, ((SELECT count(*) FROM "timetable_versions" v WHERE v."academicYearId" = y.id AND v."status" = 'DRAFT')
                             + (SELECT count(*) FROM "timetable_generation_runs" r WHERE r."academicYearId" = y.id AND r."status" IN ('QUEUED','RUNNING')))::int AS total
            FROM "academic_years" y WHERE y.id = ANY(${yearIds})`;
          state.samples++;
          for (const r of rows) state.max.set(r.y, Math.max(state.max.get(r.y) ?? 0, r.total));
        } catch { state.errors++; await sleep(200); }
      }
    })();
    return { state, stop: async () => { running = false; await loop; } };
  };

  // ---- the operations, exactly in the lock order the design fixes ----
  type CloneOutcome = 'CREATED' | 'REFUSED' | `ERROR ${string}`;
  /** The 7F-2 clone critical section: year FOR UPDATE -> draft-slot lock -> count (CLONE rule) -> max+1 -> insert. */
  const cloneLike = async (yearId: string, cap = CAP, holdMs = 0): Promise<CloneOutcome> => {
    try {
      return await big.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '30s'`);
        await tx.$queryRaw`SELECT "id" FROM "academic_years" WHERE "id" = ${yearId} FOR UPDATE`;
        const claim = await claimDraftSlot(tx, yearId, cap, 'CLONE');
        if (!claim.ok) return 'REFUSED' as const;
        if (holdMs > 0) await sleep(holdMs);
        const max = (await tx.$queryRaw<Array<{ n: number | null }>>`SELECT max("versionNumber")::int AS n FROM "timetable_versions" WHERE "academicYearId" = ${yearId}`)[0]?.n ?? 0;
        await tx.timetableVersion.create({ data: { schoolId: world.schoolId, academicYearId: yearId, versionNumber: max + 1, status: 'DRAFT', solutionSource: 'BASELINE', solverStatus: 'FEASIBLE', weightsVersion: 'V1', inputHash: 'x', inputSnapshot: {}, metrics: {}, baselineMetrics: {} } });
        return 'CREATED' as const;
      }, { maxWait: 60_000, timeout: 90_000 });
    } catch (e) { return `ERROR ${errText(e).slice(0, 200)}`; }
  };
  const enqueueInput = (yearId: string, sections = 3) => ({ schoolId: world.schoolId, academicYearId: yearId, requestedById: world.adminId, options: { seed: 1, reproducible: false }, timeLimitSeconds: 10, workers: 2, sectionCount: sections });
  const enqueueOp = async (yearId: string, cap = CAP) => { try { return await repo.enqueue(enqueueInput(yearId), 10_000, cap); } catch (e) { return { ok: false as const, reason: `ERROR ${errText(e).slice(0, 200)}` }; } };
  const reasonOf = (r: Awaited<ReturnType<typeof enqueueOp>>): string => (r.ok ? 'ACCEPTED' : r.reason);
  const claimRun = async (id: string, token: string, leaseSeconds = 60): Promise<void> => {
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'RUNNING'::"TimetableRunStatus", "leaseOwner" = ${token}, "leaseExpiresAt" = now() + (${leaseSeconds}::int * interval '1 second'), "heartbeatAt" = now(), "startedAt" = now(), "attempts" = "attempts" + 1, "phase" = 'CLAIMED' WHERE "id" = ${id} AND "status" = 'QUEUED'::"TimetableRunStatus"`;
  };
  const problems = new Map<string, Awaited<ReturnType<typeof loadProblem>>>();
  async function loadProblem(y: SeededYear) { const n = normalizeProblem(await loadGenerationSnapshot(prisma, world.schoolId, y.yearId)); if (!n.ok) throw new Error('not normalisable'); return { problem: n.problem, entries: validEntries(n.problem) }; }
  const persistParams = async (y: SeededYear, run: { id: string; schoolId: string; academicYearId: string; requestedById: string | null }, token: string, extra: Partial<PersistParams> = {}): Promise<PersistParams> => {
    if (!problems.has(y.yearId)) problems.set(y.yearId, await loadProblem(y));
    const { problem, entries } = problems.get(y.yearId)!;
    return {
      prisma: big as never, run, token, problem, entries,
      version: { solutionSource: 'CP_SAT', solverStatus: 'FEASIBLE', weightsVersion: 'V1', metrics: evaluateMetrics(problem, entries), baselineMetrics: evaluateMetrics(problem, entries), solverDiagnostics: null },
      resultSummary: {}, lockTimeoutSeconds: 30, maxDraftsPerYear: CAP, ...extra,
    };
  };
  const persistOutcome = async (p: PersistParams): Promise<string> => { try { await persistGeneratedVersionOnce(p); return 'PERSISTED'; } catch (e) { return e instanceof DraftLimitReachedError ? 'DRAFT_LIMIT' : e instanceof LeaseLostError ? 'LEASE_LOST' : `ERROR ${errText(e).slice(0, 200)}`; } };
  const tally = (xs: string[]): Record<string, number> => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
  const settledFlag = <T,>(p: Promise<T>) => { const f = { done: false }; void p.finally(() => { f.done = true; }); return f; };

  try {
    // =================================================================================================================
    section('L. The SQL lock matrix on the actual database (a probe waits at most 1.2 s for the lock)');
    {
      const y1 = await plainYear();
      const y2 = await plainYear();
      const ROLLBACK = new Error('probe rollback');
      type Hold = (tx: Prisma.TransactionClient) => Promise<void>;
      /** Hold a lock in one transaction, try another in a second: BLOCKED when it times out (55P03), else GRANTED. */
      const probe = async (hold: Hold, attempt: Hold): Promise<'GRANTED' | 'BLOCKED'> => {
        const held = deferred();
        const release = deferred();
        const holder = big.$transaction(async (tx) => { await hold(tx); held.resolve(); await release.promise; }, { timeout: 60_000, maxWait: 30_000 });
        await held.promise;
        let result: 'GRANTED' | 'BLOCKED' = 'GRANTED';
        try {
          await big.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '1200ms'`); await attempt(tx); throw ROLLBACK; }, { timeout: 30_000, maxWait: 30_000 });
        } catch (e) {
          if (e === ROLLBACK || (e as Error)?.message === 'probe rollback') result = 'GRANTED';
          else if (/55P03|lock timeout/i.test(errText(e))) result = 'BLOCKED';
          else throw e;
        }
        release.resolve();
        await holder;
        return result;
      };
      const year = (mode: 'SHARE' | 'UPDATE', id: string): Hold => async (tx) => { if (mode === 'SHARE') await tx.$queryRaw`SELECT "id" FROM "academic_years" WHERE "id" = ${id} FOR SHARE`; else await tx.$queryRaw`SELECT "id" FROM "academic_years" WHERE "id" = ${id} FOR UPDATE`; };
      const slot = (id: string): Hold => async (tx) => { await lockDraftSlots(tx, id); };
      const queueLock: Hold = async (tx) => { await tx.$executeRaw`SELECT pg_advisory_xact_lock(${7_411_001})`; };
      const fkInsert = (id: string): Hold => async (tx) => { await tx.$executeRaw`INSERT INTO "timetable_versions" ("id","schoolId","academicYearId","versionNumber","solutionSource","solverStatus","weightsVersion","inputHash","inputSnapshot","metrics","baselineMetrics","updatedAt") VALUES (${randomUUID()}, ${world.schoolId}, ${id}, 9999, 'BASELINE'::"SolutionSource", 'FEASIBLE'::"SolverStatus", 'V1', 'x', '{}', '{}', '{}', now())`; };

      check('year FOR SHARE vs FOR SHARE: GRANTED (two persists / edits may hold it together: the lock mode alone does NOT serialise creators)', (await probe(year('SHARE', y1), year('SHARE', y1))) === 'GRANTED');
      check('year FOR SHARE blocks FOR UPDATE (persist blocks a clone / publish / guarded enqueue)', (await probe(year('SHARE', y1), year('UPDATE', y1))) === 'BLOCKED');
      check('year FOR UPDATE blocks FOR SHARE (a clone / publish blocks persist and edits)', (await probe(year('UPDATE', y1), year('SHARE', y1))) === 'BLOCKED');
      check('year FOR UPDATE blocks FOR UPDATE (clone vs clone, clone vs enqueue, enqueue vs enqueue)', (await probe(year('UPDATE', y1), year('UPDATE', y1))) === 'BLOCKED');
      check('year FOR SHARE does NOT block a version insert (its foreign-key check takes only FOR KEY SHARE)', (await probe(year('SHARE', y1), fkInsert(y1))) === 'GRANTED');
      check('year FOR UPDATE DOES block a version insert (FOR KEY SHARE conflicts with FOR UPDATE)', (await probe(year('UPDATE', y1), fkInsert(y1))) === 'BLOCKED');
      check('draft-slot lock vs the same year\'s draft-slot lock: BLOCKED (this is what serialises two FOR SHARE creators)', (await probe(slot(y1), slot(y1))) === 'BLOCKED');
      check('draft-slot lock of ANOTHER year: GRANTED (years never wait for each other)', (await probe(slot(y1), slot(y2))) === 'GRANTED');
      check('holding the draft-slot lock does not block year FOR SHARE or FOR UPDATE (edits, Module 9 and publish are not slowed by it)', (await probe(slot(y1), year('SHARE', y1))) === 'GRANTED' && (await probe(slot(y1), year('UPDATE', y1))) === 'GRANTED');
      check('holding the year row lock does not hold the draft-slot lock (the order year -> slot is a convention the code keeps, not something the database enforces)', (await probe(year('UPDATE', y1), slot(y1))) === 'GRANTED');
      check('the queue-size advisory lock (7411001, single-key form) and the draft-slot lock (two-key form) are separate key spaces in both directions', (await probe(queueLock, slot(y1))) === 'GRANTED' && (await probe(slot(y1), queueLock)) === 'GRANTED');
      check(`the namespace constant is ${DRAFT_SLOT_LOCK_NAMESPACE} and two different years hash to different keys (checked on the database)`, (await prisma.$queryRaw<Array<{ same: boolean }>>`SELECT hashtext(${y1}) = hashtext(${y2}) AS same`)[0]!.same === false);
    }

    // =================================================================================================================
    section('1. enqueue x enqueue');
    {
      const y = await plainYear();
      await resetYear(y, CAP - 1);
      const s = startSampler([y]);
      const results = await Promise.all(Array.from({ length: 10 }, () => enqueueOp(y)));
      await s.stop();
      const t = tally(results.map(reasonOf));
      const c = await counts(y);
      check('19 drafts, ten simultaneous requests: exactly ONE accepted, the other nine ALREADY_ACTIVE, no error', t.ACCEPTED === 1 && t.ALREADY_ACTIVE === 9, JSON.stringify(t));
      check('the state is drafts 19 + 1 reservation = 20, and no sample ever showed more', c.drafts === 19 && c.active === 1 && s.state.max.get(y)! <= CAP, `${JSON.stringify(c)} max=${s.state.max.get(y)}`);
      await resetYear(y, CAP);
      const s2 = startSampler([y]);
      const atCap = await Promise.all(Array.from({ length: 10 }, () => enqueueOp(y)));
      await s2.stop();
      const t2 = tally(atCap.map(reasonOf));
      check('20 drafts, ten simultaneous requests: ALL ten refused with DRAFT_LIMIT_REACHED, no run row exists', t2.DRAFT_LIMIT_REACHED === 10 && (await counts(y)).active === 0 && s2.state.max.get(y)! <= CAP, JSON.stringify(t2));
    }

    // =================================================================================================================
    section('2. clone x clone');
    {
      const y = await plainYear();
      await resetYear(y, 5);
      const s = startSampler([y]);
      const results = await Promise.all(Array.from({ length: 30 }, () => cloneLike(y)));
      await s.stop();
      const t = tally(results);
      const c = await counts(y);
      check('5 drafts, 30 simultaneous clones, cap 20: EXACTLY 15 created and 15 refused, no error', t.CREATED === 15 && t.REFUSED === 15 && Object.keys(t).length === 2, JSON.stringify(t));
      check('the year ends with exactly 20 drafts and the sampler never saw more than 20', c.drafts === 20 && s.state.max.get(y)! <= CAP, `${JSON.stringify(c)} max=${s.state.max.get(y)} samples=${s.state.samples}`);
      const numbers = (await prisma.timetableVersion.findMany({ where: { academicYearId: y }, select: { versionNumber: true } })).map((v) => v.versionNumber);
      check('version numbers are unique and gapless 1..20 (max+1 under the lock never collided)', new Set(numbers).size === 20 && Math.max(...numbers) === 20);
    }

    // =================================================================================================================
    section('3. Two FOR SHARE creators (the year lock alone does not serialise them; the draft-slot lock does)');
    {
      const y = await plainYear();
      const insertDraft = (tx: Prisma.TransactionClient, versionNumber: number) => tx.timetableVersion.create({ data: { schoolId: world.schoolId, academicYearId: y, versionNumber, status: 'DRAFT', solutionSource: 'BASELINE', solverStatus: 'FEASIBLE', weightsVersion: 'V1', inputHash: 'x', inputSnapshot: {}, metrics: {}, baselineMetrics: {} } });
      // CONTROL: naive count-then-insert under FOR SHARE, forced to interleave: both pass the check
      await resetYear(y, CAP - 1);
      let arrived = 0;
      const bothRead = deferred();
      const naive = async (n: number): Promise<string> => big.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "academic_years" WHERE "id" = ${y} FOR SHARE`;
        const drafts = (await readDraftSlots(tx, y)).drafts; // no draft-slot lock
        if (++arrived === 2) bothRead.resolve();
        await bothRead.promise;
        if (drafts >= CAP) return 'REFUSED';
        await insertDraft(tx, 1000 + n);
        return 'CREATED';
      }, { timeout: 60_000, maxWait: 30_000 });
      const control = await Promise.all([naive(1), naive(2)]);
      check('CONTROL (no draft-slot lock): two FOR SHARE holders BOTH pass the check at 19 drafts and the year reaches 21 — the race is real', control.every((r) => r === 'CREATED') && (await counts(y)).drafts === CAP + 1, `${control} ${JSON.stringify(await counts(y))}`);

      // THE SAME TWO TRANSACTIONS with the shared helper: exactly one passes
      await resetYear(y, CAP - 1);
      const guarded = async (purpose: 'PERSIST' | 'ENQUEUE' | 'CLONE'): Promise<string> => big.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '30s'`);
        await tx.$queryRaw`SELECT "id" FROM "academic_years" WHERE "id" = ${y} FOR SHARE`;
        const claim = await claimDraftSlot(tx, y, CAP, purpose);
        if (!claim.ok) return 'REFUSED';
        await sleep(600); // hold the slot a while so the other transaction certainly arrives while it is held
        const max = (await tx.$queryRaw<Array<{ n: number | null }>>`SELECT max("versionNumber")::int AS n FROM "timetable_versions" WHERE "academicYearId" = ${y}`)[0]?.n ?? 0;
        await insertDraft(tx, max + 1);
        return 'CREATED';
      }, { timeout: 60_000, maxWait: 30_000 });
      const [a, b] = await Promise.all([guarded('PERSIST'), guarded('PERSIST')]);
      check('WITH the shared helper: two FOR SHARE creators at 19 drafts -> exactly ONE created, the other refused, the year ends at 20', [a, b].sort().join() === 'CREATED,REFUSED' && (await counts(y)).drafts === CAP, `${a},${b} ${JSON.stringify(await counts(y))}`);
      await resetYear(y, CAP - 1);
      const eight = await Promise.all(Array.from({ length: 8 }, () => guarded('PERSIST')));
      check('eight FOR SHARE creators at 19 drafts: exactly one created, seven refused', tally(eight).CREATED === 1 && tally(eight).REFUSED === 7 && (await counts(y)).drafts === CAP, JSON.stringify(tally(eight)));
    }

    // =================================================================================================================
    section('4. clone x enqueue (8 rounds, 1 enqueue against 5 clones, one slot left)');
    {
      const y = await plainYear();
      const s = startSampler([y]);
      let rounds = 0; let enqueueWon = 0; let cloneWon = 0; let bad = 0;
      for (let round = 0; round < 8; round++) {
        await resetYear(y, CAP - 1);
        const ops = await Promise.all([enqueueOp(y), ...Array.from({ length: 5 }, () => cloneLike(y))]);
        const enq = reasonOf(ops[0] as Awaited<ReturnType<typeof enqueueOp>>);
        const clones = ops.slice(1) as CloneOutcome[];
        const created = clones.filter((c) => c === 'CREATED').length;
        const c = await counts(y);
        rounds++;
        const winners = (enq === 'ACCEPTED' ? 1 : 0) + created;
        if (winners !== 1 || c.drafts + c.active !== CAP || clones.some((x) => x.startsWith('ERROR')) || (enq !== 'ACCEPTED' && enq !== 'DRAFT_LIMIT_REACHED')) { bad++; console.log(`    round ${round}: enqueue=${enq} clones=${JSON.stringify(tally(clones))} state=${JSON.stringify(c)}`); }
        if (enq === 'ACCEPTED') enqueueWon++; else cloneWon++;
        // the loser of the enqueue is always DRAFT_LIMIT_REACHED (never ALREADY_ACTIVE: no run was active); when the enqueue won every clone is refused
        if (enq === 'ACCEPTED' && created !== 0) bad++;
        if (enq !== 'ACCEPTED' && created !== 1) bad++;
      }
      await s.stop();
      check(`all ${rounds} rounds: exactly ONE of {the enqueue, one clone} takes the last slot, the total is exactly ${CAP}, no errors (enqueue won ${enqueueWon}, a clone won ${cloneWon})`, bad === 0 && rounds === 8, `bad=${bad}`);
      check('the sampler never saw drafts + reservations above the cap', s.state.max.get(y)! <= CAP, `max=${s.state.max.get(y)} samples=${s.state.samples}`);
    }

    // =================================================================================================================
    section('5. persist x clone / enqueue / publish / edit (the persist is held inside its transaction, slot lock taken)');
    {
      const y = await mkSeeded('persist-pairs');
      await resetYear(y.yearId, CAP - 1);
      const queued = await repo.enqueue(enqueueInput(y.yearId), 10_000, CAP);
      if (!queued.ok) throw new Error('setup: enqueue refused');
      const token = randomUUID();
      await claimRun(queued.run.id, token);
      const slotHeld = deferred();
      const gate = deferred();
      const params = await persistParams(y, { id: queued.run.id, schoolId: world.schoolId, academicYearId: y.yearId, requestedById: world.adminId }, token, {
        hooks: { afterDraftSlotLock: async () => { slotHeld.resolve(); await gate.promise; } },
      });
      const s = startSampler([y.yearId]);
      const persist = persistOutcome(params);
      await Promise.race([slotHeld.promise, persist.then((o) => { throw new Error(`the persist ended before holding the slot: ${o}`); })]);

      const clones = Array.from({ length: 5 }, () => cloneLike(y.yearId));
      const cloneFlags = clones.map(settledFlag);
      const enq = enqueueOp(y.yearId);
      const enqFlag = settledFlag(enq);
      const quick = async (mode: 'SHARE' | 'UPDATE'): Promise<'GRANTED' | 'BLOCKED'> => {
        try {
          await big.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`); if (mode === 'SHARE') await tx.$queryRaw`SELECT "id" FROM "academic_years" WHERE "id" = ${y.yearId} FOR SHARE`; else await tx.$queryRaw`SELECT "id" FROM "academic_years" WHERE "id" = ${y.yearId} FOR UPDATE`; });
          return 'GRANTED';
        } catch (e) { if (/55P03|lock timeout/i.test(errText(e))) return 'BLOCKED'; throw e; }
      };
      check('while the persist holds the slot: an edit / Module 9 schedule edit (year FOR SHARE) is NOT blocked', (await quick('SHARE')) === 'GRANTED');
      check('...a publish (year FOR UPDATE) IS blocked until the persist ends (existing behaviour, unchanged)', (await quick('UPDATE')) === 'BLOCKED');
      await sleep(1_500);
      check('the five clones and the enqueue are all still WAITING behind the persist (none completed)', cloneFlags.every((f) => !f.done) && !enqFlag.done);
      gate.resolve();
      const persisted = await persist;
      const cloneResults = await Promise.all(clones);
      const enqResult = await enq;
      await s.stop();
      const c = await counts(y.yearId);
      check('the persist committed: 19 -> 20 drafts, its run SUCCEEDED', persisted === 'PERSISTED' && c.drafts === CAP && (await getRun(queued.run.id)).status === 'SUCCEEDED', `${persisted} ${JSON.stringify(c)}`);
      check('after it, ALL five clones were REFUSED (they saw the new draft) and no error occurred', cloneResults.every((r) => r === 'REFUSED'), JSON.stringify(tally(cloneResults)));
      check('the enqueue was refused with DRAFT_LIMIT_REACHED (it saw 20 drafts) and no run exists', reasonOf(enqResult) === 'DRAFT_LIMIT_REACHED' && c.active === 0, reasonOf(enqResult));
      check('the sampler never saw more than 20', s.state.max.get(y.yearId)! <= CAP, `max=${s.state.max.get(y.yearId)}`);
    }

    // =================================================================================================================
    section('6. reservation: a clone cannot take the slot a queued run is waiting for');
    {
      const y = await mkSeeded('reservation');
      await resetYear(y.yearId, CAP - 2);
      const queued = await repo.enqueue(enqueueInput(y.yearId), 10_000, CAP);
      if (!queued.ok) throw new Error('setup: enqueue refused');
      const token = randomUUID();
      await claimRun(queued.run.id, token);
      const s = startSampler([y.yearId]);
      const clones = await Promise.all([cloneLike(y.yearId), cloneLike(y.yearId), cloneLike(y.yearId)]);
      let c = await counts(y.yearId);
      check('18 drafts + 1 RUNNING run (a reservation), cap 20: of three simultaneous clones exactly ONE is created (19 + 1 = 20)', tally(clones).CREATED === 1 && tally(clones).REFUSED === 2 && c.drafts === CAP - 1 && c.active === 1, `${JSON.stringify(tally(clones))} ${JSON.stringify(c)}`);
      const persisted = await persistOutcome(await persistParams(y, { id: queued.run.id, schoolId: world.schoolId, academicYearId: y.yearId, requestedById: world.adminId }, token));
      c = await counts(y.yearId);
      await s.stop();
      check('the run that was waiting then PERSISTS into its reserved slot: 20 drafts, run SUCCEEDED (the clone did not steal it)', persisted === 'PERSISTED' && c.drafts === CAP && c.active === 0, `${persisted} ${JSON.stringify(c)}`);
      check('the total never exceeded 20 at any sample', s.state.max.get(y.yearId)! <= CAP, `max=${s.state.max.get(y.yearId)}`);
      const after = await cloneLike(y.yearId);
      check('and the year is now full for clones', after === 'REFUSED');
    }

    // =================================================================================================================
    section('7. persist x persist and persist x recovery');
    {
      const y = await mkSeeded('persist-persist');
      await resetYear(y.yearId, CAP - 1);
      const queued = await repo.enqueue(enqueueInput(y.yearId), 10_000, CAP);
      if (!queued.ok) throw new Error('setup: enqueue refused');
      const token = randomUUID();
      const slotHeld = deferred();
      const gate = deferred();
      const base = await persistParams(y, { id: queued.run.id, schoolId: world.schoolId, academicYearId: y.yearId, requestedById: world.adminId }, token); // built BEFORE the claim: no slow work between the claim and the fence
      await claimRun(queued.run.id, token, 8); // an 8 s lease: it expires while the persist is held, but is still valid when the persist starts
      const first = persistOutcome({ ...base, hooks: { afterDraftSlotLock: async () => { slotHeld.resolve(); await gate.promise; } } });
      await Promise.race([slotHeld.promise, first.then((o) => { throw new Error(`the first persist ended before holding the slot: ${o}`); })]);
      const second = persistOutcome(base); // the same claim, concurrently: it waits at the fence (the run row is locked by the first)
      await sleep(9_000); // the lease expired in the meantime
      const recovered = await repo.recoverStale(2);
      const mid = await getRun(queued.run.id);
      check('the lease EXPIRED during the persist, yet recovery SKIPPED the locked run (SKIP LOCKED): nothing requeued or failed', recovered.requeued.length === 0 && recovered.failed.length === 0 && mid.status === 'RUNNING', `${JSON.stringify(recovered)} ${mid.status}`);
      gate.resolve();
      const results = [await first, await second];
      const c = await counts(y.yearId);
      check('persist x persist (same claim, 19 drafts): exactly ONE persisted, the other was fenced out (LEASE_LOST)', results[0] === 'PERSISTED' && results[1] === 'LEASE_LOST', JSON.stringify(results));
      check('exactly one version was created: 20 drafts, the run SUCCEEDED, no active run', c.drafts === CAP && c.active === 0 && (await getRun(queued.run.id)).status === 'SUCCEEDED', JSON.stringify(c));
    }

    // =================================================================================================================
    section('8. delete x clone and delete x persist (a delete only ever lowers the count)');
    {
      const y = await plainYear();
      const s = startSampler([y]);
      let bad = 0; const created: number[] = [];
      for (let round = 0; round < 6; round++) {
        await resetYear(y, CAP);
        const victim = (await prisma.timetableVersion.findFirst({ where: { academicYearId: y }, orderBy: { versionNumber: 'asc' } }))!;
        const del = (async () => { await sleep(randomInt(0, 400)); return prisma.timetableVersion.deleteMany({ where: { id: victim.id, status: 'DRAFT' } }); })();
        const clones = await Promise.all(Array.from({ length: 10 }, () => cloneLike(y)));
        await del;
        const n = clones.filter((x) => x === 'CREATED').length;
        const c = await counts(y);
        created.push(n);
        if (n > 1 || c.drafts !== CAP - 1 + n || c.drafts > CAP || clones.some((x) => x.startsWith('ERROR'))) { bad++; console.log(`    round ${round}: ${JSON.stringify(tally(clones))} ${JSON.stringify(c)}`); }
      }
      await s.stop();
      check(`at 20 drafts, one delete racing ten clones, 6 rounds: at most ONE clone is ever created (created per round: ${created.join(',')}), the count is always 19 + created <= 20, no errors`, bad === 0, `bad=${bad}`);
      check('the sampler never saw more than 20', s.state.max.get(y)! <= CAP, `max=${s.state.max.get(y)}`);

      // persist x delete
      const ys = await mkSeeded('persist-delete');
      let ok = 0; let refused = 0; let wrong = 0;
      for (let round = 0; round < 3; round++) {
        await resetYear(ys.yearId, CAP - 1);
        const q = await repo.enqueue(enqueueInput(ys.yearId), 10_000, CAP);
        if (!q.ok) throw new Error('setup: enqueue refused');
        const tok = randomUUID();
        await claimRun(q.run.id, tok);
        await addDrafts(ys.yearId, 1); // now 20 drafts + the run: persist would exceed the cap unless a draft goes first
        const victim = (await prisma.timetableVersion.findFirst({ where: { academicYearId: ys.yearId }, orderBy: { versionNumber: 'asc' } }))!;
        const params = await persistParams(ys, { id: q.run.id, schoolId: world.schoolId, academicYearId: ys.yearId, requestedById: world.adminId }, tok);
        const [outcome] = await Promise.all([persistOutcome(params), (async () => { await sleep(randomInt(0, 1_200)); await prisma.timetableVersion.deleteMany({ where: { id: victim.id } }); })()]);
        const c = await counts(ys.yearId);
        if (outcome === 'PERSISTED' && c.drafts === CAP) ok++;
        else if (outcome === 'DRAFT_LIMIT' && c.drafts === CAP - 1) refused++;
        else wrong++;
        if (c.drafts > CAP) wrong++;
      }
      check(`persist racing a delete at the cap, 3 rounds: every outcome is consistent (persisted -> exactly 20 drafts, refused -> 19; persisted ${ok}, refused ${refused}), never above 20`, wrong === 0 && ok + refused === 3);
    }

    // =================================================================================================================
    section('9. Deadlock stress: every operation at once, several years, 25 seconds');
    {
      const STRESS_CAP = 4; // small, so the years SATURATE and the cap is really contended (asserted below)
      const plain = [await plainYear(), await plainYear()];
      const sy = await mkSeeded('stress');
      const years = [...plain, sy.yearId];
      for (const y of years) await resetYear(y, 1);
      const sampler = startSampler(years);
      const errors: string[] = [];
      const events: Record<string, number> = {};
      const bump = (k: string): void => { events[k] = (events[k] ?? 0) + 1; };
      const note = (what: string, e: unknown): void => { const t = errText(e); bump(`${what}:EXCEPTION`); errors.push(`${what}: ${t.slice(0, 220)}`); };
      let stopping = false;
      const pickYear = (): string => years[randomInt(0, years.length)]!;
      const randomDraft = (yearId: string) => prisma.timetableVersion.findFirst({ where: { academicYearId: yearId, status: 'DRAFT' }, orderBy: { versionNumber: randomInt(0, 2) === 0 ? 'asc' : 'desc' } });
      const worker = (name: string, body: () => Promise<void>) => (async () => { while (!stopping) { try { await body(); } catch (e) { note(name, e); } await sleep(randomInt(0, 150)); } })();

      const workers: Array<Promise<void>> = [];
      for (let i = 0; i < 6; i++) workers.push(worker('clone', async () => { const r = await cloneLike(pickYear(), STRESS_CAP, randomInt(0, 200)); bump(`clone:${r.startsWith('ERROR') ? 'ERROR' : r}`); if (r.startsWith('ERROR')) errors.push(`clone: ${r}`); }));
      for (let i = 0; i < 2; i++) workers.push(worker('enqueue', async () => {
        const y = plain[randomInt(0, plain.length)]!; // plain years only: they have no configuration to persist
        const r = await enqueueOp(y, STRESS_CAP);
        bump(`enqueue:${reasonOf(r).startsWith('ERROR') ? 'ERROR' : reasonOf(r)}`);
        if (reasonOf(r).startsWith('ERROR')) errors.push(`enqueue: ${reasonOf(r)}`);
        if (r.ok) { await sleep(randomInt(0, 300)); await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "id" = ${r.run.id}`; }
      }));
      // Slots are freed only by the delete worker, and six clone workers poll for a free slot all the time, so a persist worker that merely polls every ~400 ms is starved
      // (measured: dozens of refused attempts, every freed slot taken by a clone) and "a persist committed" depended on luck. A freed slot of the persist year is announced
      // and the persist worker reacts at once, so it competes on equal terms (a clone can still win it). Assertions unchanged.
      let freedSeq = 0;
      let freedWaiters: Array<() => void> = [];
      const signalFreed = (): void => { freedSeq++; const w = freedWaiters; freedWaiters = []; for (const f of w) f(); };
      const waitFreed = (ms: number): Promise<void> => new Promise<void>((resolve) => { const t = setTimeout(resolve, ms); freedWaiters.push(() => { clearTimeout(t); resolve(); }); });
      workers.push((async () => { // the seeded year: wait for a freed slot, then enqueue -> claim -> the REAL persist transaction
        let seen = 0;
        while (!stopping) {
          if (seen === freedSeq) await waitFreed(300); // a slot was freed while it was busy: go straight to it
          seen = freedSeq;
          if (stopping) break;
          try {
            const q = await repo.enqueue(enqueueInput(sy.yearId), 10_000, STRESS_CAP);
            if (!q.ok) { bump(`persist-enqueue:${q.reason}`); continue; }
            const tok = randomUUID();
            await claimRun(q.run.id, tok);
            await sleep(randomInt(0, 300));
            const outcome = await persistOutcome(await persistParams(sy, { id: q.run.id, schoolId: world.schoolId, academicYearId: sy.yearId, requestedById: world.adminId }, tok, { maxDraftsPerYear: STRESS_CAP, lockTimeoutSeconds: 30 }));
            bump(`persist:${outcome.startsWith('ERROR') ? 'ERROR' : outcome}`);
            if (outcome.startsWith('ERROR')) errors.push(`persist: ${outcome}`);
            if (outcome !== 'PERSISTED') await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "id" = ${q.run.id}`;
          } catch (e) { note('persist', e); }
        }
      })());
      workers.push(worker('delete', async () => { await sleep(randomInt(300, 1_200)); const d = await randomDraft(pickYear()); if (d) { await prisma.timetableVersion.deleteMany({ where: { id: d.id, status: 'DRAFT' } }); bump('delete'); if (d.academicYearId === sy.yearId) signalFreed(); } }));
      for (let i = 0; i < 2; i++) workers.push(worker('edit', async () => { // year FOR SHARE -> version FOR UPDATE, as the editor does
        const y = pickYear();
        await big.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '30s'`);
          await tx.$queryRaw`SELECT "id" FROM "academic_years" WHERE "id" = ${y} FOR SHARE`;
          const v = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "timetable_versions" WHERE "academicYearId" = ${y} AND "status" = 'DRAFT' ORDER BY "versionNumber" LIMIT 1 FOR UPDATE`;
          await sleep(randomInt(0, 200));
          if (v[0]) await tx.$executeRaw`UPDATE "timetable_versions" SET "revision" = "revision" + 1, "updatedAt" = now() WHERE "id" = ${v[0].id}`;
        }, { timeout: 60_000, maxWait: 60_000 });
        bump('edit');
      }));
      workers.push(worker('publish', async () => { // year FOR UPDATE -> version rows FOR UPDATE -> config FOR SHARE, as publish does (no status change)
        const y = pickYear();
        await big.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '30s'`);
          await tx.$queryRaw`SELECT "id" FROM "academic_years" WHERE "id" = ${y} FOR UPDATE`;
          await tx.$queryRaw`SELECT "id" FROM "timetable_versions" WHERE "academicYearId" = ${y} ORDER BY "id" FOR UPDATE`;
          await tx.$queryRaw`SELECT "id" FROM "schedule_configs" WHERE "academicYearId" = ${y} FOR SHARE`;
          await sleep(randomInt(0, 200));
        }, { timeout: 60_000, maxWait: 60_000 });
        bump('publish');
      }));

      const started = Date.now();
      await sleep(25_000);
      stopping = true;
      await Promise.all(workers);
      await sampler.stop();
      const elapsed = Math.round((Date.now() - started) / 1000);
      console.log(`  info: ${elapsed}s, ${sampler.state.samples} cap samples, operations: ${JSON.stringify(events)}`);
      const deadlocks = errors.filter((e) => /deadlock|40P01/i.test(e));
      const finals = await Promise.all(years.map(counts));
      check('NO DEADLOCK (SQLSTATE 40P01) occurred', deadlocks.length === 0, deadlocks.slice(0, 3).join(' | '));
      check('no unexpected error of any kind (no 500-class failure, no lock timeout, no unique violation)', errors.length === 0, errors.slice(0, 5).join(' | '));
      check('every kind of operation actually ran (clones created and refused, enqueues accepted, persists committed, deletes, edits, publishes)', (events['clone:CREATED'] ?? 0) > 0 && (events['clone:REFUSED'] ?? 0) > 0 && (events['enqueue:ACCEPTED'] ?? 0) > 0 && (events['persist:PERSISTED'] ?? 0) > 0 && (events.delete ?? 0) > 0 && (events.edit ?? 0) > 0 && (events.publish ?? 0) > 0, JSON.stringify(events));
      check(`THE INVARIANT HELD AT EVERY SAMPLE: drafts + active runs <= ${STRESS_CAP} for every year (max per year: ${years.map((y) => sampler.state.max.get(y)).join(', ')})`, years.every((y) => sampler.state.max.get(y)! <= STRESS_CAP) && sampler.state.samples > 20, `samples=${sampler.state.samples}`);
      check('the stress really SATURATED the cap (every year was observed exactly at the cap), so the bound above is not vacuous', years.every((y) => sampler.state.max.get(y) === STRESS_CAP), years.map((y) => sampler.state.max.get(y)).join(','));
      check('final state: every year within the cap, at most one active run, no orphan runs', finals.every((c) => c.drafts + c.active <= STRESS_CAP && c.active <= 1), JSON.stringify(finals));
      check('version numbers are unique per year (the max+1 under the slot lock never collided)', (await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM (SELECT "academicYearId", "versionNumber" FROM "timetable_versions" WHERE "academicYearId" = ANY(${years}) GROUP BY 1, 2 HAVING count(*) > 1) d`)[0]!.n === 0);
    }
  } finally {
    section('10. Cleanup and proof that nothing existing changed');
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    await sleep(200);
    check('exactly the one test school was deleted (cascade)', (await destroyWorld(world)) === 1);
    check('the new tables are back to their starting counts', JSON.stringify(await newTableCounts()) === JSON.stringify(newBefore));
    const after = await fingerprint();
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, EXISTING_TABLES.every((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h));
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11CC_' } } })) === 0);
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
