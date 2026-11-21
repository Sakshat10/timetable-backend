// Pure tests (no database, no server) for the automatic teacher allocation: the allocator itself, the normalizer (what generation does) and the
// analyzer (what readiness reports), including a randomized check that readiness and generation never disagree.
//   npx tsx test-teacher-auto-allocation-core.ts
import { allocateTeachers, type AllocationUnit } from './src/modules/timetable-feasibility/teacher-allocator.js';
import { analyzeFeasibility, type SchedulingInput } from './src/modules/timetable-feasibility/timetable-feasibility.analyzer.js';
import { normalizeProblem, isAutoAssignmentId, type GenerationSnapshot } from './src/modules/timetable-generation/timetable-generation.normalizer.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);

// ===========================================================================================================
section('ALLOCATOR');
const unit = (key: string, periods: number, candidates: string[]): AllocationUnit => ({ key, periods, candidates });
{
  const r = allocateTeachers({ units: [unit('s1', 5, ['a', 'b']), unit('s2', 5, ['a', 'b']), unit('s3', 5, ['a', 'b']), unit('s4', 5, ['a', 'b'])], teacherCapacity: 30, fixedLoad: new Map() });
  check('balanced: 4 equal units over 2 teachers go 2 + 2', r.unplaceable.length === 0 && r.load.get('a') === 10 && r.load.get('b') === 10, JSON.stringify([...r.load]));
}
{
  const r = allocateTeachers({ units: [unit('s1', 5, ['a', 'b'])], teacherCapacity: 30, fixedLoad: new Map([['a', 20]]) });
  check('explicit load is respected: the teacher with more room gets the unit', r.assigned.get('s1') === 'b');
}
{
  const r = allocateTeachers({ units: [unit('s1', 10, ['a'])], teacherCapacity: 30, fixedLoad: new Map([['a', 25]]) });
  check('a unit that does not fit the remaining capacity is unplaceable (never overloads a teacher)', r.unplaceable.join() === 's1' && !r.assigned.has('s1') && r.load.get('a') === 25);
}
{
  const r = allocateTeachers({ units: [unit('s1', 3, []), unit('s2', 3, ['a'])], teacherCapacity: 30, fixedLoad: new Map() });
  check('no candidates stays "no candidates": nobody is invented', r.noCandidates.join() === 's1' && r.assigned.get('s2') === 'a' && r.unplaceable.length === 0);
}
{
  // greedy-by-room alone fails here; the augmenting move rescues it:
  //   x (6, a|b) and y (6, a|b) fit one each; z (6, only a) arrives last because it has FEWER candidates only if ordered first, so build a trap
  const units = [unit('big', 4, ['a']), unit('mid', 3, ['a', 'b']), unit('mid2', 3, ['a', 'b']), unit('last', 4, ['b'])];
  const r = allocateTeachers({ units, teacherCapacity: 7, fixedLoad: new Map() });
  check('augmenting search finds a packing a plain greedy misses (all 4 units placed within capacity 7)', r.unplaceable.length === 0 && (r.load.get('a') ?? 0) <= 7 && (r.load.get('b') ?? 0) <= 7, JSON.stringify([r.unplaceable, [...r.load]]));
}
{
  const shuffle = <T,>(xs: T[], seed: number): T[] => { const a = [...xs]; let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) & 0x7fffffff; const j = s % (i + 1); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
  const base = Array.from({ length: 30 }, (_, i) => unit(`u${String(i).padStart(2, '0')}`, 1 + (i % 5), ['t1', 't2', 't3', 't4'].slice(0, 2 + (i % 3))));
  const ref = JSON.stringify([...allocateTeachers({ units: base, teacherCapacity: 32, fixedLoad: new Map() }).assigned].sort());
  const same = [1, 2, 3, 4, 5].every((seed) => JSON.stringify([...allocateTeachers({ units: shuffle(base.map((u) => ({ ...u, candidates: shuffle([...u.candidates], seed) })), seed), teacherCapacity: 32, fixedLoad: new Map() }).assigned].sort()) === ref);
  check('deterministic: input order and candidate order do not change the result', same);
}

