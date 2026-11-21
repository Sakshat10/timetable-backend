import { type Prisma } from '@prisma/client';
import { effectiveSchedule, SCHEDULE_ENGINE_SELECT } from '../schedule-config/schedule-config.effective.js';
import {
  absenceCoversSlot,
  adjacency,
  classifyCandidate,
  dateToString,
  MAX_PERIOD,
  runThrough,
  type ExclusionReason,
  type SubjectBasis,
} from './substitution.core.js';

type Db = Prisma.TransactionClient;

export interface TeacherVerdict { teacher: { id: string; name: string; employeeCode: string | null }; reason: ExclusionReason | null; /** How the school's data says this teacher teaches the lesson's subject (null: they do not; they are still a candidate). */ basis: SubjectBasis | null }

/**
 * For every teacher of the school: can they take this lesson as a TEMPORARY cover, and if not, why (first failing rule). A teacher needs NO subject link and NO grade eligibility for
 * that: the only exclusions are the absent teacher, an inactive teacher, absence, unavailability, a lesson of the published timetable in that period, another cover in that period.
 * Separately, `basis` says whether the existing data shows the teacher teaches the lesson's subject (a teacher-subject link of either type, or lessons of that subject in the
 * published version): such teachers are preferred, nobody else is excluded for lacking it. Pure reads; callers take locks when it matters.
 */
