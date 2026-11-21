// Phase 5 tests, part 2: the orchestration pipeline end to end on REAL PostgreSQL with a scripted solver:
// outcomes and the B/D4 rule, time budget, configuration-change races at every phase, the locks of the final
// transaction, persistence atomicity, leases / heartbeats / stale workers, concurrency and graceful shutdown.
//
// Run with   NODE_ENV=production npx tsx test-timetable-generation-runner.ts
import 'dotenv/config'; // first: the database pool is created when a module imports src/config/database.ts
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { buildBaseline } from './src/modules/timetable-generation/timetable-generation.baseline.js';
import {
  ConfigurationChangedError, LeaseLostError, persistGeneratedVersionOnce, type PersistParams,
} from './src/modules/timetable-generation/timetable-generation.final-persist.js';
import { canonicalJson } from './src/modules/timetable-generation/timetable-generation.hash.js';
import { loadGenerationSnapshot } from './src/modules/timetable-generation/timetable-generation.loader.js';
import { evaluateMetrics } from './src/modules/timetable-generation/timetable-generation.metrics.js';
import { normalizeProblem } from './src/modules/timetable-generation/timetable-generation.normalizer.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { RunRepository, type RunRecord } from './src/modules/timetable-generation/timetable-generation.run-repository.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { type GenerationPhase, type OrchestratorHooks } from './src/modules/timetable-generation/timetable-generation.orchestrator.js';
import {
  abortableSleep, assertQueueIsEmpty, captureLogger, createWorld, deferred, destroyWorld, enqueueFor, EXISTING_TABLES, fakeInfo, fastConfig, feasibleAfter,
  fingerprint, getRun, infeasible, infraRetries, mustEnqueue, newTableCounts, noSolution, outputFault, prisma, processFault, rawPrisma, ScriptedSolver, seedYear, sleep, solution,
  validEntries, waitFor, waitTerminal, watchdog, type SeededYear, type SolveCtx, type World,
} from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
/** PostgreSQL jsonb does not preserve object key order: compare structurally. */
const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(json(a)) === canonicalJson(json(b));

// a second connection pool, used to play "another admin editing the configuration" while the runner holds its locks
const writerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 20, connectionTimeoutMillis: 30_000 });
const writer = new PrismaClient({ adapter: new PrismaPg(writerPool) });

interface Rig { runner: GenerationRunner; solver: ScriptedSolver; lines: ReturnType<typeof captureLogger>['lines'] }
interface RigOptions {
  config?: Partial<ReturnType<typeof fastConfig>>;
  hooks?: OrchestratorHooks;
  now?: () => number;
  repo?: RunRepository;
  buildBaseline?: typeof buildBaseline;
  solver?: ScriptedSolver;
  policy?: typeof DEFAULT_TIME_POLICY;
}
const rig = (script: (ctx: SolveCtx) => ReturnType<ScriptedSolver['script']>, o: RigOptions = {}): Rig => {
  const solver = o.solver ?? new ScriptedSolver(script);
  const { logger, lines } = captureLogger();
  const runner = new GenerationRunner({
    prisma: rawPrisma, solverClient: solver, config: fastConfig(o.config), policy: o.policy ?? { ...DEFAULT_TIME_POLICY, le10: 10 }, logger,
    ...(o.hooks ? { hooks: o.hooks } : {}), ...(o.now ? { now: o.now } : {}), ...(o.repo ? { repo: o.repo } : {}), ...(o.buildBaseline ? { buildBaseline: o.buildBaseline } : {}),
  });
  return { runner, solver, lines };
};
const feasible = (ctx: SolveCtx) => solution(ctx.problem);

