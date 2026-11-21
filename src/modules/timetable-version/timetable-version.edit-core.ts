import { z } from 'zod';
import { type NormalizedProblem } from '../timetable-generation/timetable-generation.normalizer.js';
import { assignmentSchema, fixedEntrySchema, gridSchema, MAX_TEACHER_PERIODS_PER_WEEK, type SolverProblemCore, type TimetableEntryRow } from '../timetable-generation/timetable-generation.contracts.js';
import { validateEntries, type ValidationProblem } from '../timetable-generation/timetable-generation.validator.js';
import { evaluateMetrics, type TimetableMetrics } from '../timetable-generation/timetable-generation.metrics.js';
import { hashJson } from '../timetable-generation/timetable-generation.hash.js';

// ---------------------------------------------------------------------------
// Phase 7B: the pure rules of reviewing, editing, locking and publishing a timetable version. No database, no HTTP, no clock.
//
// The service layer loads rows, calls these functions inside a locked transaction and writes what they decide. Everything here
// is deterministic, so every rule can be tested exhaustively without a database.
//
// V1 edit model: a lesson can only MOVE to a free slot, or SWAP slots with another lesson of the SAME section. Teacher, subject,
// section and assignment never change, so the weekly requirement counts and the teaching assignments are preserved by
// construction; the full validation after every edit proves it.
// ---------------------------------------------------------------------------

export type VersionStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type YearStatus = 'DRAFT' | 'ACTIVE' | 'COMPLETED';
export type EntrySource = 'GENERATED' | 'MANUAL';

export interface EditableEntry {
  id: string;
  sectionId: string;
  subjectId: string;
  teacherId: string;
  subjectRequirementId: string;
  dayOfWeek: string;
  periodNumber: number;
  source: EntrySource;
  isLocked: boolean;
}

/** The stable, machine-readable reasons an operation is refused. */
export const EDIT_ERROR_CODES = [
  'VERSION_NOT_DRAFT',
  'ACADEMIC_YEAR_NOT_EDITABLE',
  'REVISION_CONFLICT',
  'ENTRY_NOT_FOUND',
  'ENTRY_LOCKED',
  'SLOT_OCCUPIED',
  'TEACHER_BUSY',
  'INVALID_SLOT',
  'INVALID_MOVE',
  'INVALID_SWAP',
  'INVARIANT_VIOLATION',
  'PUBLISHED_CHANGED',
  'STALE_CONFIGURATION',
  'VALIDATION_FAILED',
  'SNAPSHOT_UNUSABLE',
] as const;
export type EditErrorCode = (typeof EDIT_ERROR_CODES)[number];

export interface Refusal {
  ok: false;
  status: 400 | 404 | 409;
  code: EditErrorCode;
  message: string;
  details?: Record<string, unknown>;
}
export type Planned<T> = ({ ok: true } & T) | Refusal;

