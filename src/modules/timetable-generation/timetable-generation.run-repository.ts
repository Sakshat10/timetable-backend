import { Prisma, type PrismaClient } from '@prisma/client';
import { type FailureCode } from './timetable-generation.contracts.js';
import { type FrozenLock } from './timetable-generation.locks.js';
import { claimDraftSlot, DEFAULT_MAX_DRAFTS_PER_YEAR } from './timetable-generation.draft-slots.js';
import { type PeriodTime } from './timetable-generation.period-times.js';

// ---------------------------------------------------------------------------
// The run queue, in PostgreSQL. The database is the single source of truth: no in-memory queue exists.
//
//  * CLAIM is one atomic UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1): two workers can never
//    claim the same run, and a worker never blocks on a row another worker is claiming.
//  * Every lease decision uses the DATABASE clock (now()), never the clock of the machine running the worker, so skew
//    between machines cannot break fencing.
//  * Every write a worker makes after the claim is FENCED: it carries `leaseOwner = <the claim's token>` and
//    `status = 'RUNNING'`. A worker whose lease was lost (the run was requeued, failed or re-claimed) updates zero rows
//    and learns it has lost ownership; it can never overwrite a newer attempt.
//  * `attempts` counts claims. A lost attempt is requeued while attempts < maxAttempts and failed WORKER_LOST afterwards,
//    so a run can never loop forever.
// ---------------------------------------------------------------------------

export interface RunRecord {
  id: string;
  schoolId: string;
  academicYearId: string;
  requestedById: string | null;
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  phase: string | null;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  heartbeatAt: Date | null;
  options: unknown;
  timeLimitSeconds: number;
  workers: number;
  sectionCount: number;
  inputHash: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  failureDiagnostics: unknown;
  versionId: string | null;
  resultSummary: unknown;
  /** Phase 7F-0: captured once from the first attempt's snapshot (see freezePeriodTimes). */
  periodTimes: unknown;
  periodTimesCapturedAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

export interface EnqueueInput {
  schoolId: string;
  academicYearId: string;
  requestedById: string | null;
  /**
   * {seed, reproducible}: the per-run options the caller may choose. Phase 7E adds, ONLY for a run started from a source draft:
   * the locks frozen at POST time and the source version id (provenance). They are stored as JSON with the rest; no column changes.
   */
  options: { seed: number; reproducible: boolean; sourceVersionId?: string; lockedEntries?: readonly FrozenLock[] };
  timeLimitSeconds: number;
  workers: number;
  sectionCount: number;
}

export type EnqueueResult =
  | { ok: true; run: RunRecord }
  | { ok: false; reason: 'ALREADY_ACTIVE'; existingRunId: string | null }
  | { ok: false; reason: 'QUEUE_FULL'; active: number; max: number }
  /** Phase 7F-0: the year already holds `drafts` >= `max` DRAFT versions. */
  | { ok: false; reason: 'DRAFT_LIMIT_REACHED'; drafts: number; max: number }
  /** A lock wait exceeded the lock timeout (a concurrent edit, publish or persist of the same year): retry shortly. */
  | { ok: false; reason: 'BUSY' };

const jsonParam = (value: unknown): Prisma.Sql => Prisma.sql`${JSON.stringify(value)}::jsonb`;

/** Constant key of the transaction-level advisory lock that serialises the queue-size check (safe with the pooler). */
const ENQUEUE_LOCK_KEY = 7_411_001;
/** Bounds every lock wait inside enqueue (year row, draft-slot, queue-size): a concurrent persist or edit of the same year may hold them briefly. */
const ENQUEUE_LOCK_TIMEOUT_SECONDS = 10;

/** PostgreSQL 55P03 (lock_not_available), however Prisma wraps it. */
export function isLockTimeout(error: unknown): boolean {
  const e = error as { code?: string; message?: string; meta?: unknown };
  const blob = `${e?.message ?? ''} ${JSON.stringify(e?.meta ?? {})}`;
  return blob.includes('55P03') || /lock timeout|canceling statement due to lock timeout/i.test(blob);
}

export class RunRepository {
  constructor(private readonly prisma: PrismaClient) {}

