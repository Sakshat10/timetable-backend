// Pure tests (no database, no server) for the curriculum rules: classification, planning, section applicability, validation, and that readiness and generation read
// the curriculum the same way.   npx tsx test-curriculum-core.ts
import { buildClassifyContext, changesBetween, classifyRequirement, normalizeLine, planCurriculum, sectionDemand, type ReqRow } from './src/modules/curriculum/curriculum.core.js';
import { copyCurriculumSchema, curriculumLineSchema, replaceCurriculumSchema } from './src/modules/curriculum/curriculum.schema.js';
import { createSubjectRequirementSchema, scopeIssues, updateSubjectRequirementSchema } from './src/modules/subject-requirement/subject-requirement.schema.js';
import { requirementAppliesToSection, requirementSectionIds } from './src/modules/timetable-feasibility/requirement-applicability.js';
import { analyzeFeasibility, type SchedulingInput } from './src/modules/timetable-feasibility/timetable-feasibility.analyzer.js';
import { normalizeProblem, requirementAppliesToSection as normalizerRule, type GenerationSnapshot } from './src/modules/timetable-generation/timetable-generation.normalizer.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

section('SECTION APPLICABILITY (one definition for readiness, generation and assignment)');
{
  const req = { gradeId: 'g8', streamId: null as string | null };
  const sec = (id: string, gradeId = 'g8', streamId: string | null = null) => ({ id, gradeId, streamId });
  check('same grade and stream, no section restriction: applies to every section', requirementAppliesToSection(req, sec('a')) && requirementAppliesToSection({ ...req, sectionIds: null }, sec('b')));
  check('a different grade never applies', !requirementAppliesToSection(req, sec('a', 'g9')));
  check('the stream must match EXACTLY (null equals null; a stream requirement never applies to a non-streamed section or another stream)', !requirementAppliesToSection({ gradeId: 'g11', streamId: 'sci' }, sec('a', 'g11', null)) && !requirementAppliesToSection({ gradeId: 'g11', streamId: null }, sec('a', 'g11', 'sci')) && !requirementAppliesToSection({ gradeId: 'g11', streamId: 'sci' }, sec('a', 'g11', 'com')) && requirementAppliesToSection({ gradeId: 'g11', streamId: 'sci' }, sec('a', 'g11', 'sci')));
  check('a restricted requirement applies only to its listed sections', requirementAppliesToSection({ ...req, sectionIds: ['a'] }, sec('a')) && !requirementAppliesToSection({ ...req, sectionIds: ['a'] }, sec('b')));
  check('a restricted requirement never applies to a section of another grade even if listed', !requirementAppliesToSection({ ...req, sectionIds: ['a'] }, sec('a', 'g9')));
  check('an empty selection applies to nothing; a section without an id is never selected', !requirementAppliesToSection({ ...req, sectionIds: [] }, sec('a')) && !requirementAppliesToSection({ ...req, sectionIds: ['a'] }, { gradeId: 'g8', streamId: null }));
  check('the generation normalizer exports the SAME function', normalizerRule === requirementAppliesToSection);
  check('the loader mapping: ALL_SECTIONS -> null, SELECTED_SECTIONS -> sorted ids', requirementSectionIds({ sectionScope: 'ALL_SECTIONS', sections: [] }) === null && requirementSectionIds({ sectionScope: 'SELECTED_SECTIONS', sections: [{ sectionId: 'b' }, { sectionId: 'a' }] })!.join() === 'a,b');
}

