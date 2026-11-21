// Phase 5 tests, part 3: REAL PROCESSES. Runner workers are separate Node processes that are killed with `kill -9` at
// chosen points; the production Python solver is really running when it matters; faults go through the real
// SubprocessSolverClient; shutdown is a real SIGTERM. REAL PostgreSQL throughout.
//
// Run with   NODE_ENV=production npx tsx test-timetable-generation-runner-crash.ts
import 'dotenv/config'; // first: the database pool is created when a module imports src/config/database.ts
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadGenerationSnapshot } from './src/modules/timetable-generation/timetable-generation.loader.js';
import { evaluateMetrics } from './src/modules/timetable-generation/timetable-generation.metrics.js';
import { normalizeProblem } from './src/modules/timetable-generation/timetable-generation.normalizer.js';
import { canonicalJson } from './src/modules/timetable-generation/timetable-generation.hash.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { REPO_ROOT, resolveSolverClientConfig, SubprocessSolverClient } from './src/modules/timetable-generation/timetable-generation.solver-client.js';
import { validateEntries } from './src/modules/timetable-generation/timetable-generation.validator.js';
import {
  assertQueueIsEmpty, captureLogger, createWorld, destroyWorld, EXISTING_TABLES, fastConfig, fingerprint, getRun, mustEnqueue, newTableCounts, prisma,
  ScriptedSolver, seedYear, solution, waitFor, waitTerminal, rawPrisma, type SeededYear,
} from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);

const WORKER = path.join(REPO_ROOT, 'test-fixtures', 'timetable-generation', 'runner-worker.ts');
const FAKE = path.join(REPO_ROOT, 'test-fixtures', 'timetable-generation', 'fake-solvers', 'fake_solver.py');
const tmp = mkdtempSync(path.join(tmpdir(), 'runner-crash-'));
const workers: ChildProcess[] = [];

const solverProcesses = (): string[] => spawnSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(`${REPO_ROOT}/solver/main.py`) && !l.includes('ps -axo'));
const alive = (pid: number | undefined): boolean => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

