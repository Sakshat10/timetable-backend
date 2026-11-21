import { performance } from 'node:perf_hooks';
import { type PrismaClient } from '@prisma/client';
import { analyzeFeasibility } from '../timetable-feasibility/timetable-feasibility.analyzer.js';
import { buildBaseline } from './timetable-generation.baseline.js';
import { buildBaselineWithFixed } from './timetable-generation.baseline-locks.js';
import { WEIGHTS_V1, WEIGHTS_VERSION, type FailureCode, type SolverDiagnostics, type TimetableEntryRow } from './timetable-generation.contracts.js';
import { frozenLocksSchema, LOCK_ISSUE_CODES, type FrozenLock } from './timetable-generation.locks.js';
import {
  ConfigurationChangedError,
  CandidateRejectedError,
  DraftLimitReachedError,
  LeaseLostError,
  persistGeneratedVersion,
  type PersistParams,
} from './timetable-generation.final-persist.js';
import { loadGenerationSnapshotWithTimes, SnapshotError } from './timetable-generation.loader.js';
import { parseStoredPeriodTimes, periodTimesMatchGrid, type PeriodTime } from './timetable-generation.period-times.js';
import { evaluateMetrics, type TimetableMetrics } from './timetable-generation.metrics.js';
import { buildSolverInput, normalizeProblem } from './timetable-generation.normalizer.js';
import { decideOutcome, type SolverAttempt } from './timetable-generation.outcome.js';
import { type RunnerConfig } from './timetable-generation.runner-config.js';
import { type RunRecord, type RunRepository } from './timetable-generation.run-repository.js';
import { SolverAbortedError, type SolverClient, type SolverRunInfo } from './timetable-generation.solver-client.js';
import { buildSolverOptions, SolverRequestError } from './timetable-generation.solver-options.js';
import { DEFAULT_TIME_POLICY, type TimeLimitPolicy } from './timetable-generation.time-policy.js';
import { validateEntries } from './timetable-generation.validator.js';

// ---------------------------------------------------------------------------
// Orchestration of ONE claimed run:
//
//   fresh consistent snapshot -> year DRAFT? -> Module 10 feasibility (READY required) -> Phase 1 normalisation + input hash
//   -> TypeScript baseline (validated) -> SolverClient (remaining budget) -> interpret + decide (B / D4) -> validate ->
//   independent metrics -> final locked persistence -> SUCCEEDED.
//
// Rules this file enforces:
//   * nothing is trusted from enqueue time: the snapshot, the feasibility check and the hash are computed here, fresh;
//   * ONE budget clock starts when execution starts and covers snapshot, feasibility, normalisation, hashing, baseline,
//     the solver subprocess (which receives only the REMAINING budget), validation and persistence preparation;
//   * only a clean UNKNOWN and a watchdog kill may select the validated baseline; every process or output fault fails;
//   * every write is fenced by the claim token; a worker that lost its lease writes nothing and just stops;
//   * a shutdown requeues the run without consuming an attempt.
// ---------------------------------------------------------------------------

export type GenerationPhase = 'SNAPSHOT' | 'FEASIBILITY' | 'NORMALIZE' | 'BASELINE' | 'SOLVING' | 'VALIDATING' | 'METRICS' | 'PERSISTING';

export interface Logger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export const consoleLogger: Logger = {
  info: (f, m) => console.log(JSON.stringify({ level: 'info', msg: m, ...f })),
  warn: (f, m) => console.warn(JSON.stringify({ level: 'warn', msg: m, ...f })),
  error: (f, m) => console.error(JSON.stringify({ level: 'error', msg: m, ...f })),
};

export interface OrchestratorHooks {
  /** Test seam: called at every phase boundary after the lease check and before the phase's work. May mutate data or throw. */
  onPhase?: (phase: GenerationPhase, ctx: { runId: string; token: string; attempt: number }) => Promise<void> | void;
  /** Test seams of the final transaction. */
  persist?: PersistParams['hooks'];
}

