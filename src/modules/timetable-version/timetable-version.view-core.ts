import { DAYS_OF_WEEK } from './timetable-version.schema.js';
import { type PeriodTime } from '../timetable-generation/timetable-generation.period-times.js';

// ---------------------------------------------------------------------------
// Phase 7F-1: readable timetable views. PURE: no database, no clock. The service reads; this file assembles.
//
// A view is ONE section's week or ONE teacher's week of ONE version, as a full grid (every working day x every period, empty slots
// included) with the names a person needs, the lock state and the entry source, and totals.
//
// Period times, three sources (never mixed within one response):
//   SNAPSHOT     the times stored with the version when it was generated (the default whenever they exist);
//   CURRENT      the school's live schedule, only when explicitly requested (?periodTimes=current);
//   UNAVAILABLE  a legacy version (generated before 7F-0) without stored times and without an explicit request: no times are invented.
//   NONE         a version generated under the simplified schedule (no clock times, by design): periods carry no times and nothing is missing. Never combined with `current`.
// `changedSinceCapture` is a CONTENT comparison of the stored times with the live schedule, so an edit that was changed back is not
// reported, and a timestamp race cannot hide a real change. It is null whenever there is nothing stored to compare.
// ---------------------------------------------------------------------------

export type ViewKind = 'section' | 'teacher';
export type PeriodTimesRequest = 'snapshot' | 'current';
export type PeriodTimesSource = 'SNAPSHOT' | 'CURRENT' | 'UNAVAILABLE' | 'NONE';

export interface ViewEntryRow {
  id: string;
  sectionId: string;
  subjectId: string;
  teacherId: string;
  subjectRequirementId: string;
  dayOfWeek: string;
  periodNumber: number;
  source: string;
  isLocked: boolean;
}

export interface ViewGrid {
  days: Array<{ index: number; dayOfWeek: string }>;
  periods: Array<{ periodNumber: number; continuesIntoNext: boolean }>;
}

export interface SectionName { name: string; code: string; gradeName: string }
export interface SubjectName { name: string; code: string }
export interface TeacherName { name: string; isActive: boolean }

export interface NameMaps {
  sections: ReadonlyMap<string, SectionName>;
  subjects: ReadonlyMap<string, SubjectName>;
  teachers: ReadonlyMap<string, TeacherName>;
}

export interface LessonView {
  entryId: string;
  /** Names are null only if the row could not be resolved inside this school and academic year (never another school's name). */
  section: { id: string; name: string | null; code: string | null; gradeName: string | null };
  subject: { id: string; name: string | null; code: string | null };
  teacher: { id: string; name: string | null; isActive: boolean | null };
  subjectRequirementId: string;
  isLocked: boolean;
  source: string;
}

export interface PeriodTimesInfo {
  source: PeriodTimesSource;
  /** When the stored times were captured (the run's first snapshot). Null for legacy versions and for CURRENT without a snapshot. */
  capturedAt: string | null;
  /** The stored times differ from the live schedule. Null when the version has no stored times. */
  changedSinceCapture: boolean | null;
  /** Legacy version viewed with periodTimes=current only: a HEURISTIC (live period rows created after the version). Null otherwise. */
  periodRowsCreatedAfterVersion: boolean | null;
  /** The live schedule has no period for some grid period (CURRENT) or the stored times do not cover the grid (SNAPSHOT). */
  incomplete: boolean;
}

export const toHHmm = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Exactly the same periods with the same start and end minutes. */
export function sameTimes(a: readonly PeriodTime[], b: readonly PeriodTime[]): boolean {
  if (a.length !== b.length) return false;
  const byNumber = new Map(b.map((t) => [t.periodNumber, t]));
  return a.every((t) => {
    const o = byNumber.get(t.periodNumber);
    return o !== undefined && o.startMinute === t.startMinute && o.endMinute === t.endMinute;
  });
}

