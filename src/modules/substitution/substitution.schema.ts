import { z } from 'zod';
import { CONSECUTIVE_POLICIES, dayCount, isValidDateString, MAX_ABSENCE_DAYS, MAX_PERIOD } from './substitution.core.js';

const dateString = z.string({ error: 'A date is required (YYYY-MM-DD)' }).trim().refine(isValidDateString, 'Must be a real calendar date written as YYYY-MM-DD');
const periodNumber = z.int('Must be a whole number').min(1, 'Periods start at 1').max(MAX_PERIOD, `At most ${MAX_PERIOD} periods a day`);
const reason = z
  .string()
  .trim()
  .max(500, 'The reason must not exceed 500 characters')
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();
const uuid = (what: string) => z.string().uuid(`Invalid ${what} ID format`);

// ---------------------------------------------------------------------------
// Absences
// ---------------------------------------------------------------------------
const absenceFields = {
  teacherId: uuid('teacher'),
  startDate: dateString,
  endDate: dateString,
  scope: z.enum(['FULL_DAY', 'PERIODS'], { error: 'scope must be FULL_DAY or PERIODS' }).optional(),
  fromPeriod: periodNumber.nullable().optional(),
  toPeriod: periodNumber.nullable().optional(),
  reason,
  /** false: record the absence only; the cover requests stay OPEN for manual assignment (default true: the system assigns substitutes automatically). */
  autoAssign: z.boolean().optional(),
  /** false: do not use a free teacher who does not teach the subject as temporary cover (default true: the school's existing policy permits it). */
  allowTemporaryCover: z.boolean().optional(),
};

interface AbsenceShape {
  startDate: string;
  endDate: string;
  scope?: 'FULL_DAY' | 'PERIODS' | undefined;
  fromPeriod?: number | null | undefined;
  toPeriod?: number | null | undefined;
}

/** The rules that relate the fields to each other (shared by create and by update on the merged record). */
export function absenceShapeIssues(a: AbsenceShape): Array<{ path: string; message: string }> {
  const issues: Array<{ path: string; message: string }> = [];
  if (a.endDate < a.startDate) issues.push({ path: 'endDate', message: 'endDate must not be before startDate' });
  else if (dayCount(a.startDate, a.endDate) > MAX_ABSENCE_DAYS) issues.push({ path: 'endDate', message: `An absence can span at most ${MAX_ABSENCE_DAYS} days` });
  const scope = a.scope ?? 'FULL_DAY';
  if (scope === 'FULL_DAY') {
    if (a.fromPeriod != null || a.toPeriod != null) issues.push({ path: 'scope', message: 'A FULL_DAY absence has no fromPeriod/toPeriod; use scope PERIODS for a partial day' });
  } else {
    if (a.fromPeriod == null) issues.push({ path: 'fromPeriod', message: 'fromPeriod is required for a PERIODS absence' });
    if (a.toPeriod == null) issues.push({ path: 'toPeriod', message: 'toPeriod is required for a PERIODS absence' });
    if (a.fromPeriod != null && a.toPeriod != null && a.toPeriod < a.fromPeriod) issues.push({ path: 'toPeriod', message: 'toPeriod must not be before fromPeriod' });
  }
  return issues;
}

export const createAbsenceSchema = z.object(absenceFields).superRefine((v, ctx) => {
  for (const i of absenceShapeIssues(v)) ctx.addIssue({ code: 'custom', path: [i.path], message: i.message });
});

export const updateAbsenceSchema = z
  .object({
    /** Not changeable: present only to refuse it with a clear message instead of silently ignoring it. */
    teacherId: z.unknown().optional(),
    startDate: dateString.optional(),
    endDate: dateString.optional(),
    scope: absenceFields.scope,
    fromPeriod: absenceFields.fromPeriod,
    toPeriod: absenceFields.toPeriod,
    reason,
    autoAssign: absenceFields.autoAssign,
    allowTemporaryCover: absenceFields.allowTemporaryCover,
  })
  .refine((v) => v.teacherId === undefined, { path: ['teacherId'], message: 'The teacher of an absence cannot be changed: cancel this absence and record a new one' })
  .refine((v) => [v.startDate, v.endDate, v.scope, v.fromPeriod, v.toPeriod, v.reason].some((x) => x !== undefined), { message: 'Provide at least one field to change' });

