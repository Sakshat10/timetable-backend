import { slotsExhausted, type DraftSlots } from '../timetable-generation/timetable-generation.draft-slots.js';
import { isYearEditable, type YearStatus } from './timetable-version.edit-core.js';

// ---------------------------------------------------------------------------
// Phase 7F-2: cloning a timetable version into a new DRAFT. PURE decisions only (no database); the service applies them.
//
// Lock modes (what happens to each lesson's `isLocked` flag in the CLONE; the source is never touched):
//   KEEP  every lesson keeps the flag it has in the source (the default)
//   ALL   every lesson is locked
//   NONE  no lesson is locked
// A lesson's `source` (GENERATED or MANUAL) is ALWAYS copied unchanged: a lock mode never rewrites history.
// ---------------------------------------------------------------------------

export const LOCK_MODES = ['KEEP', 'ALL', 'NONE'] as const;
export type LockMode = (typeof LOCK_MODES)[number];
export const DEFAULT_LOCK_MODE: LockMode = 'KEEP';

/** The isLocked flag a lesson has in the clone. */
export function lockedAfterClone(mode: LockMode, sourceIsLocked: boolean): boolean {
  if (mode === 'ALL') return true;
  if (mode === 'NONE') return false;
  return sourceIsLocked;
}

export interface CloneRefusal {
  status: 409;
  code: 'ACADEMIC_YEAR_NOT_EDITABLE' | 'DRAFT_LIMIT_REACHED';
  message: string;
  details: Record<string, unknown>;
}

/**
 * Why a clone cannot be made, or null. The year check comes first (it needs no counting); the cap check uses the CLONE rule:
 * drafts + active generation runs >= cap refuses, because a queued or running generation holds a slot for its draft.
 * Equality blocks, and so does a year above the cap (legacy data, or a cap lowered at a restart): nothing is ever deleted for it.
 */
export function checkCloneAllowed(input: { yearStatus: YearStatus; slots: DraftSlots; max: number }): CloneRefusal | null {
  if (!isYearEditable(input.yearStatus)) {
    return { status: 409, code: 'ACADEMIC_YEAR_NOT_EDITABLE', message: `The academic year is ${input.yearStatus.toLowerCase()}; its timetables can no longer be changed`, details: { yearStatus: input.yearStatus } };
  }
  if (slotsExhausted('CLONE', input.slots, input.max)) {
    return {
      status: 409,
      code: 'DRAFT_LIMIT_REACHED',
      message: `This academic year already has ${input.slots.drafts} draft timetable versions${input.slots.activeRuns > 0 ? ' and a generation in progress' : ''} (the maximum is ${input.max}). Delete or publish a draft${input.slots.activeRuns > 0 ? ', or wait for the generation to finish,' : ''} and try again`,
      details: { drafts: input.slots.drafts, maxDraftsPerYear: input.max, pendingRun: input.slots.activeRuns > 0 },
    };
  }
  return null;
}
