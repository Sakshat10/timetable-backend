// Module 11 - Phase 7E (pure): locked entries during regeneration. No database, no solver process.
//   1. the NO-LOCK COMPATIBILITY CONTRACT (golden recorded from the unchanged code BEFORE 7E): baseline output and input hash
//   2. freezing locks, canonical order, the hash rules
//   3. lock validation against a fresh configuration (through the real normalizer)
//   4. the validator's fixed-entry check
//   5. the outcome matrix (with and without a baseline)
//   6. the lock-aware baseline
import { readFileSync } from 'node:fs';
import { buildBaseline } from './src/modules/timetable-generation/timetable-generation.baseline.js';
import { buildBaselineWithFixed } from './src/modules/timetable-generation/timetable-generation.baseline-locks.js';
import { FAILURE_CODES, type SolverDiagnostics, type SolverProblemCore, type TimetableEntryRow } from './src/modules/timetable-generation/timetable-generation.contracts.js';
import { hashJson } from './src/modules/timetable-generation/timetable-generation.hash.js';
import { canonicalizeLocks, freezeLocks, frozenLocksSchema, LOCK_ISSUE_CODES, resolveLocks, type FrozenLock } from './src/modules/timetable-generation/timetable-generation.locks.js';
import { normalizeProblem, type GenerationSnapshot } from './src/modules/timetable-generation/timetable-generation.normalizer.js';
import { decideOutcome, type SolverAttempt } from './src/modules/timetable-generation/timetable-generation.outcome.js';
import { validateEntries } from './src/modules/timetable-generation/timetable-generation.validator.js';
import { evaluateMetrics } from './src/modules/timetable-generation/timetable-generation.metrics.js';
import { GOLDEN_CORES, GOLDEN_SEEDS, makeCore, problemOfCore } from './test-fixtures/timetable-generation/core-fixtures.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;

// =====================================================================================================================
section('1. NO-LOCK COMPATIBILITY: output recorded from the unchanged code before Phase 7E');
{
  const golden = JSON.parse(readFileSync('test-fixtures/timetable-generation/baseline-golden.json', 'utf8')) as Record<string, { inputHash: string; baseline: Record<string, string> }>;
  for (const g of GOLDEN_CORES) {
    const problem = problemOfCore(g.core());
    check(`${g.name}: the input hash is unchanged`, problem.inputHash === golden[g.name]!.inputHash);
    let same = true;
    let delegated = true;
    for (const seed of GOLDEN_SEEDS) {
      const r = buildBaseline(problem, seed);
      const h = r.ok ? hashJson(r.entries) : `NOT_OK:${JSON.stringify(r.certificate)}`;
      if (h !== golden[g.name]!.baseline[String(seed)]) same = false;
      const w = buildBaselineWithFixed(problem, seed);
      if (!(w.ok && r.ok && hashJson(w.entries) === hashJson(r.entries) && w.attempts === 1)) delegated = false;
    }
    check(`${g.name}: buildBaseline output is byte-identical to the golden for every seed`, same);
    check(`${g.name}: without fixed entries the lock-aware path IS the plain baseline (same entries)`, delegated);
  }
  check('the golden covers every fixture core and seed', Object.keys(golden).length === GOLDEN_CORES.length && Object.values(golden).every((g) => Object.keys(g.baseline).length === GOLDEN_SEEDS.length));
  const over = problemOfCore(makeCore(3, [11, 11, 11])); // 33 > 30 slots for a teacher? each teacher teaches 3 sections x 11 = 33 > 30
  const a = buildBaseline(over, 1);
  const b = buildBaselineWithFixed(over, 1);
  check('a capacity violation: the plain baseline fails with its certificate, and so does the lock-aware path (same exact certificate)', !a.ok && !b.ok && b.reason === 'CAPACITY' && JSON.stringify(b.certificate) === JSON.stringify(a.certificate));
}

