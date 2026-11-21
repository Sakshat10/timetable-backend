import { randomInt } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { analyzeFeasibility } from '../timetable-feasibility/timetable-feasibility.analyzer.js';
import { loadSchedulingInput } from '../timetable-feasibility/timetable-feasibility.loader.js';
import { freezeLocks, LOCK_ISSUE_CODES, type FrozenLock, type LockIssue } from './timetable-generation.locks.js';
import { normalizeProblem } from './timetable-generation.normalizer.js';
import { RunRepository, type RunRecord } from './timetable-generation.run-repository.js';
import { resolveRunnerConfig, type RunnerConfig } from './timetable-generation.runner-config.js';
import { parseTimePolicy, resolveTimeLimitSeconds, type TimeLimitPolicy } from './timetable-generation.time-policy.js';
import { triggerGenerationRunner } from './timetable-generation.runner-handle.js';
import { toRunView, type GenerationRunView, type StartGenerationInput } from './timetable-generation.schema.js';

/** An error that carries a structured `data` payload next to the standard envelope (NOT_READY report, existing run id). */
export class AppErrorWithData extends AppError {
  constructor(statusCode: number, message: string, public readonly data: unknown, public readonly headers: Record<string, string> = {}) {
    super(statusCode, message);
    this.name = 'AppErrorWithData';
  }
}

export interface AcceptedGeneration {
  generationRunId: string;
  academicYearId: string;
  status: RunRecord['status'];
  seed: number;
  reproducible: boolean;
  timeLimitSeconds: number;
  sectionCount: number;
  /** Only for a generation started from a source draft (Phase 7E). */
  sourceVersionId?: string;
  lockedEntryCount?: number;
}

export interface GenerationServiceDeps {
  prisma?: PrismaClient;
  env?: Record<string, string | undefined>;
  /** Called after the run is queued. Defaults to hinting the runner registered by server.ts. */
  trigger?: () => void;
}

/**
 * The thin API layer over the Phase 5 queue. It never solves anything: it checks, inserts a QUEUED row and hints the runner.
 * The authoritative checks (fresh snapshot, feasibility, input hash, locked persistence) stay in the runner.
 */
export class TimetableGenerationService {
  private readonly db: PrismaClient;
  private readonly repo: RunRepository;
  private readonly env: Record<string, string | undefined>;
  private readonly trigger: () => void;
  private runnerConfig: RunnerConfig | null = null;
  private policy: TimeLimitPolicy | null = null;

  constructor(deps: GenerationServiceDeps = {}) {
    this.db = deps.prisma ?? prisma;
    this.repo = new RunRepository(this.db);
    this.env = deps.env ?? process.env;
    this.trigger = deps.trigger ?? ((): void => void triggerGenerationRunner());
  }

  /** Read per call (cheap): the limits stored on a run always describe the configuration in force when it was queued. */
  private config(): { runner: RunnerConfig; policy: TimeLimitPolicy } {
    return { runner: resolveRunnerConfig(this.env).config, policy: parseTimePolicy(this.env) };
  }