section('READINESS AND GENERATION INTERPRET THE CURRICULUM IDENTICALLY');
{
  const SCHOOL = 's1';
  const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
  const snap = (over: Partial<GenerationSnapshot>): GenerationSnapshot => ({
    schoolId: SCHOOL, academicYear: { id: 'ay', name: 'Y', status: 'DRAFT' },
    schedule: { periodsPerDay: 8, workingDays: days, periods: Array.from({ length: 8 }, (_, i) => ({ periodNumber: i + 1 })) },
    grades: [{ id: 'g6', name: 'G6', displayOrder: 1 }, { id: 'g11', name: 'G11', displayOrder: 2 }],
    streams: [{ id: 'sci', gradeId: 'g11', name: 'Science', code: 'SCI' }, { id: 'com', gradeId: 'g11', name: 'Commerce', code: 'COM' }],
    sections: [
      { id: 's6a', gradeId: 'g6', streamId: null, name: 'A', code: 'A' }, { id: 's6b', gradeId: 'g6', streamId: null, name: 'B', code: 'B' },
      { id: 's11s', gradeId: 'g11', streamId: 'sci', name: 'A', code: 'A' }, { id: 's11c', gradeId: 'g11', streamId: 'com', name: 'A', code: 'A' },
    ],
    subjects: ['eng', 'sci', 'comp', 'phy', 'acc'].map((id) => ({ id, name: id, code: id.toUpperCase(), schoolId: SCHOOL })),
    requirements: [
      { id: 'r-eng6', gradeId: 'g6', streamId: null, subjectId: 'eng', periodsPerWeek: 6 },
      { id: 'r-sci6', gradeId: 'g6', streamId: null, subjectId: 'sci', periodsPerWeek: 5 },
      { id: 'r-comp6', gradeId: 'g6', streamId: null, subjectId: 'comp', periodsPerWeek: 2, sectionIds: ['s6a'] }, // only section A
      { id: 'r-eng11s', gradeId: 'g11', streamId: 'sci', subjectId: 'eng', periodsPerWeek: 4 },
      { id: 'r-eng11c', gradeId: 'g11', streamId: 'com', subjectId: 'eng', periodsPerWeek: 4 },
      { id: 'r-phy11', gradeId: 'g11', streamId: 'sci', subjectId: 'phy', periodsPerWeek: 6 },
      { id: 'r-acc11', gradeId: 'g11', streamId: 'com', subjectId: 'acc', periodsPerWeek: 6 },
    ],
    assignments: [],
    teachers: ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => ({ id, schoolId: SCHOOL, name: id, isActive: true })),
    teacherSubjects: ['eng', 'sci', 'comp', 'phy', 'acc'].flatMap((subjectId, i) => [{ teacherId: `t${i + 1}`, subjectId, gradeIds: [], allGrades: true }, { teacherId: 't6', subjectId, gradeIds: [], allGrades: true }]),
    timingEvents: [],
    ...over,
  });
  const s = snap({});
  const report = analyzeFeasibility(s as SchedulingInput);
  const norm = normalizeProblem(s);
  check('the configuration is READY and normalizes', report.status === 'READY' && norm.ok, JSON.stringify(report.errors.map((e) => e.code)));
  if (norm.ok) {
    const lessonsOf = (sectionId: string) => norm.problem.core.assignments.filter((a) => a.sectionId === sectionId).map((a) => a.subjectRequirementId).sort().join();
    check('a lower grade without streams: its sections get the common subjects (English, Science) and nothing from a stream', lessonsOf('s6b') === 'r-eng6,r-sci6');
    check('the restricted subject (Computer) is scheduled for section A only', lessonsOf('s6a') === 'r-comp6,r-eng6,r-sci6');
    check('stream-specific subjects reach only their own stream: Physics for Science, Accountancy for Commerce, English for both (each at its own period count)', lessonsOf('s11s') === 'r-eng11s,r-phy11' && lessonsOf('s11c') === 'r-acc11,r-eng11c');
    check('readiness demand equals what generation schedules: total periods and entries agree', report.summary.totalDemandPeriods === norm.problem.derived.expectedEntryCount && norm.problem.derived.expectedEntryCount === (6 + 5 + 2) + (6 + 5) + (4 + 6) + (4 + 6));
    const perSection = (id: string) => report.breakdown.sections.find((x) => x.id === id)?.demandPeriods;
    check('and per section: A 13, B 11, Science 10, Commerce 10', perSection('s6a') === 13 && perSection('s6b') === 11 && perSection('s11s') === 10 && perSection('s11c') === 10);
    check('the same subject has different periods in different grades/streams without any duplication of the subject', norm.problem.core.assignments.filter((a) => a.subjectId === 'eng').map((a) => a.periodsPerWeek).sort().join() === '4,4,6,6');
  }
  // an explicit assignment outside the restricted sections is a blocker in BOTH readiness and generation
  const outside = snap({ assignments: [{ id: 'x', sectionId: 's6b', subjectRequirementId: 'r-comp6', teacherId: 't3' }] });
  const rep2 = analyzeFeasibility(outside as SchedulingInput);
  const n2 = normalizeProblem(outside);
  check('a teacher assignment of a restricted subject to a section outside its scope is rejected by readiness (INVALID_ASSIGNMENT, SECTION_NOT_IN_SCOPE) and by generation (REQUIREMENT_SECTION_MISMATCH)', rep2.errors.some((e) => e.code === 'INVALID_ASSIGNMENT' && (e.details.reasons as string[]).includes('SECTION_NOT_IN_SCOPE')) && !n2.ok && n2.issues.some((i) => i.code === 'REQUIREMENT_SECTION_MISMATCH'));
  // a subject nobody can teach stays a blocker; the curriculum alone never creates a qualification
  const noTeacher = snap({ teacherSubjects: [] });
  check('a curriculum subject with no eligible teacher is still a blocker (NO_ELIGIBLE_TEACHER); the curriculum never becomes a qualification', analyzeFeasibility(noTeacher as SchedulingInput).errors.some((e) => e.code === 'NO_ELIGIBLE_TEACHER') && !normalizeProblem(noTeacher).ok);
  check('a restricted requirement with an empty selection schedules nothing (no demand, no phantom lessons)', (() => { const r = normalizeProblem(snap({ requirements: [{ id: 'r', gradeId: 'g6', streamId: null, subjectId: 'eng', periodsPerWeek: 3, sectionIds: [] }], sections: [{ id: 's6a', gradeId: 'g6', streamId: null, name: 'A', code: 'A' }] })); return !r.ok && r.issues.some((i) => i.code === 'NO_ASSIGNMENTS'); })());
}

