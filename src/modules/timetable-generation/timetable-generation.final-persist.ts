import { Prisma, type PrismaClient, type SolutionSource, type SolverStatus } from '@prisma/client';
import { type TimetableEntryRow } from './timetable-generation.contracts.js';
import { readGenerationSnapshot, SnapshotError } from './timetable-generation.loader.js';
import { type TimetableMetrics } from './timetable-generation.metrics.js';
import { type FrozenLock } from './timetable-generation.locks.js';
import { claimDraftSlot, DEFAULT_MAX_DRAFTS_PER_YEAR } from './timetable-generation.draft-slots.js';
import { periodTimesMatchGrid, type PeriodTime } from './timetable-generation.period-times.js';
import { normalizeProblem, type NormalizedProblem } from './timetable-generation.normalizer.js';
import { validateEntries } from './timetable-generation.validator.js';

// ---------------------------------------------------------------------------
// Stage 3: the final, atomic persistence of a generated timetable.
//
// ONE transaction does all of this, and any failure rolls everything back (no version, no entries, run not SUCCEEDED):
//
//   1. FENCE   lock the run row `FOR UPDATE` while it is RUNNING, owned by this worker's token and its lease unexpired.
//              The row lock also keeps stale-lease recovery away until we commit (it skips locked rows).
//   2. LOCK    `FOR SHARE` on everything the solved problem depends on: the academic year, the schedule config, the
//              year's grades (Modules 5 and 7 take the grade row `FOR UPDATE` when they add sections or requirements),
//              the used teachers, teacher-subject links, grade eligibility, assignments and requirements. Concurrent
//              writers of those rows (they UPDATE / DELETE or take FOR UPDATE) wait for us or are blocked.
//   3. RE-READ the authoritative snapshot under those locks (READ COMMITTED: it sees the latest committed state).
//   4. RE-CHECK the year is still DRAFT, the data still normalises, and the input hash is IDENTICAL to the hash of the
//              problem that was solved. Otherwise nothing is persisted (CONFIGURATION_CHANGED).
//   5. RE-VALIDATE the candidate timetable against the freshly normalised problem.
//   6. CAP     (Phase 7F-0) take the year's draft-slot lock (the LAST lock, after the year, config and dependency locks), then count:
//              a year already holding MAX_DRAFTS_PER_YEAR drafts gets nothing (DraftLimitReachedError, no version, source untouched).
//   7. WRITE   the version (always a NEW version, status DRAFT, with the run's frozen period times), its entries, and mark the
//              run SUCCEEDED, fenced again.
// ---------------------------------------------------------------------------

