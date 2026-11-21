import { type SchedulingInput } from '../timetable-feasibility/timetable-feasibility.analyzer.js';
import {
  CONTRACT_VERSION,
  DAYS_OF_WEEK,
  MAX_TEACHER_PERIODS_PER_WEEK,
  WEIGHTS_V1,
  WEIGHTS_VERSION,
  type SolverInput,
  type SolverOptions,
  type SolverProblemCore,
} from './timetable-generation.contracts.js';
import { allocateTeachers } from '../timetable-feasibility/teacher-allocator.js';
import { requirementAppliesToSection } from '../timetable-feasibility/requirement-applicability.js';
import { hashJson } from './timetable-generation.hash.js';
import { LOCK_ISSUE_CODES, resolveLocks, type FrozenLock } from './timetable-generation.locks.js';

// ---------------------------------------------------------------------------
// Normalizer: Module 10's scheduling snapshot -> the immutable solver problem.
//
// Pure and deterministic. It is the Module 11 "Stage 1" gate: it re-checks every precondition itself and does
// NOT trust an earlier feasibility report. Anything that would let the solver place a lesson that violates a
// hard rule (wrong teacher, ineligible teacher, inactive teacher, stream mismatch, overload) is rejected here,
// so the solver only ever sees validated (section, subject, teacher, periods) tuples.
// ---------------------------------------------------------------------------

/** The Module 10 snapshot plus the schedule's timing events (breaks, lunch, ...). */
export type GenerationSnapshot = SchedulingInput & {
  /** Only afterPeriodNumber matters: any event in the gap after period k ends a consecutive run there. */
  timingEvents: Array<{ afterPeriodNumber: number }>;
};

export const ISSUE_CODES = [
  'YEAR_NOT_DRAFT',
  'SCHEDULE_MISSING',
  'NO_WORKING_DAYS',
  'INVALID_WORKING_DAY',
  'PERIODS_INVALID',
  'NO_ASSIGNMENTS',
  'DUPLICATE_ASSIGNMENT_ID',
  'DUPLICATE_ASSIGNMENT',
  'UNKNOWN_SECTION',
  'UNKNOWN_REQUIREMENT',
  'UNKNOWN_SUBJECT',
  'UNKNOWN_TEACHER',
  'INVALID_PERIODS_PER_WEEK',
  'REQUIREMENT_SECTION_MISMATCH',
  'SUBJECT_CROSS_SCHOOL',
  'TEACHER_CROSS_SCHOOL',
  'TEACHER_INACTIVE',
  'TEACHER_NOT_ELIGIBLE',
  'NO_ELIGIBLE_TEACHER',
  'TEACHER_ALLOCATION_FAILED',
  'TEACHER_OVER_CAPACITY',
  'SECTION_OVER_CAPACITY',
  // Phase 7E: the frozen locks do not fit the fresh configuration (see timetable-generation.locks.ts)
  ...LOCK_ISSUE_CODES,
] as const;
export type IssueCode = (typeof ISSUE_CODES)[number];

export interface GenerationIssue {
  code: IssueCode;
  message: string;
  entity?: { type: string; id: string };
  details?: Record<string, unknown>;
}

export interface NormalizedProblem {
  schoolId: string;
  academicYear: { id: string; name: string };
  core: SolverProblemCore;
  derived: {
    dayCount: number;
    periodsPerDay: number;
    weeklySlots: number;
    teacherCapacity: number;
    sectionCount: number;
    teacherCount: number;
    assignmentCount: number;
    /** Sum of periodsPerWeek: the exact number of timetable entries a valid timetable contains. */
    expectedEntryCount: number;
  };
  /** sha256 over the canonical problem core (grid, sections, teachers, assignments). Excludes run options. */
  inputHash: string;
}

export type NormalizeResult =
  | { ok: true; problem: NormalizedProblem }
  | { ok: false; issues: GenerationIssue[]; truncated: boolean };

