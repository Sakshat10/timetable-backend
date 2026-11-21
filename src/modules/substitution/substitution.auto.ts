// ---------------------------------------------------------------------------
// Automatic substitution: the database side. It loads one school day, lets the pure allocator (substitution.allocator.ts) decide, and persists each decision
// through the SAME checks as a manual assignment (substitution.evaluate.ts re-run under locks), writing the same cover_requests/cover_events rows.
//
// Concurrency: one transaction per day; the first statement takes the school's automatic-allocation advisory lock, so simultaneous runs are serialised and each
// sees the other's assignments. Nothing here ever WAITS for a lock held by a manual operation (cover row, replacement teacher row, version row: SKIP LOCKED;
// per-teacher-per-date advisory lock: try-lock), so it cannot deadlock with them; a busy slot is retried in a later round and, if still busy, reported. The partial
// unique index on (replacement, date, period) remains the last guard. Only OPEN requests are touched: an assigned request (by anyone) is never overwritten.
// The published timetable is only READ.
// ---------------------------------------------------------------------------
import { Prisma } from '@prisma/client';
import prisma from '../../config/database.js';
import { allocateDay, UNFILLED_MESSAGES, type AllocCover, type AllocTeacher, type AllocWorld, type AssignedDecision, type UnfilledCode, type UnfilledDecision } from './substitution.allocator.js';
import { absenceCoversSlot, adjacency, dateToString, DEFAULT_CONSECUTIVE_POLICY, isBlockedByPolicy, MAX_PERIOD, TIER_KEYS, tierOf, type ConsecutivePolicy, type SubjectBasis } from './substitution.core.js';
import { evaluateTeachers, gradeEligibleTeachers, scoreValid, workloadFacts } from './substitution.evaluate.js';
import { syncSchool } from './substitution.sync.js';
import { effectiveSchedule, SCHEDULE_ENGINE_SELECT } from '../schedule-config/schedule-config.effective.js';

type Db = Prisma.TransactionClient;
export interface AutoAdmin { id: string; schoolId: string }
export interface AutoScope {
  /** Only the OPEN requests of these absences (and/or of the coverIds below). */
  absenceIds?: string[];
  /** Only these requests (used for requests an absence change just released). */
  coverIds?: string[];
  from?: string;
  to?: string;
  /** Only the requests made from this timetable version (used right after it was published). */
  versionId?: string;
}
export interface AutoOptions {
  /** false: a free teacher with no link to the subject may not be used (default true: the school's existing policy is that temporary cover is permitted). */
  allowTemporaryCover?: boolean;
}

const asDate = (d: string): Date => new Date(`${d}T00:00:00.000Z`);
const MAX_ROUNDS = 3;
export const todayUtc = (): string => new Date().toISOString().slice(0, 10);
const ALL_PERIODS = Array.from({ length: MAX_PERIOD }, (_, i) => i + 1);

export interface AutoRunResult {
  /** OPEN requests of future dates that were considered. */
  considered: number;
  assigned: number;
  unfilled: number;
  /** Requests that changed or were busy while the run was deciding (left OPEN; a retry handles them). */
  conflicts: number;
  /** OPEN requests inside the scope whose date has already passed (never assigned automatically). */
  skippedPast: number;
  /** New requests that replace a lesson an ADMIN had assigned in the previous timetable version: left OPEN for the admin's review, never filled automatically. */
  heldForReview: number;
}

interface TargetCover {
  id: string; schoolId: string; date: Date; dayOfWeek: string; periodNumber: number; timetableVersionId: string; subjectId: string; sectionId: string; absentTeacherId: string; attentionCode: string | null;
  section: { gradeId: string }; timetableVersion: { academicYearId: string };
}