export interface OrchestratorDeps {
  prisma: PrismaClient;
  repo: RunRepository;
  solverClient: SolverClient;
  config: RunnerConfig;
  policy?: TimeLimitPolicy;
  logger?: Logger;
  /** Monotonic milliseconds (injectable for tests). */
  now?: () => number;
  hooks?: OrchestratorHooks;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: the baseline builder (defaults to the Phase 1 implementation). */
  buildBaseline?: typeof buildBaseline;
  /** Test seam: the lock-aware baseline builder used only when the run has locked entries (Phase 7E). */
  buildBaselineWithFixed?: typeof buildBaselineWithFixed;
}

/** The lease as the orchestrator sees it. The signal is aborted with reason 'SHUTDOWN' or 'LEASE_LOST'. */
export interface LeaseHandle {
  signal: AbortSignal;
}

export type RunResult =
  | { kind: 'SUCCEEDED'; versionId: string; versionNumber: number; solutionSource: string; solverStatus: string }
  | { kind: 'FAILED'; code: FailureCode }
  | { kind: 'REQUEUED' }
  | { kind: 'ABANDONED'; reason: string };

class JobInterrupted extends Error {
  constructor(public readonly reason: 'SHUTDOWN' | 'LEASE_LOST') {
    super(`job interrupted: ${reason}`);
    this.name = 'JobInterrupted';
  }
}

class RunFailure extends Error {
  constructor(public readonly code: FailureCode, message: string, public readonly diagnostics: Record<string, unknown> = {}, public readonly inputHash: string | null = null) {
    super(message);
    this.name = 'RunFailure';
  }
}

/** Diagnostics that stay small however large the solver output was. */
function bounded(value: unknown, maxChars = 48_000): unknown {
  const text = JSON.stringify(value) ?? 'null';
  return text.length <= maxChars ? value : { truncated: true, originalChars: text.length, preview: text.slice(0, 2_000) };
}

function processInfo(info: SolverRunInfo | null): Record<string, unknown> | null {
  if (!info) return null;
  return {
    pid: info.pid, exitCode: info.exitCode, signal: info.signal, durationMs: info.durationMs, timeLimitSeconds: info.timeLimitSeconds,
    killGraceMs: info.killGraceMs, timeout: info.timeout, stdoutBytes: info.stdoutBytes, stderrBytes: info.stderrBytes,
    stderrTail: info.stderrTail.slice(-2_000), solverStatus: info.solverStatus, stoppedBy: info.stoppedBy, failureCode: info.failureCode,
    stdin: { bytes: info.stdin.bytes, written: info.stdin.written, error: info.stdin.error, closedByClient: info.stdin.closedByClient },
  };
}

function budgetExhaustedAttempt(budgetSeconds: number): SolverAttempt {
  const diagnostics: SolverDiagnostics = {
    objectiveValue: null, bestObjectiveBound: null, wallSeconds: 0, numWorkers: 0, seed: 0, ortoolsVersion: '', numBooleans: null,
    numConstraints: null, conflicts: null, branches: null, stoppedBy: 'TIME_LIMIT',
    messages: [`the ${budgetSeconds}s budget was spent before the solver could start`],
  };
  return { kind: 'NO_SOLUTION', diagnostics };
}

/** What a run's `baselineMetrics` holds when no valid baseline exists (only possible with locked entries). Never fabricated numbers. */
export interface BaselineMetricsUnavailable {
  available: false;
  reason: 'NO_LOCK_AWARE_BASELINE' | 'BASELINE_REJECTED';
}

interface RunOptions {
  seed: number;
  reproducible: boolean;
  /** Phase 7E: the locks frozen at POST time (never read from the source version again). Empty without locks. */
  lockedEntries: FrozenLock[];
  /** Provenance only: the draft the locks were taken from. */
  sourceVersionId: string | null;
}

