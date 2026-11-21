import os from 'node:os';

// ---------------------------------------------------------------------------
// GenerationRunner configuration: explicit, validated, fail-fast.
//
// Resource planning (approved architecture):
//   * workers per solve: default 4, never above the CPU count;
//   * concurrent solves: default min(2, floor(cpus / workers)), at least 1, and never so many that
//     concurrency x workers exceeds the CPU count (CP-SAT processes must not oversubscribe the machine);
//   * memory: roughly 1 GiB is planned per active solver slot (Phase 0 measured 550-700 MB at 4 workers for a
//     100-section school), so concurrency is also capped by 70% of the installed memory.
// The result is reported together with the warnings that explain every reduction.
// ---------------------------------------------------------------------------

export const MEMORY_PER_SLOT_BYTES = 1024 * 1024 * 1024;
const MEMORY_BUDGET_FRACTION = 0.7;

export interface RunnerConfig {
  enabled: boolean;
  /** CP-SAT workers per solve (what the solver is asked to use). */
  workers: number;
  /** Solves running at the same time inside this process. */
  concurrency: number;
  /** Maximum QUEUED + RUNNING runs across the table; beyond it new requests are refused. */
  queueMax: number;
  /** A run still QUEUED after this long is failed with QUEUE_EXPIRED. */
  queueTtlMinutes: number;
  leaseSeconds: number;
  heartbeatSeconds: number;
  /** Consecutive heartbeat errors tolerated before the run is treated as lost. */
  heartbeatMaxFailures: number;
  tickSeconds: number;
  /** A run is claimed at most this many times; a lost attempt is requeued while attempts < maxAttempts. */
  maxAttempts: number;
  /** How long stop() waits for active runs to requeue themselves. */
  shutdownGraceSeconds: number;
  persistMaxRetries: number;
  /** PostgreSQL lock_timeout used by the final persistence transaction. */
  persistLockTimeoutSeconds: number;
  /** Phase 7F-0: the most DRAFT versions one academic year may hold (each active generation run reserves one more slot). */
  maxDraftsPerYear: number;
}

export interface RunnerResources {
  cpuCount: number;
  totalMemoryBytes: number;
}

export interface ResolvedRunnerConfig {
  config: RunnerConfig;
  warnings: string[];
}

export const DEFAULT_RUNNER_SETTINGS = Object.freeze({
  workers: 4,
  queueMax: 10,
  queueTtlMinutes: 30,
  leaseSeconds: 90,
  heartbeatSeconds: 20,
  heartbeatMaxFailures: 3,
  tickSeconds: 15,
  maxAttempts: 2,
  shutdownGraceSeconds: 30,
  persistMaxRetries: 2,
  persistLockTimeoutSeconds: 10,
  maxDraftsPerYear: 20,
});

const KEYS = {
  enabled: 'GENERATION_RUNNER_ENABLED',
  workers: 'SOLVER_WORKERS',
  concurrency: 'SOLVER_MAX_CONCURRENT_RUNS',
  queueMax: 'SOLVER_QUEUE_MAX',
  queueTtlMinutes: 'GENERATION_QUEUE_TTL_MINUTES',
  leaseSeconds: 'GENERATION_LEASE_SECONDS',
  heartbeatSeconds: 'GENERATION_HEARTBEAT_SECONDS',
  heartbeatMaxFailures: 'GENERATION_HEARTBEAT_MAX_FAILURES',
  tickSeconds: 'GENERATION_TICK_SECONDS',
  maxAttempts: 'GENERATION_MAX_ATTEMPTS',
  shutdownGraceSeconds: 'GENERATION_SHUTDOWN_GRACE_SECONDS',
  persistMaxRetries: 'GENERATION_PERSIST_MAX_RETRIES',
  persistLockTimeoutSeconds: 'GENERATION_PERSIST_LOCK_TIMEOUT_SECONDS',
  maxDraftsPerYear: 'MAX_DRAFTS_PER_YEAR',
} as const;

function readInt(env: Record<string, string | undefined>, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${key} must be an integer (got "${raw}")`);
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be between ${min} and ${max} (got ${value})`);
  return value;
}

