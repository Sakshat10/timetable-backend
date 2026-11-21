import { z } from 'zod';
import { DAYS_OF_WEEK, type SolverInput } from './timetable-generation.contracts.js';

// ---------------------------------------------------------------------------
// Phase 7E: locked entries during regeneration. PURE (no database, no clock, no solver).
//
// A lock pins ONE lesson of ONE assignment to a slot. The life of a lock:
//
//   locked timetable entry (source draft)
//     -> freezeLocks(): resolved to its assignment and stored, with verification fields, in the run's options at POST time
//        (the source version is never read again: editing, unlocking or deleting it cannot change a queued run)
//     -> resolveLocks(): validated against the FRESH configuration inside normalizeProblem (authoritative, every attempt)
//     -> core.fixedEntries (canonically sorted, part of the input hash) -> baseline / CP-SAT -> validateEntries -> persistence
//
// D-E1: a frozen lock is resolved by its EXACT assignment id. If that assignment no longer exists (deleted, or deleted and
// recreated under a new id), the lock is reported as LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND. Nothing is guessed or remapped.
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(100);

/** What the run stores for every lock. The first three fields are the solver contract's fixed entry; the rest verify it. */
export const frozenLockSchema = z.strictObject({
  assignmentId: id,
  dayOfWeek: z.enum(DAYS_OF_WEEK),
  periodNumber: z.int().min(1).max(12),
  /** Verification fields: the lock must still describe the same lesson of the same section, requirement and teacher. */
  sectionId: id,
  subjectRequirementId: id,
  teacherId: id,
  /** D-E2: the lesson's original source is preserved in the new version. */
  source: z.enum(['GENERATED', 'MANUAL']),
});
export type FrozenLock = z.infer<typeof frozenLockSchema>;

export const MAX_FROZEN_LOCKS = 10_000;
export const frozenLocksSchema = z.array(frozenLockSchema).max(MAX_FROZEN_LOCKS);

export const LOCK_ISSUE_CODES = [
  'LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND',
  'LOCKED_ENTRY_REQUIREMENT_MISMATCH',
  'LOCKED_ENTRY_TEACHER_CHANGED',
  'LOCKED_ENTRY_INVALID_DAY',
  'LOCKED_ENTRY_INVALID_PERIOD',
  'LOCKED_ENTRY_DUPLICATE',
  'LOCKED_ENTRY_SECTION_COLLISION',
  'LOCKED_ENTRY_TEACHER_COLLISION',
  'LOCKED_ENTRY_EXCEEDS_REQUIREMENT',
  'LOCKED_ENTRY_CAPACITY_EXCEEDED',
] as const;
export type LockIssueCode = (typeof LOCK_ISSUE_CODES)[number];

export interface LockIssue {
  code: LockIssueCode;
  message: string;
  entity: { type: 'LOCKED_ENTRY'; id: string };
  details: Record<string, unknown>;
}

const dayRank = new Map<string, number>(DAYS_OF_WEEK.map((d, i) => [d, i]));

/** The canonical order of locks: assignment id, then day (week order), then period. Same locks in any order give the same list (and hash). */
export function canonicalizeLocks<T extends { assignmentId: string; dayOfWeek: string; periodNumber: number }>(locks: readonly T[]): T[] {
  return [...locks].sort((a, b) => {
    if (a.assignmentId !== b.assignmentId) return a.assignmentId < b.assignmentId ? -1 : 1;
    const da = dayRank.get(a.dayOfWeek) ?? 99;
    const db = dayRank.get(b.dayOfWeek) ?? 99;
    return da !== db ? da - db : a.periodNumber - b.periodNumber;
  });
}

export interface LockableEntry {
  id: string;
  sectionId: string;
  subjectRequirementId: string;
  teacherId: string;
  dayOfWeek: string;
  periodNumber: number;
  source: string;
}

