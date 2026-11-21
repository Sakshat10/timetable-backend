import { type NormalizedProblem } from './timetable-generation.normalizer.js';
import { type TimetableEntryRow } from './timetable-generation.contracts.js';
import { buildBaseline, findCapacityViolations, sortEntries, type CapacityViolation } from './timetable-generation.baseline.js';

// ---------------------------------------------------------------------------
// Phase 7E: the lock-aware baseline. A SEPARATE path: `buildBaseline` (timetable-generation.baseline.ts) is untouched, so a problem
// without fixed entries gets exactly the baseline, and the same guarantee, it always had.
//
// Why a separate, best-effort path: without fixed slots the baseline is a proper edge-colouring of a bipartite multigraph (Konig),
// which always exists when every load fits. With some edges PRE-coloured (the locked lessons) the question is the bipartite
// precolouring-extension problem, which is NP-hard in general. So this builder is a bounded heuristic:
//   * fixed lessons are placed first and never move;
//   * the others are coloured one by one (a free colour at both ends, else an alternating-path flip that never touches a fixed edge);
//   * a bounded number of seeded restarts (a fixed count, never wall-clock, so the result is deterministic) is tried.
// It may therefore fail even when a timetable exists. A failure is NOT a proof of anything: the caller simply has no baseline and
// CP-SAT is the only producer. Whatever it returns is validated by the caller before it is trusted.
// ---------------------------------------------------------------------------

export type LockAwareBaselineResult =
  | { ok: true; entries: TimetableEntryRow[]; attempts: number }
  /** A teacher or section exceeds its weekly capacity: infeasible with or without locks (the same exact certificate as the plain baseline). */
  | { ok: false; reason: 'CAPACITY'; certificate: CapacityViolation[] }
  /** No placement was found within the bounded effort. NOT a proof of infeasibility. */
  | { ok: false; reason: 'NO_PLACEMENT_FOUND'; attempts: number };

export const DEFAULT_MAX_ATTEMPTS = 40;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

