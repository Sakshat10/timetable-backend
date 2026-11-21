// Cross-language contract test for the Module 11 Python solver (Phase 2).
//
// Runs the REAL Phase 1 TypeScript pipeline (normalizer -> buildSolverInput) into the REAL Python solver CLI and
// validates what comes back with the REAL Zod schema, the TypeScript validator and the TypeScript metric evaluator.
// This is a test harness, not the production SolverClient (Phase 3): it only spawns the CLI to check the contract.
//
// No database, no server. Requires the solver virtualenv:  cd solver && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
// Run with   npx tsx test-solver-contract.ts
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  CONTRACT_VERSION,
  solverInputSchema,
  solverOutputSchema,
  TERM_NAMES,
  type SolverInput,
  type TimetableEntryRow,
} from './src/modules/timetable-generation/timetable-generation.contracts.js';
import { hashJson } from './src/modules/timetable-generation/timetable-generation.hash.js';
import { buildSolverInput, normalizeProblem, type GenerationSnapshot, type NormalizedProblem } from './src/modules/timetable-generation/timetable-generation.normalizer.js';
import { buildBaseline } from './src/modules/timetable-generation/timetable-generation.baseline.js';
import { interpretSolverOutput, validateEntries } from './src/modules/timetable-generation/timetable-generation.validator.js';
import { decideOutcome } from './src/modules/timetable-generation/timetable-generation.outcome.js';
import { evaluateMetrics } from './src/modules/timetable-generation/timetable-generation.metrics.js';

const PYTHON = new URL('./solver/.venv/bin/python', import.meta.url).pathname;
const MAIN = new URL('./solver/main.py', import.meta.url).pathname;
if (!existsSync(PYTHON)) {
  console.error(`Solver virtualenv not found at ${PYTHON}. Create it first (see the header of this file).`);
  process.exit(2);
}

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