section('CLASSIFICATION (derived from the data, nothing built in)');
{
  const row = (id: string, gradeId: string, streamId: string | null, subjectId: string, scope: 'ALL_SECTIONS' | 'SELECTED_SECTIONS' = 'ALL_SECTIONS', sectionIds: string[] = []): ReqRow => ({ id, gradeId, streamId, subjectId, periodsPerWeek: 4, isOptional: false, sectionScope: scope, sectionIds });
  const rows = [
    row('1', 'g6', null, 'sci'), row('2', 'g7', null, 'sci'), row('3', 'g8', null, 'sci'),            // one general Science across 6-8
    row('4', 'g9', null, 'phy'), row('5', 'g10', null, 'phy'), row('6', 'g9', null, 'bio'),            // Physics in 9 and 10; Biology only in 9
    row('7', 'g11', 'sci', 'phy'), row('8', 'g11', 'com', 'acc'), row('9', 'g11', 'hum', 'hist'),       // stream subjects
    row('10', 'g11', 'sci', 'eng'), row('11', 'g11', 'com', 'eng'), row('12', 'g11', 'hum', 'eng'),     // English in every stream
    row('13', 'g6', null, 'comp', 'SELECTED_SECTIONS', ['a']),                                           // section specific
  ];
  const ctx = buildClassifyContext(rows, new Map([['g11', 3]]));
  const c = (id: string) => classifyRequirement(rows.find((r) => r.id === id)!, ctx);
  check('Science shared by Classes 6-8 is COMMON', c('1') === 'COMMON' && c('3') === 'COMMON');
  check('Physics in Classes 9 and 10 (and 11 Science) is COMMON; Biology in Class 9 only is GRADE_SPECIFIC', c('4') === 'COMMON' && c('6') === 'GRADE_SPECIFIC');
  check('a subject of only some streams (Accountancy, History) is STREAM_SPECIFIC', c('8') === 'STREAM_SPECIFIC' && c('9') === 'STREAM_SPECIFIC');
  check('a subject required by EVERY stream of the grade (English) is not stream-specific: it is COMMON when other grades use it, else GRADE_SPECIFIC', c('10') === 'GRADE_SPECIFIC' && classifyRequirement(rows.find((r) => r.id === '10')!, buildClassifyContext([...rows, row('99', 'g6', null, 'eng')], new Map([['g11', 3]]))) === 'COMMON');
  check('a requirement for selected sections is SECTION_SPECIFIC', c('13') === 'SECTION_SPECIFIC');
  check('section demand adds only the requirements that apply to that section', sectionDemand({ id: 'a' }, [rows[0]!, rows[12]!]) === 8 && sectionDemand({ id: 'b' }, [rows[0]!, rows[12]!]) === 4);
}

