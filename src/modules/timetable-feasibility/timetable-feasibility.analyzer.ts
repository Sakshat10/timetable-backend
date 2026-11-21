// ---------------------------------------------------------------------------
// Pure feasibility analyzer. NO database access: it turns one plain SchedulingInput snapshot into a
// report, so it is deterministic and table-testable. The loader (timetable-feasibility.loader.ts) is
// the only code that reads the database.
//
// DEMAND EXPANSION RULE
//   A SubjectRequirement is defined ONCE per grade (and optional stream) but applies INDEPENDENTLY to
//   every matching section. A requirement R applies to a section S when
//       R.gradeId === S.gradeId  AND  R.streamId === S.streamId   (null equals null)
//   which is exactly the rule Module 8 enforces when creating an assignment. Therefore
//       demand(S) = sum of R.periodsPerWeek over the requirements that apply to S
//   and Mathematics at 5 periods for Grade 8 sections A, B and C is 15 periods of demand, NOT 5.
//   An applicable (section, requirement) pair is one "unit" of demand; it is assigned when a
//   SectionSubjectTeacher row exists for it.
//
// WHAT A POSITIVE RESULT MEANS
//   Every check below is a deterministic precondition (a necessary condition). READY means none of them
//   failed. It does not prove a timetable exists. See NOT_CHECKED.
// ---------------------------------------------------------------------------
import { maxFlowBipartite } from './timetable-feasibility.maxflow.js';
import { allocateTeachers } from './teacher-allocator.js';
import { requirementAppliesToSection } from './requirement-applicability.js';
import {
  MAX_TEACHER_PERIODS_PER_WEEK,
  NOT_CHECKED,
  READY_MEANING,
  type FeasibilityEntity,
  type FeasibilityIssue,
  type FeasibilityReportCore,
  type SectionBreakdownRow,
  type SubjectGroupBreakdownRow,
  type TeacherBreakdownRow,
} from './timetable-feasibility.schema.js';

// ---------------------------------------------------------------------------
// Input snapshot (plain data)
// ---------------------------------------------------------------------------
export interface SchedulingInput {
  schoolId: string;
  academicYear: { id: string; name: string; status: 'DRAFT' | 'ACTIVE' | 'COMPLETED' };
  /** null when the academic year has no schedule configuration. */
  schedule: null | {
    periodsPerDay: number;
    workingDays: string[];
    periods: Array<{ periodNumber: number }>;
  };
  grades: Array<{ id: string; name: string; displayOrder: number }>;
  streams: Array<{ id: string; gradeId: string; name: string; code: string }>;
  sections: Array<{ id: string; gradeId: string; streamId: string | null; name: string; code: string }>;
  subjects: Array<{ id: string; name: string; code: string; schoolId: string }>;
  requirements: Array<{
    id: string;
    gradeId: string;
    streamId: string | null;
    subjectId: string;
    periodsPerWeek: number;
    /** null/absent: every section of the grade/stream; a list: only those sections (SELECTED_SECTIONS). */
    sectionIds?: string[] | null;
  }>;
  assignments: Array<{ id: string; sectionId: string; subjectRequirementId: string; teacherId: string }>;
  /** The school's teachers plus any teacher referenced by an assignment. */
  teachers: Array<{ id: string; schoolId: string; name: string; isActive: boolean }>;
  /** Teacher <-> subject links with the grades (of this academic year) the link is eligible for. */
  teacherSubjects: Array<{ teacherId: string; subjectId: string; gradeIds: string[]; /** gradeScope ALL_GRADES: eligible for every grade regardless of gradeIds. Absent means SELECTED_GRADES. */ allGrades?: boolean }>;
}

type Section = SchedulingInput['sections'][number];
type Requirement = SchedulingInput['requirements'][number];
type Assignment = SchedulingInput['assignments'][number];

interface Unit {
  section: Section;
  requirement: Requirement;
  assignment: Assignment | null;
}