export async function evaluateTeachers(db: Db, cover: { id: string; schoolId: string; date: Date; dayOfWeek: string; periodNumber: number; timetableVersionId: string; subjectId: string; absentTeacherId: string }): Promise<TeacherVerdict[]> {
  const date = dateToString(cover.date);
  const [teachers, links, subjectLessons, absences, unavailable, lessons, covering] = await Promise.all([
    db.teacher.findMany({ where: { schoolId: cover.schoolId }, select: { id: true, name: true, employeeCode: true, isActive: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
    db.teacherSubject.findMany({ where: { subjectId: cover.subjectId, teacher: { schoolId: cover.schoolId } }, select: { teacherId: true, type: true } }),
    db.timetableEntry.findMany({ where: { versionId: cover.timetableVersionId, subjectId: cover.subjectId }, distinct: ['teacherId'], select: { teacherId: true } }),
    db.teacherAbsence.findMany({ where: { schoolId: cover.schoolId, status: 'ACTIVE', startDate: { lte: cover.date }, endDate: { gte: cover.date } } }),
    db.teacherUnavailability.findMany({ where: { schoolId: cover.schoolId, status: 'ACTIVE', date: cover.date, OR: [{ periodNumber: null }, { periodNumber: cover.periodNumber }] }, select: { teacherId: true } }),
    db.timetableEntry.findMany({ where: { versionId: cover.timetableVersionId, dayOfWeek: cover.dayOfWeek as never, periodNumber: cover.periodNumber }, select: { teacherId: true } }),
    db.coverRequest.findMany({ where: { schoolId: cover.schoolId, date: cover.date, periodNumber: cover.periodNumber, status: 'ASSIGNED', id: { not: cover.id } }, select: { replacementTeacherId: true } }),
  ]);
  const linkType = new Map(links.map((l) => [l.teacherId, l.type]));
  const teachesInTimetable = new Set(subjectLessons.map((l) => l.teacherId));
  const basisOf = (teacherId: string): SubjectBasis | null => {
    const type = linkType.get(teacherId);
    if (type === 'PRIMARY') return 'PRIMARY_LINK';
    if (type === 'SECONDARY') return 'SECONDARY_LINK';
    return teachesInTimetable.has(teacherId) ? 'TEACHES_IN_TIMETABLE' : null;
  };
  const absentIds = new Set(absences.filter((a) => absenceCoversSlot({ startDate: dateToString(a.startDate), endDate: dateToString(a.endDate), scope: a.scope, fromPeriod: a.fromPeriod, toPeriod: a.toPeriod }, date, cover.periodNumber)).map((a) => a.teacherId));
  const unavailableIds = new Set(unavailable.map((u) => u.teacherId));
  const lessonIds = new Set(lessons.map((l) => l.teacherId));
  const coveringIds = new Set(covering.map((c) => c.replacementTeacherId).filter((x): x is string => x !== null));
  return teachers.map((t) => ({
    teacher: { id: t.id, name: t.name, employeeCode: t.employeeCode },
    basis: basisOf(t.id),
    reason: classifyCandidate({
      isAbsentTeacher: t.id === cover.absentTeacherId,
      isActive: t.isActive,
      isAbsent: absentIds.has(t.id),
      isUnavailable: unavailableIds.has(t.id),
      hasLessonInPeriod: lessonIds.has(t.id),
      isCoveringInPeriod: coveringIds.has(t.id),
    }),
  }));
}

export interface Score { runFrom: number; runTo: number; runLength: number; coverLoad: number }

/**
 * For teachers who are otherwise valid: the run of consecutive teaching periods they would have through this lesson's period if they covered it. Their teaching that day is
 * the lessons of the PUBLISHED version on that weekday that they will actually teach (a lesson inside their own absence is not taught by them) plus the covers already
 * assigned to them that date (this request excluded, so a re-evaluation of the current replacement is not counted twice). Adjacency follows the year's schedule: a timing
 * event after a period ends the run there. Pure reads; the published timetable is never written.
 */
export async function scoreValid(db: Db, cover: { id: string; schoolId: string; date: Date; dayOfWeek: string; periodNumber: number; timetableVersionId: string; timetableVersion: { academicYearId: string } }, teacherIds: string[]): Promise<Map<string, Score>> {
  const out = new Map<string, Score>();
  if (teacherIds.length === 0) return out;
  const date = dateToString(cover.date);
  const [schedule, lessons, absences, covers] = await Promise.all([
    db.scheduleConfig.findUnique({ where: { academicYearId: cover.timetableVersion.academicYearId }, select: SCHEDULE_ENGINE_SELECT }),
    db.timetableEntry.findMany({ where: { versionId: cover.timetableVersionId, dayOfWeek: cover.dayOfWeek as never, teacherId: { in: teacherIds } }, select: { teacherId: true, periodNumber: true } }),
    db.teacherAbsence.findMany({ where: { schoolId: cover.schoolId, status: 'ACTIVE', teacherId: { in: teacherIds }, startDate: { lte: cover.date }, endDate: { gte: cover.date } } }),
    db.coverRequest.findMany({ where: { schoolId: cover.schoolId, date: cover.date, status: 'ASSIGNED', replacementTeacherId: { in: teacherIds }, id: { not: cover.id } }, select: { replacementTeacherId: true, periodNumber: true } }),
  ]);
  const effective = schedule ? effectiveSchedule(schedule) : null;
  const continues = adjacency(effective?.periodsPerDay ?? MAX_PERIOD, effective?.breakPositions ?? []);
  for (const id of teacherIds) {
    const away = absences.filter((a) => a.teacherId === id).map((a) => ({ startDate: dateToString(a.startDate), endDate: dateToString(a.endDate), scope: a.scope, fromPeriod: a.fromPeriod, toPeriod: a.toPeriod }));
    const teaching = new Set<number>();
    for (const l of lessons) if (l.teacherId === id && !away.some((a) => absenceCoversSlot(a, date, l.periodNumber))) teaching.add(l.periodNumber);
    const coversToday = covers.filter((c) => c.replacementTeacherId === id);
    for (const c of coversToday) teaching.add(c.periodNumber);
    teaching.add(cover.periodNumber);
    const run = runThrough(teaching, cover.periodNumber, continues);
    out.set(id, { runFrom: run.from, runTo: run.to, runLength: run.length, coverLoad: coversToday.length });
  }
  return out;
}


export interface RankingFacts { gradeEligible: boolean; weeklyLoad: number; recentCovers: number }
export interface WorkloadFacts { weeklyLoad: number; recentCovers: number }

const addDays = (date: string, n: number): string => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + n)).toISOString().slice(0, 10);
const asDay = (d: string): Date => new Date(`${d}T00:00:00.000Z`);
const WEEKDAYS = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
/** Monday of the week containing the date (the school week used for the weekly workload). */
export function weekStart(date: string): string {
  return addDays(date, -((asDay(date).getUTCDay() + 6) % 7));
}

/**
 * The existing weekly workload and the recent cover count of teachers, for ranking. Pure reads.
 *  weeklyLoad    the teacher's lessons in the PUBLISHED version that they will actually teach in the Monday-Sunday week of the date (a lesson inside their own active
 *                absence is not taught by them) PLUS covers assigned to them that week (excluding `excludeCoverId`). Covers are other teachers' lessons, so nothing is
 *                counted twice. The school configures NO weekly maximum: this only ranks, it never refuses anyone.
 *  recentCovers  covers assigned to them in the 28 days ending on the date, the date included (fairness).
 */
export async function workloadFacts(db: Db, schoolId: string, versionId: string, date: string, teacherIds: string[], excludeCoverId: string | null): Promise<Map<string, WorkloadFacts>> {
  const out = new Map<string, WorkloadFacts>();
  if (teacherIds.length === 0) return out;
  const wkStart = weekStart(date);
  const wkEnd = addDays(wkStart, 6);
  const notThis = excludeCoverId ? { id: { not: excludeCoverId } } : {};
  const [lessons, absences, weekCovers, recent] = await Promise.all([
    db.timetableEntry.findMany({ where: { versionId, teacherId: { in: teacherIds } }, select: { teacherId: true, dayOfWeek: true, periodNumber: true } }),
    db.teacherAbsence.findMany({ where: { schoolId, status: 'ACTIVE', teacherId: { in: teacherIds }, startDate: { lte: asDay(wkEnd) }, endDate: { gte: asDay(wkStart) } } }),
    db.coverRequest.groupBy({ by: ['replacementTeacherId'], where: { schoolId, status: 'ASSIGNED', replacementTeacherId: { in: teacherIds }, date: { gte: asDay(wkStart), lte: asDay(wkEnd) }, ...notThis }, _count: { _all: true } }),
    db.coverRequest.groupBy({ by: ['replacementTeacherId'], where: { schoolId, status: 'ASSIGNED', replacementTeacherId: { in: teacherIds }, date: { gte: asDay(addDays(date, -27)), lte: asDay(date) }, ...notThis }, _count: { _all: true } }),
  ]);
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(wkStart, i));
  const dateOfWeekday = new Map(weekDates.map((d) => [WEEKDAYS[asDay(d).getUTCDay()]!, d]));
  for (const id of teacherIds) {
    const away = absences.filter((a) => a.teacherId === id).map((a) => ({ startDate: dateToString(a.startDate), endDate: dateToString(a.endDate), scope: a.scope, fromPeriod: a.fromPeriod, toPeriod: a.toPeriod }));
    let own = 0;
    for (const l of lessons) {
      if (l.teacherId !== id) continue;
      const d = dateOfWeekday.get(l.dayOfWeek);
      if (d !== undefined && !away.some((a) => absenceCoversSlot(a, d, l.periodNumber))) own++;
    }
    out.set(id, { weeklyLoad: own + (weekCovers.find((c) => c.replacementTeacherId === id)?._count._all ?? 0), recentCovers: recent.find((r) => r.replacementTeacherId === id)?._count._all ?? 0 });
  }
  return out;
}