interface Worker { child: ChildProcess; exited: Promise<{ code: number | null; signal: string | null }>; out: () => string }
function startWorker(env: Record<string, string>): Worker {
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER], { cwd: REPO_ROOT, env: { ...process.env, NODE_ENV: 'production', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  workers.push(child);
  let out = '';
  child.stdout?.on('data', (d: Buffer) => { out = (out + d.toString()).slice(-4_000); });
  child.stderr?.on('data', (d: Buffer) => { out = (out + d.toString()).slice(-4_000); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, out: () => out };
}
const kill9 = async (w: Worker): Promise<void> => { w.child.kill('SIGKILL'); await w.exited; };
const leaseExpired = async (id: string): Promise<boolean> => (await prisma.$queryRaw<Array<{ e: boolean }>>`SELECT ("leaseExpiresAt" < now()) AS e FROM "timetable_generation_runs" WHERE "id" = ${id}`)[0]?.e === true;

async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();
  const world = await createWorld('M11CR');
  const mkYear = (tag: string, o: Parameters<typeof seedYear>[2] = {}): Promise<SeededYear> => seedYear(world, tag, o);
  // a tight school (29 of 30 weekly slots per section): CP-SAT cannot prove optimality quickly, so the solve really takes seconds
  const TIGHT = { sections: 3, subjects: [6, 6, 6, 6, 5] };
  const versionsOf = (yearId: string) => prisma.timetableVersion.findMany({ where: { academicYearId: yearId }, orderBy: { versionNumber: 'asc' } });
  const entryCount = (yearId: string) => prisma.timetableEntry.count({ where: { version: { academicYearId: yearId } } });
  const scripted = () => { const { logger } = captureLogger(); const solver = new ScriptedSolver((ctx) => solution(ctx.problem)); return { solver, runner: new GenerationRunner({ prisma: rawPrisma, solverClient: solver, config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: 10 }, logger }) }; };
  const realRunner = () => { const { logger } = captureLogger(); return new GenerationRunner({ prisma: rawPrisma, solverClient: new SubprocessSolverClient(resolveSolverClientConfig({}, {})), config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: 10 }, logger }); };

  try {
    // ===================================================================================================================
    section('1. kill -9 of a runner process at chosen points, then recovery by another runner');
    const crashCase = async (label: string, hold: string, o: { tight?: boolean; real?: boolean; expectPython?: boolean; checkLocksReleased?: boolean } = {}): Promise<void> => {
      const y = await mkYear('crash', o.tight ? TIGHT : {});
      const q = await mustEnqueue(world, y);
      const ready = path.join(tmp, `${label.replace(/\W+/g, '_')}.ready`);
      const w = startWorker({ HOLD_AT: hold, READY_FILE: ready, SOLVER: 'real', RUNNER_CONFIG: '{}', READY_DELAY_MS: '200' });
      const reached = await waitFor(() => existsSync(ready), 90_000, 100);
      check(`${label}: the worker process reached the freeze point`, reached, w.out().slice(-400));
      const pythonNow = solverProcesses().length; // looked at BEFORE any database round trip, while the solve is still in progress
      const mid = await getRun(q.id);
      if (o.expectPython) check(`${label}: the production Python solver process is running`, pythonNow >= 1, String(pythonNow));
      check(`${label}: the run is RUNNING, owned by the worker, attempt 1`, mid.status === 'RUNNING' && mid.leaseOwner !== null && mid.attempts === 1, `${mid.status} ${mid.attempts}`);
      if (hold === 'persist:beforeCommit') {
        check(`${label}: the open transaction has written everything, but NOTHING is visible to other connections yet`, (await versionsOf(y.yearId)).length === 0 && (await entryCount(y.yearId)) === 0);
      }
      const crashedPhase = mid.phase;
      await kill9(w);
      if (o.expectPython) check(`${label}: the orphaned Python solver ends by itself within 8 s (parent-death watchdog)`, await waitFor(() => solverProcesses().length === 0, 8_000, 200), String(solverProcesses().length));
      const after = await getRun(q.id);
      check(`${label}: after the crash the run is still RUNNING (nobody recorded anything) and nothing was persisted`, after.status === 'RUNNING' && after.versionId === null && (await versionsOf(y.yearId)).length === 0 && (await entryCount(y.yearId)) === 0);
      if (o.checkLocksReleased) {
        const t0 = Date.now();
        await prisma.$executeRaw`UPDATE "teachers" SET "name" = "name" WHERE "id" = ${y.teacherIds[0]!}`;
        check(`${label}: the dead process left NO locks behind (an UPDATE of a locked teacher row completes at once)`, Date.now() - t0 < 5_000, `${Date.now() - t0} ms`);
      }
      check(`${label}: the lease expires on its own (database clock)`, await waitFor(() => leaseExpired(q.id), 15_000, 250));

      const rec = o.real ? { runner: realRunner(), solver: null } : scripted();
      await rec.runner.dispatch();
      const done = await waitTerminal(q.id, 120_000);
      await rec.runner.stop(8);
      const versions = await versionsOf(y.yearId);
      check(`${label}: another runner requeued the stale run and completed it as attempt 2 -> SUCCEEDED`, done.status === 'SUCCEEDED' && done.attempts === 2 && rec.runner.stats.recoveredRequeued === 1, `${done.status} attempts=${done.attempts}`);
      const expectedEntries = y.subjectPeriods.reduce((a, b) => a + b, 0) * y.sectionIds.length;
      check(`${label}: exactly ONE version exists (the crashed attempt left none behind), with all ${expectedEntries} entries`, versions.length === 1 && (await entryCount(y.yearId)) === expectedEntries, `${versions.length} versions, ${await entryCount(y.yearId)} entries`);
      check(`${label}: the lost attempt is recorded in the diagnostics (phase at the time: ${crashedPhase})`, ((done.failureDiagnostics as { lostAttempts?: Array<{ attempt: number }> } | null)?.lostAttempts ?? []).length === 1);
      if (o.real) {
        const v = versions[0]!;
        const snap = normalizeProblem(await loadGenerationSnapshot(prisma, world.schoolId, y.yearId));
        if (snap.ok) {
          const requirementToAssignment = new Map(snap.problem.core.assignments.map((a) => [`${a.sectionId}|${a.subjectRequirementId}`, a]));
          const rows = await prisma.timetableEntry.findMany({ where: { versionId: v.id } });
          const entries = rows.map((r) => { const a = requirementToAssignment.get(`${r.sectionId}|${r.subjectRequirementId}`)!; return { assignmentId: a.id, sectionId: r.sectionId, subjectId: r.subjectId, teacherId: r.teacherId, dayOfWeek: r.dayOfWeek, periodNumber: r.periodNumber }; });
          check(`${label}: END TO END with the production solver: the stored timetable passes the independent validator`, validateEntries(snap.problem, entries).valid);
          check(`${label}: ...and the stored AUTHORITATIVE metrics equal an independent re-evaluation of what is in the database`, canonicalJson(JSON.parse(JSON.stringify(v.metrics))) === canonicalJson(JSON.parse(JSON.stringify(evaluateMetrics(snap.problem, entries)))));
          check(`${label}: ...solutionSource CP_SAT, status OPTIMAL or FEASIBLE, OR-Tools 9.15.6755 recorded`, v.solutionSource === 'CP_SAT' && ['OPTIMAL', 'FEASIBLE'].includes(v.solverStatus) && (v.solverDiagnostics as { solver: { ortoolsVersion: string } }).solver.ortoolsVersion === '9.15.6755');
          check(`${label}: ...input hash matches the current configuration`, v.inputHash === snap.problem.inputHash);
        }
      }
    };
    await crashCase('crash before the solver starts (while loading the snapshot)', 'phase:SNAPSHOT');
    await crashCase('crash during the baseline phase', 'phase:BASELINE');
    await crashCase('crash during the real Python solve', 'solver:running', { tight: true, real: true, expectPython: true });
    await crashCase('crash inside the final transaction (after locks)', 'persist:afterLocks', { checkLocksReleased: true });
    await crashCase('crash inside the final transaction, everything written, just before COMMIT', 'persist:beforeCommit', { checkLocksReleased: true });

    // ===================================================================================================================
    section('2. A run whose workers die on every attempt ends WORKER_LOST');
    {
      const y = await mkYear('lost');
      const q = await mustEnqueue(world, y);
      const files = [path.join(tmp, 'lost1.ready'), path.join(tmp, 'lost2.ready')];
      const w1 = startWorker({ HOLD_AT: 'phase:BASELINE', READY_FILE: files[0]!, SOLVER: 'real' });
      await waitFor(() => existsSync(files[0]!), 60_000, 100);
      await kill9(w1);
      await waitFor(() => leaseExpired(q.id), 15_000, 250);
      const w2 = startWorker({ HOLD_AT: 'phase:BASELINE', READY_FILE: files[1]!, SOLVER: 'real' }); // its own sweep requeues and claims: attempt 2
      const reached = await waitFor(() => existsSync(files[1]!), 60_000, 100);
      check('the second worker recovered the run and is working on attempt 2', reached && (await getRun(q.id)).attempts === 2 && (await getRun(q.id)).status === 'RUNNING');
      await kill9(w2);
      await waitFor(() => leaseExpired(q.id), 15_000, 250);
      const sweeper = scripted();
      await sweeper.runner.dispatch();
      const lost = await getRun(q.id);
      await sweeper.runner.stop(5);
      check('the second attempt died too: FAILED WORKER_LOST (no third attempt)', lost.status === 'FAILED' && lost.failureCode === 'WORKER_LOST' && lost.attempts === 2 && sweeper.runner.stats.recoveredFailed === 1);
      check('...both lost attempts are recorded, the healthy runner never solved it, no version', ((lost.failureDiagnostics as { lostAttempts: unknown[] }).lostAttempts ?? []).length === 2 && sweeper.solver.calls.length === 0 && (await versionsOf(y.yearId)).length === 0);
      check('...and a new generation is allowed afterwards (the failed run no longer holds the year)', (await mustEnqueue(world, y)).status === 'QUEUED');
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    }

    // ===================================================================================================================
    section('3. Graceful shutdown with a REAL solver process (real SIGTERM to a runner process)');
    {
      const y = await mkYear('graceful', TIGHT);
      const q = await mustEnqueue(world, y);
      const w = startWorker({ SOLVER: 'real' });
      const solving = await waitFor(() => solverProcesses().length >= 1, 90_000, 150);
      check('the production Python solver is running inside the worker', solving);
      const t0 = Date.now();
      w.child.kill('SIGTERM');
      const exit = await w.exited;
      const took = Date.now() - t0;
      check('the worker process exits cleanly (code 0) on SIGTERM and promptly', exit.code === 0 && took < 20_000, `${JSON.stringify(exit)} ${took} ms`);
      check('its output reports the graceful stop: 1 run aborted, none still active, 1 requeued', /"stopped":true/.test(w.out()) && /"aborted":1/.test(w.out()) && /"stillActive":0/.test(w.out()) && /"requeued":1/.test(w.out()), w.out().slice(-300));
      check('the solver subprocess was ended explicitly (it is detached, so the runner terminates it): no solver process remains', await waitFor(() => solverProcesses().length === 0, 8_000, 200));
      const r = await getRun(q.id);
      check('the run was REQUEUED, not orphaned: QUEUED, no owner, no lease, attempts back to 0, no version', r.status === 'QUEUED' && r.leaseOwner === null && r.leaseExpiresAt === null && r.attempts === 0 && r.versionId === null && (await versionsOf(y.yearId)).length === 0);
      const rec = realRunner();
      await rec.dispatch();
      const done = await waitTerminal(q.id, 120_000);
      await rec.stop(8);
      check('a fresh runner picks the requeued run up and completes it with the real solver as attempt 1', done.status === 'SUCCEEDED' && done.attempts === 1 && (await versionsOf(y.yearId)).length === 1);
    }

    // ===================================================================================================================
    section('4. Faults through the REAL SubprocessSolverClient (fake Python modes): the B / D4 rule end to end');
    {
      const fakeRunner = (mode: string, over: { python?: string; policy?: number } = {}) => {
        const { logger } = captureLogger();
        const cfg = resolveSolverClientConfig({}, { entrypointPath: FAKE, entrypointArgs: [mode, `crash-suite-${mode}`], cwd: path.dirname(FAKE), killGraceMs: 300, terminateWaitMs: 400, ...(over.python ? { pythonPath: over.python } : {}) });
        return new GenerationRunner({ prisma: rawPrisma, solverClient: new SubprocessSolverClient(cfg), config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: over.policy ?? 30 }, logger });
      };
      const table: Array<[string, string, 'SUCCEEDED' | 'FAILED', string, { python?: string; policy?: number }?]> = [
        ['Python unavailable (interpreter missing)', 'echo', 'FAILED', 'SOLVER_UNAVAILABLE', { python: '/nonexistent/bin/python3' }],
        ['Python crash (exit code 3)', 'crash3', 'FAILED', 'SOLVER_CRASHED'],
        ['Python killed by a signal (segfault)', 'segv', 'FAILED', 'SOLVER_CRASHED'],
        ['malformed stdout (not JSON)', 'not-json', 'FAILED', 'SOLVER_INVALID_OUTPUT'],
        ['empty stdout', 'empty', 'FAILED', 'SOLVER_INVALID_OUTPUT'],
        ['a document for another request', 'wrong-request-id', 'FAILED', 'SOLVER_INVALID_OUTPUT'],
        ['an invalid timetable (everything on Monday period 1)', 'invalid-timetable', 'FAILED', 'SOLVER_INVALID_OUTPUT'],
        ['a clean UNKNOWN document', 'echo', 'SUCCEEDED', 'BASELINE'],
        ['a hung solver killed by the watchdog (timeout)', 'hang', 'SUCCEEDED', 'BASELINE', { policy: 25 }],
      ];
      for (const [name, mode, expected, detail, over] of table) {
        const y = await mkYear('fake');
        const runner = fakeRunner(mode, over ?? {});
        const q = await mustEnqueue(world, y);
        const t0 = Date.now();
        await runner.dispatch();
        const run = await waitTerminal(q.id, 60_000);
        await runner.stop(5);
        const versions = await versionsOf(y.yearId);
        if (expected === 'FAILED') {
          check(`${name}: FAILED ${detail}, no version, no baseline fallback`, run.status === 'FAILED' && run.failureCode === detail && versions.length === 0 && run.versionId === null, `${run.status} ${run.failureCode} fallbackReason=${(run.resultSummary as { fallbackReason?: string } | null)?.fallbackReason} diag=${JSON.stringify(run.failureDiagnostics)?.slice(0, 200)}`);
        } else {
          check(`${name}: SUCCEEDED with the validated BASELINE`, run.status === 'SUCCEEDED' && versions.length === 1 && versions[0]!.solutionSource === 'BASELINE' && versions[0]!.solverStatus === 'UNKNOWN', `${run.status} ${versions[0]?.solutionSource} fallbackReason=${(run.resultSummary as { fallbackReason?: string } | null)?.fallbackReason}`);
          if (mode === 'hang') {
            const elapsed = Date.now() - t0;
            const lingering = spawnSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes('crash-suite-hang')).length;
            const fallbackReason = (run.resultSummary as { fallbackReason?: string } | null)?.fallbackReason;
            check(`${name}: the watchdog fired at the deadline, not much later (${elapsed} ms) and no process remains`, fallbackReason === 'KILLED_BY_WATCHDOG' && elapsed < 30_000 && lingering === 0, `fallbackReason=${fallbackReason} elapsed=${elapsed} lingering=${lingering}`);
          }
        }
      }
    }

    // ===================================================================================================================
    section('5. Two runner PROCESSES over one database: nothing is claimed twice');
    {
      const years = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => mkYear(`mp${i}`)));
      const runs = [];
      for (const y of years) runs.push(await mustEnqueue(world, y));
      const common = { SOLVER: 'fake:echo', RUNNER_CONFIG: JSON.stringify({ concurrency: 1 }), TIME_POLICY: JSON.stringify({ le10: 8 }) };
      const a = startWorker(common); const b = startWorker(common);
      for (const r of runs) await waitTerminal(r.id, 120_000);
      a.child.kill('SIGTERM'); b.child.kill('SIGTERM');
      const [ea, eb] = await Promise.all([a.exited, b.exited]);
      const finals = await Promise.all(runs.map((r) => getRun(r.id)));
      check('all 6 runs finished SUCCEEDED across two processes', finals.every((r) => r.status === 'SUCCEEDED'));
      check('every run was claimed exactly once (attempts = 1 for all)', finals.every((r) => r.attempts === 1));
      check('every academic year has exactly one version', (await Promise.all(years.map(async (y) => (await versionsOf(y.yearId)).length))).every((n) => n === 1));
      check('both worker processes shut down gracefully (exit 0)', ea.code === 0 && eb.code === 0, `${JSON.stringify(ea)} ${JSON.stringify(eb)}`);
      const claimed = [a.out(), b.out()].map((o) => Number(/"claimed":(\d+)/.exec(o)?.[1] ?? 0));
      check('the two processes together claimed exactly 6 runs', claimed[0]! + claimed[1]! === 6, claimed.join('+'));
    }
  } finally {
    section('6. Cleanup and proof that nothing existing changed, nothing is left running');
    for (const w of workers) if (alive(w.pid)) w.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 1_500));
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    const deleted = await destroyWorld(world);
    check('exactly the one test school was deleted (cascade)', deleted === 1);
    const newAfter = await newTableCounts();
    check('the new tables are back to their starting counts', JSON.stringify(newAfter) === JSON.stringify(newBefore), JSON.stringify({ newBefore, newAfter }));
    const after = await fingerprint();
    const unchanged = EXISTING_TABLES.filter((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h);
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, unchanged.length === EXISTING_TABLES.length, EXISTING_TABLES.filter((t) => !unchanged.includes(t)).join(','));
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11CR_' } } })) === 0);
    check('no runner worker process remains', workers.every((w) => !alive(w.pid)));
    check('no solver process remains', solverProcesses().length === 0, solverProcesses().join(' | '));
    rmSync(tmp, { recursive: true, force: true });
  }
}

main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
