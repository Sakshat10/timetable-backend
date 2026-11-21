import { Prisma } from '@prisma/client';
import prisma from '../../config/database.js';
import { AppError, isUniqueViolation } from '../../utils/errors.js';
import {
  absenceCoversSlot,
  absencesOverlap,
  adjacency,
  classifyCandidate,
  CONSECUTIVE_THRESHOLD,
  dateToString,
  explainCandidate,
  EXCLUSION_MESSAGES,
  isEligibilityReason,
  MAX_PERIOD,
  noCandidateMessage,
  periodsText,
  rankCandidates,
  runThrough,
  selectionSummary,
  TIER_KEYS,
  tierOf,
  type ExclusionReason,
  type SubjectBasis,
} from './substitution.core.js';
import { materializeAbsence, syncSchool, type AbsenceRow } from './substitution.sync.js';
import { evaluateTeachers, rankingFacts, scoreValid } from './substitution.evaluate.js';
import { autoAllocate, summarize, type AutoRunResult } from './substitution.auto.js';
import { DEFAULT_CONSECUTIVE_POLICY, isBlockedByPolicy, type ConsecutivePolicy } from './substitution.core.js';
import {
  absenceShapeIssues,
  type CreateAbsenceInput,
  type CreateUnavailabilityInput,
  type ListAbsencesQuery,
  type ListCoverQuery,
  type ListUnavailabilityQuery,
  type UpdateAbsenceInput,
} from './substitution.schema.js';

type Db = Prisma.TransactionClient;
type Admin = { id: string; schoolId: string };

/** The school's four-consecutive-periods policy (a column of schools: no separate settings table). */
async function schoolPolicy(db: Db | typeof prisma, schoolId: string): Promise<ConsecutivePolicy> {
  return (await db.school.findUnique({ where: { id: schoolId }, select: { consecutivePeriodPolicy: true } }))?.consecutivePeriodPolicy ?? DEFAULT_CONSECUTIVE_POLICY;
}

/** One readable line per request for a 409 that tells the admin exactly what needs attention. */
async function describeCovers(db: Db, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.coverRequest.findMany({ where: { id: { in: ids.slice(0, 20) } }, include: { section: { select: { name: true } }, subject: { select: { name: true } }, replacementTeacher: { select: { name: true } } }, orderBy: [{ date: 'asc' }, { periodNumber: 'asc' }, { id: 'asc' }] });
  return rows.map((r) => `${r.id}: ${dateToString(r.date)} period ${r.periodNumber}, ${r.section.name} ${r.subject.name}, substitute ${r.replacementTeacher?.name ?? 'none'} (assigned by an admin)`);
}

const asDate = (d: string): Date => new Date(`${d}T00:00:00.000Z`);
const conflict = (message: string, code: string, extra: Record<string, string[]> = {}): AppError => new AppError(409, message, { code: [code], ...extra });