/**
 * A (section, requirement) pair with no explicit section-subject-teacher assignment gets a teacher chosen automatically (see
 * teacher-allocator.ts). Its assignment id is synthetic and deterministic, so the problem, its hash and any lock on it are reproducible.
 * It exists only inside the solver problem: there is no section_subject_teachers row behind it.
 */
export const AUTO_ASSIGNMENT_PREFIX = 'auto:';
export const autoAssignmentId = (sectionId: string, requirementId: string): string => `${AUTO_ASSIGNMENT_PREFIX}${sectionId}:${requirementId}`;
export const isAutoAssignmentId = (assignmentId: string): boolean => assignmentId.startsWith(AUTO_ASSIGNMENT_PREFIX);

const MAX_ISSUES = 200;
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The rule Module 8 enforces on write and Module 10 re-checks: a requirement applies to a section when the grade is the same, the stream is exactly the
 * same (null equals null) and, for a requirement restricted to selected sections, the section is one of them. The single shared definition lives in
 * timetable-feasibility/requirement-applicability.ts.
 */
export { requirementAppliesToSection };

class IssueCollector {
  readonly issues: GenerationIssue[] = [];
  truncated = false;

  add(issue: GenerationIssue): void {
    if (this.issues.length >= MAX_ISSUES) {
      this.truncated = true;
      return;
    }
    this.issues.push(issue);
  }
}

export interface NormalizeOptions {
  /**
   * Phase 7E: locks frozen from a source draft. Validated against THIS snapshot (after every other precondition passed) and, when valid,
   * emitted as core.fixedEntries, so they are part of the input hash. Omitted or empty: the problem and its hash are exactly as before.
   */
  lockedEntries?: readonly FrozenLock[] | undefined;
}