  /**
   * Phase 7E: freeze the locks of a source draft. The version and its locked entries are read in ONE REPEATABLE READ transaction (a
   * consistent view, no row locks, so an admin editing the draft is never blocked). The result is what the run will use: the source
   * version is never read again, so editing, unlocking or deleting it after this point cannot change the queued run.
   * Refusals: 404 unknown, 403 another school's, 400 another academic year's, 409 not a DRAFT, 400 LOCKS_INVALID.
   */
  private async freezeFromSource(
    schoolId: string,
    academicYearId: string,
    sourceVersionId: string,
    problem: Awaited<ReturnType<typeof loadSchedulingInput>>
  ): Promise<FrozenLock[]> {
    const loaded = await this.db.$transaction(
      async (tx) => {
        const version = await tx.timetableVersion.findUnique({ where: { id: sourceVersionId }, select: { schoolId: true, academicYearId: true, status: true } });
        if (!version || version.schoolId !== schoolId || version.academicYearId !== academicYearId || version.status !== 'DRAFT') return { version, entries: [] };
        const entries = await tx.timetableEntry.findMany({
          where: { versionId: sourceVersionId, isLocked: true },
          select: { id: true, sectionId: true, subjectRequirementId: true, teacherId: true, dayOfWeek: true, periodNumber: true, source: true },
        });
        return { version, entries };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 30_000 }
    );
    const { version } = loaded;
    if (!version) throw new AppErrorWithData(404, 'Source timetable version not found', { code: 'SOURCE_VERSION_NOT_FOUND' });
    if (version.schoolId !== schoolId) throw new AppErrorWithData(403, 'You do not have access to this timetable version', { code: 'SOURCE_VERSION_FORBIDDEN' });
    if (version.academicYearId !== academicYearId) throw new AppErrorWithData(400, 'The source timetable version belongs to a different academic year', { code: 'SOURCE_VERSION_WRONG_YEAR' });
    if (version.status !== 'DRAFT') throw new AppErrorWithData(409, `Only a DRAFT timetable version can be the source of a regeneration (this one is ${version.status.toLowerCase()})`, { code: 'SOURCE_VERSION_NOT_DRAFT', status: version.status });

    const lockIssues = (issues: LockIssue[] | Array<{ code: string; message: string; entity?: unknown; details?: unknown }>) =>
      new AppErrorWithData(400, 'The locked lessons of the source timetable do not fit the current configuration', {
        code: 'LOCKS_INVALID',
        issueCount: issues.length,
        issues: issues.slice(0, 50).map((i) => ({ code: i.code, message: i.message, entity: i.entity, details: i.details })),
      });

    // Locks are resolved against the assignments the SOLVER problem will contain: explicit ones AND the automatically chosen ones (which
    // exist only inside the normalized problem), so lessons of automatically assigned teachers can be locked and regenerated around.
    const base = normalizeProblem({ ...problem, timingEvents: [] });
    if (!base.ok) {
      throw new AppErrorWithData(400, 'The academic year is not ready for timetable generation', { code: 'NOT_READY', issues: base.issues.slice(0, 20).map((i) => ({ code: i.code, message: i.message })) });
    }
    const frozen = freezeLocks(loaded.entries, base.problem.core.assignments);
    if (frozen.issues.length > 0) throw lockIssues(frozen.issues);
    if (frozen.locks.length === 0) return [];

    // The early, cheap check (the run validates again, authoritatively, against its own fresh snapshot). It uses the data this request
    // already loaded; the timing events only decide which periods may form a run, which no lock depends on.
    const preflight = normalizeProblem({ ...problem, timingEvents: [] }, { lockedEntries: frozen.locks });
    if (!preflight.ok) {
      const onlyLocks = preflight.issues.every((i) => (LOCK_ISSUE_CODES as readonly string[]).includes(i.code));
      if (onlyLocks) throw lockIssues(preflight.issues);
      throw new AppErrorWithData(400, 'The academic year is not ready for timetable generation', { code: 'NOT_READY', issues: preflight.issues.slice(0, 20).map((i) => ({ code: i.code, message: i.message })) });
    }
    return frozen.locks;
  }

