import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { coversPeriod, dateToString, eachDate, weekdayOf, type PeriodScope } from './substitution.core.js';

type Db = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Keeping cover requests in step with the PUBLISHED timetable.
//
// A cover request is a snapshot of one lesson of one published version on one date. Two idempotent operations keep the set correct:
//   materializeAbsence: for an absence, create the missing requests from the CURRENT published version of each date's academic year.
//   obsoleteStaleCovers: a request whose version is no longer PUBLISHED (a newer version was published, or it was archived) and whose date has not
//                        passed becomes OBSOLETE (history kept, replacement freed). The next materialize creates a fresh request from the new version.
// Past dates are never touched: the lesson happened under the timetable that was in force, and its record stays as it was.
// "Today" is the UTC calendar date (the schema stores no school time zone).
// ---------------------------------------------------------------------------

export interface AbsenceRow extends PeriodScope {
  id: string;
  schoolId: string;
  teacherId: string;
  startDate: string;
  endDate: string;
}

interface PublishedVersion { versionId: string; yearId: string; start: string; end: string }

/** The published version of every DRAFT or ACTIVE academic year of the school (a COMPLETED year is closed: no cover is created for it). */
async function publishedVersions(db: Db, schoolId: string): Promise<PublishedVersion[]> {
  const rows = await db.$queryRaw<Array<{ versionId: string; yearId: string; start: Date; end: Date }>>`
    SELECT v."id" AS "versionId", y."id" AS "yearId", y."startDate" AS "start", y."endDate" AS "end"
    FROM "timetable_versions" v JOIN "academic_years" y ON y."id" = v."academicYearId"
    WHERE v."schoolId" = ${schoolId} AND v."status" = 'PUBLISHED'::"TimetableVersionStatus" AND y."status" IN ('DRAFT'::"AcademicYearStatus", 'ACTIVE'::"AcademicYearStatus")`;
  return rows.map((r) => ({ versionId: r.versionId, yearId: r.yearId, start: dateToString(new Date(r.start)), end: dateToString(new Date(r.end)) }));
}

/** The published version whose academic year contains the date; null when none; 'AMBIGUOUS' when two years contain it. */
function versionOnDate(versions: PublishedVersion[], date: string): string | null | 'AMBIGUOUS' {
  const hits = versions.filter((v) => date >= v.start && date <= v.end);
  if (hits.length === 0) return null;
  return hits.length === 1 ? hits[0]!.versionId : 'AMBIGUOUS';
}

export interface MaterializeResult {
  created: number;
  /** Dates inside the absence that no academic year with a published timetable contains, or that two years contain (nothing is created for them). */
  datesWithoutTimetable: string[];
  ambiguousDates: string[];
}

/** Create the missing OPEN cover requests of one absence. Idempotent: lessons that already have a request (any status) for this absence/version are skipped. */
export async function materializeAbsence(db: Db, absence: AbsenceRow, actorAdminId: string | null, onlyFrom?: string): Promise<MaterializeResult> {
  const versions = await publishedVersions(db, absence.schoolId);
  const result: MaterializeResult = { created: 0, datesWithoutTimetable: [], ambiguousDates: [] };
  const dates = eachDate(absence.startDate, absence.endDate).filter((d) => onlyFrom === undefined || d >= onlyFrom);

  const entriesByVersion = new Map<string, Array<{ id: string; sectionId: string; subjectId: string; dayOfWeek: string; periodNumber: number }>>();
  const rows: Prisma.CoverRequestCreateManyInput[] = [];
  // The obsolete requests of this absence, to link a new request to the one it replaces. A lesson that MOVED to another period in the new
  // version still replaces the old request of the same section, date and subject (same period preferred).
  const obsolete = await db.coverRequest.findMany({
    where: { absenceId: absence.id, status: 'OBSOLETE' },
    orderBy: [{ obsoleteAt: 'asc' }, { id: 'asc' }],
    select: { id: true, sectionId: true, subjectId: true, date: true, periodNumber: true },
  });
  const obsoleteByLesson = new Map<string, Array<{ id: string; periodNumber: number }>>();
  for (const o of obsolete) {
    const key = `${o.sectionId}|${dateToString(o.date)}|${o.subjectId}`;
    obsoleteByLesson.set(key, [...(obsoleteByLesson.get(key) ?? []), { id: o.id, periodNumber: o.periodNumber }]);
  }
  const claimed = new Set<string>();
  const supersededBy = (sectionId: string, date: string, subjectId: string, period: number): string | null => {
    const list = obsoleteByLesson.get(`${sectionId}|${date}|${subjectId}`)?.filter((o) => !claimed.has(o.id)) ?? [];
    const pick = list.find((o) => o.periodNumber === period) ?? list[0];
    if (!pick) return null;
    claimed.add(pick.id);
    return pick.id;
  };

  for (const date of dates) {
    const versionId = versionOnDate(versions, date);
    if (versionId === null) { result.datesWithoutTimetable.push(date); continue; }
    if (versionId === 'AMBIGUOUS') { result.ambiguousDates.push(date); continue; }
    if (!entriesByVersion.has(versionId)) {
      entriesByVersion.set(versionId, await db.timetableEntry.findMany({
        where: { versionId, teacherId: absence.teacherId },
        select: { id: true, sectionId: true, subjectId: true, dayOfWeek: true, periodNumber: true },
      }));
    }
    const weekday = weekdayOf(date);
    for (const e of entriesByVersion.get(versionId)!) {
      if (e.dayOfWeek !== weekday || !coversPeriod(absence, e.periodNumber)) continue;
      rows.push({
        id: randomUUID(),
        schoolId: absence.schoolId,
        absenceId: absence.id,
        timetableVersionId: versionId,
        sourceEntryId: e.id,
        date: new Date(`${date}T00:00:00.000Z`),
        dayOfWeek: weekday,
        periodNumber: e.periodNumber,
        sectionId: e.sectionId,
        subjectId: e.subjectId,
        absentTeacherId: absence.teacherId,
        status: 'OPEN',
        supersedesId: supersededBy(e.sectionId, date, e.subjectId, e.periodNumber),
      });
    }
  }

  if (rows.length > 0) {
    // skipDuplicates = ON CONFLICT DO NOTHING: the unique keys (per absence/version/lesson/date, and one LIVE request per lesson and date) make this safe to repeat
    const created = await db.coverRequest.createManyAndReturn({ data: rows, skipDuplicates: true, select: { id: true, schoolId: true } });
    result.created = created.length;
    if (created.length > 0) {
      await db.coverEvent.createMany({
        data: created.map((c) => ({ schoolId: c.schoolId, coverRequestId: c.id, action: 'CREATED' as const, toStatus: 'OPEN' as const, actorAdminId, note: actorAdminId === null ? 'Created from the published timetable' : null })),
      });
    }
  }
  return result;
}

