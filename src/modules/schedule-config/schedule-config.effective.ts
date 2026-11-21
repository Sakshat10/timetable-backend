import type { DayOfWeek } from '@prisma/client';

// ---------------------------------------------------------------------------
// The ONE place that turns a stored schedule configuration into what scheduling needs: working days, the teaching periods 1..periodsPerDay and where the
// day's break is. Nothing here (and nothing that consumes it) reads a clock time.
//
//   simplified configuration  schedule_configs.breakAfterPeriod is set: exactly one break, after that period.
//   legacy configuration      breakAfterPeriod is NULL (made before the simplification, zero or several timing events): the break positions are the stored
//                             timing events' afterPeriodNumber, exactly as the scheduler always used them, until an admin saves the simplified form.
//
// The legacy tables schedule_periods / schedule_timing_events are read-only history; their start/end minutes are never consulted here.
// ---------------------------------------------------------------------------

/** What a Prisma `select` must read to build an effective schedule. */
export const SCHEDULE_ENGINE_SELECT = {
  periodsPerDay: true,
  breakAfterPeriod: true,
  days: { select: { dayOfWeek: true } },
  timingEvents: { select: { afterPeriodNumber: true } },
} as const;

export interface ScheduleEngineRow {
  periodsPerDay: number;
  breakAfterPeriod: number | null;
  days: ReadonlyArray<{ dayOfWeek: DayOfWeek }>;
  timingEvents: ReadonlyArray<{ afterPeriodNumber: number }>;
}

export interface EffectiveSchedule {
  periodsPerDay: number;
  workingDays: DayOfWeek[];
  /** Teaching periods 1..periodsPerDay. The break is NOT a period. */
  periods: Array<{ periodNumber: number }>;
  /** Positions k meaning "a break separates period k from period k+1" (a single one for a simplified configuration). */
  breakPositions: number[];
  legacy: boolean;
  /** workingDays x periodsPerDay: the number of teaching slots in a week. The break adds none. */
  weeklyTeachingCapacity: number;
}

export function effectiveSchedule(row: ScheduleEngineRow): EffectiveSchedule {
  const legacy = row.breakAfterPeriod === null;
  const breakPositions = legacy ? [...new Set(row.timingEvents.map((e) => e.afterPeriodNumber))].sort((a, b) => a - b) : [row.breakAfterPeriod as number];
  const workingDays = row.days.map((d) => d.dayOfWeek);
  return {
    periodsPerDay: row.periodsPerDay,
    workingDays,
    periods: Array.from({ length: row.periodsPerDay }, (_, i) => ({ periodNumber: i + 1 })),
    breakPositions,
    legacy,
    weeklyTeachingCapacity: workingDays.length * row.periodsPerDay,
  };
}
