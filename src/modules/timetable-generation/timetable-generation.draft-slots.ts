import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Phase 7F-0: the per-academic-year DRAFT cap.
//
// Invariant:   drafts(year) + activeRuns(year) <= MAX_DRAFTS_PER_YEAR     (an active run is a reservation of one future draft)
//
// Every path that CREATES a draft, or RESERVES one (queues a run), takes the year's "draft-slot" lock and counts under it:
//
//   * generation enqueue : refused when drafts >= cap                (the run being queued becomes the reservation)
//   * generation persist : refused when drafts >= cap                (the run's own reservation is consumed by the draft it creates)
//   * clone (7F-2)       : refused when drafts + activeRuns >= cap   (a clone consumes a slot a queued run may be waiting for)
//
// The lock is a transaction-scoped advisory lock keyed by the year. It is the ONLY thing that serialises the creators among
// themselves: the year row lock does not (generation persistence holds it FOR SHARE, which two holders can share), and changing that
// lock mode would make Module 9 schedule edits and the version editor wait on every persist.
//
// Rules every caller must keep:
//   1. Lock ORDER: the year row first (whatever mode the caller already used), then this lock, and it is the LAST lock taken before the
//      writes. Nothing that holds it ever waits for a lock another creator holds, so it cannot take part in a deadlock cycle.
//   2. The lock statement and the count are SEPARATE statements. Under READ COMMITTED a statement sees what was committed when IT
//      started, so a count that starts after the lock was granted sees the previous holder's commit.
//   3. The lock lives to the end of the transaction (xact lock): commit or rollback releases it, even through a pooler.
//   4. The caller's transaction should set a lock_timeout so a wait is bounded.
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_DRAFTS_PER_YEAR = 20;

/** First key of the two-integer advisory lock form (a key space separate from the single-bigint form used by the queue-size lock). */
export const DRAFT_SLOT_LOCK_NAMESPACE = 7_411_002;

export type DraftSlotPurpose = 'ENQUEUE' | 'PERSIST' | 'CLONE';

export interface DraftSlots {
  drafts: number;
  activeRuns: number;
}

export type DraftSlotClaim = { ok: true; slots: DraftSlots } | { ok: false; slots: DraftSlots; max: number };

/** Take the year's draft-slot lock until the end of the transaction. Waits (bounded by the transaction's lock_timeout). */
export async function lockDraftSlots(tx: Prisma.TransactionClient, academicYearId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DRAFT_SLOT_LOCK_NAMESPACE}::int, hashtext(${academicYearId}))`;
}

/** Both counts from ONE statement (one snapshot). Meaningful for a decision only while the draft-slot lock is held. */
export async function readDraftSlots(tx: Prisma.TransactionClient, academicYearId: string): Promise<DraftSlots> {
  const rows = await tx.$queryRaw<Array<{ drafts: number; activeRuns: number }>>`
    SELECT
      (SELECT count(*) FROM "timetable_versions" WHERE "academicYearId" = ${academicYearId} AND "status" = 'DRAFT'::"TimetableVersionStatus")::int AS "drafts",
      (SELECT count(*) FROM "timetable_generation_runs" WHERE "academicYearId" = ${academicYearId} AND "status" IN ('QUEUED'::"TimetableRunStatus", 'RUNNING'::"TimetableRunStatus"))::int AS "activeRuns"`;
  return { drafts: rows[0]?.drafts ?? 0, activeRuns: rows[0]?.activeRuns ?? 0 };
}

/**
 * Whether one more draft (or reservation) is NOT allowed. `>=` everywhere: a year exactly at the cap admits nothing, and a year above it
 * (legacy data, or the cap lowered at a restart) admits nothing until deletes or publishes bring it below. Nothing is ever deleted for it.
 */
export function slotsExhausted(purpose: DraftSlotPurpose, slots: DraftSlots, max: number): boolean {
  return purpose === 'CLONE' ? slots.drafts + slots.activeRuns >= max : slots.drafts >= max;
}

/** Lock, then count (two statements, rule 2), then decide. */
export async function claimDraftSlot(tx: Prisma.TransactionClient, academicYearId: string, max: number, purpose: DraftSlotPurpose): Promise<DraftSlotClaim> {
  await lockDraftSlots(tx, academicYearId);
  const slots = await readDraftSlots(tx, academicYearId);
  return slotsExhausted(purpose, slots, max) ? { ok: false, slots, max } : { ok: true, slots };
}
