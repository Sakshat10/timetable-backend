// Pure analyzer + max-flow tests for Module 10 (timetable feasibility). NO database, NO server.
// Permanent regression test: run with   npx tsx test-timetable-feasibility-analyzer.ts
import {
  analyzeFeasibility,
  type SchedulingInput,
} from './src/modules/timetable-feasibility/timetable-feasibility.analyzer.js';
import { maxFlowBipartite } from './src/modules/timetable-feasibility/timetable-feasibility.maxflow.js';
import type { FeasibilityIssue } from './src/modules/timetable-feasibility/timetable-feasibility.schema.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------
const SCHOOL = 'school1';
const DAYS5 = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
const DAYS6 = [...DAYS5, 'SATURDAY'];
const schedule = (days: string[], ppd: number) => ({
  periodsPerDay: ppd, workingDays: days, periods: Array.from({ length: ppd }, (_, i) => ({ periodNumber: i + 1 })),
});

interface Opts extends Partial<SchedulingInput> {}
function input(over: Opts = {}): SchedulingInput {
  return {
    schoolId: SCHOOL,
    academicYear: { id: 'ay1', name: '2030', status: 'DRAFT' },
    schedule: schedule(DAYS5, 6), // 30 weekly slots
    grades: [{ id: 'g8', name: 'Grade 8', displayOrder: 1 }],
    streams: [],
    sections: [],
    subjects: [
      { id: 'math', name: 'Mathematics', code: 'MATH', schoolId: SCHOOL },
      { id: 'sci', name: 'Science', code: 'SCI', schoolId: SCHOOL },
      { id: 'eng', name: 'English', code: 'ENG', schoolId: SCHOOL },
    ],
    requirements: [], assignments: [], teachers: [], teacherSubjects: [],
    ...over,
  };
}
const secs = (gradeId: string, names: string[], streamId: string | null = null) =>
  names.map((n) => ({ id: `s${gradeId}${n}${streamId ?? ''}`, gradeId, streamId, name: `Sec ${n}`, code: n }));
const sid = (gradeId: string, n: string, streamId: string | null = null) => `s${gradeId}${n}${streamId ?? ''}`;
const req = (id: string, gradeId: string, subjectId: string, periods: number, streamId: string | null = null) => ({ id, gradeId, streamId, subjectId, periodsPerWeek: periods });
const teacher = (id: string, over: Partial<SchedulingInput['teachers'][number]> = {}) => ({ id, schoolId: SCHOOL, name: `Teacher ${id}`, isActive: true, ...over });
const link = (teacherId: string, subjectId: string, gradeIds: string[]) => ({ teacherId, subjectId, gradeIds });
const asg = (id: string, sectionId: string, requirementId: string, teacherId: string) => ({ id, sectionId, subjectRequirementId: requirementId, teacherId });
const codes = (issues: FeasibilityIssue[]): string[] => issues.map((i) => i.code);
const has = (issues: FeasibilityIssue[], code: string): boolean => issues.some((i) => i.code === code);
const find = (issues: FeasibilityIssue[], code: string): FeasibilityIssue | undefined => issues.find((i) => i.code === code);

// A fully valid Grade 8 / sections A,B,C / Mathematics 5 / each section assigned to a teacher
function readyBase(): SchedulingInput {
  return input({
    sections: secs('g8', ['A', 'B', 'C']),
    requirements: [req('rm', 'g8', 'math', 5)],
    teachers: [teacher('t1'), teacher('t2'), teacher('t3')],
    teacherSubjects: [link('t1', 'math', ['g8']), link('t2', 'math', ['g8']), link('t3', 'math', ['g8'])],
    assignments: [asg('a1', sid('g8', 'A'), 'rm', 't1'), asg('a2', sid('g8', 'B'), 'rm', 't2'), asg('a3', sid('g8', 'C'), 'rm', 't3')],
  });
}

