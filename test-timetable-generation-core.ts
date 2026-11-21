// Pure tests for the Module 11 core (contracts, normalizer, hash, baseline, validator, outcome, metrics, time policy).
// NO database, NO server, NO Python. Permanent regression test: run with   npx tsx test-timetable-generation-core.ts
import { type FrozenLock } from './src/modules/timetable-generation/timetable-generation.locks.js';
import { readFileSync } from 'node:fs';
import {
  CONTRACT_VERSION,
  FAILURE_CODES,
  TERM_NAMES,
  WEIGHTS_V1,
  solverInputSchema,
  solverOutputSchema,
  type SolverOutput,
  type TimetableEntryRow,
} from './src/modules/timetable-generation/timetable-generation.contracts.js';
import { canonicalJson, hashJson } from './src/modules/timetable-generation/timetable-generation.hash.js';
import {
  ISSUE_CODES,
  buildSolverInput,
  normalizeProblem,
  requirementAppliesToSection,
  type GenerationSnapshot,
  type IssueCode,
  type NormalizedProblem,
} from './src/modules/timetable-generation/timetable-generation.normalizer.js';
import { buildBaseline, findCapacityViolations } from './src/modules/timetable-generation/timetable-generation.baseline.js';
import { interpretSolverOutput, validateEntries } from './src/modules/timetable-generation/timetable-generation.validator.js';
import { decideOutcome, type SolverAttempt } from './src/modules/timetable-generation/timetable-generation.outcome.js';
import { evaluateMetrics } from './src/modules/timetable-generation/timetable-generation.metrics.js';
import {
  DEFAULT_TIME_POLICY,
  DETERMINISTIC_TIME_RATIO,
  parseTimePolicy,
  resolveDeterministicTimeLimit,
  resolveKillAfterSeconds,
  resolveTimeLimitSeconds,
} from './src/modules/timetable-generation/timetable-generation.time-policy.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn: () => unknown): boolean => { try { fn(); return false; } catch { return true; } };

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
const SCHOOL = 'school1';
const DAYS5 = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
const DAYS6 = [...DAYS5, 'SATURDAY'];
const WEEK = [...DAYS6, 'SUNDAY'];
const schedule = (days: string[], ppd: number) => ({
  periodsPerDay: ppd, workingDays: days, periods: Array.from({ length: ppd }, (_, i) => ({ periodNumber: i + 1 })),
});

type Snap = GenerationSnapshot;
const teacher = (id: string, over: Partial<Snap['teachers'][number]> = {}) => ({ id, schoolId: SCHOOL, name: `Teacher ${id}`, isActive: true, ...over });
const link = (teacherId: string, subjectId: string, gradeIds: string[]) => ({ teacherId, subjectId, gradeIds });
const sec = (id: string, gradeId = 'g8', streamId: string | null = null) => ({ id, gradeId, streamId, name: id, code: id });
const req = (id: string, gradeId: string, subjectId: string, periodsPerWeek: number, streamId: string | null = null) => ({ id, gradeId, streamId, subjectId, periodsPerWeek });
const asg = (id: string, sectionId: string, subjectRequirementId: string, teacherId: string) => ({ id, sectionId, subjectRequirementId, teacherId });

/** Grade 8, sections 8A/8B/8C, Math 5 + Science 4 per section, 5 days x 6 periods (W = 30). */
function snapshot(over: Partial<Snap> = {}): Snap {
  const sections = [sec('8A'), sec('8B'), sec('8C')];
  const requirements = [req('r-math', 'g8', 'math', 5), req('r-sci', 'g8', 'sci', 4)];
  const assignments = sections.flatMap((s) => [asg(`a-${s.id}-math`, s.id, 'r-math', 't-math'), asg(`a-${s.id}-sci`, s.id, 'r-sci', 't-sci')]);
  return {
    schoolId: SCHOOL,
    academicYear: { id: 'ay1', name: '2030', status: 'DRAFT' },
    schedule: schedule(DAYS5, 6),
    grades: [{ id: 'g8', name: 'Grade 8', displayOrder: 1 }],
    streams: [],
    sections,
    subjects: [
      { id: 'math', name: 'Mathematics', code: 'MATH', schoolId: SCHOOL },
      { id: 'sci', name: 'Science', code: 'SCI', schoolId: SCHOOL },
    ],
    requirements,
    assignments,
    teachers: [teacher('t-math'), teacher('t-sci')],
    teacherSubjects: [link('t-math', 'math', ['g8']), link('t-sci', 'sci', ['g8'])],
    timingEvents: [],
    ...over,
  };
}

function mustNormalize(s: Snap): NormalizedProblem {
  const r = normalizeProblem(s);
  if (!r.ok) throw new Error(`normalize failed: ${r.issues.map((i) => i.code).join(',')}`);
  return r.problem;
}
const seenCodes = new Set<IssueCode>();
const codes = (s: Snap): IssueCode[] => { const r = normalizeProblem(s); const list = r.ok ? [] : r.issues.map((i) => i.code); list.forEach((c) => seenCodes.add(c)); return list; };
const has = (s: Snap, code: IssueCode): boolean => codes(s).includes(code);

/** A problem built directly from [id, section, teacher, periods] tuples (bypasses the normalizer on purpose). */
type Tuple = [string, string, string, number];
function coreProblem(D: number, K: number, continues: boolean[], tuples: Tuple[], teacherCap?: number): NormalizedProblem {
  const W = D * K;
  const cap = teacherCap ?? Math.min(32, W);
  const sections = [...new Set(tuples.map((t) => t[1]))].sort();
  const teachers = [...new Set(tuples.map((t) => t[2]))].sort();
  const core = {
    contractVersion: CONTRACT_VERSION,
    grid: {
      days: WEEK.slice(0, D).map((dayOfWeek, index) => ({ index, dayOfWeek: dayOfWeek as 'MONDAY' })),
      periods: continues.map((c, i) => ({ periodNumber: i + 1, continuesIntoNext: c })),
      maxTeacherPeriodsPerWeek: 32,
    },
    sections: sections.map((id) => ({ id })),
    teachers: teachers.map((id) => ({ id, weeklyCapacity: cap })),
    assignments: tuples.map(([id, s, t, p], i) => ({ id, sectionId: s, subjectId: `subj-${i}`, subjectRequirementId: `req-${i}`, teacherId: t, periodsPerWeek: p })),
    fixedEntries: [],
  };
  return {
    schoolId: SCHOOL, academicYear: { id: 'ay', name: 'ay' }, core,
    derived: {
      dayCount: D, periodsPerDay: K, weeklySlots: W, teacherCapacity: cap, sectionCount: sections.length, teacherCount: teachers.length,
      assignmentCount: tuples.length, expectedEntryCount: tuples.reduce((n, t) => n + t[3], 0),
    },
    inputHash: hashJson(core),
  };
}
const allContinue = (K: number): boolean[] => Array.from({ length: K }, (_, i) => i < K - 1);
/** A hand-placed entry: day is 0-based, period is 1-based. */
function entry(problem: NormalizedProblem, assignmentId: string, day: number, period: number): TimetableEntryRow {
  const a = problem.core.assignments.find((x) => x.id === assignmentId)!;
  return { assignmentId, sectionId: a.sectionId, subjectId: a.subjectId, teacherId: a.teacherId, dayOfWeek: problem.core.grid.days[day]!.dayOfWeek, periodNumber: period };
}

// ===========================================================================
section('1. Time policy');
{
  const t = (n: number): number => resolveTimeLimitSeconds(n);
  check('0 sections -> 10 s', t(0) === 10);
  check('1 section -> 10 s', t(1) === 10);
  check('10 sections -> 10 s (boundary)', t(10) === 10);
  check('11 sections -> 60 s (boundary)', t(11) === 60);
  check('50 sections -> 60 s (boundary)', t(50) === 60);
  check('51 sections -> 120 s (boundary)', t(51) === 120);
  check('100 sections -> 120 s (boundary)', t(100) === 120);
  check('101 sections -> 180 s (boundary)', t(101) === 180);
  check('5000 sections -> 180 s', t(5000) === 180);
  check('default policy: max 300, kill grace 20', DEFAULT_TIME_POLICY.max === 300 && DEFAULT_TIME_POLICY.killGraceSeconds === 20);
  check('default policy object is frozen', Object.isFrozen(DEFAULT_TIME_POLICY));
  check('non-integer / negative section count throws', throws(() => t(1.5)) && throws(() => t(-1)));
  check('a configured budget above max is clamped to max', resolveTimeLimitSeconds(5, { ...DEFAULT_TIME_POLICY, le10: 400 }) === 300);
  check('kill timer = budget + grace', resolveKillAfterSeconds(120) === 140 && resolveKillAfterSeconds(10, { ...DEFAULT_TIME_POLICY, killGraceSeconds: 5 }) === 15);

  check('parseTimePolicy({}) equals the defaults', same(parseTimePolicy({}), DEFAULT_TIME_POLICY));
  const custom = parseTimePolicy({ SOLVER_TIME_LIMIT_LE10: '15', SOLVER_TIME_LIMIT_LE50: '90', SOLVER_TIME_LIMIT_LE100: '150', SOLVER_TIME_LIMIT_GT100: '240', SOLVER_TIME_LIMIT_MAX: '280', SOLVER_KILL_GRACE_SECONDS: '30' });
  check('parseTimePolicy reads every key', same(custom, { le10: 15, le50: 90, le100: 150, gt100: 240, max: 280, killGraceSeconds: 30 }));
  check('blank env values fall back to defaults', same(parseTimePolicy({ SOLVER_TIME_LIMIT_LE10: '  ' }), DEFAULT_TIME_POLICY));
  for (const bad of ['abc', '0', '-5', '1.5', '10s', '1e3']) {
    check(`malformed value "${bad}" is rejected`, throws(() => parseTimePolicy({ SOLVER_TIME_LIMIT_LE50: bad })));
  }
  check('a budget above the configured max is rejected', throws(() => parseTimePolicy({ SOLVER_TIME_LIMIT_GT100: '400' })));
  check('a max above the contract ceiling (3600) is rejected', throws(() => parseTimePolicy({ SOLVER_TIME_LIMIT_MAX: '4000' })));
  check('raising max allows a larger budget', parseTimePolicy({ SOLVER_TIME_LIMIT_MAX: '600', SOLVER_TIME_LIMIT_GT100: '400' }).gt100 === 400);

  check('deterministic limit = round(budget * ratio), at least 1', resolveDeterministicTimeLimit(120) === Math.round(120 * DETERMINISTIC_TIME_RATIO) && resolveDeterministicTimeLimit(1) === 1);
}