/** Teachers with a teacher-subject link for the subject that covers the grade (ALL_GRADES, or an explicit grade row). */
export async function gradeEligibleTeachers(db: Db, subjectId: string, gradeId: string, teacherIds: string[]): Promise<Set<string>> {
  if (teacherIds.length === 0) return new Set();
  const links = await db.teacherSubject.findMany({ where: { subjectId, teacherId: { in: teacherIds } }, select: { teacherId: true, gradeScope: true, grades: { where: { gradeId }, select: { gradeId: true } } } });
  return new Set(links.filter((l) => l.gradeScope === 'ALL_GRADES' || l.grades.length > 0).map((l) => l.teacherId));
}

/** gradeEligible + weeklyLoad + recentCovers for teachers who are otherwise valid for one cover request. */
export async function rankingFacts(db: Db, cover: { id: string; schoolId: string; date: Date; subjectId: string; timetableVersionId: string; section: { gradeId: string } }, teacherIds: string[]): Promise<Map<string, RankingFacts>> {
  const [eligible, load] = await Promise.all([gradeEligibleTeachers(db, cover.subjectId, cover.section.gradeId, teacherIds), workloadFacts(db, cover.schoolId, cover.timetableVersionId, dateToString(cover.date), teacherIds, cover.id)]);
  return new Map(teacherIds.map((id) => [id, { gradeEligible: eligible.has(id), weeklyLoad: load.get(id)?.weeklyLoad ?? 0, recentCovers: load.get(id)?.recentCovers ?? 0 }]));
}