/** Load the day (all teachers of the school with their facts) for the given covers of ONE date and version. */
async function loadWorld(db: Db, schoolId: string, date: string, versionId: string, yearId: string, covers: TargetCover[], allowTemporaryCover: boolean, policy: ConsecutivePolicy): Promise<AllocWorld> {
  const dateD = asDate(date);
  const weekday = covers[0]!.dayOfWeek;
  const subjectIds = [...new Set(covers.map((c) => c.subjectId))];
  const [teachers, links, subjectLessons, dayLessons, absences, unavailable, covering, schedule] = await Promise.all([
    db.teacher.findMany({ where: { schoolId }, select: { id: true, name: true, isActive: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
    db.teacherSubject.findMany({ where: { subjectId: { in: subjectIds }, teacher: { schoolId } }, select: { teacherId: true, subjectId: true, type: true } }),
    db.timetableEntry.findMany({ where: { versionId, subjectId: { in: subjectIds } }, distinct: ['teacherId', 'subjectId'], select: { teacherId: true, subjectId: true } }),
    db.timetableEntry.findMany({ where: { versionId, dayOfWeek: weekday as never }, select: { teacherId: true, periodNumber: true } }),
    db.teacherAbsence.findMany({ where: { schoolId, status: 'ACTIVE', startDate: { lte: dateD }, endDate: { gte: dateD } } }),
    db.teacherUnavailability.findMany({ where: { schoolId, status: 'ACTIVE', date: dateD }, select: { teacherId: true, periodNumber: true } }),
    db.coverRequest.findMany({ where: { schoolId, date: dateD, status: 'ASSIGNED' }, select: { replacementTeacherId: true, periodNumber: true } }),
    db.scheduleConfig.findUnique({ where: { academicYearId: yearId }, select: SCHEDULE_ENGINE_SELECT }),
  ]);
  const ids = teachers.map((t) => t.id);
  const [load, ...eligibleSets] = await Promise.all([
    workloadFacts(db, schoolId, versionId, date, ids, null),
    ...[...new Set(covers.map((c) => `${c.subjectId}|${c.section.gradeId}`))].map(async (key) => {
      const [subjectId, gradeId] = key.split('|') as [string, string];
      return { key, set: await gradeEligibleTeachers(db, subjectId, gradeId, ids) };
    }),
  ]) as [Awaited<ReturnType<typeof workloadFacts>>, ...Array<{ key: string; set: Set<string> }>];

  const allocTeachers: AllocTeacher[] = teachers.map((t) => {
    const mine = absences.filter((a) => a.teacherId === t.id).map((a) => ({ startDate: dateToString(a.startDate), endDate: dateToString(a.endDate), scope: a.scope, fromPeriod: a.fromPeriod, toPeriod: a.toPeriod }));
    const absentPeriods = new Set(ALL_PERIODS.filter((p) => mine.some((a) => absenceCoversSlot(a, date, p))));
    const unavailablePeriods = new Set<number>();
    for (const u of unavailable) if (u.teacherId === t.id) for (const p of u.periodNumber === null ? ALL_PERIODS : [u.periodNumber]) unavailablePeriods.add(p);
    const lessonPeriods = new Set(dayLessons.filter((l) => l.teacherId === t.id).map((l) => l.periodNumber));
    const basisBySubject = new Map<string, SubjectBasis>();
    for (const sid of subjectIds) {
      const link = links.find((l) => l.teacherId === t.id && l.subjectId === sid);
      if (link) basisBySubject.set(sid, link.type === 'PRIMARY' ? 'PRIMARY_LINK' : 'SECONDARY_LINK');
      else if (subjectLessons.some((l) => l.teacherId === t.id && l.subjectId === sid)) basisBySubject.set(sid, 'TEACHES_IN_TIMETABLE');
    }
    const gradeEligible = new Set<string>();
    for (const e of eligibleSets) if (e.set.has(t.id)) gradeEligible.add(e.key);
    return {
      id: t.id, name: t.name, isActive: t.isActive, absentPeriods, unavailablePeriods, lessonPeriods,
      teachingPeriods: new Set([...lessonPeriods].filter((p) => !absentPeriods.has(p))),
      coveringPeriods: new Set(covering.filter((c) => c.replacementTeacherId === t.id).map((c) => c.periodNumber)),
      weeklyLoad: load.get(t.id)?.weeklyLoad ?? 0, recentCovers: load.get(t.id)?.recentCovers ?? 0, basisBySubject, gradeEligible,
    };
  });
  const effective = schedule ? effectiveSchedule(schedule) : null;
  const continues = adjacency(effective?.periodsPerDay ?? MAX_PERIOD, effective?.breakPositions ?? []);
  return { teachers: allocTeachers, continues: () => continues, allowTemporaryCover, policy };
}

type Outcome = 'ASSIGNED' | 'UNFILLED' | 'CONFLICT';

/** Persist one ASSIGN decision under locks, re-checking it with the manual-assignment rules. CONFLICT: not assigned, retry later. */
async function persistAssign(tx: Db, admin: AutoAdmin, d: AssignedDecision, date: string, policy: ConsecutivePolicy): Promise<Outcome> {
  const locked = await tx.$queryRaw<Array<{ status: string; timetableVersionId: string }>>`
    SELECT "status"::text AS "status", "timetableVersionId" FROM "cover_requests" WHERE "id" = ${d.coverId} AND "schoolId" = ${admin.schoolId} FOR UPDATE SKIP LOCKED`;
  const row = locked[0];
  if (!row || row.status !== 'OPEN') return 'CONFLICT'; // locked by someone, or no longer open (assigned/cancelled meanwhile): never overwritten
  const versions = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status"::text AS "status" FROM "timetable_versions" WHERE "id" = ${row.timetableVersionId} FOR SHARE SKIP LOCKED`;
  if (versions[0]?.status !== 'PUBLISHED') return 'CONFLICT';
  const got = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${`cover-assign:${d.option.teacherId}:${date}`})) AS "ok"`;
  if (!got[0]?.ok) return 'CONFLICT';
  const teacherRows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "teachers" WHERE "id" = ${d.option.teacherId} AND "schoolId" = ${admin.schoolId} FOR SHARE SKIP LOCKED`;
  if (!teacherRows[0]) return 'CONFLICT';

  const cover = await tx.coverRequest.findUniqueOrThrow({ where: { id: d.coverId }, include: { section: { select: { gradeId: true } }, timetableVersion: { select: { academicYearId: true } } } });
  const verdict = (await evaluateTeachers(tx, cover)).find((v) => v.teacher.id === d.option.teacherId);
  if (!verdict || verdict.reason !== null) return 'CONFLICT';
  const score = (await scoreValid(tx, cover, [d.option.teacherId])).get(d.option.teacherId)!;
  if (isBlockedByPolicy(policy, score.runLength)) return 'CONFLICT'; // NEVER_ALLOW and the run changed since the decision: decide again
  const tier = tierOf(verdict.basis !== null, score.runLength, policy);
  // PREFER_AVOID: a last resort is only legitimate when nobody better was available at decision time; the allocator ranked it last, so that held then.
  if (tier === 3 && !d.lastResort) return 'CONFLICT'; // it became four-in-a-row since the decision (a concurrent change): decide again

  const details = {
    mode: 'AUTOMATIC',
    policy, lastResort: tier === 3,
    tier, tierKey: TIER_KEYS[tier],
    subjectBasis: verdict.basis, gradeEligible: d.option.gradeEligible, temporaryUnqualified: verdict.basis === null,
    weeklyLoad: d.option.weeklyLoad, coverLoadToday: d.option.coverLoad, recentCovers: d.option.recentCovers,
    consecutive: { resultingRun: score.runLength, from: score.runFrom, to: score.runTo },
    candidatesConsidered: d.optionCount,
    rankingOrder: ['subjectBasis', 'gradeEligible', 'weeklyLoad', 'coverLoadToday', 'consecutive.resultingRun', 'recentCovers', 'name', 'id'],
    nextBest: d.alternatives.map((a) => ({ teacherId: a.teacherId, name: a.name, tier: a.tier, subjectBasis: a.basis, gradeEligible: a.gradeEligible, weeklyLoad: a.weeklyLoad, coverLoad: a.coverLoad, runLength: a.runLength, recentCovers: a.recentCovers })),
    excludedCounts: d.excludedCounts,
  };
  const runText = `P${score.runFrom}${score.runTo === score.runFrom ? '' : `–P${score.runTo}`}`;
  const note = (verdict.basis === null
    ? 'Automatically assigned as TEMPORARY, UNQUALIFIED cover: no free teacher of this subject was available; no subject link or grade eligibility was created or changed'
    : 'Automatically assigned: the best free teacher of this subject') +
    (tier === 3 ? `. LAST RESORT: ${score.runLength} consecutive teaching periods (${runText}); nobody better was free (school policy ${policy})` : '');
  await tx.coverRequest.update({ where: { id: d.coverId }, data: { status: 'ASSIGNED', replacementTeacherId: d.option.teacherId, assignedById: admin.id, assignedAt: new Date(), assignmentSource: 'AUTOMATIC', temporaryUnqualified: verdict.basis === null, attentionCode: null, attentionNote: null } });
  await tx.coverEvent.create({ data: { schoolId: admin.schoolId, coverRequestId: d.coverId, action: 'AUTO_ASSIGNED', fromStatus: 'OPEN', toStatus: 'ASSIGNED', toTeacherId: d.option.teacherId, actorAdminId: admin.id, note, details: details as Prisma.InputJsonValue } });
  return 'ASSIGNED';
}

/** Leave the request OPEN and record why (once per distinct reason: repeated runs write nothing new). */
async function persistUnfilled(tx: Db, admin: AutoAdmin, d: UnfilledDecision, previousCode: string | null): Promise<Outcome> {
  const locked = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status"::text AS "status" FROM "cover_requests" WHERE "id" = ${d.coverId} AND "schoolId" = ${admin.schoolId} FOR UPDATE SKIP LOCKED`;
  if (!locked[0] || locked[0].status !== 'OPEN') return 'CONFLICT';
  if (previousCode === d.code) return 'UNFILLED';
  await tx.coverRequest.update({ where: { id: d.coverId }, data: { attentionCode: d.code, attentionNote: d.message } });
  await tx.coverEvent.create({ data: { schoolId: admin.schoolId, coverRequestId: d.coverId, action: 'AUTO_UNFILLED', fromStatus: 'OPEN', toStatus: 'OPEN', actorAdminId: admin.id, note: d.message, details: { code: d.code, excludedCounts: d.excludedCounts } as Prisma.InputJsonValue } });
  return 'UNFILLED';
}

export const MANUAL_REVIEW_CODE = 'MANUAL_ASSIGNMENT_NEEDS_REVIEW';

/**
 * A new request created after a republish replaces (supersedes) an old one. If an ADMIN had assigned a substitute to that old lesson, the admin's decision must not be quietly
 * replaced by an algorithmic one: the new request stays OPEN with attention MANUAL_ASSIGNMENT_NEEDS_REVIEW (one AUTO_UNFILLED event, written once) and the admin assigns it, or
 * confirms the previous teacher, through the normal assignment endpoint. Returns the ids held back.
 */
async function holdManualSuccessors(admin: AutoAdmin, open: Array<{ id: string; date: Date; supersedesId: string | null; attentionCode: string | null }>): Promise<Set<string>> {
  const successors = open.filter((c) => c.supersedesId !== null);
  if (successors.length === 0) return new Set();
  const olds = await prisma.coverRequest.findMany({ where: { id: { in: successors.map((c) => c.supersedesId!) }, schoolId: admin.schoolId, assignmentSource: 'MANUAL', replacementTeacherId: { not: null } }, select: { id: true, replacementTeacherId: true, replacementTeacher: { select: { name: true } } } });
  const oldById = new Map(olds.map((o) => [o.id, o]));
  const held = new Set<string>();
  for (const c of successors) {
    const old = oldById.get(c.supersedesId!);
    if (!old) continue;
    held.add(c.id);
    if (c.attentionCode === MANUAL_REVIEW_CODE) continue;
    const note = `An admin had assigned ${old.replacementTeacher?.name ?? 'a substitute'} for this lesson in the previous timetable version. It is not replaced automatically: review and assign it`;
    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status"::text AS "status" FROM "cover_requests" WHERE "id" = ${c.id} AND "schoolId" = ${admin.schoolId} FOR UPDATE SKIP LOCKED`;
      if (locked[0]?.status !== 'OPEN') return;
      await tx.coverRequest.update({ where: { id: c.id }, data: { attentionCode: MANUAL_REVIEW_CODE, attentionNote: note } });
      await tx.coverEvent.create({ data: { schoolId: admin.schoolId, coverRequestId: c.id, action: 'AUTO_UNFILLED', fromStatus: 'OPEN', toStatus: 'OPEN', actorAdminId: admin.id, note, details: { code: MANUAL_REVIEW_CODE, previousRequestId: old.id, previousSubstituteId: old.replacementTeacherId } as Prisma.InputJsonValue } });
    });
  }
  return held;
}

