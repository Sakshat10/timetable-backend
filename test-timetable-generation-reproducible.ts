// Module 11 - reproducibility fix: in reproducible mode the DETERMINISTIC solver limit must come from the policy budget, never from the
// remaining wall-clock time (which depends on how long database work before the solve took).
//
//   A  pure: buildSolverOptions with the elapsed time varied (the defect itself)
//   B  through the real runner: the clock is jumped by a chosen amount between "run started" and "solver options built"
//   C  the real Python solver end to end with different amounts of preceding time
//   D  what the budgets mean together: deterministic limit, overall deadline, watchdog, termination
import 'dotenv/config'; // first: the database pool is created when a module imports src/config/database.ts
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { buildSolverOptions } from './src/modules/timetable-generation/timetable-generation.solver-options.js';
import {
  DEFAULT_TIME_POLICY, DETERMINISTIC_TIME_RATIO, resolveDeterministicTimeLimit, resolveKillAfterSeconds, resolveTimeLimitSeconds, type TimeLimitPolicy,
} from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { REPO_ROOT, resolveSolverClientConfig, SubprocessSolverClient, type SolverClient } from './src/modules/timetable-generation/timetable-generation.solver-client.js';
import { hashJson } from './src/modules/timetable-generation/timetable-generation.hash.js';
import {
  assertQueueIsEmpty, captureLogger, createWorld, destroyWorld, EXISTING_TABLES, fastConfig, fingerprint, mustEnqueue, newTableCounts, noSolution, prisma, rawPrisma, ScriptedSolver,
  seedYear, solution, waitTerminal, watchdog, type SeededYear,
} from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const solverProcesses = (): string[] => spawnSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(`${REPO_ROOT}/solver/main.py`) && !l.includes('ps -axo'));

/** A clock that runs normally, except that every reading AFTER the first one is `offsetMs` later: "the work before the solve took offsetMs longer". */
const jumpClock = (offsetMs: number) => { let n = 0; return (): number => performance.now() + (n++ === 0 ? 0 : offsetMs); };