// ===========================================================================
section('2. Canonical JSON and hashing');
{
  check('object key order does not matter', canonicalJson({ b: 1, a: { d: 2, c: 3 } }) === canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  check('array order matters', canonicalJson([1, 2]) !== canonicalJson([2, 1]));
  check('undefined members are skipped, like JSON.stringify', canonicalJson({ a: 1, b: undefined }) === canonicalJson({ a: 1 }));
  check('non-finite numbers are rejected', throws(() => canonicalJson({ a: Number.NaN })) && throws(() => canonicalJson([Infinity])));
  check('hashJson is a 64-char hex sha256, stable', /^[0-9a-f]{64}$/.test(hashJson({ x: 1 })) && hashJson({ x: 1 }) === hashJson({ x: 1 }));
  check('different values hash differently', hashJson({ x: 1 }) !== hashJson({ x: 2 }));
}

// ===========================================================================
section('3. Contracts');
{
  const problem = mustNormalize(snapshot());
  const options = { timeLimitSeconds: 10, seed: 42, numWorkers: 4, reproducible: false, deterministicTimeLimit: null };
  const input = buildSolverInput(problem, 'req-1', options);
  check('WEIGHTS_V1 is frozen with the approved values', Object.isFrozen(WEIGHTS_V1) && WEIGHTS_V1.teacherRun3 === 3 && WEIGHTS_V1.teacherRun4Plus === 8 && WEIGHTS_V1.subjectSameDayExcess === 5 && WEIGHTS_V1.sectionHoles === 4 && WEIGHTS_V1.dailyLoadExcess === 2);
  check('there are exactly the five approved objective terms', same([...TERM_NAMES], ['teacherRun3', 'teacherRun4Plus', 'subjectSameDayExcess', 'sectionHoles', 'dailyLoadExcess']));
  check('a built SolverInput satisfies the input schema', solverInputSchema.safeParse(input).success);
  check('SolverInput carries WEIGHTS_V1 and its version', same(input.weights, WEIGHTS_V1) && input.weightsVersion === 'V1');
  check('SolverInput contains ids and integers only (no names)', !JSON.stringify(input).includes('Teacher t-') && !JSON.stringify(input).includes('Mathematics'));
  check('fixedEntries is empty in V1', input.fixedEntries.length === 0);
  check('unknown top-level key is rejected (strict)', !solverInputSchema.safeParse({ ...input, extra: 1 }).success);
  check('unknown nested key is rejected (strict)', !solverInputSchema.safeParse({ ...input, sections: [{ id: 's', name: 'x' }] }).success);
  check('negative seed rejected', !solverInputSchema.safeParse({ ...input, options: { ...options, seed: -1 } }).success);
  check('time limit 0 rejected, 3601 rejected', !solverInputSchema.safeParse({ ...input, options: { ...options, timeLimitSeconds: 0 } }).success && !solverInputSchema.safeParse({ ...input, options: { ...options, timeLimitSeconds: 3601 } }).success);
  check('reproducible with a deterministic limit is accepted', solverInputSchema.safeParse({ ...input, options: { ...options, reproducible: true, deterministicTimeLimit: 54 } }).success);
  check('wrong contract version rejected', !solverInputSchema.safeParse({ ...input, contractVersion: '2.0' }).success);
  check('zero assignments rejected by the schema', !solverInputSchema.safeParse({ ...input, assignments: [] }).success);

  const goodOutput: SolverOutput = {
    contractVersion: CONTRACT_VERSION, requestId: 'req-1', status: 'UNKNOWN', entries: [],
    diagnostics: { objectiveValue: null, bestObjectiveBound: null, wallSeconds: 1, numWorkers: 4, seed: 42, ortoolsVersion: '9.15.6755', numBooleans: null, numConstraints: null, conflicts: null, branches: null, stoppedBy: 'TIME_LIMIT', messages: [] },
  };
  check('a well-formed output parses', solverOutputSchema.safeParse(goodOutput).success);
  check('unknown status rejected', !solverOutputSchema.safeParse({ ...goodOutput, status: 'DONE' }).success);
  check('missing diagnostics rejected', !solverOutputSchema.safeParse({ ...goodOutput, diagnostics: undefined }).success);
  check('extra diagnostics key rejected', !solverOutputSchema.safeParse({ ...goodOutput, diagnostics: { ...goodOutput.diagnostics, foo: 1 } }).success);
  check('failure codes are unique', new Set(FAILURE_CODES).size === FAILURE_CODES.length);
}

// ===========================================================================
section('4. Normalizer: happy path, demand expansion, ordering');
{
  const p = mustNormalize(snapshot());
  check('8A/8B/8C x (Math 5 + Science 4) -> 6 assignments', p.derived.assignmentCount === 6);
  check('demand is expanded per section: 3 x (5+4) = 27 entries (NOT 9)', p.derived.expectedEntryCount === 27);
  check('3 sections and 2 teachers in the problem', p.derived.sectionCount === 3 && p.derived.teacherCount === 2);
  check('5 days x 6 periods = 30 weekly slots; teacher capacity min(32, 30) = 30', p.derived.weeklySlots === 30 && p.derived.teacherCapacity === 30);
  check('every teacher in the solver input carries weeklyCapacity 30', p.core.teachers.every((t) => t.weeklyCapacity === 30));
  const p48 = mustNormalize(snapshot({ schedule: schedule(DAYS6, 8) }));
  check('6 x 8 = 48 slots; teacher capacity = 32', p48.derived.weeklySlots === 48 && p48.derived.teacherCapacity === 32);
  check('days are indexed in week order', same(p.core.grid.days.map((d) => d.dayOfWeek), DAYS5) && p.core.grid.days.every((d, i) => d.index === i));
  const shuffledDays = mustNormalize(snapshot({ schedule: schedule([...DAYS5].reverse(), 6) }));
  check('working days given in any order are sorted Monday..', same(shuffledDays.core.grid.days.map((d) => d.dayOfWeek), DAYS5));
  check('arrays are canonically sorted by id', same(p.core.assignments.map((a) => a.id), [...p.core.assignments.map((a) => a.id)].sort()) && same(p.core.sections.map((s) => s.id), ['8A', '8B', '8C']));

  const noEvents = mustNormalize(snapshot());
  check('no timing events: every period continues except the last', same(noEvents.core.grid.periods.map((x) => x.continuesIntoNext), [true, true, true, true, true, false]));
  const lunch = mustNormalize(snapshot({ timingEvents: [{ afterPeriodNumber: 3 }] }));
  check('an event after period 3 ends the run there', same(lunch.core.grid.periods.map((x) => x.continuesIntoNext), [true, true, false, true, true, false]));
  const edge = mustNormalize(snapshot({ timingEvents: [{ afterPeriodNumber: 0 }, { afterPeriodNumber: 6 }] }));
  check('events before the first / after the last period break nothing', same(edge.core.grid.periods.map((x) => x.continuesIntoNext), [true, true, true, true, true, false]));
  const several = mustNormalize(snapshot({ timingEvents: [{ afterPeriodNumber: 2 }, { afterPeriodNumber: 2 }, { afterPeriodNumber: 4 }] }));
  check('several events (even in the same gap) are handled', same(several.core.grid.periods.map((x) => x.continuesIntoNext), [true, false, true, false, true, false]));

}
{
  // a section with no applicable requirement is legal and simply absent
  const base = snapshot();
  const extra = snapshot({ sections: [...base.sections, sec('9A', 'g9')], grades: [...base.grades, { id: 'g9', name: 'Grade 9', displayOrder: 2 }] });
  const r = normalizeProblem(extra);
  check('a section with no applicable requirements is not an error and is excluded', r.ok && r.problem.core.sections.length === 3 && !r.problem.core.sections.some((s) => s.id === '9A'));
}

section('5. Normalizer: input hash');
{
  const base = mustNormalize(snapshot());
  const s = snapshot();
  const shuffled = snapshot({
    sections: [...s.sections].reverse(), requirements: [...s.requirements].reverse(), assignments: [...s.assignments].reverse(),
    teachers: [...s.teachers].reverse(), teacherSubjects: [...s.teacherSubjects].reverse(), schedule: schedule([...DAYS5].reverse(), 6),
  });
  check('hash is independent of input array order', mustNormalize(shuffled).inputHash === base.inputHash);
  check('hash is a sha256 hex string', /^[0-9a-f]{64}$/.test(base.inputHash));
  check('hash equals hashJson of the problem core', base.inputHash === hashJson(base.core));
  const a = buildSolverInput(base, 'req-A', { timeLimitSeconds: 10, seed: 1, numWorkers: 4, reproducible: false, deterministicTimeLimit: null });
  const b = buildSolverInput(base, 'req-B', { timeLimitSeconds: 99, seed: 7, numWorkers: 8, reproducible: true, deterministicTimeLimit: 40 });
  check('hash is unaffected by requestId and run options', base.inputHash === hashJson({ contractVersion: a.contractVersion, grid: a.grid, sections: a.sections, teachers: a.teachers, assignments: a.assignments, fixedEntries: a.fixedEntries }) && same(a.assignments, b.assignments));

  const swapTeacher = snapshot({ teachers: [...s.teachers, teacher('t-math2')], teacherSubjects: [...s.teacherSubjects, link('t-math2', 'math', ['g8'])], assignments: s.assignments.map((x) => (x.id === 'a-8A-math' ? { ...x, teacherId: 't-math2' } : x)) });
  check('changing an assignment teacher changes the hash', mustNormalize(swapTeacher).inputHash !== base.inputHash);
  check('changing periodsPerWeek changes the hash', mustNormalize(snapshot({ requirements: [req('r-math', 'g8', 'math', 4), req('r-sci', 'g8', 'sci', 4)] })).inputHash !== base.inputHash);
  check('adding a timing event changes the hash', mustNormalize(snapshot({ timingEvents: [{ afterPeriodNumber: 3 }] })).inputHash !== base.inputHash);
  check('changing the working days changes the hash', mustNormalize(snapshot({ schedule: schedule(DAYS6, 6) })).inputHash !== base.inputHash);
  check('changing periodsPerDay changes the hash', mustNormalize(snapshot({ schedule: schedule(DAYS5, 7) })).inputHash !== base.inputHash);
  check('renaming a teacher (irrelevant to the problem) does NOT change the hash', mustNormalize(snapshot({ teachers: s.teachers.map((t) => ({ ...t, name: `Renamed ${t.id}` })) })).inputHash === base.inputHash);
  check('the same input twice gives the same hash', mustNormalize(snapshot()).inputHash === base.inputHash);
}

section('6. Normalizer: every rejection');
{
  const s = snapshot();
  check('YEAR_NOT_DRAFT: ACTIVE', has(snapshot({ academicYear: { id: 'ay1', name: 'x', status: 'ACTIVE' } }), 'YEAR_NOT_DRAFT'));
  check('YEAR_NOT_DRAFT: COMPLETED', has(snapshot({ academicYear: { id: 'ay1', name: 'x', status: 'COMPLETED' } }), 'YEAR_NOT_DRAFT'));
  check('SCHEDULE_MISSING', has(snapshot({ schedule: null }), 'SCHEDULE_MISSING'));
  check('NO_WORKING_DAYS', has(snapshot({ schedule: schedule([], 6) }), 'NO_WORKING_DAYS'));
  check('INVALID_WORKING_DAY', has(snapshot({ schedule: schedule(['MONDAY', 'FUNDAY'], 6) }), 'INVALID_WORKING_DAY'));
  check('PERIODS_INVALID: a gap in the numbering', has(snapshot({ schedule: { periodsPerDay: 3, workingDays: DAYS5, periods: [{ periodNumber: 1 }, { periodNumber: 2 }, { periodNumber: 4 }] } }), 'PERIODS_INVALID'));
  check('PERIODS_INVALID: count differs from periodsPerDay', has(snapshot({ schedule: { periodsPerDay: 6, workingDays: DAYS5, periods: [{ periodNumber: 1 }, { periodNumber: 2 }] } }), 'PERIODS_INVALID'));
  check('PERIODS_INVALID: no periods', has(snapshot({ schedule: { periodsPerDay: 0, workingDays: DAYS5, periods: [] } }), 'PERIODS_INVALID'));
  check('NO_ASSIGNMENTS (nothing to schedule: no explicit assignment and no requirement applies)', has(snapshot({ assignments: [], requirements: [] }), 'NO_ASSIGNMENTS'));
  check('no explicit assignments at all is NOT an issue while requirements exist (teachers are chosen automatically)', normalizeProblem(snapshot({ assignments: [] })).ok);
  check('DUPLICATE_ASSIGNMENT_ID', has(snapshot({ assignments: [...s.assignments, { ...s.assignments[0]! }] }), 'DUPLICATE_ASSIGNMENT_ID'));
  check('DUPLICATE_ASSIGNMENT: same section + requirement twice', has(snapshot({ assignments: [...s.assignments, asg('dup', '8A', 'r-math', 't-math')] }), 'DUPLICATE_ASSIGNMENT'));
  check('UNKNOWN_SECTION', has(snapshot({ assignments: [...s.assignments, asg('x', 'nope', 'r-math', 't-math')] }), 'UNKNOWN_SECTION'));
  check('UNKNOWN_REQUIREMENT', has(snapshot({ assignments: [...s.assignments, asg('x', '8A', 'nope', 't-math')] }), 'UNKNOWN_REQUIREMENT'));
  check('UNKNOWN_TEACHER', has(snapshot({ assignments: s.assignments.map((a) => (a.id === 'a-8A-math' ? { ...a, teacherId: 'ghost' } : a)) }), 'UNKNOWN_TEACHER'));
  check('UNKNOWN_SUBJECT', has(snapshot({ subjects: s.subjects.filter((x) => x.id !== 'math') }), 'UNKNOWN_SUBJECT'));
  check('INVALID_PERIODS_PER_WEEK: zero', has(snapshot({ requirements: [req('r-math', 'g8', 'math', 0), req('r-sci', 'g8', 'sci', 4)] }), 'INVALID_PERIODS_PER_WEEK'));
  check('INVALID_PERIODS_PER_WEEK: fraction', has(snapshot({ requirements: [req('r-math', 'g8', 'math', 2.5), req('r-sci', 'g8', 'sci', 4)] }), 'INVALID_PERIODS_PER_WEEK'));
  check('INVALID_PERIODS_PER_WEEK: more than the weekly slots', has(snapshot({ requirements: [req('r-math', 'g8', 'math', 31), req('r-sci', 'g8', 'sci', 4)] }), 'INVALID_PERIODS_PER_WEEK'));
  check('REQUIREMENT_SECTION_MISMATCH: different grade', has(snapshot({ grades: [...s.grades, { id: 'g9', name: 'G9', displayOrder: 2 }], sections: [...s.sections, sec('9A', 'g9')], assignments: [...s.assignments, asg('x', '9A', 'r-math', 't-math')] }), 'REQUIREMENT_SECTION_MISMATCH'));
  check('SUBJECT_CROSS_SCHOOL', has(snapshot({ subjects: s.subjects.map((x) => (x.id === 'math' ? { ...x, schoolId: 'other' } : x)) }), 'SUBJECT_CROSS_SCHOOL'));
  check('TEACHER_CROSS_SCHOOL', has(snapshot({ teachers: s.teachers.map((t) => (t.id === 't-math' ? { ...t, schoolId: 'other' } : t)) }), 'TEACHER_CROSS_SCHOOL'));
  check('TEACHER_INACTIVE', has(snapshot({ teachers: s.teachers.map((t) => (t.id === 't-math' ? { ...t, isActive: false } : t)) }), 'TEACHER_INACTIVE'));
  check('TEACHER_NOT_ELIGIBLE: no subject link', has(snapshot({ teacherSubjects: s.teacherSubjects.filter((l) => l.teacherId !== 't-math') }), 'TEACHER_NOT_ELIGIBLE'));
  check('TEACHER_NOT_ELIGIBLE: link without the grade', has(snapshot({ teacherSubjects: [link('t-math', 'math', ['g9']), link('t-sci', 'sci', ['g8'])] }), 'TEACHER_NOT_ELIGIBLE'));
  check('ALL_GRADES link without grade rows is eligible (no TEACHER_NOT_ELIGIBLE)', !has(snapshot({ teacherSubjects: [{ teacherId: 't-math', subjectId: 'math', gradeIds: [], allGrades: true }, link('t-sci', 'sci', ['g8'])] }), 'TEACHER_NOT_ELIGIBLE'));
  check('allGrades:false without grade rows stays TEACHER_NOT_ELIGIBLE', has(snapshot({ teacherSubjects: [{ teacherId: 't-math', subjectId: 'math', gradeIds: [], allGrades: false }, link('t-sci', 'sci', ['g8'])] }), 'TEACHER_NOT_ELIGIBLE'));
  check('ALL_GRADES for a different subject does not qualify the teacher', has(snapshot({ teacherSubjects: [{ teacherId: 't-math', subjectId: 'sci', gradeIds: [], allGrades: true }, link('t-sci', 'sci', ['g8'])] }), 'TEACHER_NOT_ELIGIBLE'));
  check('a (section, requirement) pair without an explicit teacher is no longer an issue: it is auto-assigned to the eligible teacher', (() => {
    const r = normalizeProblem(snapshot({ assignments: s.assignments.filter((a) => a.id !== 'a-8B-sci') }));
    const auto = r.ok ? r.problem.core.assignments.find((a) => a.id === 'auto:8B:r-sci') : undefined;
    return r.ok && auto?.teacherId === 't-sci' && r.problem.derived.assignmentCount === s.assignments.length;
  })());
  check('NO_ELIGIBLE_TEACHER: no explicit teacher and nobody eligible for the grade', has(snapshot({ assignments: s.assignments.filter((a) => a.id !== 'a-8B-sci'), teacherSubjects: [link('t-math', 'math', ['g8']), link('t-sci', 'sci', ['g9'])] }), 'NO_ELIGIBLE_TEACHER'));
  check('TEACHER_ALLOCATION_FAILED: eligible teacher exists but has no capacity left (W = 30)', has(snapshot({ requirements: [req('r-math', 'g8', 'math', 25), req('r-sci', 'g8', 'sci', 4)], sections: [sec('8A'), sec('8B')], assignments: [asg('x1', '8A', 'r-math', 't-math'), asg('x2', '8A', 'r-sci', 't-sci'), asg('x3', '8B', 'r-sci', 't-sci')] }), 'TEACHER_ALLOCATION_FAILED'));
  check('TEACHER_OVER_CAPACITY (W = 30): one teacher with 31 periods', has(snapshot({ requirements: [req('r-math', 'g8', 'math', 11), req('r-sci', 'g8', 'sci', 4)], assignments: s.assignments.map((a) => (a.subjectRequirementId === 'r-sci' ? { ...a, teacherId: 't-math' } : a)), teacherSubjects: [link('t-math', 'math', ['g8']), link('t-math', 'sci', ['g8'])] }), 'TEACHER_OVER_CAPACITY'));
  check('TEACHER_OVER_CAPACITY (W = 48): 35 periods exceeds 32', has(snapshot({ schedule: schedule(DAYS6, 8), requirements: [req('r-math', 'g8', 'math', 12), req('r-sci', 'g8', 'sci', 4)] }), 'TEACHER_OVER_CAPACITY'));
  check('exactly 32 periods for one teacher is allowed (section demand 32 <= 48)', normalizeProblem(snapshot({ schedule: schedule(DAYS6, 8), sections: [sec('8A')], assignments: [asg('a1', '8A', 'r-math', 't-math')], requirements: [req('r-math', 'g8', 'math', 32)] })).ok);
  check('SECTION_OVER_CAPACITY: demand 31 > 30 slots', has(snapshot({ sections: [sec('8A')], assignments: [asg('a1', '8A', 'r-math', 't-math'), asg('a2', '8A', 'r-sci', 't-sci')], requirements: [req('r-math', 'g8', 'math', 16), req('r-sci', 'g8', 'sci', 15)] }), 'SECTION_OVER_CAPACITY'));
  // ---- Phase 7E: the lock issue codes (locks are validated against the fresh configuration, after every other precondition) ----
  const lk = (over: Partial<FrozenLock> = {}): FrozenLock => ({ assignmentId: 'a-8A-math', sectionId: '8A', subjectRequirementId: 'r-math', teacherId: 't-math', dayOfWeek: 'MONDAY', periodNumber: 1, source: 'GENERATED', ...over });
  const lockCodes = (locks: FrozenLock[], snap: Snap = snapshot()): IssueCode[] => { const r = normalizeProblem(snap, { lockedEntries: locks }); const list = r.ok ? [] : r.issues.map((i) => i.code); list.forEach((c) => seenCodes.add(c)); return list; };
  check('LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND', lockCodes([lk({ assignmentId: 'ghost' })]).includes('LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND'));
  check('LOCKED_ENTRY_REQUIREMENT_MISMATCH', lockCodes([lk({ sectionId: '8B' })]).includes('LOCKED_ENTRY_REQUIREMENT_MISMATCH'));
  check('LOCKED_ENTRY_TEACHER_CHANGED', lockCodes([lk({ teacherId: 't-sci' })]).includes('LOCKED_ENTRY_TEACHER_CHANGED'));
  check('LOCKED_ENTRY_INVALID_DAY', lockCodes([lk({ dayOfWeek: 'SATURDAY' })]).includes('LOCKED_ENTRY_INVALID_DAY'));
  check('LOCKED_ENTRY_INVALID_PERIOD', lockCodes([lk({ periodNumber: 7 })]).includes('LOCKED_ENTRY_INVALID_PERIOD'));
  check('LOCKED_ENTRY_DUPLICATE', lockCodes([lk(), lk()]).includes('LOCKED_ENTRY_DUPLICATE'));
  check('LOCKED_ENTRY_SECTION_COLLISION', lockCodes([lk(), lk({ assignmentId: 'a-8A-sci', subjectRequirementId: 'r-sci', teacherId: 't-sci' })]).includes('LOCKED_ENTRY_SECTION_COLLISION'));
  check('LOCKED_ENTRY_TEACHER_COLLISION', lockCodes([lk(), lk({ assignmentId: 'a-8B-math', sectionId: '8B' })]).includes('LOCKED_ENTRY_TEACHER_COLLISION'));
  const sciLocks = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].map((d) => lk({ assignmentId: 'a-8A-sci', subjectRequirementId: 'r-sci', teacherId: 't-sci', dayOfWeek: d as FrozenLock['dayOfWeek'] }));
  check('LOCKED_ENTRY_EXCEEDS_REQUIREMENT (5 locks, 4 periods)', lockCodes(sciLocks).includes('LOCKED_ENTRY_EXCEEDS_REQUIREMENT'));
  const manyMath: FrozenLock[] = [];
  for (const d of ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'] as const) for (let k = 1; k <= 6; k++) manyMath.push(lk({ dayOfWeek: d, periodNumber: k }));
  manyMath.push(lk({ assignmentId: 'a-8B-math', sectionId: '8B' }));
  check('LOCKED_ENTRY_CAPACITY_EXCEEDED (31 locks of one teacher, capacity 30)', lockCodes(manyMath).includes('LOCKED_ENTRY_CAPACITY_EXCEEDED'));
  check('a configuration with another problem reports ONLY that problem (locks are not judged against an invalid configuration)', (() => { const c = lockCodes([lk({ assignmentId: 'ghost' })], snapshot({ assignments: [], requirements: [] })); return c.includes('NO_ASSIGNMENTS') && !c.some((x) => x.startsWith('LOCKED_ENTRY')); })());
  const withNo = normalizeProblem(snapshot(), { lockedEntries: [] });
  const withNone = normalizeProblem(snapshot());
  check('an empty lock list changes nothing: same problem and the same hash as no option at all', withNo.ok && withNone.ok && withNo.problem.inputHash === withNone.problem.inputHash && withNo.problem.core.fixedEntries.length === 0);
  const unexercised = ISSUE_CODES.filter((c) => !seenCodes.has(c));
  check('every one of the normalizer issue codes was triggered by a test above', unexercised.length === 0, `not exercised: ${unexercised.join(',')}`);
  check('ISSUE_CODES has no duplicates', new Set(ISSUE_CODES).size === ISSUE_CODES.length);

  const many = snapshot({ assignments: Array.from({ length: 250 }, (_, i) => asg(`bad${i}`, `ghost${i}`, 'r-math', 't-math')) });
  const r = normalizeProblem(many);
  check('issue list is capped at 200 and flagged truncated', !r.ok && r.issues.length === 200 && r.truncated);
  check('a clean input has no issues', normalizeProblem(snapshot()).ok);
  check('normalizer is deterministic', same(normalizeProblem(snapshot()), normalizeProblem(snapshot())));
}

section('7. Streams and grades (exact matching)');
{
  const stream = (id: string, gradeId = 'g11') => ({ id, gradeId, name: id, code: id });
  const s11: Snap = snapshot({
    grades: [{ id: 'g11', name: 'Grade 11', displayOrder: 1 }],
    streams: [stream('SCI'), stream('COM')],
    sections: [sec('11S1', 'g11', 'SCI'), sec('11S2', 'g11', 'SCI'), sec('11C1', 'g11', 'COM')],
    subjects: [
      { id: 'phys', name: 'Physics', code: 'PHY', schoolId: SCHOOL },
      { id: 'acct', name: 'Accountancy', code: 'ACC', schoolId: SCHOOL },
    ],
    requirements: [req('r-phys', 'g11', 'phys', 6, 'SCI'), req('r-acct', 'g11', 'acct', 6, 'COM')],
    teachers: [teacher('t-phys'), teacher('t-acct')],
    teacherSubjects: [link('t-phys', 'phys', ['g11']), link('t-acct', 'acct', ['g11'])],
    assignments: [asg('a1', '11S1', 'r-phys', 't-phys'), asg('a2', '11S2', 'r-phys', 't-phys'), asg('a3', '11C1', 'r-acct', 't-acct')],
  });
  const ok = normalizeProblem(s11);
  check('Science requirement applies to both Science sections, Commerce to Commerce only', ok.ok && ok.problem.derived.assignmentCount === 3 && ok.problem.derived.expectedEntryCount === 18);
  check('a Science requirement can never be assigned to a Commerce section', has({ ...s11, assignments: [...s11.assignments, asg('bad', '11C1', 'r-phys', 't-phys')] }, 'REQUIREMENT_SECTION_MISMATCH'));
  check('a Commerce requirement can never be assigned to a Science section', has({ ...s11, assignments: [...s11.assignments, asg('bad', '11S1', 'r-acct', 't-acct')] }, 'REQUIREMENT_SECTION_MISMATCH'));
  check('a Science section without an explicit Science teacher gets the eligible Science teacher automatically', (() => {
    const r = normalizeProblem({ ...s11, assignments: s11.assignments.filter((a) => a.id !== 'a2') });
    return r.ok && r.problem.core.assignments.find((a) => a.id === 'auto:11S2:r-phys')?.teacherId === 't-phys';
  })());
  check('...and the Commerce teacher is never chosen for a Science section (subject qualification)', (() => {
    const r = normalizeProblem({ ...s11, assignments: s11.assignments.filter((a) => a.id !== 'a2'), teacherSubjects: [link('t-acct', 'acct', ['g11']), link('t-acct', 'phys', [])] });
    return !r.ok && r.issues.some((i) => i.code === 'TEACHER_NOT_ELIGIBLE' || i.code === 'NO_ELIGIBLE_TEACHER');
  })());
  check('a non-streamed requirement does NOT apply to a streamed section (null != SCI)', !requirementAppliesToSection({ gradeId: 'g11', streamId: null }, { gradeId: 'g11', streamId: 'SCI' }));
  check('a streamed requirement does NOT apply to a non-streamed section', !requirementAppliesToSection({ gradeId: 'g11', streamId: 'SCI' }, { gradeId: 'g11', streamId: null }));
  check('null equals null; same stream equals; different grade never', requirementAppliesToSection({ gradeId: 'g8', streamId: null }, { gradeId: 'g8', streamId: null }) && requirementAppliesToSection({ gradeId: 'g11', streamId: 'SCI' }, { gradeId: 'g11', streamId: 'SCI' }) && !requirementAppliesToSection({ gradeId: 'g8', streamId: null }, { gradeId: 'g9', streamId: null }));
  check('the null-stream requirement of a streamed grade creates no missing assignments for streamed sections', normalizeProblem({ ...s11, requirements: [...s11.requirements, req('r-eng', 'g11', 'phys', 3, null)] }).ok);
  // a teacher shared across streams: collisions are global
  const shared: Snap = { ...s11, assignments: [asg('a1', '11S1', 'r-phys', 't-phys'), asg('a2', '11S2', 'r-phys', 't-phys'), asg('a3', '11C1', 'r-acct', 't-phys')], teacherSubjects: [link('t-phys', 'phys', ['g11']), link('t-phys', 'acct', ['g11'])] };
  const sp = normalizeProblem(shared);
  check('one teacher teaching two streams is legal and counted once', sp.ok && sp.problem.derived.teacherCount === 1);
  if (sp.ok) {
    const base = buildBaseline(sp.problem, 3);
    check('baseline for a shared-teacher streamed grade is valid (no teacher collision across streams)', base.ok && validateEntries(sp.problem, base.entries).valid);
  }
}

section('8. Baseline (Konig edge-colouring)');
{
  const p = mustNormalize(snapshot());
  const r = buildBaseline(p, 1);
  check('baseline builds for the 8A/8B/8C example', r.ok);
  if (r.ok) {
    check('exactly 27 entries: 5 Math + 4 Science per section x 3', r.entries.length === 27);
    check('baseline passes the independent validator', validateEntries(p, r.entries).valid);
    check('each section has exactly 9 entries', ['8A', '8B', '8C'].every((id) => r.entries.filter((e) => e.sectionId === id).length === 9));
    check('Math teacher has 15 entries, no two in one slot', r.entries.filter((e) => e.teacherId === 't-math').length === 15);
    const again = buildBaseline(p, 1);
    check('same seed -> identical baseline', again.ok && same(again.entries, r.entries));
    const other = buildBaseline(p, 2);
    check('different seed -> a different but equally valid baseline', other.ok && !same(other.entries, r.entries) && validateEntries(p, other.entries).valid);
    check('entries only use configured days and periods', r.entries.every((e) => DAYS5.includes(e.dayOfWeek) && e.periodNumber >= 1 && e.periodNumber <= 6));
  }
  // certificate
  const overTeacher = coreProblem(2, 3, allContinue(3), [['a', 'S1', 'T1', 4], ['b', 'S2', 'T1', 3]]);
  const c1 = buildBaseline(overTeacher);
  check('teacher with 7 > 6 slots: no baseline, exact certificate', !c1.ok && same(c1.certificate, [{ type: 'TEACHER', id: 'T1', load: 7, limit: 6 }]));
  const overSection = coreProblem(2, 3, allContinue(3), [['a', 'S1', 'T1', 4], ['b', 'S1', 'T2', 3]]);
  const c2 = buildBaseline(overSection);
  check('section with 7 > 6 slots: no baseline, exact certificate', !c2.ok && same(c2.certificate, [{ type: 'SECTION', id: 'S1', load: 7, limit: 6 }]));
  const cap = coreProblem(6, 8, allContinue(8), Array.from({ length: 7 }, (_, i): Tuple => [`a${i}`, `S${i}`, 'T1', 5]));
  check('teacher with 35 periods > 32 (W = 48): certificate names the teacher', findCapacityViolations(cap).some((v) => v.type === 'TEACHER' && v.id === 'T1' && v.load === 35 && v.limit === 32));
  check('capacity violations of a valid problem: none', findCapacityViolations(p).length === 0);
}
{
  // Konig fuzz: TIGHT regular instances, every teacher and section at full degree W (teacher cap lifted to W).
  const rnd = mulberry32(2026);
  let built = 0; let invalid = 0; let threw = 0;
  for (let i = 0; i < 1200; i++) {
    const n = 2 + Math.floor(rnd() * 11); const D = 1 + Math.floor(rnd() * 6); const K = 2 + Math.floor(rnd() * 7); const W = D * K;
    const mult = new Map<string, number>();
    for (let c = 0; c < W; c++) {
      const perm = Array.from({ length: n }, (_, j) => j);
      for (let j = n - 1; j > 0; j--) { const k = Math.floor(rnd() * (j + 1)); [perm[j], perm[k]] = [perm[k]!, perm[j]!]; }
      perm.forEach((s, t) => { const key = `S${s}|T${t}`; mult.set(key, (mult.get(key) ?? 0) + 1); });
    }
    const tuples: Tuple[] = [...mult].map(([key, p], j) => { const [s, t] = key.split('|'); return [`a${j}`, s!, t!, p]; });
    const problem = coreProblem(D, K, allContinue(K), tuples, W);
    try {
      const r = buildBaseline(problem, 1 + (i % 97));
      if (!r.ok) { invalid++; continue; }
      built++;
      if (!validateEntries(problem, r.entries).valid) invalid++;
    } catch { threw++; }
  }
  check('1200 tight regular instances (every vertex at degree W): baseline always valid', built === 1200 && invalid === 0 && threw === 0, `built=${built} invalid=${invalid} threw=${threw}`);
}
{
  // random instances below capacity, mixed teacher / section loads
  const rnd = mulberry32(99);
  let bad = 0;
  for (let i = 0; i < 400; i++) {
    const nS = 1 + Math.floor(rnd() * 15); const nT = 1 + Math.floor(rnd() * 12); const D = 1 + Math.floor(rnd() * 6); const K = 2 + Math.floor(rnd() * 7); const W = D * K;
    const cap = Math.min(32, W); const tl = new Array(nT).fill(0); const sd = new Array(nS).fill(0); const tuples: Tuple[] = [];
    for (let j = 0; j < nS * 6; j++) {
      const s = Math.floor(rnd() * nS); const t = Math.floor(rnd() * nT); const p = 1 + Math.floor(rnd() * 6);
      if (tl[t] + p > cap || sd[s] + p > W) continue;
      tl[t] += p; sd[s] += p; tuples.push([`a${tuples.length}`, `S${s}`, `T${t}`, p]);
    }
    if (tuples.length === 0) continue;
    const problem = coreProblem(D, K, allContinue(K), tuples);
    const r = buildBaseline(problem, i);
    if (!r.ok || !validateEntries(problem, r.entries).valid) bad++;
  }
  check('400 random below-capacity instances: baseline always valid', bad === 0, `${bad} invalid`);
}
{
  // realistic scale: 100 sections, heavy teachers near 32, 5 days x 8 periods (W = 40), Phase 0 shape
  const rnd = mulberry32(5);
  const subjects = Array.from({ length: 10 }, (_, i) => i);
  const tuples: Tuple[] = [];
  const teacherLoad = new Map<string, number>();
  const cursor = subjects.map(() => ({ idx: 1, load: 0 }));
  for (const subj of subjects) {
    for (let s = 0; s < 100; s++) {
      const p = 1 + Math.floor(rnd() * 6);
      const c = cursor[subj]!;
      if (c.load + p > 32) { c.idx++; c.load = 0; }
      c.load += p;
      const t = `T-${subj}-${c.idx}`;
      teacherLoad.set(t, (teacherLoad.get(t) ?? 0) + p);
      tuples.push([`a-${subj}-${s}`, `S${String(s).padStart(3, '0')}`, t, p]);
    }
  }
  const demand = new Map<string, number>();
  for (const t of tuples) demand.set(t[1], (demand.get(t[1]) ?? 0) + t[3]);
  // keep only sections that fit the week, as a real configuration would
  const fit = tuples.filter((t) => (demand.get(t[1]) ?? 0) <= 40);
  const problem = coreProblem(5, 8, allContinue(8), fit);
  const t0 = Date.now();
  const r = buildBaseline(problem, 1);
  const ms = Date.now() - t0;
  check(`100-section heavy instance (${fit.length} assignments, ${problem.derived.expectedEntryCount} entries): valid baseline`, r.ok && validateEntries(problem, r.entries).valid);
  check(`...built in well under a second (${ms} ms)`, ms < 1000);
}

section('9. Validator: every rejection');
{
  const p = mustNormalize(snapshot());
  const good = buildBaseline(p, 1);
  if (!good.ok) throw new Error('baseline failed');
  const E = good.entries;
  const codesOf = (entries: TimetableEntryRow[], problem: NormalizedProblem = p) => validateEntries(problem, entries).problems.map((x) => x.code);
  check('the baseline is valid', validateEntries(p, E).valid && validateEntries(p, E).problemCount === 0);
  check('an empty timetable is invalid (count mismatch + wrong counts)', codesOf([]).includes('ENTRY_COUNT_MISMATCH') && codesOf([]).includes('WRONG_PERIOD_COUNT'));
  check('a missing entry is detected', codesOf(E.slice(1)).includes('ENTRY_COUNT_MISMATCH') && codesOf(E.slice(1)).includes('WRONG_PERIOD_COUNT'));
  check('an extra entry is detected', codesOf([...E, { ...E[0]!, dayOfWeek: E[0]!.dayOfWeek === 'MONDAY' ? 'TUESDAY' : 'MONDAY' }]).includes('ENTRY_COUNT_MISMATCH'));
  check('DUPLICATE_ENTRY: the same assignment twice in one slot', codesOf([...E, { ...E[0]! }]).includes('DUPLICATE_ENTRY'));
  check('UNKNOWN_ASSIGNMENT', codesOf([{ ...E[0]!, assignmentId: 'nope' }, ...E.slice(1)]).includes('UNKNOWN_ASSIGNMENT'));
  check('ENTRY_ID_MISMATCH: wrong teacher', codesOf([{ ...E[0]!, teacherId: 't-other' }, ...E.slice(1)]).includes('ENTRY_ID_MISMATCH'));
  check('ENTRY_ID_MISMATCH: wrong section', codesOf([{ ...E[0]!, sectionId: '8Z' }, ...E.slice(1)]).includes('ENTRY_ID_MISMATCH'));
  check('ENTRY_ID_MISMATCH: wrong subject', codesOf([{ ...E[0]!, subjectId: 'art' }, ...E.slice(1)]).includes('ENTRY_ID_MISMATCH'));
  check('INVALID_DAY: SATURDAY on a Monday-Friday school', codesOf([{ ...E[0]!, dayOfWeek: 'SATURDAY' }, ...E.slice(1)]).includes('INVALID_DAY'));
  check('INVALID_PERIOD: 0', codesOf([{ ...E[0]!, periodNumber: 0 }, ...E.slice(1)]).includes('INVALID_PERIOD'));
  check('INVALID_PERIOD: K + 1', codesOf([{ ...E[0]!, periodNumber: 7 }, ...E.slice(1)]).includes('INVALID_PERIOD'));
  check('INVALID_PERIOD: fractional', codesOf([{ ...E[0]!, periodNumber: 2.5 }, ...E.slice(1)]).includes('INVALID_PERIOD'));

  // section collision: put a second assignment of the same section into an occupied slot
  const mathA = E.find((e) => e.assignmentId === 'a-8A-math')!;
  const sciA = E.findIndex((e) => e.assignmentId === 'a-8A-sci');
  const clash = E.map((e, i) => (i === sciA ? { ...e, dayOfWeek: mathA.dayOfWeek, periodNumber: mathA.periodNumber } : e));
  check('SECTION_COLLISION', codesOf(clash).includes('SECTION_COLLISION'));
  // teacher collision: two sections of the same teacher in one slot
  const mathB = E.findIndex((e) => e.assignmentId === 'a-8B-math');
  const tclash = E.map((e, i) => (i === mathB ? { ...e, dayOfWeek: mathA.dayOfWeek, periodNumber: mathA.periodNumber } : e));
  check('TEACHER_COLLISION: 8A Math and 8B Math (same teacher) in one slot', codesOf(tclash).includes('TEACHER_COLLISION'));
  // teacher over capacity: a problem whose teacher capacity is smaller than the load
  const tiny = coreProblem(2, 3, allContinue(3), [['a', 'S1', 'T1', 6]], 4);
  const tinyEntries = [0, 1].flatMap((d) => [1, 2, 3].map((k) => entry(tiny, 'a', d, k)));
  check('TEACHER_OVER_CAPACITY: 6 periods against a limit of 4', codesOf(tinyEntries, tiny).includes('TEACHER_OVER_CAPACITY'));
  // many problems are capped but counted
  const junk = Array.from({ length: 500 }, (_, i) => ({ ...E[0]!, assignmentId: `junk${i}` }));
  const v = validateEntries(p, junk);
  check('reported problems are capped at 100, the true count is kept', v.problems.length === 100 && v.problemCount >= 500);
  check('validation is deterministic', same(validateEntries(p, tclash), validateEntries(p, tclash)));
}

// ===========================================================================
section('10. Solver output interpretation + outcome decision (decisions B / D4)');
{
  const p = mustNormalize(snapshot());
  const b = buildBaseline(p, 1);
  if (!b.ok) throw new Error('baseline failed');
  const baseline = b.entries;
  // a different but valid timetable for the "solver" to return
  const other = buildBaseline(p, 9);
  if (!other.ok) throw new Error('baseline failed');
  const diag = { objectiveValue: 12, bestObjectiveBound: 0, wallSeconds: 3.2, numWorkers: 4, seed: 1, ortoolsVersion: '9.15.6755', numBooleans: 100, numConstraints: 80, conflicts: 5, branches: 9, stoppedBy: 'TIME_LIMIT' as const, messages: [] };
  const out = (status: SolverOutput['status'], entries: TimetableEntryRow[], over: Partial<SolverOutput> = {}): SolverOutput => ({ contractVersion: CONTRACT_VERSION, requestId: 'r1', status, entries, diagnostics: diag, ...over });
  const run = (raw: unknown) => decideOutcome(interpretSolverOutput(p, 'r1', raw), baseline);

  const opt = run(out('OPTIMAL', other.entries));
  check('OPTIMAL + valid entries -> SUCCESS from CP_SAT, optimal = true', opt.kind === 'SUCCESS' && opt.solutionSource === 'CP_SAT' && opt.solverStatus === 'OPTIMAL' && opt.optimal && same(opt.entries, other.entries));
  const feas = run(out('FEASIBLE', other.entries));
  check('FEASIBLE + valid entries -> SUCCESS from CP_SAT, optimal = false (a normal result)', feas.kind === 'SUCCESS' && feas.solutionSource === 'CP_SAT' && feas.solverStatus === 'FEASIBLE' && !feas.optimal && feas.fallbackReason === null);
  check('the solver diagnostics are carried through', feas.kind === 'SUCCESS' && feas.solverDiagnostics?.objectiveValue === 12);

  const unknown = run(out('UNKNOWN', []));
  check('UNKNOWN with no entries -> SUCCESS using the BASELINE (not an error)', unknown.kind === 'SUCCESS' && unknown.solutionSource === 'BASELINE' && unknown.solverStatus === 'UNKNOWN' && !unknown.optimal && unknown.fallbackReason === 'NO_SOLUTION_WITHIN_BUDGET' && same(unknown.entries, baseline));
  const killed = decideOutcome({ kind: 'KILLED_BY_WATCHDOG' }, baseline);
  check('process killed at the watchdog deadline -> SUCCESS using the BASELINE', killed.kind === 'SUCCESS' && killed.solutionSource === 'BASELINE' && killed.fallbackReason === 'KILLED_BY_WATCHDOG');

  const infeasible = run(out('INFEASIBLE', []));
  check('INFEASIBLE while a valid baseline exists -> FAILED INTERNAL_INCONSISTENCY', infeasible.kind === 'FAILURE' && infeasible.code === 'INTERNAL_INCONSISTENCY');
  check('INFEASIBLE with entries -> FAULT SOLVER_INVALID_OUTPUT', (() => { const r = run(out('INFEASIBLE', other.entries)); return r.kind === 'FAILURE' && r.code === 'SOLVER_INVALID_OUTPUT'; })());
  check('UNKNOWN with entries -> FAULT SOLVER_INVALID_OUTPUT (never falls back)', (() => { const r = run(out('UNKNOWN', other.entries)); return r.kind === 'FAILURE' && r.code === 'SOLVER_INVALID_OUTPUT'; })());
  check('MODEL_INVALID -> FAILED SOLVER_MODEL_INVALID', (() => { const r = run(out('MODEL_INVALID', [])); return r.kind === 'FAILURE' && r.code === 'SOLVER_MODEL_INVALID'; })());
  check('INPUT_INVALID -> FAILED SOLVER_INPUT_REJECTED', (() => { const r = run(out('INPUT_INVALID', [])); return r.kind === 'FAILURE' && r.code === 'SOLVER_INPUT_REJECTED'; })());

  const invalid = run(out('FEASIBLE', [...other.entries.slice(1), other.entries[1]!]));
  check('FEASIBLE with an invalid timetable -> FAILED SOLVER_INVALID_OUTPUT, NOT the baseline', invalid.kind === 'FAILURE' && invalid.code === 'SOLVER_INVALID_OUTPUT' && invalid.problems.length > 0);
  check('FEASIBLE with no entries -> FAILED SOLVER_INVALID_OUTPUT', (() => { const r = run(out('FEASIBLE', [])); return r.kind === 'FAILURE' && r.code === 'SOLVER_INVALID_OUTPUT'; })());
  check('OPTIMAL missing one entry -> FAILED', (() => { const r = run(out('OPTIMAL', other.entries.slice(1))); return r.kind === 'FAILURE' && r.code === 'SOLVER_INVALID_OUTPUT'; })());

  check('wrong requestId -> FAILED SOLVER_INVALID_OUTPUT', (() => { const r = run(out('OPTIMAL', other.entries, { requestId: 'someone-else' })); return r.kind === 'FAILURE' && r.code === 'SOLVER_INVALID_OUTPUT'; })());
  check('wrong contract version -> FAILED SOLVER_INVALID_OUTPUT', (() => { const r = run({ ...out('OPTIMAL', other.entries), contractVersion: '9.9' }); return r.kind === 'FAILURE' && r.code === 'SOLVER_INVALID_OUTPUT'; })());
  for (const [label, raw] of [['null', null], ['undefined', undefined], ['a string', 'ok'], ['a number', 42], ['an array', []], ['an empty object', {}], ['a truncated object', { contractVersion: '1.0' }]] as const) {
    const r = run(raw);
    check(`malformed output (${label}) -> FAILED SOLVER_INVALID_OUTPUT, never throws`, r.kind === 'FAILURE' && r.code === 'SOLVER_INVALID_OUTPUT');
  }
  check('extra top-level field -> FAILED', (() => { const r = run({ ...out('OPTIMAL', other.entries), debug: true }); return r.kind === 'FAILURE'; })());
  check('extra field inside an entry -> FAILED', (() => { const r = run(out('OPTIMAL', [{ ...other.entries[0]!, extra: 1 } as unknown as TimetableEntryRow, ...other.entries.slice(1)])); return r.kind === 'FAILURE'; })());
  check('periodNumber as a string -> FAILED', (() => { const r = run(out('OPTIMAL', [{ ...other.entries[0]!, periodNumber: '3' } as unknown as TimetableEntryRow, ...other.entries.slice(1)])); return r.kind === 'FAILURE'; })());
  check('unknown day name -> FAILED', (() => { const r = run(out('OPTIMAL', [{ ...other.entries[0]!, dayOfWeek: 'FUNDAY' } as unknown as TimetableEntryRow, ...other.entries.slice(1)])); return r.kind === 'FAILURE'; })());

  const unavailable = decideOutcome({ kind: 'PROCESS_FAULT', code: 'SOLVER_UNAVAILABLE', message: 'python not found' }, baseline);
  const crashed = decideOutcome({ kind: 'PROCESS_FAULT', code: 'SOLVER_CRASHED', message: 'exit 1' }, baseline);
  check('Python missing -> FAILED SOLVER_UNAVAILABLE (does NOT fall back)', unavailable.kind === 'FAILURE' && unavailable.code === 'SOLVER_UNAVAILABLE');
  check('Python crash / non-zero exit -> FAILED SOLVER_CRASHED (does NOT fall back)', crashed.kind === 'FAILURE' && crashed.code === 'SOLVER_CRASHED');

  // The decision table: which attempts may ever yield a baseline?
  const attempts: Array<[string, SolverAttempt]> = [
    ['SOLUTION', { kind: 'SOLUTION', status: 'FEASIBLE', entries: other.entries, diagnostics: diag }],
    ['NO_SOLUTION', { kind: 'NO_SOLUTION', diagnostics: diag }],
    ['KILLED_BY_WATCHDOG', { kind: 'KILLED_BY_WATCHDOG' }],
    ['INFEASIBLE', { kind: 'INFEASIBLE', diagnostics: diag }],
    ['FAULT', { kind: 'FAULT', code: 'SOLVER_INVALID_OUTPUT', message: 'x', problems: [], diagnostics: null }],
    ['PROCESS_FAULT unavailable', { kind: 'PROCESS_FAULT', code: 'SOLVER_UNAVAILABLE', message: 'x' }],
    ['PROCESS_FAULT crashed', { kind: 'PROCESS_FAULT', code: 'SOLVER_CRASHED', message: 'x' }],
  ];
  const usesBaseline = attempts.filter(([, a]) => { const o = decideOutcome(a, baseline); return o.kind === 'SUCCESS' && o.solutionSource === 'BASELINE'; }).map(([n]) => n);
  check('ONLY a clean UNKNOWN and a watchdog kill may use the baseline', same(usesBaseline, ['NO_SOLUTION', 'KILLED_BY_WATCHDOG']), usesBaseline.join(','));
  check('every failure outcome carries a code from the closed failure-code list', attempts.every(([, a]) => { const o = decideOutcome(a, baseline); return o.kind === 'SUCCESS' || (FAILURE_CODES as readonly string[]).includes(o.code); }));
  check('the baseline array is not mutated by a fallback', same(baseline, b.entries));
}

// ===========================================================================
section('11. Metric evaluator: hand-computed cases');
{
  const K = 6;
  const day = (n: number) => n; // 0-based day
  const termsOf = (problem: NormalizedProblem, entries: TimetableEntryRow[]) => evaluateMetrics(problem, entries).terms;

  // Teacher runs: one teacher with n single-period lessons in different sections, D = 1.
  const teacherRuns = (periods: number[], continues: boolean[] = allContinue(K)) => {
    const tuples: Tuple[] = periods.map((_, i) => [`a${i}`, `S${i}`, 'T', 1]);
    const problem = coreProblem(1, K, continues, tuples);
    const entries = periods.map((pn, i) => entry(problem, `a${i}`, day(0), pn));
    return { problem, terms: termsOf(problem, entries) };
  };
  let r = teacherRuns([1, 2, 3]);
  check('run of 3 -> teacherRun3 = 1, teacherRun4Plus = 0', r.terms.teacherRun3 === 1 && r.terms.teacherRun4Plus === 0);
  r = teacherRuns([1, 2, 3, 4]);
  check('run of 4 -> teacherRun3 = 2, teacherRun4Plus = 1', r.terms.teacherRun3 === 2 && r.terms.teacherRun4Plus === 1);
  r = teacherRuns([1, 2, 3, 4, 5]);
  check('run of 5 -> teacherRun3 = 3, teacherRun4Plus = 2', r.terms.teacherRun3 === 3 && r.terms.teacherRun4Plus === 2);
  r = teacherRuns([1, 2, 3, 4, 5, 6]);
  check('run of 6 -> teacherRun3 = 4, teacherRun4Plus = 3', r.terms.teacherRun3 === 4 && r.terms.teacherRun4Plus === 3);
  r = teacherRuns([1, 2, 4, 5, 6]);
  check('2 then a gap then 3 -> teacherRun3 = 1 (the 3-run), nothing for the 2-run', r.terms.teacherRun3 === 1 && r.terms.teacherRun4Plus === 0);
  r = teacherRuns([1, 2, 4, 5]);
  check('two runs of 2 -> no run penalty', r.terms.teacherRun3 === 0 && r.terms.teacherRun4Plus === 0);
  r = teacherRuns([1, 2, 3], [true, true, false, true, true, false]);
  check('periods 1-3 with a break after period 3: still a run of 3', r.terms.teacherRun3 === 1);
  r = teacherRuns([1, 2, 3], [true, false, true, true, true, false]);
  check('a break after period 2 splits periods 1-3: NO run of 3 (a break ends the run)', r.terms.teacherRun3 === 0 && r.terms.teacherRun4Plus === 0);
  r = teacherRuns([3, 4, 5], [true, false, true, true, true, false]);
  check('periods 3-5 after that break form a run of 3', r.terms.teacherRun3 === 1);
  r = teacherRuns([1, 2, 3, 4], [true, true, false, true, true, false]);
  check('periods 1-4 with a break after 3 -> only the 1-3 window counts: run3 = 1, run4 = 0', r.terms.teacherRun3 === 1 && r.terms.teacherRun4Plus === 0);
  r = teacherRuns([1, 2, 3, 4], [false, false, false, false, false, false]);
  check('breaks everywhere -> no consecutive run at all', r.terms.teacherRun3 === 0 && r.terms.teacherRun4Plus === 0);

  // teacher with weekly load < 3 is excluded from runs and from the daily-load term
  {
    const problem = coreProblem(5, K, allContinue(K), [['a', 'SA', 'T', 1], ['b', 'SB', 'T', 1]]);
    const entries = [entry(problem, 'a', 0, 1), entry(problem, 'b', 0, 2)];
    const m = evaluateMetrics(problem, entries);
    check('teacher with load 2 on one day: dailyLoadExcess ignores it (load < 3 rule)', m.terms.dailyLoadExcess === 0 && m.terms.teacherRun3 === 0);
    check('...while section SB, a late starter at period 2, has 1 hole', m.terms.sectionHoles === 1);
  }

  // subject spread
  const spread = (p: number, D: number, K_: number, placement: Array<[number, number]>) => {
    const problem = coreProblem(D, K_, allContinue(K_), [['a', 'S', 'T', p]], 32);
    const entries = placement.map(([d, k]) => entry(problem, 'a', d, k));
    return evaluateMetrics(problem, entries).terms.subjectSameDayExcess;
  };
  check('p=1: never penalised', spread(1, 5, 6, [[0, 1]]) === 0);
  check('p=2 on two different days: 0', spread(2, 5, 6, [[0, 1], [1, 1]]) === 0);
  check('p=2 on the same day: 1', spread(2, 5, 6, [[0, 1], [0, 2]]) === 1);
  check('p=3 all on one day, D=5 (cap 1): 2', spread(3, 5, 6, [[0, 1], [0, 2], [0, 3]]) === 2);
  check('p=5 one per day (D=5): 0', spread(5, 5, 6, [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]]) === 0);
  check('p=5 with a double (D=5, cap 1): 1', spread(5, 5, 6, [[0, 1], [0, 2], [2, 1], [3, 1], [4, 1]]) === 1);
  check('p=8 over 5 days as 2,2,2,1,1 (cap 2): 0 - what the week forces is free', spread(8, 5, 6, [[0, 1], [0, 2], [1, 1], [1, 2], [2, 1], [2, 2], [3, 1], [4, 1]]) === 0);
  check('p=8 as 3,2,1,1,1 (cap 2): 1', spread(8, 5, 6, [[0, 1], [0, 2], [0, 3], [1, 1], [1, 2], [2, 1], [3, 1], [4, 1]]) === 1);
  check('cap >= K is skipped (p=8, D=5, K=2: cap 2 = K)', spread(8, 5, 2, [[0, 1], [0, 2], [1, 1], [1, 2], [2, 1], [2, 2], [3, 1], [3, 2]]) === 0);

  // section holes
  const holes = (periods: number[]) => {
    const tuples: Tuple[] = periods.map((_, i) => [`a${i}`, 'S', `T${i}`, 1]);
    const problem = coreProblem(1, K, allContinue(K), tuples);
    return evaluateMetrics(problem, periods.map((pn, i) => entry(problem, `a${i}`, 0, pn))).terms.sectionHoles;
  };
  check('periods 1-3 from the start: no hole', holes([1, 2, 3]) === 0);
  check('periods 1,3,5: two holes', holes([1, 3, 5]) === 2);
  check('periods 2,3,4 (late start): one hole', holes([2, 3, 4]) === 1);
  check('periods 1,2,3,5: one hole', holes([1, 2, 3, 5]) === 1);
  check('a full day (6 of 6): no holes by definition', holes([1, 2, 3, 4, 5, 6]) === 0);
  check('holes are counted per day', (() => {
    const problem = coreProblem(2, K, allContinue(K), [['a', 'S', 'T1', 1], ['b', 'S', 'T2', 1], ['c', 'S', 'T3', 1], ['d', 'S', 'T4', 1]]);
    const entries = [entry(problem, 'a', 0, 1), entry(problem, 'b', 0, 3), entry(problem, 'c', 1, 2), entry(problem, 'd', 1, 3)];
    return evaluateMetrics(problem, entries).terms.sectionHoles === 2; // day0: 1,3 -> 1 hole; day1: 2,3 -> 1 (late start)
  })());

  // daily load excess
  {
    const problem = coreProblem(5, K, allContinue(K), [['a', 'S1', 'T', 12]]);
    const days = [[0, 5], [1, 3], [2, 2], [3, 1], [4, 1]] as const; // 5+3+2+1+1 = 12
    const entries = days.flatMap(([d, n]) => Array.from({ length: n }, (_, k) => entry(problem, 'a', d, k + 1)));
    const m = evaluateMetrics(problem, entries);
    // teacher: load 12 over D=5, cap=3: excess (5-3)=2. Section S1 (demand 12 of 30): same cap 3 -> excess 2. Total 4.
    check('teacher AND section daily load excess: 5,3,2,1,1 with cap 3 -> 2 + 2 = 4', m.terms.dailyLoadExcess === 4, String(m.terms.dailyLoadExcess));
  }
  {
    const problem = coreProblem(1, K, allContinue(K), [['a', 'S', 'T', 6]]);
    const entries = [1, 2, 3, 4, 5, 6].map((k) => entry(problem, 'a', 0, k));
    check('cap >= K (one day, load 6 = K) skips the daily-load term; a full section is skipped', evaluateMetrics(problem, entries).terms.dailyLoadExcess === 0);
  }

  // weights
  {
    const problem = coreProblem(1, K, allContinue(K), [['a', 'S1', 'T', 1], ['b', 'S2', 'T', 1], ['c', 'S3', 'T', 1], ['d', 'S4', 'T', 1]]);
    const entries = [1, 2, 3, 4].map((k, i) => entry(problem, ['a', 'b', 'c', 'd'][i]!, 0, k));
    const m = evaluateMetrics(problem, entries);
    check('weightedObjective = 3*run3 + 8*run4 + 5*spread + 4*holes + 2*load (WEIGHTS_V1)', m.weightedObjective === 3 * m.terms.teacherRun3 + 8 * m.terms.teacherRun4Plus + 5 * m.terms.subjectSameDayExcess + 4 * m.terms.sectionHoles + 2 * m.terms.dailyLoadExcess);
    check('a run of 4 scores 2*3 + 8 = 14 from the teacher plus 3 holes (S2..S4 start late) x 4', m.weightedObjective === 14 + 4 * 3 + 2 * m.terms.dailyLoadExcess, `${m.weightedObjective} terms=${JSON.stringify(m.terms)}`);
    check('weights and version are recorded with the result', same(m.weights, WEIGHTS_V1) && m.weightsVersion === 'V1');
    const custom = evaluateMetrics(problem, entries, { ...WEIGHTS_V1, teacherRun4Plus: 100 });
    check('custom weights change the objective, never the raw terms', same(custom.terms, m.terms) && custom.weightedObjective === m.weightedObjective + 92);
  }

  // informational
  {
    const problem = coreProblem(2, K, [true, true, false, true, true, false], [['a', 'S1', 'T', 1], ['b', 'S2', 'T', 1], ['c', 'S3', 'T', 1], ['d', 'S4', 'T', 1], ['e', 'S5', 'T', 1]]);
    const entries = [entry(problem, 'a', 0, 1), entry(problem, 'b', 0, 4), entry(problem, 'c', 1, 2), entry(problem, 'd', 1, 3), entry(problem, 'e', 1, 4)];
    const i = evaluateMetrics(problem, entries).informational;
    check('teacher gap periods: day0 periods 1,4 -> 2; day1 periods 2,3,4 -> 0', i.teacherGapPeriods === 2);
    check('busy days = 2, single-lesson days = 0', i.teacherBusyDays === 2 && i.teacherSingleLessonDays === 0);
    check('max run honours the break after period 3: day1 periods 2,3 | 4 -> max 2', i.teacherMaxRun === 2);
  }
  {
    const problem = coreProblem(5, K, allContinue(K), [['a', 'S', 'T', 7]]);
    const entries = [[0, 1], [0, 2], [1, 1], [1, 2], [2, 1], [3, 1], [4, 1]].map(([d, k]) => entry(problem, 'a', d!, k!));
    const i = evaluateMetrics(problem, entries).informational;
    check('same-day repeat pairs = 2 (days with 2 lessons); forced = p - D = 2', i.sameDayRepeatPairs === 2 && i.forcedSameDayRepeatPairs === 2);
  }
  {
    const problem = coreProblem(1, K, allContinue(K), [['a', 'S1', 'T', 1]]);
    check('a lone lesson is a single-lesson day', evaluateMetrics(problem, [entry(problem, 'a', 0, 1)]).informational.teacherSingleLessonDays === 1);
  }

  // properties
  {
    const p = mustNormalize(snapshot());
    const b = buildBaseline(p, 4);
    if (b.ok) {
      const m1 = evaluateMetrics(p, b.entries);
      const shuffled = [...b.entries].reverse();
      check('metrics do not depend on entry order', same(m1, evaluateMetrics(p, shuffled)));
      check('metrics are deterministic', same(m1, evaluateMetrics(p, b.entries)));
      check('all terms are non-negative integers', TERM_NAMES.every((n) => Number.isInteger(m1.terms[n]) && m1.terms[n] >= 0));
    }
  }
}