export function buildBaselineWithFixed(problem: NormalizedProblem, seed = 1, maxAttempts = DEFAULT_MAX_ATTEMPTS): LockAwareBaselineResult {
  // No locks: exactly the plain baseline (never reimplemented here).
  if (problem.core.fixedEntries.length === 0) {
    const plain = buildBaseline(problem, seed);
    return plain.ok ? { ok: true, entries: plain.entries, attempts: 1 } : { ok: false, reason: 'CAPACITY', certificate: plain.certificate };
  }

  const violations = findCapacityViolations(problem);
  if (violations.length > 0) return { ok: false, reason: 'CAPACITY', certificate: violations };

  const { periodsPerDay, weeklySlots: W } = problem.derived;
  const { assignments, teachers, sections, grid, fixedEntries } = problem.core;
  const teacherIndex = new Map(teachers.map((t, i) => [t.id, i]));
  const sectionIndex = new Map(sections.map((s, i) => [s.id, i]));
  const dayIndex = new Map(grid.days.map((d) => [d.dayOfWeek as string, d.index]));

  // one edge per lesson period; the first `fixedCount[a]` edges of an assignment are its locked lessons
  const edgeTeacher: number[] = [];
  const edgeSection: number[] = [];
  const edgeAssignment: number[] = [];
  const firstEdge: number[] = [];
  assignments.forEach((a, ai) => {
    firstEdge.push(edgeTeacher.length);
    for (let n = 0; n < a.periodsPerWeek; n++) {
      edgeTeacher.push(teacherIndex.get(a.teacherId)!);
      edgeSection.push(sectionIndex.get(a.sectionId)!);
      edgeAssignment.push(ai);
    }
  });
  const edgeCount = edgeTeacher.length;
  const assignmentIndex = new Map(assignments.map((a, i) => [a.id, i]));

  const fixedSlot = new Int32Array(edgeCount).fill(-1); // the slot a locked edge is pinned to, or -1
  const usedForAssignment = new Map<number, number>();
  for (const f of fixedEntries) {
    const ai = assignmentIndex.get(f.assignmentId);
    const di = dayIndex.get(f.dayOfWeek);
    if (ai === undefined || di === undefined) return { ok: false, reason: 'NO_PLACEMENT_FOUND', attempts: 0 }; // cannot happen for a normalized problem
    const n = usedForAssignment.get(ai) ?? 0;
    if (n >= assignments[ai]!.periodsPerWeek) return { ok: false, reason: 'NO_PLACEMENT_FOUND', attempts: 0 };
    usedForAssignment.set(ai, n + 1);
    fixedSlot[firstEdge[ai]! + n] = di * periodsPerDay + (f.periodNumber - 1);
  }

  const teacherLoad = new Map<number, number>();
  const sectionDemand = new Map<number, number>();
  for (let e = 0; e < edgeCount; e++) {
    teacherLoad.set(edgeTeacher[e]!, (teacherLoad.get(edgeTeacher[e]!) ?? 0) + 1);
    sectionDemand.set(edgeSection[e]!, (sectionDemand.get(edgeSection[e]!) ?? 0) + 1);
  }
  const freeEdges: number[] = [];
  for (let e = 0; e < edgeCount; e++) if (fixedSlot[e] === -1) freeEdges.push(e);
  // most constrained first (stable, so attempt 0 is deterministic without any randomness in the order)
  const constrained = [...freeEdges].sort((x, y) => {
    const wx = teacherLoad.get(edgeTeacher[x]!)! + sectionDemand.get(edgeSection[x]!)!;
    const wy = teacherLoad.get(edgeTeacher[y]!)! + sectionDemand.get(edgeSection[y]!)!;
    return wy !== wx ? wy - wx : x - y;
  });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const random = mulberry32((seed + 1) * 2654435761 + attempt * 40503);
    const teacherColour = new Int32Array(teachers.length * W).fill(-1);
    const sectionColour = new Int32Array(sections.length * W).fill(-1);
    const edgeColour = new Int32Array(edgeCount).fill(-1);

    let consistent = true;
    for (let e = 0; e < edgeCount && consistent; e++) {
      const c = fixedSlot[e]!;
      if (c === -1) continue;
      if (teacherColour[edgeTeacher[e]! * W + c] !== -1 || sectionColour[edgeSection[e]! * W + c] !== -1) consistent = false; // two locks collide
      edgeColour[e] = c;
      teacherColour[edgeTeacher[e]! * W + c] = e;
      sectionColour[edgeSection[e]! * W + c] = e;
    }
    if (!consistent) return { ok: false, reason: 'NO_PLACEMENT_FOUND', attempts: attempt + 1 };

    const order = attempt === 0 ? constrained : shuffle([...freeEdges], random);
    let failed = false;
    for (const e of order) {
      const t = edgeTeacher[e]!;
      const s = edgeSection[e]!;
      const bothFree: number[] = [];
      const freeAtTeacher: number[] = [];
      const freeAtSection: number[] = [];
      for (let c = 0; c < W; c++) {
        const ft = teacherColour[t * W + c] === -1;
        const fs = sectionColour[s * W + c] === -1;
        if (ft && fs) bothFree.push(c);
        else if (ft) freeAtTeacher.push(c);
        else if (fs) freeAtSection.push(c);
      }
      let colour = -1;
      if (bothFree.length > 0) {
        colour = bothFree[Math.floor(random() * bothFree.length)]!;
      } else {
        // alternating-path flips (a free at the teacher, b free at the section); never through a locked edge
        const pairs: Array<[number, number]> = [];
        for (const a of freeAtTeacher) for (const b of freeAtSection) pairs.push([a, b]);
        shuffle(pairs, random);
        for (const [a, b] of pairs.slice(0, 12)) {
          const path: number[] = [];
          let onSection = true;
          let node = s;
          let walking = a;
          let blocked = false;
          for (;;) {
            const edge = onSection ? sectionColour[node * W + walking]! : teacherColour[node * W + walking]!;
            if (edge === -1) break;
            if (fixedSlot[edge] !== -1) { blocked = true; break; }
            path.push(edge);
            if (path.length > edgeCount) { blocked = true; break; }
            node = onSection ? edgeTeacher[edge]! : edgeSection[edge]!;
            onSection = !onSection;
            walking = walking === a ? b : a;
          }
          if (blocked) continue;
          for (const edge of path) {
            teacherColour[edgeTeacher[edge]! * W + edgeColour[edge]!] = -1;
            sectionColour[edgeSection[edge]! * W + edgeColour[edge]!] = -1;
          }
          for (const edge of path) {
            const flipped = edgeColour[edge] === a ? b : a;
            edgeColour[edge] = flipped;
            teacherColour[edgeTeacher[edge]! * W + flipped] = edge;
            sectionColour[edgeSection[edge]! * W + flipped] = edge;
          }
          if (sectionColour[s * W + a] === -1 && teacherColour[t * W + a] === -1) { colour = a; break; }
          // the flip did not free `a` at both ends (should not happen): fail this attempt rather than risk a wrong colouring
          failed = true;
          break;
        }
      }
      if (failed || colour === -1) { failed = true; break; }
      edgeColour[e] = colour;
      teacherColour[t * W + colour] = e;
      sectionColour[s * W + colour] = e;
    }
    if (failed) continue;

    const entries: TimetableEntryRow[] = [];
    for (let e = 0; e < edgeCount; e++) {
      const slot = edgeColour[e]!;
      const a = assignments[edgeAssignment[e]!]!;
      entries.push({
        assignmentId: a.id,
        sectionId: a.sectionId,
        subjectId: a.subjectId,
        teacherId: a.teacherId,
        dayOfWeek: grid.days[Math.floor(slot / periodsPerDay)]!.dayOfWeek,
        periodNumber: (slot % periodsPerDay) + 1,
      });
    }
    return { ok: true, entries: sortEntries(entries, grid.days.map((d) => d.dayOfWeek)), attempts: attempt + 1 };
  }
  return { ok: false, reason: 'NO_PLACEMENT_FOUND', attempts: maxAttempts };
}
