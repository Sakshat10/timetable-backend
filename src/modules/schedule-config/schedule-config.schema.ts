import { z } from 'zod';

// ---------------------------------------------------------------------------
// The simplified school schedule (migration 20261117090000). The school configures ONLY:
//   1. the working days (any subset of Monday..Sunday),
//   2. the number of teaching periods per day,
//   3. exactly ONE break per working day, given as the period AFTER WHICH it happens.
// There are no clock times, no break durations and no other timing events. The break is not a teaching period.
// ---------------------------------------------------------------------------

/** A break needs a period before it and one after it, so a day has at least 2 teaching periods. */
export const MIN_PERIODS_PER_DAY = 2;
export const MAX_PERIODS_PER_DAY = 12;

export const DAYS_OF_WEEK = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;

const LEGACY_FIELDS_MESSAGE =
  'Clock times are no longer part of the schedule. Send only workingDays, periodsPerDay and breakAfterPeriod (periods and timingEvents are not accepted).';

// These routes bypass Fastify's coercing Ajv validation (see the routes file): real JSON numbers and strings only.
const workingDaysSchema = z
  .array(z.enum(DAYS_OF_WEEK, { error: 'Invalid day of week' }), { error: 'workingDays must be an array of days of the week' })
  .min(1, 'At least one working day is required')
  .max(7, 'At most 7 working days are allowed')
  .refine((days) => new Set(days).size === days.length, { message: 'workingDays must not contain duplicate days' });

const periodsPerDaySchema = z
  .number({ error: 'periodsPerDay must be a number' })
  .int('periodsPerDay must be an integer')
  .min(MIN_PERIODS_PER_DAY, `periodsPerDay must be at least ${MIN_PERIODS_PER_DAY} (the break sits between two teaching periods)`)
  .max(MAX_PERIODS_PER_DAY, `periodsPerDay must not exceed ${MAX_PERIODS_PER_DAY}`);

const breakAfterPeriodSchema = z
  .number({ error: 'breakAfterPeriod must be a number' })
  .int('breakAfterPeriod must be an integer')
  .min(1, 'breakAfterPeriod must be at least 1 (the break comes after a teaching period)');

/** Old payload fields: accepted by the parser only so they can be refused with a clear message instead of "unrecognized key". */
const refuseLegacy = (v: { periods?: unknown; timingEvents?: unknown }, ctx: z.RefinementCtx): void => {
  if (v.periods !== undefined) ctx.addIssue({ code: 'custom', path: ['periods'], message: LEGACY_FIELDS_MESSAGE });
  if (v.timingEvents !== undefined) ctx.addIssue({ code: 'custom', path: ['timingEvents'], message: LEGACY_FIELDS_MESSAGE });
};

export const createScheduleConfigSchema = z
  .object({
    academicYearId: z.string().uuid('Invalid academic year ID format'),
    workingDays: workingDaysSchema,
    periodsPerDay: periodsPerDaySchema,
    breakAfterPeriod: breakAfterPeriodSchema,
    periods: z.unknown().optional(),
    timingEvents: z.unknown().optional(),
  })
  .superRefine(refuseLegacy)
  .superRefine((v, ctx) => {
    if (v.breakAfterPeriod >= v.periodsPerDay) {
      ctx.addIssue({ code: 'custom', path: ['breakAfterPeriod'], message: `breakAfterPeriod must be between 1 and ${v.periodsPerDay - 1} (periodsPerDay is ${v.periodsPerDay}; the break cannot come after the last period)` });
    }
  });

// Each supplied field replaces that field; the merged result is re-validated as a whole.
export const updateScheduleConfigSchema = z
  .object({
    academicYearId: z.never({ error: 'academicYearId cannot be changed' }).optional(),
    workingDays: workingDaysSchema.optional(),
    periodsPerDay: periodsPerDaySchema.optional(),
    breakAfterPeriod: breakAfterPeriodSchema.optional(),
    periods: z.unknown().optional(),
    timingEvents: z.unknown().optional(),
  })
  .superRefine(refuseLegacy)
  .refine((v) => v.workingDays !== undefined || v.periodsPerDay !== undefined || v.breakAfterPeriod !== undefined, {
    message: 'At least one of workingDays, periodsPerDay or breakAfterPeriod must be provided',
  });

export const listScheduleConfigsQuerySchema = z.object({
  academicYearId: z.string().uuid('Invalid academic year ID format').optional(),
});

export const scheduleConfigIdParamSchema = z.object({
  id: z.string().uuid('Invalid schedule config ID format'),
});

export type CreateScheduleConfigBody = z.input<typeof createScheduleConfigSchema>;
export type UpdateScheduleConfigBody = z.input<typeof updateScheduleConfigSchema>;
export type CreateScheduleConfigInput = z.output<typeof createScheduleConfigSchema>;
export type UpdateScheduleConfigInput = z.output<typeof updateScheduleConfigSchema>;
export type ListScheduleConfigsQuery = z.infer<typeof listScheduleConfigsQuerySchema>;
export type ScheduleConfigIdParam = z.infer<typeof scheduleConfigIdParamSchema>;