/** OPEN/ASSIGNED requests of upcoming dates whose version is no longer PUBLISHED become OBSOLETE (event written, replacement freed, history kept). */
export async function obsoleteStaleCovers(db: Db, schoolId: string): Promise<number> {
  const stale = await db.$queryRaw<Array<{ id: string; status: 'OPEN' | 'ASSIGNED'; replacementTeacherId: string | null }>>`
    SELECT c."id", c."status"::text AS "status", c."replacementTeacherId"
    FROM "cover_requests" c JOIN "timetable_versions" v ON v."id" = c."timetableVersionId"
    WHERE c."schoolId" = ${schoolId} AND c."status" IN ('OPEN'::"CoverStatus", 'ASSIGNED'::"CoverStatus")
      AND v."status" <> 'PUBLISHED'::"TimetableVersionStatus"
      AND c."date" >= (now() AT TIME ZONE 'UTC')::date
    ORDER BY c."id" FOR UPDATE OF c`;
  if (stale.length === 0) return 0;
  await db.coverRequest.updateMany({ where: { id: { in: stale.map((s) => s.id) } }, data: { status: 'OBSOLETE', obsoleteAt: new Date() } });
  await db.coverEvent.createMany({
    data: stale.map((s) => ({
      schoolId,
      coverRequestId: s.id,
      action: 'OBSOLETED' as const,
      fromStatus: s.status,
      toStatus: 'OBSOLETE' as const,
      fromTeacherId: s.replacementTeacherId,
      actorAdminId: null,
      note: 'The timetable version this lesson came from is no longer the published one',
    })),
  });
  return stale.length;
}

export interface SyncResult { obsoleted: number; created: number }

/** Idempotent school-wide reconciliation, serialised per school. Called before cover requests are listed or changed. */
export async function syncSchool(prisma: PrismaClient, schoolId: string): Promise<SyncResult> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cover-sync:${schoolId}`}))`;
      const obsoleted = await obsoleteStaleCovers(tx, schoolId);
      const absences = await tx.$queryRaw<Array<{ id: string; teacherId: string; startDate: Date; endDate: Date; scope: 'FULL_DAY' | 'PERIODS'; fromPeriod: number | null; toPeriod: number | null }>>`
        SELECT "id", "teacherId", "startDate", "endDate", "scope"::text AS "scope", "fromPeriod", "toPeriod"
        FROM "teacher_absences"
        WHERE "schoolId" = ${schoolId} AND "status" = 'ACTIVE'::"RecordStatus" AND "endDate" >= (now() AT TIME ZONE 'UTC')::date
        ORDER BY "id"`;
      let created = 0;
      for (const a of absences) {
        const r = await materializeAbsence(tx, { id: a.id, schoolId, teacherId: a.teacherId, startDate: dateToString(new Date(a.startDate)), endDate: dateToString(new Date(a.endDate)), scope: a.scope, fromPeriod: a.fromPeriod, toPeriod: a.toPeriod }, null);
        created += r.created;
      }
      return { obsoleted, created };
    },
    { timeout: 30_000, maxWait: 10_000 }
  );
}