/**
 * Coordinated automatic allocation of the OPEN requests in `scope` (future dates, PUBLISHED versions only). Idempotent: assigned requests are never touched, repeated
 * calls do nothing once everything assignable is assigned. Dates are processed in order, each in its own transaction, so a failure keeps the earlier days' work.
 */
export async function autoAllocate(admin: AutoAdmin, scope: AutoScope, options: AutoOptions = {}): Promise<AutoRunResult> {
  const allowTemporaryCover = options.allowTemporaryCover !== false;
  await syncSchool(prisma, admin.schoolId);
  const today = todayUtc();
  const where: Prisma.CoverRequestWhereInput = {
    schoolId: admin.schoolId, status: 'OPEN', timetableVersion: { status: 'PUBLISHED' },
    ...(scope.versionId ? { timetableVersionId: scope.versionId } : {}),
    ...(scope.absenceIds || scope.coverIds ? { OR: [...(scope.absenceIds ? [{ absenceId: { in: scope.absenceIds } }] : []), ...(scope.coverIds ? [{ id: { in: scope.coverIds } }] : [])] } : {}),
    ...(scope.from || scope.to ? { date: { ...(scope.from ? { gte: asDate(scope.from) } : {}), ...(scope.to ? { lte: asDate(scope.to) } : {}) } } : {}),
  };
  let open = await prisma.coverRequest.findMany({ where, select: { id: true, date: true, supersedesId: true, attentionCode: true } });
  const held = await holdManualSuccessors(admin, open);
  open = open.filter((c) => !held.has(c.id));
  const result: AutoRunResult = { considered: 0, assigned: 0, unfilled: 0, conflicts: 0, skippedPast: open.filter((c) => dateToString(c.date) < today).length, heldForReview: held.size };
  const dates = [...new Set(open.map((c) => dateToString(c.date)).filter((d) => d >= today))].sort();

  for (const date of dates) {
    let pending = open.filter((c) => dateToString(c.date) === date).map((c) => c.id);
    for (let round = 1; round <= MAX_ROUNDS && pending.length > 0; round++) {
      const retry: string[] = [];
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`cover-auto:${admin.schoolId}`}))`;
        const policy = (await tx.school.findUnique({ where: { id: admin.schoolId }, select: { consecutivePeriodPolicy: true } }))?.consecutivePeriodPolicy ?? DEFAULT_CONSECUTIVE_POLICY;
        const covers = await tx.coverRequest.findMany({
          where: { id: { in: pending }, status: 'OPEN', timetableVersion: { status: 'PUBLISHED' }, schoolId: admin.schoolId },
          select: { id: true, schoolId: true, date: true, dayOfWeek: true, periodNumber: true, timetableVersionId: true, subjectId: true, sectionId: true, absentTeacherId: true, attentionCode: true, section: { select: { gradeId: true } }, timetableVersion: { select: { academicYearId: true } } },
        });
        // requests no longer open (assigned/cancelled/obsolete meanwhile) are simply left alone: they are not in `covers`
        if (round === 1) result.considered += covers.length;
        const groups = new Map<string, TargetCover[]>();
        for (const c of covers) groups.set(c.timetableVersionId, [...(groups.get(c.timetableVersionId) ?? []), c]);
        for (const [versionId, group] of groups) {
          const world = await loadWorld(tx, admin.schoolId, date, versionId, group[0]!.timetableVersion.academicYearId, group, allowTemporaryCover, policy);
          const allocCovers: AllocCover[] = group.map((c) => ({ id: c.id, sectionId: c.sectionId, period: c.periodNumber, subjectId: c.subjectId, gradeId: c.section.gradeId, absentTeacherId: c.absentTeacherId, yearId: c.timetableVersion.academicYearId }));
          const prev = new Map(group.map((c) => [c.id, c.attentionCode]));
          for (const d of allocateDay(world, allocCovers)) {
            const outcome = d.kind === 'ASSIGN' ? await persistAssign(tx, admin, d, date, policy) : await persistUnfilled(tx, admin, d, prev.get(d.coverId) ?? null);
            if (outcome === 'ASSIGNED') result.assigned++;
            else if (outcome === 'UNFILLED') result.unfilled++;
            else retry.push(d.coverId);
          }
        }
      }, { timeout: 30_000, maxWait: 10_000 });
      pending = retry;
    }
    if (pending.length > 0) {
      // still busy or changed after every round: leave them OPEN, say so (nothing is half-assigned)
      const still = await prisma.coverRequest.count({ where: { id: { in: pending }, status: 'OPEN' } });
      result.conflicts += still;
    }
  }
  return result;
}

export { UNFILLED_MESSAGES };
export type { UnfilledCode };

// ---------------------------------------------------------------------------
// Result summary (also served by GET /teacher-absences/:id/substitution-summary)
// ---------------------------------------------------------------------------
export interface AllocationSummary {
  totalAffectedLessons: number;
  assigned: number;
  automaticallyAssigned: number;
  manuallyAssigned: number;
  unfilled: number;
  temporaryUnqualifiedCovers: number;
  skippedPastDates: number;
  needsAdminAttention: number;
  covers: Array<{
    id: string; absenceId: string; date: string; periodNumber: number; status: string;
    section: { id: string; name: string }; subject: { id: string; name: string };
    replacementTeacher: { id: string; name: string } | null;
    assignmentSource: string | null; temporaryUnqualified: boolean;
    attention: { code: string; message: string | null } | null;
  }>;
}

/** Live (OPEN/ASSIGNED) requests of the given absences, counted and listed. School-scoped. */
export async function summarize(schoolId: string, absenceIds: string[], extraCoverIds: string[] = []): Promise<AllocationSummary> {
  const rows = await prisma.coverRequest.findMany({
    where: { schoolId, status: { in: ['OPEN', 'ASSIGNED'] }, OR: [{ absenceId: { in: absenceIds } }, ...(extraCoverIds.length ? [{ id: { in: extraCoverIds } }] : [])] },
    include: { section: { select: { id: true, name: true } }, subject: { select: { id: true, name: true } }, replacementTeacher: { select: { id: true, name: true } } },
    orderBy: [{ date: 'asc' }, { periodNumber: 'asc' }, { id: 'asc' }],
  });
  const today = todayUtc();
  const covers = rows.map((c) => {
    const date = dateToString(c.date);
    const attention = c.status === 'OPEN' ? (c.attentionCode ? { code: c.attentionCode, message: c.attentionNote } : date < today ? { code: 'PAST_DATE', message: 'The date has passed; past lessons are not assigned automatically' } : null) : null;
    return { id: c.id, absenceId: c.absenceId, date, periodNumber: c.periodNumber, status: c.status, section: c.section, subject: c.subject, replacementTeacher: c.replacementTeacher, assignmentSource: c.assignmentSource, temporaryUnqualified: c.temporaryUnqualified, attention };
  });
  const assigned = covers.filter((c) => c.status === 'ASSIGNED');
  const open = covers.filter((c) => c.status === 'OPEN');
  return {
    totalAffectedLessons: covers.length,
    assigned: assigned.length,
    automaticallyAssigned: assigned.filter((c) => c.assignmentSource === 'AUTOMATIC').length,
    manuallyAssigned: assigned.filter((c) => c.assignmentSource === 'MANUAL').length,
    unfilled: open.length,
    temporaryUnqualifiedCovers: assigned.filter((c) => c.temporaryUnqualified).length,
    skippedPastDates: open.filter((c) => c.date < today).length,
    needsAdminAttention: open.length,
    covers,
  };
}