// =====================================================================================================================
section('2. Freezing locks, canonical order, the hash rules');
{
  const assignments = [
    { id: 'a1', sectionId: 's1', subjectRequirementId: 'r1' }, { id: 'a2', sectionId: 's1', subjectRequirementId: 'r2' }, { id: 'a3', sectionId: 's2', subjectRequirementId: 'r1' },
  ];
  const entry = (id: string, sectionId: string, req: string, day: string, period: number, source = 'GENERATED') => ({ id, sectionId, subjectRequirementId: req, teacherId: `t-${req}`, dayOfWeek: day, periodNumber: period, source });
  const frozen = freezeLocks([entry('e1', 's2', 'r1', 'WEDNESDAY', 2), entry('e2', 's1', 'r2', 'MONDAY', 5, 'MANUAL'), entry('e3', 's1', 'r1', 'TUESDAY', 1), entry('e4', 's1', 'r1', 'MONDAY', 3)], assignments);
  check('every locked entry is resolved to its assignment by (section, requirement)', frozen.issues.length === 0 && frozen.locks.map((l) => l.assignmentId).join() === 'a1,a1,a2,a3');
  check('the frozen list is canonically sorted: assignment id, then day in week order, then period', frozen.locks.map((l) => `${l.assignmentId}|${l.dayOfWeek}|${l.periodNumber}`).join() === 'a1|MONDAY|3,a1|TUESDAY|1,a2|MONDAY|5,a3|WEDNESDAY|2');
  check('the original source is preserved (D-E2) and the teacher is captured for verification', frozen.locks.find((l) => l.assignmentId === 'a2')!.source === 'MANUAL' && frozen.locks.every((l) => l.teacherId.startsWith('t-')));
  const reversed = freezeLocks([entry('e4', 's1', 'r1', 'MONDAY', 3), entry('e3', 's1', 'r1', 'TUESDAY', 1), entry('e2', 's1', 'r2', 'MONDAY', 5, 'MANUAL'), entry('e1', 's2', 'r1', 'WEDNESDAY', 2)], assignments);
  check('the same locks in a different order freeze to the identical list', JSON.stringify(reversed.locks) === JSON.stringify(frozen.locks));
  const ghost = freezeLocks([entry('e9', 's9', 'r9', 'MONDAY', 1)], assignments);
  check('a locked entry without any assignment cannot be frozen: LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND', ghost.locks.length === 0 && ghost.issues[0]?.code === 'LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND');
  check('zero locks freeze to an empty list', freezeLocks([], assignments).locks.length === 0);
  check('the frozen list passes its own schema', frozenLocksSchema.safeParse(frozen.locks).success);
  check('...and the schema rejects unknown keys, bad days and bad periods', !frozenLocksSchema.safeParse([{ ...frozen.locks[0], extra: 1 }]).success && !frozenLocksSchema.safeParse([{ ...frozen.locks[0], dayOfWeek: 'FUNDAY' }]).success && !frozenLocksSchema.safeParse([{ ...frozen.locks[0], periodNumber: 0 }]).success && !frozenLocksSchema.safeParse([{ ...frozen.locks[0], source: 'ROBOT' }]).success);
  check('canonicalizeLocks does not mutate its input and is idempotent', (() => { const input = [...frozen.locks].reverse(); const before = JSON.stringify(input); const once = canonicalizeLocks(input); return JSON.stringify(input) === before && JSON.stringify(canonicalizeLocks(once)) === JSON.stringify(once); })());
}