  // ---- enqueue ------------------------------------------------------------------------------------------------
  /**
   * Insert a QUEUED run. Lock order (Phase 7F-0), every lock bounded by lock_timeout:
   *   1. the academic year row FOR UPDATE   (the same first lock as every other creator; serialises with persist, publish, edits)
   *   2. the year's draft-slot advisory lock (serialises the creators of drafts and reservations of this year)
   *   3. the global queue-size advisory lock (so two requests cannot both slip under the queue limit); never held while waiting for 1 or 2
   * then the queue-size check, the draft cap check (drafts >= cap refuses), and the insert. "One active run per academic year" is NOT
   * checked here: PostgreSQL's partial unique index decides, and its violation is reported as ALREADY_ACTIVE.
   */
  async enqueue(input: EnqueueInput, queueMax: number, maxDraftsPerYear: number = DEFAULT_MAX_DRAFTS_PER_YEAR): Promise<EnqueueResult> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${ENQUEUE_LOCK_TIMEOUT_SECONDS}s'`);
          await tx.$queryRaw`SELECT "id" FROM "academic_years" WHERE "id" = ${input.academicYearId} FOR UPDATE`;
          const claim = await claimDraftSlot(tx, input.academicYearId, maxDraftsPerYear, 'ENQUEUE');
          if (!claim.ok) return { ok: false as const, reason: 'DRAFT_LIMIT_REACHED' as const, drafts: claim.slots.drafts, max: maxDraftsPerYear };
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ENQUEUE_LOCK_KEY})`;
          const active = Number((await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "timetable_generation_runs" WHERE "status" IN ('QUEUED', 'RUNNING')`)[0]!.n);
          if (active >= queueMax) return { ok: false as const, reason: 'QUEUE_FULL' as const, active, max: queueMax };
          const run = await tx.timetableGenerationRun.create({
            data: {
              schoolId: input.schoolId,
              academicYearId: input.academicYearId,
              requestedById: input.requestedById,
              options: input.options,
              timeLimitSeconds: input.timeLimitSeconds,
              workers: input.workers,
              sectionCount: input.sectionCount,
            },
          });
          return { ok: true as const, run: run as unknown as RunRecord };
        },
        { maxWait: 10_000, timeout: 30_000 }
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.timetableGenerationRun.findFirst({
          where: { academicYearId: input.academicYearId, status: { in: ['QUEUED', 'RUNNING'] } },
          select: { id: true },
        });
        return { ok: false, reason: 'ALREADY_ACTIVE', existingRunId: existing?.id ?? null };
      }
      if (isLockTimeout(error)) return { ok: false, reason: 'BUSY' };
      throw error;
    }
  }

  // ---- period times (Phase 7F-0) ---------------------------------------------------------------------------------
  /**
   * Freeze the run's period times: write-ONCE, fenced by the claim token. The first attempt stores the times it read; any later call (a
   * recovered attempt, a retry) leaves the stored value alone and gets it back. Returns null when the lease is lost (nothing is written then).
   */
  async freezePeriodTimes(runId: string, token: string, times: readonly PeriodTime[]): Promise<{ periodTimes: unknown; capturedAt: Date; reused: boolean } | null> {
    const written = await this.prisma.$queryRaw<Array<{ periodTimesCapturedAt: Date }>>`
      UPDATE "timetable_generation_runs"
      SET "periodTimes" = ${jsonParam(times)}, "periodTimesCapturedAt" = now(), "updatedAt" = now()
      WHERE "id" = ${runId} AND "leaseOwner" = ${token} AND "status" = 'RUNNING'::"TimetableRunStatus" AND "periodTimes" IS NULL
      RETURNING "periodTimesCapturedAt"`;
    if (written[0]) return { periodTimes: times, capturedAt: written[0].periodTimesCapturedAt, reused: false };
    const current = await this.prisma.$queryRaw<Array<{ periodTimes: unknown; periodTimesCapturedAt: Date | null }>>`
      SELECT "periodTimes", "periodTimesCapturedAt" FROM "timetable_generation_runs"
      WHERE "id" = ${runId} AND "leaseOwner" = ${token} AND "status" = 'RUNNING'::"TimetableRunStatus"`;
    const row = current[0];
    if (!row || row.periodTimes === null || row.periodTimesCapturedAt === null) return null;
    return { periodTimes: row.periodTimes, capturedAt: row.periodTimesCapturedAt, reused: true };
  }

  // ---- claim --------------------------------------------------------------------------------------------------
  /** Atomically claim the oldest QUEUED run for `token`. Returns null when nothing is queued (or all queued rows are being claimed). */
  async claimNext(token: string, leaseSeconds: number): Promise<RunRecord | null> {
    const rows = await this.prisma.$queryRaw<RunRecord[]>`
      UPDATE "timetable_generation_runs" AS r
      SET "status" = 'RUNNING'::"TimetableRunStatus",
          "leaseOwner" = ${token},
          "leaseExpiresAt" = now() + (${leaseSeconds}::int * interval '1 second'),
          "heartbeatAt" = now(),
          "startedAt" = coalesce(r."startedAt", now()),
          "attempts" = r."attempts" + 1,
          "phase" = 'CLAIMED',
          "updatedAt" = now()
      WHERE r."id" = (
        SELECT q."id" FROM "timetable_generation_runs" AS q
        WHERE q."status" = 'QUEUED'::"TimetableRunStatus"
        ORDER BY q."createdAt" ASC, q."id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING r.*`;
    return rows[0] ?? null;
  }

  // ---- fenced writes ------------------------------------------------------------------------------------------
  /** Extend the lease. True only while `token` still owns the RUNNING run. */
  async heartbeat(runId: string, token: string, leaseSeconds: number): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "timetable_generation_runs"
      SET "heartbeatAt" = now(), "leaseExpiresAt" = now() + (${leaseSeconds}::int * interval '1 second'), "updatedAt" = now()
      WHERE "id" = ${runId} AND "leaseOwner" = ${token} AND "status" = 'RUNNING'::"TimetableRunStatus"`;
    return n === 1;
  }

  /** Record the current phase (and optionally audit fields). False when the lease is lost or has expired. */
  async setPhase(runId: string, token: string, phase: string, extra: { inputHash?: string; sectionCount?: number; timeLimitSeconds?: number } = {}): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "timetable_generation_runs"
      SET "phase" = ${phase},
          "inputHash" = coalesce(${extra.inputHash ?? null}, "inputHash"),
          "sectionCount" = coalesce(${extra.sectionCount ?? null}::int, "sectionCount"),
          "timeLimitSeconds" = coalesce(${extra.timeLimitSeconds ?? null}::int, "timeLimitSeconds"),
          "updatedAt" = now()
      WHERE "id" = ${runId} AND "leaseOwner" = ${token} AND "status" = 'RUNNING'::"TimetableRunStatus" AND "leaseExpiresAt" > now()`;
    return n === 1;
  }

  /** RUNNING -> FAILED. False when the lease was lost (nothing is written then). */
  async fail(
    runId: string,
    token: string,
    failure: { code: FailureCode; message: string; diagnostics: unknown; inputHash?: string | null }
  ): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "timetable_generation_runs"
      SET "status" = 'FAILED'::"TimetableRunStatus",
          "failureCode" = ${failure.code},
          "failureMessage" = ${failure.message.slice(0, 1000)},
          "failureDiagnostics" = coalesce("failureDiagnostics", '{}'::jsonb) || ${jsonParam(failure.diagnostics ?? {})},
          "inputHash" = coalesce(${failure.inputHash ?? null}, "inputHash"),
          "leaseExpiresAt" = NULL,
          "finishedAt" = now(),
          "updatedAt" = now()
      WHERE "id" = ${runId} AND "leaseOwner" = ${token} AND "status" = 'RUNNING'::"TimetableRunStatus"`;
    return n === 1;
  }

  /**
   * Graceful shutdown: RUNNING -> QUEUED without consuming an attempt (the claim's increment is taken back), so the work
   * is picked up again by the next runner. False when the lease was lost.
   */
  async requeueForShutdown(runId: string, token: string): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE "timetable_generation_runs"
      SET "status" = 'QUEUED'::"TimetableRunStatus", "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "phase" = NULL,
          "attempts" = greatest("attempts" - 1, 0), "updatedAt" = now()
      WHERE "id" = ${runId} AND "leaseOwner" = ${token} AND "status" = 'RUNNING'::"TimetableRunStatus"`;
    return n === 1;
  }

  // ---- recovery / expiry ----------------------------------------------------------------------------------------
  /**
   * Stale-lease recovery: a RUNNING run whose lease has expired (the worker or server died, or stopped heartbeating) is
   * requeued while attempts < maxAttempts and failed WORKER_LOST afterwards. Rows another sweeper is handling are skipped.
   */
  async recoverStale(maxAttempts: number): Promise<{ requeued: string[]; failed: string[] }> {
    const lost = Prisma.sql`jsonb_build_object('lostAttempts', coalesce("failureDiagnostics"->'lostAttempts', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'attempt', "attempts", 'phase', "phase", 'leaseOwner', "leaseOwner", 'lastHeartbeatAt', "heartbeatAt", 'leaseExpiredAt', "leaseExpiresAt", 'recoveredAt', now())))`;
    const failed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "timetable_generation_runs"
      SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'WORKER_LOST',
          "failureMessage" = 'The worker running this generation was lost on every attempt',
          "failureDiagnostics" = coalesce("failureDiagnostics", '{}'::jsonb) || ${lost},
          "leaseExpiresAt" = NULL, "finishedAt" = now(), "updatedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "timetable_generation_runs"
        WHERE "status" = 'RUNNING'::"TimetableRunStatus" AND "leaseExpiresAt" < now() AND "attempts" >= ${maxAttempts}::int
        FOR UPDATE SKIP LOCKED)
      RETURNING "id"`;
    const requeued = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "timetable_generation_runs"
      SET "status" = 'QUEUED'::"TimetableRunStatus", "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "heartbeatAt" = NULL, "phase" = NULL,
          "failureDiagnostics" = coalesce("failureDiagnostics", '{}'::jsonb) || ${lost}, "updatedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "timetable_generation_runs"
        WHERE "status" = 'RUNNING'::"TimetableRunStatus" AND "leaseExpiresAt" < now() AND "attempts" < ${maxAttempts}::int
        FOR UPDATE SKIP LOCKED)
      RETURNING "id"`;
    return { requeued: requeued.map((r) => r.id), failed: failed.map((r) => r.id) };
  }

  /** A run still QUEUED after the TTL is failed with QUEUE_EXPIRED and never executed. */
  async expireQueued(ttlMinutes: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "timetable_generation_runs"
      SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'QUEUE_EXPIRED',
          "failureMessage" = ${`The generation waited in the queue longer than ${ttlMinutes} minutes and was not started`},
          "failureDiagnostics" = coalesce("failureDiagnostics", '{}'::jsonb) || jsonb_build_object('queuedForSeconds', extract(epoch FROM (now() - "createdAt"))::int, 'ttlMinutes', ${ttlMinutes}::int),
          "finishedAt" = now(), "updatedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "timetable_generation_runs"
        WHERE "status" = 'QUEUED'::"TimetableRunStatus" AND "createdAt" < now() - (${ttlMinutes}::int * interval '1 minute')
        FOR UPDATE SKIP LOCKED)
      RETURNING "id"`;
    return rows.map((r) => r.id);
  }

  // ---- reads ----------------------------------------------------------------------------------------------------
  async get(runId: string): Promise<RunRecord | null> {
    return (await this.prisma.timetableGenerationRun.findUnique({ where: { id: runId } })) as unknown as RunRecord | null;
  }

  async activeCount(): Promise<number> {
    return Number((await this.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "timetable_generation_runs" WHERE "status" IN ('QUEUED', 'RUNNING')`)[0]!.n);
  }

  async queuedCount(): Promise<number> {
    return Number((await this.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "timetable_generation_runs" WHERE "status" = 'QUEUED'`)[0]!.n);
  }
}