// ===========================================================================
section('DEMAND EXPANSION: a requirement applies independently to every matching section');
{
  const r = analyzeFeasibility(input({ sections: secs('g8', ['A', 'B', 'C']), requirements: [req('rm', 'g8', 'math', 5)] }));
  check('one requirement (5/week) + 3 matching sections = 15 periods of demand, not 5', r.summary.totalDemandPeriods === 15, String(r.summary.totalDemandPeriods));
  check('  each section carries its own 5 periods', r.breakdown.sections.every((s) => s.demandPeriods === 5) && r.breakdown.sections.length === 3);
  check('  the subject group shows 3 sections and 15 periods', r.breakdown.subjectGroups.length === 1 && r.breakdown.subjectGroups[0]!.sectionCount === 3 && r.breakdown.subjectGroups[0]!.demandPeriods === 15);
  check('  there is 1 requirement but 15 periods', r.summary.requirements === 1 && r.summary.totalDemandPeriods === 15);
  check('  none assigned: 0 assigned, 15 unassigned', r.summary.assignedPeriods === 0 && r.summary.unassignedPeriods === 15);
  const auto = r.warnings.filter((e) => e.code === 'TEACHER_AUTO_ASSIGNED');
  check('  no explicit teacher is NOT a blocker any more: no MISSING_TEACHER_ASSIGNMENT error', !has(r.errors, 'MISSING_TEACHER_ASSIGNMENT'));
  check('  one grouped TEACHER_AUTO_ASSIGNED warning listing all 3 sections and 15 unassigned periods', auto.length === 1 && (auto[0]!.details.sections as unknown[]).length === 3 && auto[0]!.details.unassignedPeriods === 15);
  check('  but with nobody eligible it is still NOT_READY (NO_ELIGIBLE_TEACHER)', has(r.errors, 'NO_ELIGIBLE_TEACHER') && r.status === 'NOT_READY');
}
{
  const r = analyzeFeasibility(readyBase());
  check('all sections assigned: total 15, assigned 15, unassigned 0', r.summary.totalDemandPeriods === 15 && r.summary.assignedPeriods === 15 && r.summary.unassignedPeriods === 0);
  check('  no MISSING_TEACHER_ASSIGNMENT', !has(r.errors, 'MISSING_TEACHER_ASSIGNMENT'));
  check('  READY with no errors', r.status === 'READY' && r.errors.length === 0, JSON.stringify(codes(r.errors)));
}
{
  const base = readyBase();
  const r = analyzeFeasibility({ ...base, assignments: base.assignments.filter((a) => a.sectionId !== sid('g8', 'C')) });
  check('A and B assigned, C not: totalDemand 15, assignedDemand 10, unassignedDemand 5', r.summary.totalDemandPeriods === 15 && r.summary.assignedPeriods === 10 && r.summary.unassignedPeriods === 5, JSON.stringify(r.summary));
  const auto = r.warnings.find((e) => e.code === 'TEACHER_AUTO_ASSIGNED')!;
  check('  the auto-assigned warning names only section C with 5 unassigned periods', (auto.details.sections as Array<{ sectionId: string }>).map((s) => s.sectionId).join() === sid('g8', 'C') && auto.details.unassignedPeriods === 5);
  check('  READY: an eligible teacher (t3) exists for section C, no error', r.status === 'READY' && r.errors.length === 0, JSON.stringify(codes(r.errors)));
  const rowC = r.breakdown.sections.find((s) => s.id === sid('g8', 'C'))!;
  check('  section C row: demand 5, assigned 0, unassigned 5', rowC.demandPeriods === 5 && rowC.assignedPeriods === 0 && rowC.unassignedPeriods === 5);
}
{
  const g11 = [{ id: 'sci', gradeId: 'g11', name: 'Science', code: 'SCI' }, { id: 'com', gradeId: 'g11', name: 'Commerce', code: 'COM' }];
  const r = analyzeFeasibility(input({
    grades: [{ id: 'g11', name: 'Grade 11', displayOrder: 1 }], streams: g11,
    subjects: [{ id: 'phy', name: 'Physics', code: 'PHY', schoolId: SCHOOL }, { id: 'acc', name: 'Accountancy', code: 'ACC', schoolId: SCHOOL }],
    sections: [...secs('g11', ['A', 'B'], 'sci'), ...secs('g11', ['A'], 'com')],
    requirements: [req('rp', 'g11', 'phy', 6, 'sci'), req('ra', 'g11', 'acc', 6, 'com')],
  }));
  check('streamed requirements apply only to matching stream sections: 2 Science sections x6 + 1 Commerce section x6 = 18', r.summary.totalDemandPeriods === 18, String(r.summary.totalDemandPeriods));
  const phy = r.breakdown.subjectGroups.find((g) => g.subjectId === 'phy')!;
  const acc = r.breakdown.subjectGroups.find((g) => g.subjectId === 'acc')!;
  check('  Physics (Science stream) covers 2 sections / 12 periods', phy.sectionCount === 2 && phy.demandPeriods === 12);
  check('  Accountancy (Commerce stream) covers 1 section / 6 periods', acc.sectionCount === 1 && acc.demandPeriods === 6);
  check('  every section has exactly one applicable requirement (6 periods)', r.breakdown.sections.every((s) => s.requirementCount === 1 && s.demandPeriods === 6));
  check('  the Science requirement does not leak onto the Commerce section', r.breakdown.sections.filter((s) => s.streamName === 'Commerce').every((s) => s.demandPeriods === 6));
}
{
  const r = analyzeFeasibility(readyBase());
  check('multiple teachers across sections: 3 teachers with 5 periods each', r.breakdown.teachers.length === 3 && r.breakdown.teachers.every((t) => t.assignedPeriods === 5 && t.assignmentCount === 1) && r.summary.teachersWithAssignments === 3);
}
{
  const base = readyBase();
  const r = analyzeFeasibility({ ...base, assignments: base.assignments.map((a) => ({ ...a, teacherId: 't1' })) });
  check('same teacher on 3 sections: one teacher row, 3 assignments, 15 periods', r.breakdown.teachers.length === 1 && r.breakdown.teachers[0]!.assignmentCount === 3 && r.breakdown.teachers[0]!.assignedPeriods === 15);
  check('  a teacher teaching several sections is NOT rejected (no collision logic here)', r.status === 'READY');
}
{
  const r = analyzeFeasibility(input({ sections: secs('g8', ['A', 'B']), requirements: [req('rm', 'g8', 'math', 5), req('rs', 'g8', 'sci', 4), req('re', 'g8', 'eng', 6)] }));
  check('several requirements: section demand is the sum of its applicable requirements (15) and total is 30', r.breakdown.sections.every((s) => s.demandPeriods === 15 && s.requirementCount === 3) && r.summary.totalDemandPeriods === 30);
}