export interface PeriodTimesInput {
  stored: readonly PeriodTime[] | null;
  storedCapturedAt: Date | null;
  /** The live schedule's periods; null when it was not read (legacy version, default request) or the year has no schedule rows. */
  live: readonly PeriodTime[] | null;
  /** Whether `live` was read at all (false: no comparison was possible and none is claimed). */
  liveRead: boolean;
  requested: PeriodTimesRequest;
  /** Heuristic input: some live period row was created after the version was. Only used for a legacy version with `current`. */
  liveRowsCreatedAfterVersion: boolean | null;
  gridPeriods: readonly number[];
  /** The version stores an EMPTY period-time list: made under the simplified schedule, which has no clock times. */
  noTimes?: boolean;
}

export function resolvePeriodTimes(input: PeriodTimesInput): { info: PeriodTimesInfo; byPeriod: Map<number, PeriodTime> } {
  const { stored, live, requested } = input;
  if (input.noTimes) {
    return { info: { source: 'NONE', capturedAt: input.storedCapturedAt ? input.storedCapturedAt.toISOString() : null, changedSinceCapture: null, periodRowsCreatedAfterVersion: null, incomplete: false }, byPeriod: new Map() };
  }
  const covers = (times: readonly PeriodTime[] | null): boolean => times !== null && input.gridPeriods.every((n) => times.some((t) => t.periodNumber === n));
  const byPeriodOf = (times: readonly PeriodTime[] | null): Map<number, PeriodTime> => new Map((times ?? []).map((t) => [t.periodNumber, t]));
  const changed = stored !== null && input.liveRead ? !(live !== null && sameTimes(stored, live)) : null;

  if (requested === 'current') {
    return {
      info: {
        source: 'CURRENT',
        capturedAt: stored !== null && input.storedCapturedAt ? input.storedCapturedAt.toISOString() : null,
        changedSinceCapture: changed,
        periodRowsCreatedAfterVersion: stored === null ? input.liveRowsCreatedAfterVersion : null,
        incomplete: !covers(live),
      },
      byPeriod: byPeriodOf(live),
    };
  }
  if (stored !== null) {
    return {
      info: { source: 'SNAPSHOT', capturedAt: input.storedCapturedAt ? input.storedCapturedAt.toISOString() : null, changedSinceCapture: changed, periodRowsCreatedAfterVersion: null, incomplete: !covers(stored) },
      byPeriod: byPeriodOf(stored),
    };
  }
  return { info: { source: 'UNAVAILABLE', capturedAt: null, changedSinceCapture: null, periodRowsCreatedAfterVersion: null, incomplete: true }, byPeriod: new Map() };
}

export interface BuildViewInput {
  kind: ViewKind;
  grid: ViewGrid;
  entries: readonly ViewEntryRow[];
  names: NameMaps;
  times: { info: PeriodTimesInfo; byPeriod: ReadonlyMap<number, PeriodTime> };
}

export interface CountBy { id: string; name: string | null; lessons: number }

export interface ViewBody {
  grid: {
    days: Array<{ dayOfWeek: string; index: number }>;
    periods: Array<{ periodNumber: number; continuesIntoNext: boolean; startMinute: number | null; endMinute: number | null; startTime: string | null; endTime: string | null }>;
  };
  periodTimes: PeriodTimesInfo;
  cells: Array<{ dayOfWeek: string; periodNumber: number; lesson: LessonView | null }>;
  totals: {
    lessons: number;
    lockedLessons: number;
    manualLessons: number;
    /** Grid slots without a lesson (days x periods - placed lessons). */
    freeSlots: number;
    /** Lessons whose day or period is not in this version's grid (never expected; reported instead of hidden). */
    outsideGrid: number;
    perDay: Array<{ dayOfWeek: string; lessons: number }>;
    bySubject: CountBy[];
    /** Section view: who teaches the section. */
    byTeacher?: CountBy[];
    /** Teacher view: which sections the teacher teaches. */
    bySection?: CountBy[];
  };
}

const dayRank = new Map<string, number>(DAYS_OF_WEEK.map((d, i) => [d, i]));