export function normalizeProblem(snapshot: GenerationSnapshot, options: NormalizeOptions = {}): NormalizeResult {
  const out = new IssueCollector();

  if (snapshot.academicYear.status !== 'DRAFT') {
    out.add({
      code: 'YEAR_NOT_DRAFT',
      message: `Timetable generation is only allowed for DRAFT academic years (this one is ${snapshot.academicYear.status})`,
      entity: { type: 'ACADEMIC_YEAR', id: snapshot.academicYear.id },
    });
  }

  // ---- grid ---------------------------------------------------------------
  const schedule = snapshot.schedule;
  if (!schedule) {
    out.add({ code: 'SCHEDULE_MISSING', message: 'The academic year has no schedule configuration' });
    return { ok: false, issues: out.issues, truncated: out.truncated };
  }

  const dayIndexByName = new Map<string, number>(DAYS_OF_WEEK.map((name, index) => [name, index]));
  const workingDays = [...new Set(schedule.workingDays)];
  for (const name of workingDays) {
    if (!dayIndexByName.has(name)) {
      out.add({ code: 'INVALID_WORKING_DAY', message: `Unknown working day "${name}"`, details: { day: name } });
    }
  }
  const sortedDays = workingDays
    .filter((name) => dayIndexByName.has(name))
    .sort((a, b) => dayIndexByName.get(a)! - dayIndexByName.get(b)!);
  if (sortedDays.length === 0) {
    out.add({ code: 'NO_WORKING_DAYS', message: 'The schedule has no working days' });
  }

  const periodNumbers = schedule.periods.map((p) => p.periodNumber).sort((a, b) => a - b);
  const periodsContiguous =
    periodNumbers.length > 0 &&
    periodNumbers.length === schedule.periodsPerDay &&
    periodNumbers.every((n, i) => n === i + 1);
  if (!periodsContiguous) {
    out.add({
      code: 'PERIODS_INVALID',
      message: 'The schedule periods must be numbered 1..periodsPerDay without gaps and match periodsPerDay',
      details: { periodsPerDay: schedule.periodsPerDay, periodNumbers },
    });
  }
  if (sortedDays.length === 0 || !periodsContiguous) {
    return { ok: false, issues: out.issues, truncated: out.truncated };
  }

  const dayCount = sortedDays.length;
  const periodsPerDay = schedule.periodsPerDay;
  const weeklySlots = dayCount * periodsPerDay;
  const teacherCapacity = Math.min(MAX_TEACHER_PERIODS_PER_WEEK, weeklySlots);

  const breakAfter = new Set(snapshot.timingEvents.map((e) => e.afterPeriodNumber));
  const periods = periodNumbers.map((periodNumber) => ({
    periodNumber,
    // The last period has no successor; any timing event in the gap after period k ends the run there.
    continuesIntoNext: periodNumber < periodsPerDay && !breakAfter.has(periodNumber),
  }));

  // ---- lookups --------------------------------------------------------------
  const sections = new Map(snapshot.sections.map((s) => [s.id, s]));
  const requirements = new Map(snapshot.requirements.map((r) => [r.id, r]));
  const subjects = new Map(snapshot.subjects.map((s) => [s.id, s]));
  const teachers = new Map(snapshot.teachers.map((t) => [t.id, t]));
  const eligibility = new Map<string, Set<string>>();
  const allGradesLinks = new Set<string>();
  for (const link of snapshot.teacherSubjects) {
    eligibility.set(`${link.teacherId}|${link.subjectId}`, new Set(link.gradeIds));
    if (link.allGrades === true) allGradesLinks.add(`${link.teacherId}|${link.subjectId}`);
  }

  if (snapshot.assignments.length === 0 && !snapshot.sections.some((section) => snapshot.requirements.some((r) => requirementAppliesToSection(r, section)))) {
    out.add({ code: 'NO_ASSIGNMENTS', message: 'There is nothing to schedule: no section has a subject requirement' });
  }

  // ---- assignments ----------------------------------------------------------
  const seenIds = new Set<string>();
  const seenPairs = new Set<string>();
  const validAssignments: SolverInput['assignments'] = [];
  const teacherLoad = new Map<string, number>();
  const sectionDemand = new Map<string, number>();

  for (const a of snapshot.assignments) {
    const entity = { type: 'ASSIGNMENT', id: a.id };
    let ok = true;

    if (seenIds.has(a.id)) {
      out.add({ code: 'DUPLICATE_ASSIGNMENT_ID', message: `Assignment id ${a.id} appears more than once`, entity });
      continue;
    }
    seenIds.add(a.id);

    const pairKey = `${a.sectionId}|${a.subjectRequirementId}`;
    if (seenPairs.has(pairKey)) {
      out.add({
        code: 'DUPLICATE_ASSIGNMENT',
        message: 'A section and requirement must have exactly one assignment',
        entity,
        details: { sectionId: a.sectionId, subjectRequirementId: a.subjectRequirementId },
      });
      continue;
    }
    seenPairs.add(pairKey);

    const section = sections.get(a.sectionId);
    const requirement = requirements.get(a.subjectRequirementId);
    const teacher = teachers.get(a.teacherId);
    if (!section) {
      out.add({ code: 'UNKNOWN_SECTION', message: `Section ${a.sectionId} is not part of this academic year`, entity });
      ok = false;
    }
    if (!requirement) {
      out.add({ code: 'UNKNOWN_REQUIREMENT', message: `Requirement ${a.subjectRequirementId} is not part of this academic year`, entity });
      ok = false;
    }
    if (!teacher) {
      out.add({ code: 'UNKNOWN_TEACHER', message: `Teacher ${a.teacherId} is unknown`, entity });
      ok = false;
    }
    if (!section || !requirement || !teacher) continue;

    if (!requirementAppliesToSection(requirement, section)) {
      out.add({
        code: 'REQUIREMENT_SECTION_MISMATCH',
        message: 'The requirement does not apply to this section (grade or stream differs)',
        entity,
        details: { sectionId: section.id, subjectRequirementId: requirement.id },
      });
      ok = false;
    }

    if (!Number.isInteger(requirement.periodsPerWeek) || requirement.periodsPerWeek < 1 || requirement.periodsPerWeek > weeklySlots) {
      out.add({
        code: 'INVALID_PERIODS_PER_WEEK',
        message: `periodsPerWeek must be an integer between 1 and the ${weeklySlots} weekly slots`,
        entity,
        details: { periodsPerWeek: requirement.periodsPerWeek },
      });
      ok = false;
    }

    const subject = subjects.get(requirement.subjectId);
    if (!subject) {
      out.add({ code: 'UNKNOWN_SUBJECT', message: `Subject ${requirement.subjectId} is unknown`, entity });
      ok = false;
    } else if (subject.schoolId !== snapshot.schoolId) {
      out.add({ code: 'SUBJECT_CROSS_SCHOOL', message: 'The subject belongs to another school', entity });
      ok = false;
    }

    if (teacher.schoolId !== snapshot.schoolId) {
      out.add({ code: 'TEACHER_CROSS_SCHOOL', message: 'The teacher belongs to another school', entity: { type: 'TEACHER', id: teacher.id } });
      ok = false;
    } else if (!teacher.isActive) {
      out.add({ code: 'TEACHER_INACTIVE', message: `Teacher "${teacher.name}" is inactive`, entity: { type: 'TEACHER', id: teacher.id } });
      ok = false;
    } else if (!allGradesLinks.has(`${teacher.id}|${requirement.subjectId}`) && !eligibility.get(`${teacher.id}|${requirement.subjectId}`)?.has(section.gradeId)) {
      out.add({
        code: 'TEACHER_NOT_ELIGIBLE',
        message: `Teacher "${teacher.name}" is not eligible for this subject and grade`,
        entity: { type: 'TEACHER', id: teacher.id },
        details: { subjectId: requirement.subjectId, gradeId: section.gradeId },
      });
      ok = false;
    }

    if (!ok) continue;
    validAssignments.push({
      id: a.id,
      sectionId: section.id,
      subjectId: requirement.subjectId,
      subjectRequirementId: requirement.id,
      teacherId: teacher.id,
      periodsPerWeek: requirement.periodsPerWeek,
    });
    teacherLoad.set(teacher.id, (teacherLoad.get(teacher.id) ?? 0) + requirement.periodsPerWeek);
    sectionDemand.set(section.id, (sectionDemand.get(section.id) ?? 0) + requirement.periodsPerWeek);
  }

  // ---- automatic teachers: every applicable pair WITHOUT an explicit assignment ------------------------------------------------------
  // Explicit assignments above are hard (and validated). A pair without one gets a teacher chosen among the teachers who are active, in
  // this school, linked to the subject AND eligible for the section's grade (gradeScope ALL_GRADES, or an explicit eligibility row).
  // Nobody becomes eligible by omission: a SELECTED_GRADES link without a row for the grade is not a candidate.
  interface AutoUnit { key: string; section: (typeof snapshot.sections)[number]; requirement: (typeof snapshot.requirements)[number] }
  const autoUnits: AutoUnit[] = [];
  const reportedRequirements = new Set<string>();
  const sectionsInOrder = [...snapshot.sections].sort((x, y) => compare(x.id, y.id));
  const requirementsInOrder = [...snapshot.requirements].sort((x, y) => compare(x.id, y.id));
  for (const section of sectionsInOrder) {
    for (const requirement of requirementsInOrder) {
      if (!requirementAppliesToSection(requirement, section) || seenPairs.has(`${section.id}|${requirement.id}`)) continue;
      const subject = subjects.get(requirement.subjectId);
      const entity = { type: 'REQUIREMENT', id: requirement.id };
      let usable = true;
      if (!Number.isInteger(requirement.periodsPerWeek) || requirement.periodsPerWeek < 1 || requirement.periodsPerWeek > weeklySlots) {
        if (!reportedRequirements.has(`P|${requirement.id}`)) {
          reportedRequirements.add(`P|${requirement.id}`);
          out.add({ code: 'INVALID_PERIODS_PER_WEEK', message: `periodsPerWeek must be an integer between 1 and the ${weeklySlots} weekly slots`, entity, details: { periodsPerWeek: requirement.periodsPerWeek } });
        }
        usable = false;
      }
      if (!subject) {
        if (!reportedRequirements.has(`S|${requirement.id}`)) {
          reportedRequirements.add(`S|${requirement.id}`);
          out.add({ code: 'UNKNOWN_SUBJECT', message: `Subject ${requirement.subjectId} is unknown`, entity });
        }
        usable = false;
      } else if (subject.schoolId !== snapshot.schoolId) {
        if (!reportedRequirements.has(`X|${requirement.id}`)) {
          reportedRequirements.add(`X|${requirement.id}`);
          out.add({ code: 'SUBJECT_CROSS_SCHOOL', message: 'The subject belongs to another school', entity });
        }
        usable = false;
      }
      if (usable) autoUnits.push({ key: `${section.id}|${requirement.id}`, section, requirement });
    }
  }

  if (autoUnits.length > 0) {
    const activeTeachers = snapshot.teachers.filter((t) => t.schoolId === snapshot.schoolId && t.isActive).map((t) => t.id).sort(compare);
    const candidatesFor = (subjectId: string, gradeId: string): string[] =>
      activeTeachers.filter((id) => allGradesLinks.has(`${id}|${subjectId}`) || (eligibility.get(`${id}|${subjectId}`)?.has(gradeId) ?? false));
    const allocation = allocateTeachers({
      units: autoUnits.map((u) => ({ key: u.key, periods: u.requirement.periodsPerWeek, candidates: candidatesFor(u.requirement.subjectId, u.section.gradeId) })),
      teacherCapacity,
      fixedLoad: teacherLoad,
    });

    const autoByKey = new Map(autoUnits.map((u) => [u.key, u]));
    const groupByRequirement = (keys: string[]): Array<[string, AutoUnit[]]> => {
      const byRequirement = new Map<string, AutoUnit[]>();
      for (const key of keys) {
        const unit = autoByKey.get(key)!;
        byRequirement.set(unit.requirement.id, [...(byRequirement.get(unit.requirement.id) ?? []), unit]);
      }
      return [...byRequirement].sort(([x], [y]) => compare(x, y));
    };
    for (const [requirementId, list] of groupByRequirement(allocation.noCandidates)) {
      const requirement = list[0]!.requirement;
      out.add({
        code: 'NO_ELIGIBLE_TEACHER',
        message: `${list.length} section(s) have no explicit teacher and no active teacher is eligible for this subject and grade`,
        entity: { type: 'REQUIREMENT', id: requirementId },
        details: { subjectId: requirement.subjectId, gradeId: requirement.gradeId, sectionIds: list.map((u) => u.section.id).slice(0, 20), count: list.length },
      });
    }
    for (const [requirementId, list] of groupByRequirement(allocation.unplaceable)) {
      const requirement = list[0]!.requirement;
      out.add({
        code: 'TEACHER_ALLOCATION_FAILED',
        message: `${list.length} section(s) could not be given an eligible teacher within the weekly capacity of ${teacherCapacity} periods`,
        entity: { type: 'REQUIREMENT', id: requirementId },
        details: { subjectId: requirement.subjectId, gradeId: requirement.gradeId, periodsPerWeek: requirement.periodsPerWeek, sectionIds: list.map((u) => u.section.id).slice(0, 20), count: list.length, capacity: teacherCapacity },
      });
    }

    for (const unit of autoUnits) {
      const teacherId = allocation.assigned.get(unit.key);
      if (teacherId === undefined) continue;
      validAssignments.push({
        id: autoAssignmentId(unit.section.id, unit.requirement.id),
        sectionId: unit.section.id,
        subjectId: unit.requirement.subjectId,
        subjectRequirementId: unit.requirement.id,
        teacherId,
        periodsPerWeek: unit.requirement.periodsPerWeek,
      });
      teacherLoad.set(teacherId, (teacherLoad.get(teacherId) ?? 0) + unit.requirement.periodsPerWeek);
      sectionDemand.set(unit.section.id, (sectionDemand.get(unit.section.id) ?? 0) + unit.requirement.periodsPerWeek);
    }
  }

  // ---- capacity -------------------------------------------------------------
  for (const [teacherId, load] of [...teacherLoad].sort(([a], [b]) => compare(a, b))) {
    if (load > teacherCapacity) {
      out.add({
        code: 'TEACHER_OVER_CAPACITY',
        message: `Teacher is assigned ${load} periods per week; the limit is ${teacherCapacity}`,
        entity: { type: 'TEACHER', id: teacherId },
        details: { load, capacity: teacherCapacity },
      });
    }
  }
  for (const [sectionId, demand] of [...sectionDemand].sort(([a], [b]) => compare(a, b))) {
    if (demand > weeklySlots) {
      out.add({
        code: 'SECTION_OVER_CAPACITY',
        message: `Section needs ${demand} periods per week but only ${weeklySlots} exist`,
        entity: { type: 'SECTION', id: sectionId },
        details: { demand, weeklySlots },
      });
    }
  }

  // ---- locked entries (Phase 7E): only against a configuration that is otherwise valid --------------------------------
  let fixedEntries: SolverInput['fixedEntries'] = [];
  if (out.issues.length === 0 && options.lockedEntries && options.lockedEntries.length > 0) {
    const resolved = resolveLocks(options.lockedEntries, {
      assignments: validAssignments,
      workingDays: new Set(sortedDays),
      periodsPerDay,
      teacherCapacity,
    });
    for (const lockIssue of resolved.issues) out.add(lockIssue);
    fixedEntries = resolved.fixedEntries;
  }

  if (out.issues.length > 0) {
    return { ok: false, issues: out.issues, truncated: out.truncated };
  }

  // ---- build the immutable, canonically ordered problem ----------------------
  const core: SolverProblemCore = {
    contractVersion: CONTRACT_VERSION,
    grid: {
      days: sortedDays.map((dayOfWeek, index) => ({ index, dayOfWeek: dayOfWeek as (typeof DAYS_OF_WEEK)[number] })),
      periods,
      maxTeacherPeriodsPerWeek: MAX_TEACHER_PERIODS_PER_WEEK,
    },
    sections: [...sectionDemand.keys()].sort(compare).map((id) => ({ id })),
    teachers: [...teacherLoad.keys()].sort(compare).map((id) => ({ id, weeklyCapacity: teacherCapacity })),
    assignments: [...validAssignments].sort((a, b) => compare(a.id, b.id)),
    fixedEntries,
  };

  return {
    ok: true,
    problem: {
      schoolId: snapshot.schoolId,
      academicYear: { id: snapshot.academicYear.id, name: snapshot.academicYear.name },
      core,
      derived: {
        dayCount,
        periodsPerDay,
        weeklySlots,
        teacherCapacity,
        sectionCount: core.sections.length,
        teacherCount: core.teachers.length,
        assignmentCount: core.assignments.length,
        expectedEntryCount: core.assignments.reduce((sum, a) => sum + a.periodsPerWeek, 0),
      },
      inputHash: hashJson(core),
    },
  };
}

/** Attach the per-run options to the problem to produce the exact JSON sent to the solver. */
export function buildSolverInput(problem: NormalizedProblem, requestId: string, options: SolverOptions): SolverInput {
  return {
    contractVersion: problem.core.contractVersion,
    requestId,
    options,
    weightsVersion: WEIGHTS_VERSION,
    weights: { ...WEIGHTS_V1 },
    grid: problem.core.grid,
    sections: problem.core.sections,
    teachers: problem.core.teachers,
    assignments: problem.core.assignments,
    fixedEntries: problem.core.fixedEntries,
  };
}