const refuse = (status: Refusal['status'], code: EditErrorCode, message: string, details?: Record<string, unknown>): Refusal => ({
  ok: false, status, code, message, ...(details ? { details } : {}),
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------
/** DRAFT --publish--> PUBLISHED --(the next publish of another version)--> ARCHIVED. ARCHIVED is terminal. Nothing else moves. */
export const VERSION_TRANSITIONS: Readonly<Record<VersionStatus, readonly VersionStatus[]>> = Object.freeze({
  DRAFT: ['PUBLISHED'],
  PUBLISHED: ['ARCHIVED'],
  ARCHIVED: [],
});

export const canTransition = (from: VersionStatus, to: VersionStatus): boolean => VERSION_TRANSITIONS[from].includes(to);
/** Only drafts may be edited, locked or deleted. PUBLISHED and ARCHIVED versions are immutable history. */
export const isEditableStatus = (status: VersionStatus): boolean => status === 'DRAFT';
export const canDeleteVersion = (status: VersionStatus): boolean => status === 'DRAFT';
/** Editing, locking and publishing are allowed in DRAFT and ACTIVE academic years, never in COMPLETED ones. (Generation stays DRAFT-only.) */
export const isYearEditable = (status: YearStatus): boolean => status === 'DRAFT' || status === 'ACTIVE';

/** The first reason (in a fixed order) why a draft cannot be mutated, or null. Order: version state, year state, revision. */
export function checkMutable(input: { versionStatus: VersionStatus; yearStatus: YearStatus; revision: number; expectedRevision: number }): Refusal | null {
  if (!isEditableStatus(input.versionStatus)) {
    return refuse(409, 'VERSION_NOT_DRAFT', `The timetable version is ${input.versionStatus.toLowerCase()} and can no longer be changed`, { status: input.versionStatus, revision: input.revision });
  }
  if (!isYearEditable(input.yearStatus)) {
    return refuse(409, 'ACADEMIC_YEAR_NOT_EDITABLE', `The academic year is ${input.yearStatus.toLowerCase()}; its timetables can no longer be changed`, { yearStatus: input.yearStatus });
  }
  if (input.revision !== input.expectedRevision) {
    return refuse(409, 'REVISION_CONFLICT', 'The timetable was changed by someone else. Reload it and try again', { revision: input.revision, status: input.versionStatus });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rebuilding the problem from the stored snapshot
// ---------------------------------------------------------------------------
const storedCoreSchema = z.strictObject({
  contractVersion: z.string().min(1).max(20),
  grid: gridSchema,
  sections: z.array(z.strictObject({ id: z.string().min(1).max(100) })).min(1),
  teachers: z.array(z.strictObject({ id: z.string().min(1).max(100), weeklyCapacity: z.int().min(1) })).min(1),
  assignments: z.array(assignmentSchema).min(1),
  fixedEntries: z.array(fixedEntrySchema),
});

export class SnapshotUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotUnusableError';
  }
}

/**
 * Rebuild the normalized problem a version was generated from, from its stored `inputSnapshot` (the exact problem core).
 * The core already holds everything the validator and the metrics evaluator read; the derived numbers are pure functions of it,
 * computed with the same formulas as the normalizer. Throws SnapshotUnusableError if the stored JSON is not a valid core.
 */
export function problemFromCore(stored: unknown, context: { schoolId: string; academicYear: { id: string; name: string } }): NormalizedProblem {
  const parsed = storedCoreSchema.safeParse(stored);
  if (!parsed.success) throw new SnapshotUnusableError(`The stored timetable snapshot is not a valid problem (${parsed.error.issues[0]?.message ?? 'unknown'})`);
  const core = parsed.data as unknown as SolverProblemCore;
  const dayCount = core.grid.days.length;
  const periodsPerDay = core.grid.periods.length;
  const weeklySlots = dayCount * periodsPerDay;
  return {
    schoolId: context.schoolId,
    academicYear: context.academicYear,
    core,
    derived: {
      dayCount,
      periodsPerDay,
      weeklySlots,
      teacherCapacity: Math.min(MAX_TEACHER_PERIODS_PER_WEEK, weeklySlots),
      sectionCount: core.sections.length,
      teacherCount: core.teachers.length,
      assignmentCount: core.assignments.length,
      expectedEntryCount: core.assignments.reduce((sum, a) => sum + a.periodsPerWeek, 0),
    },
    inputHash: hashJson(core),
  };
}

/**
 * The identity of a CONFIGURATION for staleness: the problem core WITHOUT its fixed entries (locks are not configuration, and the
 * generation input hash is deliberately not changed). Two cores with equal configuration hashes describe the same school setup.
 */
export const configurationHash = (core: SolverProblemCore): string => hashJson({ ...core, fixedEntries: [] });

export interface Staleness {
  stale: boolean;
  reason: 'NONE' | 'CONFIGURATION_CHANGED' | 'CONFIGURATION_NOT_NORMALIZABLE';
}
/** Strict rule (D3): the draft is current only if the freshly normalized configuration hashes to exactly the draft's. `fresh` is null when the live configuration no longer normalizes. */
export function assessStaleness(storedCore: SolverProblemCore, fresh: SolverProblemCore | null): Staleness {
  if (fresh === null) return { stale: true, reason: 'CONFIGURATION_NOT_NORMALIZABLE' };
  return configurationHash(storedCore) === configurationHash(fresh) ? { stale: false, reason: 'NONE' } : { stale: true, reason: 'CONFIGURATION_CHANGED' };
}

// ---------------------------------------------------------------------------
// Stored entries <-> validator rows
// ---------------------------------------------------------------------------
export function rowsFromEntries(problem: NormalizedProblem, entries: readonly EditableEntry[]): { rows: TimetableEntryRow[]; unmapped: EditableEntry[] } {
  const assignmentOf = new Map(problem.core.assignments.map((a) => [`${a.sectionId}|${a.subjectRequirementId}`, a.id]));
  const rows: TimetableEntryRow[] = [];
  const unmapped: EditableEntry[] = [];
  for (const entry of entries) {
    const assignmentId = assignmentOf.get(`${entry.sectionId}|${entry.subjectRequirementId}`);
    if (assignmentId === undefined) {
      unmapped.push(entry);
      continue;
    }
    rows.push({ assignmentId, sectionId: entry.sectionId, subjectId: entry.subjectId, teacherId: entry.teacherId, dayOfWeek: entry.dayOfWeek as TimetableEntryRow['dayOfWeek'], periodNumber: entry.periodNumber });
  }
  return { rows, unmapped };
}

export interface VersionValidation {
  valid: boolean;
  /** Bounded list (the validator's own cap); `violationCount` is the true total. */
  violations: Array<Pick<ValidationProblem, 'code' | 'message'> & Partial<Pick<ValidationProblem, 'assignmentId' | 'sectionId' | 'teacherId' | 'dayOfWeek' | 'periodNumber'>>>;
  violationCount: number;
  /** Authoritative metrics; null when the timetable is not valid (they are undefined for an invalid timetable). */
  metrics: TimetableMetrics | null;
}

/** Hard-constraint validation of a whole timetable against a problem, plus the authoritative metrics when valid. */
export function validateVersion(problem: NormalizedProblem, entries: readonly EditableEntry[]): VersionValidation {
  const { rows, unmapped } = rowsFromEntries(problem, entries);
  // Phase 7E: a version generated from locks carries them in its snapshot as HISTORY (what was fixed when it was generated). Whether a
  // lesson is locked NOW is the entry's isLocked flag, which an admin may change; the old fixed entries must not make a legitimate move or
  // an unlocked lesson look invalid. Everything else is validated exactly as before.
  const checked = problem.core.fixedEntries.length === 0 ? problem : { ...problem, core: { ...problem.core, fixedEntries: [] } };
  const result = validateEntries(checked, rows);
  const violations: VersionValidation['violations'] = [
    ...unmapped.slice(0, 20).map((e) => ({ code: 'UNKNOWN_ASSIGNMENT' as const, message: 'A lesson does not belong to any current teaching assignment', sectionId: e.sectionId, dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber })),
    ...result.problems,
  ];
  const violationCount = unmapped.length + result.problemCount;
  const valid = violationCount === 0 && result.valid;
  return { valid, violations: violations.slice(0, 50), violationCount, metrics: valid ? evaluateMetrics(problem, rows) : null };
}

export interface MetricsDelta {
  weightedObjective: number;
  terms: Record<string, number>;
}
/** after - before: negative is better (the objective is a cost). */
export function metricsDelta(before: TimetableMetrics, after: TimetableMetrics): MetricsDelta {
  const terms: Record<string, number> = {};
  for (const key of Object.keys(after.terms) as Array<keyof typeof after.terms>) terms[key] = after.terms[key] - before.terms[key];
  return { weightedObjective: after.weightedObjective - before.weightedObjective, terms };
}

export const lockedCount = (entries: readonly EditableEntry[]): number => entries.filter((e) => e.isLocked).length;
export const manualEditCount = (entries: readonly EditableEntry[]): number => entries.filter((e) => e.source === 'MANUAL').length;

// ---------------------------------------------------------------------------
// Move / swap
// ---------------------------------------------------------------------------
export interface MoveRequest {
  entryId: string;
  to: { dayOfWeek: string; periodNumber: number };
  swapWithEntryId?: string | undefined;
}
export interface SlotChange {
  id: string;
  dayOfWeek: string;
  periodNumber: number;
}
export interface MovePlan {
  mode: 'MOVE' | 'SWAP';
  /** MOVE: one change. SWAP: two changes (the entry first, its partner second). */
  changes: SlotChange[];
}

const slotKey = (day: string, period: number): string => `${day}|${period}`;

/**
 * Decide a move or a swap against the CURRENT entries, or refuse it with a stable code. Refusals, in this order:
 *   404 ENTRY_NOT_FOUND   an entry is not in this version
 *   400 INVALID_SLOT      the target is not a working day / period of the grid
 *   400 INVALID_SWAP      swapping an entry with itself, across sections, or `to` is not the partner's slot
 *   400 INVALID_MOVE      the lesson is already in that slot
 *   409 ENTRY_LOCKED      the lesson (or the swap partner) is locked
 *   409 SLOT_OCCUPIED     the target slot of the section already holds a lesson (a move; use a swap)
 *   409 TEACHER_BUSY      the teacher already teaches another section in the target slot
 */
export function planMove(problem: NormalizedProblem, entries: readonly EditableEntry[], request: MoveRequest): Planned<{ plan: MovePlan }> {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const entry = byId.get(request.entryId);
  if (!entry) return refuse(404, 'ENTRY_NOT_FOUND', 'Timetable entry not found');

  const days = new Set(problem.core.grid.days.map((d) => d.dayOfWeek as string));
  const { dayOfWeek, periodNumber } = request.to;
  if (!days.has(dayOfWeek) || !Number.isInteger(periodNumber) || periodNumber < 1 || periodNumber > problem.derived.periodsPerDay) {
    return refuse(400, 'INVALID_SLOT', 'The target is not a working day and period of this timetable', { dayOfWeek, periodNumber });
  }

  // Slots held by teacher / section, so each rule is a lookup.
  const teacherAt = new Map<string, string>(); // teacher|day|period -> entry id (any one; collisions are impossible in a valid timetable)
  const sectionAt = new Map<string, string>(); // section|day|period -> entry id
  for (const e of entries) {
    teacherAt.set(`${e.teacherId}|${slotKey(e.dayOfWeek, e.periodNumber)}`, e.id);
    sectionAt.set(`${e.sectionId}|${slotKey(e.dayOfWeek, e.periodNumber)}`, e.id);
  }
  const target = slotKey(dayOfWeek, periodNumber);

  if (request.swapWithEntryId !== undefined) {
    const partner = byId.get(request.swapWithEntryId);
    if (!partner) return refuse(404, 'ENTRY_NOT_FOUND', 'Timetable entry not found');
    if (partner.id === entry.id) return refuse(400, 'INVALID_SWAP', 'A lesson cannot be swapped with itself');
    if (partner.sectionId !== entry.sectionId) return refuse(400, 'INVALID_SWAP', 'Only two lessons of the same section can be swapped');
    if (slotKey(partner.dayOfWeek, partner.periodNumber) !== target) return refuse(400, 'INVALID_SWAP', 'The target slot must be the slot of the lesson it is swapped with');
    if (entry.isLocked) return refuse(409, 'ENTRY_LOCKED', 'The lesson is locked and cannot be moved', { entryId: entry.id });
    if (partner.isLocked) return refuse(409, 'ENTRY_LOCKED', 'The lesson it would be swapped with is locked', { entryId: partner.id });

    // each teacher moves into the other lesson's slot; the only entries that can be in the way are OTHER lessons
    const entrySlot = slotKey(entry.dayOfWeek, entry.periodNumber);
    for (const [mover, slot] of [[entry, target], [partner, entrySlot]] as const) {
      const holder = teacherAt.get(`${mover.teacherId}|${slot}`);
      if (holder !== undefined && holder !== entry.id && holder !== partner.id) {
        return refuse(409, 'TEACHER_BUSY', 'The teacher already teaches another section in that slot', { entryId: mover.id });
      }
    }
    return {
      ok: true,
      plan: {
        mode: 'SWAP',
        changes: [
          { id: entry.id, dayOfWeek, periodNumber },
          { id: partner.id, dayOfWeek: entry.dayOfWeek, periodNumber: entry.periodNumber },
        ],
      },
    };
  }

  if (slotKey(entry.dayOfWeek, entry.periodNumber) === target) return refuse(400, 'INVALID_MOVE', 'The lesson is already in that slot');
  if (entry.isLocked) return refuse(409, 'ENTRY_LOCKED', 'The lesson is locked and cannot be moved', { entryId: entry.id });
  const occupant = sectionAt.get(`${entry.sectionId}|${target}`);
  if (occupant !== undefined) return refuse(409, 'SLOT_OCCUPIED', 'The section already has a lesson in that slot. Swap the two lessons instead', { occupantEntryId: occupant });
  const busy = teacherAt.get(`${entry.teacherId}|${target}`);
  if (busy !== undefined && busy !== entry.id) return refuse(409, 'TEACHER_BUSY', 'The teacher already teaches another section in that slot', { entryId: entry.id });
  return { ok: true, plan: { mode: 'MOVE', changes: [{ id: entry.id, dayOfWeek, periodNumber }] } };
}

/** The entries after a plan: moved lessons change slot and become MANUAL; nothing else changes and no lock is added or removed (D2). */
export function applyPlan(entries: readonly EditableEntry[], plan: MovePlan): EditableEntry[] {
  const change = new Map(plan.changes.map((c) => [c.id, c]));
  return entries.map((e) => {
    const c = change.get(e.id);
    return c ? { ...e, dayOfWeek: c.dayOfWeek, periodNumber: c.periodNumber, source: 'MANUAL' as const } : e;
  });
}

// ---------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------
export interface LockPlan {
  /** Entries whose isLocked really changes. */
  toChange: string[];
  /** Entries already in the requested state (the operation is idempotent for them). */
  unchanged: string[];
}
/** 404 if any id is not an entry of this version; otherwise which entries change. Duplicate ids are a request error handled by the schema. */
export function planLocks(entries: readonly EditableEntry[], entryIds: readonly string[], locked: boolean): Planned<{ plan: LockPlan }> {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const toChange: string[] = [];
  const unchanged: string[] = [];
  for (const id of entryIds) {
    const e = byId.get(id);
    if (!e) return refuse(404, 'ENTRY_NOT_FOUND', 'Timetable entry not found');
    (e.isLocked === locked ? unchanged : toChange).push(id);
  }
  return { ok: true, plan: { toChange, unchanged } };
}

// ---------------------------------------------------------------------------
// Publish preconditions that depend only on state (the fresh normalization / validation come after these, under locks)
// ---------------------------------------------------------------------------
export interface PublishState {
  target: { status: VersionStatus; revision: number };
  yearStatus: YearStatus;
  currentPublishedId: string | null;
  expectedRevision: number;
  expectedPublishedVersionId: string | null;
}
/** Order: version state, year state, revision, then the published version the admin saw. */
export function checkPublishable(state: PublishState): Refusal | null {
  const mutable = checkMutable({ versionStatus: state.target.status, yearStatus: state.yearStatus, revision: state.target.revision, expectedRevision: state.expectedRevision });
  if (mutable) return mutable;
  if (state.currentPublishedId !== state.expectedPublishedVersionId) {
    return refuse(409, 'PUBLISHED_CHANGED', 'The published timetable changed since you loaded it. Reload and review it again', { publishedVersionId: state.currentPublishedId });
  }
  return null;
}