function countBy(entries: readonly ViewEntryRow[], key: (e: ViewEntryRow) => string, name: (id: string) => string | null): CountBy[] {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(key(e), (counts.get(key(e)) ?? 0) + 1);
  return [...counts.entries()]
    .map(([id, lessons]) => ({ id, name: name(id), lessons }))
    .sort((a, b) => b.lessons - a.lessons || (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id));
}

export function buildView(input: BuildViewInput): ViewBody {
  const { grid, names, times } = input;
  const days = [...grid.days].sort((a, b) => a.index - b.index || (dayRank.get(a.dayOfWeek) ?? 0) - (dayRank.get(b.dayOfWeek) ?? 0));
  const periods = [...grid.periods].sort((a, b) => a.periodNumber - b.periodNumber);
  const entries = [...input.entries].sort((a, b) => (dayRank.get(a.dayOfWeek) ?? 99) - (dayRank.get(b.dayOfWeek) ?? 99) || a.periodNumber - b.periodNumber || a.id.localeCompare(b.id));

  const lessonOf = (e: ViewEntryRow): LessonView => {
    const section = names.sections.get(e.sectionId);
    const subject = names.subjects.get(e.subjectId);
    const teacher = names.teachers.get(e.teacherId);
    return {
      entryId: e.id,
      section: { id: e.sectionId, name: section?.name ?? null, code: section?.code ?? null, gradeName: section?.gradeName ?? null },
      subject: { id: e.subjectId, name: subject?.name ?? null, code: subject?.code ?? null },
      teacher: { id: e.teacherId, name: teacher?.name ?? null, isActive: teacher?.isActive ?? null },
      subjectRequirementId: e.subjectRequirementId,
      isLocked: e.isLocked,
      source: e.source,
    };
  };

  const slot = new Map<string, ViewEntryRow>();
  let outsideGrid = 0;
  const dayNames = new Set(days.map((d) => d.dayOfWeek));
  const periodNumbers = new Set(periods.map((p) => p.periodNumber));
  const inGrid: ViewEntryRow[] = [];
  for (const e of entries) {
    if (!dayNames.has(e.dayOfWeek) || !periodNumbers.has(e.periodNumber)) { outsideGrid++; continue; }
    slot.set(`${e.dayOfWeek}|${e.periodNumber}`, e);
    inGrid.push(e);
  }

  const cells: ViewBody['cells'] = [];
  for (const d of days) {
    for (const p of periods) {
      const e = slot.get(`${d.dayOfWeek}|${p.periodNumber}`);
      cells.push({ dayOfWeek: d.dayOfWeek, periodNumber: p.periodNumber, lesson: e ? lessonOf(e) : null });
    }
  }

  const totals: ViewBody['totals'] = {
    lessons: entries.length,
    lockedLessons: entries.filter((e) => e.isLocked).length,
    manualLessons: entries.filter((e) => e.source === 'MANUAL').length,
    freeSlots: days.length * periods.length - inGrid.length,
    outsideGrid,
    perDay: days.map((d) => ({ dayOfWeek: d.dayOfWeek, lessons: inGrid.filter((e) => e.dayOfWeek === d.dayOfWeek).length })),
    bySubject: countBy(entries, (e) => e.subjectId, (id) => names.subjects.get(id)?.name ?? null),
  };
  if (input.kind === 'section') totals.byTeacher = countBy(entries, (e) => e.teacherId, (id) => names.teachers.get(id)?.name ?? null);
  else totals.bySection = countBy(entries, (e) => e.sectionId, (id) => { const s = names.sections.get(id); return s ? `${s.gradeName} ${s.name}` : null; });

  return {
    grid: {
      days: days.map((d) => ({ dayOfWeek: d.dayOfWeek, index: d.index })),
      periods: periods.map((p) => {
        const t = times.byPeriod.get(p.periodNumber);
        return {
          periodNumber: p.periodNumber,
          continuesIntoNext: p.continuesIntoNext,
          startMinute: t?.startMinute ?? null,
          endMinute: t?.endMinute ?? null,
          startTime: t ? toHHmm(t.startMinute) : null,
          endTime: t ? toHHmm(t.endMinute) : null,
        };
      }),
    },
    periodTimes: times.info,
    cells,
    totals,
  };
}
