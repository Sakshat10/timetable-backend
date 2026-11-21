import { type Staleness } from './timetable-version.edit-core.js';

// ---------------------------------------------------------------------------
// Phase 7F-3: staleness information for listings and clones. PURE helpers (no database).
//
// The decision itself is NOT made here: it is `assessStaleness` of Phase 7D (the strict rule D3: the live configuration, freshly normalized, must
// hash to exactly the configuration hash of the version's stored snapshot). This file only shapes the answer and groups the work.
// ---------------------------------------------------------------------------

/** The reasons GET .../validation reports, plus the two this information can add: the stored snapshot cannot be read, or the assessment itself failed. */
export type StalenessReason = Staleness['reason'] | 'SNAPSHOT_UNUSABLE' | 'ASSESSMENT_FAILED';

export interface StalenessInfo {
  /** true: the live configuration is not the one the timetable was generated from. null: it could not be established (see `reason`). */
  isStale: boolean | null;
  reason: StalenessReason;
}

export const fromAssessment = (assessment: Staleness): StalenessInfo => ({ isStale: assessment.stale, reason: assessment.reason });
export const unusableSnapshot = (): StalenessInfo => ({ isStale: null, reason: 'SNAPSHOT_UNUSABLE' });
export const assessmentFailed = (): StalenessInfo => ({ isStale: null, reason: 'ASSESSMENT_FAILED' });

/**
 * Versions with the same input hash have the same stored snapshot (the hash IS the hash of the snapshot's core, and a clone copies both), so
 * their staleness is the same answer. One representative per hash is enough to assess; every version of that hash receives the result.
 */
export function groupByInputHash(rows: ReadonlyArray<{ id: string; inputHash: string }>): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const ids = groups.get(r.inputHash);
    if (ids) ids.push(r.id); else groups.set(r.inputHash, [r.id]);
  }
  return groups;
}

/** Spread the answer for each hash to every version that has it. */
export function spreadByHash(groups: ReadonlyMap<string, string[]>, answers: ReadonlyMap<string, StalenessInfo>): Map<string, StalenessInfo> {
  const out = new Map<string, StalenessInfo>();
  for (const [hash, ids] of groups) {
    const info = answers.get(hash);
    if (info) for (const id of ids) out.set(id, info);
  }
  return out;
}