interface CliResult { code: number | null; stdout: string; stderr: string; json: unknown }
function runSolver(payload: unknown, timeoutMs = 120_000): CliResult {
  const r = spawnSync(PYTHON, [MAIN], { input: typeof payload === 'string' ? payload : JSON.stringify(payload), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs });
  let json: unknown = null;
  if (r.stdout) { try { json = JSON.parse(r.stdout); } catch { json = 'UNPARSEABLE'; } }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

// ---------------------------------------------------------------------------
// Builders (the same shapes as test-timetable-generation-core.ts)
// ---------------------------------------------------------------------------
const SCHOOL = 'school1';
const DAYS5 = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
const WEEK = [...DAYS5, 'SATURDAY', 'SUNDAY'];
const schedule = (days: string[], ppd: number) => ({ periodsPerDay: ppd, workingDays: days, periods: Array.from({ length: ppd }, (_, i) => ({ periodNumber: i + 1 })) });
const teacher = (id: string) => ({ id, schoolId: SCHOOL, name: `Teacher ${id}`, isActive: true });
const link = (teacherId: string, subjectId: string, gradeIds: string[]) => ({ teacherId, subjectId, gradeIds });
const sec = (id: string, gradeId = 'g8', streamId: string | null = null) => ({ id, gradeId, streamId, name: id, code: id });
const req = (id: string, gradeId: string, subjectId: string, periodsPerWeek: number, streamId: string | null = null) => ({ id, gradeId, streamId, subjectId, periodsPerWeek });
const asg = (id: string, sectionId: string, subjectRequirementId: string, teacherId: string) => ({ id, sectionId, subjectRequirementId, teacherId });

function snapshot(over: Partial<GenerationSnapshot> = {}): GenerationSnapshot {
  const sections = [sec('8A'), sec('8B'), sec('8C')];
  return {
    schoolId: SCHOOL, academicYear: { id: 'ay1', name: '2030', status: 'DRAFT' }, schedule: schedule(DAYS5, 6),
    grades: [{ id: 'g8', name: 'Grade 8', displayOrder: 1 }], streams: [], sections,
    subjects: [{ id: 'math', name: 'Mathematics', code: 'MATH', schoolId: SCHOOL }, { id: 'sci', name: 'Science', code: 'SCI', schoolId: SCHOOL }],
    requirements: [req('r-math', 'g8', 'math', 5), req('r-sci', 'g8', 'sci', 4)],
    assignments: sections.flatMap((s) => [asg(`a-${s.id}-math`, s.id, 'r-math', 't-math'), asg(`a-${s.id}-sci`, s.id, 'r-sci', 't-sci')]),
    teachers: [teacher('t-math'), teacher('t-sci')], teacherSubjects: [link('t-math', 'math', ['g8']), link('t-sci', 'sci', ['g8'])],
    timingEvents: [], ...over,
  };
}
const must = (s: GenerationSnapshot): NormalizedProblem => { const r = normalizeProblem(s); if (!r.ok) throw new Error(r.issues.map((i) => i.code).join(',')); return r.problem; };

type Tuple = [string, string, string, number];
function coreProblem(D: number, K: number, continues: boolean[], tuples: Tuple[]): NormalizedProblem {
  const W = D * K; const cap = Math.min(32, W);
  const sections = [...new Set(tuples.map((t) => t[1]))].sort(); const teachers = [...new Set(tuples.map((t) => t[2]))].sort();
  const core = {
    contractVersion: CONTRACT_VERSION,
    grid: { days: WEEK.slice(0, D).map((dayOfWeek, index) => ({ index, dayOfWeek: dayOfWeek as 'MONDAY' })), periods: continues.map((c, i) => ({ periodNumber: i + 1, continuesIntoNext: c })), maxTeacherPeriodsPerWeek: 32 },
    sections: sections.map((id) => ({ id })), teachers: teachers.map((id) => ({ id, weeklyCapacity: cap })),
    assignments: tuples.map(([id, s, t, p], i) => ({ id, sectionId: s, subjectId: `subj-${i}`, subjectRequirementId: `req-${i}`, teacherId: t, periodsPerWeek: p })),
    fixedEntries: [],
  };
  return { schoolId: SCHOOL, academicYear: { id: 'ay', name: 'ay' }, core, derived: { dayCount: D, periodsPerDay: K, weeklySlots: W, teacherCapacity: cap, sectionCount: sections.length, teacherCount: teachers.length, assignmentCount: tuples.length, expectedEntryCount: tuples.reduce((n, t) => n + t[3], 0) }, inputHash: hashJson(core) };
}
const allContinue = (K: number): boolean[] => Array.from({ length: K }, (_, i) => i < K - 1);
const opts = (over: Partial<SolverInput['options']> = {}): SolverInput['options'] => ({ timeLimitSeconds: 10, seed: 1, numWorkers: 2, reproducible: false, deterministicTimeLimit: null, ...over });

interface Golden { cases: Array<{ name: string; dayCount: number; periodsPerDay: number; continues: boolean[]; assignments: Tuple[]; entries: Array<[number, number, number]>; expected: { weightedObjective: number } }> }
const golden = JSON.parse(readFileSync(new URL('./test-fixtures/timetable-generation/golden-metrics.json', import.meta.url), 'utf8')) as Golden;
const goldenProblem = (prefix: string): NormalizedProblem => { const c = golden.cases.find((x) => x.name.startsWith(prefix))!; return coreProblem(c.dayCount, c.periodsPerDay, c.continues, c.assignments); };

function solveWithCli(problem: NormalizedProblem, options: SolverInput['options'], requestId = 'req-1') {
  const input = buildSolverInput(problem, requestId, options);
  const zod = solverInputSchema.safeParse(input);
  const result = runSolver(input);
  const zodOut = solverOutputSchema.safeParse(result.json);
  const interpretation = interpretSolverOutput(problem, requestId, result.json);
  return { input, zod, result, zodOut, interpretation };
}

// ===========================================================================
section('1. A TypeScript-built input is accepted and the output satisfies the real Zod schema');
{
  const problem = must(snapshot());
  const { input, zod, result, zodOut, interpretation } = solveWithCli(problem, opts());
  check('the Phase 1 pipeline builds a Zod-valid SolverInput', zod.success);
  check('the CLI exits 0 and prints one JSON document', result.code === 0 && typeof result.json === 'object' && result.json !== null);
  check('the document satisfies solverOutputSchema (real Zod)', zodOut.success, zodOut.success ? '' : JSON.stringify(zodOut.error.issues.slice(0, 3)));
  check('requestId and contractVersion are echoed', (result.json as { requestId: string }).requestId === 'req-1' && (result.json as { contractVersion: string }).contractVersion === CONTRACT_VERSION);
  check('the TypeScript interpreter classifies it as a SOLUTION (OPTIMAL or FEASIBLE)', interpretation.kind === 'SOLUTION');
  if (interpretation.kind === 'SOLUTION') {
    check('the entries pass the TypeScript validator against the TypeScript problem', validateEntries(problem, interpretation.entries).valid);
    check('27 entries = 3 sections x (5 + 4)', interpretation.entries.length === 27);
    const ts = evaluateMetrics(problem, interpretation.entries);
    const objective = interpretation.diagnostics.objectiveValue ?? -1;
    check('the authoritative TypeScript objective never exceeds the solver diagnostic (slack >= 0)', ts.weightedObjective <= objective, `ts=${ts.weightedObjective} solver=${objective}`);
    const outcome = decideOutcome(interpretation, []);
    check('decideOutcome: SUCCESS from CP_SAT', outcome.kind === 'SUCCESS' && outcome.solutionSource === 'CP_SAT');
    check('weights echoed to the solver are WEIGHTS_V1', same(input.weights, { teacherRun3: 3, teacherRun4Plus: 8, subjectSameDayExcess: 5, sectionHoles: 4, dailyLoadExcess: 2 }));
  }
}

section('2. OPTIMAL: the solver objective equals the TypeScript authoritative objective exactly');
{
  // a single lesson series has a provable optimum of 0
  const one = coreProblem(5, 6, allContinue(6), [['a', 'S', 'T', 5]]);
  const r1 = solveWithCli(one, opts());
  check('one section, one subject: OPTIMAL', r1.interpretation.kind === 'SOLUTION' && r1.interpretation.status === 'OPTIMAL');
  if (r1.interpretation.kind === 'SOLUTION') {
    check('solver objective == TypeScript weightedObjective (0)', r1.interpretation.diagnostics.objectiveValue === evaluateMetrics(one, r1.interpretation.entries).weightedObjective);
  }
  // the golden 10-section school
  const g = goldenProblem('s10_5d6p');
  const r2 = solveWithCli(g, opts({ timeLimitSeconds: 60, numWorkers: 4 }));
  check('golden 10-section school: OPTIMAL', r2.interpretation.kind === 'SOLUTION' && r2.interpretation.status === 'OPTIMAL');
  if (r2.interpretation.kind === 'SOLUTION') {
    const ts = evaluateMetrics(g, r2.interpretation.entries);
    check('golden 10-section school: solver objective == TypeScript weightedObjective', r2.interpretation.diagnostics.objectiveValue === ts.weightedObjective, `${r2.interpretation.diagnostics.objectiveValue} vs ${ts.weightedObjective}`);
    check('golden 10-section school: valid under the TypeScript validator', validateEntries(g, r2.interpretation.entries).valid);
  }
}

section('3. Cross-language objective agreement with breaks (continuesIntoNext) and teachers of load < 3');
{
  const cases: Array<[string, NormalizedProblem]> = [
    ['teacher run of 3, no break', coreProblem(1, 6, allContinue(6), [['a', 'S1', 'T', 1], ['b', 'S2', 'T', 1], ['c', 'S3', 'T', 1]])],
    ['same teacher, break after period 2', coreProblem(1, 6, [true, false, true, true, true, false], [['a', 'S1', 'T', 1], ['b', 'S2', 'T', 1], ['c', 'S3', 'T', 1], ['d', 'S4', 'T', 1]])],
    ['teacher with load 2 (excluded from teacher terms)', coreProblem(5, 6, allContinue(6), [['a', 'SA', 'T', 1], ['b', 'SB', 'T', 1]])],
    ['subject spread 5 periods over 5 days', coreProblem(5, 6, allContinue(6), [['a', 'S', 'T', 5], ['b', 'S', 'U', 2]])],
    ['section holes with a late-start section', coreProblem(1, 6, allContinue(6), [['a', 'S', 'T1', 1], ['b', 'S', 'T2', 1], ['c', 'S2', 'T1', 1]])],
  ];
  for (const [name, problem] of cases) {
    const r = solveWithCli(problem, opts({ timeLimitSeconds: 20, numWorkers: 1 }));
    if (r.interpretation.kind !== 'SOLUTION') { check(`${name}: solved`, false, r.interpretation.kind); continue; }
    const ts = evaluateMetrics(problem, r.interpretation.entries).weightedObjective;
    const solver = r.interpretation.diagnostics.objectiveValue ?? -1;
    if (r.interpretation.status === 'OPTIMAL') check(`${name}: OPTIMAL, solver objective == TypeScript objective (${ts})`, solver === ts, `${solver} vs ${ts}`);
    else check(`${name}: FEASIBLE, TypeScript objective <= solver objective`, ts <= solver, `${ts} vs ${solver}`);
  }
}

section('4. Streamed grade: lessons stay on their own stream through the whole pipeline');
{
  const stream = (id: string) => ({ id, gradeId: 'g11', name: id, code: id });
  const s11: GenerationSnapshot = snapshot({
    grades: [{ id: 'g11', name: 'Grade 11', displayOrder: 1 }], streams: [stream('SCI'), stream('COM')],
    sections: [sec('11S1', 'g11', 'SCI'), sec('11S2', 'g11', 'SCI'), sec('11C1', 'g11', 'COM')],
    subjects: [{ id: 'phys', name: 'Physics', code: 'PHY', schoolId: SCHOOL }, { id: 'acct', name: 'Accountancy', code: 'ACC', schoolId: SCHOOL }],
    requirements: [req('r-phys', 'g11', 'phys', 6, 'SCI'), req('r-acct', 'g11', 'acct', 6, 'COM')],
    teachers: [teacher('t-phys'), teacher('t-acct')], teacherSubjects: [link('t-phys', 'phys', ['g11']), link('t-acct', 'acct', ['g11'])],
    assignments: [asg('a1', '11S1', 'r-phys', 't-phys'), asg('a2', '11S2', 'r-phys', 't-phys'), asg('a3', '11C1', 'r-acct', 't-acct')],
  });
  const problem = must(s11);
  const r = solveWithCli(problem, opts());
  check('the streamed school is solved', r.interpretation.kind === 'SOLUTION');
  if (r.interpretation.kind === 'SOLUTION') {
    const streamOfSection = new Map(s11.sections.map((s) => [s.id, s.streamId]));
    const reqByAssignment = new Map(s11.assignments.map((a) => [a.id, s11.requirements.find((q) => q.id === a.subjectRequirementId)!]));
    const ok = r.interpretation.entries.every((e) => reqByAssignment.get(e.assignmentId)!.streamId === streamOfSection.get(e.sectionId));
    check('every entry carries a requirement whose stream equals its section stream', ok);
    check('no Physics lesson in a Commerce section, no Accountancy lesson in a Science section', r.interpretation.entries.every((e) => (e.sectionId === '11C1') === (e.subjectId === 'acct')));
    check('valid under the TypeScript validator', validateEntries(problem, r.interpretation.entries).valid);
  }
  const withStream = { ...buildSolverInput(problem, 'req-s', opts()), sections: problem.core.sections.map((s) => ({ ...s, streamId: 'SCI' })) };
  const rej = runSolver(withStream);
  check('a stream field on a section is rejected by Zod AND by Python (the solver cannot see streams)', !solverInputSchema.safeParse(withStream).success && (rej.json as { status: string }).status === 'INPUT_INVALID');
}

section('5. The approved B / D4 rule with the REAL solver');
{
  // CP-SAT's own UNKNOWN (deterministic budget far too small) -> baseline fallback, a SUCCESS
  const g = goldenProblem('s50_5d8p');
  const baseline = buildBaseline(g, 1);
  if (!baseline.ok) throw new Error('baseline failed');
  const r = solveWithCli(g, opts({ timeLimitSeconds: 60, numWorkers: 2, reproducible: true, deterministicTimeLimit: 0.001 }));
  check('UNKNOWN output satisfies Zod and classifies as NO_SOLUTION', r.zodOut.success && r.interpretation.kind === 'NO_SOLUTION');
  const outcome = decideOutcome(r.interpretation, baseline.entries);
  check('UNKNOWN -> SUCCESS with solutionSource BASELINE (validated baseline)', outcome.kind === 'SUCCESS' && outcome.solutionSource === 'BASELINE' && validateEntries(g, outcome.entries).valid);
  check('UNKNOWN stopped by the deterministic limit', r.interpretation.kind === 'NO_SOLUTION' && r.interpretation.diagnostics.stoppedBy === 'DETERMINISTIC_LIMIT');

  // INFEASIBLE (an overloaded teacher that bypasses the normalizer) -> a failure, never a baseline
  const overloaded = coreProblem(2, 3, allContinue(3), [['a', 'S1', 'T1', 4], ['b', 'S2', 'T1', 3]]);
  const inf = solveWithCli(overloaded, opts());
  check('INFEASIBLE output satisfies Zod and classifies as INFEASIBLE', inf.zodOut.success && inf.interpretation.kind === 'INFEASIBLE');
  const infOutcome = decideOutcome(inf.interpretation, []);
  check('INFEASIBLE -> FAILED INTERNAL_INCONSISTENCY (no silent fallback)', infOutcome.kind === 'FAILURE' && infOutcome.code === 'INTERNAL_INCONSISTENCY');
  check('INFEASIBLE diagnostics name the overloaded teacher', inf.interpretation.kind === 'INFEASIBLE' && inf.interpretation.diagnostics.messages.some((m) => m.includes('teacher T1')));

  // INPUT_INVALID (a dangling teacher id) -> a failure
  const good = buildSolverInput(must(snapshot()), 'req-bad', opts());
  const bad = { ...good, assignments: good.assignments.map((a, i) => (i === 0 ? { ...a, teacherId: 'ghost' } : a)) };
  const badRun = runSolver(bad);
  const badInterp = interpretSolverOutput(must(snapshot()), 'req-bad', badRun.json);
  check('INPUT_INVALID output satisfies Zod and classifies as a SOLVER_INPUT_REJECTED fault', solverOutputSchema.safeParse(badRun.json).success && badInterp.kind === 'FAULT' && badInterp.code === 'SOLVER_INPUT_REJECTED');
  check('INPUT_INVALID -> FAILED SOLVER_INPUT_REJECTED', (() => { const o = decideOutcome(badInterp, []); return o.kind === 'FAILURE' && o.code === 'SOLVER_INPUT_REJECTED'; })());

  // a process-level problem (exit code 2) produces no output at all: the backend sees "no document" -> a process fault
  const garbage = runSolver('this is not json');
  check('malformed input: exit code 2, empty stdout (the backend classifies this as a process fault)', garbage.code === 2 && garbage.stdout === '');
}

section('6. Reproducible mode through the contract');
{
  const g = goldenProblem('s10_6d8p');
  const o = opts({ timeLimitSeconds: 120, numWorkers: 4, reproducible: true, deterministicTimeLimit: 4 });
  const runs = [0, 1].map(() => solveWithCli(g, o));
  check('both runs satisfy Zod', runs.every((x) => x.zodOut.success));
  const entries = runs.map((x) => (x.interpretation.kind === 'SOLUTION' ? JSON.stringify(x.interpretation.entries) : x.interpretation.kind));
  check('two reproducible runs return identical entries (same machine, same OR-Tools version)', entries[0] === entries[1] && entries[0] !== 'NO_SOLUTION');
  const inconsistent = { ...buildSolverInput(g, 'req-r', opts()), options: opts({ reproducible: true, deterministicTimeLimit: null }) };
  check('reproducible without a deterministic limit: Zod accepts, Python rejects (stricter by design)', solverInputSchema.safeParse(inconsistent).success && (runSolver(inconsistent).json as { status: string }).status === 'INPUT_INVALID');
  const inconsistent2 = { ...buildSolverInput(g, 'req-r', opts()), options: opts({ reproducible: false, deterministicTimeLimit: 5 }) };
  check('a deterministic limit without reproducible: Zod accepts, Python rejects (stricter by design)', solverInputSchema.safeParse(inconsistent2).success && (runSolver(inconsistent2).json as { status: string }).status === 'INPUT_INVALID');
}

section('7. Zod and Python agree on the input contract (mutation battery)');
{
  const base = buildSolverInput(must(snapshot()), 'req-m', opts());
  const clone = (): any => JSON.parse(JSON.stringify(base));
  const mutations: Array<[string, (i: any) => void]> = [
    ['extra top-level key', (i) => { i.debug = 1; }],
    ...(['contractVersion', 'requestId', 'options', 'weightsVersion', 'weights', 'grid', 'sections', 'teachers', 'assignments', 'fixedEntries'] as const).map((k): [string, (i: any) => void] => [`missing ${k}`, (i) => { delete i[k]; }]),
    ['contractVersion 2.0', (i) => { i.contractVersion = '2.0'; }],
    ['empty requestId', (i) => { i.requestId = ''; }],
    ['101-char requestId', (i) => { i.requestId = 'r'.repeat(101); }],
    ['seed -1', (i) => { i.options.seed = -1; }], ['seed 2^31', (i) => { i.options.seed = 2 ** 31; }], ['seed 1.5', (i) => { i.options.seed = 1.5; }],
    ['numWorkers 0', (i) => { i.options.numWorkers = 0; }], ['numWorkers 65', (i) => { i.options.numWorkers = 65; }],
    ['timeLimitSeconds 0', (i) => { i.options.timeLimitSeconds = 0; }], ['timeLimitSeconds 3601', (i) => { i.options.timeLimitSeconds = 3601; }],
    ['reproducible "yes"', (i) => { i.options.reproducible = 'yes'; }],
    ['deterministicTimeLimit 0', (i) => { i.options.reproducible = true; i.options.deterministicTimeLimit = 0; }],
    ['deterministicTimeLimit 3601', (i) => { i.options.reproducible = true; i.options.deterministicTimeLimit = 3601; }],
    ['deterministicTimeLimit "x"', (i) => { i.options.deterministicTimeLimit = 'x'; }],
    ['extra options key', (i) => { i.options.extra = 1; }],
    ['weight -1', (i) => { i.weights.teacherRun3 = -1; }], ['weight 1001', (i) => { i.weights.teacherRun3 = 1001; }], ['weight 1.5', (i) => { i.weights.sectionHoles = 1.5; }],
    ['missing weight', (i) => { delete i.weights.dailyLoadExcess; }], ['extra weight', (i) => { i.weights.extra = 1; }],
    ['weightsVersion empty', (i) => { i.weightsVersion = ''; }],
    ['no days', (i) => { i.grid.days = []; }],
    ['unknown day name', (i) => { i.grid.days[1].dayOfWeek = 'FUNDAY'; }],
    ['13 periods', (i) => { i.grid.periods = Array.from({ length: 13 }, (_, k) => ({ periodNumber: k + 1, continuesIntoNext: true })); }],
    ['maxTeacherPeriodsPerWeek 0', (i) => { i.grid.maxTeacherPeriodsPerWeek = 0; }], ['maxTeacherPeriodsPerWeek 33', (i) => { i.grid.maxTeacherPeriodsPerWeek = 33; }],
    ['continuesIntoNext "yes"', (i) => { i.grid.periods[0].continuesIntoNext = 'yes'; }],
    ['no sections', (i) => { i.sections = []; }], ['section extra key (streamId)', (i) => { i.sections[0].streamId = 'SCI'; }], ['empty section id', (i) => { i.sections[0].id = ''; }],
    ['no teachers', (i) => { i.teachers = []; }], ['weeklyCapacity 0', (i) => { i.teachers[0].weeklyCapacity = 0; }], ['weeklyCapacity 33', (i) => { i.teachers[0].weeklyCapacity = 33; }],
    ['no assignments', (i) => { i.assignments = []; }], ['periodsPerWeek 0', (i) => { i.assignments[0].periodsPerWeek = 0; }], ['periodsPerWeek 101', (i) => { i.assignments[0].periodsPerWeek = 101; }], ['periodsPerWeek 2.5', (i) => { i.assignments[0].periodsPerWeek = 2.5; }],
    ['assignment extra key (gradeId)', (i) => { i.assignments[0].gradeId = 'g8'; }], ['assignment id 101 chars', (i) => { i.assignments[0].id = 'x'.repeat(101); }], ['assignment missing teacherId', (i) => { delete i.assignments[0].teacherId; }],
    ['fixed entry period 0', (i) => { i.fixedEntries = [{ assignmentId: 'a-8A-math', dayOfWeek: 'MONDAY', periodNumber: 0 }]; }],
    ['fixed entry unknown day', (i) => { i.fixedEntries = [{ assignmentId: 'a-8A-math', dayOfWeek: 'FUNDAY', periodNumber: 1 }]; }],
    ['fixed entry extra key', (i) => { i.fixedEntries = [{ assignmentId: 'a-8A-math', dayOfWeek: 'MONDAY', periodNumber: 1, extra: 1 }]; }],
  ];
  const accepts: Array<[string, (i: any) => void]> = [
    ['seed 0', (i) => { i.options.seed = 0; }], ['seed 2147483647', (i) => { i.options.seed = 2_147_483_647; }],
    ['numWorkers 1', (i) => { i.options.numWorkers = 1; }], ['numWorkers 64', (i) => { i.options.numWorkers = 64; }],
    ['timeLimitSeconds 1', (i) => { i.options.timeLimitSeconds = 1; }], ['timeLimitSeconds 3600', (i) => { i.options.timeLimitSeconds = 3600; }],
    ['all weights 0', (i) => { for (const k of TERM_NAMES) i.weights[k] = 0; }], ['all weights 1000', (i) => { for (const k of TERM_NAMES) i.weights[k] = 1000; }],
    ['100-char requestId', (i) => { i.requestId = 'r'.repeat(100); }], ['weightsVersion of 20 chars', (i) => { i.weightsVersion = 'v'.repeat(20); }],
    ['an unreferenced extra section', (i) => { i.sections.push({ id: 'unused' }); }],
    ['reproducible with a limit', (i) => { i.options.reproducible = true; i.options.deterministicTimeLimit = 3.5; }],
    ['7 days x 12 periods grid', (i) => { i.grid.days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map((d, k) => ({ index: k, dayOfWeek: d })); i.grid.periods = Array.from({ length: 12 }, (_, k) => ({ periodNumber: k + 1, continuesIntoNext: k % 2 === 0 })); }],
    ['a valid fixed entry', (i) => { i.fixedEntries = [{ assignmentId: 'a-8A-math', dayOfWeek: 'MONDAY', periodNumber: 1 }]; }],
  ];
  let disagreements: string[] = [];
  const pythonAccepts = (payload: unknown): boolean => { const r = runSolver(payload, 60_000); return r.code === 0 && (r.json as { status?: string } | null)?.status !== 'INPUT_INVALID'; };
  for (const [name, mutate] of mutations) {
    const input = clone(); mutate(input);
    const zodValid = solverInputSchema.safeParse(input).success;
    const py = pythonAccepts(input);
    if (zodValid) disagreements.push(`${name}: Zod ACCEPTS (battery expects rejection)`);
    if (py) disagreements.push(`${name}: Python ACCEPTS what Zod rejects`);
  }
  check(`all ${mutations.length} invalid payloads are rejected by BOTH Zod and Python`, disagreements.length === 0, disagreements.join(' | '));
  disagreements = [];
  for (const [name, mutate] of accepts) {
    // a valid payload is judged on acceptance, not on solve quality: switch the objective off so every solve ends at the
    // first feasible timetable (otherwise e.g. timeLimitSeconds 3600 would legitimately keep optimising for an hour)
    const input = clone(); for (const k of TERM_NAMES) input.weights[k] = 0; mutate(input);
    const zodValid = solverInputSchema.safeParse(input).success;
    const py = pythonAccepts(input);
    if (!zodValid) disagreements.push(`${name}: Zod rejects`);
    if (!py) disagreements.push(`${name}: Python rejects what Zod accepts`);
  }
  check(`all ${accepts.length} valid payloads are accepted by BOTH Zod and Python`, disagreements.length === 0, disagreements.join(' | '));
}

section('8. Every status document the solver can produce satisfies the real Zod output schema');
{
  const docs: Array<[string, unknown]> = [];
  docs.push(['OPTIMAL', solveWithCli(coreProblem(5, 6, allContinue(6), [['a', 'S', 'T', 5]]), opts()).result.json]);
  docs.push(['FEASIBLE', solveWithCli(goldenProblem('s50_5d8p'), opts({ timeLimitSeconds: 6, numWorkers: 4 })).result.json]);
  docs.push(['UNKNOWN', solveWithCli(goldenProblem('s50_5d8p'), opts({ timeLimitSeconds: 60, reproducible: true, deterministicTimeLimit: 0.001 })).result.json]);
  docs.push(['INFEASIBLE', solveWithCli(coreProblem(2, 3, allContinue(3), [['a', 'S1', 'T1', 4], ['b', 'S2', 'T1', 3]]), opts()).result.json]);
  docs.push(['INPUT_INVALID', runSolver({ ...buildSolverInput(must(snapshot()), 'req-x', opts()), grid: null }).json]);
  for (const [label, doc] of docs) {
    const parsed = solverOutputSchema.safeParse(doc);
    check(`${label}: satisfies solverOutputSchema and reports status ${(doc as { status: string }).status}`, parsed.success && (doc as { status: string }).status.startsWith(label.slice(0, 5)) , parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 2)));
  }
  const statuses = docs.map(([, d]) => (d as { status: string }).status);
  check('the five documents cover OPTIMAL, FEASIBLE, UNKNOWN, INFEASIBLE and INPUT_INVALID', same(statuses, ['OPTIMAL', 'FEASIBLE', 'UNKNOWN', 'INFEASIBLE', 'INPUT_INVALID']), statuses.join(','));
  const entriesOnlyWhenSolved = docs.every(([label, d]) => ((d as { entries: unknown[] }).entries.length > 0) === (label === 'OPTIMAL' || label === 'FEASIBLE'));
  check('entries are present exactly for OPTIMAL and FEASIBLE', entriesOnlyWhenSolved);
}

