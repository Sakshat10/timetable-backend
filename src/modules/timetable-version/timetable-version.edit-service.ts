import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { type TimetableMetrics } from '../timetable-generation/timetable-generation.metrics.js';
import {
  applyPlan, checkMutable, lockedCount, manualEditCount, metricsDelta, planLocks, planMove, problemFromCore, SnapshotUnusableError, validateVersion,
  type EditableEntry, type MetricsDelta, type VersionStatus, type YearStatus,
} from './timetable-version.edit-core.js';
import { busyError, fromRefusal, isLockTimeout, VersionRuleError } from './timetable-version.errors.js';
import { type EntryView, type LocksBody, type MoveBody } from './timetable-version.schema.js';

const LOCK_TIMEOUT_SECONDS = 5;
/** A swap parks one lesson here for the middle statement of its transaction. No real period is anywhere near it (CHECK periodNumber >= 1 allows it). */
export const TEMP_PERIOD = 1_000_000;
const TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 } as const;

export const ENTRY_SELECT = {
  id: true, sectionId: true, subjectId: true, teacherId: true, subjectRequirementId: true, dayOfWeek: true, periodNumber: true, source: true, isLocked: true,
} as const;

export interface MoveResult {
  versionId: string;
  mode: 'MOVE' | 'SWAP';
  revision: number;
  /** The lessons whose slot changed (one for a move, two for a swap), in their NEW state. */
  changedEntries: EntryView[];
  metrics: TimetableMetrics | null;
  /** after - before (negative is better); null when either side has no metrics. */
  metricsDelta: MetricsDelta | null;
  manualEditCount: number;
  lockedCount: number;
}

export interface LocksResult {
  versionId: string;
  locked: boolean;
  /** Entries whose state really changed. */
  changed: number;
  /** Entries that were already in the requested state. */
  unchanged: number;
  revision: number;
  lockedCount: number;
}

export interface LockedVersion {
  schoolId: string;
  yearId: string;
  yearName: string;
  yearStatus: YearStatus;
  versionStatus: VersionStatus;
  revision: number;
}

/**
 * Take the locks every mutation needs, in the one global order: the academic year row, then the version row.
 *   year    FOR SHARE   (edits and lock changes of different versions do not block each other; a publish of the year, which takes
 *                        FOR UPDATE, serialises with all of them; a concurrent change of the year's status waits)
 *   version FOR UPDATE  (serialises every mutation of THIS version, and a concurrent DELETE of it)
 * Returns the state under the locks, or throws 404 when the version vanished (deleted) in the meantime.
 */
export async function lockVersionForMutation(tx: Prisma.TransactionClient, schoolId: string, versionId: string, yearId: string): Promise<LockedVersion> {
  await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_SECONDS}s'`);
  const years = await tx.$queryRaw<Array<{ name: string; status: YearStatus }>>`SELECT "name", "status"::text AS status FROM "academic_years" WHERE "id" = ${yearId} AND "schoolId" = ${schoolId} FOR SHARE`;
  const versions = await tx.$queryRaw<Array<{ status: VersionStatus; revision: number }>>`SELECT "status"::text AS status, "revision" FROM "timetable_versions" WHERE "id" = ${versionId} AND "schoolId" = ${schoolId} FOR UPDATE`;
  const year = years[0];
  const version = versions[0];
  if (!year || !version) throw new AppError(404, 'Timetable version not found');
  return { schoolId, yearId, yearName: year.name, yearStatus: year.status, versionStatus: version.status, revision: version.revision };
}