/** The worker no longer owns the run (it was requeued, failed, re-claimed, or its lease expired). Nothing may be written. */
export class LeaseLostError extends Error {
  constructor(message = 'The lease on this run was lost') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

/** The configuration changed between the authoritative read and the final persistence: the solved problem is stale. */
export class ConfigurationChangedError extends Error {
  constructor(message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ConfigurationChangedError';
  }
}

/** The candidate failed re-validation against the fresh problem (a defect, never expected). */
export class CandidateRejectedError extends Error {
  constructor(message: string, public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CandidateRejectedError';
  }
}

/** The year already holds the maximum number of drafts (Phase 7F-0). Nothing is persisted; the run FAILS with DRAFT_LIMIT_REACHED. */
export class DraftLimitReachedError extends Error {
  constructor(public readonly drafts: number, public readonly max: number) {
    super(`The academic year already has ${drafts} draft timetable versions (the maximum is ${max}). Delete or publish a draft, then generate again`);
    this.name = 'DraftLimitReachedError';
  }
}

export interface PersistParams {
  prisma: PrismaClient;
  run: { id: string; schoolId: string; academicYearId: string; requestedById: string | null };
  /** The claim's token: the fencing identity of this worker for this attempt. */
  token: string;
  /** The problem that was solved. Its inputHash is what the data must still match. */
  problem: NormalizedProblem;
  entries: readonly TimetableEntryRow[];
  /**
   * Phase 7E: the locks frozen for this run. The fresh configuration is normalized WITH them (so the input hash is comparable), and the
   * persisted lessons they pin are written isLocked = true with their original source. Absent without locks: nothing changes.
   */
  lockedEntries?: readonly FrozenLock[];
  version: {
    solutionSource: SolutionSource;
    solverStatus: SolverStatus;
    weightsVersion: string;
    metrics: TimetableMetrics;
    /** The baseline's metrics, or an explicit marker that no valid baseline existed (only with locks). Never invented numbers. */
    baselineMetrics: TimetableMetrics | { available: false; reason: string };
    solverDiagnostics: unknown | null;
  };
  /** Stored on the run as resultSummary, plus the version id and number. */
  resultSummary: Record<string, unknown>;
  lockTimeoutSeconds: number;
  /** Phase 7F-0: the per-year draft cap (MAX_DRAFTS_PER_YEAR). Defaults to 20: the safety net is never off. */
  maxDraftsPerYear?: number;
  /** Phase 7F-0: the run's frozen period times (captured once from its first attempt) and when. Absent: the version stores none. */
  periodTimes?: { times: readonly PeriodTime[]; capturedAt: Date };
  /** Test seams (production passes none). */
  hooks?: {
    /** Called at the start of every attempt (1-based); may throw to simulate a transient database error. */
    onAttempt?: (attempt: number) => Promise<void> | void;
    /** Called inside the transaction right after the locks are taken. */
    afterLocks?: () => Promise<void> | void;
    /** Called inside the transaction after the draft-slot lock and count (nothing is written yet). */
    afterDraftSlotLock?: () => Promise<void> | void;
    /** Called inside the transaction after everything is written, before it commits. */
    beforeCommit?: () => Promise<void> | void;
  };
}

export interface PersistedVersion {
  versionId: string;
  versionNumber: number;
  entryCount: number;
}

const ENTRY_CHUNK = 2_000;

async function lockDependencies(tx: Prisma.TransactionClient, run: PersistParams['run'], problem: NormalizedProblem): Promise<void> {
  const teacherIds = [...new Set(problem.core.assignments.map((a) => a.teacherId))].sort();
  const subjectIds = [...new Set(problem.core.assignments.map((a) => a.subjectId))].sort();
  const assignmentIds = problem.core.assignments.map((a) => a.id).sort();
  const requirementIds = [...new Set(problem.core.assignments.map((a) => a.subjectRequirementId))].sort();
  const year = run.academicYearId;

  await tx.$queryRaw`SELECT "id" FROM "academic_years" WHERE "id" = ${year} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "schedule_configs" WHERE "academicYearId" = ${year} FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "grades" WHERE "academicYearId" = ${year} ORDER BY "id" FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "teachers" WHERE "id" = ANY(${teacherIds}) ORDER BY "id" FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "teacher_subjects" WHERE "teacherId" = ANY(${teacherIds}) AND "subjectId" = ANY(${subjectIds}) ORDER BY "id" FOR SHARE`;
  await tx.$queryRaw`
    SELECT tsg."id" FROM "teacher_subject_grades" tsg
    JOIN "teacher_subjects" ts ON ts."id" = tsg."teacherSubjectId"
    JOIN "grades" g ON g."id" = tsg."gradeId"
    WHERE ts."teacherId" = ANY(${teacherIds}) AND ts."subjectId" = ANY(${subjectIds}) AND g."academicYearId" = ${year}
    ORDER BY tsg."id" FOR SHARE OF tsg`;
  await tx.$queryRaw`SELECT "id" FROM "section_subject_teachers" WHERE "id" = ANY(${assignmentIds}) ORDER BY "id" FOR SHARE`;
  await tx.$queryRaw`SELECT "id" FROM "subject_requirements" WHERE "id" = ANY(${requirementIds}) ORDER BY "id" FOR SHARE`;
}

/** One attempt of the final transaction. Throws LeaseLostError, ConfigurationChangedError, CandidateRejectedError or a database error. */
export async function persistGeneratedVersionOnce(params: PersistParams): Promise<PersistedVersion> {
  const { prisma, run, token, problem, entries, version, hooks } = params;
  const lockTimeout = Math.max(1, Math.floor(params.lockTimeoutSeconds));

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${lockTimeout}s'`);

      // 1. fence
      const owned = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "timetable_generation_runs"
        WHERE "id" = ${run.id} AND "leaseOwner" = ${token} AND "status" = 'RUNNING'::"TimetableRunStatus" AND "leaseExpiresAt" > now()
        FOR UPDATE`;
      if (owned.length !== 1) throw new LeaseLostError('The run is no longer owned by this worker (or its lease expired)');

      // 2. lock everything the solved problem depends on
      await lockDependencies(tx, run, problem);
      await hooks?.afterLocks?.();

      // 3. re-read under the locks
      let snapshot;
      try {
        snapshot = await readGenerationSnapshot(tx, run.schoolId, run.academicYearId);
      } catch (error) {
        if (error instanceof SnapshotError) throw new ConfigurationChangedError(error.message, { code: error.code });
        throw error;
      }

      // 4. still DRAFT, still valid, still the identical problem
      if (snapshot.academicYear.status !== 'DRAFT') {
        throw new ConfigurationChangedError(`The academic year is no longer DRAFT (it is ${snapshot.academicYear.status})`, { status: snapshot.academicYear.status });
      }
      const fresh = normalizeProblem(snapshot, { lockedEntries: params.lockedEntries });
      if (!fresh.ok) {
        throw new ConfigurationChangedError('The configuration no longer satisfies the generation preconditions', {
          issues: fresh.issues.slice(0, 20).map((i) => ({ code: i.code, message: i.message })),
        });
      }
      if (fresh.problem.inputHash !== problem.inputHash) {
        throw new ConfigurationChangedError('The scheduling configuration changed while the timetable was being generated', {
          solvedInputHash: problem.inputHash,
          currentInputHash: fresh.problem.inputHash,
        });
      }

      // 5. the candidate must be valid against the FRESH problem
      const validation = validateEntries(fresh.problem, entries);
      if (!validation.valid) {
        throw new CandidateRejectedError(`The selected timetable failed re-validation (${validation.problemCount} problems)`, { problems: validation.problems.slice(0, 10) });
      }

      // 6. the draft cap, under the year's draft-slot lock (lock and count are separate statements; see timetable-generation.draft-slots.ts)
      const maxDrafts = params.maxDraftsPerYear ?? DEFAULT_MAX_DRAFTS_PER_YEAR;
      const claim = await claimDraftSlot(tx, run.academicYearId, maxDrafts, 'PERSIST');
      if (!claim.ok) throw new DraftLimitReachedError(claim.slots.drafts, maxDrafts);
      await hooks?.afterDraftSlotLock?.();
      if (params.periodTimes && !periodTimesMatchGrid(params.periodTimes.times, fresh.problem.derived.periodsPerDay)) {
        throw new ConfigurationChangedError('The schedule periods changed since this run captured its period times', { periodsPerDay: fresh.problem.derived.periodsPerDay, capturedPeriods: params.periodTimes.times.length });
      }

      // 7. write: a NEW version, its entries, the run
      const requirementOfAssignment = new Map(fresh.problem.core.assignments.map((a) => [a.id, a.subjectRequirementId]));
      const max = await tx.$queryRaw<Array<{ n: number | null }>>`SELECT max("versionNumber")::int AS n FROM "timetable_versions" WHERE "academicYearId" = ${run.academicYearId}`;
      const versionNumber = (max[0]?.n ?? 0) + 1;
      const created = await tx.timetableVersion.create({
        data: {
          schoolId: run.schoolId,
          academicYearId: run.academicYearId,
          versionNumber,
          status: 'DRAFT',
          solutionSource: version.solutionSource,
          solverStatus: version.solverStatus,
          weightsVersion: version.weightsVersion,
          inputHash: problem.inputHash,
          inputSnapshot: fresh.problem.core as unknown as Prisma.InputJsonValue,
          metrics: version.metrics as unknown as Prisma.InputJsonValue,
          baselineMetrics: version.baselineMetrics as unknown as Prisma.InputJsonValue,
          solverDiagnostics: (version.solverDiagnostics ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          createdById: run.requestedById,
          ...(params.periodTimes
            ? { periodTimes: params.periodTimes.times as unknown as Prisma.InputJsonValue, periodTimesCapturedAt: params.periodTimes.capturedAt }
            : {}),
        },
        select: { id: true },
      });

      // Phase 7E: a lesson pinned by a lock keeps its lock and its original source in the new version
      const lockOf = new Map((params.lockedEntries ?? []).map((l) => [`${l.assignmentId}|${l.dayOfWeek}|${l.periodNumber}`, l]));
      const rows = entries.map((e) => {
        const lock = lockOf.get(`${e.assignmentId}|${e.dayOfWeek}|${e.periodNumber}`);
        return {
          versionId: created.id,
          sectionId: e.sectionId,
          subjectId: e.subjectId,
          teacherId: e.teacherId,
          subjectRequirementId: requirementOfAssignment.get(e.assignmentId)!,
          dayOfWeek: e.dayOfWeek,
          periodNumber: e.periodNumber,
          ...(lock ? { isLocked: true, source: lock.source } : {}),
        };
      });
      if (rows.filter((r) => 'isLocked' in r).length !== (params.lockedEntries ?? []).length) {
        throw new CandidateRejectedError('A locked lesson is missing from the selected timetable', { expectedLocks: (params.lockedEntries ?? []).length });
      }
      for (let i = 0; i < rows.length; i += ENTRY_CHUNK) {
        await tx.timetableEntry.createMany({ data: rows.slice(i, i + ENTRY_CHUNK) as never });
      }
      const stored = await tx.timetableEntry.count({ where: { versionId: created.id } });
      if (stored !== fresh.problem.derived.expectedEntryCount || stored !== entries.length) {
        throw new CandidateRejectedError(`Stored ${stored} entries but ${fresh.problem.derived.expectedEntryCount} were expected`);
      }

      const summary = { ...params.resultSummary, versionId: created.id, versionNumber, entryCount: stored };
      const updated = await tx.$executeRaw`
        UPDATE "timetable_generation_runs"
        SET "status" = 'SUCCEEDED'::"TimetableRunStatus", "versionId" = ${created.id}, "resultSummary" = ${JSON.stringify(summary)}::jsonb,
            "phase" = 'DONE', "leaseExpiresAt" = NULL, "finishedAt" = now(), "updatedAt" = now()
        WHERE "id" = ${run.id} AND "leaseOwner" = ${token} AND "status" = 'RUNNING'::"TimetableRunStatus"`;
      if (updated !== 1) throw new LeaseLostError('The run could not be marked SUCCEEDED (ownership lost)');

      await hooks?.beforeCommit?.();
      return { versionId: created.id, versionNumber, entryCount: stored };
    },
    { maxWait: 15_000, timeout: 90_000 }
  );
}

// ---------------------------------------------------------------------------
// Transient database errors: worth retrying because the solve is expensive and the failure is not about the data.
// ---------------------------------------------------------------------------
const TRANSIENT_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);
const TRANSIENT_SQLSTATES = ['40001', '40P01', '55P03', '57P01', '53300', '08000', '08001', '08003', '08006'];
const TRANSIENT_TEXT = /connection terminated|ECONNRESET|ETIMEDOUT|timeout|Server has closed the connection|too many connections|lock timeout|deadlock|could not serialize|terminating connection/i;

export function isTransientDbError(error: unknown): boolean {
  if (error instanceof LeaseLostError || error instanceof ConfigurationChangedError || error instanceof CandidateRejectedError || error instanceof DraftLimitReachedError) return false;
  const e = error as { code?: string; message?: string; meta?: unknown };
  if (e.code !== undefined && TRANSIENT_PRISMA_CODES.has(e.code)) return true;
  const blob = `${e.message ?? ''} ${JSON.stringify(e.meta ?? {})}`;
  if (TRANSIENT_SQLSTATES.some((state) => blob.includes(`"${state}"`) || blob.includes(`\`${state}\``) || blob.includes(`Code: ${state}`))) return true;
  return TRANSIENT_TEXT.test(blob);
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number[];
}

/** The final transaction with bounded retries on transient database errors only. Every retry re-checks the fence. */
export async function persistGeneratedVersion(params: PersistParams, policy: RetryPolicy, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<PersistedVersion & { attempts: number }> {
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await params.hooks?.onAttempt?.(attempt);
      const result = await persistGeneratedVersionOnce(params);
      return { ...result, attempts: attempt };
    } catch (error) {
      if (attempt > policy.maxRetries || !isTransientDbError(error)) throw error;
      await sleep(policy.backoffMs[Math.min(attempt - 1, policy.backoffMs.length - 1)] ?? 250);
    }
  }
}