function readRunOptions(run: RunRecord): RunOptions {
  const raw = (run.options ?? {}) as { seed?: unknown; reproducible?: unknown; lockedEntries?: unknown; sourceVersionId?: unknown };
  const seed = typeof raw.seed === 'number' && Number.isInteger(raw.seed) && raw.seed >= 0 && raw.seed <= 2_147_483_647 ? raw.seed : 1;
  let lockedEntries: FrozenLock[] = [];
  if (raw.lockedEntries !== undefined) {
    const parsed = frozenLocksSchema.safeParse(raw.lockedEntries);
    // written only by our own POST: unreadable frozen locks are a defect, never something to ignore (that would drop locks silently)
    if (!parsed.success) throw new RunFailure('INTERNAL_INCONSISTENCY', 'The locked entries stored with this run are unreadable', { issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) });
    lockedEntries = parsed.data;
  }
  return { seed, reproducible: raw.reproducible === true, lockedEntries, sourceVersionId: typeof raw.sourceVersionId === 'string' ? raw.sourceVersionId : null };
}

export async function executeRun(run: RunRecord, token: string, lease: LeaseHandle, deps: OrchestratorDeps): Promise<RunResult> {
  const { prisma, repo, solverClient, config, hooks } = deps;
  const policy = deps.policy ?? DEFAULT_TIME_POLICY;
  const log = deps.logger ?? consoleLogger;
  const clock = deps.now ?? ((): number => performance.now());
  const startedMs = clock();
  const ctx = { runId: run.id, token, attempt: run.attempts };
  let inputHash: string | null = null;

  const interruption = (): JobInterrupted => new JobInterrupted(lease.signal.reason === 'SHUTDOWN' ? 'SHUTDOWN' : 'LEASE_LOST');
  const throwIfInterrupted = (): void => {
    if (lease.signal.aborted) throw interruption();
  };
  const checkpoint = async (phase: GenerationPhase, extra: { inputHash?: string; sectionCount?: number; timeLimitSeconds?: number } = {}): Promise<void> => {
    throwIfInterrupted();
    await hooks?.onPhase?.(phase, ctx);
    throwIfInterrupted();
    if (!(await repo.setPhase(run.id, token, phase, extra))) throw new JobInterrupted('LEASE_LOST');
  };

  try {
    // ---- 1. authoritative snapshot ----------------------------------------------------------------------------------
    await checkpoint('SNAPSHOT');
    const { snapshot, periodTimes: snapshotPeriodTimes, periodTimesInvalid } = await loadGenerationSnapshotWithTimes(prisma, run.schoolId, run.academicYearId);
    if (snapshot.academicYear.status !== 'DRAFT') {
      throw new RunFailure('YEAR_NOT_DRAFT', `Timetable generation is only allowed for DRAFT academic years (this one is ${snapshot.academicYear.status})`, { status: snapshot.academicYear.status });
    }

    // ---- 2. Module 10 feasibility (reused, not duplicated) ----------------------------------------------------------
    await checkpoint('FEASIBILITY');
    const report = analyzeFeasibility(snapshot);
    if (report.status !== 'READY') {
      throw new RunFailure('NOT_READY', `The configuration is not ready for generation (${report.errors.length} blocking errors)`, {
        feasibility: bounded({
          status: report.status, summary: report.summary,
          errors: report.errors.slice(0, 25).map((e) => ({ code: e.code, message: e.message, hint: e.hint, entity: e.entity })),
          errorsOmitted: Math.max(0, report.errors.length - 25),
        }),
      });
    }

    // ---- 3. Phase 1 normalisation, input hash --------------------------------------------------------------------------
    await checkpoint('NORMALIZE');
    const options = readRunOptions(run);
    const normalized = normalizeProblem(snapshot, { lockedEntries: options.lockedEntries });
    if (!normalized.ok) {
      const onlyYear = normalized.issues.every((i) => i.code === 'YEAR_NOT_DRAFT');
      const onlyLocks = normalized.issues.length > 0 && normalized.issues.every((i) => (LOCK_ISSUE_CODES as readonly string[]).includes(i.code));
      throw new RunFailure(onlyYear ? 'YEAR_NOT_DRAFT' : onlyLocks ? 'LOCKS_INVALID' : 'NOT_READY', onlyLocks ? 'The locked lessons do not fit the current configuration' : 'The configuration does not satisfy the generation preconditions', {
        issues: bounded(normalized.issues.slice(0, 50).map((i) => ({ code: i.code, message: i.message, entity: i.entity, ...(onlyLocks ? { details: i.details } : {}) })) as unknown),
        truncated: normalized.truncated,
      });
    }
    const problem = normalized.problem;
    inputHash = problem.inputHash;
    if (!(await repo.setPhase(run.id, token, 'NORMALIZE', { inputHash, sectionCount: problem.derived.sectionCount }))) throw new JobInterrupted('LEASE_LOST');

    // ---- 3b. Phase 7F-0: freeze the period times. Write-once: the FIRST attempt stores what its consistent snapshot read; a recovered attempt
    // reuses the stored value (it never overwrites it), so the version always carries the times of the run's first look at the configuration.
    let frozenTimes: { times: PeriodTime[]; capturedAt: Date };
    if (run.periodTimes !== null && run.periodTimes !== undefined && run.periodTimesCapturedAt) {
      const stored = parseStoredPeriodTimes(run.periodTimes);
      if (!stored) throw new RunFailure('INTERNAL_INCONSISTENCY', 'The period times stored with this run are unreadable', {}, inputHash);
      frozenTimes = { times: stored, capturedAt: new Date(run.periodTimesCapturedAt) };
    } else {
      if (periodTimesInvalid || snapshotPeriodTimes === null) throw new RunFailure('INTERNAL_INCONSISTENCY', 'The schedule periods could not be read as a valid 1..n sequence', {}, inputHash);
      const frozen = await repo.freezePeriodTimes(run.id, token, snapshotPeriodTimes);
      if (!frozen) throw new JobInterrupted('LEASE_LOST');
      const stored = parseStoredPeriodTimes(frozen.periodTimes);
      if (!stored) throw new RunFailure('INTERNAL_INCONSISTENCY', 'The period times stored with this run are unreadable', {}, inputHash);
      frozenTimes = { times: stored, capturedAt: frozen.capturedAt };
    }
    if (!periodTimesMatchGrid(frozenTimes.times, problem.derived.periodsPerDay)) {
      throw new RunFailure('CONFIGURATION_CHANGED', 'The schedule periods changed since this run captured its period times', { periodsPerDay: problem.derived.periodsPerDay, capturedPeriods: frozenTimes.times.length }, inputHash);
    }

    // ---- 4. TypeScript baseline, validated ---------------------------------------------------------------------------
    await checkpoint('BASELINE');
    // Phase 7E: with locked entries the baseline is a SEPARATE, best-effort path. Without them the original path below is untouched.
    let baselineEntries: TimetableEntryRow[] | null;
    let baselineMetrics: TimetableMetrics | BaselineMetricsUnavailable;
    const lockWarnings: string[] = [];
    if (problem.core.fixedEntries.length === 0) {
      const baseline = (deps.buildBaseline ?? buildBaseline)(problem, options.seed);
      if (!baseline.ok) {
        throw new RunFailure('INFEASIBLE_HARD_CONSTRAINTS', 'The hard constraints cannot be satisfied: a teacher or section exceeds its weekly capacity', { certificate: bounded(baseline.certificate.slice(0, 50)) }, inputHash);
      }
      const baselineValidation = validateEntries(problem, baseline.entries);
      if (!baselineValidation.valid) {
        throw new RunFailure('INTERNAL_INCONSISTENCY', 'The constructive baseline failed validation', { problems: baselineValidation.problems.slice(0, 20) }, inputHash);
      }
      baselineEntries = baseline.entries;
      baselineMetrics = evaluateMetrics(problem, baseline.entries);
    } else {
      const locked = (deps.buildBaselineWithFixed ?? buildBaselineWithFixed)(problem, options.seed);
      baselineEntries = null;
      baselineMetrics = { available: false, reason: 'NO_LOCK_AWARE_BASELINE' };
      if (locked.ok) {
        const lockedValidation = validateEntries(problem, locked.entries);
        if (lockedValidation.valid) {
          baselineEntries = locked.entries;
          baselineMetrics = evaluateMetrics(problem, locked.entries);
        } else {
          // D-E3: an invalid lock-aware baseline is DISCARDED (with diagnostics), never used and never persisted; CP-SAT continues
          baselineMetrics = { available: false, reason: 'BASELINE_REJECTED' };
          lockWarnings.push('LOCK_AWARE_BASELINE_REJECTED_BY_VALIDATION');
          log.warn({ runId: run.id, problems: lockedValidation.problems.slice(0, 5) }, 'the lock-aware baseline failed validation and was discarded');
        }
      } else if (locked.reason === 'CAPACITY') {
        // the same exact certificate as without locks: a teacher or section over capacity is infeasible, locks or not
        throw new RunFailure('INFEASIBLE_HARD_CONSTRAINTS', 'The hard constraints cannot be satisfied: a teacher or section exceeds its weekly capacity', { certificate: bounded(locked.certificate.slice(0, 50)) }, inputHash);
      } else {
        lockWarnings.push('NO_LOCK_AWARE_BASELINE');
      }
    }

    // ---- 5. the solver, with the REMAINING budget ----------------------------------------------------------------------
    await checkpoint('SOLVING');
    const built = buildSolverOptions({
      sectionCount: problem.derived.sectionCount,
      elapsedMs: clock() - startedMs,
      seed: options.seed,
      numWorkers: config.workers,
      reproducible: options.reproducible,
      policy,
    });
    let attempt: SolverAttempt;
    let info: SolverRunInfo | null = null;
    let timeLimitSeconds: number;
    if (!built.ok) {
      timeLimitSeconds = built.budgetSeconds;
      attempt = budgetExhaustedAttempt(built.budgetSeconds);
    } else {
      timeLimitSeconds = built.budgetSeconds;
      const input = buildSolverInput(problem, run.id, built.options);
      try {
        const result = await solverClient.solve({ problem, input }, { signal: lease.signal });
        attempt = result.attempt;
        info = result.info;
      } catch (error) {
        if (error instanceof SolverAbortedError) throw interruption();
        if (error instanceof SolverRequestError) throw new RunFailure('INTERNAL_INCONSISTENCY', `The solver request was invalid: ${error.message}`, { issues: error.issues.slice(0, 10) }, inputHash);
        throw error;
      }
    }
    throwIfInterrupted();

    // ---- 6. interpret, apply the B / D4 rule, validate ----------------------------------------------------------------
    await checkpoint('VALIDATING');
    const outcome = decideOutcome(attempt, baselineEntries);
    if (outcome.kind === 'FAILURE') {
      throw new RunFailure(outcome.code, outcome.message, {
        problems: bounded(outcome.problems.slice(0, 20)), solver: bounded(outcome.solverDiagnostics), process: bounded(processInfo(info), 8_000),
      }, inputHash);
    }
    const candidateValidation = validateEntries(problem, outcome.entries);
    if (!candidateValidation.valid) {
      throw new RunFailure('INTERNAL_INCONSISTENCY', 'The selected timetable failed validation', { problems: candidateValidation.problems.slice(0, 20), solutionSource: outcome.solutionSource }, inputHash);
    }

    // ---- 7. independent, authoritative metrics ----------------------------------------------------------------------------
    await checkpoint('METRICS');
    const metrics = evaluateMetrics(problem, outcome.entries);
    const solverObjective = outcome.solutionSource === 'CP_SAT' ? (outcome.solverDiagnostics?.objectiveValue ?? null) : null;
    let agreement: 'NOT_APPLICABLE' | 'EXACT' | 'SOLVER_ABOVE' | 'SOLVER_BELOW' = 'NOT_APPLICABLE';
    const warnings: string[] = [];
    if (solverObjective !== null) {
      agreement = solverObjective === metrics.weightedObjective ? 'EXACT' : solverObjective > metrics.weightedObjective ? 'SOLVER_ABOVE' : 'SOLVER_BELOW';
      // Above is expected for an unconverged solution (slack). Below is impossible for a correct model, and so is any difference at OPTIMAL.
      if (agreement === 'SOLVER_BELOW' || (outcome.optimal && agreement !== 'EXACT')) {
        warnings.push('SOLVER_OBJECTIVE_DISAGREES_WITH_AUTHORITATIVE_METRICS');
        log.warn({ runId: run.id, solverObjective, authoritative: metrics.weightedObjective, optimal: outcome.optimal }, 'solver objective disagrees with the authoritative metrics');
      }
    }
    if (outcome.solutionSource === 'CP_SAT' && 'weightedObjective' in baselineMetrics && metrics.weightedObjective > baselineMetrics.weightedObjective) warnings.push('CP_SAT_WORSE_THAN_BASELINE');
    warnings.push(...lockWarnings);
    // A reproducible run is only known to be repeatable when the search CONFIRMABLY ended at its deterministic limit (stoppedBy DETERMINISTIC_LIMIT,
    // or OPTIMAL). If the wall clock ended it (TIME_LIMIT), if it ended near both limits so the cause cannot be established (LIMIT_AMBIGUOUS), or
    // if the watchdog killed the solver, the result may differ from another run of the same input: say so, and never claim determinism.
    if (options.reproducible && (outcome.solverDiagnostics?.stoppedBy === 'TIME_LIMIT' || outcome.solverDiagnostics?.stoppedBy === 'LIMIT_AMBIGUOUS' || outcome.fallbackReason === 'KILLED_BY_WATCHDOG')) warnings.push('REPRODUCIBLE_RUN_STOPPED_BY_WALL_CLOCK');

    // ---- 8. final locked persistence -------------------------------------------------------------------------------------
    await checkpoint('PERSISTING');
    const runtimeSeconds = Math.round(((clock() - startedMs) / 1000) * 1000) / 1000;
    const resultSummary = {
      solverStatus: outcome.solverStatus,
      solutionSource: outcome.solutionSource,
      optimal: outcome.optimal,
      fallbackReason: outcome.fallbackReason,
      runtimeSeconds,
      solverRuntimeMs: info?.durationMs ?? null,
      weightsVersion: WEIGHTS_VERSION,
      weights: { ...WEIGHTS_V1 },
      terms: metrics.terms,
      weightedObjective: metrics.weightedObjective,
      baselineWeightedObjective: 'weightedObjective' in baselineMetrics ? baselineMetrics.weightedObjective : null,
      solverObjective,
      objectiveAgreement: agreement,
      warnings,
      inputHash,
      sectionCount: problem.derived.sectionCount,
      timeLimitSeconds,
      workers: config.workers,
      attempts: run.attempts,
      // only runs started from a source draft carry these keys, so the summary of every other run is exactly what it always was
      ...(options.sourceVersionId !== null || options.lockedEntries.length > 0
        ? { sourceVersionId: options.sourceVersionId, lockedEntryCount: options.lockedEntries.length, baselineAvailable: 'weightedObjective' in baselineMetrics }
        : {}),
    };
    let persistAttempts = 1;
    try {
      const persisted = await persistGeneratedVersion(
        {
          prisma,
          run: { id: run.id, schoolId: run.schoolId, academicYearId: run.academicYearId, requestedById: run.requestedById },
          token,
          problem,
          entries: outcome.entries,
          ...(options.lockedEntries.length > 0 ? { lockedEntries: options.lockedEntries } : {}),
          version: {
            solutionSource: outcome.solutionSource,
            solverStatus: outcome.solverStatus,
            weightsVersion: WEIGHTS_VERSION,
            metrics,
            baselineMetrics,
            solverDiagnostics: bounded({ solver: outcome.solverDiagnostics, process: processInfo(info), objectiveAgreement: agreement, warnings }),
          },
          resultSummary,
          lockTimeoutSeconds: config.persistLockTimeoutSeconds,
          maxDraftsPerYear: config.maxDraftsPerYear,
          periodTimes: frozenTimes,
          ...(hooks?.persist ? { hooks: hooks.persist } : {}),
        },
        { maxRetries: config.persistMaxRetries, backoffMs: [250, 1_000, 2_000] },
        deps.sleep
      );
      persistAttempts = persisted.attempts;
      log.info({ runId: run.id, versionId: persisted.versionId, versionNumber: persisted.versionNumber, source: outcome.solutionSource, status: outcome.solverStatus, persistAttempts }, 'generation succeeded');
      return { kind: 'SUCCEEDED', versionId: persisted.versionId, versionNumber: persisted.versionNumber, solutionSource: outcome.solutionSource, solverStatus: outcome.solverStatus };
    } catch (error) {
      if (error instanceof LeaseLostError) throw new JobInterrupted('LEASE_LOST');
      if (error instanceof ConfigurationChangedError) throw new RunFailure('CONFIGURATION_CHANGED', error.message, error.details, inputHash);
      if (error instanceof CandidateRejectedError) throw new RunFailure('INTERNAL_INCONSISTENCY', error.message, error.details, inputHash);
      if (error instanceof DraftLimitReachedError) throw new RunFailure('DRAFT_LIMIT_REACHED', error.message, { drafts: error.drafts, max: error.max }, inputHash);
      throw new RunFailure('PERSIST_FAILED', 'The timetable could not be saved', { error: String((error as Error)?.message ?? error).slice(0, 500), attempts: persistAttempts }, inputHash);
    }
  } catch (error) {
    return finalize(error, run, token, deps, inputHash, log);
  }
}

