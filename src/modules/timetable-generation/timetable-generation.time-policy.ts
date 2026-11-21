// ---------------------------------------------------------------------------
// Solver time policy (server-side only; the admin cannot choose a time limit in V1).
//
// The budget depends on the number of sections in the solver input. Phase 0 (Apple M2, synthetic fixtures)
// showed solution quality improving strongly with time at 50-100 sections, so larger schools get more.
// These are INITIAL defaults and must be revisited after production telemetry.
// ---------------------------------------------------------------------------

export interface TimeLimitPolicy {
  /** <= 10 sections */
  le10: number;
  /** 11-50 sections */
  le50: number;
  /** 51-100 sections */
  le100: number;
  /** > 100 sections */
  gt100: number;
  /** Absolute ceiling: no resolved budget may exceed this. */
  max: number;
  /** Node's kill timer fires at budget + this many seconds (backstop for a hung solver process). */
  killGraceSeconds: number;
}

export const DEFAULT_TIME_POLICY: Readonly<TimeLimitPolicy> = Object.freeze({
  le10: 10,
  le50: 60,
  le100: 120,
  gt100: 180,
  max: 300,
  killGraceSeconds: 20,
});

const ENV_KEYS: Record<keyof TimeLimitPolicy, string> = {
  le10: 'SOLVER_TIME_LIMIT_LE10',
  le50: 'SOLVER_TIME_LIMIT_LE50',
  le100: 'SOLVER_TIME_LIMIT_LE100',
  gt100: 'SOLVER_TIME_LIMIT_GT100',
  max: 'SOLVER_TIME_LIMIT_MAX',
  killGraceSeconds: 'SOLVER_KILL_GRACE_SECONDS',
};

/** Hard upper bound for the configurable ceiling itself (the solver contract allows at most 3600). */
const POLICY_MAX_CEILING = 3_600;

function readPositiveInt(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`${key} must be a positive integer (got "${raw}")`);
  }
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${key} must be a positive integer (got "${raw}")`);
  }
  return value;
}

/**
 * Read the policy from the environment, validating every value. Fails fast (throws) on a malformed value,
 * on a budget above the configured maximum, or on a maximum above the contract ceiling.
 */
export function parseTimePolicy(env: Record<string, string | undefined>): TimeLimitPolicy {
  const policy: TimeLimitPolicy = {
    le10: readPositiveInt(env, ENV_KEYS.le10, DEFAULT_TIME_POLICY.le10),
    le50: readPositiveInt(env, ENV_KEYS.le50, DEFAULT_TIME_POLICY.le50),
    le100: readPositiveInt(env, ENV_KEYS.le100, DEFAULT_TIME_POLICY.le100),
    gt100: readPositiveInt(env, ENV_KEYS.gt100, DEFAULT_TIME_POLICY.gt100),
    max: readPositiveInt(env, ENV_KEYS.max, DEFAULT_TIME_POLICY.max),
    killGraceSeconds: readPositiveInt(env, ENV_KEYS.killGraceSeconds, DEFAULT_TIME_POLICY.killGraceSeconds),
  };

  if (policy.max > POLICY_MAX_CEILING) {
    throw new Error(`${ENV_KEYS.max} must not exceed ${POLICY_MAX_CEILING} (got ${policy.max})`);
  }
  for (const key of ['le10', 'le50', 'le100', 'gt100'] as const) {
    if (policy[key] > policy.max) {
      throw new Error(`${ENV_KEYS[key]} (${policy[key]}) must not exceed ${ENV_KEYS.max} (${policy.max})`);
    }
  }
  return policy;
}

/** Time budget in seconds for a school with `sectionCount` sections in the solver input. */
export function resolveTimeLimitSeconds(sectionCount: number, policy: TimeLimitPolicy = DEFAULT_TIME_POLICY): number {
  if (!Number.isInteger(sectionCount) || sectionCount < 0) {
    throw new Error(`sectionCount must be a non-negative integer (got ${sectionCount})`);
  }
  const budget =
    sectionCount <= 10 ? policy.le10 : sectionCount <= 50 ? policy.le50 : sectionCount <= 100 ? policy.le100 : policy.gt100;
  return Math.min(budget, policy.max);
}

/** Wall-clock moment (seconds after start) at which Node force-kills a solver process that has not exited. */
export function resolveKillAfterSeconds(timeLimitSeconds: number, policy: TimeLimitPolicy = DEFAULT_TIME_POLICY): number {
  return timeLimitSeconds + policy.killGraceSeconds;
}

/**
 * Reproducible mode budgets CP-SAT in deterministic time instead of wall-clock time. Phase 0 measured
 * roughly 0.45 deterministic units per wall second on the benchmark machine (det 20 ~ 42-47 s wall at 50 sections).
 * This ratio is only a starting calibration and must be re-measured on production hardware.
 */
export const DETERMINISTIC_TIME_RATIO = 0.45;

export function resolveDeterministicTimeLimit(timeLimitSeconds: number): number {
  return Math.max(1, Math.round(timeLimitSeconds * DETERMINISTIC_TIME_RATIO));
}