async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();
  const world: World = await createWorld('M11RN');
  const seeded: SeededYear[] = [];
  const mkYear = async (tag: string, o: Parameters<typeof seedYear>[2] = {}): Promise<SeededYear> => { const y = await seedYear(world, tag, o); seeded.push(y); return y; };
  const versionsOf = (yearId: string) => prisma.timetableVersion.findMany({ where: { academicYearId: yearId }, orderBy: { versionNumber: 'asc' } });
  const entriesOf = (versionId: string) => prisma.timetableEntry.findMany({ where: { versionId } });
  const problemOf = async (y: SeededYear) => { const n = normalizeProblem(await loadGenerationSnapshot(prisma, world.schoolId, y.yearId)); if (!n.ok) throw new Error('not normalisable'); return n.problem; };
  /** Enqueue, run to a terminal state with a fresh runner, stop it, return the final run. */
  const execute = async (rg: Rig, y: SeededYear | string, enq: Parameters<typeof enqueueFor>[2] = {}): Promise<RunRecord> => {
    const queued = await mustEnqueue(world, y, enq);
    await rg.runner.dispatch();
    const run = await waitTerminal(queued.id, 90_000);
    await rg.runner.stop(5);
    return run;
  };
  const drain = () => prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;

  try {
    // ===================================================================================================================
    section('1. A successful generation: what is persisted');
    {
      const y = await mkYear('ok');
      const problem = await problemOf(y);
      let lastEntries: ReturnType<typeof validEntries> = [];
      const rg = rig((ctx) => { lastEntries = validEntries(ctx.problem); return solution(ctx.problem, 'FEASIBLE', { entries: lastEntries }); });
      const run = await execute(rg, y);
      check('the run ends SUCCEEDED with a version, phase DONE, no failure, lease released', run.status === 'SUCCEEDED' && run.versionId !== null && run.phase === 'DONE' && run.failureCode === null && run.leaseExpiresAt === null && run.finishedAt !== null && run.startedAt !== null && run.attempts === 1);
      const [v] = await versionsOf(y.yearId);
      check('exactly one version was created, numbered 1, in status DRAFT (never auto-published), linked from the run', (await versionsOf(y.yearId)).length === 1 && v!.versionNumber === 1 && v!.status === 'DRAFT' && v!.id === run.versionId);
      const stored = await entriesOf(v!.id);
      check('36 entries = 3 sections x (5 + 4 + 3): the demand is expanded per section', stored.length === 36 && problem.derived.expectedEntryCount === 36);
      const key = (e: { sectionId: string; teacherId: string; subjectId: string; dayOfWeek: string; periodNumber: number }) => `${e.sectionId}|${e.teacherId}|${e.subjectId}|${e.dayOfWeek}|${e.periodNumber}`;
      check('the stored entries are exactly the validated candidate', same(stored.map(key).sort(), lastEntries.map(key).sort()));
      check('entries are GENERATED and unlocked', stored.every((e) => e.source === 'GENERATED' && e.isLocked === false));
      check('every entry carries its logical subjectRequirementId', stored.every((e) => y.requirementIds.includes(e.subjectRequirementId)));
      check('solutionSource CP_SAT, solverStatus FEASIBLE, weightsVersion V1', v!.solutionSource === 'CP_SAT' && v!.solverStatus === 'FEASIBLE' && v!.weightsVersion === 'V1');
      check('the version records its creator and school', v!.createdById === world.adminId && v!.schoolId === world.schoolId);
      check('inputHash on the version and on the run equals the hash of the normalised problem', v!.inputHash === problem.inputHash && run.inputHash === problem.inputHash);
      check('inputSnapshot is the normalised problem core', sameJson(v!.inputSnapshot, problem.core));
      const truth = evaluateMetrics(problem, lastEntries);
      check('AUTHORITATIVE metrics are the independent TypeScript evaluation of the stored timetable (WEIGHTS_V1)', sameJson(v!.metrics, truth));
      const baseline = buildBaseline(problem, 1);
      check('baselineMetrics are the evaluation of the validated baseline', baseline.ok && sameJson(v!.baselineMetrics, evaluateMetrics(problem, baseline.entries)));
      const summary = run.resultSummary as Record<string, unknown>;
      check('resultSummary: status, source, optimal=false, metrics, baseline objective, runtime', summary.solverStatus === 'FEASIBLE' && summary.solutionSource === 'CP_SAT' && summary.optimal === false && summary.weightedObjective === truth.weightedObjective && summary.baselineWeightedObjective === (baseline.ok ? evaluateMetrics(problem, baseline.entries).weightedObjective : -1) && typeof summary.runtimeSeconds === 'number' && summary.versionId === v!.id && summary.versionNumber === 1 && summary.entryCount === 36);
      check('solver diagnostics are stored separately from the authoritative metrics', (v!.solverDiagnostics as { solver: { objectiveValue: number } }).solver.objectiveValue === truth.weightedObjective && (v!.solverDiagnostics as { process: { exitCode: number } }).process.exitCode === 0);
      check('the run recorded the actual section count', run.sectionCount === 3);
      check('the solver was called exactly once, with the run id as request id', rg.solver.calls.length === 1 && rg.solver.calls[0]!.input.requestId === run.id);

      // generation never overwrites: a second run makes version 2 and version 1 is untouched
      const v1Entries = stored.map(key).sort();
      const rg2 = rig(feasible);
      const run2 = await execute(rg2, y);
      const versions = await versionsOf(y.yearId);
      check('a second generation creates version 2 and leaves version 1 untouched', run2.status === 'SUCCEEDED' && versions.length === 2 && versions[1]!.versionNumber === 2 && same((await entriesOf(versions[0]!.id)).map(key).sort(), v1Entries) && versions[0]!.status === 'DRAFT');
      check('the two runs point at two different versions', run.versionId !== run2.versionId);

      const optimal = await execute(rig((ctx) => solution(ctx.problem, 'OPTIMAL')), await mkYear('opt'));
      check('OPTIMAL is stored as solverStatus OPTIMAL with optimal=true in the summary', optimal.status === 'SUCCEEDED' && (await versionsOf((await prisma.timetableGenerationRun.findUniqueOrThrow({ where: { id: optimal.id } })).academicYearId))[0]!.solverStatus === 'OPTIMAL' && (optimal.resultSummary as { optimal: boolean }).optimal === true);
    }

    // ===================================================================================================================
    section('2. UNKNOWN and watchdog: the ONLY cases that select the validated baseline');
    {
      const y = await mkYear('unk');
      const problem = await problemOf(y);
      const baseline = buildBaseline(problem, 1);
      const run = await execute(rig(() => noSolution()), y);
      const [v] = await versionsOf(y.yearId);
      check('UNKNOWN -> SUCCEEDED (not an error) with solutionSource BASELINE and solverStatus UNKNOWN', run.status === 'SUCCEEDED' && v!.solutionSource === 'BASELINE' && v!.solverStatus === 'UNKNOWN');
      check('the stored timetable IS the validated baseline, and metrics == baselineMetrics', baseline.ok && same((await entriesOf(v!.id)).map((e) => `${e.sectionId}|${e.teacherId}|${e.dayOfWeek}|${e.periodNumber}`).sort(), baseline.entries.map((e) => `${e.sectionId}|${e.teacherId}|${e.dayOfWeek}|${e.periodNumber}`).sort()) && sameJson(v!.metrics, v!.baselineMetrics));
      check('the summary records why: NO_SOLUTION_WITHIN_BUDGET', (run.resultSummary as { fallbackReason: string }).fallbackReason === 'NO_SOLUTION_WITHIN_BUDGET' && (run.resultSummary as { optimal: boolean }).optimal === false);

      const y2 = await mkYear('wd');
      const wd = await execute(rig(() => watchdog()), y2);
      const [v2] = await versionsOf(y2.yearId);
      check('watchdog kill -> SUCCEEDED with the baseline, fallbackReason KILLED_BY_WATCHDOG', wd.status === 'SUCCEEDED' && v2!.solutionSource === 'BASELINE' && (wd.resultSummary as { fallbackReason: string }).fallbackReason === 'KILLED_BY_WATCHDOG');
      check('...and there are no solver numbers, only the process record', (v2!.solverDiagnostics as { solver: unknown }).solver === null && (v2!.solverDiagnostics as { process: { signal: string } }).process.signal === 'SIGTERM');
    }

    // ===================================================================================================================
    section('3. Everything else FAILS: no hidden fallback');
    {
      const cases: Array<[string, (ctx: SolveCtx) => ReturnType<typeof solution> | Promise<ReturnType<typeof solution>>, string]> = [
        ['Python unavailable', () => processFault('SOLVER_UNAVAILABLE', 'python missing'), 'SOLVER_UNAVAILABLE'],
        ['Python crash / non-zero exit', () => processFault('SOLVER_CRASHED', 'exit code 3'), 'SOLVER_CRASHED'],
        ['malformed / invalid solver output', () => outputFault('SOLVER_INVALID_OUTPUT', 'not json'), 'SOLVER_INVALID_OUTPUT'],
        ['model invalid', () => outputFault('SOLVER_MODEL_INVALID'), 'SOLVER_MODEL_INVALID'],
        ['input rejected by the solver', () => outputFault('SOLVER_INPUT_REJECTED'), 'SOLVER_INPUT_REJECTED'],
        ['INFEASIBLE although a valid baseline exists', () => infeasible(), 'INTERNAL_INCONSISTENCY'],
        ['a SOLUTION whose timetable is invalid (one lesson missing)', (ctx) => solution(ctx.problem, 'FEASIBLE', { entries: validEntries(ctx.problem).slice(1) }), 'INTERNAL_INCONSISTENCY'],
        ['an unexpected exception from the solver client', () => { throw new Error('socket exploded'); }, 'INTERNAL_INCONSISTENCY'],
      ];
      for (const [name, script, code] of cases) {
        const y = await mkYear('f');
        const run = await execute(rig(script as never), y);
        check(`${name}: run FAILED ${code}`, run.status === 'FAILED' && run.failureCode === code, `${run.status} ${run.failureCode}`);
        check(`${name}: NO version, NO entries, NO baseline fallback`, (await versionsOf(y.yearId)).length === 0 && run.versionId === null && (await prisma.timetableEntry.count({ where: { section: { grade: { academicYearId: y.yearId } } } })) === 0);
        check(`${name}: message, diagnostics, finishedAt recorded and the lease released`, (run.failureMessage ?? '').length > 0 && run.failureDiagnostics !== null && run.finishedAt !== null && run.leaseExpiresAt === null);
      }
      const y = await mkYear('crashdiag');
      const run = await execute(rig(() => processFault('SOLVER_CRASHED', 'exit code 3')), y);
      check('process diagnostics (exit code, stderr tail, timing) are stored in the failure diagnostics', typeof (run.failureDiagnostics as { process?: unknown }) === 'object');
    }

    // ===================================================================================================================
    section('4. Pre-solver rejections: NOT_READY, YEAR_NOT_DRAFT, baseline failures (the solver is never started)');
    {
      const check4 = async (name: string, prepare: (y: SeededYear) => Promise<unknown>, code: string, errorCode?: string, over: Partial<RigOptions> = {}): Promise<void> => {
        const y = await mkYear('pre');
        await prepare(y);
        const rg = rig(feasible, over);
        const run = await execute(rg, y);
        check(`${name}: FAILED ${code}`, run.status === 'FAILED' && run.failureCode === code, `${run.status} ${run.failureCode}`);
        check(`${name}: the solver was NOT called, no version`, rg.solver.calls.length === 0 && (await versionsOf(y.yearId)).length === 0);
        if (errorCode) check(`${name}: the diagnostics carry the feasibility error ${errorCode}`, JSON.stringify(run.failureDiagnostics).includes(errorCode));
      };
      await check4('a subject with no explicit teacher and no eligible teacher', async (y) => { await prisma.sectionSubjectTeacher.delete({ where: { id: y.assignmentIds[0]! } }); await prisma.teacherSubjectGrade.deleteMany({ where: { id: { in: [y.eligibilityIds[0]!, y.spareEligibilityId] } } }); }, 'NOT_READY', 'NO_ELIGIBLE_TEACHER');
      await check4('an inactive assigned teacher', (y) => prisma.teacher.update({ where: { id: y.teacherIds[0]! }, data: { isActive: false } }), 'NOT_READY', 'INACTIVE_ASSIGNED_TEACHER');
      await check4('a teacher without the grade eligibility', (y) => prisma.teacherSubjectGrade.delete({ where: { id: y.eligibilityIds[0]! } }), 'NOT_READY', 'ASSIGNED_TEACHER_NOT_ELIGIBLE');
      await check4('no schedule configuration', (y) => prisma.scheduleConfig.delete({ where: { id: y.configId } }), 'NOT_READY', 'SCHEDULE_CONFIG_MISSING');
      await check4('an ACTIVE academic year', (y) => prisma.academicYear.update({ where: { id: y.yearId }, data: { status: 'ACTIVE' } }), 'YEAR_NOT_DRAFT');
      await check4('a COMPLETED academic year', (y) => prisma.academicYear.update({ where: { id: y.yearId }, data: { status: 'COMPLETED' } }), 'YEAR_NOT_DRAFT');
      await check4('a baseline that cannot be built (hard constraints)', async () => undefined, 'INFEASIBLE_HARD_CONSTRAINTS', undefined, { buildBaseline: () => ({ ok: false, certificate: [{ type: 'TEACHER', id: 't', load: 40, limit: 30 }] }) });
      await check4('a baseline that fails validation', async () => undefined, 'INTERNAL_INCONSISTENCY', undefined, { buildBaseline: (p, seed) => { const b = buildBaseline(p, seed); return b.ok ? { ok: true, entries: b.entries.slice(2) } : b; } });
    }

    // ===================================================================================================================
    section('5. Time budget: the solver receives the REMAINING budget');
    {
      let t = 0;
      const stepClock = (step: number) => () => { const v = t; t += step; return v; };
      const y = await mkYear('time');
      t = 0;
      const rg = rig(feasible, { now: stepClock(1_500) });
      await execute(rg, y);
      const opts = rg.solver.calls[0]!.input.options;
      check('10 s policy budget (3 sections) minus 1.5 s already spent -> the solver gets 8 s, not a fresh 10 s', opts.timeLimitSeconds === 8, String(opts.timeLimitSeconds));
      check('...the seed is 1, the worker count is the configured 2, reproducible is off with a null deterministic limit', opts.seed === 1 && opts.numWorkers === 2 && opts.reproducible === false && opts.deterministicTimeLimit === null);

      const y2 = await mkYear('time2'); t = 0;
      const rg2 = rig(feasible, { now: stepClock(11_000) });
      const run2 = await execute(rg2, y2);
      check('a budget already spent before the solver can start: the solver is NOT started', rg2.solver.calls.length === 0);
      check('...that counts as "no solution within the budget": SUCCEEDED with the baseline', run2.status === 'SUCCEEDED' && (run2.resultSummary as { solutionSource: string; fallbackReason: string }).solutionSource === 'BASELINE' && (run2.resultSummary as { fallbackReason: string }).fallbackReason === 'NO_SOLUTION_WITHIN_BUDGET');

      const y3 = await mkYear('time3');
      const rg3 = rig(feasible, { policy: { ...DEFAULT_TIME_POLICY, le10: 7 } });
      await execute(rg3, y3, { seed: 77, reproducible: true });
      const o3 = rg3.solver.calls[0]!.input.options;
      check('the policy is configurable: a 7 s policy budget is honoured (the solver gets the 7 s minus the real time already spent)', o3.timeLimitSeconds <= 7 && o3.timeLimitSeconds >= 3);
      check('the per-run options (seed 77, reproducible) reach the solver, with a consistent deterministic limit', o3.seed === 77 && o3.reproducible === true && o3.deterministicTimeLimit !== null && o3.deterministicTimeLimit > 0);
      check('the solver request carries WEIGHTS_V1 and the problem hash', rg3.solver.calls[0]!.input.weightsVersion === 'V1' && rg3.solver.calls[0]!.input.weights.teacherRun4Plus === 8);
    }

    // ===================================================================================================================
    section('6. The solver\'s own objective is diagnostic only');
    {
      const y = await mkYear('obj');
      const problem = await problemOf(y);
      const run = await execute(rig((ctx) => solution(ctx.problem, 'FEASIBLE', { objective: 987_654 })), y);
      const [v] = await versionsOf(y.yearId);
      const truth = evaluateMetrics(problem, validEntries(problem)).weightedObjective;
      check('a garbage solver objective (987654) never reaches the authoritative metrics', (v!.metrics as { weightedObjective: number }).weightedObjective === truth && (v!.solverDiagnostics as { solver: { objectiveValue: number } }).solver.objectiveValue === 987_654);
      check('...it is recorded as SOLVER_ABOVE (the expected slack of an unconverged solution), WITHOUT a disagreement warning', (run.resultSummary as { objectiveAgreement: string }).objectiveAgreement === 'SOLVER_ABOVE' && !((run.resultSummary as { warnings: string[] }).warnings).includes('SOLVER_OBJECTIVE_DISAGREES_WITH_AUTHORITATIVE_METRICS'));
      const y2 = await mkYear('obj2');
      const rg = rig((ctx) => solution(ctx.problem, 'FEASIBLE', { objective: -5 }));
      const run2 = await execute(rg, y2);
      check('a solver objective BELOW the truth is impossible for a correct model: flagged in the summary and logged, the run still succeeds with authoritative metrics', run2.status === 'SUCCEEDED' && (run2.resultSummary as { warnings: string[] }).warnings.includes('SOLVER_OBJECTIVE_DISAGREES_WITH_AUTHORITATIVE_METRICS') && rg.lines.some((l) => l.level === 'warn' && l.msg.includes('disagrees')));
      const y3 = await mkYear('obj3');
      const run3 = await execute(rig((ctx) => solution(ctx.problem, 'OPTIMAL', { objective: 12_345 })), y3);
      check('OPTIMAL with a differing solver objective is flagged too', (run3.resultSummary as { warnings: string[] }).warnings.includes('SOLVER_OBJECTIVE_DISAGREES_WITH_AUTHORITATIVE_METRICS'));
      const y4 = await mkYear('obj4');
      const run4 = await execute(rig((ctx) => solution(ctx.problem)), y4);
      check('an exact match is recorded as EXACT', (run4.resultSummary as { objectiveAgreement: string }).objectiveAgreement === 'EXACT');
    }

    // ===================================================================================================================
    section('7. Configuration changes during a run: a stale timetable is NEVER persisted');
    {
      const MUTATIONS: Record<string, (y: SeededYear) => Promise<unknown>> = {
        'the academic year becomes ACTIVE': (y) => prisma.academicYear.update({ where: { id: y.yearId }, data: { status: 'ACTIVE' } }),
        'a working day is added to the schedule': (y) => prisma.scheduleDay.create({ data: { scheduleConfigId: y.configId, dayOfWeek: 'SATURDAY' } }),
        'the break moves (after period 3 -> after period 5)': (y) => prisma.scheduleConfig.update({ where: { id: y.configId }, data: { breakAfterPeriod: 5 } }),
        'a section assignment changes teacher': (y) => prisma.sectionSubjectTeacher.update({ where: { id: y.assignmentIds[0]! }, data: { teacherId: y.spareTeacherId } }),
        'a teacher\'s grade eligibility is removed': (y) => prisma.teacherSubjectGrade.delete({ where: { id: y.eligibilityIds[1]! } }),
        'a subject requirement changes its periods': (y) => prisma.subjectRequirement.update({ where: { id: y.requirementIds[2]! }, data: { periodsPerWeek: { increment: 1 } } }),
        'a teacher is deactivated': (y) => prisma.teacher.update({ where: { id: y.teacherIds[0]! }, data: { isActive: false } }),
      };
      const names = Object.keys(MUTATIONS);
      const racePhase = async (phase: GenerationPhase, mutation: string): Promise<void> => {
        const y = await mkYear('race');
        let fired = false;
        const rg = rig(feasible, { hooks: { onPhase: async (p) => { if (p === phase && !fired) { fired = true; await MUTATIONS[mutation]!(y); } } } });
        const run = await execute(rg, y);
        const versions = await versionsOf(y.yearId);
        const entries = await prisma.timetableEntry.count({ where: { section: { grade: { academicYearId: y.yearId } } } });
        check(`during ${phase}: ${mutation} -> FAILED CONFIGURATION_CHANGED, nothing persisted`, run.status === 'FAILED' && run.failureCode === 'CONFIGURATION_CHANGED' && versions.length === 0 && entries === 0 && run.versionId === null, `${run.status} ${run.failureCode} versions=${versions.length}`);
      };
      for (const phase of ['FEASIBILITY', 'SOLVING', 'PERSISTING'] as GenerationPhase[]) for (const m of names) await racePhase(phase, m);
      for (const phase of ['NORMALIZE', 'BASELINE', 'VALIDATING', 'METRICS'] as GenerationPhase[]) for (const m of [names[0]!, names[3]!, names[2]!]) await racePhase(phase, m);

      // queued -> running: a change made while the run waits is simply seen by the fresh snapshot
      const queuedCases: Array<[string, string, (v: Awaited<ReturnType<typeof versionsOf>>[number], entries: number) => boolean]> = [
        [names[0]!, 'YEAR_NOT_DRAFT', () => true], [names[6]!, 'NOT_READY', () => true], [names[4]!, 'NOT_READY', () => true],
        [names[1]!, 'SUCCEEDED', (v) => (v.inputSnapshot as { grid: { days: unknown[] } }).grid.days.length === 6],
        [names[2]!, 'SUCCEEDED', (v) => (v.inputSnapshot as { grid: { periods: Array<{ continuesIntoNext: boolean }> } }).grid.periods[4]!.continuesIntoNext === false],
        [names[3]!, 'SUCCEEDED', (v) => (v.inputSnapshot as { assignments: Array<{ teacherId: string }> }).assignments.some((a) => a.teacherId === 'SPARE')],
        [names[5]!, 'SUCCEEDED', (_v, n) => n === 39],
      ];
      for (const [mutation, expected, extra] of queuedCases) {
        const y = await mkYear('queued');
        const queued = await mustEnqueue(world, y);
        await MUTATIONS[mutation]!(y); // changed while QUEUED, before the runner claims it
        const rg = rig(feasible);
        await rg.runner.dispatch();
        const run = await waitTerminal(queued.id, 60_000);
        await rg.runner.stop(5);
        const versions = await versionsOf(y.yearId);
        const n = versions[0] ? (await entriesOf(versions[0].id)).length : 0;
        const spareOk = versions[0] ? extra({ ...versions[0], inputSnapshot: JSON.parse(JSON.stringify(versions[0].inputSnapshot).replaceAll(y.spareTeacherId, 'SPARE')) } as never, n) : true;
        const ok = expected === 'SUCCEEDED' ? run.status === 'SUCCEEDED' && versions.length === 1 && spareOk : run.status === 'FAILED' && run.failureCode === expected && versions.length === 0;
        check(`while QUEUED: ${mutation} -> ${expected} (the run uses the fresh state, never a stale one)`, ok, `${run.status} ${run.failureCode} versions=${versions.length}`);
      }

      // control: a change that does not affect the problem does not fail the run
      const yc = await mkYear('control');
      let fired = false;
      const runC = await execute(rig(feasible, { hooks: { onPhase: async (p) => { if (p === 'PERSISTING' && !fired) { fired = true; await prisma.teacher.update({ where: { id: yc.teacherIds[0]! }, data: { name: 'Renamed teacher' } }); } } } }), yc);
      check('control: renaming a teacher during PERSISTING does not change the problem hash: the run SUCCEEDS', runC.status === 'SUCCEEDED');

      // the details of a stale failure are recorded
      const yd = await mkYear('details');
      let f2 = false;
      const runD = await execute(rig(feasible, { hooks: { onPhase: async (p) => { if (p === 'SOLVING' && !f2) { f2 = true; await MUTATIONS[names[5]!]!(yd); } } } }), yd);
      const dd = runD.failureDiagnostics as { solvedInputHash?: string; currentInputHash?: string };
      check('a hash mismatch records both the solved and the current input hash', typeof dd.solvedInputHash === 'string' && typeof dd.currentInputHash === 'string' && dd.solvedInputHash !== dd.currentInputHash);
    }

    // ===================================================================================================================
    section('8. The final transaction LOCKS what the solved problem depends on');
    {
      const y = await mkYear('lock');
      const blocked: Record<string, boolean> = {};
      const writers: Array<Promise<unknown>> = [];
      const writerErrors: string[] = [];
      const startWriter = (name: string, fn: () => Promise<unknown>): void => {
        blocked[name] = true;
        writers.push(fn().then(() => { blocked[name] = false; }).catch((e) => { writerErrors.push(`${name}: ${String((e as Error).message).slice(0, 120)}`); blocked[name] = false; }));
      };
      const pendingAtCommit: Record<string, boolean> = {};
      const hooks: OrchestratorHooks = {
        persist: {
          afterLocks: async () => {
            startWriter('teacher UPDATE', () => writer.$executeRaw`UPDATE "teachers" SET "isActive" = false WHERE "id" = ${y.teacherIds[0]!}`);
            startWriter('assignment UPDATE', () => writer.$executeRaw`UPDATE "section_subject_teachers" SET "teacherId" = ${y.spareTeacherId} WHERE "id" = ${y.assignmentIds[0]!}`);
            startWriter('assignment DELETE', () => writer.$executeRaw`DELETE FROM "section_subject_teachers" WHERE "id" = ${y.assignmentIds[1]!}`);
            startWriter('requirement UPDATE', () => writer.$executeRaw`UPDATE "subject_requirements" SET "periodsPerWeek" = 4 WHERE "id" = ${y.requirementIds[2]!}`);
            startWriter('schedule config UPDATE', () => writer.$executeRaw`UPDATE "schedule_configs" SET "periodsPerDay" = "periodsPerDay" WHERE "id" = ${y.configId}`);
            startWriter('academic year status UPDATE', () => writer.$executeRaw`UPDATE "academic_years" SET "status" = 'ACTIVE'::"AcademicYearStatus" WHERE "id" = ${y.yearId}`);
            startWriter('eligibility DELETE', () => writer.$executeRaw`DELETE FROM "teacher_subject_grades" WHERE "id" = ${y.eligibilityIds[2]!}`);
            startWriter('teacher-subject link DELETE (a link used by the problem)', () => writer.$executeRaw`DELETE FROM "teacher_subjects" WHERE "id" = (SELECT "teacherSubjectId" FROM "teacher_subject_grades" WHERE "id" = ${y.eligibilityIds[0]!})`);
            startWriter('grade FOR UPDATE (what Modules 5 and 7 take)', () => writer.$transaction(async (tx) => { await tx.$queryRaw`SELECT "id" FROM "grades" WHERE "id" = ${y.gradeId} FOR UPDATE`; }, { maxWait: 30_000, timeout: 60_000 }));
            await sleep(900);
          },
          beforeCommit: async () => { for (const k of Object.keys(blocked)) pendingAtCommit[k] = blocked[k]!; },
        },
      };
      const run = await execute(rig(feasible, { hooks }), y);
      const names = Object.keys(pendingAtCommit);
      check('the run SUCCEEDED (the writers had to wait until it committed)', run.status === 'SUCCEEDED');
      for (const n of names) check(`a concurrent ${n} was BLOCKED while the final transaction held its locks`, pendingAtCommit[n] === true);
      await Promise.all(writers);
      check('...and every blocked writer completed right after the commit, without error', Object.values(blocked).every((b) => b === false) && writerErrors.length === 0, writerErrors.join(' | '));
      check('the persisted version reflects the state the locks protected (hash of the solved problem)', (await versionsOf(y.yearId))[0]!.inputHash === run.inputHash);
      check('the writes that waited were applied afterwards (the year is now ACTIVE)', (await prisma.academicYear.findUniqueOrThrow({ where: { id: y.yearId } })).status === 'ACTIVE');
    }

    // ===================================================================================================================
    section('9. Persistence is atomic and survives transient database errors');
    {
      const transient = (): Error => Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { code: 'P2024' });
      const countAll = async (y: SeededYear) => ({ versions: (await versionsOf(y.yearId)).length, entries: await prisma.timetableEntry.count({ where: { section: { grade: { academicYearId: y.yearId } } } }) });

      let attempts = 0;
      const y1 = await mkYear('tr1');
      const r1 = await execute(rig(feasible, { hooks: { persist: { onAttempt: (n) => { attempts = n; if (n <= 2) throw transient(); } } } }), y1);
      check('two transient errors then success: the run SUCCEEDS on the 3rd attempt (retry policy: 2 retries)', r1.status === 'SUCCEEDED' && attempts === 3);
      check('...with exactly one version', (await countAll(y1)).versions === 1);

      attempts = 0;
      const y2 = await mkYear('tr2');
      const r2 = await execute(rig(feasible, { hooks: { persist: { onAttempt: (n) => { attempts = n; throw transient(); } } } }), y2);
      check('a persistent transient error: FAILED PERSIST_FAILED after 3 attempts (bounded retries)', r2.status === 'FAILED' && r2.failureCode === 'PERSIST_FAILED' && attempts === 3, `${r2.failureCode} ${attempts}`);
      check('...nothing persisted', (await countAll(y2)).versions === 0);

      attempts = 0;
      const y3 = await mkYear('tr3');
      const r3 = await execute(rig(feasible, { hooks: { persist: { onAttempt: (n) => { attempts = n; throw new Error('disk full'); } } } }), y3);
      check('a NON-transient error is not retried: PERSIST_FAILED after 1 attempt', r3.failureCode === 'PERSIST_FAILED' && attempts === 1);

      const y4 = await mkYear('tr4');
      const r4 = await execute(rig(feasible, { hooks: { persist: { afterLocks: () => { throw new Error('boom after the locks'); } } } }), y4);
      check('an error inside the transaction after the locks: PERSIST_FAILED, nothing persisted', r4.failureCode === 'PERSIST_FAILED' && same(await countAll(y4), { versions: 0, entries: 0 }));

      const y5 = await mkYear('tr5');
      const r5 = await execute(rig(feasible, { hooks: { persist: { beforeCommit: () => { throw new Error('boom just before the commit'); } } } }), y5);
      check('ATOMIC: an error after the version and all 36 entries were written, just before the commit, rolls EVERYTHING back', r5.failureCode === 'PERSIST_FAILED' && same(await countAll(y5), { versions: 0, entries: 0 }));
      check('...and the run is not SUCCEEDED and has no version', r5.status === 'FAILED' && r5.versionId === null);

      const y6 = await mkYear('tr6');
      let first = true;
      const rg6 = rig(feasible, { hooks: { persist: { beforeCommit: () => { if (first) { first = false; throw transient(); } } } } });
      const r6 = await execute(rg6, y6);
      const c6 = await countAll(y6);
      check('a transient error AFTER the writes: the transaction rolled back and the retry produced exactly ONE version (no duplicates)', r6.status === 'SUCCEEDED' && c6.versions === 1 && c6.entries === 36 && (await versionsOf(y6.yearId))[0]!.versionNumber === 1, `${r6.status} ${r6.failureCode} ${JSON.stringify(c6)} ${r6.failureMessage} logs=${JSON.stringify(rg6.lines.filter((l) => l.level !== 'info').map((l) => l.msg + ' ' + JSON.stringify(l.fields)).slice(0, 4)).slice(0, 600)}`);
    }

    // ===================================================================================================================
    section('10. The fence: stale workers cannot write (final transaction level)');
    {
      const y = await mkYear('fence');
      const problem = await problemOf(y);
      const entries = validEntries(problem);
      const repo = new RunRepository(rawPrisma);
      const base = (run: RunRecord, token: string): PersistParams => ({
        prisma: rawPrisma, run: { id: run.id, schoolId: run.schoolId, academicYearId: run.academicYearId, requestedById: run.requestedById }, token, problem, entries,
        version: { solutionSource: 'CP_SAT', solverStatus: 'FEASIBLE', weightsVersion: 'V1', metrics: evaluateMetrics(problem, entries), baselineMetrics: evaluateMetrics(problem, entries), solverDiagnostics: null },
        resultSummary: { solverStatus: 'FEASIBLE' }, lockTimeoutSeconds: 5,
      });
      await drain();
      const queued = await mustEnqueue(world, y);
      const tokenA = randomUUID();
      const claimed = (await repo.claimNext(tokenA, 60))!;
      const rejectedWith = async (p: PersistParams): Promise<string> => { try { await persistGeneratedVersionOnce(p); return 'persisted'; } catch (e) { return (e as Error).constructor.name; } };

      check('a wrong token is refused (LeaseLostError)', (await rejectedWith(base(claimed, randomUUID()))) === 'LeaseLostError');
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "leaseExpiresAt" = now() - interval '1 second' WHERE "id" = ${claimed.id}`;
      check('the right token with an EXPIRED lease is refused too (a lost lease must not persist)', (await rejectedWith(base(claimed, tokenA))) === 'LeaseLostError');
      check('...nothing was written by either attempt', (await versionsOf(y.yearId)).length === 0 && (await getRun(claimed.id)).status === 'RUNNING');

      await repo.heartbeat(claimed.id, tokenA, 60);
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "leaseExpiresAt" = now() - interval '1 second' WHERE "id" = ${claimed.id}`;
      await repo.recoverStale(2);
      check('after the run was REQUEUED by recovery, the old token is refused', (await getRun(claimed.id)).status === 'QUEUED' && (await rejectedWith(base(claimed, tokenA))) === 'LeaseLostError');
      const tokenB = randomUUID();
      const claimedB = (await repo.claimNext(tokenB, 60))!;
      check('after a NEW worker claimed it, the old token is still refused and the new attempt is untouched', (await rejectedWith(base(claimed, tokenA))) === 'LeaseLostError' && (await getRun(claimed.id)).leaseOwner === tokenB && (await versionsOf(y.yearId)).length === 0);

      const results = await Promise.allSettled([persistGeneratedVersionOnce(base(claimedB, tokenB)), persistGeneratedVersionOnce(base(claimedB, tokenB))]);
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const lost = results.filter((r) => r.status === 'rejected' && r.reason instanceof LeaseLostError).length;
      check('two concurrent final transactions for the SAME claim: exactly one persists, the other is fenced out', ok === 1 && lost === 1, `ok=${ok} lost=${lost}`);
      check('...exactly one version and 36 entries exist, and the run is SUCCEEDED', (await versionsOf(y.yearId)).length === 1 && (await prisma.timetableEntry.count({ where: { version: { academicYearId: y.yearId } } })) === 36 && (await getRun(queued.id)).status === 'SUCCEEDED');
      check('once SUCCEEDED, even the owner token cannot persist again', (await rejectedWith(base(claimedB, tokenB))) === 'LeaseLostError' && (await versionsOf(y.yearId)).length === 1);
      // a stale hash is refused at this level
      const y2 = await mkYear('fence2');
      const p2 = await problemOf(y2);
      await drain();
      const q2 = await mustEnqueue(world, y2);
      const tok2 = randomUUID();
      const c2 = (await repo.claimNext(tok2, 60))!;
      await prisma.subjectRequirement.update({ where: { id: y2.requirementIds[0]! }, data: { periodsPerWeek: { increment: 1 } } });
      let kind = '';
      try { await persistGeneratedVersionOnce({ ...base(c2, tok2), problem: p2, entries: validEntries(p2) }); } catch (e) { kind = e instanceof ConfigurationChangedError ? 'ConfigurationChangedError' : (e as Error).constructor.name; }
      check('a changed problem is refused with ConfigurationChangedError, nothing written, the run still RUNNING', kind === 'ConfigurationChangedError' && (await versionsOf(y2.yearId)).length === 0 && (await getRun(q2.id)).status === 'RUNNING');
      await drain();
    }

    // ===================================================================================================================
    section('11. Leases and heartbeats inside the runner');
    {
      // (a) the heartbeat keeps a long job alive across several lease lengths while another runner sweeps
      await drain();
      const y = await mkYear('hb');
      const beats = new Set<number>();
      const rgA = rig(feasibleAfter(4_500));
      const rgB = rig(feasible); // a second runner: it sweeps every second and must find nothing stale
      const queued = await mustEnqueue(world, y);
      await rgA.runner.dispatch(); // runner A claims the run
      rgB.runner.start(); // only now does the second runner start sweeping
      const sampler = setInterval(() => { void getRun(queued.id).then((r) => { if (r.heartbeatAt) beats.add(r.heartbeatAt.getTime()); }); }, 400);
      const done = await waitTerminal(queued.id, 60_000);
      clearInterval(sampler);
      await rgA.runner.stop(5); await rgB.runner.stop(5);
      check('a 4.5 s solve under a 3 s lease SUCCEEDS: the heartbeat kept the lease alive', done.status === 'SUCCEEDED' && done.attempts === 1);
      check('...the heartbeat advanced several times meanwhile', beats.size >= 3, String(beats.size));
      check('...and the sweeping second runner did not touch it (no requeue, no second claim)', rgB.runner.stats.claimed === 0 && rgB.runner.stats.recoveredRequeued === 0 && rgB.solver.calls.length === 0 && (await versionsOf(y.yearId)).length === 1);

      // (b) ownership stolen while running: the worker notices, aborts its solver and writes nothing
      const y2 = await mkYear('steal');
      const rg2 = rig((ctx) => abortableSleep(30_000, ctx.signal).then(() => solution(ctx.problem)));
      const q2 = await mustEnqueue(world, y2);
      await rg2.runner.dispatch();
      await waitFor(() => rg2.solver.calls.length === 1, 10_000);
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "leaseOwner" = 'a-different-worker' WHERE "id" = ${q2.id}`;
      const noticed = await waitFor(() => rg2.runner.stats.abandoned === 1, 8_000);
      const stolen = await getRun(q2.id);
      check('the worker notices the lost ownership at the next heartbeat and aborts its solver (AbortSignal)', noticed && rg2.solver.calls[0]!.signal?.aborted === true && rg2.solver.calls[0]!.signal?.reason === 'LEASE_LOST');
      check('...it wrote NOTHING: the run still belongs to the other owner, not failed, not succeeded, no version', stolen.status === 'RUNNING' && stolen.leaseOwner === 'a-different-worker' && stolen.failureCode === null && stolen.versionId === null && (await versionsOf(y2.yearId)).length === 0);
      check('...and it freed its slot', rg2.runner.activeCount === 0);
      await rg2.runner.stop(5);
      await drain();

      // (c) heartbeats that keep failing: the worker gives up, then stale recovery lets another runner finish the job
      class FailingHeartbeatRepo extends RunRepository {
        armed = false;
        override async heartbeat(runId: string, token: string, leaseSeconds: number): Promise<boolean> {
          if (this.armed) throw new Error('database unreachable');
          return super.heartbeat(runId, token, leaseSeconds);
        }
      }
      const failingRepo = new FailingHeartbeatRepo(rawPrisma);
      const y3 = await mkYear('hbfail');
      const slow = rig((ctx) => abortableSleep(30_000, ctx.signal).then(() => solution(ctx.problem)), { repo: failingRepo });
      const q3 = await mustEnqueue(world, y3);
      await slow.runner.dispatch();
      await waitFor(() => slow.solver.calls.length === 1, 20_000);
      failingRepo.armed = true; // the database "goes away" for the heartbeat only once the solver is running
      const gaveUp = await waitFor(() => slow.runner.stats.abandoned === 1, 10_000);
      check('after 2 consecutive heartbeat failures the worker treats the lease as lost, aborts and writes nothing', gaveUp && slow.solver.calls[0]!.signal?.aborted === true && slow.lines.some((l) => l.msg.includes('heartbeat failed')) && (await getRun(q3.id)).status === 'RUNNING');
      const recovery = rig(feasible);
      await waitFor(async () => (await getRun(q3.id)).leaseExpiresAt!.getTime() < Date.now() - 200, 10_000, 200).catch(() => false);
      await recovery.runner.dispatch();
      const finished = await waitTerminal(q3.id, 30_000);
      await recovery.runner.stop(5); await slow.runner.stop(5);
      check('stale heartbeat -> lease expiry -> another runner recovers the run and completes it as attempt 2', finished.status === 'SUCCEEDED' && finished.attempts === 2 && recovery.runner.stats.recoveredRequeued === 1);
      check('...with exactly ONE version', (await versionsOf(y3.yearId)).length === 1);
    }

    // ===================================================================================================================
    section('12. A stuck worker comes back after another worker finished the run');
    {
      await drain();
      const y = await mkYear('stuck');
      class SilentRepo extends RunRepository { override async heartbeat(): Promise<boolean> { return true; } } // claims to heartbeat, writes nothing: the lease really expires
      const stuck = rig(async (ctx) => { await sleep(7_500); return solution(ctx.problem); }, { repo: new SilentRepo(rawPrisma) });
      const q = await mustEnqueue(world, y);
      await stuck.runner.dispatch();
      await waitFor(() => stuck.solver.calls.length === 1, 10_000);
      const healthy = rig(feasible);
      const completed = await waitFor(async () => { await healthy.runner.dispatch(); return (await getRun(q.id)).status === 'SUCCEEDED'; }, 20_000, 700);
      const mid = await getRun(q.id);
      check('while the first worker is stuck its lease expires; a healthy runner recovers the run and finishes it (attempt 2)', completed && mid.attempts === 2 && healthy.runner.stats.recoveredRequeued === 1);
      const versionId = mid.versionId;
      await waitFor(() => stuck.runner.stats.abandoned === 1, 15_000);
      check('the stuck worker finally returns and tries to persist: it is FENCED OUT (abandoned), it writes nothing', stuck.runner.stats.abandoned === 1 && stuck.runner.stats.succeeded === 0);
      const end = await getRun(q.id);
      check('the finished run and its version are exactly as the second worker left them (one version, same id, attempt 2)', end.status === 'SUCCEEDED' && end.versionId === versionId && end.attempts === 2 && (await versionsOf(y.yearId)).length === 1);
      await stuck.runner.stop(5); await healthy.runner.stop(5);
    }

    // ===================================================================================================================
    section('13. Two runners, many workers, one database');
    {
      await drain();
      const years = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => mkYear(`cc${i}`)));
      const queued = [];
      for (const y of years) queued.push(await mustEnqueue(world, y));
      const callsByRun = new Map<string, number>();
      const mk = (): Rig => rig(async (ctx) => { callsByRun.set(ctx.input.requestId, (callsByRun.get(ctx.input.requestId) ?? 0) + 1); await abortableSleep(500, ctx.signal); return solution(ctx.problem); });
      const A = mk(); const B = mk();
      A.runner.start(); B.runner.start();
      for (const q of queued) await waitTerminal(q.id, 90_000);
      await A.runner.stop(10); await B.runner.stop(10);
      const finals = await Promise.all(queued.map((q) => getRun(q.id)));
      check('all 6 runs SUCCEEDED across two runners', finals.every((r) => r.status === 'SUCCEEDED'));
      check('every run was solved EXACTLY ONCE (never claimed twice)', queued.every((q) => callsByRun.get(q.id) === 1) && callsByRun.size === 6);
      check('the two runners together claimed exactly 6 runs', A.runner.stats.claimed + B.runner.stats.claimed === 6, `${A.runner.stats.claimed}+${B.runner.stats.claimed}`);
      check('both runners did real work (the load was shared)', A.runner.stats.claimed > 0 && B.runner.stats.claimed > 0, `${A.runner.stats.claimed}/${B.runner.stats.claimed}`);
      check('each runner respected its concurrency limit of 2', A.solver.peak <= 2 && B.solver.peak <= 2, `${A.solver.peak}/${B.solver.peak}`);
      check('each academic year got exactly one version numbered 1 (independent numbering)', (await Promise.all(years.map(async (y) => (await versionsOf(y.yearId)).map((v) => v.versionNumber).join()))).every((n) => n === '1'));
      check('every attempt counter is 1', finals.every((r) => r.attempts === 1));

      // concurrency 1: the queue drains one at a time
      const ys = await Promise.all([1, 2, 3, 4].map((i) => mkYear(`one${i}`)));
      const qs = []; for (const y of ys) qs.push(await mustEnqueue(world, y));
      const single = rig(feasibleAfter(300), { config: { concurrency: 1 } });
      single.runner.start();
      for (const q of qs) await waitTerminal(q.id, 60_000);
      await single.runner.stop(5);
      check('with concurrency 1, four queued runs were solved strictly one at a time', single.solver.peak === 1 && single.solver.calls.length === 4);

      // same academic year: the database arbitrates
      const sy = await mkYear('same');
      const race = await Promise.all(Array.from({ length: 8 }, () => enqueueFor(world, sy)));
      check('8 simultaneous requests for the SAME academic year: exactly one is accepted, seven are ALREADY_ACTIVE', race.filter((r) => r.ok).length === 1 && race.filter((r) => !r.ok && r.reason === 'ALREADY_ACTIVE').length === 7);
      const accepted = race.find((r) => r.ok);
      const rgS = rig(feasible);
      await rgS.runner.dispatch(); await waitTerminal(accepted!.ok ? accepted.run.id : '', 60_000); await rgS.runner.stop(5);
      const second = await execute(rig(feasible), sy);
      const third = await execute(rig(feasible), sy);
      check('after each run finishes a new one is allowed: versions are numbered 1, 2, 3 and never overwritten', (await versionsOf(sy.yearId)).map((v) => v.versionNumber).join() === '1,2,3' && second.status === 'SUCCEEDED' && third.status === 'SUCCEEDED');
      check('different academic years of the same school run independently while one is active', await (async () => {
        const a = await mkYear('indA'); const b = await mkYear('indB');
        const qa = await mustEnqueue(world, a); const qb = await mustEnqueue(world, b);
        const r = rig(feasibleAfter(2_500)); await r.runner.dispatch(); // long enough that both claims overlap even when the database is slow
        await waitTerminal(qa.id, 60_000); await waitTerminal(qb.id, 60_000); await r.runner.stop(5);
        const ok = r.solver.peak === 2 && (await versionsOf(a.yearId)).length === 1 && (await versionsOf(b.yearId)).length === 1;
        if (!ok) console.log(`    detail: peak=${r.solver.peak} versionsA=${(await versionsOf(a.yearId)).length} versionsB=${(await versionsOf(b.yearId)).length}`);
        return ok;
      })());
    }

    // ===================================================================================================================
    section('14. Queue TTL, stale runs and WORKER_LOST through the runner');
    {
      await drain();
      const y = await mkYear('ttlr');
      const q = await mustEnqueue(world, y);
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "createdAt" = now() - interval '45 minutes' WHERE "id" = ${q.id}`;
      const rg = rig(feasible);
      await rg.runner.dispatch();
      const r = await getRun(q.id);
      check('a run queued for 45 minutes is NOT executed: FAILED QUEUE_EXPIRED with diagnostics, the solver never called', r.status === 'FAILED' && r.failureCode === 'QUEUE_EXPIRED' && rg.solver.calls.length === 0 && rg.runner.stats.expired === 1 && (r.failureDiagnostics as { ttlMinutes: number }).ttlMinutes === 30);
      check('the expiry was logged', rg.lines.some((l) => l.msg.includes('expired')));
      await rg.runner.stop(5);

      // a crashed worker (claimed, never ran): recovery requeues it, the runner completes it
      const y2 = await mkYear('crash1');
      const q2 = await mustEnqueue(world, y2);
      const repo = new RunRepository(rawPrisma);
      await repo.claimNext(randomUUID(), 60); // a worker that claimed it and died
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "leaseExpiresAt" = now() - interval '1 second' WHERE "id" = ${q2.id}`;
      const rg2 = rig(feasible);
      await rg2.runner.dispatch();
      const done = await waitTerminal(q2.id, 30_000);
      await rg2.runner.stop(5);
      check('a run whose worker died is requeued by the sweep and completed as attempt 2 (one version)', done.status === 'SUCCEEDED' && done.attempts === 2 && rg2.runner.stats.recoveredRequeued === 1 && (await versionsOf(y2.yearId)).length === 1);

      // lost on EVERY attempt: WORKER_LOST, never a third attempt
      class SilentRepo2 extends RunRepository { override async heartbeat(): Promise<boolean> { return true; } } // claims to beat, writes nothing: the lease really expires
      const y3 = await mkYear('crash2');
      const q3 = await mustEnqueue(world, y3);
      await repo.claimNext(randomUUID(), 60); // attempt 1: a worker that claimed it and died
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "leaseExpiresAt" = now() - interval '1 second' WHERE "id" = ${q3.id}`;
      const stuck = rig((ctx) => abortableSleep(60_000, ctx.signal).then(() => solution(ctx.problem)), { repo: new SilentRepo2(rawPrisma) });
      await stuck.runner.dispatch(); // the sweep requeues it and this runner claims it: attempt 2, which then goes silent too
      await waitFor(() => stuck.solver.calls.length === 1, 10_000);
      check('attempt 2 was claimed by the runner after the first worker died', (await getRun(q3.id)).attempts === 2);
      const sweeper = rig(feasible);
      const failedNow = await waitFor(async () => { await sweeper.runner.dispatch(); return (await getRun(q3.id)).status === 'FAILED'; }, 40_000, 700);
      const lostRun = await getRun(q3.id);
      check('attempt 2 is lost as well: FAILED WORKER_LOST (no third attempt, no loop)', failedNow && lostRun.failureCode === 'WORKER_LOST' && lostRun.attempts === 2 && sweeper.runner.stats.recoveredFailed === 1, `waited=${failedNow} status=${lostRun.status} code=${lostRun.failureCode} attempts=${lostRun.attempts} recoveredFailed=${sweeper.runner.stats.recoveredFailed} stuckStats=${JSON.stringify(stuck.runner.stats)}`);
      check('...the diagnostics list both lost attempts, the healthy runner never solved it, no version exists', ((lostRun.failureDiagnostics as { lostAttempts: unknown[] }).lostAttempts ?? []).length === 2 && sweeper.solver.calls.length === 0 && (await versionsOf(y3.yearId)).length === 0);
      await stuck.runner.stop(8); await sweeper.runner.stop(5);
      check('the silent worker, when finally stopped, cannot overwrite the finished run (fenced): it stays FAILED WORKER_LOST', (await getRun(q3.id)).status === 'FAILED' && (await getRun(q3.id)).failureCode === 'WORKER_LOST' && stuck.runner.stats.requeued === 0);
      await drain();
    }

    // ===================================================================================================================
    section('15. Graceful shutdown (scripted solver; the real-process version is in the crash suite)');
    {
      await drain();
      const y = await mkYear('shut');
      const q = await mustEnqueue(world, y);
      const rg = rig((ctx) => abortableSleep(30_000, ctx.signal).then(() => solution(ctx.problem)));
      await rg.runner.dispatch();
      await waitFor(() => rg.solver.calls.length === 1, 10_000);
      const t0 = Date.now();
      const summary = await rg.runner.stop(10);
      const r = await getRun(q.id);
      check('stop() aborts the active run through its AbortSignal and returns promptly', summary.aborted === 1 && summary.stillActive === 0 && rg.solver.calls[0]!.signal?.aborted === true && rg.solver.calls[0]!.signal?.reason === 'SHUTDOWN' && Date.now() - t0 < 5_000, `${Date.now() - t0} ms`);
      check('the run was REQUEUED, not orphaned as RUNNING: status QUEUED, no owner, no lease, attempts back to 0', r.status === 'QUEUED' && r.leaseOwner === null && r.leaseExpiresAt === null && r.attempts === 0 && r.phase === null && rg.runner.stats.requeued === 1);
      check('...no version, no failure', r.failureCode === null && (await versionsOf(y.yearId)).length === 0);
      const after = await rg.runner.dispatch().then(() => getRun(q.id));
      check('a stopped runner accepts no new work: the queued run stays QUEUED', after.status === 'QUEUED' && rg.runner.isStopping);
      rg.runner.trigger(); await sleep(300);
      check('...even when triggered', (await getRun(q.id)).status === 'QUEUED');
      const next = rig(feasible);
      await next.runner.dispatch();
      const done = await waitTerminal(q.id, 30_000);
      await next.runner.stop(5);
      check('a fresh runner picks the requeued run up and completes it as attempt 1', done.status === 'SUCCEEDED' && done.attempts === 1);

      // shutdown during a non-solver phase
      const y2 = await mkYear('shut2');
      const q2 = await mustEnqueue(world, y2);
      const gate = deferred();
      let reached = false;
      const rg2 = rig(feasible, { hooks: { onPhase: async (p) => { if (p === 'BASELINE') { reached = true; await gate.promise; } } } });
      await rg2.runner.dispatch();
      await waitFor(() => reached, 10_000);
      const stopping = rg2.runner.stop(10);
      gate.resolve();
      const s2 = await stopping;
      const r2 = await getRun(q2.id);
      check('shutdown during the BASELINE phase: requeued at the next checkpoint, solver never started', s2.stillActive === 0 && r2.status === 'QUEUED' && r2.attempts === 0 && rg2.solver.calls.length === 0);
      await drain();

      // shutdown while the final transaction is running: it is allowed to finish
      const y3 = await mkYear('shut3');
      const q3 = await mustEnqueue(world, y3);
      let inTx = false;
      const rg3 = rig(feasible, { hooks: { persist: { afterLocks: async () => { inTx = true; await sleep(1_500); } } } });
      await rg3.runner.dispatch();
      await waitFor(() => inTx, 10_000);
      const s3 = await rg3.runner.stop(15);
      const r3 = await getRun(q3.id);
      check('shutdown during the final transaction: the transaction completes, the run is SUCCEEDED (never left half-done)', r3.status === 'SUCCEEDED' && s3.stillActive === 0 && (await versionsOf(y3.yearId)).length === 1);
    }
  } finally {
    section('16. Cleanup and proof that nothing existing changed');
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    const deleted = await destroyWorld(world);
    check('exactly the one test school was deleted (cascade)', deleted === 1);
    const newAfter = await newTableCounts();
    check('the new tables are back to their starting counts', same(newAfter, newBefore), JSON.stringify({ newBefore, newAfter }));
    const after = await fingerprint();
    const unchanged = EXISTING_TABLES.filter((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h);
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, unchanged.length === EXISTING_TABLES.length, EXISTING_TABLES.filter((t) => !unchanged.includes(t)).join(','));
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11RN_' } } })) === 0);
    void seeded; void fakeInfo; void processFault;
    if (infraRetries.count > 0) console.log(`  (note: ${infraRetries.count} dropped database connection(s) were retried in the tests' own reads)`);
  }
}

main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(async () => {
    await writer.$disconnect();
    await writerPool.end().catch(() => undefined);
    await prisma.$disconnect();
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