// ===========================================================================
section('SCHEDULE');
{
  const r = analyzeFeasibility(input({ schedule: null, sections: secs('g8', ['A']), requirements: [req('rm', 'g8', 'math', 5)] }));
  check('no schedule: SCHEDULE_CONFIG_MISSING', has(r.errors, 'SCHEDULE_CONFIG_MISSING') && r.status === 'NOT_READY');
  check('  slot capacity is unknown (null) and no SECTION_CAPACITY error is invented', r.limits.weeklySlots === null && !has(r.errors, 'SECTION_CAPACITY_EXCEEDED') && r.limits.effectiveTeacherCapacity === 32);
}
{
  const r = analyzeFeasibility(input({ schedule: { periodsPerDay: 6, workingDays: [], periods: schedule(DAYS5, 6).periods } }));
  check('no working days: NO_WORKING_DAYS', has(r.errors, 'NO_WORKING_DAYS'));
}
{
  const r = analyzeFeasibility(input({ schedule: { periodsPerDay: 0, workingDays: DAYS5, periods: [] } }));
  check('no periods: NO_PERIODS', has(r.errors, 'NO_PERIODS'));
}
{
  const r = analyzeFeasibility(input({ schedule: { periodsPerDay: 6, workingDays: DAYS5, periods: schedule(DAYS5, 5).periods } }));
  check('periodsPerDay (6) differs from the stored periods (5): SCHEDULE_CONFIG_INVALID, slots unknown', has(r.errors, 'SCHEDULE_CONFIG_INVALID') && r.limits.weeklySlots === null);
}
{
  const r = analyzeFeasibility(input({ schedule: { periodsPerDay: 3, workingDays: DAYS5, periods: [{ periodNumber: 1 }, { periodNumber: 2 }, { periodNumber: 4 }] } }));
  check('non-contiguous period numbers: SCHEDULE_CONFIG_INVALID', has(r.errors, 'SCHEDULE_CONFIG_INVALID'));
}
{
  const r = analyzeFeasibility(input({ schedule: schedule(DAYS6, 8) }));
  check('weekly slots = working days x periodsPerDay (6 x 8 = 48); effective teacher capacity is min(32, 48) = 32', r.limits.weeklySlots === 48 && r.limits.effectiveTeacherCapacity === 32);
  const r2 = analyzeFeasibility(input());
  check('5 x 6 = 30 slots; effective teacher capacity is min(32, 30) = 30', r2.limits.weeklySlots === 30 && r2.limits.effectiveTeacherCapacity === 30);
}

// ===========================================================================
section('STRUCTURE');
check('empty year: NO_SECTIONS', has(analyzeFeasibility(input()).errors, 'NO_SECTIONS'));
{
  const r = analyzeFeasibility(input({ sections: secs('g8', ['A']) }));
  check('sections but no requirements: NO_SUBJECT_REQUIREMENTS', has(r.errors, 'NO_SUBJECT_REQUIREMENTS'));
  check('  and the section is only a warning (GRADE_HAS_NO_REQUIREMENTS)', find(r.warnings, 'SECTION_HAS_NO_REQUIREMENTS')?.details.reason === 'GRADE_HAS_NO_REQUIREMENTS' && !has(r.errors, 'SECTION_HAS_NO_REQUIREMENTS'));
}
{
  const base = readyBase();
  const r = analyzeFeasibility({ ...base, sections: [...base.sections, ...secs('g8', ['Z'], 'sX')], streams: [{ id: 'sX', gradeId: 'g8', name: 'X', code: 'X' }] });
  check('a streamed section in a grade whose requirements are not stream-specific: warning REQUIREMENTS_ARE_NOT_STREAM_SPECIFIC', find(r.warnings, 'SECTION_HAS_NO_REQUIREMENTS')?.details.reason === 'REQUIREMENTS_ARE_NOT_STREAM_SPECIFIC');
  check('  it does not block READY', r.status === 'READY');
  check('  mixed streamed + non-streamed sections: MIXED_GRADE_MODE warning', has(r.warnings, 'MIXED_GRADE_MODE'));
}
{
  const r = analyzeFeasibility(input({ sections: secs('g8', ['A']), requirements: [req('rm', 'g8', 'math', 5, 'sX')], streams: [{ id: 'sX', gradeId: 'g8', name: 'X', code: 'X' }] }));
  check('non-streamed section but stream-specific requirements: SECTION_NOT_IN_STREAM warning', find(r.warnings, 'SECTION_HAS_NO_REQUIREMENTS')?.details.reason === 'SECTION_NOT_IN_STREAM');
  check('  the stream-specific requirement has no section in its stream: NO_SECTION_IN_THIS_STREAM warning', find(r.warnings, 'REQUIREMENT_HAS_NO_SECTIONS')?.details.reason === 'NO_SECTION_IN_THIS_STREAM');
}
{
  const r = analyzeFeasibility(input({ grades: [{ id: 'g8', name: 'Grade 8', displayOrder: 1 }, { id: 'g9', name: 'Grade 9', displayOrder: 2 }], sections: secs('g8', ['A']), requirements: [req('rm', 'g8', 'math', 5), req('r9', 'g9', 'math', 5)] }));
  check('requirement for a grade with no sections: REQUIREMENT_HAS_NO_SECTIONS (GRADE_HAS_NO_SECTIONS), a warning', find(r.warnings, 'REQUIREMENT_HAS_NO_SECTIONS')?.details.reason === 'GRADE_HAS_NO_SECTIONS' && !has(r.errors, 'REQUIREMENT_HAS_NO_SECTIONS'));
  check('  the orphan requirement adds no demand', r.summary.totalDemandPeriods === 5);
}
{
  const r = analyzeFeasibility(input({ sections: [...secs('g8', ['A'], 'sX')], streams: [{ id: 'sX', gradeId: 'g8', name: 'X', code: 'X' }], requirements: [req('rm', 'g8', 'math', 5)] }));
  check('non-stream requirement but all sections are streamed: GRADE_SECTIONS_ARE_ALL_IN_STREAMS warning', find(r.warnings, 'REQUIREMENT_HAS_NO_SECTIONS')?.details.reason === 'GRADE_SECTIONS_ARE_ALL_IN_STREAMS');
}
for (const status of ['ACTIVE', 'COMPLETED'] as const) {
  const r = analyzeFeasibility({ ...readyBase(), academicYear: { id: 'ay1', name: '2030', status } });
  check(`${status} year: analysed normally with an ACADEMIC_YEAR_NOT_DRAFT warning (still READY)`, has(r.warnings, 'ACADEMIC_YEAR_NOT_DRAFT') && r.status === 'READY');
}
check('DRAFT year: no ACADEMIC_YEAR_NOT_DRAFT warning', !has(analyzeFeasibility(readyBase()).warnings, 'ACADEMIC_YEAR_NOT_DRAFT'));

