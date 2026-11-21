import {
  type FailureCode,
  type SolverDiagnostics,
  type TimetableEntryRow,
} from './timetable-generation.contracts.js';
import { type SolverOutputInterpretation, type ValidationProblem } from './timetable-generation.validator.js';

// ---------------------------------------------------------------------------
// Outcome decision: what a finished solver attempt means for the run.
//
// The rule (approved architecture, decisions B and D4):
//   * ONLY "CP-SAT ran to its budget and produced no usable solution" (clean UNKNOWN), or a solver process
//     the backend had to kill at its watchdog deadline, may be answered with the validated baseline. That is a
//     SUCCESS with solutionSource = BASELINE, not an error.
//   * Every process or output fault (Python missing, crash, non-zero exit, malformed JSON, invalid or
//     incoherent output, model rejected) FAILS the run. Nothing silently falls back.
//   * CP-SAT claiming INFEASIBLE while a valid baseline exists is a contradiction and FAILS the run.
// ---------------------------------------------------------------------------

/** What the SolverClient (Phase 3) reports about the child process, before any output is interpreted. */
export type SolverAttempt =
  | SolverOutputInterpretation
  /** The process exceeded its kill deadline and was terminated by the backend. */
  | { kind: 'KILLED_BY_WATCHDOG' }
  /** The process could not run or ended abnormally (spawn failure, crash, non-zero exit, no output). */
  | { kind: 'PROCESS_FAULT'; code: 'SOLVER_UNAVAILABLE' | 'SOLVER_CRASHED'; message: string };

export type GenerationOutcome =
  | {
      kind: 'SUCCESS';
      solutionSource: 'CP_SAT' | 'BASELINE';
      /** The CP-SAT outcome. UNKNOWN when the baseline was used. */
      solverStatus: 'OPTIMAL' | 'FEASIBLE' | 'UNKNOWN';
      /** OPTIMAL means proven best; FEASIBLE is the normal result for medium and large schools. */
      optimal: boolean;
      entries: TimetableEntryRow[];
      solverDiagnostics: SolverDiagnostics | null;
      /** Why the baseline was chosen, when it was. */
      fallbackReason: 'NO_SOLUTION_WITHIN_BUDGET' | 'KILLED_BY_WATCHDOG' | null;
    }
  | {
      kind: 'FAILURE';
      code: FailureCode;
      message: string;
      problems: ValidationProblem[];
      solverDiagnostics: SolverDiagnostics | null;
    };

/**
 * @param attempt  the interpreted solver result
 * @param baseline the VALIDATED baseline entries (the caller must have validated them before the solver ran)
 */
export function decideOutcome(attempt: SolverAttempt, baseline: readonly TimetableEntryRow[] | null): GenerationOutcome {
  // Phase 7E: with locked entries there may be no lock-aware baseline. The rule below is then applied WITHOUT a baseline; with a baseline
  // (always the case without locks) nothing here differs from before.
  if (baseline === null) return decideWithoutBaseline(attempt);
  switch (attempt.kind) {
    case 'SOLUTION':
      return {
        kind: 'SUCCESS',
        solutionSource: 'CP_SAT',
        solverStatus: attempt.status,
        optimal: attempt.status === 'OPTIMAL',
        entries: [...attempt.entries],
        solverDiagnostics: attempt.diagnostics,
        fallbackReason: null,
      };
    case 'NO_SOLUTION':
      return {
        kind: 'SUCCESS',
        solutionSource: 'BASELINE',
        solverStatus: 'UNKNOWN',
        optimal: false,
        entries: [...baseline],
        solverDiagnostics: attempt.diagnostics,
        fallbackReason: 'NO_SOLUTION_WITHIN_BUDGET',
      };
    case 'KILLED_BY_WATCHDOG':
      return {
        kind: 'SUCCESS',
        solutionSource: 'BASELINE',
        solverStatus: 'UNKNOWN',
        optimal: false,
        entries: [...baseline],
        solverDiagnostics: null,
        fallbackReason: 'KILLED_BY_WATCHDOG',
      };
    case 'INFEASIBLE':
      return {
        kind: 'FAILURE',
        code: 'INTERNAL_INCONSISTENCY',
        message: 'The solver reported INFEASIBLE although a valid baseline timetable exists',
        problems: [],
        solverDiagnostics: attempt.diagnostics,
      };
    case 'FAULT':
      return {
        kind: 'FAILURE',
        code: attempt.code,
        message: attempt.message,
        problems: attempt.problems,
        solverDiagnostics: attempt.diagnostics,
      };
    case 'PROCESS_FAULT':
      return { kind: 'FAILURE', code: attempt.code, message: attempt.message, problems: [], solverDiagnostics: null };
  }
}

/**
 * Phase 7E: the outcome when locked entries exist and no valid lock-aware baseline could be produced. A clean UNKNOWN or a killed solver
 * then yields NO_SOLUTION_WITH_LOCKS (no lock-preserving timetable was produced: this does NOT mean infeasible), and INFEASIBLE is a
 * genuine INFEASIBLE_HARD_CONSTRAINTS (there is no baseline that would contradict it). A solution and every process or output fault keep
 * their usual meaning: nothing silently falls back.
 */
function decideWithoutBaseline(attempt: SolverAttempt): GenerationOutcome {
  switch (attempt.kind) {
    case 'NO_SOLUTION':
      return {
        kind: 'FAILURE',
        code: 'NO_SOLUTION_WITH_LOCKS',
        message: 'No timetable that keeps the locked lessons was found within the time budget. This does not prove that none exists',
        problems: [],
        solverDiagnostics: attempt.diagnostics,
      };
    case 'KILLED_BY_WATCHDOG':
      return {
        kind: 'FAILURE',
        code: 'NO_SOLUTION_WITH_LOCKS',
        message: 'The solver was stopped at its deadline before it produced a timetable that keeps the locked lessons. This does not prove that none exists',
        problems: [],
        solverDiagnostics: null,
      };
    case 'INFEASIBLE':
      return {
        kind: 'FAILURE',
        code: 'INFEASIBLE_HARD_CONSTRAINTS',
        message: 'The hard constraints cannot be satisfied while keeping the locked lessons (proven by the solver)',
        problems: [],
        solverDiagnostics: attempt.diagnostics,
      };
    default:
      // SOLUTION, FAULT, PROCESS_FAULT: none of them uses the baseline
      return decideOutcome(attempt, []);
  }
}