section('9. Transport: the solver never waits for stdin end-of-file (regression for a measured Node/macOS hang)');
{
  // Under child_process.spawnSync the child's stdio is a socket pair and the end-of-input signal is not reliably delivered:
  // a trivial script that read stdin to EOF hung in about 1 of 40 runs, and the solver (before it stopped at the end of the
  // JSON document) hung in about 1 of 5 of these runs. 30 runs; every one must complete.
  const tiny = buildSolverInput(coreProblem(1, 3, allContinue(3), [['a', 'S', 'T', 1]]), 'req-t', opts({ numWorkers: 1, timeLimitSeconds: 10 }));
  let bad = 0;
  for (let i = 0; i < 30; i++) {
    const r = runSolver(tiny, 20_000);
    if (r.code !== 0 || (r.json as { status?: string } | null)?.status !== 'OPTIMAL') bad++;
  }
  check('30 consecutive spawnSync runs all complete with OPTIMAL (no hang, no timeout)', bad === 0, `${bad} of 30 failed`);
  const compact = JSON.stringify(tiny);
  const withNewline = runSolver(`${compact}\n`, 20_000);
  check('the request may carry a trailing newline', withNewline.code === 0 && (withNewline.json as { status?: string }).status === 'OPTIMAL');
  const pretty = runSolver(JSON.stringify(tiny, null, 2), 20_000);
  check('a pretty-printed request is accepted', pretty.code === 0 && (pretty.json as { status?: string }).status === 'OPTIMAL');
}

