import { z } from 'zod';
import { DAYS_OF_WEEK } from '../schedule-config/schedule-config.schema.js';
import { MAX_TEACHER_PERIODS_PER_WEEK } from '../timetable-feasibility/timetable-feasibility.schema.js';

// ---------------------------------------------------------------------------
// Module 11 contracts: the exact JSON exchanged between the Node backend and the Python solver, plus the
// constants that define the V1 objective. Pure data definitions: no database, no process, no I/O.
// ---------------------------------------------------------------------------

export { DAYS_OF_WEEK, MAX_TEACHER_PERIODS_PER_WEEK };
export type DayOfWeekName = (typeof DAYS_OF_WEEK)[number];

export const CONTRACT_VERSION = '1.0';

// ---------------------------------------------------------------------------
// Objective: WEIGHTS_V1 (frozen after Phase 0 benchmarking)
// ---------------------------------------------------------------------------
export const WEIGHTS_VERSION = 'V1';

export const TERM_NAMES = [
  'teacherRun3',
  'teacherRun4Plus',
  'subjectSameDayExcess',
  'sectionHoles',
  'dailyLoadExcess',
] as const;
export type TermName = (typeof TERM_NAMES)[number];
export type ObjectiveWeights = Readonly<Record<TermName, number>>;
export type TermCounts = Record<TermName, number>;

export const WEIGHTS_V1: ObjectiveWeights = Object.freeze({
  teacherRun3: 3,
  teacherRun4Plus: 8,
  subjectSameDayExcess: 5,
  sectionHoles: 4,
  dailyLoadExcess: 2,
});