const NO_STREAM = '∅';
const streamKey = (gradeId: string, streamId: string | null): string => `${gradeId}|${streamId ?? NO_STREAM}`;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------
export function analyzeFeasibility(raw: SchedulingInput): FeasibilityReportCore {
  const input = sortInput(raw);
  const errors: FeasibilityIssue[] = [];
  const warnings: FeasibilityIssue[] = [];

  const gradeOrder = new Map(input.grades.map((g, i) => [g.id, i]));
  const gradeById = new Map(input.grades.map((g) => [g.id, g]));
  const streamById = new Map(input.streams.map((s) => [s.id, s]));
  const subjectById = new Map(input.subjects.map((s) => [s.id, s]));
  const sectionById = new Map(input.sections.map((s) => [s.id, s]));
  const requirementById = new Map(input.requirements.map((r) => [r.id, r]));
  const teacherById = new Map(input.teachers.map((t) => [t.id, t]));
  const teacherGrades = new Map<string, Set<string>>();
  const allGradesLinks = new Set<string>();
  for (const link of input.teacherSubjects) {
    const key = `${link.teacherId}|${link.subjectId}`;
    const set = teacherGrades.get(key) ?? new Set<string>();
    link.gradeIds.forEach((g) => set.add(g));
    teacherGrades.set(key, set);
    if (link.allGrades === true) allGradesLinks.add(key);
  }
  // A teacher may teach subject+grade with an explicit eligibility row, or when the link was explicitly set to ALL_GRADES.
  const canTeach = (teacherId: string, subjectId: string, gradeId: string): boolean => {
    const key = `${teacherId}|${subjectId}`;
    return allGradesLinks.has(key) || (teacherGrades.get(key)?.has(gradeId) ?? false);
  };

  const gradeName = (id: string): string => gradeById.get(id)?.name ?? id;
  const subjectName = (id: string): string => subjectById.get(id)?.name ?? id;
  const sectionLabel = (s: Section): string => {
    const stream = s.streamId ? streamById.get(s.streamId) : undefined;
    return `${gradeName(s.gradeId)} / ${s.name}${stream ? ` (${stream.name})` : ''}`;
  };
  const requirementLabel = (r: Requirement): string => {
    const stream = r.streamId ? streamById.get(r.streamId) : undefined;
    return `${gradeName(r.gradeId)} · ${subjectName(r.subjectId)}${stream ? ` (${stream.name})` : ''}`;
  };
  const teacherLabel = (id: string): string => teacherById.get(id)?.name ?? id;

  const addError = (
    code: FeasibilityIssue['code'],
    entity: FeasibilityEntity,
    message: string,
    hint: string,
    details: Record<string, unknown> = {}
  ): void => { errors.push({ code, severity: 'ERROR', message, hint, entity, details }); };
  const addWarning = (
    code: FeasibilityIssue['code'],
    entity: FeasibilityEntity,
    message: string,
    hint: string,
    details: Record<string, unknown> = {}
  ): void => { warnings.push({ code, severity: 'WARNING', message, hint, entity, details }); };

  // -------------------------------------------------------------------------
  // 1. Schedule grid
  // -------------------------------------------------------------------------
  const yearEntity: FeasibilityEntity = { type: 'ACADEMIC_YEAR', id: input.academicYear.id, label: input.academicYear.name };
  const scheduleEntity: FeasibilityEntity = { type: 'SCHEDULE_CONFIG', id: null, label: `Schedule of ${input.academicYear.name}` };
  const workingDays = input.schedule?.workingDays.length ?? 0;
  const periodsPerDay = input.schedule?.periodsPerDay ?? 0;
  let weeklySlots: number | null = null;

  if (input.schedule === null) {
    addError('SCHEDULE_CONFIG_MISSING', yearEntity,
      'This academic year has no schedule configuration, so there is no time grid to place periods into.',
      'Create the schedule configuration (working days, periods per day and period times) for this academic year.');
  } else {
    if (workingDays === 0) {
      addError('NO_WORKING_DAYS', scheduleEntity,
        'The schedule configuration has no working days.', 'Configure at least one working day.');
    }
    if (periodsPerDay === 0 || input.schedule.periods.length === 0) {
      addError('NO_PERIODS', scheduleEntity,
        'The schedule configuration has no teaching periods.', 'Configure at least one period per day.');
    }
    const numbers = input.schedule.periods.map((p) => p.periodNumber).sort((a, b) => a - b);
    const contiguous = numbers.every((n, i) => n === i + 1);
    if (input.schedule.periods.length > 0 && periodsPerDay > 0 && (numbers.length !== periodsPerDay || !contiguous)) {
      addError('SCHEDULE_CONFIG_INVALID', scheduleEntity,
        `The stored schedule is inconsistent: periodsPerDay is ${periodsPerDay} but ${numbers.length} period(s) are stored` +
          (contiguous ? '.' : ' and the period numbers are not 1..N.'),
        'Re-save the schedule configuration so periodsPerDay matches the periods.',
        { periodsPerDay, storedPeriodNumbers: numbers });
    } else if (workingDays > 0 && periodsPerDay > 0 && input.schedule.periods.length > 0) {
      weeklySlots = workingDays * periodsPerDay;
    }
  }
  // A teacher cannot teach more periods than the week has slots, nor more than the normal workload.
  const teacherCapacity = weeklySlots === null ? MAX_TEACHER_PERIODS_PER_WEEK : Math.min(MAX_TEACHER_PERIODS_PER_WEEK, weeklySlots);
  const capacityLimitSource = teacherCapacity === MAX_TEACHER_PERIODS_PER_WEEK ? 'MAX_WORKLOAD' : 'WEEKLY_SLOTS';

  if (input.academicYear.status !== 'DRAFT') {
    addWarning('ACADEMIC_YEAR_NOT_DRAFT', yearEntity,
      `The academic year is ${input.academicYear.status}, so its configuration is read-only; issues found here cannot be fixed through the API.`,
      'Run feasibility on a DRAFT academic year to act on the results.', { status: input.academicYear.status });
  }

  // -------------------------------------------------------------------------
  // 2. Structure: which requirements apply to which sections (demand expansion)
  // -------------------------------------------------------------------------
  const requirementsByKey = new Map<string, Requirement[]>();
  for (const r of input.requirements) {
    const key = streamKey(r.gradeId, r.streamId);
    requirementsByKey.set(key, [...(requirementsByKey.get(key) ?? []), r]);
  }
  const assignmentByPair = new Map<string, Assignment>();
  for (const a of input.assignments) assignmentByPair.set(`${a.sectionId}|${a.subjectRequirementId}`, a);

  const units: Unit[] = [];
  const unitsBySection = new Map<string, Unit[]>();
  const sectionsWithRequirement = new Set<string>();
  for (const section of input.sections) {
    const applicable = (requirementsByKey.get(streamKey(section.gradeId, section.streamId)) ?? []).filter((r) => requirementAppliesToSection(r, section));
    const list: Unit[] = applicable.map((requirement) => ({
      section,
      requirement,
      assignment: assignmentByPair.get(`${section.id}|${requirement.id}`) ?? null,
    }));
    unitsBySection.set(section.id, list);
    units.push(...list);
    applicable.forEach((r) => sectionsWithRequirement.add(r.id));
  }

  const totalDemand = units.reduce((sum, u) => sum + u.requirement.periodsPerWeek, 0);
  const assignedUnits = units.filter((u) => u.assignment !== null);
  const assignedDemand = assignedUnits.reduce((sum, u) => sum + u.requirement.periodsPerWeek, 0);
  const unassignedDemand = totalDemand - assignedDemand;

  if (input.sections.length === 0) {
    addError('NO_SECTIONS', yearEntity,
      'This academic year has no sections, so there is nothing to schedule.',
      'Create grades and sections for this academic year.');
  } else if (totalDemand === 0) {
    addError('NO_SUBJECT_REQUIREMENTS', yearEntity,
      'No subject requirement applies to any section, so there is nothing to schedule.',
      'Create subject requirements for the grades (and streams) that have sections.');
  }

  // Sections no requirement applies to (warning: sections cannot be removed or deactivated).
  const requirementsByGrade = new Map<string, Requirement[]>();
  for (const r of input.requirements) requirementsByGrade.set(r.gradeId, [...(requirementsByGrade.get(r.gradeId) ?? []), r]);
  for (const section of input.sections) {
    if ((unitsBySection.get(section.id) ?? []).length > 0) continue;
    const gradeRequirements = requirementsByGrade.get(section.gradeId) ?? [];
    const reason =
      gradeRequirements.length === 0 ? 'GRADE_HAS_NO_REQUIREMENTS'
      : section.streamId === null ? 'SECTION_NOT_IN_STREAM'
      : gradeRequirements.some((r) => r.streamId === null) && !gradeRequirements.some((r) => r.streamId === section.streamId)
        ? 'REQUIREMENTS_ARE_NOT_STREAM_SPECIFIC'
        : 'NO_REQUIREMENT_FOR_THIS_STREAM';
    const explanation: Record<string, string> = {
      GRADE_HAS_NO_REQUIREMENTS: 'its grade has no subject requirements',
      SECTION_NOT_IN_STREAM: 'the grade\'s requirements are stream-specific but this section is not in a stream',
      REQUIREMENTS_ARE_NOT_STREAM_SPECIFIC: 'the grade\'s requirements are not stream-specific but this section is in a stream',
      NO_REQUIREMENT_FOR_THIS_STREAM: 'no requirement exists for this section\'s stream',
    };
    addWarning('SECTION_HAS_NO_REQUIREMENTS', { type: 'SECTION', id: section.id, label: sectionLabel(section) },
      `${sectionLabel(section)} has no subject requirement that applies to it: ${explanation[reason]}. It contributes no teaching demand.`,
      'Add the missing subject requirements for this section\'s grade and stream, or ignore it if the section is intentionally unused.',
      { reason, gradeId: section.gradeId, streamId: section.streamId });
  }

  // Requirements that apply to no section (warning).
  const sectionsByGrade = new Map<string, Section[]>();
  for (const s of input.sections) sectionsByGrade.set(s.gradeId, [...(sectionsByGrade.get(s.gradeId) ?? []), s]);
  for (const r of input.requirements) {
    if (sectionsWithRequirement.has(r.id)) continue;
    const gradeSections = sectionsByGrade.get(r.gradeId) ?? [];
    const reason =
      gradeSections.length === 0 ? 'GRADE_HAS_NO_SECTIONS'
      : r.streamId === null ? 'GRADE_SECTIONS_ARE_ALL_IN_STREAMS'
      : 'NO_SECTION_IN_THIS_STREAM';
    const explanation: Record<string, string> = {
      GRADE_HAS_NO_SECTIONS: 'its grade has no sections',
      GRADE_SECTIONS_ARE_ALL_IN_STREAMS: 'it is not stream-specific but every section of the grade is in a stream',
      NO_SECTION_IN_THIS_STREAM: 'no section exists in its stream',
    };
    addWarning('REQUIREMENT_HAS_NO_SECTIONS', { type: 'REQUIREMENT', id: r.id, label: requirementLabel(r) },
      `${requirementLabel(r)} (${r.periodsPerWeek}/week) applies to no section: ${explanation[reason]}. It contributes no teaching demand.`,
      'Create the matching sections, or ignore the requirement if it is intentionally unused.',
      { reason, periodsPerWeek: r.periodsPerWeek });
  }

  // Grades mixing streamed and non-streamed sections (legacy data).
  for (const grade of input.grades) {
    const gradeSections = sectionsByGrade.get(grade.id) ?? [];
    const streamed = gradeSections.filter((s) => s.streamId !== null).length;
    if (streamed > 0 && streamed < gradeSections.length) {
      addWarning('MIXED_GRADE_MODE', { type: 'GRADE', id: grade.id, label: grade.name },
        `${grade.name} has both streamed (${streamed}) and non-streamed (${gradeSections.length - streamed}) sections. Demand is still computed per section by exact stream matching.`,
        'Normally a grade is either fully streamed or fully non-streamed; review the grade\'s sections and requirements.',
        { streamedSections: streamed, nonStreamedSections: gradeSections.length - streamed });
    }
  }

  // -------------------------------------------------------------------------
  // 3. Section capacity
  // -------------------------------------------------------------------------
  const sectionDemand = new Map<string, number>();
  for (const section of input.sections) {
    const demand = (unitsBySection.get(section.id) ?? []).reduce((sum, u) => sum + u.requirement.periodsPerWeek, 0);
    sectionDemand.set(section.id, demand);
    if (weeklySlots === null || demand === 0) continue;
    const entity: FeasibilityEntity = { type: 'SECTION', id: section.id, label: sectionLabel(section) };
    if (demand > weeklySlots) {
      addError('SECTION_CAPACITY_EXCEEDED', entity,
        `${sectionLabel(section)} needs ${demand} teaching periods per week but the schedule only has ${weeklySlots} slots.`,
        `Reduce this section's subject requirements by ${demand - weeklySlots} period(s) or add working days / periods per day.`,
        {
          demandPeriods: demand, weeklySlots, excess: demand - weeklySlots,
          requirements: (unitsBySection.get(section.id) ?? []).map((u) => ({
            requirementId: u.requirement.id, subject: subjectName(u.requirement.subjectId), periodsPerWeek: u.requirement.periodsPerWeek,
          })),
        });
    } else if (demand === weeklySlots) {
      addWarning('SECTION_AT_FULL_CAPACITY', entity,
        `${sectionLabel(section)} uses all ${weeklySlots} weekly slots, leaving no free period.`,
        'Generation is possible but has no flexibility for this section.', { demandPeriods: demand, weeklySlots });
    }
  }

  // -------------------------------------------------------------------------
  // 4. Assignments: structural validity, then teacher-level checks
  // -------------------------------------------------------------------------
  for (const a of input.assignments) {
    const section = sectionById.get(a.sectionId);
    const requirement = requirementById.get(a.subjectRequirementId);
    const teacher = teacherById.get(a.teacherId);
    const reasons: string[] = [];
    if (!requirement) reasons.push('REQUIREMENT_NOT_IN_ACADEMIC_YEAR');
    if (section && requirement) {
      if (requirement.gradeId !== section.gradeId) reasons.push('GRADE_MISMATCH');
      else if (requirement.streamId !== section.streamId) reasons.push('STREAM_MISMATCH');
      else if (!requirementAppliesToSection(requirement, section)) reasons.push('SECTION_NOT_IN_SCOPE');
    }
    if (!teacher) reasons.push('TEACHER_NOT_FOUND');
    else if (teacher.schoolId !== input.schoolId) reasons.push('CROSS_SCHOOL_TEACHER');
    if (requirement) {
      const subject = subjectById.get(requirement.subjectId);
      if (!subject || subject.schoolId !== input.schoolId) reasons.push('CROSS_SCHOOL_SUBJECT');
    }
    if (reasons.length > 0 && section) {
      addError('INVALID_ASSIGNMENT', { type: 'ASSIGNMENT', id: a.id, label: `${sectionLabel(section)} → ${teacherLabel(a.teacherId)}` },
        `The assignment of ${teacherLabel(a.teacherId)} to ${sectionLabel(section)} is structurally invalid (${reasons.join(', ')}).`,
        'Delete this assignment and create a correct one.', { assignmentId: a.id, reasons });
    }
  }

  const loadByTeacher = new Map<string, number>();
  const assignmentCountByTeacher = new Map<string, number>();
  for (const u of assignedUnits) {
    const t = u.assignment!.teacherId;
    loadByTeacher.set(t, (loadByTeacher.get(t) ?? 0) + u.requirement.periodsPerWeek);
    assignmentCountByTeacher.set(t, (assignmentCountByTeacher.get(t) ?? 0) + 1);
  }

  // Inactive assigned teachers (grouped per teacher).
  const inactiveUnits = new Map<string, Unit[]>();
  for (const u of assignedUnits) {
    const t = teacherById.get(u.assignment!.teacherId);
    if (t && t.schoolId === input.schoolId && !t.isActive) inactiveUnits.set(t.id, [...(inactiveUnits.get(t.id) ?? []), u]);
  }
  for (const [teacherId, list] of [...inactiveUnits.entries()].sort((a, b) => compare(teacherLabel(a[0]), teacherLabel(b[0])) || compare(a[0], b[0]))) {
    addError('INACTIVE_ASSIGNED_TEACHER', { type: 'TEACHER', id: teacherId, label: teacherLabel(teacherId) },
      `${teacherLabel(teacherId)} is inactive but is still assigned to ${list.length} section subject(s) (${list.reduce((s, u) => s + u.requirement.periodsPerWeek, 0)} periods/week).`,
      'Reactivate the teacher, or replace them on each of these assignments with an active eligible teacher.',
      {
        assignedPeriods: list.reduce((s, u) => s + u.requirement.periodsPerWeek, 0),
        assignments: list.map((u) => ({ assignmentId: u.assignment!.id, section: sectionLabel(u.section), subject: subjectName(u.requirement.subjectId), periodsPerWeek: u.requirement.periodsPerWeek })),
      });
  }

  // Assigned teachers that are not (or no longer) eligible.
  for (const u of assignedUnits) {
    const t = teacherById.get(u.assignment!.teacherId);
    if (!t || t.schoolId !== input.schoolId || !t.isActive) continue;
    const grades = teacherGrades.get(`${t.id}|${u.requirement.subjectId}`);
    const reason = !grades ? 'NO_TEACHER_SUBJECT' : !canTeach(t.id, u.requirement.subjectId, u.section.gradeId) ? 'NOT_ELIGIBLE_FOR_GRADE' : null;
    if (reason) {
      addError('ASSIGNED_TEACHER_NOT_ELIGIBLE', { type: 'ASSIGNMENT', id: u.assignment!.id, label: `${sectionLabel(u.section)} → ${t.name}` },
        `${t.name} is assigned to ${subjectName(u.requirement.subjectId)} in ${sectionLabel(u.section)} but is ${reason === 'NO_TEACHER_SUBJECT' ? 'not linked to that subject' : 'not eligible for that grade'}.`,
        'Make the teacher eligible for the subject and grade, or assign a different teacher.',
        { assignmentId: u.assignment!.id, reason, teacherId: t.id, subjectId: u.requirement.subjectId, gradeId: u.section.gradeId });
    }
  }

  // Sections without an explicit teacher, grouped per requirement. NOT a blocker: explicit assignments are optional overrides, and
  // generation chooses a teacher among the eligible ones (section 6 below checks that this is actually possible).
  const missingByRequirement = new Map<string, Unit[]>();
  for (const u of units) {
    if (u.assignment === null) missingByRequirement.set(u.requirement.id, [...(missingByRequirement.get(u.requirement.id) ?? []), u]);
  }
  const missingEntries = [...missingByRequirement.entries()]
    .map(([id, list]) => ({ requirement: requirementById.get(id)!, list }))
    .sort((a, b) => compare(requirementLabel(a.requirement), requirementLabel(b.requirement)) || compare(a.requirement.id, b.requirement.id));
  for (const { requirement, list } of missingEntries) {
    const periods = list.length * requirement.periodsPerWeek;
    addWarning('TEACHER_AUTO_ASSIGNED', { type: 'REQUIREMENT', id: requirement.id, label: requirementLabel(requirement) },
      `${requirementLabel(requirement)} (${requirement.periodsPerWeek}/week) has no explicit teacher in ${list.length} section(s): ${list.map((u) => u.section.name).join(', ')}. Generation will choose an eligible teacher automatically.`,
      'Optional: assign a specific teacher to a section to override the automatic choice.',
      {
        periodsPerWeek: requirement.periodsPerWeek, unassignedPeriods: periods,
        sections: list.map((u) => ({ sectionId: u.section.id, label: sectionLabel(u.section) })),
      });
  }

  // -------------------------------------------------------------------------
  // 5. Teacher capacity
  // -------------------------------------------------------------------------
  const schoolTeacherIds = new Set(input.teachers.filter((t) => t.schoolId === input.schoolId).map((t) => t.id));
  for (const [teacherId, load] of [...loadByTeacher.entries()].sort((a, b) => compare(teacherLabel(a[0]), teacherLabel(b[0])) || compare(a[0], b[0]))) {
    if (!schoolTeacherIds.has(teacherId)) continue;
    const entity: FeasibilityEntity = { type: 'TEACHER', id: teacherId, label: teacherLabel(teacherId) };
    if (load > teacherCapacity) {
      addError('TEACHER_CAPACITY_EXCEEDED', entity,
        `${teacherLabel(teacherId)} is assigned ${load} periods per week but can teach at most ${teacherCapacity}` +
          (capacityLimitSource === 'WEEKLY_SLOTS' ? ` (the schedule only has ${weeklySlots} weekly slots).` : ` (the ${MAX_TEACHER_PERIODS_PER_WEEK}-period weekly workload limit).`),
        `Reassign at least ${load - teacherCapacity} period(s) of this teacher's sections to other eligible teachers.`,
        { assignedPeriods: load, capacity: teacherCapacity, excess: load - teacherCapacity, limitSource: capacityLimitSource, maxWorkload: MAX_TEACHER_PERIODS_PER_WEEK, weeklySlots });
    } else if (load === teacherCapacity && load > 0) {
      addWarning('TEACHER_AT_FULL_CAPACITY', entity,
        `${teacherLabel(teacherId)} is assigned exactly ${load} periods, their full weekly capacity.`,
        'Generation is possible but leaves this teacher no slack.', { assignedPeriods: load, capacity: teacherCapacity });
    }
  }

  // A single requirement larger than a teacher's capacity can never be given to one teacher.
  for (const r of input.requirements) {
    if (!sectionsWithRequirement.has(r.id) || r.periodsPerWeek <= teacherCapacity) continue;
    addError('REQUIREMENT_EXCEEDS_TEACHER_CAPACITY', { type: 'REQUIREMENT', id: r.id, label: requirementLabel(r) },
      `${requirementLabel(r)} requires ${r.periodsPerWeek} periods per week from one teacher, but a teacher can teach at most ${teacherCapacity}.`,
      `Lower this requirement to at most ${teacherCapacity} periods per week.`,
      { periodsPerWeek: r.periodsPerWeek, capacity: teacherCapacity, limitSource: capacityLimitSource });
  }

  // -------------------------------------------------------------------------
  // 6. Eligible-teacher capacity for UNASSIGNED demand
  // -------------------------------------------------------------------------
  interface Group { key: string; gradeId: string; subjectId: string; demand: number; sections: Set<string>; eligible: string[] }
  const groups = new Map<string, Group>();
  for (const u of units) {
    if (u.assignment !== null) continue;
    const key = `${u.requirement.gradeId}|${u.requirement.subjectId}`;
    const group = groups.get(key) ?? { key, gradeId: u.requirement.gradeId, subjectId: u.requirement.subjectId, demand: 0, sections: new Set<string>(), eligible: [] };
    group.demand += u.requirement.periodsPerWeek;
    group.sections.add(u.section.id);
    groups.set(key, group);
  }
  const remaining = (teacherId: string): number => Math.max(0, teacherCapacity - (loadByTeacher.get(teacherId) ?? 0));
  const activeSchoolTeachers = input.teachers.filter((t) => t.schoolId === input.schoolId && t.isActive);
  const eligibleFor = (gradeId: string, subjectId: string): string[] =>
    activeSchoolTeachers.filter((t) => canTeach(t.id, subjectId, gradeId)).map((t) => t.id);

  const orderedGroups = [...groups.values()].sort((a, b) =>
    (gradeOrder.get(a.gradeId) ?? 0) - (gradeOrder.get(b.gradeId) ?? 0) || compare(subjectName(a.subjectId), subjectName(b.subjectId)) || compare(a.key, b.key));
  const flowCandidates: Group[] = [];
  for (const group of orderedGroups) {
    group.eligible = eligibleFor(group.gradeId, group.subjectId);
    const entity: FeasibilityEntity = { type: 'SUBJECT_GROUP', id: group.key, label: `${gradeName(group.gradeId)} · ${subjectName(group.subjectId)}` };
    if (group.eligible.length === 0) {
      addError('NO_ELIGIBLE_TEACHER', entity,
        `${entity.label} has ${group.demand} unassigned period(s) in ${group.sections.size} section(s) but no active teacher is eligible for this subject and grade.`,
        'Make at least one active teacher eligible for this subject and grade (teacher subject + grade eligibility).',
        { unassignedPeriods: group.demand, sections: group.sections.size });
      continue;
    }
    const available = group.eligible.reduce((sum, id) => sum + remaining(id), 0);
    if (group.demand > available) {
      addError('ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT', entity,
        `${entity.label} needs ${group.demand} more period(s) but its ${group.eligible.length} eligible teacher(s) only have ${available} period(s) of capacity left.`,
        `Make more teachers eligible, or reduce this subject's demand by ${group.demand - available} period(s).`,
        {
          kind: 'GROUP', unassignedPeriods: group.demand, remainingCapacity: available, shortfall: group.demand - available,
          eligibleTeachers: group.eligible.map((id) => ({ teacherId: id, name: teacherLabel(id), currentLoad: loadByTeacher.get(id) ?? 0, remainingCapacity: remaining(id) })),
        });
      continue;
    }
    flowCandidates.push(group);
  }

  // Pooled check across groups that individually look fine (max-flow RELAXATION, necessary condition only).
  if (flowCandidates.length > 0) {
    const teacherIds = [...new Set(flowCandidates.flatMap((g) => g.eligible))].sort((a, b) => compare(teacherLabel(a), teacherLabel(b)) || compare(a, b));
    const teacherIndex = new Map(teacherIds.map((id, i) => [id, i]));
    const edges: Array<[number, number]> = [];
    flowCandidates.forEach((g, gi) => [...g.eligible].sort((a, b) => compare(a, b)).forEach((t) => edges.push([gi, teacherIndex.get(t)!])));
    const result = maxFlowBipartite({
      demands: flowCandidates.map((g) => g.demand),
      capacities: teacherIds.map((id) => remaining(id)),
      edges,
    });
    if (result.maxFlow < result.totalDemand) {
      const badGroups = result.bottleneckGroups.map((i) => flowCandidates[i]!);
      const badTeachers = result.bottleneckTeachers.map((i) => teacherIds[i]!);
      const demand = badGroups.reduce((s, g) => s + g.demand, 0);
      const capacity = badTeachers.reduce((s, id) => s + remaining(id), 0);
      const labels = badGroups.map((g) => `${gradeName(g.gradeId)} · ${subjectName(g.subjectId)}`);
      addError('ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT', { type: 'SUBJECT_GROUPS', id: null, label: labels.join(', ') },
        `${badGroups.length} subject group(s) compete for the same teachers: together they need ${demand} period(s) but their eligible teachers only have ${capacity} left (${demand - capacity} short).`,
        'Make more teachers eligible for these subject/grade combinations, or reduce their demand.',
        {
          kind: 'POOLED', unassignedPeriods: demand, remainingCapacity: capacity, shortfall: demand - capacity,
          groups: badGroups.map((g) => ({ gradeId: g.gradeId, grade: gradeName(g.gradeId), subjectId: g.subjectId, subject: subjectName(g.subjectId), unassignedPeriods: g.demand })),
          teachers: badTeachers.map((id) => ({ teacherId: id, name: teacherLabel(id), currentLoad: loadByTeacher.get(id) ?? 0, remainingCapacity: remaining(id) })),
          note: 'Computed with a max-flow relaxation that treats demand as divisible: it proves impossibility but its absence does not prove feasibility.',
        });
    }
  }

  // The pooled check above is a relaxation (divisible demand). Generation allocates whole (section, subject) units with the SAME allocator,
  // so run it here: if it cannot place every unit, generation would fail the same way, and the report says so instead of claiming READY.
  const pooledFailed = errors.some((e) => e.code === 'ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT' && e.details.kind === 'POOLED');
  if (flowCandidates.length > 0 && !pooledFailed) {
    const inFlow = new Set(flowCandidates.map((g) => g.key));
    const allocUnits = units
      .filter((u) => u.assignment === null && inFlow.has(`${u.requirement.gradeId}|${u.requirement.subjectId}`) && u.requirement.periodsPerWeek <= teacherCapacity)
      .map((u) => ({ key: `${u.section.id}|${u.requirement.id}`, periods: u.requirement.periodsPerWeek, candidates: eligibleFor(u.requirement.gradeId, u.requirement.subjectId), unit: u }));
    const allocation = allocateTeachers({ units: allocUnits, teacherCapacity, fixedLoad: loadByTeacher });
    const failedByRequirement = new Map<string, Unit[]>();
    for (const key of allocation.unplaceable) {
      const unit = allocUnits.find((a) => a.key === key)!.unit;
      failedByRequirement.set(unit.requirement.id, [...(failedByRequirement.get(unit.requirement.id) ?? []), unit]);
    }
    for (const [requirementId, list] of [...failedByRequirement.entries()].sort((a, b) => compare(requirementLabel(requirementById.get(a[0])!), requirementLabel(requirementById.get(b[0])!)) || compare(a[0], b[0]))) {
      const requirement = requirementById.get(requirementId)!;
      addError('TEACHER_ALLOCATION_FAILED', { type: 'REQUIREMENT', id: requirementId, label: requirementLabel(requirement) },
        `${requirementLabel(requirement)} (${requirement.periodsPerWeek}/week): ${list.length} section(s) could not be given an eligible teacher without exceeding the weekly capacity of ${teacherCapacity} periods, although the teachers' total remaining capacity is large enough on paper.`,
        'Make more teachers eligible for this subject and grade, assign teachers explicitly to some sections, or reduce the demand.',
        { periodsPerWeek: requirement.periodsPerWeek, sections: list.map((u) => ({ sectionId: u.section.id, label: sectionLabel(u.section) })), capacity: teacherCapacity,
          note: 'Whole sections cannot be split between teachers; the automatic allocation is a heuristic and may fail on tightly packed schools that a manual assignment could solve.' });
    }
  }

  // -------------------------------------------------------------------------
  // 7. Breakdown
  // -------------------------------------------------------------------------
  const sectionRows: SectionBreakdownRow[] = input.sections.map((s) => {
    const list = unitsBySection.get(s.id) ?? [];
    const demand = sectionDemand.get(s.id) ?? 0;
    const assigned = list.filter((u) => u.assignment !== null).reduce((sum, u) => sum + u.requirement.periodsPerWeek, 0);
    return {
      id: s.id, label: sectionLabel(s), gradeId: s.gradeId, gradeName: gradeName(s.gradeId),
      streamId: s.streamId, streamName: s.streamId ? (streamById.get(s.streamId)?.name ?? null) : null,
      requirementCount: list.length, demandPeriods: demand, assignedPeriods: assigned, unassignedPeriods: demand - assigned, weeklySlots,
    };
  });

  const teacherRows: TeacherBreakdownRow[] = [...loadByTeacher.keys()]
    .map((id): TeacherBreakdownRow => {
      const t = teacherById.get(id);
      return {
        id, name: t?.name ?? id, isActive: t?.isActive ?? false, belongsToSchool: t?.schoolId === input.schoolId,
        assignmentCount: assignmentCountByTeacher.get(id) ?? 0, assignedPeriods: loadByTeacher.get(id) ?? 0,
        capacity: teacherCapacity, remainingCapacity: remaining(id),
      };
    })
    .sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id));

  const groupAll = new Map<string, { gradeId: string; subjectId: string; sections: Set<string>; demand: number; assigned: number }>();
  for (const u of units) {
    const key = `${u.requirement.gradeId}|${u.requirement.subjectId}`;
    const g = groupAll.get(key) ?? { gradeId: u.requirement.gradeId, subjectId: u.requirement.subjectId, sections: new Set<string>(), demand: 0, assigned: 0 };
    g.sections.add(u.section.id);
    g.demand += u.requirement.periodsPerWeek;
    if (u.assignment !== null) g.assigned += u.requirement.periodsPerWeek;
    groupAll.set(key, g);
  }
  const groupRows: SubjectGroupBreakdownRow[] = [...groupAll.entries()]
    .map(([, g]): SubjectGroupBreakdownRow => {
      const eligible = eligibleFor(g.gradeId, g.subjectId);
      return {
        gradeId: g.gradeId, gradeName: gradeName(g.gradeId), subjectId: g.subjectId, subjectName: subjectName(g.subjectId),
        sectionCount: g.sections.size, demandPeriods: g.demand, assignedPeriods: g.assigned, unassignedPeriods: g.demand - g.assigned,
        eligibleTeacherCount: eligible.length, eligibleRemainingCapacity: eligible.reduce((s, id) => s + remaining(id), 0),
      };
    })
    .sort((a, b) => (gradeOrder.get(a.gradeId) ?? 0) - (gradeOrder.get(b.gradeId) ?? 0) || compare(a.subjectName, b.subjectName) || compare(a.subjectId, b.subjectId));

  // -------------------------------------------------------------------------
  // 8. Result (deterministic ordering)
  // -------------------------------------------------------------------------
  const issueOrder = (a: FeasibilityIssue, b: FeasibilityIssue): number =>
    compare(a.code, b.code) || compare(a.entity.label, b.entity.label) || compare(a.entity.id ?? '', b.entity.id ?? '') || compare(JSON.stringify(a.details), JSON.stringify(b.details));
  errors.sort(issueOrder);
  warnings.sort(issueOrder);

  return {
    academicYear: input.academicYear,
    status: errors.length === 0 ? 'READY' : 'NOT_READY',
    statusMeaning: READY_MEANING,
    limits: { maxTeacherPeriodsPerWeek: MAX_TEACHER_PERIODS_PER_WEEK, weeklySlots, effectiveTeacherCapacity: teacherCapacity },
    summary: {
      workingDays, periodsPerDay, weeklySlots,
      grades: input.grades.length, sections: input.sections.length, requirements: input.requirements.length, assignments: input.assignments.length,
      totalDemandPeriods: totalDemand, assignedPeriods: assignedDemand, unassignedPeriods: unassignedDemand,
      teachersWithAssignments: loadByTeacher.size, errorCount: errors.length, warningCount: warnings.length,
    },
    errors,
    warnings,
    breakdown: { sections: sectionRows, teachers: teacherRows, subjectGroups: groupRows },
    notChecked: NOT_CHECKED,
  };
}