// ===========================================================================================================
section('NORMALIZER (generation) and ANALYZER (readiness)');
const SCHOOL = 'school1';
const DAYS5 = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
const mkSchedule = (days: string[], ppd: number) => ({ periodsPerDay: ppd, workingDays: days, periods: Array.from({ length: ppd }, (_, i) => ({ periodNumber: i + 1 })) });
const teacher = (id: string, over: Partial<SchedulingInput['teachers'][number]> = {}) => ({ id, schoolId: SCHOOL, name: `T ${id}`, isActive: true, ...over });
const sec = (id: string, gradeId = 'g8') => ({ id, gradeId, streamId: null, name: id, code: id });
function snap(over: Partial<GenerationSnapshot> = {}): GenerationSnapshot {
  return {
    schoolId: SCHOOL,
    academicYear: { id: 'ay', name: 'Y', status: 'DRAFT' },
    schedule: mkSchedule(DAYS5, 6),
    grades: [{ id: 'g8', name: 'G8', displayOrder: 1 }, { id: 'g9', name: 'G9', displayOrder: 2 }],
    streams: [],
    sections: [sec('A'), sec('B'), sec('C')],
    subjects: [{ id: 'math', name: 'Math', code: 'M', schoolId: SCHOOL }, { id: 'sci', name: 'Sci', code: 'S', schoolId: SCHOOL }],
    requirements: [{ id: 'rm', gradeId: 'g8', streamId: null, subjectId: 'math', periodsPerWeek: 5 }],
    assignments: [],
    teachers: [teacher('t1'), teacher('t2')],
    teacherSubjects: [{ teacherId: 't1', subjectId: 'math', gradeIds: ['g8'] }, { teacherId: 't2', subjectId: 'math', gradeIds: [], allGrades: true }],
    timingEvents: [],
    ...over,
  };
}
const norm = (s: GenerationSnapshot) => normalizeProblem(s);
const teacherOf = (s: GenerationSnapshot, sectionId: string, req = 'rm'): string | undefined => {
  const r = norm(s);
  return r.ok ? r.problem.core.assignments.find((a) => a.sectionId === sectionId && a.subjectRequirementId === req)?.teacherId : undefined;
};
const codesOf = (s: GenerationSnapshot): string[] => { const r = norm(s); return r.ok ? [] : r.issues.map((i) => i.code); };
{
  const r = norm(snap());
  check('no explicit assignment: every section gets a teacher, ids are synthetic and deterministic', r.ok && r.problem.core.assignments.length === 3 && r.problem.core.assignments.every((a) => isAutoAssignmentId(a.id)) && r.problem.core.assignments.every((a) => a.id === `auto:${a.sectionId}:rm`));
  check('  the 3 sections are spread over the two eligible teachers (balanced)', r.ok && new Set(r.problem.core.assignments.map((a) => a.teacherId)).size === 2);
  check('  same snapshot → identical problem and hash', JSON.stringify(norm(snap())) === JSON.stringify(norm(snap())));
}
{
  const s = snap({ teacherSubjects: [{ teacherId: 't1', subjectId: 'math', gradeIds: [] }, { teacherId: 't2', subjectId: 'math', gradeIds: [] }] });
  check('SELECTED_GRADES links without any eligibility row are NOT eligible → NO_ELIGIBLE_TEACHER (never "all grades by omission")', codesOf(s).includes('NO_ELIGIBLE_TEACHER'), JSON.stringify(codesOf(s)));
  check('  the analyzer agrees: NOT_READY with NO_ELIGIBLE_TEACHER', (() => { const rep = analyzeFeasibility(s as SchedulingInput); return rep.status === 'NOT_READY' && rep.errors.some((e) => e.code === 'NO_ELIGIBLE_TEACHER'); })());
}
{
  const s = snap({ teacherSubjects: [{ teacherId: 't1', subjectId: 'math', gradeIds: ['g9'] }, { teacherId: 't2', subjectId: 'sci', gradeIds: [], allGrades: true }] });
  check('eligible for ANOTHER grade (g9) / ALL_GRADES for ANOTHER subject does not qualify for g8 math', codesOf(s).includes('NO_ELIGIBLE_TEACHER'));
}
{
  const s = snap({ teachers: [teacher('t1', { isActive: false }), teacher('t2', { schoolId: 'other' })] });
  check('inactive and other-school teachers are never candidates', codesOf(s).includes('NO_ELIGIBLE_TEACHER'));
}
{
  const s = snap({ assignments: [{ id: 'x1', sectionId: 'A', subjectRequirementId: 'rm', teacherId: 't1' }] });
  check('an explicit assignment is kept exactly (id and teacher) and the other sections are auto-assigned', teacherOf(s, 'A') === 't1' && (() => { const r = norm(s); return r.ok && r.problem.core.assignments.some((a) => a.id === 'x1') && r.problem.core.assignments.filter((a) => isAutoAssignmentId(a.id)).length === 2; })());
  check('  its load counts: t1 already carries 5, so the first auto section goes to t2 and the loads end balanced (10 / 5)', teacherOf(s, 'B') === 't2' && teacherOf(s, 'C') === 't1');
}
{
  const bad = snap({ assignments: [{ id: 'x1', sectionId: 'A', subjectRequirementId: 'rm', teacherId: 't3' }], teachers: [teacher('t1'), teacher('t2'), teacher('t3')] });
  check('an explicit assignment of an ineligible teacher is a blocker (TEACHER_NOT_ELIGIBLE), NOT replaced by an automatic choice', codesOf(bad).includes('TEACHER_NOT_ELIGIBLE') && !norm(bad).ok);
  check('  the analyzer reports ASSIGNED_TEACHER_NOT_ELIGIBLE', analyzeFeasibility(bad as SchedulingInput).errors.some((e) => e.code === 'ASSIGNED_TEACHER_NOT_ELIGIBLE'));
  const inactive = snap({ assignments: [{ id: 'x1', sectionId: 'A', subjectRequirementId: 'rm', teacherId: 't1' }], teachers: [teacher('t1', { isActive: false }), teacher('t2')] });
  check('an explicit assignment of an inactive teacher is a blocker (TEACHER_INACTIVE)', codesOf(inactive).includes('TEACHER_INACTIVE'));
}
{
  // capacity: 5 days × 6 periods = 30 slots → teacher capacity 30; 4 sections × 8 periods = 32 for ONE eligible teacher
  const s = snap({ sections: [sec('A'), sec('B'), sec('C'), sec('D')], requirements: [{ id: 'rm', gradeId: 'g8', streamId: null, subjectId: 'math', periodsPerWeek: 8 }], teacherSubjects: [{ teacherId: 't1', subjectId: 'math', gradeIds: ['g8'] }], teachers: [teacher('t1')] });
  check('one eligible teacher, 32 periods needed, capacity 30: TEACHER_ALLOCATION_FAILED in generation', codesOf(s).includes('TEACHER_ALLOCATION_FAILED'), JSON.stringify(codesOf(s)));
  const rep = analyzeFeasibility(s as SchedulingInput);
  check('  the analyzer reports the capacity shortfall instead of READY', rep.status === 'NOT_READY' && rep.errors.some((e) => e.code === 'ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT'));
}
{
  const s = snap({ sections: [sec('A'), sec('B')], requirements: [{ id: 'rm', gradeId: 'g8', streamId: null, subjectId: 'math', periodsPerWeek: 4 }, { id: 'rs', gradeId: 'g8', streamId: null, subjectId: 'sci', periodsPerWeek: 4 }], teacherSubjects: [{ teacherId: 't1', subjectId: 'math', gradeIds: [], allGrades: true }, { teacherId: 't1', subjectId: 'sci', gradeIds: [], allGrades: true }], teachers: [teacher('t1')] });
  const r = norm(s);
  check('a teacher qualified for two subjects can take both: load 16, never above capacity', r.ok && r.problem.core.assignments.length === 4 && r.problem.core.assignments.every((a) => a.teacherId === 't1'));
}

