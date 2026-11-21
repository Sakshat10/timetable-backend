import { z } from 'zod';

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------
export const feasibilityQuerySchema = z.object({
  academicYearId: z.string({ error: 'academicYearId is required' }).uuid('Invalid academic year ID format'),
});

export type FeasibilityQueryBody = z.input<typeof feasibilityQuerySchema>;
export type FeasibilityQuery = z.output<typeof feasibilityQuerySchema>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum normal teaching workload of a teacher, in periods per week (business rule). */
export const MAX_TEACHER_PERIODS_PER_WEEK = 32;

export const READY_MEANING =
  'READY means every deterministic precondition checked here passes, so the configuration is ready to ' +
  'attempt timetable generation. It does NOT guarantee that a timetable exists; the solver may still ' +
  'find none. NOT_READY means at least one blocking error was found.';

export const NOT_CHECKED: string[] = [
  'Exact placement of every period into a (working day, period number) slot.',
  'Teacher and section collisions at specific slots. Only aggregate capacity bounds are checked: a section\'s ' +
    'weekly demand against the weekly slots, and a teacher\'s assigned load against min(32, weekly slots).',
  'Whether unassigned demand can be split into whole per-section blocks inside each eligible teacher\'s remaining ' +
    'capacity. The pooled capacity check is a max-flow relaxation that treats demand as divisible, so it can prove ' +
    'impossibility but cannot prove possibility.',
  'Distribution rules: spreading subjects across the week, repeated subjects on one day, consecutive teaching ' +
    'periods and free periods (soft constraints).',
  'Teacher workload balance, and base workload versus substitution workload.',
  'Locked periods and adjustment availability (future modules).',
  'Half-days, exam days and holidays (future calendar module).',
];

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------
export const ERROR_CODES = [
  'SCHEDULE_CONFIG_MISSING',
  'NO_WORKING_DAYS',
  'NO_PERIODS',
  'SCHEDULE_CONFIG_INVALID',
  'NO_SECTIONS',
  'NO_SUBJECT_REQUIREMENTS',
  'SECTION_CAPACITY_EXCEEDED',
  'REQUIREMENT_EXCEEDS_TEACHER_CAPACITY',
  // No longer emitted (explicit teacher assignments are optional); kept so existing clients that know the code do not break.
  'MISSING_TEACHER_ASSIGNMENT',
  'TEACHER_ALLOCATION_FAILED',
  'INVALID_ASSIGNMENT',
  'INACTIVE_ASSIGNED_TEACHER',
  'ASSIGNED_TEACHER_NOT_ELIGIBLE',
  'TEACHER_CAPACITY_EXCEEDED',
  'NO_ELIGIBLE_TEACHER',
  'ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT',
] as const;

export const WARNING_CODES = [
  'SECTION_HAS_NO_REQUIREMENTS',
  'REQUIREMENT_HAS_NO_SECTIONS',
  'MIXED_GRADE_MODE',
  'SECTION_AT_FULL_CAPACITY',
  'TEACHER_AT_FULL_CAPACITY',
  'TEACHER_AUTO_ASSIGNED',
  'ACADEMIC_YEAR_NOT_DRAFT',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
export type WarningCode = (typeof WARNING_CODES)[number];

export interface FeasibilityEntity {
  type:
    | 'ACADEMIC_YEAR'
    | 'SCHEDULE_CONFIG'
    | 'GRADE'
    | 'SECTION'
    | 'REQUIREMENT'
    | 'ASSIGNMENT'
    | 'TEACHER'
    | 'SUBJECT_GROUP'
    | 'SUBJECT_GROUPS';
  id: string | null;
  label: string;
}

export interface FeasibilityIssue {
  code: ErrorCode | WarningCode;
  severity: 'ERROR' | 'WARNING';
  message: string;
  hint: string;
  entity: FeasibilityEntity;
  details: Record<string, unknown>;
}

export interface SectionBreakdownRow {
  id: string;
  label: string;
  gradeId: string;
  gradeName: string;
  streamId: string | null;
  streamName: string | null;
  requirementCount: number;
  demandPeriods: number;
  assignedPeriods: number;
  unassignedPeriods: number;
  weeklySlots: number | null;
}

export interface TeacherBreakdownRow {
  id: string;
  name: string;
  isActive: boolean;
  belongsToSchool: boolean;
  assignmentCount: number;
  assignedPeriods: number;
  capacity: number;
  remainingCapacity: number;
}

export interface SubjectGroupBreakdownRow {
  gradeId: string;
  gradeName: string;
  subjectId: string;
  subjectName: string;
  sectionCount: number;
  demandPeriods: number;
  assignedPeriods: number;
  unassignedPeriods: number;
  eligibleTeacherCount: number;
  eligibleRemainingCapacity: number;
}

export interface FeasibilityReportCore {
  academicYear: { id: string; name: string; status: 'DRAFT' | 'ACTIVE' | 'COMPLETED' };
  status: 'READY' | 'NOT_READY';
  statusMeaning: string;
  limits: {
    maxTeacherPeriodsPerWeek: number;
    weeklySlots: number | null;
    effectiveTeacherCapacity: number;
  };
  summary: {
    workingDays: number;
    periodsPerDay: number;
    weeklySlots: number | null;
    grades: number;
    sections: number;
    requirements: number;
    assignments: number;
    totalDemandPeriods: number;
    assignedPeriods: number;
    unassignedPeriods: number;
    teachersWithAssignments: number;
    errorCount: number;
    warningCount: number;
  };
  errors: FeasibilityIssue[];
  warnings: FeasibilityIssue[];
  breakdown: {
    sections: SectionBreakdownRow[];
    teachers: TeacherBreakdownRow[];
    subjectGroups: SubjectGroupBreakdownRow[];
  };
  notChecked: string[];
}

export interface FeasibilityReport extends FeasibilityReportCore {
  generatedAt: string;
}
