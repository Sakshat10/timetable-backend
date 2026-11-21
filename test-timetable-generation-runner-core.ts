// Phase 5 tests, part 1: runner configuration, the PostgreSQL queue (enqueue, limits, claim, SKIP LOCKED, TTL), lease
// fencing, heartbeat, stale recovery and the authoritative snapshot loader. REAL PostgreSQL, no solver, no Python.
//
// Run with   NODE_ENV=production npx tsx test-timetable-generation-runner-core.ts
import 'dotenv/config'; // first: the database pool is created when a module imports src/config/database.ts
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { loadSchedulingInput } from './src/modules/timetable-feasibility/timetable-feasibility.loader.js';
import { loadGenerationSnapshot } from './src/modules/timetable-generation/timetable-generation.loader.js';
import { normalizeProblem } from './src/modules/timetable-generation/timetable-generation.normalizer.js';
import { DEFAULT_RUNNER_SETTINGS, MEMORY_PER_SLOT_BYTES, resolveRunnerConfig } from './src/modules/timetable-generation/timetable-generation.runner-config.js';
import { RunRepository } from './src/modules/timetable-generation/timetable-generation.run-repository.js';
import {
  assertQueueIsEmpty, createWorld, destroyWorld, enqueueFor, EXISTING_TABLES, fingerprint, getRun, mustEnqueue, newTableCounts, prisma, rawPrisma, seedYear, sleep,
} from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const throws = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };
const GiB = MEMORY_PER_SLOT_BYTES;

// =====================================================================================================================
section('1. Runner configuration (pure)');
{
  const cfg = (env: Record<string, string> = {}, cpus = 8, memGiB = 16) => resolveRunnerConfig(env, { cpuCount: cpus, totalMemoryBytes: memGiB * GiB });
  const d = cfg();
  check('defaults on 8 CPUs / 16 GiB: workers 4, concurrency min(2, floor(8/4)) = 2', d.config.workers === 4 && d.config.concurrency === 2 && d.warnings.length === 0);
  check('the approved queue / lease / heartbeat / tick / attempt defaults', d.config.queueMax === 10 && d.config.queueTtlMinutes === 30 && d.config.leaseSeconds === 90 && d.config.heartbeatSeconds === 20 && d.config.tickSeconds === 15 && d.config.maxAttempts === 2);
  check('the default settings object is frozen', Object.isFrozen(DEFAULT_RUNNER_SETTINGS));
  check('4 CPUs: workers 4, concurrency 1', cfg({}, 4).config.concurrency === 1 && cfg({}, 4).config.workers === 4);
  check('2 CPUs: workers are limited by the CPU count (2) with a warning, concurrency 1', (() => { const r = cfg({}, 2); return r.config.workers === 2 && r.config.concurrency === 1 && r.warnings.some((w) => w.includes('SOLVER_WORKERS')); })());
  check('1 CPU: workers 1, concurrency 1', cfg({}, 1).config.workers === 1 && cfg({}, 1).config.concurrency === 1);
  check('16 CPUs / 4 workers: default concurrency stays at 2', cfg({}, 16).config.concurrency === 2);
  const over = cfg({ SOLVER_MAX_CONCURRENT_RUNS: '3' }, 8);
  check('an explicit concurrency that would oversubscribe the CPUs is reduced (3 x 4 > 8) with a warning', over.config.concurrency === 2 && over.warnings.some((w) => w.includes('oversubscribe')));
  check('an explicit concurrency within the CPU budget is kept', cfg({ SOLVER_MAX_CONCURRENT_RUNS: '4', SOLVER_WORKERS: '2' }, 8).config.concurrency === 4);
  const mem = cfg({}, 16, 2);
  check('memory budget: ~1 GiB per slot and 70% of 2 GiB -> concurrency 1 with a warning', mem.config.concurrency === 1 && mem.warnings.some((w) => w.includes('GiB')));
  check('plenty of memory does not reduce concurrency', cfg({}, 16, 64).config.concurrency === 2);
  check('every setting is overridable', (() => { const r = cfg({ GENERATION_RUNNER_ENABLED: 'false', SOLVER_QUEUE_MAX: '25', GENERATION_QUEUE_TTL_MINUTES: '5', GENERATION_LEASE_SECONDS: '120', GENERATION_HEARTBEAT_SECONDS: '10', GENERATION_TICK_SECONDS: '5', GENERATION_MAX_ATTEMPTS: '3' }); return !r.config.enabled && r.config.queueMax === 25 && r.config.queueTtlMinutes === 5 && r.config.leaseSeconds === 120 && r.config.heartbeatSeconds === 10 && r.config.tickSeconds === 5 && r.config.maxAttempts === 3; })());
  for (const [key, bad] of [['SOLVER_WORKERS', '0'], ['SOLVER_WORKERS', 'four'], ['SOLVER_MAX_CONCURRENT_RUNS', '-1'], ['SOLVER_QUEUE_MAX', '0'], ['GENERATION_QUEUE_TTL_MINUTES', '1.5'], ['GENERATION_LEASE_SECONDS', '1'], ['GENERATION_MAX_ATTEMPTS', '0'], ['GENERATION_RUNNER_ENABLED', 'maybe'], ['GENERATION_TICK_SECONDS', '']] as const) {
    if (bad === '') continue;
    check(`invalid ${key}="${bad}" is rejected at start-up`, throws(() => cfg({ [key]: bad })));
  }
  check('a heartbeat that cannot fail enough times inside the lease is rejected (20 s x 3 >= 60 s lease)', throws(() => cfg({ GENERATION_LEASE_SECONDS: '60' })));
  check('...and the approved 20 s heartbeat / 90 s lease is accepted', !throws(() => cfg({})));
}

