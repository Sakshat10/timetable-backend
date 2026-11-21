import { type DayOfWeek, type Prisma, type ScheduleEventType } from '@prisma/client';
import prisma from '../../config/database.js';
import {
  MAX_PERIODS_PER_DAY,
  MIN_PERIODS_PER_DAY,
  type CreateScheduleConfigInput,
  type ListScheduleConfigsQuery,
  type UpdateScheduleConfigInput,
} from './schedule-config.schema.js';
import { effectiveSchedule } from './schedule-config.effective.js';
import { AppError, isUniqueViolation } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// The simplified schedule: working days + teaching periods per day + exactly one break position. No clock times are written, validated or required.
// (Legacy configurations made before migration 20261117090000 are still READ: their stored timings are returned unchanged as read-only history.)
// ---------------------------------------------------------------------------
export interface ScheduleState {
  workingDays: DayOfWeek[];
  periodsPerDay: number;
  breakAfterPeriod: number;
}

const DAY_ORDER: DayOfWeek[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

const DRAFT_ONLY_MESSAGE = 'Schedule configuration can only be modified while the academic year is in DRAFT status';

/** Weekly teaching capacity: working days x teaching periods per day. The break is not a teaching period and adds nothing. */
export const weeklyTeachingCapacity = (workingDayCount: number, periodsPerDay: number): number => workingDayCount * periodsPerDay;

/** Pure validation of a COMPLETE schedule. Used for create and for the merged result of every PATCH, before anything is written. */
export function validateSchedule(state: ScheduleState): void {
  const { workingDays, periodsPerDay, breakAfterPeriod } = state;
  if (workingDays.length < 1 || new Set(workingDays).size !== workingDays.length) {
    throw new AppError(400, 'workingDays must contain between 1 and 7 distinct days');
  }
  if (!Number.isInteger(periodsPerDay) || periodsPerDay < MIN_PERIODS_PER_DAY || periodsPerDay > MAX_PERIODS_PER_DAY) {
    throw new AppError(400, `periodsPerDay must be a whole number between ${MIN_PERIODS_PER_DAY} and ${MAX_PERIODS_PER_DAY}`);
  }
  if (!Number.isInteger(breakAfterPeriod) || breakAfterPeriod < 1 || breakAfterPeriod > periodsPerDay - 1) {
    throw new AppError(400, `breakAfterPeriod must be a whole number between 1 and ${periodsPerDay - 1} (periodsPerDay is ${periodsPerDay}: the break sits between two teaching periods)`);
  }
}

// ---------------------------------------------------------------------------
// Response document
// ---------------------------------------------------------------------------
export type TimelineItem =
  | { kind: 'PERIOD'; periodNumber: number; startTime: string | null; endTime: string | null }
  | { kind: 'BREAK'; afterPeriodNumber: number }
  | { kind: 'EVENT'; type: ScheduleEventType; label: string | null; startTime: string; endTime: string };

export interface ScheduleConfigDocument {
  id: string;
  academicYearId: string;
  periodsPerDay: number;
  workingDays: DayOfWeek[];
  /** The one break per day: after this teaching period. NULL only for a legacy configuration (see `legacy`). */
  breakAfterPeriod: number | null;
  /** workingDays.length x periodsPerDay. */
  weeklyTeachingCapacity: number;
  /** true: made before the simplification and not yet saved with the simplified form. Its timings below are read-only history. */
  legacy: boolean;
  /** Compatibility: the teaching periods. Times are null for a simplified configuration (it has none). */
  periods: Array<{ periodNumber: number; startTime: string | null; endTime: string | null }>;
  /** Compatibility: stored timing events of a LEGACY configuration, unchanged. Always [] for a simplified one. */
  timingEvents: Array<{ type: ScheduleEventType; label: string | null; afterPeriodNumber: number; startTime: string; endTime: string }>;
  /** Periods in order with the break after `breakAfterPeriod` (simplified) or the stored events in clock order (legacy). */
  timeline: TimelineItem[];
  createdAt: Date;
  updatedAt: Date;
}

const configInclude = {
  days: { orderBy: { dayOfWeek: 'asc' } },
  periods: { orderBy: { periodNumber: 'asc' } },
  timingEvents: { orderBy: [{ startMinute: 'asc' }, { endMinute: 'asc' }] },
} satisfies Prisma.ScheduleConfigInclude;

type ConfigRow = Prisma.ScheduleConfigGetPayload<{ include: typeof configInclude }>;

const hhmm = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function toDocument(row: ConfigRow): ScheduleConfigDocument {
  const eff = effectiveSchedule(row);
  const workingDays = [...eff.workingDays].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
  const base = { id: row.id, academicYearId: row.academicYearId, periodsPerDay: row.periodsPerDay, workingDays, breakAfterPeriod: row.breakAfterPeriod, weeklyTeachingCapacity: eff.weeklyTeachingCapacity, legacy: eff.legacy, createdAt: row.createdAt, updatedAt: row.updatedAt };

  if (!eff.legacy) {
    const timeline: TimelineItem[] = [];
    for (const p of eff.periods) {
      timeline.push({ kind: 'PERIOD', periodNumber: p.periodNumber, startTime: null, endTime: null });
      if (p.periodNumber === row.breakAfterPeriod) timeline.push({ kind: 'BREAK', afterPeriodNumber: p.periodNumber });
    }
    return { ...base, periods: eff.periods.map((p) => ({ periodNumber: p.periodNumber, startTime: null, endTime: null })), timingEvents: [], timeline };
  }

  // Legacy: exactly what was stored, read-only.
  const periods = row.periods.map((p) => ({ periodNumber: p.periodNumber, startTime: hhmm(p.startMinute), endTime: hhmm(p.endMinute) }));
  const timingEvents = row.timingEvents.map((e) => ({ type: e.eventType, label: e.label, afterPeriodNumber: e.afterPeriodNumber, startTime: hhmm(e.startMinute), endTime: hhmm(e.endMinute) }));
  const timeline: Array<{ start: number; item: TimelineItem }> = [
    ...row.periods.map((p) => ({ start: p.startMinute, item: { kind: 'PERIOD' as const, periodNumber: p.periodNumber, startTime: hhmm(p.startMinute), endTime: hhmm(p.endMinute) } })),
    ...row.timingEvents.map((e) => ({ start: e.startMinute, item: { kind: 'EVENT' as const, type: e.eventType, label: e.label, startTime: hhmm(e.startMinute), endTime: hhmm(e.endMinute) } })),
  ].sort((a, b) => a.start - b.start);
  return { ...base, periods, timingEvents, timeline: timeline.map((t) => t.item) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function duplicateConfigError(): AppError {
  return new AppError(409, 'A schedule configuration already exists for this academic year');
}

/** Fetch a config and verify it belongs to the school through its academic year. 404 if not found, 403 on an ownership mismatch. */
async function fetchConfigWithOwnership(configId: string, schoolId: string) {
  const config = await prisma.scheduleConfig.findUnique({ where: { id: configId }, include: { academicYear: true } });
  if (!config) throw new AppError(404, 'Schedule configuration not found');
  if (config.academicYear.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this schedule configuration');
  return config;
}

/** Re-check the academic-year status inside the transaction under a share lock, so a status change (which takes a row lock) cannot slip in between check and write. */
async function assertAcademicYearDraftLocked(tx: Prisma.TransactionClient, academicYearId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status" FROM "academic_years" WHERE "id" = ${academicYearId} FOR SHARE`;
  if (rows[0]?.status !== 'DRAFT') throw new AppError(400, DRAFT_ONLY_MESSAGE);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
export class ScheduleConfigService {
  /** Create the (single) schedule configuration of an academic year. The unique index on academicYearId is the backstop for concurrent creates (409). */
  async createScheduleConfig(schoolId: string, data: CreateScheduleConfigInput): Promise<ScheduleConfigDocument> {
    const academicYear = await prisma.academicYear.findUnique({ where: { id: data.academicYearId } });
    if (!academicYear) throw new AppError(404, 'Academic year not found');
    if (academicYear.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this academic year');
    if (academicYear.status !== 'DRAFT') throw new AppError(400, DRAFT_ONLY_MESSAGE);

    const state: ScheduleState = { workingDays: data.workingDays, periodsPerDay: data.periodsPerDay, breakAfterPeriod: data.breakAfterPeriod };
    validateSchedule(state);

    if (await prisma.scheduleConfig.findUnique({ where: { academicYearId: data.academicYearId } })) throw duplicateConfigError();

    try {
      const createdId = await prisma.$transaction(async (tx) => {
        await assertAcademicYearDraftLocked(tx, data.academicYearId);
        const created = await tx.scheduleConfig.create({
          data: {
            academicYearId: data.academicYearId,
            periodsPerDay: state.periodsPerDay,
            breakAfterPeriod: state.breakAfterPeriod,
            days: { create: state.workingDays.map((dayOfWeek) => ({ dayOfWeek })) },
          },
          select: { id: true },
        });
        return created.id;
      });
      return await this.loadDocument(createdId);
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateConfigError();
      throw error;
    }
  }

  /** List the school's configurations (at most one per academic year). Optional academicYearId filter, ownership-checked. Allowed in any academic-year status. */
  async getScheduleConfigs(schoolId: string, filters: ListScheduleConfigsQuery): Promise<ScheduleConfigDocument[]> {
    if (filters.academicYearId !== undefined) {
      const academicYear = await prisma.academicYear.findUnique({ where: { id: filters.academicYearId } });
      if (!academicYear) throw new AppError(404, 'Academic year not found');
      if (academicYear.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this academic year');
    }
    const rows = await prisma.scheduleConfig.findMany({
      where: { academicYear: { schoolId, ...(filters.academicYearId !== undefined && { id: filters.academicYearId }) } },
      include: configInclude,
      orderBy: { academicYear: { startDate: 'desc' } },
    });
    return rows.map(toDocument);
  }

  async getScheduleConfigById(configId: string, schoolId: string): Promise<ScheduleConfigDocument> {
    const owned = await fetchConfigWithOwnership(configId, schoolId);
    return this.loadDocument(owned.id);
  }

  /**
   * Update the configuration. Each supplied field (workingDays, periodsPerDay, breakAfterPeriod) replaces that field; the current state is merged with them under a row
   * lock and the COMPLETE merged schedule is validated before anything is written. A legacy configuration (no breakAfterPeriod yet) must be given breakAfterPeriod: that
   * converts it to the simplified model. Legacy timing rows are never modified or deleted: they stay as read-only history.
   */
  async updateScheduleConfig(configId: string, schoolId: string, data: UpdateScheduleConfigInput): Promise<ScheduleConfigDocument> {
    const owned = await fetchConfigWithOwnership(configId, schoolId);
    if (owned.academicYear.status !== 'DRAFT') throw new AppError(400, DRAFT_ONLY_MESSAGE);

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "schedule_configs" WHERE "id" = ${configId} FOR UPDATE`;
      await assertAcademicYearDraftLocked(tx, owned.academicYearId);
      const current = await tx.scheduleConfig.findUniqueOrThrow({ where: { id: configId }, include: { days: true } });

      const mergedBreak = data.breakAfterPeriod ?? current.breakAfterPeriod;
      if (mergedBreak === null) {
        throw new AppError(400, 'This schedule was made before the simplified model and has no single break position yet. Send breakAfterPeriod (1..periodsPerDay-1) to convert it.');
      }
      const merged: ScheduleState = {
        workingDays: data.workingDays ?? current.days.map((d) => d.dayOfWeek),
        periodsPerDay: data.periodsPerDay ?? current.periodsPerDay,
        breakAfterPeriod: mergedBreak,
      };
      validateSchedule(merged);

      if (data.workingDays !== undefined) {
        await tx.scheduleDay.deleteMany({ where: { scheduleConfigId: configId } });
        await tx.scheduleDay.createMany({ data: merged.workingDays.map((dayOfWeek) => ({ scheduleConfigId: configId, dayOfWeek })) });
      }
      await tx.scheduleConfig.update({ where: { id: configId }, data: { periodsPerDay: merged.periodsPerDay, breakAfterPeriod: merged.breakAfterPeriod } });
    });

    return this.loadDocument(configId);
  }

  private async loadDocument(configId: string): Promise<ScheduleConfigDocument> {
    const row = await prisma.scheduleConfig.findUniqueOrThrow({ where: { id: configId }, include: configInclude });
    return toDocument(row);
  }
}

export const scheduleConfigService = new ScheduleConfigService();