// ===========================================================================
section('SECTION CAPACITY (30 weekly slots)');
const subjectsMany = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `x${n}`, name: `Subject ${n}`, code: `X${n}`, schoolId: SCHOOL }));
const capacityInput = (periods: number[]): SchedulingInput => input({
  subjects: subjectsMany, sections: secs('g8', ['A']),
  requirements: periods.map((p, i) => req(`r${i}`, 'g8', `x${i + 1}`, p)),
});
{
  const under = analyzeFeasibility(capacityInput([5, 5, 5, 5, 5, 4]));
  check('29 periods in 30 slots: no capacity error, no full-capacity warning', !has(under.errors, 'SECTION_CAPACITY_EXCEEDED') && !has(under.warnings, 'SECTION_AT_FULL_CAPACITY'));
  const exact = analyzeFeasibility(capacityInput([5, 5, 5, 5, 5, 5]));
  check('exactly 30 periods in 30 slots: allowed, SECTION_AT_FULL_CAPACITY warning only', !has(exact.errors, 'SECTION_CAPACITY_EXCEEDED') && has(exact.warnings, 'SECTION_AT_FULL_CAPACITY'));
  const over = analyzeFeasibility(capacityInput([5, 5, 5, 5, 5, 5, 1]));
  const issue = find(over.errors, 'SECTION_CAPACITY_EXCEEDED')!;
  check('31 periods in 30 slots: SECTION_CAPACITY_EXCEEDED with excess 1', !!issue && issue.details.excess === 1 && issue.details.demandPeriods === 31 && issue.details.weeklySlots === 30);
}

// ===========================================================================
section('TEACHER CAPACITY');
const loadInput = (periods: number[], sched = schedule(DAYS6, 8)): SchedulingInput => input({
  schedule: sched, sections: secs('g8', periods.map((_, i) => String(i))),
  requirements: periods.map((p, i) => req(`r${i}`, 'g8', `x${i + 1}`, p)).slice(0, 1),
  subjects: subjectsMany,
});
// one subject, N sections each needing P periods, all assigned to t1
const oneTeacher = (sections: number, periods: number, sched = schedule(DAYS6, 8)): SchedulingInput => input({
  schedule: sched, sections: secs('g8', Array.from({ length: sections }, (_, i) => String(i))),
  requirements: [req('rm', 'g8', 'math', periods)], teachers: [teacher('t1')], teacherSubjects: [link('t1', 'math', ['g8'])],
  assignments: Array.from({ length: sections }, (_, i) => asg(`a${i}`, sid('g8', String(i)), 'rm', 't1')),
});
void loadInput;
{
  const ok32 = analyzeFeasibility(oneTeacher(4, 8)); // 32 on a 48-slot grid
  check('teacher load 32 (limit 32): allowed, TEACHER_AT_FULL_CAPACITY warning', !has(ok32.errors, 'TEACHER_CAPACITY_EXCEEDED') && has(ok32.warnings, 'TEACHER_AT_FULL_CAPACITY'));
  const bad33 = analyzeFeasibility(oneTeacher(3, 11)); // 33
  const issue = find(bad33.errors, 'TEACHER_CAPACITY_EXCEEDED')!;
  check('teacher load 33: TEACHER_CAPACITY_EXCEEDED (limitSource MAX_WORKLOAD, excess 1)', !!issue && issue.details.limitSource === 'MAX_WORKLOAD' && issue.details.excess === 1 && issue.details.capacity === 32);
  const slots = analyzeFeasibility(oneTeacher(2, 16, schedule(DAYS5, 6))); // 32 on a 30-slot grid
  const slotIssue = find(slots.errors, 'TEACHER_CAPACITY_EXCEEDED')!;
  check('teacher load 32 on a 30-slot week: exceeds the weekly slots (limitSource WEEKLY_SLOTS, capacity 30)', !!slotIssue && slotIssue.details.limitSource === 'WEEKLY_SLOTS' && slotIssue.details.capacity === 30);
  const edge = analyzeFeasibility(oneTeacher(3, 10, schedule(DAYS5, 6))); // 30 on 30
  check('teacher load 30 on a 30-slot week: allowed (at full capacity warning)', !has(edge.errors, 'TEACHER_CAPACITY_EXCEEDED') && has(edge.warnings, 'TEACHER_AT_FULL_CAPACITY'));
}
{
  const big = analyzeFeasibility(input({ schedule: schedule(DAYS6, 8), sections: secs('g8', ['A']), requirements: [req('rm', 'g8', 'math', 33)] }));
  check('one requirement of 33 periods: REQUIREMENT_EXCEEDS_TEACHER_CAPACITY (a teacher can do at most 32)', has(big.errors, 'REQUIREMENT_EXCEEDS_TEACHER_CAPACITY'));
  const ok = analyzeFeasibility(input({ schedule: schedule(DAYS6, 8), sections: secs('g8', ['A']), requirements: [req('rm', 'g8', 'math', 32)] }));
  check('a requirement of exactly 32 periods is fine for one teacher', !has(ok.errors, 'REQUIREMENT_EXCEEDS_TEACHER_CAPACITY'));
  const unused = analyzeFeasibility(input({ schedule: schedule(DAYS6, 8), sections: secs('g8', ['A']), requirements: [req('rm', 'g8', 'math', 5), req('rbig', 'g9', 'sci', 40)] }));
  check('an oversized requirement that applies to no section adds no error (no demand)', !has(unused.errors, 'REQUIREMENT_EXCEEDS_TEACHER_CAPACITY'));
}