/** Turn whatever ended the run into its fenced final state. Never throws on a lost lease: it just reports ABANDONED. */
async function finalize(error: unknown, run: RunRecord, token: string, deps: OrchestratorDeps, inputHash: string | null, log: Logger): Promise<RunResult> {
  const { repo } = deps;
  if (error instanceof JobInterrupted) {
    if (error.reason === 'SHUTDOWN') {
      const requeued = await repo.requeueForShutdown(run.id, token);
      log.info({ runId: run.id, requeued }, 'run requeued for shutdown');
      return requeued ? { kind: 'REQUEUED' } : { kind: 'ABANDONED', reason: 'lease lost while shutting down' };
    }
    log.warn({ runId: run.id }, 'lease lost: stopping without writing');
    return { kind: 'ABANDONED', reason: 'lease lost' };
  }
  let failure: RunFailure;
  if (error instanceof RunFailure) failure = error;
  else if (error instanceof SnapshotError) failure = new RunFailure('INTERNAL_INCONSISTENCY', error.message, { code: error.code }, inputHash);
  else {
    const e = error as Error;
    log.error({ runId: run.id, error: String(e?.message ?? e).slice(0, 300), name: e?.name }, 'unexpected error while generating');
    failure = new RunFailure('INTERNAL_INCONSISTENCY', 'An unexpected error ended the generation', { error: { name: e?.name, message: String(e?.message ?? e).slice(0, 500) } }, inputHash);
  }
  const written = await repo.fail(run.id, token, { code: failure.code, message: failure.message, diagnostics: failure.diagnostics, inputHash: failure.inputHash ?? inputHash });
  if (!written) {
    log.warn({ runId: run.id, code: failure.code }, 'could not record the failure: lease already lost');
    return { kind: 'ABANDONED', reason: 'lease lost before the failure could be recorded' };
  }
  log.info({ runId: run.id, code: failure.code }, 'generation failed');
  return { kind: 'FAILED', code: failure.code };
}