/**
 * Freeze the locked entries of a source version: each entry is resolved to its assignment by (section, requirement), the pair
 * that identifies an assignment (the database enforces one assignment per pair). An entry whose pair has no assignment now cannot
 * be frozen: it is reported as LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND. The result is canonically sorted.
 */
export function freezeLocks(
  lockedEntries: readonly LockableEntry[],
  assignments: ReadonlyArray<{ id: string; sectionId: string; subjectRequirementId: string }>
): { locks: FrozenLock[]; issues: LockIssue[] } {
  const byPair = new Map(assignments.map((a) => [`${a.sectionId}|${a.subjectRequirementId}`, a.id]));
  const locks: FrozenLock[] = [];
  const issues: LockIssue[] = [];
  for (const e of lockedEntries) {
    const assignmentId = byPair.get(`${e.sectionId}|${e.subjectRequirementId}`);
    if (assignmentId === undefined) {
      issues.push({
        code: 'LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND',
        message: 'A locked lesson no longer has a teaching assignment (its section and requirement have no teacher assigned)',
        entity: { type: 'LOCKED_ENTRY', id: e.id },
        details: { sectionId: e.sectionId, subjectRequirementId: e.subjectRequirementId, dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber },
      });
      continue;
    }
    locks.push({
      assignmentId,
      dayOfWeek: e.dayOfWeek as FrozenLock['dayOfWeek'],
      periodNumber: e.periodNumber,
      sectionId: e.sectionId,
      subjectRequirementId: e.subjectRequirementId,
      teacherId: e.teacherId,
      source: e.source === 'MANUAL' ? 'MANUAL' : 'GENERATED',
    });
  }
  return { locks: canonicalizeLocks(locks), issues };
}

export interface LockContext {
  /** The VALIDATED assignments of the fresh problem. */
  assignments: ReadonlyArray<{ id: string; sectionId: string; subjectRequirementId: string; teacherId: string; periodsPerWeek: number }>;
  workingDays: ReadonlySet<string>;
  periodsPerDay: number;
  /** min(32, weekly slots): the most periods any teacher may teach per week. */
  teacherCapacity: number;
}

export interface ResolvedLocks {
  /** The solver contract's fixed entries, canonically sorted. Empty when there are issues. */
  fixedEntries: SolverInput['fixedEntries'];
  issues: LockIssue[];
}

/**
 * Validate frozen locks against the fresh problem. Per lock: the assignment exists, still describes the same section / requirement /
 * teacher, and the slot is a real working day and period. Across locks: no duplicates, no two lessons of one section or one teacher in
 * a slot, no assignment locked more often than its weekly periods, no teacher locked beyond the weekly capacity.
 * Every problem is reported (bounded by the caller), never the first one only.
 */