// ===========================================================================
section('ASSIGNED TEACHERS');
{
  const base = readyBase();
  const r = analyzeFeasibility({ ...base, teachers: base.teachers.map((t) => (t.id === 't1' ? { ...t, isActive: false } : t)) });
  const issue = find(r.errors, 'INACTIVE_ASSIGNED_TEACHER')!;
  check('inactive assigned teacher: INACTIVE_ASSIGNED_TEACHER (grouped per teacher), NOT_READY', !!issue && issue.entity.id === 't1' && r.status === 'NOT_READY');
  check('  the assignment still counts as assigned demand (it exists in the data)', r.summary.assignedPeriods === 15);
  const two = analyzeFeasibility({ ...base, assignments: base.assignments.map((a) => ({ ...a, teacherId: 't1' })), teachers: base.teachers.map((t) => (t.id === 't1' ? { ...t, isActive: false } : t)) });
  check('  a teacher inactive on 3 sections yields ONE grouped issue listing 3 assignments', two.errors.filter((e) => e.code === 'INACTIVE_ASSIGNED_TEACHER').length === 1 && (find(two.errors, 'INACTIVE_ASSIGNED_TEACHER')!.details.assignments as unknown[]).length === 3);
}
{
  // gradeScope ALL_GRADES (explicit): eligible for every grade without eligibility rows; SELECTED_GRADES (absent flag) stays strict
  const base = readyBase();
  const allGrades = analyzeFeasibility({ ...base, teacherSubjects: base.teacherSubjects.map((l) => (l.teacherId === 't1' ? { ...l, gradeIds: [], allGrades: true } : l)) });
  check('ALL_GRADES link with no grade rows: assigned teacher is eligible (no ASSIGNED_TEACHER_NOT_ELIGIBLE)', !has(allGrades.errors, 'ASSIGNED_TEACHER_NOT_ELIGIBLE') && allGrades.status === 'READY', JSON.stringify(codes(allGrades.errors)));
  const explicitFalse = analyzeFeasibility({ ...base, teacherSubjects: base.teacherSubjects.map((l) => (l.teacherId === 't1' ? { ...l, gradeIds: [], allGrades: false } : l)) });
  check('allGrades:false with no grade rows is still NOT_ELIGIBLE_FOR_GRADE (missing eligibility is never permission)', find(explicitFalse.errors, 'ASSIGNED_TEACHER_NOT_ELIGIBLE')?.details.reason === 'NOT_ELIGIBLE_FOR_GRADE');
  const noLinkAll = analyzeFeasibility({ ...base, teacherSubjects: base.teacherSubjects.filter((l) => l.teacherId !== 't1').concat([{ teacherId: 't1', subjectId: 'sci', gradeIds: [], allGrades: true }]) });
  check('ALL_GRADES on a different subject does not qualify the teacher for this subject (subject qualification still enforced)', find(noLinkAll.errors, 'ASSIGNED_TEACHER_NOT_ELIGIBLE')?.details.reason === 'NO_TEACHER_SUBJECT');
}
{
  const base = readyBase();
  const noLink = analyzeFeasibility({ ...base, teacherSubjects: base.teacherSubjects.filter((l) => l.teacherId !== 't1') });
  check('assigned teacher with no subject link: ASSIGNED_TEACHER_NOT_ELIGIBLE (NO_TEACHER_SUBJECT)', find(noLink.errors, 'ASSIGNED_TEACHER_NOT_ELIGIBLE')?.details.reason === 'NO_TEACHER_SUBJECT');
  const noGrade = analyzeFeasibility({ ...base, teacherSubjects: base.teacherSubjects.map((l) => (l.teacherId === 't1' ? { ...l, gradeIds: [] } : l)) });
  check('assigned teacher without grade eligibility: ASSIGNED_TEACHER_NOT_ELIGIBLE (NOT_ELIGIBLE_FOR_GRADE)', find(noGrade.errors, 'ASSIGNED_TEACHER_NOT_ELIGIBLE')?.details.reason === 'NOT_ELIGIBLE_FOR_GRADE');
}
{
  const base = readyBase();
  const streamMismatch = analyzeFeasibility({ ...base, streams: [{ id: 'sX', gradeId: 'g8', name: 'X', code: 'X' }], requirements: [...base.requirements, req('rx', 'g8', 'math', 3, 'sX')], assignments: [...base.assignments, asg('bad', sid('g8', 'A'), 'rx', 't1')] });
  check('assignment of a stream requirement to a non-stream section: INVALID_ASSIGNMENT (STREAM_MISMATCH)', (find(streamMismatch.errors, 'INVALID_ASSIGNMENT')?.details.reasons as string[]).includes('STREAM_MISMATCH'));
  const gradeMismatch = analyzeFeasibility({ ...base, grades: [...base.grades, { id: 'g9', name: 'Grade 9', displayOrder: 2 }], requirements: [...base.requirements, req('r9', 'g9', 'math', 3)], assignments: [...base.assignments, asg('bad', sid('g8', 'A'), 'r9', 't1')] });
  check('assignment of another grade\'s requirement: INVALID_ASSIGNMENT (GRADE_MISMATCH)', (find(gradeMismatch.errors, 'INVALID_ASSIGNMENT')?.details.reasons as string[]).includes('GRADE_MISMATCH'));
  const foreign = analyzeFeasibility({ ...base, teachers: base.teachers.map((t) => (t.id === 't1' ? { ...t, schoolId: 'other' } : t)) });
  check('assignment to a teacher of another school: INVALID_ASSIGNMENT (CROSS_SCHOOL_TEACHER)', (find(foreign.errors, 'INVALID_ASSIGNMENT')?.details.reasons as string[]).includes('CROSS_SCHOOL_TEACHER'));
  const outside = analyzeFeasibility({ ...base, assignments: [...base.assignments, asg('bad', sid('g8', 'A'), 'not-in-year', 't1')] });
  check('assignment to a requirement outside the academic year: INVALID_ASSIGNMENT', (find(outside.errors, 'INVALID_ASSIGNMENT')?.details.reasons as string[]).includes('REQUIREMENT_NOT_IN_ACADEMIC_YEAR'));
  check('  structurally invalid assignments never count as assigned demand', outside.summary.assignedPeriods === 15);
}

