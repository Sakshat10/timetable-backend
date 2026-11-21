import {
  solverInputSchema,
  type SolverInput,
  type SolverOptions,
} from './timetable-generation.contracts.js';
import { canonicalJson, hashJson } from './timetable-generation.hash.js';
import { type NormalizedProblem } from './timetable-generation.normalizer.js';
import {
  DEFAULT_TIME_POLICY,
  resolveDeterministicTimeLimit,
  resolveTimeLimitSeconds,
  type TimeLimitPolicy,
} from './timetable-generation.time-policy.js';

// ---------------------------------------------------------------------------
// Building and validating the solver request on the Node side of the boundary.
//
// Two rules are enforced here, at the boundary, instead of changing the Phase 1 Zod contract (which stays untouched):
//
//  1. TIME. The solver process receives the REMAINING budget, never an independent full one. Everything the run has
//     already spent (loading, normalising, building the baseline) is subtracted from the policy budget before the
//     options are built. options.timeLimitSeconds is then the budget of the WHOLE solver process, measured from the
//     moment Node spawns it (the Python process starts its own clock before importing OR-Tools, so start-up is
//     inside it). The client force-kills at that budget plus the kill grace, so the real worst case is
//     budget + grace, not budget + start-up + timeout + grace.
//
//     REPRODUCIBLE mode is the one exception to "everything follows the remaining budget": its DETERMINISTIC limit is derived from the
//     policy budget alone, so the same problem, seed and settings always get the same deterministic search budget however long the
//     work before the solve took. The remaining wall-clock budget stays the backstop (and the kill deadline is unchanged): if it is
//     reached before the deterministic limit, the solver reports stoppedBy TIME_LIMIT and the run records a warning, because only a
//     search stopped by its deterministic limit is repeatable.
//
//  2. OPTION CONSISTENCY. The Python solver is stricter than the Zod schema: `reproducible = true` REQUIRES a
//     deterministic time limit and `reproducible = false` REQUIRES null. The builder produces only consistent
//     combinations and the client refuses to send anything else.
// ---------------------------------------------------------------------------

export interface BuildOptionsParams {
  /** Sections in the solver input (problem.derived.sectionCount): selects the policy budget. */
  sectionCount: number;
  /** Time the run has already spent since its budget started (loading, normalising, baseline...). */
  elapsedMs: number;
  seed: number;
  numWorkers: number;
  reproducible: boolean;
  policy?: TimeLimitPolicy;
}

export type BuildOptionsResult =
  | { ok: true; options: SolverOptions; budgetSeconds: number; remainingSeconds: number }
  /** Less than one whole second is left: the solver cannot be started with a valid budget. The orchestration layer decides. */
  | { ok: false; reason: 'BUDGET_EXHAUSTED'; budgetSeconds: number; remainingSeconds: number };

export function buildSolverOptions(params: BuildOptionsParams): BuildOptionsResult {
  if (!Number.isFinite(params.elapsedMs) || params.elapsedMs < 0) {
    throw new Error(`elapsedMs must be a non-negative number (got ${params.elapsedMs})`);
  }
  const budgetSeconds = resolveTimeLimitSeconds(params.sectionCount, params.policy ?? DEFAULT_TIME_POLICY);
  const remaining = budgetSeconds - params.elapsedMs / 1000;
  const wholeSeconds = Math.floor(remaining);
  if (wholeSeconds < 1) {
    return { ok: false, reason: 'BUDGET_EXHAUSTED', budgetSeconds, remainingSeconds: Math.max(0, remaining) };
  }
  return {
    ok: true,
    budgetSeconds,
    remainingSeconds: remaining,
    options: {
      timeLimitSeconds: wholeSeconds,
      seed: params.seed,
      numWorkers: params.numWorkers,
      reproducible: params.reproducible,
      // Reproducible mode: the deterministic limit comes from the POLICY budget (a function of the section count only), NEVER from the
      // remaining wall-clock time. The remaining time depends on how long the database round trips before the solve happened to take;
      // deriving the limit from it gave identical inputs different search budgets (and different timetables) from run to run.
      deterministicTimeLimit: params.reproducible ? resolveDeterministicTimeLimit(budgetSeconds) : null,
    },
  };
}

/** The Python-side option rule. Returns the violations (empty = consistent). */
export function optionConsistencyIssues(options: SolverOptions): string[] {
  const issues: string[] = [];
  if (options.reproducible && options.deterministicTimeLimit === null) {
    issues.push('reproducible=true requires a deterministicTimeLimit');
  }
  if (!options.reproducible && options.deterministicTimeLimit !== null) {
    issues.push('reproducible=false requires deterministicTimeLimit=null');
  }
  return issues;
}

/** The exact bytes sent to the solver: canonical (sorted-key) compact JSON plus a newline. Deterministic for equal input. */
export function serializeSolverRequest(input: SolverInput): string {
  return `${canonicalJson(input)}\n`;
}

/** The part of the request that defines the scheduling problem; its hash must equal NormalizedProblem.inputHash. */
export function problemCoreOf(input: SolverInput): Pick<SolverInput, 'contractVersion' | 'grid' | 'sections' | 'teachers' | 'assignments' | 'fixedEntries'> {
  return {
    contractVersion: input.contractVersion,
    grid: input.grid,
    sections: input.sections,
    teachers: input.teachers,
    assignments: input.assignments,
    fixedEntries: input.fixedEntries,
  };
}

/** A request the caller built wrongly. This is a programming error in the backend, never a solver fault. */
export class SolverRequestError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid solver request: ${issues.slice(0, 5).join('; ')}`);
    this.name = 'SolverRequestError';
  }
}

/**
 * Validate everything that can be validated before a process is spawned: the Phase 1 Zod contract, the option
 * consistency rule Python enforces, and that the request really belongs to the problem its output will be checked
 * against (a mismatched pair would validate a timetable against the wrong problem).
 */
export function validateSolverRequest(problem: NormalizedProblem, input: SolverInput): string[] {
  const issues: string[] = [];
  const parsed = solverInputSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 10)) {
      issues.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    return issues;
  }
  issues.push(...optionConsistencyIssues(input.options));
  if (hashJson(problemCoreOf(input)) !== problem.inputHash) {
    issues.push('the request does not belong to the given problem (input hash differs)');
  }
  return issues;
}

export function assertValidSolverRequest(problem: NormalizedProblem, input: SolverInput): void {
  const issues = validateSolverRequest(problem, input);
  if (issues.length > 0) throw new SolverRequestError(issues);
}