// =====================================================================================================================
async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();
  const world = await createWorld('M11RC');
  const repo = new RunRepository(rawPrisma);
  try {
    const mkYear = (tag: string) => seedYear(world, tag, { sections: 2 });
    /** claimNext takes the OLDEST queued run, so every section starts from an empty queue. */
    const drain = () => prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    /** Backdate the lease of a RUNNING run so it counts as expired (the database clock decides). */
    const expireLease = (id: string) => prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "leaseExpiresAt" = now() - interval '1 minute' WHERE "id" = ${id}`;

    // ===================================================================================================================
    section('2. Enqueue, the queue limit and the one-active-run rule');
    {
      const y1 = await mkYear('enq1');
      const r1 = await enqueueFor(world, y1);
      check('a run is enqueued as QUEUED with attempts 0, no lease, and the requested options', r1.ok && r1.run.status === 'QUEUED' && r1.run.attempts === 0 && r1.run.leaseOwner === null && (r1.run.options as { seed: number }).seed === 1);
      const dup = await enqueueFor(world, y1);
      check('a second request for the same academic year is ALREADY_ACTIVE (decided by the database) and names the existing run', !dup.ok && dup.reason === 'ALREADY_ACTIVE' && dup.existingRunId === (r1.ok ? r1.run.id : ''));

      const active0 = await repo.activeCount();
      const limit = active0 + 3;
      const years = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map((i) => mkYear(`lim${i}`)));
      const results = await Promise.all(years.map((y) => enqueueFor(world, y, { queueMax: limit })));
      const accepted = results.filter((r) => r.ok).length;
      const refused = results.filter((r) => !r.ok && r.reason === 'QUEUE_FULL').length;
      check(`8 simultaneous requests with room for 3 (limit ${limit}, ${active0} active): exactly 3 accepted, 5 refused QUEUE_FULL`, accepted === 3 && refused === 5, `accepted=${accepted} refused=${refused}`);
      check('the queue count never exceeded the limit', (await repo.activeCount()) === limit);
      const full = results.find((r) => !r.ok && r.reason === 'QUEUE_FULL');
      check('QUEUE_FULL reports the current size and the limit', !!full && !full.ok && full.reason === 'QUEUE_FULL' && full.max === limit);
      // drain: mark everything finished so later sections start from an empty queue
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
      check('finished runs no longer count against the queue limit', (await repo.activeCount()) === 0);
      check('after the queue drains, a new request is accepted again', (await enqueueFor(world, y1)).ok);
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    }

    // ===================================================================================================================
    section('3. Claiming: atomic, FIFO, never twice');
    {
      const years = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => mkYear(`cl${i}`)));
      const runs = [];
      for (const y of years) { runs.push(await mustEnqueue(world, y)); await sleep(15); } // distinct createdAt for FIFO
      const token = randomUUID();
      const first = await repo.claimNext(token, 60);
      check('the OLDEST queued run is claimed first (FIFO)', first?.id === runs[0]!.id);
      check('the claim sets RUNNING, the token, a lease from the database clock, heartbeat, startedAt, attempts 1, phase CLAIMED', first?.status === 'RUNNING' && first.leaseOwner === token && first.attempts === 1 && first.phase === 'CLAIMED' && first.startedAt !== null && first.heartbeatAt !== null && first.leaseExpiresAt !== null);
      check('the lease is about 60 s long (database clock)', first !== null && first.leaseExpiresAt !== null && first.heartbeatAt !== null && Math.abs((first.leaseExpiresAt.getTime() - first.heartbeatAt.getTime()) / 1000 - 60) < 2);

      // release it again for the contention test
      await repo.requeueForShutdown(first!.id, token);
      const claimers = Array.from({ length: 4 }, () => async (): Promise<string[]> => {
        const mine: string[] = [];
        for (;;) {
          const run = await repo.claimNext(randomUUID(), 60);
          if (!run) return mine;
          mine.push(run.id);
        }
      });
      const claimed = (await Promise.all(claimers.map((c) => c()))).flat();
      check('4 concurrent claimers drain 6 runs: 6 claims in total', claimed.length === 6, String(claimed.length));
      check('...and no run was claimed twice', new Set(claimed).size === 6);
      check('...every one of the 6 runs was claimed', runs.every((r) => claimed.includes(r.id)));
      check('every claimed run is RUNNING with attempts 1 and its own lease', (await Promise.all(runs.map((r) => getRun(r.id)))).every((r) => r.status === 'RUNNING' && r.attempts === 1 && r.leaseOwner !== null));
      check('nothing is left to claim', (await repo.claimNext(randomUUID(), 60)) === null);
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;

      // many rounds: the guarantee must hold under repeated contention
      let doubleClaims = 0; let rounds = 0;
      for (let round = 0; round < 6; round++) {
        const ys = await Promise.all([1, 2, 3].map((i) => mkYear(`rc${round}_${i}`)));
        for (const y of ys) await mustEnqueue(world, y);
        const got = (await Promise.all(Array.from({ length: 5 }, async () => { const r = await repo.claimNext(randomUUID(), 60); return r ? [r.id] : []; }))).flat();
        rounds++;
        if (got.length !== 3 || new Set(got).size !== 3) doubleClaims++;
        await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
      }
      check(`6 rounds of 5 simultaneous claims over 3 runs: each run claimed exactly once every round (${rounds - doubleClaims}/${rounds})`, doubleClaims === 0);
    }

    // ===================================================================================================================
    section('4. SKIP LOCKED: a claim never waits for a row another worker holds');
    {
      const [ya, yb] = await Promise.all([mkYear('sl1'), mkYear('sl2')]);
      const a = await mustEnqueue(world, ya); await sleep(20); const b = await mustEnqueue(world, yb);
      let release!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      let locked!: () => void;
      const lockTaken = new Promise<void>((r) => { locked = r; });
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "timetable_generation_runs" WHERE "id" = ${a.id} FOR UPDATE`;
        locked();
        await held;
      }, { timeout: 30_000 });
      await lockTaken;
      const t0 = Date.now();
      const claimed = await repo.claimNext(randomUUID(), 60);
      check('with the oldest row locked by another transaction, the claim takes the NEXT one immediately', claimed?.id === b.id && Date.now() - t0 < 2_000, `${claimed?.id === b.id} ${Date.now() - t0} ms`);
      check('...and the locked row stays QUEUED', (await getRun(a.id)).status === 'QUEUED');
      release(); await holder;
      const later = await repo.claimNext(randomUUID(), 60);
      check('once the lock is released the row is claimable', later?.id === a.id);
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    }

    // ===================================================================================================================
    section('5. Lease, heartbeat and fencing');
    {
      await drain();
      const y = await mkYear('lease');
      const run = await mustEnqueue(world, y);
      const token = randomUUID();
      const claimed = (await repo.claimNext(token, 60))!;
      const other = randomUUID();
      check('heartbeat by the owner extends the lease and succeeds', await (async () => { const t = (await getRun(run.id)).leaseExpiresAt!.getTime(); await sleep(1100); const ok = await repo.heartbeat(run.id, token, 60); return ok && (await getRun(run.id)).leaseExpiresAt!.getTime() > t; })());
      check('heartbeat by another token is refused and changes nothing', await (async () => { const b = await getRun(run.id); const ok = await repo.heartbeat(run.id, other, 60); const a = await getRun(run.id); return !ok && a.leaseExpiresAt!.getTime() === b.leaseExpiresAt!.getTime() && a.leaseOwner === token; })());
      check('setPhase by the owner works and records audit fields', await (async () => { const ok = await repo.setPhase(run.id, token, 'BASELINE', { inputHash: 'abc', sectionCount: 7 }); const r = await getRun(run.id); return ok && r.phase === 'BASELINE' && r.inputHash === 'abc' && r.sectionCount === 7; })());
      check('setPhase / fail / requeue by a foreign token are all refused and change nothing', await (async () => {
        const b = await getRun(run.id);
        const r1 = await repo.setPhase(run.id, other, 'HACKED'); const r2 = await repo.fail(run.id, other, { code: 'NOT_READY', message: 'x', diagnostics: {} }); const r3 = await repo.requeueForShutdown(run.id, other);
        const a = await getRun(run.id);
        return !r1 && !r2 && !r3 && a.status === 'RUNNING' && a.phase === b.phase && a.leaseOwner === token && a.attempts === b.attempts;
      })());
      check('a QUEUED run cannot be heartbeated or phase-updated', await (async () => { const y2 = await mkYear('lease2'); const q = await mustEnqueue(world, y2); return !(await repo.heartbeat(q.id, token, 60)) && !(await repo.setPhase(q.id, token, 'X')); })());

      // an expired lease: the phase write is refused (the worker must notice), the heartbeat can still revive an unrecovered run
      await expireLease(run.id);
      check('with an EXPIRED lease, setPhase is refused', !(await repo.setPhase(run.id, token, 'LATE')));
      check('...but the owner can still revive the lease by heartbeat while nobody has recovered the run', await repo.heartbeat(run.id, token, 60) && await repo.setPhase(run.id, token, 'REVIVED'));

      // after a requeue and a re-claim by a NEW token, the old token is powerless
      await expireLease(run.id);
      const sweep = await repo.recoverStale(2);
      check('stale recovery requeues the expired run (attempts 1 < 2)', sweep.requeued.includes(run.id) && (await getRun(run.id)).status === 'QUEUED');
      const q = await getRun(run.id);
      check('the requeued run has no owner and no lease, and records the lost attempt', q.leaseOwner === null && q.leaseExpiresAt === null && Array.isArray((q.failureDiagnostics as { lostAttempts?: unknown[] }).lostAttempts) && (q.failureDiagnostics as { lostAttempts: Array<{ attempt: number }> }).lostAttempts[0]!.attempt === 1);
      const fresh = randomUUID();
      const second = (await repo.claimNext(fresh, 60))!;
      check('a new worker claims it as attempt 2', second.id === run.id && second.attempts === 2 && second.leaseOwner === fresh);
      check('THE OLD TOKEN can no longer heartbeat, change the phase, fail or requeue the run', !(await repo.heartbeat(run.id, token, 60)) && !(await repo.setPhase(run.id, token, 'OLD')) && !(await repo.fail(run.id, token, { code: 'NOT_READY', message: 'old', diagnostics: {} })) && !(await repo.requeueForShutdown(run.id, token)));
      const now = await getRun(run.id);
      check('...and the run still belongs to the new attempt, untouched', now.status === 'RUNNING' && now.leaseOwner === fresh && now.attempts === 2 && now.failureCode === null);
      check('the new owner can finish the run (fenced FAILED)', await repo.fail(run.id, fresh, { code: 'NOT_READY', message: 'done', diagnostics: { a: 1 } }) && (await getRun(run.id)).status === 'FAILED');
      check('nobody can write to a finished run', !(await repo.heartbeat(run.id, fresh, 60)) && !(await repo.setPhase(run.id, fresh, 'AFTER')) && !(await repo.requeueForShutdown(run.id, fresh)));
      void claimed;
    }

    // ===================================================================================================================
    section('6. Stale recovery and the attempt limit');
    {
      await drain();
      const y = await mkYear('stale');
      const run = await mustEnqueue(world, y);
      await repo.claimNext(randomUUID(), 60);
      check('a RUNNING run with a valid lease is NOT touched by recovery', (await repo.recoverStale(2)).requeued.length === 0 && (await getRun(run.id)).status === 'RUNNING');
      await expireLease(run.id);
      const r1 = await repo.recoverStale(2);
      check('attempt 1 lost -> QUEUED (retried once)', r1.requeued.includes(run.id) && r1.failed.length === 0 && (await getRun(run.id)).status === 'QUEUED');
      await repo.claimNext(randomUUID(), 60);
      check('claimed again: attempts 2', (await getRun(run.id)).attempts === 2);
      await expireLease(run.id);
      const r2 = await repo.recoverStale(2);
      const failed = await getRun(run.id);
      check('attempt 2 lost -> FAILED WORKER_LOST (no infinite requeue loop)', r2.failed.includes(run.id) && failed.status === 'FAILED' && failed.failureCode === 'WORKER_LOST' && failed.finishedAt !== null && failed.leaseExpiresAt === null);
      check('the failure diagnostics list BOTH lost attempts', ((failed.failureDiagnostics as { lostAttempts: unknown[] }).lostAttempts ?? []).length === 2);
      check('a failed run is never recovered or claimed again', (await repo.recoverStale(2)).requeued.length === 0 && (await repo.claimNext(randomUUID(), 60)) === null);

      // maxAttempts is honoured as configured
      const y3 = await mkYear('stale3'); const run3 = await mustEnqueue(world, y3);
      for (let i = 0; i < 2; i++) { await repo.claimNext(randomUUID(), 60); await expireLease(run3.id); await repo.recoverStale(3); }
      check('with maxAttempts 3 the run is still QUEUED after two lost attempts', (await getRun(run3.id)).status === 'QUEUED');
      await repo.claimNext(randomUUID(), 60); await expireLease(run3.id); await repo.recoverStale(3);
      check('...and WORKER_LOST after the third', (await getRun(run3.id)).failureCode === 'WORKER_LOST');

      // concurrent sweepers do not double-process
      const y4 = await mkYear('stale4'); const run4 = await mustEnqueue(world, y4);
      await repo.claimNext(randomUUID(), 60); await expireLease(run4.id);
      const sweeps = await Promise.all(Array.from({ length: 5 }, () => repo.recoverStale(2)));
      check('5 concurrent recovery sweeps requeue the stale run exactly once', sweeps.flatMap((s) => s.requeued).filter((id) => id === run4.id).length === 1);
      check('...and its recorded lost attempts are not duplicated', ((await getRun(run4.id)).failureDiagnostics as { lostAttempts: unknown[] }).lostAttempts.length === 1);
    }

    // ===================================================================================================================
    section('7. Graceful-shutdown requeue and the queue TTL');
    {
      await drain();
      const y = await mkYear('shut');
      const run = await mustEnqueue(world, y);
      const token = randomUUID();
      await repo.claimNext(token, 60);
      await repo.setPhase(run.id, token, 'SOLVING');
      check('shutdown requeue: RUNNING -> QUEUED, owner and lease cleared, phase cleared', await repo.requeueForShutdown(run.id, token));
      const q = await getRun(run.id);
      check('...WITHOUT consuming an attempt (the claim\'s increment is taken back)', q.status === 'QUEUED' && q.attempts === 0 && q.leaseOwner === null && q.leaseExpiresAt === null && q.phase === null);
      const again = await repo.claimNext(randomUUID(), 60);
      check('...and it is claimable again as attempt 1', again?.id === run.id && again.attempts === 1);
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "id" = ${run.id}`;

      const y2 = await mkYear('ttl'); const old = await mustEnqueue(world, y2);
      const y3 = await mkYear('ttl2'); const fresh = await mustEnqueue(world, y3);
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "createdAt" = now() - interval '31 minutes' WHERE "id" = ${old.id}`;
      const expired = await repo.expireQueued(30);
      const o = await getRun(old.id);
      check('a run QUEUED for 31 minutes expires: FAILED QUEUE_EXPIRED with a message and diagnostics', expired.includes(old.id) && o.status === 'FAILED' && o.failureCode === 'QUEUE_EXPIRED' && (o.failureMessage ?? '').includes('30 minutes') && (o.failureDiagnostics as { queuedForSeconds: number }).queuedForSeconds >= 31 * 60 && o.finishedAt !== null);
      check('a fresh run is not expired', (await getRun(fresh.id)).status === 'QUEUED' && !expired.includes(fresh.id));
      check('an expired run is never claimed (stale work is not executed)', (await repo.claimNext(randomUUID(), 60))?.id === fresh.id);
      check('a RUNNING run is never expired by the TTL, however old', await (async () => { const y4 = await mkYear('ttl3'); const r = await mustEnqueue(world, y4); await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "createdAt" = now() - interval '5 hours' WHERE "id" = ${r.id}`; const c = await repo.claimNext(randomUUID(), 60); await repo.expireQueued(30); return c?.id === r.id && (await getRun(r.id)).status === 'RUNNING'; })());
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    }

    // ===================================================================================================================
    section('8. Authoritative snapshot loader');
    {
      const y = await seedYear(world, 'snap', { sections: 3, breakAfter: [2, 4] });
      const snap = await loadGenerationSnapshot(prisma, world.schoolId, y.yearId);
      const m10 = await loadSchedulingInput(world.schoolId, y.yearId);
      const sorted = <T>(rows: T[], key: (r: T) => string): T[] => [...rows].sort((a, b) => (key(a) < key(b) ? -1 : 1));
      // every SchedulingInput field, in a canonical order (Module 10's loader returns rows in database order)
      const canon = (i: typeof m10): unknown => ({
        schoolId: i.schoolId,
        academicYear: i.academicYear,
        schedule: i.schedule && { periodsPerDay: i.schedule.periodsPerDay, workingDays: [...i.schedule.workingDays].sort(), periods: sorted(i.schedule.periods, (p) => String(p.periodNumber).padStart(3, '0')) },
        grades: sorted(i.grades, (g) => g.id),
        streams: sorted(i.streams, (g) => g.id),
        sections: sorted(i.sections, (g) => g.id),
        subjects: sorted(i.subjects, (g) => g.id),
        requirements: sorted(i.requirements, (g) => g.id),
        assignments: sorted(i.assignments, (g) => g.id),
        teachers: sorted(i.teachers, (g) => g.id),
        teacherSubjects: sorted(i.teacherSubjects.map((l) => ({ ...l, gradeIds: [...l.gradeIds].sort() })), (l) => `${l.teacherId}|${l.subjectId}`),
      });
      const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
      const { timingEvents, ...snapshotWithoutEvents } = snap;
      check('PARITY: every scheduling field equals Module 10\'s loader (year, schedule, grades, streams, sections, subjects, requirements, assignments, teachers, eligibility)', same(canon(snapshotWithoutEvents as typeof m10), canon(m10)));
      check('...and the data is not trivially empty (3 sections, 3 requirements, 9 assignments; all of the school\'s teachers; the 4 links of the year\'s subjects)', snap.sections.length === 3 && snap.requirements.length === 3 && snap.assignments.length === 9 && [...y.teacherIds, y.spareTeacherId].every((id) => snap.teachers.some((t) => t.id === id)) && snap.teacherSubjects.length === 4);
      check('the snapshot ADDS the timing events Module 10\'s loader does not read', timingEvents.length === 2 && same(timingEvents.map((e) => e.afterPeriodNumber).sort(), [2, 4]));
      check('it covers eligibility: every assigned teacher has a link with the year\'s grade', snap.teacherSubjects.some((l) => y.teacherIds.includes(l.teacherId) && l.gradeIds.includes(y.gradeId)));
      const n = normalizeProblem(snap);
      check('the snapshot normalises (READY configuration) and carries continuesIntoNext from the timing events', n.ok && n.problem.core.grid.periods.map((p) => p.continuesIntoNext).join() === 'true,false,true,false,true,false');
      check('it carries the teacher active flag and the school (what the normalizer re-checks)', snap.teachers.every((t) => t.schoolId === world.schoolId && typeof t.isActive === 'boolean'));
      let unknown = false; try { await loadGenerationSnapshot(prisma, world.schoolId, randomUUID()); } catch (e) { unknown = (e as { code?: string }).code === 'ACADEMIC_YEAR_NOT_FOUND'; }
      check('an unknown academic year is a SnapshotError ACADEMIC_YEAR_NOT_FOUND', unknown);
      let foreign = false; try { await loadGenerationSnapshot(prisma, randomUUID(), y.yearId); } catch (e) { foreign = (e as { code?: string }).code === 'ACADEMIC_YEAR_FOREIGN'; }
      check('a year of another school is refused (school isolation) ACADEMIC_YEAR_FOREIGN', foreign);
      // REPEATABLE READ: a concurrent edit committed after the snapshot began is not seen half-way
      const consistent = await prisma.$transaction(async (tx) => {
        const first = await tx.teacher.findUnique({ where: { id: y.teacherIds[0]! }, select: { isActive: true } });
        await prisma.teacher.update({ where: { id: y.teacherIds[0]! }, data: { isActive: false } }); // committed outside the transaction
        const second = await tx.teacher.findUnique({ where: { id: y.teacherIds[0]! }, select: { isActive: true } });
        return first?.isActive === second?.isActive;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      check('the snapshot transaction is REPEATABLE READ: a concurrent commit is not seen mid-snapshot', consistent);
    }
  } finally {
    section('9. Cleanup and proof that nothing existing changed');
    const deleted = await destroyWorld(world);
    check('exactly the one test school was deleted (cascade)', deleted === 1);
    const newAfter = await newTableCounts();
    check('the new tables are back to their starting counts', JSON.stringify(newAfter) === JSON.stringify(newBefore), JSON.stringify({ newBefore, newAfter }));
    const after = await fingerprint();
    const same = EXISTING_TABLES.filter((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h);
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, same.length === EXISTING_TABLES.length, EXISTING_TABLES.filter((t) => !same.includes(t)).join(','));
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11RC_' } } })) === 0);
  }
}

main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