// ===========================================================================================================
section('READINESS == GENERATION on 400 random configurations');
{
  let seed = 20261022;
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let ready = 0;
  let notReady = 0;
  let mismatches = 0;
  let firstMismatch = '';
  for (let iter = 0; iter < 400; iter++) {
    const nSections = 1 + rnd(5);
    const nSubjects = 1 + rnd(3);
    const nTeachers = 1 + rnd(5);
    const days = 1 + rnd(5);
    const ppd = 2 + rnd(5);
    const subjects = Array.from({ length: nSubjects }, (_, i) => ({ id: `sub${i}`, name: `S${i}`, code: `C${i}`, schoolId: SCHOOL }));
    const sections = Array.from({ length: nSections }, (_, i) => sec(`sec${i}`));
    const requirements = subjects.map((s, i) => ({ id: `r${i}`, gradeId: 'g8', streamId: null, subjectId: s.id, periodsPerWeek: 1 + rnd(Math.max(1, Math.min(8, Math.floor((days * ppd) / nSubjects)))) }));
    const teachers = Array.from({ length: nTeachers }, (_, i) => teacher(`t${i}`, { isActive: rnd(10) !== 0 }));
    const teacherSubjects: GenerationSnapshot['teacherSubjects'] = [];
    for (const t of teachers) for (const s of subjects) {
      const roll = rnd(5);
      if (roll === 0) teacherSubjects.push({ teacherId: t.id, subjectId: s.id, gradeIds: [], allGrades: true });
      else if (roll === 1) teacherSubjects.push({ teacherId: t.id, subjectId: s.id, gradeIds: ['g8'] });
      else if (roll === 2) teacherSubjects.push({ teacherId: t.id, subjectId: s.id, gradeIds: [] }); // SELECTED_GRADES, no rows: not eligible
    }
    const assignments: GenerationSnapshot['assignments'] = [];
    for (const s of sections) for (const r of requirements) if (rnd(4) === 0) assignments.push({ id: `a-${s.id}-${r.id}`, sectionId: s.id, subjectRequirementId: r.id, teacherId: teachers[rnd(nTeachers)]!.id });
    const s = snap({ schedule: mkSchedule(DAYS5.slice(0, days), ppd), sections, subjects, requirements, teachers, teacherSubjects, assignments });
    const report = analyzeFeasibility(s as SchedulingInput);
    const normalized = normalizeProblem(s);
    const readyByReport = report.status === 'READY';
    if (readyByReport) ready++; else notReady++;
    if (readyByReport !== normalized.ok) {
      mismatches++;
      if (!firstMismatch) firstMismatch = `iter ${iter}: report=${report.status} [${report.errors.map((e) => e.code).join(',')}] normalize=${normalized.ok ? 'ok' : normalized.issues.map((i) => i.code).join(',')}`;
    }
    if (normalized.ok) {
      // every lesson of an OK problem is taught by an eligible, active teacher of the school, and nobody is over capacity
      const load = new Map<string, number>();
      for (const a of normalized.problem.core.assignments) load.set(a.teacherId, (load.get(a.teacherId) ?? 0) + a.periodsPerWeek);
      const cap = normalized.problem.derived.teacherCapacity;
      const t = new Map(teachers.map((x) => [x.id, x]));
      const eligible = (id: string, subj: string) => teacherSubjects.some((l) => l.teacherId === id && l.subjectId === subj && (l.allGrades === true || l.gradeIds.includes('g8')));
      const sound = normalized.problem.core.assignments.every((a) => t.get(a.teacherId)?.isActive === true && eligible(a.teacherId, a.subjectId)) && [...load.values()].every((v) => v <= cap);
      if (!sound) { mismatches++; if (!firstMismatch) firstMismatch = `iter ${iter}: UNSOUND problem`; }
    }
  }
  check(`readiness and generation agree on all 400 (${ready} READY, ${notReady} NOT_READY), and every OK problem uses only eligible active teachers within capacity`, mismatches === 0, firstMismatch);
  check('  the sample is meaningful (both outcomes occur)', ready > 20 && notReady > 20, `${ready}/${notReady}`);
}

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