function readBool(env: Record<string, string | undefined>, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new Error(`${key} must be true or false (got "${env[key]}")`);
}

export function currentResources(): RunnerResources {
  return { cpuCount: Math.max(1, os.availableParallelism()), totalMemoryBytes: os.totalmem() };
}

export function resolveRunnerConfig(
  env: Record<string, string | undefined> = process.env,
  resources: RunnerResources = currentResources()
): ResolvedRunnerConfig {
  const d = DEFAULT_RUNNER_SETTINGS;
  const warnings: string[] = [];
  const cpus = Math.max(1, Math.floor(resources.cpuCount));

  const requestedWorkers = readInt(env, KEYS.workers, d.workers, 1, 64);
  const workers = Math.min(requestedWorkers, cpus);
  if (workers < requestedWorkers) warnings.push(`${KEYS.workers}=${requestedWorkers} reduced to ${workers}: the machine has ${cpus} CPUs`);

  const defaultConcurrency = Math.max(1, Math.min(2, Math.floor(cpus / workers)));
  const requestedConcurrency = readInt(env, KEYS.concurrency, defaultConcurrency, 1, 64);
  let concurrency = requestedConcurrency;
  const byCpu = Math.max(1, Math.floor(cpus / workers));
  if (concurrency > byCpu) {
    warnings.push(`${KEYS.concurrency}=${requestedConcurrency} reduced to ${byCpu}: ${requestedConcurrency} x ${workers} workers would oversubscribe ${cpus} CPUs`);
    concurrency = byCpu;
  }
  const byMemory = Math.max(1, Math.floor((resources.totalMemoryBytes * MEMORY_BUDGET_FRACTION) / MEMORY_PER_SLOT_BYTES));
  if (concurrency > byMemory) {
    warnings.push(`concurrency reduced to ${byMemory}: about 1 GiB is planned per solver slot and ${Math.round((resources.totalMemoryBytes * MEMORY_BUDGET_FRACTION) / MEMORY_PER_SLOT_BYTES)} GiB of memory is budgeted`);
    concurrency = byMemory;
  }

  const config: RunnerConfig = {
    enabled: readBool(env, KEYS.enabled, true),
    workers,
    concurrency,
    queueMax: readInt(env, KEYS.queueMax, d.queueMax, 1, 10_000),
    queueTtlMinutes: readInt(env, KEYS.queueTtlMinutes, d.queueTtlMinutes, 1, 24 * 60),
    leaseSeconds: readInt(env, KEYS.leaseSeconds, d.leaseSeconds, 2, 3_600),
    heartbeatSeconds: readInt(env, KEYS.heartbeatSeconds, d.heartbeatSeconds, 1, 600),
    heartbeatMaxFailures: readInt(env, KEYS.heartbeatMaxFailures, d.heartbeatMaxFailures, 1, 20),
    tickSeconds: readInt(env, KEYS.tickSeconds, d.tickSeconds, 1, 3_600),
    maxAttempts: readInt(env, KEYS.maxAttempts, d.maxAttempts, 1, 10),
    shutdownGraceSeconds: readInt(env, KEYS.shutdownGraceSeconds, d.shutdownGraceSeconds, 1, 600),
    persistMaxRetries: readInt(env, KEYS.persistMaxRetries, d.persistMaxRetries, 0, 10),
    persistLockTimeoutSeconds: readInt(env, KEYS.persistLockTimeoutSeconds, d.persistLockTimeoutSeconds, 1, 120),
    maxDraftsPerYear: readInt(env, KEYS.maxDraftsPerYear, d.maxDraftsPerYear, 1, 500),
  };

  if (config.heartbeatSeconds * config.heartbeatMaxFailures >= config.leaseSeconds) {
    throw new Error(
      `${KEYS.heartbeatSeconds} x ${KEYS.heartbeatMaxFailures} (${config.heartbeatSeconds * config.heartbeatMaxFailures} s) must be shorter than ${KEYS.leaseSeconds} (${config.leaseSeconds} s): ` +
        'a worker must give up on a failing heartbeat before its lease can expire under it'
    );
  }
  return { config, warnings };
}
