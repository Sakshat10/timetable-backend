import { analyzeFeasibility } from './timetable-feasibility.analyzer.js';
import { loadSchedulingInput } from './timetable-feasibility.loader.js';
import { type FeasibilityReport } from './timetable-feasibility.schema.js';

export class TimetableFeasibilityService {
  /**
   * Compute the timetable-readiness report of an academic year of the admin's school.
   *
   * Read-only and stateless: nothing is persisted, so the same database state always yields the
   * same report (only generatedAt differs). Allowed for DRAFT, ACTIVE and COMPLETED years.
   * READY means the deterministic preconditions pass; it does not guarantee a timetable exists.
   */
  async checkFeasibility(schoolId: string, academicYearId: string): Promise<FeasibilityReport> {
    const input = await loadSchedulingInput(schoolId, academicYearId);
    const report = analyzeFeasibility(input);
    return { ...report, generatedAt: new Date().toISOString() };
  }
}

export const timetableFeasibilityService = new TimetableFeasibilityService();
