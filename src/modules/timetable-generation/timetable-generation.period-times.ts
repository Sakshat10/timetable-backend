import { z } from 'zod';

// ---------------------------------------------------------------------------
// Phase 7F-0: the period times a timetable was generated under (school-local minutes since midnight, as Module 9 stored them).
// SIMPLIFIED SCHEDULE (migration 20261117090000): schedules no longer have clock times, so NEW runs capture an EMPTY list (see parseStoredPeriodTimes). Non-empty
// snapshots below exist only on versions generated before the simplification and are kept, unchanged, as history.
//
// They are NOT part of the solver input and NOT part of the input hash or the configuration hash: scheduling does not depend on clock
// times. They are captured once per run, from the first attempt's consistent configuration snapshot, and copied to the version the run
// creates, so a timetable keeps showing the times it was made for even if the school later edits its schedule.
// ---------------------------------------------------------------------------

export const MAX_PERIOD_TIMES = 12;

export const periodTimeSchema = z.strictObject({
  periodNumber: z.int().min(1).max(MAX_PERIOD_TIMES),
  startMinute: z.int().min(0).max(1438),
  endMinute: z.int().min(1).max(1439),
});

/** Periods 1..n in order, each starting before it ends. */
export const periodTimesSchema = z
  .array(periodTimeSchema)
  .min(1)
  .max(MAX_PERIOD_TIMES)
  .refine((times) => times.every((t, i) => t.periodNumber === i + 1 && t.startMinute < t.endMinute), 'period times must be numbered 1..n in order, each starting before it ends');

export type PeriodTime = z.infer<typeof periodTimeSchema>;

export function parsePeriodTimes(value: unknown): PeriodTime[] | null {
  const parsed = periodTimesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Reads a STORED period-times value. Since the simplified schedule (migration 20261117090000) a schedule has no clock times, so a new run / version stores an EMPTY
 * list with a capture timestamp: "this timetable has no clock times, by design". It is distinct from NULL, which only a version generated before period times were
 * captured (7F-0) has. A non-empty value is parsed exactly as before, so every historical snapshot stays readable.
 */
export function parseStoredPeriodTimes(value: unknown): PeriodTime[] | null {
  if (Array.isArray(value) && value.length === 0) return [];
  return parsePeriodTimes(value);
}

/** True when the times describe exactly the periods 1..periodsPerDay of the problem. An empty list (a schedule without clock times) has nothing to match. */
export function periodTimesMatchGrid(times: readonly PeriodTime[], periodsPerDay: number): boolean {
  if (times.length === 0) return true;
  return times.length === periodsPerDay && times.every((t, i) => t.periodNumber === i + 1);
}
