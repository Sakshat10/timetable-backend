import { AppError } from '../../utils/errors.js';
import { type EditErrorCode, type Refusal } from './timetable-version.edit-core.js';

/** Phase 7F-1: codes of the read-only timetable views. */
export type ViewErrorCode = 'SECTION_NOT_FOUND' | 'TEACHER_NOT_FOUND';
/** Phase 7F-2: the clone refusal that is not an edit rule (ACADEMIC_YEAR_NOT_EDITABLE is shared with the edit rules). */
export type CloneErrorCode = 'DRAFT_LIMIT_REACHED';
/** Deleting a PUBLISHED or ARCHIVED version: it needs the explicit confirmation body; the rest are refusals under the locks. */
export type DeleteErrorCode = 'CONFIRMATION_REQUIRED' | 'CONFIRMATION_MISMATCH' | 'STATUS_CHANGED' | 'REVISION_CONFLICT' | 'ACADEMIC_YEAR_NOT_EDITABLE' | 'VERSION_HAS_HISTORY';

/**
 * A refusal with a stable, machine-readable code. It travels in the standard envelope as
 * { success: false, message, data: { code, ...details } } (the same `data` convention Phase 6 uses for 409 / NOT_READY), so a
 * client can branch on `data.code` without parsing messages.
 */
export class VersionRuleError extends AppError {
  constructor(
    statusCode: number,
    public readonly code: EditErrorCode | ViewErrorCode | CloneErrorCode | DeleteErrorCode | 'BUSY',
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly headers: Record<string, string> = {}
  ) {
    super(statusCode, message);
    this.name = 'VersionRuleError';
  }
}

export const fromRefusal = (refusal: Refusal): VersionRuleError => new VersionRuleError(refusal.status, refusal.code, refusal.message, refusal.details ?? {});

/** PostgreSQL gave up waiting for a row lock (`lock_timeout`): another request holds the version for too long. Deterministic, retryable. */
export function isLockTimeout(error: unknown): boolean {
  const text = `${(error as { message?: string })?.message ?? ''} ${JSON.stringify((error as { meta?: unknown })?.meta ?? {})}`;
  return /55P03|lock timeout|could not obtain lock/i.test(text);
}
export const busyError = (): VersionRuleError =>
  new VersionRuleError(503, 'BUSY', 'The timetable is being changed by another request. Please try again in a moment', {}, { 'Retry-After': '2' });
