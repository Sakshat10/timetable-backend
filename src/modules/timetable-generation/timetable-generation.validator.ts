import { type NormalizedProblem } from './timetable-generation.normalizer.js';
import {
  CONTRACT_VERSION,
  solverOutputSchema,
  type SolverDiagnostics,
  type TimetableEntryRow,
} from './timetable-generation.contracts.js';

// ---------------------------------------------------------------------------
// Validators for solver output. Pure. The backend never persists anything these have not accepted, and the
// same checks are re-run in the persist transaction (Stage 3).
// ---------------------------------------------------------------------------

export const PROBLEM_CODES = [
  'CONTRACT_VIOLATION',
  'UNKNOWN_ASSIGNMENT',
  'ENTRY_ID_MISMATCH',
  'INVALID_DAY',
  'INVALID_PERIOD',
  'DUPLICATE_ENTRY',
  'SECTION_COLLISION',
  'TEACHER_COLLISION',
  'WRONG_PERIOD_COUNT',
  'TEACHER_OVER_CAPACITY',
  'ENTRY_COUNT_MISMATCH',
  // Phase 7E: a locked (fixed) lesson is not at the exact assignment / day / period it was fixed to
  'FIXED_ENTRY_VIOLATED',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

export interface ValidationProblem {
  code: ProblemCode;
  message: string;
  assignmentId?: string;
  sectionId?: string;
  teacherId?: string;
  dayOfWeek?: string;
  periodNumber?: number;
}

export interface ValidationResult {
  valid: boolean;
  /** At most MAX_REPORTED problems; problemCount is the true total. */
  problems: ValidationProblem[];
  problemCount: number;
}

const MAX_REPORTED = 100;

/**
 * Check a COMPLETE timetable against the problem: every row traces to an assignment with matching ids, uses a
 * valid slot, creates no section or teacher collision, every assignment has exactly periodsPerWeek rows and no
 * teacher exceeds the weekly limit.
 */
export function validateEntries(problem: NormalizedProblem, entries: readonly TimetableEntryRow[]): ValidationResult {
  const problems: ValidationProblem[] = [];
  let count = 0;
  const report = (problem_: ValidationProblem): void => {
    count++;
    if (problems.length < MAX_REPORTED) problems.push(problem_);
  };

  const { periodsPerDay, weeklySlots: W } = problem.derived;
  const dayIndex = new Map(problem.core.grid.days.map((d) => [d.dayOfWeek as string, d.index]));
  const assignments = new Map(problem.core.assignments.map((a) => [a.id, a]));
  const sectionIndex = new Map(problem.core.sections.map((s, i) => [s.id, i]));
  const teacherIndex = new Map(problem.core.teachers.map((t, i) => [t.id, i]));
  const teacherLimit = new Map(problem.core.teachers.map((t) => [t.id, Math.min(t.weeklyCapacity, W)]));

  const sectionSlots = new Set<number>();
  const teacherSlots = new Set<number>();
  const assignmentSlots = new Set<string>();
  const perAssignment = new Map<string, number>();
  const perTeacher = new Map<string, number>();

  if (entries.length !== problem.derived.expectedEntryCount) {
    report({
      code: 'ENTRY_COUNT_MISMATCH',
      message: `Expected ${problem.derived.expectedEntryCount} entries but received ${entries.length}`,
    });
  }

  for (const entry of entries) {
    const assignment = assignments.get(entry.assignmentId);
    if (!assignment) {
      report({ code: 'UNKNOWN_ASSIGNMENT', message: 'Entry does not belong to any assignment', assignmentId: entry.assignmentId });
      continue;
    }
    if (
      entry.sectionId !== assignment.sectionId ||
      entry.subjectId !== assignment.subjectId ||
      entry.teacherId !== assignment.teacherId
    ) {
      report({
        code: 'ENTRY_ID_MISMATCH',
        message: 'Entry section, subject or teacher differs from its assignment',
        assignmentId: entry.assignmentId,
        sectionId: entry.sectionId,
        teacherId: entry.teacherId,
      });
      continue;
    }
    const day = dayIndex.get(entry.dayOfWeek);
    if (day === undefined) {
      report({ code: 'INVALID_DAY', message: `${entry.dayOfWeek} is not a working day`, assignmentId: entry.assignmentId, dayOfWeek: entry.dayOfWeek });
      continue;
    }
    if (!Number.isInteger(entry.periodNumber) || entry.periodNumber < 1 || entry.periodNumber > periodsPerDay) {
      report({
        code: 'INVALID_PERIOD',
        message: `Period ${entry.periodNumber} is outside 1..${periodsPerDay}`,
        assignmentId: entry.assignmentId,
        periodNumber: entry.periodNumber,
      });
      continue;
    }
    const slot = day * periodsPerDay + (entry.periodNumber - 1);

    const assignmentKey = `${entry.assignmentId}|${slot}`;
    if (assignmentSlots.has(assignmentKey)) {
      report({
        code: 'DUPLICATE_ENTRY',
        message: 'The same assignment is placed twice in one slot',
        assignmentId: entry.assignmentId,
        dayOfWeek: entry.dayOfWeek,
        periodNumber: entry.periodNumber,
      });
      continue;
    }
    assignmentSlots.add(assignmentKey);

    const sectionKey = sectionIndex.get(entry.sectionId)! * W + slot;
    if (sectionSlots.has(sectionKey)) {
      report({
        code: 'SECTION_COLLISION',
        message: 'A section has two lessons in the same slot',
        sectionId: entry.sectionId,
        dayOfWeek: entry.dayOfWeek,
        periodNumber: entry.periodNumber,
      });
    }
    sectionSlots.add(sectionKey);

    const teacherKey = teacherIndex.get(entry.teacherId)! * W + slot;
    if (teacherSlots.has(teacherKey)) {
      report({
        code: 'TEACHER_COLLISION',
        message: 'A teacher teaches two lessons in the same slot',
        teacherId: entry.teacherId,
        dayOfWeek: entry.dayOfWeek,
        periodNumber: entry.periodNumber,
      });
    }
    teacherSlots.add(teacherKey);

    perAssignment.set(entry.assignmentId, (perAssignment.get(entry.assignmentId) ?? 0) + 1);
    perTeacher.set(entry.teacherId, (perTeacher.get(entry.teacherId) ?? 0) + 1);
  }

  for (const assignment of problem.core.assignments) {
    const placed = perAssignment.get(assignment.id) ?? 0;
    if (placed !== assignment.periodsPerWeek) {
      report({
        code: 'WRONG_PERIOD_COUNT',
        message: `Assignment has ${placed} periods but needs exactly ${assignment.periodsPerWeek}`,
        assignmentId: assignment.id,
      });
    }
  }
  for (const [teacherId, load] of perTeacher) {
    const limit = teacherLimit.get(teacherId) ?? 0;
    if (load > limit) {
      report({ code: 'TEACHER_OVER_CAPACITY', message: `Teacher has ${load} periods; the limit is ${limit}`, teacherId });
    }
  }

  // Phase 7E: every fixed (locked) entry must be present at exactly its assignment, day and period. Does nothing when there are none,
  // so every problem without locks is validated exactly as before.
  if (problem.core.fixedEntries.length > 0) {
    const present = new Set(entries.map((e) => `${e.assignmentId}|${e.dayOfWeek}|${e.periodNumber}`));
    for (const fixed of problem.core.fixedEntries) {
      if (!present.has(`${fixed.assignmentId}|${fixed.dayOfWeek}|${fixed.periodNumber}`)) {
        report({
          code: 'FIXED_ENTRY_VIOLATED',
          message: 'A locked lesson is not at the slot it was locked to',
          assignmentId: fixed.assignmentId,
          dayOfWeek: fixed.dayOfWeek,
          periodNumber: fixed.periodNumber,
        });
      }
    }
  }

  return { valid: count === 0, problems, problemCount: count };
}

// ---------------------------------------------------------------------------
// Interpreting what came back from the solver process
// ---------------------------------------------------------------------------
export type SolverFaultCode = 'SOLVER_INVALID_OUTPUT' | 'SOLVER_MODEL_INVALID' | 'SOLVER_INPUT_REJECTED';

export type SolverOutputInterpretation =
  /** CP-SAT produced a complete timetable that passed validation. */
  | { kind: 'SOLUTION'; status: 'OPTIMAL' | 'FEASIBLE'; entries: TimetableEntryRow[]; diagnostics: SolverDiagnostics }
  /** CP-SAT ran to its budget and found nothing usable (UNKNOWN). */
  | { kind: 'NO_SOLUTION'; diagnostics: SolverDiagnostics }
  /** CP-SAT claims infeasibility. */
  | { kind: 'INFEASIBLE'; diagnostics: SolverDiagnostics }
  /** The output cannot be trusted: malformed, incoherent, or the solver rejected / mis-built the model. */
  | { kind: 'FAULT'; code: SolverFaultCode; message: string; problems: ValidationProblem[]; diagnostics: SolverDiagnostics | null };

/**
 * Parse and validate the raw JSON a solver process printed. Never throws. The distinction it encodes is the
 * one the run lifecycle depends on: only a clean UNKNOWN ("no usable solution within the budget") may be
 * answered with the baseline; every kind of broken or untrustworthy output is a FAULT.
 */
export function interpretSolverOutput(problem: NormalizedProblem, requestId: string, raw: unknown): SolverOutputInterpretation {
  const parsed = solverOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: 'FAULT',
      code: 'SOLVER_INVALID_OUTPUT',
      message: 'Solver output does not match the contract',
      problems: parsed.error.issues.slice(0, 20).map((issue) => ({
        code: 'CONTRACT_VIOLATION' as const,
        message: `${issue.path.join('.') || '(root)'}: ${issue.message}`.slice(0, 300),
      })),
      diagnostics: null,
    };
  }
  const output = parsed.data;
  const fault = (code: SolverFaultCode, message: string, problems: ValidationProblem[] = []): SolverOutputInterpretation => ({
    kind: 'FAULT',
    code,
    message,
    problems,
    diagnostics: output.diagnostics,
  });

  if (output.contractVersion !== CONTRACT_VERSION) {
    return fault('SOLVER_INVALID_OUTPUT', `Unsupported contract version ${output.contractVersion}`);
  }
  if (output.requestId !== requestId) {
    return fault('SOLVER_INVALID_OUTPUT', 'Solver output belongs to a different request');
  }

  switch (output.status) {
    case 'OPTIMAL':
    case 'FEASIBLE': {
      const validation = validateEntries(problem, output.entries);
      if (!validation.valid) {
        return fault('SOLVER_INVALID_OUTPUT', `Solver returned an invalid timetable (${validation.problemCount} problems)`, validation.problems);
      }
      return { kind: 'SOLUTION', status: output.status, entries: output.entries, diagnostics: output.diagnostics };
    }
    case 'UNKNOWN':
      if (output.entries.length > 0) return fault('SOLVER_INVALID_OUTPUT', 'Status UNKNOWN but entries were returned');
      return { kind: 'NO_SOLUTION', diagnostics: output.diagnostics };
    case 'INFEASIBLE':
      if (output.entries.length > 0) return fault('SOLVER_INVALID_OUTPUT', 'Status INFEASIBLE but entries were returned');
      return { kind: 'INFEASIBLE', diagnostics: output.diagnostics };
    case 'MODEL_INVALID':
      return fault('SOLVER_MODEL_INVALID', 'The solver reported its own model as invalid');
    case 'INPUT_INVALID':
      return fault('SOLVER_INPUT_REJECTED', 'The solver rejected the input the backend sent');
  }
}