  /**
   * POST /timetable-generations. Quick preflight only (ownership, DRAFT, Module 10 readiness), then a QUEUED run.
   * Errors: 404 unknown year, 403 foreign year, 400 not DRAFT / NOT_READY, 409 already active, 503 queue full.
   */
  async start(admin: { id: string; schoolId: string }, input: StartGenerationInput): Promise<AcceptedGeneration> {
    const problem = await loadSchedulingInput(admin.schoolId, input.academicYearId); // 404 / 403 live here

    if (problem.academicYear.status !== 'DRAFT') {
      throw new AppError(400, 'A timetable can only be generated for an academic year in DRAFT status');
    }

    const report = analyzeFeasibility(problem);
    if (report.status !== 'READY') {
      throw new AppErrorWithData(400, 'The academic year is not ready for timetable generation', {
        status: report.status,
        summary: report.summary,
        errorCount: report.errors.length,
        errors: report.errors.slice(0, 50),
        warnings: report.warnings.slice(0, 20),
      });
    }

    // Phase 7E: locks frozen from a source draft (absent: exactly the behaviour this endpoint always had)
    const sourceVersionId = input.options?.sourceVersionId;
    const lockedEntries = sourceVersionId === undefined ? undefined : await this.freezeFromSource(admin.schoolId, input.academicYearId, sourceVersionId, problem);

    const { runner, policy } = this.config();
    const sectionCount = problem.sections.length;
    const seed = input.options?.seed ?? randomInt(0, 2_147_483_648);
    const reproducible = input.options?.reproducible ?? false;
    const timeLimitSeconds = resolveTimeLimitSeconds(sectionCount, policy);

    const queued = await this.repo.enqueue(
      {
        schoolId: admin.schoolId,
        academicYearId: input.academicYearId,
        requestedById: admin.id,
        options: { seed, reproducible, ...(sourceVersionId !== undefined ? { sourceVersionId, lockedEntries: lockedEntries ?? [] } : {}) },
        timeLimitSeconds,
        workers: runner.workers,
        sectionCount,
      },
      runner.queueMax,
      runner.maxDraftsPerYear
    );

    if (!queued.ok) {
      if (queued.reason === 'ALREADY_ACTIVE') {
        // The year was verified to be this school's above, so its active run is this school's too.
        throw new AppErrorWithData(409, 'A timetable generation is already queued or running for this academic year', { existingRunId: queued.existingRunId });
      }
      if (queued.reason === 'DRAFT_LIMIT_REACHED') {
        throw new AppErrorWithData(409, `This academic year already has ${queued.drafts} draft timetable versions (the maximum is ${queued.max}). Delete or publish a draft, then try again`, {
          code: 'DRAFT_LIMIT_REACHED',
          drafts: queued.drafts,
          maxDraftsPerYear: queued.max,
        });
      }
      if (queued.reason === 'BUSY') {
        throw new AppErrorWithData(503, 'The academic year is being modified by another operation. Please retry in a moment', { code: 'BUSY' }, { 'Retry-After': '2' });
      }
      // No counts: the queue is shared by every school, so its size is not this admin's business.
      throw new AppErrorWithData(503, 'The timetable generation queue is full. Please try again shortly', null, { 'Retry-After': '30' });
    }

    this.trigger();
    return {
      generationRunId: queued.run.id, academicYearId: queued.run.academicYearId, status: queued.run.status, seed, reproducible, timeLimitSeconds, sectionCount,
      ...(sourceVersionId !== undefined ? { sourceVersionId, lockedEntryCount: (lockedEntries ?? []).length } : {}),
    };
  }

  /** GET /timetable-generations/:id. 404 unknown, 403 another school's run. */
  async get(schoolId: string, id: string): Promise<GenerationRunView> {
    const run = await this.db.timetableGenerationRun.findUnique({ where: { id } });
    if (!run) throw new AppError(404, 'Timetable generation not found');
    if (run.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this timetable generation');
    return toRunView(run as unknown as RunRecord);
  }

  /** GET /timetable-generations?academicYearId=. Newest first. 404 unknown year, 403 another school's year. */
  async list(schoolId: string, academicYearId: string, limit: number): Promise<GenerationRunView[]> {
    const year = await this.db.academicYear.findUnique({ where: { id: academicYearId }, select: { schoolId: true } });
    if (!year) throw new AppError(404, 'Academic year not found');
    if (year.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this academic year');
    const runs = await this.db.timetableGenerationRun.findMany({
      where: { schoolId, academicYearId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return runs.map((run) => toRunView(run as unknown as RunRecord));
  }
}

export const timetableGenerationService = new TimetableGenerationService();