export const listAbsencesQuerySchema = z.object({
  teacherId: uuid('teacher').optional(),
  status: z.enum(['ACTIVE', 'CANCELLED']).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
});

// ---------------------------------------------------------------------------
// Unavailability
// ---------------------------------------------------------------------------
export const createUnavailabilitySchema = z.object({
  teacherId: uuid('teacher'),
  date: dateString,
  periodNumber: periodNumber.nullable().optional(),
  reason,
});

export const listUnavailabilityQuerySchema = z.object({
  teacherId: uuid('teacher').optional(),
  from: dateString.optional(),
  to: dateString.optional(),
  status: z.enum(['ACTIVE', 'CANCELLED']).optional(),
});

// ---------------------------------------------------------------------------
// Cover requests
// ---------------------------------------------------------------------------
const COVER_STATUSES = ['OPEN', 'ASSIGNED', 'CANCELLED', 'OBSOLETE'] as const;

export const listCoverQuerySchema = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
  /** Comma separated, e.g. "OPEN,ASSIGNED". Default: every status (history included). */
  status: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return undefined;
      const parts = v.split(',').map((s) => s.trim());
      const bad = parts.filter((p) => !(COVER_STATUSES as readonly string[]).includes(p));
      if (bad.length > 0) {
        ctx.addIssue({ code: 'custom', message: `Unknown status: ${bad.join(', ')}` });
        return z.NEVER;
      }
      return parts as Array<(typeof COVER_STATUSES)[number]>;
    }),
  absentTeacherId: uuid('teacher').optional(),
  replacementTeacherId: uuid('teacher').optional(),
  absenceId: uuid('absence').optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const candidatesQuerySchema = z.object({
  /** "true": also list the teachers who cannot take the lesson, each with the reason. */
  includeExcluded: z.enum(['true', 'false']).optional(),
});

export const assignReplacementSchema = z.object({
  teacherId: uuid('teacher'),
  /** Required (true) to assign a LAST-RESORT teacher: one who would end up with four or more consecutive teaching periods. Ignored otherwise. */
  confirmFourConsecutive: z.boolean().optional(),
});
/** Reasons the system itself writes when it cancels a request; an admin's free text must not be mistaken for one (a request cancelled with them can be reopened). */
export const SYSTEM_CANCEL_REASONS = ['ABSENCE_CHANGED', 'ABSENCE_CANCELLED', 'SUBSTITUTE_ABSENT', 'SUBSTITUTE_UNAVAILABLE'] as const;
export const cancelCoverSchema = z.object({
  reason: reason.refine((v) => v == null || !(SYSTEM_CANCEL_REASONS as readonly string[]).includes(v.trim().toUpperCase()), { message: 'This reason is reserved for automatic cancellations; write a different reason' }),
});

export const autoAssignBodySchema = z.object({ allowTemporaryCover: z.boolean().optional() });
export const autoAssignRangeBodySchema = z.object({ from: dateString.optional(), to: dateString.optional(), allowTemporaryCover: z.boolean().optional() }).refine((v) => !v.from || !v.to || v.to >= v.from, { path: ['to'], message: 'to must not be before from' });
export const updateSettingsSchema = z.object({ consecutivePeriodPolicy: z.enum(CONSECUTIVE_POLICIES, { error: 'consecutivePeriodPolicy must be ALLOW, PREFER_AVOID or NEVER_ALLOW' }) });
export const listEventsQuerySchema = z.object({
  /** Only events strictly after this time (first call). Prefer `cursor` afterwards: events written together share a timestamp. */
  since: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Must be an ISO timestamp').optional(),
  /** The nextCursor of the previous response: continues exactly after the last event received. */
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const idParamSchema = z.object({ id: z.string().uuid('Invalid ID format') });

export type CreateAbsenceInput = z.output<typeof createAbsenceSchema>;
export type UpdateAbsenceInput = z.output<typeof updateAbsenceSchema>;
export type ListAbsencesQuery = z.output<typeof listAbsencesQuerySchema>;
export type CreateUnavailabilityInput = z.output<typeof createUnavailabilitySchema>;
export type ListUnavailabilityQuery = z.output<typeof listUnavailabilityQuerySchema>;
export type ListCoverQuery = z.output<typeof listCoverQuerySchema>;
export type CandidatesQuery = z.output<typeof candidatesQuerySchema>;