export function resolveLocks(locks: readonly FrozenLock[], context: LockContext): ResolvedLocks {
  const issues: LockIssue[] = [];
  const byId = new Map(context.assignments.map((a) => [a.id, a]));
  const sorted = canonicalizeLocks(locks);

  const issue = (code: LockIssueCode, message: string, lock: FrozenLock, extra: Record<string, unknown> = {}): void => {
    issues.push({ code, message, entity: { type: 'LOCKED_ENTRY', id: lock.assignmentId }, details: { dayOfWeek: lock.dayOfWeek, periodNumber: lock.periodNumber, ...extra } });
  };

  const valid: Array<{ lock: FrozenLock; assignment: LockContext['assignments'][number] }> = [];
  const seen = new Set<string>();
  for (const lock of sorted) {
    const assignment = byId.get(lock.assignmentId);
    if (!assignment) {
      issue('LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND', 'The locked lesson\'s teaching assignment no longer exists', lock, { sectionId: lock.sectionId, subjectRequirementId: lock.subjectRequirementId });
      continue;
    }
    if (assignment.sectionId !== lock.sectionId || assignment.subjectRequirementId !== lock.subjectRequirementId) {
      issue('LOCKED_ENTRY_REQUIREMENT_MISMATCH', 'The locked lesson\'s assignment now belongs to a different section or requirement', lock);
      continue;
    }
    if (assignment.teacherId !== lock.teacherId) {
      issue('LOCKED_ENTRY_TEACHER_CHANGED', 'The teacher of the locked lesson\'s assignment has changed', lock);
      continue;
    }
    if (!context.workingDays.has(lock.dayOfWeek)) {
      issue('LOCKED_ENTRY_INVALID_DAY', `${lock.dayOfWeek} is not a working day of the current schedule`, lock);
      continue;
    }
    if (!Number.isInteger(lock.periodNumber) || lock.periodNumber < 1 || lock.periodNumber > context.periodsPerDay) {
      issue('LOCKED_ENTRY_INVALID_PERIOD', `Period ${lock.periodNumber} is outside the current schedule (1..${context.periodsPerDay})`, lock);
      continue;
    }
    const key = `${lock.assignmentId}|${lock.dayOfWeek}|${lock.periodNumber}`;
    if (seen.has(key)) {
      issue('LOCKED_ENTRY_DUPLICATE', 'The same lesson is locked twice in one slot', lock);
      continue;
    }
    seen.add(key);
    valid.push({ lock, assignment });
  }

  // across the valid locks
  const sectionAt = new Map<string, string>();
  const teacherAt = new Map<string, string>();
  const perAssignment = new Map<string, number>();
  const perTeacher = new Map<string, number>();
  for (const { lock, assignment } of valid) {
    const slot = `${lock.dayOfWeek}|${lock.periodNumber}`;
    const sectionKey = `${assignment.sectionId}|${slot}`;
    const teacherKey = `${assignment.teacherId}|${slot}`;
    const sectionHolder = sectionAt.get(sectionKey);
    if (sectionHolder !== undefined) issue('LOCKED_ENTRY_SECTION_COLLISION', 'Two locked lessons of one section are in the same slot', lock, { otherAssignmentId: sectionHolder, sectionId: assignment.sectionId });
    else sectionAt.set(sectionKey, lock.assignmentId);
    const teacherHolder = teacherAt.get(teacherKey);
    if (teacherHolder !== undefined) issue('LOCKED_ENTRY_TEACHER_COLLISION', 'A teacher has two locked lessons in the same slot', lock, { otherAssignmentId: teacherHolder, teacherId: assignment.teacherId });
    else teacherAt.set(teacherKey, lock.assignmentId);
    perAssignment.set(assignment.id, (perAssignment.get(assignment.id) ?? 0) + 1);
    perTeacher.set(assignment.teacherId, (perTeacher.get(assignment.teacherId) ?? 0) + 1);
  }
  const reportedAssignment = new Set<string>();
  const reportedTeacher = new Set<string>();
  for (const { lock, assignment } of valid) {
    const locked = perAssignment.get(assignment.id) ?? 0;
    if (locked > assignment.periodsPerWeek && !reportedAssignment.has(assignment.id)) {
      reportedAssignment.add(assignment.id);
      issue('LOCKED_ENTRY_EXCEEDS_REQUIREMENT', `${locked} lessons are locked but the requirement needs only ${assignment.periodsPerWeek} per week`, lock, { locked, periodsPerWeek: assignment.periodsPerWeek });
    }
    const teacherLocked = perTeacher.get(assignment.teacherId) ?? 0;
    if (teacherLocked > context.teacherCapacity && !reportedTeacher.has(assignment.teacherId)) {
      reportedTeacher.add(assignment.teacherId);
      issue('LOCKED_ENTRY_CAPACITY_EXCEEDED', `${teacherLocked} locked lessons exceed the teacher's weekly capacity of ${context.teacherCapacity}`, lock, { locked: teacherLocked, capacity: context.teacherCapacity, teacherId: assignment.teacherId });
    }
  }

  if (issues.length > 0) return { fixedEntries: [], issues };
  return { fixedEntries: valid.map(({ lock }) => ({ assignmentId: lock.assignmentId, dayOfWeek: lock.dayOfWeek, periodNumber: lock.periodNumber })), issues };
}