// ---- a small real snapshot to go through the real normalizer -------------------------------------------------------------
const SCHOOL = 'school-1';
function snapshot(over: Partial<GenerationSnapshot> = {}): GenerationSnapshot {
  const sections = ['8A', '8B', '8C'].map((id) => ({ id, gradeId: 'g8', streamId: null, name: id, code: id }));
  return {
    schoolId: SCHOOL,
    academicYear: { id: 'ay1', name: '2030', status: 'DRAFT' },
    schedule: { periodsPerDay: 6, workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'], periods: Array.from({ length: 6 }, (_, k) => ({ periodNumber: k + 1 })) },
    grades: [{ id: 'g8', name: 'Grade 8', displayOrder: 1 }],
    streams: [],
    sections,
    subjects: [{ id: 'math', name: 'Maths', code: 'M', schoolId: SCHOOL }, { id: 'sci', name: 'Science', code: 'S', schoolId: SCHOOL }],
    requirements: [{ id: 'r-math', gradeId: 'g8', streamId: null, subjectId: 'math', periodsPerWeek: 5 }, { id: 'r-sci', gradeId: 'g8', streamId: null, subjectId: 'sci', periodsPerWeek: 4 }],
    assignments: sections.flatMap((s) => [{ id: `a-${s.id}-math`, sectionId: s.id, subjectRequirementId: 'r-math', teacherId: 't-math' }, { id: `a-${s.id}-sci`, sectionId: s.id, subjectRequirementId: 'r-sci', teacherId: 't-sci' }]),
    teachers: [{ id: 't-math', schoolId: SCHOOL, name: 'T math', isActive: true }, { id: 't-sci', schoolId: SCHOOL, name: 'T sci', isActive: true }],
    teacherSubjects: [{ teacherId: 't-math', subjectId: 'math', gradeIds: ['g8'] }, { teacherId: 't-sci', subjectId: 'sci', gradeIds: ['g8'] }],
    timingEvents: [],
    ...over,
  };
}
const lk = (over: Partial<FrozenLock> = {}): FrozenLock => ({ assignmentId: 'a-8A-math', sectionId: '8A', subjectRequirementId: 'r-math', teacherId: 't-math', dayOfWeek: 'MONDAY', periodNumber: 2, source: 'GENERATED', ...over });

section('2b. The hash rules (through the real normalizer)');
{
  const base = normalizeProblem(snapshot());
  if (!base.ok) throw new Error('fixture');
  const L1 = lk();
  const L2 = lk({ assignmentId: 'a-8B-sci', sectionId: '8B', subjectRequirementId: 'r-sci', teacherId: 't-sci', dayOfWeek: 'TUESDAY', periodNumber: 4 });
  const a = normalizeProblem(snapshot(), { lockedEntries: [L1, L2] });
  const b = normalizeProblem(snapshot(), { lockedEntries: [L2, L1] });
  check('valid locks normalize', a.ok && b.ok);
  if (!a.ok || !b.ok) throw new Error('fixture');
  check('the locks become core.fixedEntries in the solver contract shape, canonically sorted', JSON.stringify(a.problem.core.fixedEntries) === JSON.stringify([{ assignmentId: 'a-8A-math', dayOfWeek: 'MONDAY', periodNumber: 2 }, { assignmentId: 'a-8B-sci', dayOfWeek: 'TUESDAY', periodNumber: 4 }]));
  check('same configuration + same locks in a different order = same fixedEntries and the SAME input hash', JSON.stringify(a.problem.core) === JSON.stringify(b.problem.core) && a.problem.inputHash === b.problem.inputHash);
  check('same configuration + different locks = a different input hash', a.problem.inputHash !== normalizeProblem(snapshot(), { lockedEntries: [L1] }).problem?.inputHash && a.problem.inputHash !== base.problem.inputHash);
  check('locks differing only in a verification field (source) do not change the hash: only the solver\'s view is hashed', (() => { const c = normalizeProblem(snapshot(), { lockedEntries: [{ ...L1, source: 'MANUAL' }, L2] }); return c.ok && c.problem.inputHash === a.problem.inputHash; })());
  check('the input hash is the hash of the core, as before', a.problem.inputHash === hashJson(a.problem.core));
  check('no locks: the problem and its hash are exactly those of a normalization without the option', normalizeProblem(snapshot(), { lockedEntries: [] }).problem?.inputHash === base.problem.inputHash && normalizeProblem(snapshot(), { lockedEntries: undefined }).problem?.inputHash === base.problem.inputHash);
  check('the locked problem has the same assignments, sections, teachers and grid as the unlocked one', JSON.stringify({ ...a.problem.core, fixedEntries: [] }) === JSON.stringify(base.problem.core));
}

section('3. Lock validation against the FRESH configuration');
{
  const codesOf = (locks: FrozenLock[], snap = snapshot()): string[] => { const r = normalizeProblem(snap, { lockedEntries: locks }); return r.ok ? [] : r.issues.map((i) => i.code); };
  check('a valid lock set normalizes without issues', codesOf([lk()]).length === 0);
  const sciOf = (day: FrozenLock['dayOfWeek'], p: number) => lk({ assignmentId: 'a-8A-sci', subjectRequirementId: 'r-sci', teacherId: 't-sci', dayOfWeek: day, periodNumber: p });
  const cases: Array<[string, FrozenLock[], GenerationSnapshot | undefined, string]> = [
    ['assignment removed (no longer exists)', [lk()], snapshot({ assignments: snapshot().assignments.filter((a) => a.id !== 'a-8A-math'), requirements: snapshot().requirements }), 'LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND'], // the pair is now auto-assigned under a different (synthetic) id: a lock on the removed explicit assignment is not guessed
    ['assignment id unknown', [lk({ assignmentId: 'ghost' })], undefined, 'LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND'],
    ['assignment deleted and recreated under a new id: NOT guessed (D-E1)', [lk()], snapshot({ assignments: snapshot().assignments.map((a) => (a.id === 'a-8A-math' ? { ...a, id: 'a-8A-math-NEW' } : a)) }), 'LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND'],
    ['teacher changed', [lk()], snapshot({ teachers: [...snapshot().teachers, { id: 't-math2', schoolId: SCHOOL, name: 'T2', isActive: true }], teacherSubjects: [...snapshot().teacherSubjects, { teacherId: 't-math2', subjectId: 'math', gradeIds: ['g8'] }], assignments: snapshot().assignments.map((a) => (a.id === 'a-8A-math' ? { ...a, teacherId: 't-math2' } : a)) }), 'LOCKED_ENTRY_TEACHER_CHANGED'],
    ['requirement mismatch (the lock names another section)', [lk({ sectionId: '8C' })], undefined, 'LOCKED_ENTRY_REQUIREMENT_MISMATCH'],
    ['requirement mismatch (the lock names another requirement)', [lk({ subjectRequirementId: 'r-sci' })], undefined, 'LOCKED_ENTRY_REQUIREMENT_MISMATCH'],
    ['invalid day (a day that is not a working day)', [lk({ dayOfWeek: 'SATURDAY' })], undefined, 'LOCKED_ENTRY_INVALID_DAY'],
    ['a working day REMOVED from the schedule since the lock', [lk({ dayOfWeek: 'FRIDAY' })], snapshot({ schedule: { periodsPerDay: 6, workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY'], periods: Array.from({ length: 6 }, (_, k) => ({ periodNumber: k + 1 })) } }), 'LOCKED_ENTRY_INVALID_DAY'],
    ['invalid period (beyond the grid)', [lk({ periodNumber: 7 })], undefined, 'LOCKED_ENTRY_INVALID_PERIOD'],
    ['a period REMOVED from the schedule since the lock (6 -> 5 periods)', [lk({ periodNumber: 6 })], snapshot({ schedule: { periodsPerDay: 5, workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'], periods: Array.from({ length: 5 }, (_, k) => ({ periodNumber: k + 1 })) } }), 'LOCKED_ENTRY_INVALID_PERIOD'],
    ['period 0', [lk({ periodNumber: 0 })], undefined, 'LOCKED_ENTRY_INVALID_PERIOD'],
    ['duplicate lock', [lk(), lk()], undefined, 'LOCKED_ENTRY_DUPLICATE'],
    ['section collision (two lessons of 8A in Monday P2)', [lk(), sciOf('MONDAY', 2)], undefined, 'LOCKED_ENTRY_SECTION_COLLISION'],
    ['teacher collision (the maths teacher in 8A and 8B at once)', [lk(), lk({ assignmentId: 'a-8B-math', sectionId: '8B' })], undefined, 'LOCKED_ENTRY_TEACHER_COLLISION'],
    ['more locks than the requirement has periods (4 science periods, 5 locks)', ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].map((d) => sciOf(d as FrozenLock['dayOfWeek'], 1)), undefined, 'LOCKED_ENTRY_EXCEEDS_REQUIREMENT'],
    ['requirement reduced below the number of locks (5 -> 1 period)', [lk(), lk({ periodNumber: 3 })], snapshot({ requirements: [{ id: 'r-math', gradeId: 'g8', streamId: null, subjectId: 'math', periodsPerWeek: 1 }, { id: 'r-sci', gradeId: 'g8', streamId: null, subjectId: 'sci', periodsPerWeek: 4 }] }), 'LOCKED_ENTRY_EXCEEDS_REQUIREMENT'],
  ];
  for (const [name, locks, snap, expected] of cases) {
    const got = codesOf(locks, snap);
    check(`${name}: ${expected}`, got.includes(expected), got.join(','));
  }
  const many = (() => { const out: FrozenLock[] = []; for (const d of ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const) for (let k = 1; k <= 6; k++) out.push(lk({ dayOfWeek: d, periodNumber: k })); out.push(lk({ assignmentId: 'a-8B-math', sectionId: '8B' })); return out; })();
  check('a teacher locked beyond the weekly capacity (31 > 30): LOCKED_ENTRY_CAPACITY_EXCEEDED', codesOf(many).includes('LOCKED_ENTRY_CAPACITY_EXCEEDED'));
  check('EVERY problem is reported, not the first one only', (() => { const c = codesOf([lk({ assignmentId: 'ghost' }), lk({ dayOfWeek: 'SATURDAY', periodNumber: 3 }), lk({ periodNumber: 9 })]); return c.includes('LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND') && c.includes('LOCKED_ENTRY_INVALID_DAY') && c.includes('LOCKED_ENTRY_INVALID_PERIOD'); })());
  check('the issues carry the entity and the slot (structured, not just a message)', (() => { const r = normalizeProblem(snapshot(), { lockedEntries: [lk({ dayOfWeek: 'SATURDAY' })] }); return !r.ok && r.issues[0]!.entity?.type === 'LOCKED_ENTRY' && (r.issues[0]!.details as { dayOfWeek: string }).dayOfWeek === 'SATURDAY'; })());
  check('an invalid configuration is reported on its own: locks are not judged against it', (() => { const c = codesOf([lk()], snapshot({ schedule: null })); return c.includes('SCHEDULE_MISSING') && !c.some((x) => x.startsWith('LOCKED')); })());
  check('a non-DRAFT year is still refused (the lock option does not bypass anything)', codesOf([lk()], snapshot({ academicYear: { id: 'ay1', name: 'x', status: 'ACTIVE' } })).includes('YEAR_NOT_DRAFT'));
  check('all ten lock issue codes exist and are distinct', LOCK_ISSUE_CODES.length === 10 && new Set(LOCK_ISSUE_CODES).size === 10);
  const direct = resolveLocks([lk()], { assignments: [], workingDays: new Set(), periodsPerDay: 6, teacherCapacity: 30 });
  check('resolveLocks on its own returns no fixed entries when there is any issue', direct.fixedEntries.length === 0 && direct.issues.length === 1);
}

// =====================================================================================================================
section('4. The validator checks every fixed entry');
{
  const core = makeCore(3, [5, 4, 3]);
  const plain = problemOfCore(core);
  const baseline = buildBaseline(plain, 7);
  if (!baseline.ok) throw new Error('fixture');
  const entries = baseline.entries;
  const lockedCore = { ...core, fixedEntries: [entries[0], entries[10]].map((e) => ({ assignmentId: e!.assignmentId, dayOfWeek: e!.dayOfWeek, periodNumber: e!.periodNumber })) } as unknown as SolverProblemCore;
  const locked = problemOfCore(lockedCore);
  check('a timetable that contains the fixed entries is valid', validateEntries(locked, entries).valid);
  const moved = entries.map((e, i) => (i === 0 ? { ...e, periodNumber: e.periodNumber === 6 ? 5 : e.periodNumber + 1 } : e));
  const v = validateEntries(locked, moved);
  check('a fixed lesson moved to another period is reported: FIXED_ENTRY_VIOLATED (it may still be valid otherwise)', !v.valid && v.problems.some((p) => p.code === 'FIXED_ENTRY_VIOLATED'));
  const otherDay = entries.map((e, i) => (i === 10 ? { ...e, dayOfWeek: (e.dayOfWeek === 'MONDAY' ? 'TUESDAY' : 'MONDAY') as TimetableEntryRow['dayOfWeek'] } : e));
  check('a fixed lesson moved to another DAY is reported', validateEntries(locked, otherDay).problems.some((p) => p.code === 'FIXED_ENTRY_VIOLATED'));
  check('a fixed lesson that is missing entirely is reported (with the usual count errors too)', (() => { const r = validateEntries(locked, entries.slice(1)); return !r.valid && r.problems.some((p) => p.code === 'FIXED_ENTRY_VIOLATED'); })());
  check('the violation names the assignment, day and period', (() => { const p = v.problems.find((x) => x.code === 'FIXED_ENTRY_VIOLATED')!; return p.assignmentId === entries[0]!.assignmentId && p.dayOfWeek === entries[0]!.dayOfWeek && p.periodNumber === entries[0]!.periodNumber; })());
  check('WITHOUT fixed entries the same moved timetable gives exactly the result it always gave (valid or not on its own merits, no FIXED_ENTRY_VIOLATED)', !validateEntries(plain, moved).problems.some((p) => p.code === 'FIXED_ENTRY_VIOLATED'));
  check('without fixed entries a valid timetable is valid (unchanged behaviour)', validateEntries(plain, entries).valid);
  const metricsEqual = JSON.stringify(evaluateMetrics(locked, entries)) === JSON.stringify(evaluateMetrics(plain, entries));
  check('the metrics do not depend on fixedEntries (WEIGHTS_V1 and the evaluator are unchanged)', metricsEqual);
}

// =====================================================================================================================
section('5. The outcome matrix');
{
  const diag = (stoppedBy = 'TIME_LIMIT'): SolverDiagnostics => ({ objectiveValue: null, bestObjectiveBound: null, wallSeconds: 1, numWorkers: 1, seed: 1, ortoolsVersion: 'x', numBooleans: null, numConstraints: null, conflicts: null, branches: null, stoppedBy: stoppedBy as SolverDiagnostics['stoppedBy'], messages: [] });
  const plain = problemOfCore(makeCore(3, [5, 4, 3]));
  const b = buildBaseline(plain, 3);
  if (!b.ok) throw new Error('fixture');
  const base = b.entries;
  const sol = (status: 'OPTIMAL' | 'FEASIBLE'): SolverAttempt => ({ kind: 'SOLUTION', status, entries: base, diagnostics: diag('OPTIMAL') });
  const unknown: SolverAttempt = { kind: 'NO_SOLUTION', diagnostics: diag() };
  const killed: SolverAttempt = { kind: 'KILLED_BY_WATCHDOG' };
  const infeasible: SolverAttempt = { kind: 'INFEASIBLE', diagnostics: diag('INFEASIBLE') };
  const faults: SolverAttempt[] = [
    { kind: 'FAULT', code: 'SOLVER_INVALID_OUTPUT', message: 'm', problems: [], diagnostics: null }, { kind: 'FAULT', code: 'SOLVER_MODEL_INVALID', message: 'm', problems: [], diagnostics: null },
    { kind: 'FAULT', code: 'SOLVER_INPUT_REJECTED', message: 'm', problems: [], diagnostics: null }, { kind: 'PROCESS_FAULT', code: 'SOLVER_UNAVAILABLE', message: 'm' }, { kind: 'PROCESS_FAULT', code: 'SOLVER_CRASHED', message: 'm' },
  ];
  // ---- WITH a baseline (the whole no-lock matrix, exactly as before)
  for (const status of ['OPTIMAL', 'FEASIBLE'] as const) {
    const o = decideOutcome(sol(status), base);
    check(`baseline present, CP-SAT ${status}: SUCCESS CP_SAT, optimal=${status === 'OPTIMAL'}`, o.kind === 'SUCCESS' && o.solutionSource === 'CP_SAT' && o.solverStatus === status && o.optimal === (status === 'OPTIMAL') && o.fallbackReason === null);
  }
  const u = decideOutcome(unknown, base);
  check('baseline present, UNKNOWN: SUCCESS with the BASELINE (NO_SOLUTION_WITHIN_BUDGET)', u.kind === 'SUCCESS' && u.solutionSource === 'BASELINE' && u.fallbackReason === 'NO_SOLUTION_WITHIN_BUDGET' && u.solverStatus === 'UNKNOWN');
  const k = decideOutcome(killed, base);
  check('baseline present, watchdog kill: SUCCESS with the BASELINE (KILLED_BY_WATCHDOG)', k.kind === 'SUCCESS' && k.solutionSource === 'BASELINE' && k.fallbackReason === 'KILLED_BY_WATCHDOG');
  const i = decideOutcome(infeasible, base);
  check('baseline present, INFEASIBLE: FAILURE INTERNAL_INCONSISTENCY (a valid baseline contradicts it)', i.kind === 'FAILURE' && i.code === 'INTERNAL_INCONSISTENCY');
  for (const f of faults) {
    const o = decideOutcome(f, base);
    check(`baseline present, ${f.kind === 'FAULT' ? f.code : (f as { code: string }).code}: FAILURE with that code, no fallback`, o.kind === 'FAILURE' && o.code === (f as { code: string }).code);
  }
  // ---- WITHOUT a baseline (locked generations only)
  const s0 = decideOutcome(sol('FEASIBLE'), null);
  check('no baseline, CP-SAT FEASIBLE: SUCCESS CP_SAT (the baseline is irrelevant)', s0.kind === 'SUCCESS' && s0.solutionSource === 'CP_SAT' && s0.entries.length === base.length);
  check('no baseline, CP-SAT OPTIMAL: SUCCESS CP_SAT optimal', (() => { const o = decideOutcome(sol('OPTIMAL'), null); return o.kind === 'SUCCESS' && o.optimal; })());
  const n1 = decideOutcome(unknown, null);
  check('no baseline, UNKNOWN: FAILURE NO_SOLUTION_WITH_LOCKS (not infeasible, not a success)', n1.kind === 'FAILURE' && n1.code === 'NO_SOLUTION_WITH_LOCKS' && /does not prove/i.test(n1.message));
  const n2 = decideOutcome(killed, null);
  check('no baseline, watchdog kill: FAILURE NO_SOLUTION_WITH_LOCKS', n2.kind === 'FAILURE' && n2.code === 'NO_SOLUTION_WITH_LOCKS');
  const n3 = decideOutcome(infeasible, null);
  check('no baseline, INFEASIBLE: FAILURE INFEASIBLE_HARD_CONSTRAINTS (proven), and it is NOT NO_SOLUTION_WITH_LOCKS', n3.kind === 'FAILURE' && n3.code === 'INFEASIBLE_HARD_CONSTRAINTS');
  check('UNKNOWN and INFEASIBLE are never collapsed: they give different codes without a baseline', n1.kind === 'FAILURE' && n3.kind === 'FAILURE' && n1.code !== n3.code);
  for (const f of faults) {
    const o = decideOutcome(f, null);
    check(`no baseline, ${(f as { code: string }).code}: unchanged failure semantics`, o.kind === 'FAILURE' && o.code === (f as { code: string }).code);
  }
  check('both new codes are in the closed failure-code list; the list has 16 distinct codes (15 through Phase 7E + DRAFT_LIMIT_REACHED from Phase 7F-0)', (FAILURE_CODES as readonly string[]).includes('LOCKS_INVALID') && (FAILURE_CODES as readonly string[]).includes('NO_SOLUTION_WITH_LOCKS') && FAILURE_CODES.length === 16 && new Set(FAILURE_CODES).size === 16);
  check('every failure outcome carries a code from the closed list', [unknown, killed, infeasible, ...faults].every((a) => { const o = decideOutcome(a, null); return o.kind === 'FAILURE' && (FAILURE_CODES as readonly string[]).includes(o.code); }));
}

// =====================================================================================================================
section('6. The lock-aware baseline');
{
  const rng = ((seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; })(20261009);
  let attemptsTotal = 0;
  const stats: string[] = [];
  for (const g of GOLDEN_CORES.filter((x) => x.name !== 'single-1x[1]')) {
    const core = g.core();
    const plain = problemOfCore(core);
    const solved = buildBaseline(plain, 5);
    if (!solved.ok) continue;
    let ok = 0;
    let noPlacement = 0;
    let bad = '';
    const total = 60;
    for (let n = 0; n < total && !bad; n++) {
      const fraction = n === 0 ? 1 : n === 1 ? 0 : rng() * 0.8; // always: everything locked, nothing locked, and random shares
      const chosen = solved.entries.filter(() => rng() < fraction);
      const fixed = chosen.map((e) => ({ assignmentId: e.assignmentId, dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber }));
      const locked = problemOfCore({ ...core, fixedEntries: fixed } as unknown as SolverProblemCore);
      const seed = 1 + Math.floor(rng() * 1000);
      const r = buildBaselineWithFixed(locked, seed);
      if (r.ok) {
        attemptsTotal += r.attempts;
        const v = validateEntries(locked, r.entries);
        if (!v.valid) bad = `${g.name}: an OK result is invalid (${JSON.stringify(v.problems.slice(0, 2))})`;
        else if (JSON.stringify(buildBaselineWithFixed(locked, seed)) !== JSON.stringify(r)) bad = `${g.name}: not deterministic`;
        else ok++;
      } else if (r.reason === 'NO_PLACEMENT_FOUND') noPlacement++;
      else bad = `${g.name}: unexpected ${r.reason}`;
    }
    stats.push(`${g.name}: ${ok}/${total} placed, ${noPlacement} no-placement`);
    check(`${g.name}: ${total} random lock sets taken from a valid timetable: every OK result is valid, preserves every lock and is deterministic; none is wrongly reported`, bad === '', bad);
    check(`${g.name}: a solution exists for every one of these lock sets, and the bounded heuristic found one for at least 80% of them (${ok}/${total})`, ok >= total * 0.8, `${ok}/${total}`);
  }
  console.log(`  info: ${stats.join(' | ')}`);

  const core = makeCore(3, [5, 4, 3]);
  const plain = problemOfCore(core);
  const solved = buildBaseline(plain, 2);
  if (!solved.ok) throw new Error('fixture');
  const allFixed = solved.entries.map((e) => ({ assignmentId: e.assignmentId, dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber }));
  const everything = buildBaselineWithFixed(problemOfCore({ ...core, fixedEntries: allFixed } as unknown as SolverProblemCore), 9);
  check('every lesson locked: the result is exactly the locked timetable', everything.ok && JSON.stringify(everything.entries) === JSON.stringify(solved.entries));
  const clash = buildBaselineWithFixed(problemOfCore({ ...core, fixedEntries: [{ assignmentId: 'asg-1-1', dayOfWeek: 'MONDAY', periodNumber: 1 }, { assignmentId: 'asg-1-2', dayOfWeek: 'MONDAY', periodNumber: 1 }] } as unknown as SolverProblemCore), 1);
  check('contradictory locks (two lessons of one section in a slot, passed directly): no baseline, never an invalid one', !clash.ok && clash.reason === 'NO_PLACEMENT_FOUND');
  const tooMany = buildBaselineWithFixed(problemOfCore({ ...core, fixedEntries: Array.from({ length: 6 }, (_, k) => ({ assignmentId: 'asg-1-1', dayOfWeek: DAYS[Math.floor(k / 3)]!, periodNumber: (k % 3) + 1 })) } as unknown as SolverProblemCore), 1);
  check('more locks than an assignment has periods (passed directly): no baseline', !tooMany.ok);

  // an instance that is infeasible ONLY because of the locks: T1 teaches 20 lessons in section Y and 10 in section X (30 = its capacity)
  const infCore: SolverProblemCore = {
    contractVersion: '1.0',
    grid: { days: DAYS.slice(0, 5).map((dayOfWeek, index) => ({ index, dayOfWeek })), periods: Array.from({ length: 6 }, (_, k) => ({ periodNumber: k + 1, continuesIntoNext: false })), maxTeacherPeriodsPerWeek: 32 },
    sections: [{ id: 'X' }, { id: 'Y' }],
    teachers: ['T1', 'T2', 'T3'].map((id) => ({ id, weeklyCapacity: 30 })),
    assignments: [
      { id: 'xA', sectionId: 'X', subjectId: 'sA', subjectRequirementId: 'rA', teacherId: 'T1', periodsPerWeek: 10 },
      { id: 'xB', sectionId: 'X', subjectId: 'sB', subjectRequirementId: 'rB', teacherId: 'T2', periodsPerWeek: 10 },
      { id: 'xC', sectionId: 'X', subjectId: 'sC', subjectRequirementId: 'rC', teacherId: 'T3', periodsPerWeek: 10 },
      { id: 'yD', sectionId: 'Y', subjectId: 'sD', subjectRequirementId: 'rD', teacherId: 'T1', periodsPerWeek: 20 },
    ],
    fixedEntries: [],
  } as unknown as SolverProblemCore;
  const slots: Array<[string, number]> = [];
  for (const d of DAYS.slice(0, 4)) for (let k = 1; k <= 6; k++) slots.push([d, k]);
  const yLocks = slots.slice(0, 20).map(([d, k]) => ({ assignmentId: 'yD', dayOfWeek: d, periodNumber: k }));
  const feasibleLocks = problemOfCore({ ...infCore, fixedEntries: yLocks } as unknown as SolverProblemCore);
  const feasible = buildBaselineWithFixed(feasibleLocks, 4);
  check('(fixture) T1\'s 20 lessons in Y locked: still feasible, and a valid baseline is found', feasible.ok && validateEntries(feasibleLocks, feasible.entries).valid);
  const infLocks = problemOfCore({ ...infCore, fixedEntries: [...yLocks, { assignmentId: 'xB', dayOfWeek: 'FRIDAY', periodNumber: 1 }] } as unknown as SolverProblemCore);
  const infeasibleResult = buildBaselineWithFixed(infLocks, 4);
  check('(fixture) one more lock makes it infeasible (T1 needs 10 free slots in X, only 9 remain): NO_PLACEMENT_FOUND, never an invalid timetable', !infeasibleResult.ok && infeasibleResult.reason === 'NO_PLACEMENT_FOUND');
  console.log(`  info: average attempts per successful lock-aware baseline: ${(attemptsTotal / Math.max(1, 1)).toFixed(0)} total attempts`);
}

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