// ---------------------------------------------------------------------------
// Shared lookups and locks
// ---------------------------------------------------------------------------
async function fetchTeacher(schoolId: string, teacherId: string) {
  const teacher = await prisma.teacher.findUnique({ where: { id: teacherId } });
  if (!teacher) throw new AppError(404, 'Teacher not found');
  if (teacher.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this teacher');
  return teacher;
}

/** Serialises everything that changes one teacher's absence/availability/booking state. Always taken BEFORE any cover-request row of the operation. */
const lockTeacherForUpdate = (tx: Db, teacherId: string) => tx.$queryRaw`SELECT "id" FROM "teachers" WHERE "id" = ${teacherId} FOR UPDATE`;

function absenceRow(a: { id: string; schoolId: string; teacherId: string; startDate: Date; endDate: Date; scope: 'FULL_DAY' | 'PERIODS'; fromPeriod: number | null; toPeriod: number | null }): AbsenceRow {
  return { id: a.id, schoolId: a.schoolId, teacherId: a.teacherId, startDate: dateToString(a.startDate), endDate: dateToString(a.endDate), scope: a.scope, fromPeriod: a.fromPeriod, toPeriod: a.toPeriod };
}

const formatAbsence = (a: { id: string; teacherId: string; startDate: Date; endDate: Date; scope: string; fromPeriod: number | null; toPeriod: number | null; reason: string | null; status: string; createdById: string | null; updatedById: string | null; cancelledById: string | null; cancelledAt: Date | null; createdAt: Date; updatedAt: Date; teacher?: { id: string; name: string } }) => ({
  id: a.id,
  teacherId: a.teacherId,
  ...(a.teacher ? { teacher: { id: a.teacher.id, name: a.teacher.name } } : {}),
  startDate: dateToString(a.startDate),
  endDate: dateToString(a.endDate),
  scope: a.scope,
  fromPeriod: a.fromPeriod,
  toPeriod: a.toPeriod,
  reason: a.reason,
  status: a.status,
  createdById: a.createdById,
  updatedById: a.updatedById,
  cancelledById: a.cancelledById,
  cancelledAt: a.cancelledAt,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

/** Cover requests where this teacher is the ASSIGNED replacement inside the absence/unavailability window (they cannot be absent/unavailable there). */
async function assignedCoverConflicts(db: Db, teacherId: string, startDate: string, endDate: string, inWindow: (date: string, period: number) => boolean) {
  const covers = await db.coverRequest.findMany({
    where: { replacementTeacherId: teacherId, status: 'ASSIGNED', date: { gte: asDate(startDate), lte: asDate(endDate) } },
    select: { id: true, date: true, periodNumber: true, assignmentSource: true, replacementTeacherId: true },
  });
  return covers.filter((c) => inWindow(dateToString(c.date), c.periodNumber));
}

/**
 * Automatic assignments that must give way to an absence/unavailability change (their substitute became absent or unavailable, or the absence they cover was
 * cancelled/changed). `release`: back to OPEN, to be allocated again. `cancel`: CANCELLED (the replacement stays in the history). Manual assignments are never
 * touched here: callers refuse (409) on those, exactly as before. Rows are locked first; every change writes an audit event with the former replacement.
 */
async function giveWayAutomatic(tx: Db, adminId: string, schoolId: string, ids: string[], mode: 'release' | 'cancel', cancelReason: string, note: string): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx.$queryRaw<Array<{ id: string; replacementTeacherId: string | null }>>`
    SELECT "id", "replacementTeacherId" FROM "cover_requests" WHERE "id" IN (${Prisma.join(ids)}) AND "schoolId" = ${schoolId} AND "status" = 'ASSIGNED'::"CoverStatus" AND "assignmentSource" = 'AUTOMATIC'::"CoverAssignmentSource" ORDER BY "id" FOR UPDATE`;
  for (const r of rows) {
    if (mode === 'release') {
      await tx.coverRequest.update({ where: { id: r.id }, data: { status: 'OPEN', replacementTeacherId: null, assignedById: null, assignedAt: null, assignmentSource: null, temporaryUnqualified: false, attentionCode: null, attentionNote: null } });
      await tx.coverEvent.create({ data: { schoolId, coverRequestId: r.id, action: 'AUTO_RELEASED', fromStatus: 'ASSIGNED', toStatus: 'OPEN', fromTeacherId: r.replacementTeacherId, actorAdminId: adminId, note } });
    } else {
      await tx.coverRequest.update({ where: { id: r.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: adminId, cancelReason, attentionCode: null, attentionNote: null } });
      await tx.coverEvent.create({ data: { schoolId, coverRequestId: r.id, action: 'CANCELLED', fromStatus: 'ASSIGNED', toStatus: 'CANCELLED', fromTeacherId: r.replacementTeacherId, actorAdminId: adminId, note } });
    }
  }
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Cover-request context and candidate evaluation
// ---------------------------------------------------------------------------
const coverInclude = {
  timetableVersion: { select: { id: true, versionNumber: true, status: true, academicYearId: true } },
  section: { select: { id: true, name: true, code: true, gradeId: true } },
  subject: { select: { id: true, name: true, code: true } },
  absentTeacher: { select: { id: true, name: true } },
  replacementTeacher: { select: { id: true, name: true } },
} satisfies Prisma.CoverRequestInclude;
type CoverWithRelations = Prisma.CoverRequestGetPayload<{ include: typeof coverInclude }>;

const formatCover = (c: CoverWithRelations) => ({
  id: c.id,
  date: dateToString(c.date),
  dayOfWeek: c.dayOfWeek,
  periodNumber: c.periodNumber,
  status: c.status,
  absenceId: c.absenceId,
  timetableVersion: { id: c.timetableVersion.id, versionNumber: c.timetableVersion.versionNumber, status: c.timetableVersion.status },
  section: { id: c.section.id, name: c.section.name, code: c.section.code, gradeId: c.section.gradeId },
  subject: c.subject,
  absentTeacher: c.absentTeacher,
  replacementTeacher: c.replacementTeacher,
  assignedById: c.assignedById,
  assignedAt: c.assignedAt,
  cancelledById: c.cancelledById,
  cancelledAt: c.cancelledAt,
  cancelReason: c.cancelReason,
  obsoleteAt: c.obsoleteAt,
  supersedesId: c.supersedesId,
  assignmentSource: c.assignmentSource,
  temporaryUnqualified: c.temporaryUnqualified,
  attention: c.attentionCode ? { code: c.attentionCode, message: c.attentionNote } : null,
  createdAt: c.createdAt,
  updatedAt: c.updatedAt,
});

async function fetchCoverOwned(schoolId: string, id: string): Promise<CoverWithRelations> {
  const cover = await prisma.coverRequest.findUnique({ where: { id }, include: coverInclude });
  if (!cover) throw new AppError(404, 'Cover request not found');
  if (cover.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this cover request');
  return cover;
}

const LIVE = ['OPEN', 'ASSIGNED'] as const;
function assertLive(status: string, what: string): void {
  if (status === 'OBSOLETE') throw conflict(`This cover request is obsolete: the timetable it came from is no longer the published one. Use the current request for this lesson (${what}).`, 'COVER_OBSOLETE');
  if (status === 'CANCELLED') throw conflict('This cover request was cancelled', 'COVER_CANCELLED');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
export class SubstitutionService {
  // ===================================================================================================================================================
  // Absences
  // ===================================================================================================================================================

  /**
   * Record a teacher absence and create the OPEN cover requests of the published timetable's lessons that fall inside it. One transaction; the teacher row is
   * locked FOR UPDATE, so concurrent absence/unavailability/assignment changes for that teacher serialise. Refused (409) when the teacher already has an
   * ACTIVE absence that overlaps in dates AND periods, or when they are the assigned replacement for a lesson inside the absence. An inactive teacher is
   * NOT treated as absent; recording an absence for one is allowed.
   */
  async createAbsence(admin: Admin, input: CreateAbsenceInput) {
    await fetchTeacher(admin.schoolId, input.teacherId);
    const scope = input.scope ?? 'FULL_DAY';
    const candidate = { startDate: input.startDate, endDate: input.endDate, scope, fromPeriod: scope === 'PERIODS' ? input.fromPeriod ?? null : null, toPeriod: scope === 'PERIODS' ? input.toPeriod ?? null : null };

    const recorded = await prisma.$transaction(async (tx) => {
      await lockTeacherForUpdate(tx, input.teacherId);
      const released = await this.assertNoContradiction(tx, admin, input.teacherId, candidate, null);
      const created = await tx.teacherAbsence.create({
        data: { schoolId: admin.schoolId, teacherId: input.teacherId, startDate: asDate(candidate.startDate), endDate: asDate(candidate.endDate), scope, fromPeriod: candidate.fromPeriod, toPeriod: candidate.toPeriod, reason: input.reason ?? null, createdById: admin.id },
      });
      const result = await materializeAbsence(tx, absenceRow(created), admin.id);
      return { created, result, released };
    }, { timeout: 30_000, maxWait: 10_000 });

    // The absence is recorded and committed BEFORE the allocation: if the allocation fails, the absence stays and POST /teacher-absences/:id/auto-assign retries.
    const automaticAllocation = await this.runAllocation(admin, [recorded.created.id], recorded.released, input.autoAssign !== false, input.allowTemporaryCover !== false);
    return { absence: formatAbsence(recorded.created), coverRequestsCreated: recorded.result.created, datesWithoutPublishedTimetable: recorded.result.datesWithoutTimetable.length, ambiguousDates: recorded.result.ambiguousDates, automaticAllocation };
  }

  /** Run the coordinated allocator (when enabled) and describe the outcome. Never throws: a failed allocation is reported, the caller's change stays. */
  private async runAllocation(admin: Admin, absenceIds: string[], releasedCoverIds: string[], enabled: boolean, allowTemporaryCover: boolean) {
    let run: AutoRunResult | null = null;
    let status: 'COMPLETED' | 'FAILED' | 'DISABLED' = enabled ? 'COMPLETED' : 'DISABLED';
    let error: string | undefined;
    if (enabled) {
      try {
        run = await autoAllocate(admin, { absenceIds, coverIds: releasedCoverIds }, { allowTemporaryCover });
      } catch (e) {
        status = 'FAILED';
        error = 'Automatic assignment could not be completed; the absence is recorded. Retry with POST /api/teacher-absences/{id}/auto-assign, or assign manually.';
        console.error('Automatic substitution failed', e instanceof Error ? e.message : e);
      }
    }
    const summary = await summarize(admin.schoolId, absenceIds, releasedCoverIds);
    return { enabled, status, ...(error ? { error } : {}), allowTemporaryCover, ...summary, run, releasedAutomaticAssignments: releasedCoverIds.length };
  }

  /** Explicit (and retry-safe) allocation of one absence's OPEN requests. Idempotent: assigned requests are never touched. */
  async autoAssignAbsence(admin: Admin, absenceId: string, allowTemporaryCover = true) {
    const absence = await this.fetchAbsenceOwned(admin.schoolId, absenceId);
    if (absence.status !== 'ACTIVE') throw conflict('A cancelled absence has nothing to assign', 'ABSENCE_CANCELLED');
    const run = await autoAllocate(admin, { absenceIds: [absenceId] }, { allowTemporaryCover });
    return { allowTemporaryCover, ...(await summarize(admin.schoolId, [absenceId])), run };
  }

  /** The current allocation result of an absence (read only). */
  async absenceSummary(schoolId: string, absenceId: string) {
    await this.fetchAbsenceOwned(schoolId, absenceId);
    return summarize(schoolId, [absenceId]);
  }

  /** Explicit allocation of every OPEN request of a date range (e.g. after a timetable was republished). School-scoped; idempotent. */
  async autoAssignRange(admin: Admin, range: { from?: string | undefined; to?: string | undefined }, allowTemporaryCover = true) {
    const run = await autoAllocate(admin, { ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) }, { allowTemporaryCover });
    return { allowTemporaryCover, run };
  }

  private async assertNoContradiction(tx: Db, admin: Admin, teacherId: string, a: { startDate: string; endDate: string; scope: 'FULL_DAY' | 'PERIODS'; fromPeriod: number | null; toPeriod: number | null }, excludeAbsenceId: string | null): Promise<string[]> {
    const others = await tx.teacherAbsence.findMany({
      where: { teacherId, status: 'ACTIVE', startDate: { lte: asDate(a.endDate) }, endDate: { gte: asDate(a.startDate) }, ...(excludeAbsenceId ? { id: { not: excludeAbsenceId } } : {}) },
    });
    const clash = others.find((o) => absencesOverlap(a, { startDate: dateToString(o.startDate), endDate: dateToString(o.endDate), scope: o.scope, fromPeriod: o.fromPeriod, toPeriod: o.toPeriod }));
    if (clash) throw conflict('This teacher already has an active absence that overlaps these dates and periods', 'ABSENCE_OVERLAP', { absenceId: [clash.id] });
    const booked = await assignedCoverConflicts(tx, teacherId, a.startDate, a.endDate, (date, period) => absenceCoversSlot(a, date, period));
    // an admin's own assignment is respected (409); the allocator's assignments give way: that substitute is now absent, so the lesson is allocated again
    const manual = booked.filter((b) => b.assignmentSource !== 'AUTOMATIC');
    if (manual.length > 0) throw conflict(`The teacher is assigned by an admin to cover ${manual.length} lesson(s) inside this absence. Reassign or cancel those substitutions first.`, 'TEACHER_IS_COVERING', { coverRequestIds: manual.map((b) => b.id).slice(0, 20), lessons: await describeCovers(tx, manual.map((b) => b.id)) });
    return giveWayAutomatic(tx, admin.id, admin.schoolId, booked.map((b) => b.id), 'release', 'SUBSTITUTE_ABSENT', 'Released: the automatically assigned substitute was recorded absent for this lesson');
  }

  async listAbsences(schoolId: string, q: ListAbsencesQuery) {
    if (q.teacherId) await fetchTeacher(schoolId, q.teacherId);
    const rows = await prisma.teacherAbsence.findMany({
      where: {
        schoolId,
        ...(q.teacherId ? { teacherId: q.teacherId } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.from ? { endDate: { gte: asDate(q.from) } } : {}),
        ...(q.to ? { startDate: { lte: asDate(q.to) } } : {}),
      },
      include: { teacher: { select: { id: true, name: true } } },
      orderBy: [{ startDate: 'desc' }, { id: 'asc' }],
      take: 500,
    });
    const counts = await this.coverCounts(rows.map((r) => r.id));
    return rows.map((r) => ({ ...formatAbsence(r), covers: counts.get(r.id) ?? { OPEN: 0, ASSIGNED: 0, CANCELLED: 0, OBSOLETE: 0 } }));
  }

  private async coverCounts(absenceIds: string[]): Promise<Map<string, Record<'OPEN' | 'ASSIGNED' | 'CANCELLED' | 'OBSOLETE', number>>> {
    const grouped = absenceIds.length === 0 ? [] : await prisma.coverRequest.groupBy({ by: ['absenceId', 'status'], where: { absenceId: { in: absenceIds } }, _count: { _all: true } });
    const out = new Map<string, Record<'OPEN' | 'ASSIGNED' | 'CANCELLED' | 'OBSOLETE', number>>();
    for (const g of grouped) {
      const row = out.get(g.absenceId) ?? { OPEN: 0, ASSIGNED: 0, CANCELLED: 0, OBSOLETE: 0 };
      row[g.status] = g._count._all;
      out.set(g.absenceId, row);
    }
    return out;
  }

  private async fetchAbsenceOwned(schoolId: string, id: string) {
    const absence = await prisma.teacherAbsence.findUnique({ where: { id }, include: { teacher: { select: { id: true, name: true } } } });
    if (!absence) throw new AppError(404, 'Absence not found');
    if (absence.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this absence');
    return absence;
  }

  async getAbsence(schoolId: string, id: string) {
    const absence = await this.fetchAbsenceOwned(schoolId, id);
    const counts = await this.coverCounts([id]);
    return { ...formatAbsence(absence), covers: counts.get(id) ?? { OPEN: 0, ASSIGNED: 0, CANCELLED: 0, OBSOLETE: 0 } };
  }

  /**
   * Change an ACTIVE absence's dates, periods or reason (the teacher cannot change: cancel and record a new one). The merged record is re-validated, must not
   * contradict another absence, and every lesson that falls OUT of it must be safe to drop: an ASSIGNED substitution outside the new range makes the update a
   * 409 (cancel it first); OPEN requests outside it are cancelled (and reopened if a later change brings the lesson back); lessons that fall IN get new requests.
   */
  async updateAbsence(admin: Admin, id: string, input: UpdateAbsenceInput) {
    const before = await this.fetchAbsenceOwned(admin.schoolId, id);
    const done = await prisma.$transaction(async (tx) => {
      await lockTeacherForUpdate(tx, before.teacherId);
      const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status"::text AS "status" FROM "teacher_absences" WHERE "id" = ${id} FOR UPDATE`;
      if (rows[0]?.status !== 'ACTIVE') throw conflict('A cancelled absence cannot be changed', 'ABSENCE_CANCELLED');
      const current = await tx.teacherAbsence.findUniqueOrThrow({ where: { id } });

      const scope = input.scope ?? current.scope;
      const merged = {
        startDate: input.startDate ?? dateToString(current.startDate),
        endDate: input.endDate ?? dateToString(current.endDate),
        scope,
        fromPeriod: scope === 'PERIODS' ? (input.fromPeriod !== undefined ? input.fromPeriod : current.fromPeriod) : null,
        toPeriod: scope === 'PERIODS' ? (input.toPeriod !== undefined ? input.toPeriod : current.toPeriod) : null,
      };
      // switching to FULL_DAY while sending periods is a contradiction, not something to ignore
      const issues = absenceShapeIssues({ ...merged, ...(input.scope === 'FULL_DAY' ? { fromPeriod: input.fromPeriod, toPeriod: input.toPeriod } : {}) });
      if (issues.length > 0) {
        const errors: Record<string, string[]> = {};
        for (const i of issues) (errors[i.path] ??= []).push(i.message);
        throw new AppError(400, 'Validation failed', errors);
      }
      const released = await this.assertNoContradiction(tx, admin, current.teacherId, merged, id);

      const covers = await tx.coverRequest.findMany({ where: { absenceId: id, status: { in: [...LIVE] } }, select: { id: true, date: true, periodNumber: true, status: true, replacementTeacherId: true } });
      const outside = covers.filter((c) => !absenceCoversSlot(merged, dateToString(c.date), c.periodNumber));
      const assignedOutside = outside.filter((c) => c.status === 'ASSIGNED');
      const sources = assignedOutside.length === 0 ? [] : await tx.coverRequest.findMany({ where: { id: { in: assignedOutside.map((c) => c.id) } }, select: { id: true, assignmentSource: true } });
      const manualOutside = sources.filter((c) => c.assignmentSource !== 'AUTOMATIC');
      if (manualOutside.length > 0) throw conflict(`${manualOutside.length} assigned substitution(s) would fall outside the changed absence. Cancel or reassign them first.`, 'ASSIGNED_COVERS_OUTSIDE', { coverRequestIds: manualOutside.map((c) => c.id).slice(0, 20), lessons: await describeCovers(tx, manualOutside.map((c) => c.id)) });
      // the allocator's own assignments simply follow the absence: cancelled like the OPEN ones (reopened and allocated again if a later change brings the lesson back)
      const autoCancelled = await giveWayAutomatic(tx, admin.id, admin.schoolId, assignedOutside.map((c) => c.id), 'cancel', 'ABSENCE_CHANGED', 'The absence was changed and no longer includes this lesson');
      const openOutside = outside.filter((c) => c.status === 'OPEN');
      if (openOutside.length > 0) {
        const ids = openOutside.map((c) => c.id);
        await tx.coverRequest.updateMany({ where: { id: { in: ids } }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: admin.id, cancelReason: 'ABSENCE_CHANGED' } });
        await tx.coverEvent.createMany({ data: ids.map((coverRequestId) => ({ schoolId: admin.schoolId, coverRequestId, action: 'CANCELLED' as const, fromStatus: 'OPEN' as const, toStatus: 'CANCELLED' as const, actorAdminId: admin.id, note: 'The absence was changed and no longer includes this lesson' })) });
      }

      const updated = await tx.teacherAbsence.update({
        where: { id },
        data: { startDate: asDate(merged.startDate), endDate: asDate(merged.endDate), scope: merged.scope, fromPeriod: merged.fromPeriod, toPeriod: merged.toPeriod, ...(input.reason !== undefined ? { reason: input.reason } : {}), updatedById: admin.id },
      });

      // lessons that the earlier change dropped and the new range includes again: reopen them (one live request per lesson, so nothing is duplicated)
      const dropped = await tx.coverRequest.findMany({ where: { absenceId: id, status: 'CANCELLED', cancelReason: 'ABSENCE_CHANGED', timetableVersion: { status: 'PUBLISHED' } }, select: { id: true, date: true, periodNumber: true } });
      const back = dropped.filter((c) => absenceCoversSlot(merged, dateToString(c.date), c.periodNumber));
      for (const c of back) {
        await tx.coverRequest.update({ where: { id: c.id }, data: { status: 'OPEN', cancelledAt: null, cancelledById: null, cancelReason: null, replacementTeacherId: null, assignedById: null, assignedAt: null, assignmentSource: null, temporaryUnqualified: false } });
        await tx.coverEvent.create({ data: { schoolId: admin.schoolId, coverRequestId: c.id, action: 'CREATED', fromStatus: 'CANCELLED', toStatus: 'OPEN', actorAdminId: admin.id, note: 'Reopened: the absence was changed to include this lesson again' } });
      }
      const result = await materializeAbsence(tx, absenceRow(updated), admin.id);
      return { updated, created: result.created, cancelled: openOutside.length + autoCancelled.length, reopened: back.length, released, reopenedIds: back.map((c) => c.id) };
    }, { timeout: 30_000, maxWait: 10_000 });
    const automaticAllocation = await this.runAllocation(admin, [id], [...done.released, ...done.reopenedIds], input.autoAssign !== false, input.allowTemporaryCover !== false);
    return { absence: formatAbsence(done.updated), coverRequestsCreated: done.created, coverRequestsCancelled: done.cancelled, coverRequestsReopened: done.reopened, automaticAllocation };
  }

  /** Cancel an ACTIVE absence (soft: the record stays). OPEN requests are cancelled; any ASSIGNED substitution blocks it (409): cancel those first. */
  async cancelAbsence(admin: Admin, id: string) {
    const before = await this.fetchAbsenceOwned(admin.schoolId, id);
    return prisma.$transaction(async (tx) => {
      await lockTeacherForUpdate(tx, before.teacherId);
      const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status"::text AS "status" FROM "teacher_absences" WHERE "id" = ${id} FOR UPDATE`;
      if (rows[0]?.status !== 'ACTIVE') throw conflict('This absence is already cancelled', 'ABSENCE_CANCELLED');
      const assigned = await tx.coverRequest.findMany({ where: { absenceId: id, status: 'ASSIGNED' }, select: { id: true, assignmentSource: true } });
      const manual = assigned.filter((c) => c.assignmentSource !== 'AUTOMATIC');
      if (manual.length > 0) throw conflict(`${manual.length} substitution(s) are assigned for this absence. Cancel them first.`, 'ASSIGNED_COVERS_EXIST', { coverRequestIds: manual.map((c) => c.id).slice(0, 20), lessons: await describeCovers(tx, manual.map((c) => c.id)) });
      // the allocator's own assignments are cancelled with the absence (history kept: the replacement stays in each request's audit trail)
      const autoCancelled = await giveWayAutomatic(tx, admin.id, admin.schoolId, assigned.map((c) => c.id), 'cancel', 'ABSENCE_CANCELLED', 'The absence was cancelled');
      const open = await tx.coverRequest.findMany({ where: { absenceId: id, status: 'OPEN' }, select: { id: true } });
      if (open.length > 0) {
        const ids = open.map((c) => c.id);
        await tx.coverRequest.updateMany({ where: { id: { in: ids } }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: admin.id, cancelReason: 'ABSENCE_CANCELLED' } });
        await tx.coverEvent.createMany({ data: ids.map((coverRequestId) => ({ schoolId: admin.schoolId, coverRequestId, action: 'CANCELLED' as const, fromStatus: 'OPEN' as const, toStatus: 'CANCELLED' as const, actorAdminId: admin.id, note: 'The absence was cancelled' })) });
      }
      const updated = await tx.teacherAbsence.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: admin.id, updatedById: admin.id } });
      return { absence: formatAbsence(updated), coverRequestsCancelled: open.length + autoCancelled.length, automaticAssignmentsCancelled: autoCancelled.length };
    });
  }

  // ===================================================================================================================================================
  // Unavailability
  // ===================================================================================================================================================
  async createUnavailability(admin: Admin, input: CreateUnavailabilityInput) {
    await fetchTeacher(admin.schoolId, input.teacherId);
    const period = input.periodNumber ?? null;
    const done = await prisma.$transaction(async (tx) => {
      await lockTeacherForUpdate(tx, input.teacherId);
      const booked = await assignedCoverConflicts(tx, input.teacherId, input.date, input.date, (_date, p) => period === null || p === period);
      const manual = booked.filter((b) => b.assignmentSource !== 'AUTOMATIC');
      if (manual.length > 0) throw conflict(`The teacher is assigned by an admin to cover ${manual.length} lesson(s) in this slot. Reassign or cancel those substitutions first.`, 'TEACHER_IS_COVERING', { coverRequestIds: manual.map((b) => b.id).slice(0, 20), lessons: await describeCovers(tx, manual.map((b) => b.id)) });
      try {
        const row = await tx.teacherUnavailability.create({ data: { schoolId: admin.schoolId, teacherId: input.teacherId, date: asDate(input.date), periodNumber: period, reason: input.reason ?? null, createdById: admin.id } });
        // the allocator's own assignments give way and are allocated again to somebody else
        const released = await giveWayAutomatic(tx, admin.id, admin.schoolId, booked.map((b) => b.id), 'release', 'SUBSTITUTE_UNAVAILABLE', 'Released: the automatically assigned substitute was marked unavailable for this lesson');
        return { ...this.formatUnavailability(row), released };
      } catch (error) {
        if (isUniqueViolation(error)) throw conflict('The teacher is already marked unavailable for this date and period', 'UNAVAILABILITY_EXISTS');
        throw error;
      }
    });
    const { released, ...row } = done;
    if (released.length === 0) return row;
    // the lessons that lost their automatic substitute are allocated again (never fails the unavailability record)
    const reallocation = await this.runAllocation(admin, [], released, true, true);
    return { ...row, automaticReallocation: reallocation };
  }

  private formatUnavailability(u: { id: string; teacherId: string; date: Date; periodNumber: number | null; reason: string | null; status: string; createdById: string | null; cancelledById: string | null; cancelledAt: Date | null; createdAt: Date }) {
    return { id: u.id, teacherId: u.teacherId, date: dateToString(u.date), periodNumber: u.periodNumber, wholeDay: u.periodNumber === null, reason: u.reason, status: u.status, createdById: u.createdById, cancelledById: u.cancelledById, cancelledAt: u.cancelledAt, createdAt: u.createdAt };
  }

  async listUnavailability(schoolId: string, q: ListUnavailabilityQuery) {
    if (q.teacherId) await fetchTeacher(schoolId, q.teacherId);
    const rows = await prisma.teacherUnavailability.findMany({
      where: { schoolId, status: q.status ?? 'ACTIVE', ...(q.teacherId ? { teacherId: q.teacherId } : {}), ...(q.from || q.to ? { date: { ...(q.from ? { gte: asDate(q.from) } : {}), ...(q.to ? { lte: asDate(q.to) } : {}) } } : {}) },
      orderBy: [{ date: 'asc' }, { periodNumber: 'asc' }, { id: 'asc' }],
      take: 500,
    });
    return rows.map((r) => this.formatUnavailability(r));
  }

  /** Remove an unavailability mark (soft: it stays as CANCELLED with who removed it). It never affects assignments already made. */
  async cancelUnavailability(admin: Admin, id: string) {
    const row = await prisma.teacherUnavailability.findUnique({ where: { id } });
    if (!row) throw new AppError(404, 'Unavailability record not found');
    if (row.schoolId !== admin.schoolId) throw new AppError(403, 'You do not have access to this unavailability record');
    const result = await prisma.teacherUnavailability.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: admin.id } });
    if (result.count === 0) throw conflict('This unavailability record is already cancelled', 'ALREADY_CANCELLED');
    return this.formatUnavailability(await prisma.teacherUnavailability.findUniqueOrThrow({ where: { id } }));
  }

  // ===================================================================================================================================================
  // Cover requests
  // ===================================================================================================================================================

  /** List lessons needing cover (every status by default: this is also the history). The set is first reconciled with the published timetable. */
  async listCovers(schoolId: string, q: ListCoverQuery) {
    await syncSchool(prisma, schoolId);
    if (q.absentTeacherId) await fetchTeacher(schoolId, q.absentTeacherId);
    if (q.replacementTeacherId) await fetchTeacher(schoolId, q.replacementTeacherId);
    const where: Prisma.CoverRequestWhereInput = {
      schoolId,
      ...(q.status ? { status: { in: q.status } } : {}),
      ...(q.absentTeacherId ? { absentTeacherId: q.absentTeacherId } : {}),
      ...(q.replacementTeacherId ? { replacementTeacherId: q.replacementTeacherId } : {}),
      ...(q.absenceId ? { absenceId: q.absenceId } : {}),
      ...(q.from || q.to ? { date: { ...(q.from ? { gte: asDate(q.from) } : {}), ...(q.to ? { lte: asDate(q.to) } : {}) } } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.coverRequest.count({ where }),
      prisma.coverRequest.findMany({ where, include: coverInclude, orderBy: [{ date: 'asc' }, { periodNumber: 'asc' }, { id: 'asc' }], take: q.limit ?? 100, skip: q.offset ?? 0 }),
    ]);
    return { total, items: rows.map(formatCover) };
  }

  /** One request with its complete audit trail (who, when, which transition, which teachers). */
  async getCover(schoolId: string, id: string) {
    await syncSchool(prisma, schoolId);
    const cover = await fetchCoverOwned(schoolId, id);
    const events = await prisma.coverEvent.findMany({ where: { coverRequestId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const teacherIds = [...new Set(events.flatMap((e) => [e.fromTeacherId, e.toTeacherId]).filter((x): x is string => x !== null))];
    const adminIds = [...new Set(events.map((e) => e.actorAdminId).filter((x): x is string => x !== null))];
    const [teachers, admins] = await Promise.all([
      teacherIds.length ? prisma.teacher.findMany({ where: { id: { in: teacherIds } }, select: { id: true, name: true } }) : [],
      adminIds.length ? prisma.admin.findMany({ where: { id: { in: adminIds } }, select: { id: true, name: true } }) : [],
    ]);
    const teacherName = new Map(teachers.map((t) => [t.id, t.name]));
    const adminName = new Map(admins.map((a) => [a.id, a.name]));
    return {
      ...formatCover(cover),
      history: events.map((e) => ({
        id: e.id,
        action: e.action,
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        fromTeacher: e.fromTeacherId ? { id: e.fromTeacherId, name: teacherName.get(e.fromTeacherId) ?? null } : null,
        toTeacher: e.toTeacherId ? { id: e.toTeacherId, name: teacherName.get(e.toTeacherId) ?? null } : null,
        actor: e.actorAdminId ? { id: e.actorAdminId, name: adminName.get(e.actorAdminId) ?? null } : null,
        note: e.note,
        details: e.details,
        createdAt: e.createdAt,
      })),
    };
  }

  /**
   * The replacements for a lesson, in three tiers, and when there are none, a clear reason. School policy: a substitution is a TEMPORARY, date-specific cover, so being qualified
   * is a PREFERENCE, not a requirement. Every active teacher of the school who is free is a candidate (not absent, not marked unavailable, no lesson of the published timetable and no
   * other cover in that period); no teacher-subject link or grade eligibility is needed, and none is created or changed. Tier 1: a teacher of the lesson's subject (a link of either
   * type, or lessons of that subject in the published timetable) who would not end with four consecutive periods. Tier 2: any other free teacher with that property. Tier 3: whoever
   * would end with four or more, offered only when tiers 1 and 2 are empty. Nothing is assigned automatically.
   */
  async getCandidates(schoolId: string, id: string, includeExcluded: boolean) {
    await syncSchool(prisma, schoolId);
    const cover = await fetchCoverOwned(schoolId, id);
    assertLive(cover.status, 'GET /api/substitutions?status=OPEN,ASSIGNED');
    const policy = await schoolPolicy(prisma, schoolId);
    const { verdicts, scores } = await prisma.$transaction(async (tx) => {
      const v = await evaluateTeachers(tx, cover);
      return { verdicts: v, scores: await scoreValid(tx, cover, v.filter((x) => x.reason === null).map((x) => x.teacher.id)) };
    });
    const counts: Partial<Record<ExclusionReason, number>> = {};
    for (const v of verdicts) if (v.reason) counts[v.reason] = (counts[v.reason] ?? 0) + 1;

    const facts = await prisma.$transaction((tx) => rankingFacts(tx, cover, verdicts.filter((x) => x.reason === null).map((x) => x.teacher.id)));
    const valid = verdicts.filter((v) => v.reason === null).map((v) => {
      const sc = scores.get(v.teacher.id)!;
      const f = facts.get(v.teacher.id)!;
      return { verdict: v, input: { id: v.teacher.id, name: v.teacher.name, basis: v.basis, runLength: sc.runLength, coverLoad: sc.coverLoad, gradeEligible: f.gradeEligible, weeklyLoad: f.weeklyLoad, recentCovers: f.recentCovers }, sc, f };
    });
    // NEVER_ALLOW: a teacher who would end with four or more in a row is not a candidate at all (listed among the excluded, with the reason)
    const blocked = valid.filter((x) => isBlockedByPolicy(policy, x.sc.runLength));
    if (blocked.length > 0) counts.CONSECUTIVE_NOT_ALLOWED = blocked.length;
    const ranked = rankCandidates(valid.map((x) => x.input), policy);
    const byId = new Map(valid.map((x) => [x.verdict.teacher.id, x]));
    const candidates = ranked.map((r) => {
      const { verdict, sc, f } = byId.get(r.id)!;
      const periods = Array.from({ length: sc.runTo - sc.runFrom + 1 }, (_, i) => sc.runFrom + i);
      return {
        id: verdict.teacher.id,
        name: verdict.teacher.name,
        employeeCode: verdict.teacher.employeeCode,
        tier: r.tier,
        tierKey: TIER_KEYS[r.tier],
        offered: r.offered,
        recommended: r.tier === 1,
        requiresConfirmation: r.tier === 3,
        subjectBasis: verdict.basis,
        sameSubject: r.sameSubject,
        gradeEligible: f.gradeEligible,
        weeklyLoad: f.weeklyLoad,
        recentCovers: f.recentCovers,
        temporaryUnqualified: verdict.basis === null,
        free: true,
        coverLoadToday: sc.coverLoad,
        consecutive: { resultingRun: sc.runLength, from: sc.runFrom, to: sc.runTo, periods, createsFourConsecutive: sc.runLength >= CONSECUTIVE_THRESHOLD, threshold: CONSECUTIVE_THRESHOLD },
        explanation: explainCandidate({ tier: r.tier, basis: verdict.basis, runFrom: sc.runFrom, runTo: sc.runTo, runLength: sc.runLength }),
      };
    });
    const tierCounts = { tier1: candidates.filter((c) => c.tier === 1).length, tier2: candidates.filter((c) => c.tier === 2).length, tier3: candidates.filter((c) => c.tier === 3).length };
    const offered = candidates.filter((c) => c.offered);
    return {
      coverRequestId: id,
      date: dateToString(cover.date),
      periodNumber: cover.periodNumber,
      candidates,
      selection: {
        summary: selectionSummary(tierCounts),
        counts: { SAME_SUBJECT: tierCounts.tier1, OTHER_AVAILABLE: tierCounts.tier2, LAST_RESORT: tierCounts.tier3 },
        sameSubjectAvailable: tierCounts.tier1 > 0,
        otherAvailable: tierCounts.tier2 > 0,
        lastResortOffered: tierCounts.tier1 === 0 && tierCounts.tier2 === 0 && tierCounts.tier3 > 0,
        /** teachers who would end with four in a row but are not offered because better options exist (the server would still accept them, with confirmation) */
        notOffered: candidates.length - offered.length,
        recommendedTeacherId: offered.find((c) => c.tier !== 3)?.id ?? null,
      },
      policy,
      excludedCounts: counts,
      ...(candidates.length === 0 ? { message: noCandidateMessage(counts) } : {}),
      ...(includeExcluded ? { excluded: [...verdicts.filter((v) => v.reason !== null).map((v) => ({ teacher: v.teacher, reason: v.reason, message: EXCLUSION_MESSAGES[v.reason!] })), ...blocked.map((b) => ({ teacher: b.verdict.teacher, reason: 'CONSECUTIVE_NOT_ALLOWED' as const, message: EXCLUSION_MESSAGES.CONSECUTIVE_NOT_ALLOWED }))] } : {}),
    };
  }

  /**
   * Assign (OPEN) or reassign (ASSIGNED) a replacement. One transaction with the lock order: cover request, its timetable version (must still be PUBLISHED), the advisory lock that
   * serialises one replacement's assignments on one date, then the replacement teacher row (share-locked, so a concurrent absence or unavailability change waits). Availability and the
   * four-consecutive-periods impact are then evaluated under those locks. No subject link or grade eligibility is needed or touched: the assignment is only this cover request's row.
   * The partial unique index on (replacement, date, period) for ASSIGNED requests is the last guard: two simultaneous assignments of one teacher to one slot cannot both commit.
   */
  async assign(admin: Admin, id: string, teacherId: string, confirmFourConsecutive = false) {
    await syncSchool(prisma, admin.schoolId);
    const pre = await fetchCoverOwned(admin.schoolId, id);
    assertLive(pre.status, 'GET /api/substitutions?status=OPEN,ASSIGNED');
    const target = await prisma.teacher.findUnique({ where: { id: teacherId }, select: { id: true, schoolId: true } });
    if (!target) throw new AppError(404, 'Teacher not found');
    if (target.schoolId !== admin.schoolId) throw new AppError(403, 'You do not have access to this teacher');

    try {
      return await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ status: 'OPEN' | 'ASSIGNED' | 'CANCELLED' | 'OBSOLETE'; replacementTeacherId: string | null; timetableVersionId: string }>>`
          SELECT "status"::text AS "status", "replacementTeacherId", "timetableVersionId" FROM "cover_requests" WHERE "id" = ${id} FOR UPDATE`;
        const row = locked[0];
        if (!row) throw new AppError(404, 'Cover request not found');
        assertLive(row.status, 'GET /api/substitutions?status=OPEN,ASSIGNED');
        if (row.status === 'ASSIGNED' && row.replacementTeacherId === teacherId) {
          // Assigning the teacher the allocator already chose is the admin CONFIRMING the choice: it becomes theirs (MANUAL), so no later automatic run or republish treats it as replaceable.
          const current = await tx.coverRequest.findUniqueOrThrow({ where: { id }, include: coverInclude });
          if (current.assignmentSource !== 'AUTOMATIC') return { unchanged: true, cover: formatCover(current) };
          const pinned = await tx.coverRequest.update({ where: { id }, data: { assignmentSource: 'MANUAL', assignedById: admin.id, assignedAt: new Date() }, include: coverInclude });
          await tx.coverEvent.create({ data: { schoolId: admin.schoolId, coverRequestId: id, action: 'ASSIGNED', fromStatus: 'ASSIGNED', toStatus: 'ASSIGNED', fromTeacherId: teacherId, toTeacherId: teacherId, actorAdminId: admin.id, note: 'The admin confirmed the automatic choice; it is now a manual assignment' } });
          return { unchanged: false, cover: formatCover(pinned) };
        }

        const versions = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status"::text AS "status" FROM "timetable_versions" WHERE "id" = ${row.timetableVersionId} FOR SHARE`;
        if (versions[0]?.status !== 'PUBLISHED') throw conflict('The timetable this lesson comes from is no longer the published one. Reload the cover requests.', 'COVER_OBSOLETE');

        // One replacement's assignments on one date are decided ONE AT A TIME. The four-consecutive-periods impact depends on the teacher's OTHER covers that
        // day, which live in other cover-request rows; without this, two assignments of the same teacher to adjacent periods can each see "fewer than four"
        // and both commit. Taken right after the cover-request row lock, before the teacher row, so it adds no new lock-order cycle with the other operations.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cover-assign:${teacherId}:${dateToString(pre.date)}`}))`;

        const teachers = await tx.$queryRaw<Array<{ isActive: boolean }>>`SELECT "isActive" FROM "teachers" WHERE "id" = ${teacherId} FOR SHARE`;
        if (!teachers[0]) throw new AppError(404, 'Teacher not found');
        const cover = await tx.coverRequest.findUniqueOrThrow({ where: { id }, include: coverInclude });
        const verdict = (await evaluateTeachers(tx, cover)).find((v) => v.teacher.id === teacherId);
        if (!verdict) throw new AppError(404, 'Teacher not found');
        if (verdict.reason !== null) {
          const message = `${EXCLUSION_MESSAGES[verdict.reason]}; they cannot cover this lesson`;
          throw isEligibilityReason(verdict.reason) ? new AppError(400, message, { code: [verdict.reason] }) : conflict(message, verdict.reason);
        }

        // The four-consecutive-periods preference is recomputed HERE, under the locks, from the current timetable and covers: a stale candidate list cannot
        // slip a teacher into four in a row. It never refuses the assignment: it asks for the admin's explicit confirmation.
        const score = (await scoreValid(tx, cover, [teacherId])).get(teacherId)!;
        const policy = await schoolPolicy(tx, admin.schoolId);
        const tier = tierOf(verdict.basis !== null, score.runLength, policy);
        const runText = periodsText({ from: score.runFrom, to: score.runTo });
        if (isBlockedByPolicy(policy, score.runLength)) {
          throw new AppError(409, `The school's policy (NEVER_ALLOW) does not allow a substitute to teach four or more consecutive periods; this teacher would have ${score.runLength} (${runText}). Choose another teacher, or change the policy (PUT /api/substitution-settings).`, {
            code: ['FOUR_CONSECUTIVE_NOT_ALLOWED'],
            periods: Array.from({ length: score.runTo - score.runFrom + 1 }, (_, i) => String(score.runFrom + i)),
          });
        }
        if (tier === 3 && !confirmFourConsecutive) {
          throw new AppError(409, `Assigning this teacher would give them ${score.runLength} consecutive teaching periods (${runText}). Confirm to assign them anyway, or choose another teacher.`, {
            code: ['FOUR_CONSECUTIVE_CONFIRMATION_REQUIRED'],
            periods: Array.from({ length: score.runTo - score.runFrom + 1 }, (_, i) => String(score.runFrom + i)),
          });
        }

        const reassigned = row.status === 'ASSIGNED';
        const updated = await tx.coverRequest.update({ where: { id }, data: { status: 'ASSIGNED', replacementTeacherId: teacherId, assignedById: admin.id, assignedAt: new Date(), assignmentSource: 'MANUAL', temporaryUnqualified: verdict.basis === null, attentionCode: null, attentionNote: null }, include: coverInclude });
        await tx.coverEvent.create({ data: { schoolId: admin.schoolId, coverRequestId: id, action: reassigned ? 'REASSIGNED' : 'ASSIGNED', fromStatus: row.status, toStatus: 'ASSIGNED', fromTeacherId: row.replacementTeacherId, toTeacherId: teacherId, actorAdminId: admin.id, note: tier === 3 ? `Last-resort assignment confirmed by the admin: ${score.runLength} consecutive teaching periods (${runText})` : null } });
        return { unchanged: false, cover: formatCover(updated), selection: { tier, tierKey: TIER_KEYS[tier], sameSubject: verdict.basis !== null, subjectBasis: verdict.basis, consecutive: { resultingRun: score.runLength, from: score.runFrom, to: score.runTo, createsFourConsecutive: tier === 3 } } };
      }, { timeout: 20_000, maxWait: 10_000 });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('This teacher was just booked for another lesson in the same period', 'REPLACEMENT_ALREADY_BOOKED');
      throw error;
    }
  }

  /** ASSIGNED -> OPEN: remove the replacement, keep the request. */
  async unassign(admin: Admin, id: string) {
    await syncSchool(prisma, admin.schoolId);
    await fetchCoverOwned(admin.schoolId, id);
    return prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ status: string; replacementTeacherId: string | null }>>`SELECT "status"::text AS "status", "replacementTeacherId" FROM "cover_requests" WHERE "id" = ${id} FOR UPDATE`;
      const row = locked[0];
      if (!row) throw new AppError(404, 'Cover request not found');
      assertLive(row.status, 'GET /api/substitutions?status=OPEN,ASSIGNED');
      if (row.status !== 'ASSIGNED') throw conflict('This cover request has no replacement to remove', 'NOT_ASSIGNED');
      const updated = await tx.coverRequest.update({ where: { id }, data: { status: 'OPEN', replacementTeacherId: null, assignedById: null, assignedAt: null, assignmentSource: null, temporaryUnqualified: false }, include: coverInclude });
      await tx.coverEvent.create({ data: { schoolId: admin.schoolId, coverRequestId: id, action: 'UNASSIGNED', fromStatus: 'ASSIGNED', toStatus: 'OPEN', fromTeacherId: row.replacementTeacherId, actorAdminId: admin.id } });
      return formatCover(updated);
    });
  }

  /** OPEN or ASSIGNED -> CANCELLED (no cover is needed for this lesson). The last replacement, if any, stays in the history. */
  async cancelCover(admin: Admin, id: string, reason: string | null | undefined) {
    await syncSchool(prisma, admin.schoolId);
    await fetchCoverOwned(admin.schoolId, id);
    return prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ status: string; replacementTeacherId: string | null }>>`SELECT "status"::text AS "status", "replacementTeacherId" FROM "cover_requests" WHERE "id" = ${id} FOR UPDATE`;
      const row = locked[0];
      if (!row) throw new AppError(404, 'Cover request not found');
      assertLive(row.status, 'GET /api/substitutions?status=OPEN,ASSIGNED');
      const updated = await tx.coverRequest.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: admin.id, cancelReason: reason ?? null, attentionCode: null, attentionNote: null }, include: coverInclude });
      await tx.coverEvent.create({ data: { schoolId: admin.schoolId, coverRequestId: id, action: 'CANCELLED', fromStatus: row.status as 'OPEN' | 'ASSIGNED', toStatus: 'CANCELLED', fromTeacherId: row.replacementTeacherId, actorAdminId: admin.id, note: reason ?? null } });
      return formatCover(updated);
    });
  }

  // ===================================================================================================================================================
  // Substitution events (the persistent, school-scoped feed for the frontend's notifications)
  // ===================================================================================================================================================
  /**
   * Events newest-last since a time, built from the append-only audit trail (cover_events) plus the absences themselves. Types: ABSENCE_RECORDED, ABSENCE_CANCELLED,
   * SUBSTITUTE_AUTO_ASSIGNED, NO_SUBSTITUTE_AVAILABLE, ASSIGNMENT_CHANGED (an admin assigned), SUBSTITUTE_REPLACED (an admin replaced a substitute),
   * ASSIGNMENT_CANCELLED (unassigned/released/cancelled), SUBSTITUTE_RELEASED (the allocator gave an assignment up). Read only; nothing is marked as read.
   */
  async listEvents(schoolId: string, q: { since?: string | undefined; cursor?: string | undefined; limit?: number | undefined }) {
    const limit = q.limit ?? 100;
    // The order is (time, id): events written by one transaction share a timestamp, so a time-only cursor would lose the ones beyond a page boundary.
    // The cursor is therefore the position of the LAST item returned; the next page starts strictly after it and no event is repeated or skipped.
    let after: { ts: Date; id: string } | null = null;
    if (q.cursor) {
      const [iso, ...rest] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('|');
      const ts = new Date(iso ?? '');
      if (Number.isNaN(ts.getTime()) || rest.length === 0) throw new AppError(400, 'Invalid cursor', { cursor: ['Use the nextCursor value of a previous response'] });
      after = { ts, id: rest.join('|') };
    }
    const since = after ? null : q.since ? new Date(q.since) : null;
    const position = after
      ? Prisma.sql`WHERE (x."ts" > ${after.ts.toISOString()}::timestamptz OR (x."ts" = ${after.ts.toISOString()}::timestamptz AND x."id" COLLATE "C" > ${after.id} COLLATE "C"))`
      : since ? Prisma.sql`WHERE x."ts" > ${since.toISOString()}::timestamptz` : Prisma.empty;
    const rows = await prisma.$queryRaw<Array<{ ts: Date; id: string; kind: 'E' | 'R' | 'C'; ref: string }>>`
      SELECT x."ts", x."id", x."kind", x."ref" FROM (
        SELECT e."createdAt" AS "ts", e."id" AS "id", 'E' AS "kind", e."id" AS "ref" FROM "cover_events" e WHERE e."schoolId" = ${schoolId} AND e."action" <> 'CREATED'::"CoverEventAction"
        UNION ALL SELECT a."createdAt", 'absence:' || a."id" || ':recorded', 'R', a."id" FROM "teacher_absences" a WHERE a."schoolId" = ${schoolId}
        UNION ALL SELECT a."cancelledAt", 'absence:' || a."id" || ':cancelled', 'C', a."id" FROM "teacher_absences" a WHERE a."schoolId" = ${schoolId} AND a."cancelledAt" IS NOT NULL
      ) x ${position}
      ORDER BY x."ts" ASC, x."id" COLLATE "C" ASC
      LIMIT ${limit + 1}`;
    const page = rows.slice(0, limit);
    const eventIds = page.filter((r) => r.kind === 'E').map((r) => r.ref);
    const absenceIds = page.filter((r) => r.kind !== 'E').map((r) => r.ref);
    const [events, absences] = await Promise.all([
      eventIds.length ? prisma.coverEvent.findMany({ where: { id: { in: eventIds }, schoolId }, include: { coverRequest: { select: { absenceId: true, date: true, periodNumber: true, absentTeacherId: true } } } }) : [],
      absenceIds.length ? prisma.teacherAbsence.findMany({ where: { id: { in: absenceIds }, schoolId } }) : [],
    ]);
    const eventById = new Map(events.map((e) => [e.id, e]));
    const absenceById = new Map(absences.map((a) => [a.id, a]));
    const teacherIds = [...new Set([...events.flatMap((e) => [e.fromTeacherId, e.toTeacherId, e.coverRequest.absentTeacherId]), ...absences.map((a) => a.teacherId)].filter((x): x is string => x !== null))];
    const teachers = teacherIds.length ? await prisma.teacher.findMany({ where: { id: { in: teacherIds }, schoolId }, select: { id: true, name: true } }) : [];
    const name = new Map(teachers.map((t) => [t.id, t.name]));
    const who = (id: string | null) => (id ? { id, name: name.get(id) ?? null } : null);
    const items = page.map((r) => {
      if (r.kind === 'E') {
        const e = eventById.get(r.ref)!;
        const type = e.action === 'AUTO_ASSIGNED' ? 'SUBSTITUTE_AUTO_ASSIGNED'
          : e.action === 'AUTO_UNFILLED' ? 'NO_SUBSTITUTE_AVAILABLE'
          : e.action === 'AUTO_RELEASED' ? 'SUBSTITUTE_RELEASED'
          : e.action === 'ASSIGNED' ? 'ASSIGNMENT_CHANGED'
          : e.action === 'REASSIGNED' ? 'SUBSTITUTE_REPLACED'
          : e.action === 'UNASSIGNED' || e.action === 'CANCELLED' ? 'ASSIGNMENT_CANCELLED'
          : 'COVER_OBSOLETED';
        return { id: e.id, type, occurredAt: e.createdAt, absenceId: e.coverRequest.absenceId, coverRequestId: e.coverRequestId, date: dateToString(e.coverRequest.date), periodNumber: e.coverRequest.periodNumber as number | null, absentTeacher: who(e.coverRequest.absentTeacherId), fromTeacher: who(e.fromTeacherId), toTeacher: who(e.toTeacherId), automatic: e.action.startsWith('AUTO_'), message: e.note, details: e.details as unknown };
      }
      const a = absenceById.get(r.ref)!;
      const cancelled = r.kind === 'C';
      return { id: r.id, type: cancelled ? 'ABSENCE_CANCELLED' : 'ABSENCE_RECORDED', occurredAt: r.ts, absenceId: a.id, coverRequestId: null, date: dateToString(a.startDate), periodNumber: null, absentTeacher: who(a.teacherId), fromTeacher: null, toTeacher: null, automatic: false, message: cancelled ? null : a.reason, details: cancelled ? null : { startDate: dateToString(a.startDate), endDate: dateToString(a.endDate), scope: a.scope, fromPeriod: a.fromPeriod, toPeriod: a.toPeriod } as unknown };
    });
    const last = page[page.length - 1];
    const encode = (ts: Date, id: string): string => Buffer.from(`${ts.toISOString()}|${id}`, 'utf8').toString('base64url');
    return { items, nextCursor: last ? encode(last.ts, last.id) : q.cursor ?? null, nextSince: last ? last.ts.toISOString() : q.since ?? null, hasMore: rows.length > limit };
  }

  /**
   * Called by the publish endpoint AFTER the publish transaction has committed (never from a GET, never inside the publish transaction, so a failure here cannot undo or
   * corrupt the publish). Reconciles the cover requests with the new published version (the old version's upcoming requests become OBSOLETE, history kept; new OPEN requests
   * are created) and then allocates ONLY the requests made from the new version, with the same rules, locks and manual-override protection as every other allocation.
   * Never throws: a failure is reported and the affected requests stay OPEN; POST /api/substitutions/auto-assign recovers them.
   */
  async afterPublish(admin: Admin, versionId: string) {
    try {
      const run = await autoAllocate(admin, { versionId });
      return { status: 'COMPLETED' as const, run };
    } catch (e) {
      console.error('Automatic substitution after publish failed', e instanceof Error ? e.message : e);
      return { status: 'FAILED' as const, error: 'The timetable was published, but automatic substitute assignment did not complete. The cover requests are OPEN; retry with POST /api/substitutions/auto-assign.' };
    }
  }

  // ===================================================================================================================================================
  // School settings (four consecutive periods)
  // ===================================================================================================================================================
  async getSettings(schoolId: string) {
    return { consecutivePeriodPolicy: await schoolPolicy(prisma, schoolId), allowedValues: ['ALLOW', 'PREFER_AVOID', 'NEVER_ALLOW'] };
  }

  /** Change the policy for FUTURE decisions: assignments already made are never changed by it. */
  async updateSettings(admin: Admin, input: { consecutivePeriodPolicy: ConsecutivePolicy }) {
    await prisma.school.update({ where: { id: admin.schoolId }, data: { consecutivePeriodPolicy: input.consecutivePeriodPolicy } });
    return this.getSettings(admin.schoolId);
  }

}

export const substitutionService = new SubstitutionService();