// ===========================================================================
section('10. Phase 7E: locked lessons through the whole pipeline into the REAL solver');
{
  const lock = (assignmentId: string, section: string, req: string, teacherId: string, day: string, period: number) => ({ assignmentId, sectionId: section, subjectRequirementId: req, teacherId, dayOfWeek: day as 'MONDAY', periodNumber: period, source: 'GENERATED' as const });
  const locks = [lock('a-8A-math', '8A', 'r-math', 't-math', 'MONDAY', 2), lock('a-8B-sci', '8B', 'r-sci', 't-sci', 'FRIDAY', 6), lock('a-8C-math', '8C', 'r-math', 't-math', 'WEDNESDAY', 4)];
  const normalized = normalizeProblem(snapshot(), { lockedEntries: locks });
  if (!normalized.ok) throw new Error(normalized.issues.map((i) => i.code).join(','));
  const problem = normalized.problem;
  const { input, zod, result, zodOut, interpretation } = solveWithCli(problem, opts());
  check('the SolverInput carries the three fixed entries in the contract shape and satisfies the real Zod schema', zod.success && input.fixedEntries.length === 3 && same(input.fixedEntries, problem.core.fixedEntries));
  check('the request hash binds the locks: the core of the request hashes to the problem input hash', hashJson({ contractVersion: input.contractVersion, grid: input.grid, sections: input.sections, teachers: input.teachers, assignments: input.assignments, fixedEntries: input.fixedEntries }) === problem.inputHash);
  check('the real solver answers 0 with a document that satisfies the output schema', result.code === 0 && zodOut.success);
  check('the TypeScript interpreter accepts it as a SOLUTION', interpretation.kind === 'SOLUTION');
  if (interpretation.kind === 'SOLUTION') {
    const placed = new Set(interpretation.entries.map((e) => `${e.assignmentId}|${e.dayOfWeek}|${e.periodNumber}`));
    check('EVERY locked lesson is in the solver\'s timetable at exactly its assignment, day and period', locks.every((l) => placed.has(`${l.assignmentId}|${l.dayOfWeek}|${l.periodNumber}`)));
    check('the timetable passes the full TypeScript validation including the fixed-entry check', validateEntries(problem, interpretation.entries).valid);
    check('27 entries as without locks (locks pin lessons, they do not add any)', interpretation.entries.length === 27);
    check('the solver\'s objective is still never below the authoritative TypeScript objective', evaluateMetrics(problem, interpretation.entries).weightedObjective <= (interpretation.diagnostics.objectiveValue ?? -1));
  }

  // a solver that IGNORED a lock: the same document with one locked lesson moved. The TypeScript side must reject it.
  const doc = JSON.parse(JSON.stringify(result.json)) as { entries: TimetableEntryRow[] };
  const victim = doc.entries.findIndex((e) => e.assignmentId === 'a-8A-math' && e.dayOfWeek === 'MONDAY' && e.periodNumber === 2);
  const taken = new Set(doc.entries.filter((e) => e.sectionId === '8A').map((e) => `${e.dayOfWeek}|${e.periodNumber}`));
  const target = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].flatMap((d) => [1, 2, 3, 4, 5, 6].map((p) => [d, p] as const)).find(([d, p]) => !taken.has(`${d}|${p}`) && !doc.entries.some((e) => e.teacherId === 't-math' && e.dayOfWeek === d && e.periodNumber === p))!;
  doc.entries[victim] = { ...doc.entries[victim]!, dayOfWeek: target[0] as 'MONDAY', periodNumber: target[1] };
  const tampered = interpretSolverOutput(problem, 'req-1', { ...(result.json as object), entries: doc.entries });
  check('a timetable that moved a locked lesson is rejected: FAULT SOLVER_INVALID_OUTPUT, with FIXED_ENTRY_VIOLATED', tampered.kind === 'FAULT' && tampered.code === 'SOLVER_INVALID_OUTPUT' && tampered.problems.some((p) => p.code === 'FIXED_ENTRY_VIOLATED'));
  check('...and the outcome is a FAILURE with that code, never a success', (() => { const o = decideOutcome(tampered, null); return o.kind === 'FAILURE' && o.code === 'SOLVER_INVALID_OUTPUT'; })());
  const dropped = interpretSolverOutput(problem, 'req-1', { ...(result.json as object), entries: doc.entries.filter((_, i) => i !== victim) });
  check('a timetable that DROPPED a locked lesson is rejected too', dropped.kind === 'FAULT');

  // locks that make the problem infeasible: the REAL solver proves it
  const infCore = coreProblem(5, 6, allContinue(6), [['xA', 'X', 'T1', 10], ['xB', 'X', 'T2', 10], ['xC', 'X', 'T3', 10], ['yD', 'Y', 'T1', 20]]);
  const slots: Array<[string, number]> = [];
  for (const d of ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY']) for (let k = 1; k <= 6; k++) slots.push([d, k]);
  const fixed = [...slots.slice(0, 20).map(([d, k]) => ({ assignmentId: 'yD', dayOfWeek: d as 'MONDAY', periodNumber: k })), { assignmentId: 'xB', dayOfWeek: 'FRIDAY' as const, periodNumber: 1 }];
  const infProblem: NormalizedProblem = { ...infCore, core: { ...infCore.core, fixedEntries: fixed }, inputHash: hashJson({ ...infCore.core, fixedEntries: fixed }) };
  const inf = solveWithCli(infProblem, opts());
  check('locks that make the timetable impossible: the real solver answers INFEASIBLE', inf.interpretation.kind === 'INFEASIBLE');
  check('...which, with no baseline, is INFEASIBLE_HARD_CONSTRAINTS (proven) and never NO_SOLUTION_WITH_LOCKS', (() => { const o = decideOutcome(inf.interpretation, null); return o.kind === 'FAILURE' && o.code === 'INFEASIBLE_HARD_CONSTRAINTS'; })());
}