section('PLANNING A CURRICULUM CHANGE');
{
  const line = (subjectId: string, periodsPerWeek: number, o: Partial<{ isOptional: boolean; sectionScope: 'ALL_SECTIONS' | 'SELECTED_SECTIONS'; sectionIds: string[] }> = {}) => normalizeLine({ subjectId, periodsPerWeek, ...o });
  const existing = [{ id: 'r1', ...line('eng', 5) }, { id: 'r2', ...line('sci', 4) }, { id: 'r3', ...line('art', 1) }];
  const plan = planCurriculum(existing, [line('eng', 6), line('sci', 4), line('phy', 3)]);
  check('create / update / remove / unchanged are told apart by subject', plan.create.map((l) => l.subjectId).join() === 'phy' && plan.update.map((u) => u.id).join() === 'r1' && plan.update[0]!.changes.join() === 'periodsPerWeek' && plan.remove.map((r) => r.subjectId).join() === 'art' && plan.unchanged === 1);
  check('the same list again changes nothing (idempotent)', (() => { const p = planCurriculum(existing, existing.map(({ id: _id, ...l }) => l)); return p.create.length === 0 && p.update.length === 0 && p.remove.length === 0 && p.unchanged === 3; })());
  check('changes name exactly what changed: periods, optional label, sections', changesBetween(line('a', 3), line('a', 4)).join() === 'periodsPerWeek' && changesBetween(line('a', 3), line('a', 3, { isOptional: true })).join() === 'isOptional' && changesBetween(line('a', 3), line('a', 3, { sectionScope: 'SELECTED_SECTIONS', sectionIds: ['x'] })).join() === 'sections' && changesBetween(line('a', 3, { sectionScope: 'SELECTED_SECTIONS', sectionIds: ['x', 'y'] }), line('a', 3, { sectionScope: 'SELECTED_SECTIONS', sectionIds: ['y', 'x'] })).length === 0);
  check('normalizeLine: ALL_SECTIONS drops stray section ids; SELECTED dedupes and sorts', normalizeLine({ subjectId: 'a', periodsPerWeek: 1, sectionScope: 'ALL_SECTIONS', sectionIds: ['z'] }).sectionIds.length === 0 && normalizeLine({ subjectId: 'a', periodsPerWeek: 1, sectionScope: 'SELECTED_SECTIONS', sectionIds: ['b', 'a', 'b'] }).sectionIds.join() === 'a,b');
}

section('VALIDATION (the same rules as the single-requirement endpoint)');
{
  const ok = (v: unknown) => curriculumLineSchema.safeParse(v).success;
  check('a line needs a subject id and whole periods 1..40', ok({ subjectId: U(1), periodsPerWeek: 5 }) && !ok({ subjectId: 'x', periodsPerWeek: 5 }) && !ok({ subjectId: U(1), periodsPerWeek: 0 }) && !ok({ subjectId: U(1), periodsPerWeek: 41 }) && !ok({ subjectId: U(1), periodsPerWeek: '5' }) && !ok({ subjectId: U(1), periodsPerWeek: 2.5 }));
  check('section scope: SELECTED needs sections, ALL must not carry any, sections without a scope are ambiguous', ok({ subjectId: U(1), periodsPerWeek: 2, sectionScope: 'SELECTED_SECTIONS', sectionIds: [U(2)] }) && !ok({ subjectId: U(1), periodsPerWeek: 2, sectionScope: 'SELECTED_SECTIONS' }) && !ok({ subjectId: U(1), periodsPerWeek: 2, sectionScope: 'SELECTED_SECTIONS', sectionIds: [] }) && !ok({ subjectId: U(1), periodsPerWeek: 2, sectionScope: 'ALL_SECTIONS', sectionIds: [U(2)] }) && !ok({ subjectId: U(1), periodsPerWeek: 2, sectionIds: [U(2)] }) && ok({ subjectId: U(1), periodsPerWeek: 2, isOptional: true }) && !ok({ subjectId: U(1), periodsPerWeek: 2, isOptional: 'yes' }));
  check('the scope rules are the same function on the single-requirement endpoint', scopeIssues({ sectionScope: 'SELECTED_SECTIONS' }).length === 1 && createSubjectRequirementSchema.safeParse({ gradeId: U(1), subjectId: U(2), periodsPerWeek: 3, sectionScope: 'SELECTED_SECTIONS' }).success === false && createSubjectRequirementSchema.safeParse({ gradeId: U(1), subjectId: U(2), periodsPerWeek: 3 }).success === true);
  check('PATCH accepts periods, the label or the scope alone, but not nothing', updateSubjectRequirementSchema.safeParse({ isOptional: true }).success && updateSubjectRequirementSchema.safeParse({ periodsPerWeek: 4 }).success && !updateSubjectRequirementSchema.safeParse({}).success && !updateSubjectRequirementSchema.safeParse({ sectionIds: [U(1)] }).success);
  check('the replace body: a list of lines, optional stream and dryRun, at most 60 subjects', replaceCurriculumSchema.safeParse({ requirements: [] }).success && replaceCurriculumSchema.safeParse({ streamId: U(1), dryRun: true, requirements: [{ subjectId: U(2), periodsPerWeek: 3 }] }).success && !replaceCurriculumSchema.safeParse({ requirements: Array.from({ length: 61 }, (_, i) => ({ subjectId: U(i + 1), periodsPerWeek: 1 })) }).success && !replaceCurriculumSchema.safeParse({}).success && !replaceCurriculumSchema.safeParse({ streamId: 'x', requirements: [] }).success);
  check('the copy body needs both grades', copyCurriculumSchema.safeParse({ fromGradeId: U(1), toGradeId: U(2) }).success && !copyCurriculumSchema.safeParse({ fromGradeId: U(1) }).success);
}

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