// Sort every input collection so the report never depends on the order rows were read in.
function sortInput(raw: SchedulingInput): SchedulingInput {
  const byId = <T extends { id: string }>(list: T[]): T[] => [...list].sort((a, b) => compare(a.id, b.id));
  const gradeIndex = new Map([...raw.grades].sort((a, b) => a.displayOrder - b.displayOrder || compare(a.name, b.name) || compare(a.id, b.id)).map((g, i) => [g.id, i]));
  return {
    ...raw,
    grades: [...raw.grades].sort((a, b) => a.displayOrder - b.displayOrder || compare(a.name, b.name) || compare(a.id, b.id)),
    streams: byId(raw.streams),
    sections: [...raw.sections].sort((a, b) => (gradeIndex.get(a.gradeId) ?? 0) - (gradeIndex.get(b.gradeId) ?? 0) || compare(a.name, b.name) || compare(a.code, b.code) || compare(a.id, b.id)),
    subjects: byId(raw.subjects),
    requirements: [...raw.requirements].sort((a, b) => compare(a.subjectId, b.subjectId) || compare(a.id, b.id)),
    assignments: byId(raw.assignments),
    teachers: byId(raw.teachers),
    teacherSubjects: [...raw.teacherSubjects].sort((a, b) => compare(`${a.teacherId}|${a.subjectId}`, `${b.teacherId}|${b.subjectId}`)),
  };
}