// ===========================================================================
section('ELIGIBLE-TEACHER CAPACITY (unassigned demand)');
const unassigned = (over: Opts): SchedulingInput => input({ schedule: schedule(DAYS6, 8), sections: secs('g8', ['A', 'B', 'C', 'D']), subjects: [
  { id: 'math', name: 'Mathematics', code: 'MATH', schoolId: SCHOOL }, { id: 'sci', name: 'Science', code: 'SCI', schoolId: SCHOOL }], ...over });
{
  const r = analyzeFeasibility(unassigned({ requirements: [req('rm', 'g8', 'math', 5)] }));
  const issue = find(r.errors, 'NO_ELIGIBLE_TEACHER')!;
  check('unassigned demand with nobody eligible: NO_ELIGIBLE_TEACHER (20 periods, 4 sections)', !!issue && issue.details.unassignedPeriods === 20 && issue.details.sections === 4);
}
{
  // unassigned demand: an ALL_GRADES teacher counts in the eligible pool, a SELECTED_GRADES teacher without rows does not
  const allT = analyzeFeasibility(unassigned({ requirements: [req('rm', 'g8', 'math', 5)], teachers: [teacher('t1')], teacherSubjects: [{ teacherId: 't1', subjectId: 'math', gradeIds: [], allGrades: true }] }));
  check('ALL_GRADES teacher is in the eligible pool (no NO_ELIGIBLE_TEACHER)', !has(allT.errors, 'NO_ELIGIBLE_TEACHER'));
  const selT = analyzeFeasibility(unassigned({ requirements: [req('rm', 'g8', 'math', 5)], teachers: [teacher('t1')], teacherSubjects: [link('t1', 'math', [])] }));
  check('SELECTED_GRADES teacher with no rows is NOT in the pool (NO_ELIGIBLE_TEACHER)', has(selT.errors, 'NO_ELIGIBLE_TEACHER'));
  const wrongSubj = analyzeFeasibility(unassigned({ requirements: [req('rm', 'g8', 'math', 5)], teachers: [teacher('t1')], teacherSubjects: [{ teacherId: 't1', subjectId: 'sci', gradeIds: [], allGrades: true }] }));
  check('ALL_GRADES for another subject does not make the teacher eligible for this one', has(wrongSubj.errors, 'NO_ELIGIBLE_TEACHER'));
}
{
  const eligible = { teachers: [teacher('t1')], teacherSubjects: [link('t1', 'math', ['g8'])] };
  const tooMuch = analyzeFeasibility(unassigned({ requirements: [req('rm', 'g8', 'math', 10)], ...eligible }));  // 40 > 32
  const g = find(tooMuch.errors, 'ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT')!;
  check('one eligible teacher (capacity 32) for 40 unassigned periods: group insufficient (shortfall 8)', !!g && g.details.kind === 'GROUP' && g.details.shortfall === 8 && g.details.remainingCapacity === 32);
  const fits = analyzeFeasibility(unassigned({ requirements: [req('rm', 'g8', 'math', 8)], ...eligible }));  // 32 = 32
  check('exactly enough capacity (32 for 32): no capacity error', !has(fits.errors, 'ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT') && !has(fits.errors, 'NO_ELIGIBLE_TEACHER'));
}
{
  // the teacher already carries 20 elsewhere: remaining 12 < 15 needed
  const r = analyzeFeasibility({
    ...input({ schedule: schedule(DAYS6, 8), grades: [{ id: 'g8', name: 'Grade 8', displayOrder: 1 }, { id: 'g9', name: 'Grade 9', displayOrder: 2 }],
      subjects: [{ id: 'math', name: 'Mathematics', code: 'MATH', schoolId: SCHOOL }, { id: 'sci', name: 'Science', code: 'SCI', schoolId: SCHOOL }],
      sections: [...secs('g8', ['A', 'B', 'C']), ...secs('g9', ['A'])],
      requirements: [req('rm', 'g8', 'math', 5), req('rs', 'g9', 'sci', 20)],
      teachers: [teacher('t1')], teacherSubjects: [link('t1', 'math', ['g8']), link('t1', 'sci', ['g9'])],
      assignments: [asg('a1', sid('g9', 'A'), 'rs', 't1')] }),
  });
  const g = find(r.errors, 'ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT')!;
  check('remaining capacity accounts for the teacher\'s existing load (32 - 20 = 12 < 15)', !!g && g.details.remainingCapacity === 12 && g.details.unassignedPeriods === 15);
}
{
  const r = analyzeFeasibility(unassigned({ requirements: [req('rm', 'g8', 'math', 5)], teachers: [teacher('t1', { isActive: false }), teacher('t2')], teacherSubjects: [link('t1', 'math', ['g8']), link('t2', 'math', ['g9'])] }));
  check('inactive teachers and teachers eligible for another grade do not count as eligible', has(r.errors, 'NO_ELIGIBLE_TEACHER'));
}