/** Existence and ownership before any lock: 404 unknown, 403 another school's version (the Phase 6 convention). Returns the year of the version. */
export async function resolveOwnedVersion(db: PrismaClient, schoolId: string, versionId: string): Promise<{ academicYearId: string }> {
  const version = await db.timetableVersion.findUnique({ where: { id: versionId }, select: { schoolId: true, academicYearId: true } });
  if (!version) throw new AppError(404, 'Timetable version not found');
  if (version.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this timetable version');
  return { academicYearId: version.academicYearId };
}

const toEditable = (rows: Array<{ id: string; sectionId: string; subjectId: string; teacherId: string; subjectRequirementId: string; dayOfWeek: string; periodNumber: number; source: string; isLocked: boolean }>): EditableEntry[] =>
  rows.map((r) => ({ ...r, source: r.source as EditableEntry['source'] }));

export class TimetableVersionEditService {
  constructor(private readonly db: PrismaClient = prisma) {}

  /** Run a transactional mutation, turning a lock timeout into a deterministic, retryable 503 BUSY. */
  private async transact<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try {
      return await this.db.$transaction(work, TX_OPTIONS);
    } catch (error) {
      if (isLockTimeout(error)) throw busyError();
      throw error;
    }
  }

  /**
   * POST /timetable-versions/:id/moves : move one lesson to a free slot, or swap two lessons of the same section.
   * Valid immediately after commit, or refused: the validation of the WHOLE resulting timetable runs inside the same locked
   * transaction. The version row is locked first, so two edits can never interleave.
   */
  async move(schoolId: string, versionId: string, body: MoveBody & { expectedRevision: number }): Promise<MoveResult> {
    const { academicYearId } = await resolveOwnedVersion(this.db, schoolId, versionId);

    return this.transact(async (tx) => {
      const state = await lockVersionForMutation(tx, schoolId, versionId, academicYearId);
      const blocked = checkMutable({ versionStatus: state.versionStatus, yearStatus: state.yearStatus, revision: state.revision, expectedRevision: body.expectedRevision });
      if (blocked) throw fromRefusal(blocked);

      const version = await tx.timetableVersion.findUniqueOrThrow({ where: { id: versionId }, select: { inputSnapshot: true, metrics: true } });
      const entries = toEditable(await tx.timetableEntry.findMany({ where: { versionId }, select: ENTRY_SELECT }));
      let problem;
      try {
        problem = problemFromCore(version.inputSnapshot, { schoolId, academicYear: { id: academicYearId, name: state.yearName } });
      } catch (error) {
        if (error instanceof SnapshotUnusableError) throw new VersionRuleError(409, 'SNAPSHOT_UNUSABLE', 'This timetable cannot be edited because its stored configuration snapshot is unusable');
        throw error;
      }

      const planned = planMove(problem, entries, { entryId: body.entryId, to: body.to, swapWithEntryId: body.swapWithEntryId });
      if (!planned.ok) throw fromRefusal(planned);

      const after = applyPlan(entries, planned.plan);
      const before = validateVersion(problem, entries);
      const verdict = validateVersion(problem, after);
      if (!verdict.valid || verdict.metrics === null) {
        // unreachable if the planning rules are complete; it is the proof that no invalid draft is ever committed
        throw new VersionRuleError(409, 'INVARIANT_VIOLATION', 'The change would make the timetable invalid and was not applied', { violations: verdict.violations.slice(0, 5) });
      }

      // ---- write -----------------------------------------------------------------------------------------------------------
      const [first, second] = planned.plan.changes;
      if (planned.plan.mode === 'MOVE') {
        await tx.timetableEntry.update({ where: { id: first!.id }, data: { dayOfWeek: first!.dayOfWeek as never, periodNumber: first!.periodNumber, source: 'MANUAL' } });
      } else {
        // The slot uniqueness is a plain (non-deferrable) unique index, so two lessons cannot exchange slots in one statement.
        // Park the first lesson in a slot nobody can have, move the second into the first's slot, then the first into the second's.
        // All three statements run inside this transaction: no other connection ever sees the intermediate state.
        const original = entries.find((e) => e.id === first!.id)!;
        await tx.timetableEntry.update({ where: { id: first!.id }, data: { periodNumber: TEMP_PERIOD } });
        await tx.timetableEntry.update({ where: { id: second!.id }, data: { dayOfWeek: second!.dayOfWeek as never, periodNumber: original.periodNumber, source: 'MANUAL' } });
        await tx.timetableEntry.update({ where: { id: first!.id }, data: { dayOfWeek: first!.dayOfWeek as never, periodNumber: first!.periodNumber, source: 'MANUAL' } });
      }
      const bumped = await tx.timetableVersion.updateMany({
        where: { id: versionId, revision: body.expectedRevision, status: 'DRAFT' },
        data: { revision: { increment: 1 }, metrics: verdict.metrics as unknown as Prisma.InputJsonValue },
      });
      if (bumped.count !== 1) throw new VersionRuleError(409, 'REVISION_CONFLICT', 'The timetable was changed by someone else. Reload it and try again', { revision: state.revision });

      const changedRows = await tx.timetableEntry.findMany({ where: { id: { in: planned.plan.changes.map((c) => c.id) } }, select: ENTRY_SELECT });
      const byId = new Map(changedRows.map((r) => [r.id, r]));
      return {
        versionId,
        mode: planned.plan.mode,
        revision: body.expectedRevision + 1,
        changedEntries: planned.plan.changes.map((c) => ({ ...byId.get(c.id)!, source: String(byId.get(c.id)!.source) })) as EntryView[],
        metrics: verdict.metrics,
        metricsDelta: before.metrics ? metricsDelta(before.metrics, verdict.metrics) : null,
        manualEditCount: manualEditCount(after),
        lockedCount: lockedCount(after),
      };
    });
  }

  /**
   * PUT /timetable-versions/:id/locks : set isLocked on a list of entries (lock and unlock are the same idempotent operation).
   * The revision grows only when at least one entry really changes; a request that changes nothing succeeds and leaves the
   * revision as it is. expectedRevision is still checked, so a stale client is told so even for a no-op.
   */
  async setLocks(schoolId: string, versionId: string, body: LocksBody & { expectedRevision: number }): Promise<LocksResult> {
    const { academicYearId } = await resolveOwnedVersion(this.db, schoolId, versionId);

    return this.transact(async (tx) => {
      const state = await lockVersionForMutation(tx, schoolId, versionId, academicYearId);
      const blocked = checkMutable({ versionStatus: state.versionStatus, yearStatus: state.yearStatus, revision: state.revision, expectedRevision: body.expectedRevision });
      if (blocked) throw fromRefusal(blocked);

      // only entries OF THIS VERSION are visible to the plan: an id of another version (or school) is simply "not found"
      const found = toEditable(await tx.timetableEntry.findMany({ where: { versionId, id: { in: body.entryIds } }, select: ENTRY_SELECT }));
      const planned = planLocks(found, body.entryIds, body.locked);
      if (!planned.ok) throw fromRefusal(planned);

      const { toChange, unchanged } = planned.plan;
      let revision = state.revision;
      if (toChange.length > 0) {
        await tx.timetableEntry.updateMany({ where: { versionId, id: { in: toChange } }, data: { isLocked: body.locked } });
        const bumped = await tx.timetableVersion.updateMany({ where: { id: versionId, revision: body.expectedRevision, status: 'DRAFT' }, data: { revision: { increment: 1 } } });
        if (bumped.count !== 1) throw new VersionRuleError(409, 'REVISION_CONFLICT', 'The timetable was changed by someone else. Reload it and try again', { revision: state.revision });
        revision += 1;
      }
      return {
        versionId,
        locked: body.locked,
        changed: toChange.length,
        unchanged: unchanged.length,
        revision,
        lockedCount: await tx.timetableEntry.count({ where: { versionId, isLocked: true } }),
      };
    });
  }
}

export const timetableVersionEditService = new TimetableVersionEditService();
