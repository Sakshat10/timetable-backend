// Pure fixtures for problem cores (no database). Shared by the Phase 7E pure tests.
import { problemFromCore } from '../../src/modules/timetable-version/timetable-version.edit-core.js';
import { type SolverProblemCore } from '../../src/modules/timetable-generation/timetable-generation.contracts.js';
import { type NormalizedProblem } from '../../src/modules/timetable-generation/timetable-generation.normalizer.js';

export const WEEK_DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;

/** A deterministic problem core: `sections` sections, one teacher per subject, `periods[i]` periods per week for subject i. */
export function makeCore(sections: number, periods: number[], periodsPerDay = 6, days = 5): SolverProblemCore {
  const sectionIds = Array.from({ length: sections }, (_, i) => `sec-${i + 1}`);
  const teacherIds = periods.map((_, i) => `tea-${i + 1}`);
  const assignments = sectionIds.flatMap((s, si) => periods.map((p, i) => ({ id: `asg-${si + 1}-${i + 1}`, sectionId: s, subjectId: `sub-${i + 1}`, subjectRequirementId: `req-${i + 1}`, teacherId: teacherIds[i]!, periodsPerWeek: p })));
  return {
    contractVersion: '1.0',
    grid: { days: WEEK_DAYS.slice(0, days).map((dayOfWeek, index) => ({ index, dayOfWeek })), periods: Array.from({ length: periodsPerDay }, (_, k) => ({ periodNumber: k + 1, continuesIntoNext: false })), maxTeacherPeriodsPerWeek: 32 },
    sections: sectionIds.map((id) => ({ id })),
    teachers: teacherIds.map((id) => ({ id, weeklyCapacity: Math.min(32, days * periodsPerDay) })),
    assignments,
    fixedEntries: [],
  } as unknown as SolverProblemCore;
}

export const FIXTURE_CONTEXT = { schoolId: 'school-1', academicYear: { id: 'year-1', name: 'Y' } };

export function problemOfCore(core: SolverProblemCore): NormalizedProblem {
  return problemFromCore(JSON.parse(JSON.stringify(core)), FIXTURE_CONTEXT);
}

/** The cores used by the no-lock compatibility golden (baseline output and input hash must never change). */
export const GOLDEN_CORES: Array<{ name: string; core: () => SolverProblemCore }> = [
  { name: 'sparse-3x[5,4,3]', core: () => makeCore(3, [5, 4, 3]) },
  { name: 'dense-3x[9,9,10]', core: () => makeCore(3, [9, 9, 10]) },
  { name: 'full-2x[10,10,10]', core: () => makeCore(2, [10, 10, 10]) },
  { name: 'tight-3x[6,6,6,6,5]', core: () => makeCore(3, [6, 6, 6, 6, 5]) },
  { name: 'wide-6x[3,3,3,3,3,3,3,2]-8p-6d', core: () => makeCore(6, [3, 3, 3, 3, 3, 3, 3, 2], 8, 6) },
  { name: 'single-1x[1]', core: () => makeCore(1, [1]) },
];
export const GOLDEN_SEEDS = [1, 7, 42, 31337];