// ===========================================================================
section('12. Metric parity: TypeScript evaluator vs the independent Python (Phase 0) evaluator');
{
  interface Golden {
    cases: Array<{
      name: string; dayCount: number; periodsPerDay: number; continues: boolean[];
      assignments: Array<[string, string, string, number]>; entries: Array<[number, number, number]>;
      expected: { terms: Record<string, number>; weightedObjective: number; informational: Record<string, number> };
    }>;
  }
  const golden = JSON.parse(readFileSync(new URL('./test-fixtures/timetable-generation/golden-metrics.json', import.meta.url), 'utf8')) as Golden;
  check('golden file has 5 cases', golden.cases.length === 5);
  for (const c of golden.cases) {
    const problem = coreProblem(c.dayCount, c.periodsPerDay, c.continues, c.assignments);
    const entries = c.entries.map(([ai, d, k]) => entry(problem, c.assignments[ai]![0], d, k + 1));
    const validation = validateEntries(problem, entries);
    check(`${c.name}: the stored timetable is valid under the TypeScript validator`, validation.valid, JSON.stringify(validation.problems.slice(0, 2)));
    const m = evaluateMetrics(problem, entries);
    check(`${c.name}: all 5 terms equal the Python values ${JSON.stringify(c.expected.terms)}`, same(m.terms, c.expected.terms), JSON.stringify(m.terms));
    check(`${c.name}: weighted objective equals Python (${c.expected.weightedObjective})`, m.weightedObjective === c.expected.weightedObjective, String(m.weightedObjective));
    check(`${c.name}: informational statistics equal Python`, same(m.informational, c.expected.informational), JSON.stringify(m.informational));
    const base = buildBaseline(problem, 1);
    check(`${c.name}: the TypeScript baseline for the same problem is valid`, base.ok && validateEntries(problem, base.entries).valid);
  }
  const zeroTermCases = golden.cases.filter((c) => Object.values(c.expected.terms).every((v) => v === 0));
  const covered = TERM_NAMES.every((n) => golden.cases.some((c) => (c.expected.terms[n] ?? 0) > 0));
  check('the golden set exercises every term with a non-zero value (incl. teacherRun4Plus)', covered && zeroTermCases.length === 0);
}