async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();

  // ===================================================================================================================
  section('A. buildSolverOptions: the deterministic limit does not move with the elapsed time');
  {
    const build = (elapsedMs: number, over: Partial<Parameters<typeof buildSolverOptions>[0]> = {}) =>
      buildSolverOptions({ sectionCount: 3, elapsedMs, seed: 31337, numWorkers: 2, reproducible: true, ...over });
    const elapsed = [0, 1, 500, 1_000, 1_500, 2_999, 4_000, 6_500, 8_000, 9_000];
    const results = elapsed.map((ms) => build(ms));
    check('every elapsed time up to 9 s leaves a startable solver', results.every((r) => r.ok));
    const limits = results.map((r) => (r.ok ? r.options.deterministicTimeLimit : null));
    check(`THE DEFECT: the deterministic limit is identical for every elapsed time (${[...new Set(limits)].join(',')})`, new Set(limits).size === 1 && limits[0] === resolveDeterministicTimeLimit(10));
    check('...and it is the policy-budget limit, round(0.45 x 10 s) = 5', limits[0] === Math.round(10 * DETERMINISTIC_TIME_RATIO) && limits[0] === 5);
    const walls = results.map((r) => (r.ok ? r.options.timeLimitSeconds : -1));
    check('the WALL-CLOCK limit still follows the remaining budget (never above it): 10 -> 9 -> ... -> 1', walls[0] === 10 && walls.every((w, i) => i === 0 || w <= walls[i - 1]!) && walls[walls.length - 1] === 1, walls.join(','));
    check('the wall-clock limit is exactly floor(budget - elapsed)', elapsed.every((ms, i) => walls[i] === Math.floor(10 - ms / 1000)));
    const exhausted = build(9_001);
    check('less than 1 whole second left is still BUDGET_EXHAUSTED, reproducible or not (the overall bound is unchanged)', !exhausted.ok && exhausted.reason === 'BUDGET_EXHAUSTED' && !build(9_001, { reproducible: false }).ok);
    check('the limit does not depend on the seed or the worker count', new Set([build(0, { seed: 1 }), build(0, { seed: 999 }), build(0, { numWorkers: 1 }), build(0, { numWorkers: 8 })].map((r) => (r.ok ? r.options.deterministicTimeLimit : -1))).size === 1);
    // the limit depends on the problem size through the policy tiers, as the budget does
    const tiers: Array<[number, number]> = [[3, 10], [10, 10], [11, 60], [50, 60], [51, 120], [100, 120], [101, 180], [400, 180]];
    check('it follows the policy tiers of the section count (budget 10/60/120/180 s)', tiers.every(([sections, budget]) => { const r = build(2_000, { sectionCount: sections }); return r.ok && r.budgetSeconds === budget && r.options.deterministicTimeLimit === resolveDeterministicTimeLimit(budget); }));
    const custom: TimeLimitPolicy = { ...DEFAULT_TIME_POLICY, le10: 25 };
    check('a configured policy changes the limit (25 s budget -> 11), still independent of the elapsed time', [0, 3_000, 12_000].every((ms) => { const r = build(ms, { policy: custom }); return r.ok && r.options.deterministicTimeLimit === resolveDeterministicTimeLimit(25) && r.options.deterministicTimeLimit === 11; }));
    check('the policy maximum still caps the budget, and the deterministic limit follows the capped budget (300 s -> 135)', (() => { const r = build(0, { sectionCount: 3, policy: { ...DEFAULT_TIME_POLICY, le10: 300 } }); return r.ok && r.budgetSeconds === 300 && r.options.deterministicTimeLimit === 135; })());
    check('the deterministic limit never exceeds the contract ceiling (3600) even for the largest policy', (() => { const r = build(0, { policy: { ...DEFAULT_TIME_POLICY, le10: 3600, max: 3600 } }); return r.ok && r.options.deterministicTimeLimit! <= 3600; })());
    check('NON-reproducible mode is exactly what it was: deterministic limit null, wall limit unchanged', elapsed.every((ms) => { const r = build(ms, { reproducible: false }); return r.ok && r.options.deterministicTimeLimit === null && r.options.reproducible === false && r.options.timeLimitSeconds === Math.floor(10 - ms / 1000); }));
    check('the kill deadline (the overall execution bound) is still wall limit + grace for every elapsed time', results.every((r) => r.ok && resolveKillAfterSeconds(r.options.timeLimitSeconds) === r.options.timeLimitSeconds + DEFAULT_TIME_POLICY.killGraceSeconds));
    check('the whole process can never run longer than budget + grace, reproducible or not', results.every((r) => r.ok && resolveKillAfterSeconds(r.options.timeLimitSeconds) <= resolveTimeLimitSeconds(3) + DEFAULT_TIME_POLICY.killGraceSeconds));
  }

  // ===================================================================================================================
  const world = await createWorld('M11RP');
  const runners: GenerationRunner[] = [];
  try {
    const policy = { ...DEFAULT_TIME_POLICY, le10: 10 };
    const mkYear = (tag: string): Promise<SeededYear> => seedYear(world, tag);
    /** One run through the real runner with the clock jumped by `offsetMs`. Returns the run, the options the solver received, and the result summary. */
    const runWith = async (solver: SolverClient, year: SeededYear, offsetMs: number, reproducible: boolean) => {
      const { logger } = captureLogger();
      const runner = new GenerationRunner({ prisma: rawPrisma, solverClient: solver, config: fastConfig(), policy, logger, now: jumpClock(offsetMs) });
      runners.push(runner);
      const queued = await mustEnqueue(world, year, { seed: 31337, reproducible });
      await runner.dispatch();
      const run = await waitTerminal(queued.id, 180_000);
      await runner.stop(5);
      return { run, summary: (run.resultSummary ?? {}) as { warnings?: string[]; fallbackReason?: string | null } };
    };
    const capturing = (script: ConstructorParameters<typeof ScriptedSolver>[0]) => new ScriptedSolver(script);

    // =================================================================================================================
    section('B. Through the real runner: the clock jumps between "run started" and "solver options built"');
    {
      // The budget is 10 s and the real work before the solve already takes 2-4 s on this database, so the largest jump must still leave the solver
      // startable (>= 1 s): the exhausted case has its own check below.
      const offsets = [0, 1_000, 2_500, 4_000];
      const seen: Array<{ offset: number; options: { timeLimitSeconds: number; deterministicTimeLimit: number | null; reproducible: boolean; seed: number } }> = [];
      for (const offset of offsets) {
        const y = await mkYear(`rp${offset}`);
        const solver = capturing((ctx) => solution(ctx.problem));
        const { run } = await runWith(solver, y, offset, true);
        check(`offset ${offset} ms: the run SUCCEEDED and the solver was called once`, run.status === 'SUCCEEDED' && solver.calls.length === 1, `${run.status} ${run.failureCode}`);
        seen.push({ offset, options: solver.calls[0]!.input.options });
      }
      check(`THE DEFECT through the real pipeline: the same problem, seed and settings get the SAME deterministic limit whatever preceded the solve (${seen.map((s) => s.options.deterministicTimeLimit).join(',')})`, new Set(seen.map((s) => s.options.deterministicTimeLimit)).size === 1 && seen[0]!.options.deterministicTimeLimit === 5);
      check('...while the wall-clock limit really did shrink with the preceding time (the clock jump was real: the 4 s jump shows in the budget)', new Set(seen.map((s) => s.options.timeLimitSeconds)).size > 1 && seen[0]!.options.timeLimitSeconds > seen[3]!.options.timeLimitSeconds && seen[3]!.options.timeLimitSeconds <= 6, seen.map((s) => s.options.timeLimitSeconds).join(','));
      check('seed and reproducibility reach the solver unchanged', seen.every((s) => s.options.seed === 31337 && s.options.reproducible === true));
      check('the kill deadline derives from the shrinking wall limit, never from the deterministic one', seen.every((s) => resolveKillAfterSeconds(s.options.timeLimitSeconds) === s.options.timeLimitSeconds + policy.killGraceSeconds));

      // non-reproducible: unchanged
      const plain: number[] = [];
      for (const offset of [0, 4_000]) {
        const y = await mkYear(`np${offset}`);
        const solver = capturing((ctx) => solution(ctx.problem));
        await runWith(solver, y, offset, false);
        const o = solver.calls[0]!.input.options;
        check(`non-reproducible, offset ${offset} ms: deterministic limit null, reproducible false`, o.deterministicTimeLimit === null && o.reproducible === false);
        plain.push(o.timeLimitSeconds);
      }
      check('...and its wall-clock limit follows the remaining time as before', plain[0]! > plain[1]!);

      // exhaustion: the overall bound still wins
      const yE = await mkYear('exhausted');
      const solverE = capturing((ctx) => solution(ctx.problem));
      const { run: runE, summary: sumE } = await runWith(solverE, yE, 9_900, true);
      check('INTERACTION WITH THE OVERALL DEADLINE: when under 1 s of the budget is left the solver is NOT started, even in reproducible mode', solverE.calls.length === 0);
      check('...the run SUCCEEDS with the validated baseline (NO_SOLUTION_WITHIN_BUDGET), exactly as before the fix, and says the wall clock ended it', runE.status === 'SUCCEEDED' && sumE.fallbackReason === 'NO_SOLUTION_WITHIN_BUDGET' && (sumE.warnings ?? []).includes('REPRODUCIBLE_RUN_STOPPED_BY_WALL_CLOCK'));
    }

    // =================================================================================================================
    section('D. How the budgets act together: which limit ended the search, and what the run says');
    {
      const withStop = (stoppedBy: 'OPTIMAL' | 'DETERMINISTIC_LIMIT' | 'TIME_LIMIT' | 'LIMIT_AMBIGUOUS', status: 'OPTIMAL' | 'FEASIBLE' = 'FEASIBLE') => (ctx: { problem: Parameters<typeof solution>[0] }) => {
        const r = solution(ctx.problem, status);
        if (r.attempt.kind === 'SOLUTION') r.attempt.diagnostics = { ...r.attempt.diagnostics, stoppedBy };
        return r;
      };
      const warningsOf = async (solver: SolverClient, reproducible: boolean, tag: string) => {
        const y = await mkYear(tag);
        const { run, summary } = await runWith(solver, y, 0, reproducible);
        return { run, warnings: summary.warnings ?? [] };
      };
      const W = 'REPRODUCIBLE_RUN_STOPPED_BY_WALL_CLOCK';
      const a = await warningsOf(capturing(withStop('DETERMINISTIC_LIMIT')), true, 'd1');
      check('reproducible, ended by the DETERMINISTIC limit: repeatable, no warning', a.run.status === 'SUCCEEDED' && !a.warnings.includes(W));
      const b = await warningsOf(capturing(withStop('OPTIMAL', 'OPTIMAL')), true, 'd2');
      check('reproducible, solved to OPTIMAL: repeatable, no warning', b.run.status === 'SUCCEEDED' && !b.warnings.includes(W));
      const c = await warningsOf(capturing(withStop('TIME_LIMIT')), true, 'd3');
      check('reproducible, ended by the WALL CLOCK: the run succeeds but warns that it may not be repeatable', c.run.status === 'SUCCEEDED' && c.warnings.includes(W));
      const amb = await warningsOf(capturing(withStop('LIMIT_AMBIGUOUS')), true, 'd8');
      check('reproducible, a NEAR-SIMULTANEOUS stop (LIMIT_AMBIGUOUS): the run succeeds but warns, because repeatability cannot be established', amb.run.status === 'SUCCEEDED' && amb.warnings.includes(W));
      const ambUnknown = await warningsOf(capturing(() => { const r = noSolution(); if (r.attempt.kind === 'NO_SOLUTION') r.attempt.diagnostics = { ...r.attempt.diagnostics, stoppedBy: 'LIMIT_AMBIGUOUS' }; return r; }), true, 'd9');
      check('reproducible, an UNKNOWN with an ambiguous stop: baseline (existing rule) AND the warning', ambUnknown.run.status === 'SUCCEEDED' && ambUnknown.warnings.includes(W) && ((ambUnknown.run.resultSummary as { fallbackReason: string }).fallbackReason === 'NO_SOLUTION_WITHIN_BUDGET'));
      const ambPlain = await warningsOf(capturing(withStop('LIMIT_AMBIGUOUS')), false, 'd10');
      check('NON-reproducible with an ambiguous stop value: no warning (nothing was promised)', ambPlain.run.status === 'SUCCEEDED' && !ambPlain.warnings.includes(W));
      const d = await warningsOf(capturing(withStop('TIME_LIMIT')), false, 'd4');
      check('NON-reproducible, ended by the wall clock: no warning (nothing was promised)', d.run.status === 'SUCCEEDED' && !d.warnings.includes(W));
      const e = await warningsOf(capturing(() => watchdog()), true, 'd5');
      check('reproducible, the solver was KILLED at its deadline: baseline used (existing rule) and the warning is recorded', e.run.status === 'SUCCEEDED' && e.warnings.includes(W) && e.run.resultSummary !== null && (e.run.resultSummary as { fallbackReason: string }).fallbackReason === 'KILLED_BY_WATCHDOG');
      const f = await warningsOf(capturing(() => noSolution()), true, 'd6');
      check('reproducible, a clean UNKNOWN at the deterministic limit: baseline (existing rule), no wall-clock warning', f.run.status === 'SUCCEEDED' && !f.warnings.includes(W));
      const g = await warningsOf(capturing(() => noSolution()), false, 'd7');
      check('the same UNKNOWN without reproducible mode: identical behaviour, no warning', g.run.status === 'SUCCEEDED' && !g.warnings.includes(W));
    }

    // =================================================================================================================
    section('C. The real Python solver: the same input after different amounts of preceding time');
    {
      const inner = new SubprocessSolverClient(resolveSolverClientConfig({}, {}));
      const trace: Array<{ limit: number | null; wall: number; stoppedBy: string | undefined }> = [];
      const spy: SolverClient = {
        async solve(request, options) {
          const result = await inner.solve(request, options);
          const diagnostics = result.attempt.kind === 'SOLUTION' || result.attempt.kind === 'NO_SOLUTION' ? result.attempt.diagnostics : undefined;
          trace.push({ limit: request.input.options.deterministicTimeLimit, wall: request.input.options.timeLimitSeconds, stoppedBy: diagnostics?.stoppedBy });
          return result;
        },
      };
      const offsets = [0, 0, 1_000, 2_000, 3_000, 0, 1_000, 2_000];
      const outcomes: Array<{ offset: number; hash: string; limit: number | null; wall: number; stoppedBy: string }> = [];
      const warned: boolean[] = [];
      // ONE academic year for all eight runs: the solver sorts everything by id, so two different years (different random ids) are two different
      // inputs. Reproducibility is about the SAME input.
      const y = await mkYear('real');
      for (const offset of offsets) {
        const { run, summary } = await runWith(spy, y, offset, true);
        warned.push((summary.warnings ?? []).includes('REPRODUCIBLE_RUN_STOPPED_BY_WALL_CLOCK'));
        const version = run.versionId ? await prisma.timetableEntry.findMany({ where: { versionId: run.versionId } }) : [];
        const t = trace[trace.length - 1]!;
        const shape = hashJson(version.map((e) => `${e.sectionId}|${e.subjectRequirementId}|${e.teacherId}|${e.dayOfWeek}|${e.periodNumber}`).sort());
        outcomes.push({ offset, hash: shape, limit: t.limit, wall: t.wall, stoppedBy: t.stoppedBy ?? 'NONE' });
        check(`offset ${offset} ms: the run SUCCEEDED from CP-SAT (limit ${t.limit}, wall budget ${t.wall} s, ended by ${t.stoppedBy})`, run.status === 'SUCCEEDED' && version.length === 36, `${run.status} ${run.failureCode}`);
      }
      check('THE REGRESSION: all eight runs received the SAME deterministic limit although the wall budgets differed', new Set(outcomes.map((o) => o.limit)).size === 1 && outcomes[0]!.limit === 5 && new Set(outcomes.map((o) => o.wall)).size > 1, outcomes.map((o) => `${o.limit}/${o.wall}`).join(' '));
      const confirmed = outcomes.filter((o) => o.stoppedBy === 'DETERMINISTIC_LIMIT' || o.stoppedBy === 'OPTIMAL');
      const ambiguous = outcomes.filter((o) => o.stoppedBy === 'LIMIT_AMBIGUOUS');
      const wallEnds = outcomes.filter((o) => o.stoppedBy === 'TIME_LIMIT');
      check('every run is classified (no run lacks a stop reason)', confirmed.length + ambiguous.length + wallEnds.length === outcomes.length, JSON.stringify(outcomes.map((o) => o.stoppedBy)));
      check(`every run whose stop is CONFIRMED (deterministic limit or optimal) produced the IDENTICAL timetable (${confirmed.length} of ${outcomes.length})`, confirmed.length === 0 || new Set(confirmed.map((o) => o.hash)).size === 1, confirmed.map((o) => o.hash.slice(0, 8)).join(','));
      check('the warning is recorded for EXACTLY the runs whose stop is not confirmed deterministic (wall clock or ambiguous)', warned.every((w, i) => w === (outcomes[i]!.stoppedBy === 'TIME_LIMIT' || outcomes[i]!.stoppedBy === 'LIMIT_AMBIGUOUS')), JSON.stringify(warned));
      const unconfirmedAll = [...ambiguous, ...wallEnds];
      console.log(`  info: confirmed deterministic/optimal: ${confirmed.length}, ambiguous (near both limits): ${ambiguous.length}, wall clock: ${wallEnds.length}; the same timetable is PROMISED only for the confirmed group`);
      console.log(`  info: all ${outcomes.length} timetables identical: ${new Set(outcomes.map((o) => o.hash)).size === 1} (an observation, not a guarantee, for the ${unconfirmedAll.length} unconfirmed runs)`);
      check('no solver process remains', solverProcesses().length === 0);
    }
  } finally {
    section('E. Cleanup and proof that nothing existing changed');
    for (const r of runners) { try { await r.stop(5); } catch { /* already stopped */ } }
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    check('exactly the one test school was deleted (cascade)', (await destroyWorld(world)) === 1);
    check('the new tables are back to their starting counts', JSON.stringify(await newTableCounts()) === JSON.stringify(newBefore));
    const after = await fingerprint();
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, EXISTING_TABLES.every((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h));
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11RP_' } } })) === 0);
    check('no solver process remains', solverProcesses().length === 0);
  }
}

main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
