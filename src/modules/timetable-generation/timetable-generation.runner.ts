import { randomUUID } from 'node:crypto';
import { type PrismaClient } from '@prisma/client';
import { consoleLogger, executeRun, type Logger, type OrchestratorDeps, type OrchestratorHooks, type RunResult } from './timetable-generation.orchestrator.js';
import { resolveRunnerConfig, type RunnerConfig } from './timetable-generation.runner-config.js';
import { RunRepository, type RunRecord } from './timetable-generation.run-repository.js';
import { resolveSolverClientConfig, SubprocessSolverClient, type SolverClient } from './timetable-generation.solver-client.js';
import { DEFAULT_TIME_POLICY, parseTimePolicy, type TimeLimitPolicy } from './timetable-generation.time-policy.js';

// ---------------------------------------------------------------------------
// GenerationRunner: the in-process worker pool over the PostgreSQL queue.
//
//   * The database is the queue and the source of truth. A trigger (after an enqueue, after a job finishes) is only a
//     hint to look sooner; the periodic tick finds queued work even if every trigger is missed.
//   * Concurrency is bounded (RunnerConfig.concurrency). The per-academic-year "one active run" rule is enforced by
//     the database, not here.
//   * Each job holds a LEASE it keeps alive with a heartbeat. A job that cannot heartbeat, or finds it no longer owns
//     the run, aborts its work and writes nothing. The tick recovers jobs whose lease expired (worker/server died).
//   * stop() is a graceful shutdown: no new claims, active solver processes are aborted through their AbortSignal
//     (the solver subprocesses are detached, so they must be ended explicitly), and the runs are requeued without
//     consuming an attempt.
// ---------------------------------------------------------------------------

export interface RunnerDeps {
  prisma: PrismaClient;
  solverClient: SolverClient;
  config: RunnerConfig;
  policy?: TimeLimitPolicy;
  logger?: Logger;
  hooks?: OrchestratorHooks;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  repo?: RunRepository;
  buildBaseline?: OrchestratorDeps['buildBaseline'];
  /** Test seam (Phase 7E): the lock-aware baseline builder. */
  buildBaselineWithFixed?: OrchestratorDeps['buildBaselineWithFixed'];
}

export interface RunnerStats {
  claimed: number;
  succeeded: number;
  failed: number;
  requeued: number;
  abandoned: number;
  expired: number;
  recoveredRequeued: number;
  recoveredFailed: number;
}

interface ActiveJob {
  runId: string;
  token: string;
  controller: AbortController;
  done: Promise<RunResult | null>;
}

export class GenerationRunner {
  readonly instanceId = randomUUID();
  readonly repo: RunRepository;
  readonly stats: RunnerStats = { claimed: 0, succeeded: 0, failed: 0, requeued: 0, abandoned: 0, expired: 0, recoveredRequeued: 0, recoveredFailed: 0 };
  private readonly active = new Map<string, ActiveJob>();
  private readonly log: Logger;
  private tickTimer: NodeJS.Timeout | undefined;
  private dispatching: Promise<void> | null = null;
  private rerun = false;
  private stopping = false;
  private started = false;

  constructor(private readonly deps: RunnerDeps) {
    this.repo = deps.repo ?? new RunRepository(deps.prisma);
    this.log = deps.logger ?? consoleLogger;
  }

  get activeCount(): number {
    return this.active.size;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /** Begin ticking and look for work now. Idempotent. */
  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    this.tickTimer = setInterval(() => void this.dispatch(), this.deps.config.tickSeconds * 1000);
    this.tickTimer.unref?.();
    this.log.info({ instanceId: this.instanceId, concurrency: this.deps.config.concurrency, workers: this.deps.config.workers, tickSeconds: this.deps.config.tickSeconds }, 'generation runner started');
    void this.dispatch();
  }

  /** A hint that work may be waiting (after an enqueue). Coalesced and not awaited; a missed hint costs at most one tick. */
  trigger(): void {
    if (this.stopping) return;
    void this.dispatch();
  }

  /** Sweep (TTL, stale leases) and claim work up to the concurrency limit. Resolves when this pass is done. Exposed for tests and tools. */
  dispatch(): Promise<void> {
    if (this.dispatching) {
      this.rerun = true; // another pass right after the current one: a trigger must never be lost
      return this.dispatching;
    }
    this.dispatching = (async () => {
      do {
        this.rerun = false;
        await this.sweepAndClaim();
      } while (this.rerun && !this.stopping);
    })().finally(() => {
      this.dispatching = null;
    });
    return this.dispatching;
  }