// ===========================================================================
section('POOLED CAPACITY (max-flow relaxation)');
{
  const base = unassigned({ requirements: [req('rm', 'g8', 'math', 5), req('rs', 'g8', 'sci', 5)] }); // 20 + 20 unassigned
  const onlyT1 = analyzeFeasibility({ ...base, teachers: [teacher('t1')], teacherSubjects: [link('t1', 'math', ['g8']), link('t1', 'sci', ['g8'])] });
  check('each group fits one teacher (20 <= 32) individually…', !onlyT1.errors.some((e) => e.code === 'ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT' && e.details.kind === 'GROUP'));
  const pooled = onlyT1.errors.find((e) => e.details.kind === 'POOLED')!;
  check('…but together they need 40 of a single teacher\'s 32: POOLED error, shortfall 8', !!pooled && pooled.details.unassignedPeriods === 40 && pooled.details.remainingCapacity === 32 && pooled.details.shortfall === 8);
  check('  the bottleneck names both groups and the shared teacher', (pooled.details.groups as unknown[]).length === 2 && (pooled.details.teachers as Array<{ teacherId: string }>).map((t) => t.teacherId).join() === 't1');
  check('  the message documents that it is a relaxation', String(pooled.details.note).includes('relaxation'));
  const withT2 = analyzeFeasibility({ ...base, teachers: [teacher('t1'), teacher('t2')], teacherSubjects: [link('t1', 'math', ['g8']), link('t1', 'sci', ['g8']), link('t2', 'sci', ['g8'])] });
  check('a second teacher for Science resolves the competition: no capacity error', !has(withT2.errors, 'ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT'));
}
{
  // three groups: Math+Science share t1 (violator); English has its own teacher t3 and must NOT be named
  const base = input({ schedule: schedule(DAYS6, 8), sections: secs('g8', ['A', 'B', 'C', 'D']), subjects: [
    { id: 'math', name: 'Mathematics', code: 'MATH', schoolId: SCHOOL }, { id: 'sci', name: 'Science', code: 'SCI', schoolId: SCHOOL }, { id: 'eng', name: 'English', code: 'ENG', schoolId: SCHOOL }],
    requirements: [req('rm', 'g8', 'math', 5), req('rs', 'g8', 'sci', 5), req('re', 'g8', 'eng', 2)],
    teachers: [teacher('t1'), teacher('t3')], teacherSubjects: [link('t1', 'math', ['g8']), link('t1', 'sci', ['g8']), link('t3', 'eng', ['g8'])] });
  const r = analyzeFeasibility(base);
  const pooled = r.errors.find((e) => e.details.kind === 'POOLED')!;
  check('an unrelated group with its own teacher is not part of the reported bottleneck', !!pooled && (pooled.details.groups as Array<{ subject: string }>).map((g) => g.subject).sort().join() === 'Mathematics,Science');
}