// ---------------------------------------------------------------------------
// Failure codes (a run that ends FAILED carries exactly one of these)
// ---------------------------------------------------------------------------
export const FAILURE_CODES = [
  'NOT_READY',
  'YEAR_NOT_DRAFT',
  'INFEASIBLE_HARD_CONSTRAINTS',
  'SOLVER_UNAVAILABLE',
  'SOLVER_CRASHED',
  'SOLVER_INVALID_OUTPUT',
  'SOLVER_MODEL_INVALID',
  'SOLVER_INPUT_REJECTED',
  'INTERNAL_INCONSISTENCY',
  'CONFIGURATION_CHANGED',
  'PERSIST_FAILED',
  'WORKER_LOST',
  'QUEUE_EXPIRED',
  // Phase 7E (locked entries). LOCKS_INVALID: the frozen locks do not fit the fresh configuration (the detailed LOCKED_ENTRY_* issue codes are in
  // the diagnostics). NO_SOLUTION_WITH_LOCKS: no lock-preserving timetable was produced within the budget (UNKNOWN, no usable lock-aware
  // baseline): NOT a proof of infeasibility, which stays INFEASIBLE_HARD_CONSTRAINTS.
  'LOCKS_INVALID',
  'NO_SOLUTION_WITH_LOCKS',
  // Phase 7F-0: the academic year already holds MAX_DRAFTS_PER_YEAR draft versions, so the run (queued before the cap was reached, or under a
  // higher cap) creates nothing. Delete or publish a draft and generate again.
  'DRAFT_LIMIT_REACHED',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

// ---------------------------------------------------------------------------
// Solver input (Node -> Python). Ids and integers only: no names, e-mails, grades or streams.
// ---------------------------------------------------------------------------
const id = z.string().min(1).max(100);
const dayOfWeek = z.enum(DAYS_OF_WEEK);

const MAX_SECTIONS = 2_000;
const MAX_TEACHERS = 5_000;
const MAX_ASSIGNMENTS = 50_000;
const MAX_ENTRIES = 500_000;
const MAX_WORKERS = 64;
const MAX_TIME_LIMIT_CEILING = 3_600;

export const objectiveWeightsSchema = z.strictObject({
  teacherRun3: z.int().min(0).max(1_000),
  teacherRun4Plus: z.int().min(0).max(1_000),
  subjectSameDayExcess: z.int().min(0).max(1_000),
  sectionHoles: z.int().min(0).max(1_000),
  dailyLoadExcess: z.int().min(0).max(1_000),
});

export const solverOptionsSchema = z.strictObject({
  timeLimitSeconds: z.int().min(1).max(MAX_TIME_LIMIT_CEILING),
  seed: z.int().min(0).max(2_147_483_647),
  numWorkers: z.int().min(1).max(MAX_WORKERS),
  reproducible: z.boolean(),
  /** Only used when reproducible: CP-SAT deterministic-time budget (a wall-clock limit stays as a backstop). */
  deterministicTimeLimit: z.number().positive().max(MAX_TIME_LIMIT_CEILING).nullable(),
});

export const gridSchema = z.strictObject({
  days: z
    .array(z.strictObject({ index: z.int().min(0).max(6), dayOfWeek }))
    .min(1)
    .max(7),
  periods: z
    .array(z.strictObject({ periodNumber: z.int().min(1).max(12), continuesIntoNext: z.boolean() }))
    .min(1)
    .max(12),
  maxTeacherPeriodsPerWeek: z.int().min(1).max(MAX_TEACHER_PERIODS_PER_WEEK),
});

export const assignmentSchema = z.strictObject({
  id,
  sectionId: id,
  subjectId: id,
  subjectRequirementId: id,
  teacherId: id,
  periodsPerWeek: z.int().min(1).max(100),
});

/** Locked periods (Phase 7E). Empty unless a generation was started from a draft's locked lessons. */
export const fixedEntrySchema = z.strictObject({
  assignmentId: id,
  dayOfWeek,
  periodNumber: z.int().min(1).max(12),
});

export const solverInputSchema = z.strictObject({
  contractVersion: z.literal(CONTRACT_VERSION),
  requestId: id,
  options: solverOptionsSchema,
  weightsVersion: z.string().min(1).max(20),
  weights: objectiveWeightsSchema,
  grid: gridSchema,
  sections: z.array(z.strictObject({ id })).min(1).max(MAX_SECTIONS),
  teachers: z
    .array(z.strictObject({ id, weeklyCapacity: z.int().min(1).max(MAX_TEACHER_PERIODS_PER_WEEK) }))
    .min(1)
    .max(MAX_TEACHERS),
  assignments: z.array(assignmentSchema).min(1).max(MAX_ASSIGNMENTS),
  fixedEntries: z.array(fixedEntrySchema).max(MAX_ENTRIES),
});

export type SolverInput = z.infer<typeof solverInputSchema>;
export type SolverOptions = z.infer<typeof solverOptionsSchema>;
export type SolverAssignment = z.infer<typeof assignmentSchema>;

/** The part of the solver input that defines the scheduling problem (hashed; excludes per-run options). */
export type SolverProblemCore = Pick<
  SolverInput,
  'contractVersion' | 'grid' | 'sections' | 'teachers' | 'assignments' | 'fixedEntries'
>;

// ---------------------------------------------------------------------------
// Solver output (Python -> Node). Entries carry the ids redundantly so the backend can cross-check every row.
// ---------------------------------------------------------------------------
export const SOLVER_STATUSES = ['OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN', 'MODEL_INVALID', 'INPUT_INVALID'] as const;
export type SolverStatus = (typeof SOLVER_STATUSES)[number];

export const timetableEntrySchema = z.strictObject({
  assignmentId: id,
  sectionId: id,
  subjectId: id,
  teacherId: id,
  dayOfWeek,
  periodNumber: z.int(),
});
export type TimetableEntryRow = z.infer<typeof timetableEntrySchema>;

/** Diagnostic only. NEVER the authoritative quality metric (one-sided soft variables can carry slack). */
export const solverDiagnosticsSchema = z.strictObject({
  objectiveValue: z.number().nullable(),
  bestObjectiveBound: z.number().nullable(),
  wallSeconds: z.number().min(0),
  numWorkers: z.int().min(0),
  seed: z.int(),
  ortoolsVersion: z.string().max(50),
  numBooleans: z.int().min(0).nullable(),
  numConstraints: z.int().min(0).nullable(),
  conflicts: z.int().min(0).nullable(),
  branches: z.int().min(0).nullable(),
  stoppedBy: z.enum(['OPTIMAL', 'TIME_LIMIT', 'DETERMINISTIC_LIMIT', 'INFEASIBLE', 'ERROR', 'NONE', 'LIMIT_AMBIGUOUS']),
  messages: z.array(z.string().max(500)).max(50),
});
export type SolverDiagnostics = z.infer<typeof solverDiagnosticsSchema>;

export const solverOutputSchema = z.strictObject({
  contractVersion: z.literal(CONTRACT_VERSION),
  requestId: id,
  status: z.enum(SOLVER_STATUSES),
  entries: z.array(timetableEntrySchema).max(MAX_ENTRIES),
  diagnostics: solverDiagnosticsSchema,
});
export type SolverOutput = z.infer<typeof solverOutputSchema>;