  private async sweepAndClaim(): Promise<void> {
    const { config } = this.deps;
    try {
      const expired = await this.repo.expireQueued(config.queueTtlMinutes);
      if (expired.length > 0) {
        this.stats.expired += expired.length;
        this.log.warn({ runIds: expired, ttlMinutes: config.queueTtlMinutes }, 'queued runs expired and were not started');
      }
      const recovered = await this.repo.recoverStale(config.maxAttempts);
      this.stats.recoveredRequeued += recovered.requeued.length;
      this.stats.recoveredFailed += recovered.failed.length;
      if (recovered.requeued.length > 0) this.log.warn({ runIds: recovered.requeued }, 'stale runs requeued for another attempt');
      if (recovered.failed.length > 0) this.log.error({ runIds: recovered.failed }, 'stale runs failed: WORKER_LOST');

      while (!this.stopping && this.active.size < config.concurrency) {
        const token = randomUUID();
        const run = await this.repo.claimNext(token, config.leaseSeconds);
        if (!run) break;
        this.stats.claimed++;
        this.startJob(run, token);
      }
    } catch (error) {
      // A database error must not kill the runner: the next tick tries again.
      this.log.error({ error: String((error as Error)?.message ?? error).slice(0, 300) }, 'dispatch pass failed');
    }
  }

  private startJob(run: RunRecord, token: string): void {
    const { config } = this.deps;
    const controller = new AbortController();
    let beating = false;
    let failures = 0;
    const lost = (reason: string): void => {
      if (!controller.signal.aborted) {
        this.log.warn({ runId: run.id, reason }, 'lease lost: aborting the run');
        controller.abort('LEASE_LOST');
      }
    };
    const heartbeat = setInterval(() => {
      if (beating || controller.signal.aborted) return;
      beating = true;
      this.repo
        .heartbeat(run.id, token, config.leaseSeconds)
        .then((ok) => {
          if (ok) failures = 0;
          else lost('the run is no longer owned by this worker');
        })
        .catch((error) => {
          failures++;
          this.log.warn({ runId: run.id, failures, error: String((error as Error)?.message ?? error).slice(0, 200) }, 'heartbeat failed');
          if (failures >= config.heartbeatMaxFailures) lost(`${failures} consecutive heartbeat failures`);
        })
        .finally(() => {
          beating = false;
        });
    }, config.heartbeatSeconds * 1000);
    heartbeat.unref?.();

    const done = executeRun(run, token, { signal: controller.signal }, {
      prisma: this.deps.prisma,
      repo: this.repo,
      solverClient: this.deps.solverClient,
      config,
      policy: this.deps.policy ?? DEFAULT_TIME_POLICY,
      logger: this.log,
      ...(this.deps.hooks ? { hooks: this.deps.hooks } : {}),
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
      ...(this.deps.buildBaseline ? { buildBaseline: this.deps.buildBaseline } : {}),
      ...(this.deps.buildBaselineWithFixed ? { buildBaselineWithFixed: this.deps.buildBaselineWithFixed } : {}),
    })
      .then((result): RunResult | null => {
        if (result.kind === 'SUCCEEDED') this.stats.succeeded++;
        else if (result.kind === 'FAILED') this.stats.failed++;
        else if (result.kind === 'REQUEUED') this.stats.requeued++;
        else this.stats.abandoned++;
        return result;
      })
      .catch((error): RunResult | null => {
        // executeRun reports its own failures; reaching here means even recording the result failed (for example the
        // database is down). The lease will expire and stale recovery takes over.
        this.stats.abandoned++;
        this.log.error({ runId: run.id, error: String((error as Error)?.message ?? error).slice(0, 300) }, 'run ended without a recorded result');
        return null;
      })
      .finally(() => {
        clearInterval(heartbeat);
        this.active.delete(run.id);
        if (!this.stopping) this.trigger(); // a slot is free: look for the next run now
      });
    this.active.set(run.id, { runId: run.id, token, controller, done });
  }

  /**
   * Graceful shutdown. Stops claiming, aborts every active run (ending its solver process) so it requeues itself, and
   * waits up to the grace period. Runs still busy after the grace (for example inside the final transaction) are left
   * to finish or to be recovered by lease expiry.
   */
  async stop(graceSeconds: number = this.deps.config.shutdownGraceSeconds): Promise<{ aborted: number; stillActive: number }> {
    this.stopping = true;
    clearInterval(this.tickTimer);
    const jobs = [...this.active.values()];
    for (const job of jobs) job.controller.abort('SHUTDOWN');
    if (this.dispatching) await this.dispatching.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), graceSeconds * 1000);
    });
    await Promise.race([Promise.allSettled(jobs.map((j) => j.done)), timeout]);
    clearTimeout(timer);
    const stillActive = this.active.size;
    if (stillActive > 0) this.log.warn({ stillActive }, 'shutdown grace elapsed with runs still active');
    this.log.info({ aborted: jobs.length, stillActive }, 'generation runner stopped');
    return { aborted: jobs.length, stillActive };
  }
}

/** Build a runner from the environment (explicit, validated configuration). Nothing is started. */
export function createGenerationRunnerFromEnv(prisma: PrismaClient, env: Record<string, string | undefined> = process.env, logger: Logger = consoleLogger): GenerationRunner | null {
  const { config, warnings } = resolveRunnerConfig(env);
  for (const warning of warnings) logger.warn({}, warning);
  if (!config.enabled) {
    logger.info({}, 'generation runner disabled (GENERATION_RUNNER_ENABLED=false)');
    return null;
  }
  return new GenerationRunner({
    prisma,
    config,
    policy: parseTimePolicy(env),
    logger,
    solverClient: new SubprocessSolverClient(resolveSolverClientConfig(env)),
  });
}
