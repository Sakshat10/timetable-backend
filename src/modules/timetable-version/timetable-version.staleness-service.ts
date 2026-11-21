import { type PrismaClient } from '@prisma/client';
import prisma from '../../config/database.js';
import { loadGenerationSnapshot } from '../timetable-generation/timetable-generation.loader.js';
import { assessStaleness, problemFromCore, SnapshotUnusableError } from './timetable-version.edit-core.js';
import { normalizeConfiguration } from './timetable-version.publish-service.js';
import { fromAssessment, groupByInputHash, spreadByHash, unusableSnapshot, type StalenessInfo } from './timetable-version.staleness-core.js';

/**
 * Phase 7F-3: staleness of many versions of ONE academic year, with the SAME rule and helpers as GET /timetable-versions/:id/validation:
 * the version's stored core is rebuilt (`problemFromCore`), the live configuration is read and normalized the way publish does
 * (`normalizeConfiguration`), and `assessStaleness` compares their configuration hashes. READ-ONLY: no lock, nothing written, no hash changed.
 *
 * Cost: ONE live-configuration read and normalization for the whole call (not per version), and ONE stored snapshot per DISTINCT input hash
 * (clones and regenerations of the same configuration share a hash and are assessed once). The caller is responsible for the school and year
 * checks; every query here is scoped by both anyway.
 */
export class TimetableVersionStalenessService {
  constructor(private readonly db: PrismaClient = prisma) {}

  async assess(schoolId: string, academicYearId: string, versionIds: readonly string[]): Promise<Map<string, StalenessInfo>> {
    if (versionIds.length === 0) return new Map();
    const hashes = await this.db.$queryRaw<Array<{ id: string; inputHash: string }>>`
      SELECT "id", "inputHash" FROM "timetable_versions" WHERE "id" = ANY(${[...versionIds]}) AND "schoolId" = ${schoolId} AND "academicYearId" = ${academicYearId}`;
    const groups = groupByInputHash(hashes);
    if (groups.size === 0) return new Map();

    // one stored snapshot (the oldest version's) per distinct hash
    const snapshots = await this.db.$queryRaw<Array<{ inputHash: string; inputSnapshot: unknown }>>`
      SELECT DISTINCT ON ("inputHash") "inputHash", "inputSnapshot" FROM "timetable_versions"
      WHERE "id" = ANY(${hashes.map((h) => h.id)}) AND "schoolId" = ${schoolId} AND "academicYearId" = ${academicYearId}
      ORDER BY "inputHash", "versionNumber"`;

    // the live configuration, once
    const live = await loadGenerationSnapshot(this.db, schoolId, academicYearId);
    const normalized = normalizeConfiguration(live);
    const freshCore = normalized.ok ? normalized.problem.core : null;

    const answers = new Map<string, StalenessInfo>();
    for (const s of snapshots) {
      try {
        const problem = problemFromCore(s.inputSnapshot, { schoolId, academicYear: { id: academicYearId, name: live.academicYear.name } });
        answers.set(s.inputHash, fromAssessment(assessStaleness(problem.core, freshCore)));
      } catch (error) {
        if (error instanceof SnapshotUnusableError) answers.set(s.inputHash, unusableSnapshot());
        else throw error;
      }
    }
    return spreadByHash(groups, answers);
  }
}

export const timetableVersionStalenessService = new TimetableVersionStalenessService();