// ===========================================================================
section('13. End to end (pure): snapshot -> problem -> baseline -> validate -> metrics -> solver input');
{
  const p = mustNormalize(snapshot({ timingEvents: [{ afterPeriodNumber: 3 }] }));
  const b = buildBaseline(p, 11);
  check('baseline builds', b.ok);
  if (b.ok) {
    const v = validateEntries(p, b.entries);
    const m = evaluateMetrics(p, b.entries);
    const input = buildSolverInput(p, 'run-1', { timeLimitSeconds: resolveTimeLimitSeconds(p.derived.sectionCount), seed: 11, numWorkers: 4, reproducible: false, deterministicTimeLimit: null });
    check('the baseline is valid and its metrics are finite non-negative numbers', v.valid && Number.isInteger(m.weightedObjective) && m.weightedObjective >= 0);
    check('3 sections -> time limit 10 s in the solver input', input.options.timeLimitSeconds === 10);
    check('the solver input satisfies the contract schema', solverInputSchema.safeParse(input).success);
    const round = JSON.parse(JSON.stringify(input));
    check('the solver input survives a JSON round trip unchanged (what is hashed is what is sent)', same(round, input) && hashJson({ contractVersion: round.contractVersion, grid: round.grid, sections: round.sections, teachers: round.teachers, assignments: round.assignments, fixedEntries: round.fixedEntries }) === p.inputHash);
  }
}

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