// ===========================================================================
section('11. Stop attribution: the new LIMIT_AMBIGUOUS value is part of the cross-language contract');
{
  const g = goldenProblem('s50_5d8p');
  const real = solveWithCli(g, opts({ timeLimitSeconds: 60, numWorkers: 2, reproducible: true, deterministicTimeLimit: 0.001 }));
  check('(setup) the real solver ends a tiny deterministic budget with a CONFIRMED DETERMINISTIC_LIMIT stop', real.interpretation.kind === 'NO_SOLUTION' && real.interpretation.diagnostics.stoppedBy === 'DETERMINISTIC_LIMIT');
  const doc = JSON.parse(JSON.stringify(real.result.json)) as { diagnostics: { stoppedBy: string } };
  doc.diagnostics.stoppedBy = 'LIMIT_AMBIGUOUS';
  check('a solver document with stoppedBy LIMIT_AMBIGUOUS satisfies the real Zod output schema', solverOutputSchema.safeParse(doc).success);
  const ambiguous = interpretSolverOutput(g, 'req-1', doc);
  check('...and is interpreted exactly like any other UNKNOWN: NO_SOLUTION carrying the ambiguous stop reason', ambiguous.kind === 'NO_SOLUTION' && ambiguous.diagnostics.stoppedBy === 'LIMIT_AMBIGUOUS');
  const baseline = buildBaseline(g, 1);
  check('...and the outcome rule is unchanged: SUCCESS with the validated baseline (NO_SOLUTION_WITHIN_BUDGET)', baseline.ok && (() => { const o = decideOutcome(ambiguous, baseline.entries); return o.kind === 'SUCCESS' && o.solutionSource === 'BASELINE' && o.fallbackReason === 'NO_SOLUTION_WITHIN_BUDGET'; })());
  const unknownValue = JSON.parse(JSON.stringify(doc)) as { diagnostics: { stoppedBy: string } };
  unknownValue.diagnostics.stoppedBy = 'SOMETHING_ELSE';
  check('a stop reason outside the contract is still rejected', !solverOutputSchema.safeParse(unknownValue).success);
}

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