// ===========================================================================
section('MAX-FLOW HELPER');
{
  const r = maxFlowBipartite({ demands: [10, 10], capacities: [10, 10], edges: [[0, 0], [1, 1]] });
  check('independent groups with enough capacity: full flow, no bottleneck', r.maxFlow === 20 && r.bottleneckGroups.length === 0);
  const hall = maxFlowBipartite({ demands: [20, 20], capacities: [32], edges: [[0, 0], [1, 0]] });
  check('two groups sharing one teacher of 32: flow 32 of 40 (Hall violator = both groups)', hall.maxFlow === 32 && hall.totalDemand === 40 && hall.bottleneckGroups.join() === '0,1' && hall.bottleneckTeachers.join() === '0');
  const routed = maxFlowBipartite({ demands: [20, 20], capacities: [32, 10], edges: [[0, 0], [1, 0], [1, 1]] });
  check('group 2 draws 12 from the shared teacher plus 10 from its own: full flow 40, no bottleneck', routed.maxFlow === 40 && routed.bottleneckGroups.length === 0);
  const bound = maxFlowBipartite({ demands: [20, 20], capacities: [32, 5], edges: [[0, 0], [1, 0], [1, 1]] });
  check('capacity-bound: second teacher has only 5 left, flow 37 of 40, bottleneck is both groups', bound.maxFlow === 37 && bound.bottleneckGroups.join() === '0,1' && bound.bottleneckTeachers.join() === '0,1');
  const reroute = maxFlowBipartite({ demands: [20, 12], capacities: [20, 12], edges: [[0, 0], [0, 1], [1, 1]] });
  check('flow reroutes so a flexible group leaves the contested teacher free', reroute.maxFlow === 32 && reroute.bottleneckGroups.length === 0);
  const zero = maxFlowBipartite({ demands: [5], capacities: [0], edges: [[0, 0]] });
  check('a teacher with zero remaining capacity cannot absorb demand', zero.maxFlow === 0 && zero.bottleneckGroups.join() === '0');
  const none = maxFlowBipartite({ demands: [], capacities: [], edges: [] });
  check('empty network: flow 0, no bottleneck', none.maxFlow === 0 && none.bottleneckGroups.length === 0);
  const again = maxFlowBipartite({ demands: [20, 20], capacities: [32], edges: [[0, 0], [1, 0]] });
  check('same input gives the identical result (deterministic)', JSON.stringify(hall) === JSON.stringify(again));
}

// ===========================================================================
section('DETERMINISM and INVARIANTS');
{
  const base = readyBase();
  const withIssues: SchedulingInput = { ...base, assignments: base.assignments.slice(0, 2), teachers: base.teachers.map((t) => (t.id === 't1' ? { ...t, isActive: false } : t)), sections: [...base.sections, ...secs('g8', ['Z'], 'sX')], streams: [{ id: 'sX', gradeId: 'g8', name: 'X', code: 'X' }] };
  const a = analyzeFeasibility(withIssues);
  const shuffled: SchedulingInput = { ...withIssues, sections: [...withIssues.sections].reverse(), requirements: [...withIssues.requirements].reverse(), assignments: [...withIssues.assignments].reverse(), teachers: [...withIssues.teachers].reverse(), teacherSubjects: [...withIssues.teacherSubjects].reverse(), subjects: [...withIssues.subjects].reverse() };
  check('identical report regardless of input row order', JSON.stringify(a) === JSON.stringify(analyzeFeasibility(shuffled)));
  check('calling twice gives an identical report', JSON.stringify(a) === JSON.stringify(analyzeFeasibility(withIssues)));
  check('errors are sorted by code', a.errors.every((e, i) => i === 0 || a.errors[i - 1]!.code <= e.code));
  check('every error/warning has a code, message, hint and entity', [...a.errors, ...a.warnings].every((i) => i.code && i.message && i.hint && i.entity.label));
  check('status is READY exactly when there are no errors', (a.status === 'READY') === (a.errors.length === 0));
  check('notChecked lists what is left to the solver', a.notChecked.length >= 5 && a.notChecked.some((n) => n.includes('collisions')));
  check('statusMeaning states READY does not guarantee a timetable', a.statusMeaning.includes('does NOT guarantee'));
}
{
  // seeded pseudo-random inputs: structural invariants must always hold and the analyzer must never throw
  let seed = 12345;
  const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  let bad = 0;
  for (let i = 0; i < 300; i++) {
    const nSec = rnd(6); const nReq = rnd(5); const nTeacher = rnd(5);
    const subjectsR = [0, 1, 2, 3, 4].map((n) => ({ id: `u${n}`, name: `S${n}`, code: `S${n}`, schoolId: SCHOOL }));
    const sections = secs('g8', Array.from({ length: nSec }, (_, k) => String(k)));
    const requirements = Array.from({ length: nReq }, (_, k) => req(`r${k}`, 'g8', `u${k}`, 1 + rnd(14)));
    const teachers = Array.from({ length: nTeacher }, (_, k) => teacher(`t${k}`, { isActive: rnd(4) !== 0 }));
    const teacherSubjects = teachers.flatMap((t) => subjectsR.filter(() => rnd(2) === 0).map((s) => link(t.id, s.id, rnd(5) === 0 ? [] : ['g8'])));
    const assignments = sections.flatMap((s) => requirements.filter(() => rnd(3) === 0 && nTeacher > 0).map((r) => asg(`a${s.id}${r.id}`, s.id, r.id, `t${rnd(nTeacher)}`)));
    const inp = input({ schedule: rnd(6) === 0 ? null : schedule(DAYS5, 2 + rnd(7)), subjects: subjectsR, sections, requirements, teachers, teacherSubjects, assignments });
    try {
      const r = analyzeFeasibility(inp);
      const sectionSum = r.breakdown.sections.reduce((s, x) => s + x.demandPeriods, 0);
      const ok = r.summary.totalDemandPeriods === sectionSum
        && r.summary.assignedPeriods + r.summary.unassignedPeriods === r.summary.totalDemandPeriods
        && (r.status === 'READY') === (r.errors.length === 0)
        && r.summary.errorCount === r.errors.length && r.summary.warningCount === r.warnings.length
        && r.breakdown.teachers.every((t) => t.assignedPeriods >= 0 && t.remainingCapacity >= 0)
        && JSON.stringify(r) === JSON.stringify(analyzeFeasibility(inp));
      if (!ok) bad++;
    } catch { bad++; }
  }
  check('300 randomized inputs: never throws; total = assigned + unassigned = sum of section demand; READY iff no errors; deterministic', bad === 0, `${bad} violations`);
}

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
