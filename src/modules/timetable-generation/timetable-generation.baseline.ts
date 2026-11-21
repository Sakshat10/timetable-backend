import { type NormalizedProblem } from './timetable-generation.normalizer.js';
import { type TimetableEntryRow } from './timetable-generation.contracts.js';

// ---------------------------------------------------------------------------
// Constructive baseline: a guaranteed-valid timetable under the V1 hard constraints.
//
// The problem is a proper edge-colouring of a bipartite multigraph: teachers on one side, sections on the
// other, one edge per lesson period, one colour per weekly slot. A section cannot hold two lessons in one slot
// and a teacher cannot teach two sections in one slot, i.e. edges that share a vertex need different colours.
// By Konig's edge-colouring theorem a bipartite multigraph is colourable with (max degree) colours, so a valid
// timetable exists exactly when every teacher load and every section demand fits in the weekly slots, and this
// algorithm (alternating-path recolouring, O(E * V)) constructs one.
//
// It is the mandatory fallback when CP-SAT yields no usable solution, an independent validity reference, and a
// quality comparison. It is NEVER passed to CP-SAT as a hint.
// ---------------------------------------------------------------------------

export interface CapacityViolation {
  type: 'TEACHER' | 'SECTION';
  id: string;
  /** Teacher load or section demand, in periods per week. */
  load: number;
  limit: number;
}

export type BaselineResult =
  | { ok: true; entries: TimetableEntryRow[] }
  | { ok: false; certificate: CapacityViolation[] };

/** Small deterministic PRNG (mulberry32) so a baseline is reproducible from its seed. */
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

/**
 * The exact infeasibility certificate for the V1 hard constraints: every teacher or section whose weekly load
 * exceeds its limit. An empty list means a timetable is guaranteed to exist.
 */
export function findCapacityViolations(problem: NormalizedProblem): CapacityViolation[] {
  const weeklySlots = problem.derived.weeklySlots;
  const teacherLimit = new Map(problem.core.teachers.map((t) => [t.id, Math.min(t.weeklyCapacity, weeklySlots)]));
  const teacherLoad = new Map<string, number>();
  const sectionDemand = new Map<string, number>();
  for (const a of problem.core.assignments) {
    teacherLoad.set(a.teacherId, (teacherLoad.get(a.teacherId) ?? 0) + a.periodsPerWeek);
    sectionDemand.set(a.sectionId, (sectionDemand.get(a.sectionId) ?? 0) + a.periodsPerWeek);
  }
  const violations: CapacityViolation[] = [];
  for (const [id, load] of teacherLoad) {
    const limit = teacherLimit.get(id) ?? 0;
    if (load > limit) violations.push({ type: 'TEACHER', id, load, limit });
  }
  for (const [id, load] of sectionDemand) {
    if (load > weeklySlots) violations.push({ type: 'SECTION', id, load, limit: weeklySlots });
  }
  return violations.sort((a, b) => (a.type === b.type ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.type < b.type ? -1 : 1));
}

export function buildBaseline(problem: NormalizedProblem, seed = 1): BaselineResult {
  const violations = findCapacityViolations(problem);
  if (violations.length > 0) return { ok: false, certificate: violations };

  const { periodsPerDay, weeklySlots: W } = problem.derived;
  const { assignments, teachers, sections, grid } = problem.core;
  const teacherIndex = new Map(teachers.map((t, i) => [t.id, i]));
  const sectionIndex = new Map(sections.map((s, i) => [s.id, i]));

  // One edge per lesson period.
  const edgeTeacher: number[] = [];
  const edgeSection: number[] = [];
  const edgeAssignment: number[] = [];
  assignments.forEach((a, ai) => {
    const t = teacherIndex.get(a.teacherId)!;
    const s = sectionIndex.get(a.sectionId)!;
    for (let n = 0; n < a.periodsPerWeek; n++) {
      edgeTeacher.push(t);
      edgeSection.push(s);
      edgeAssignment.push(ai);
    }
  });
  const edgeCount = edgeTeacher.length;

  // teacherColour[t * W + c] / sectionColour[s * W + c] = edge using colour c at that vertex, or -1.
  const teacherColour = new Int32Array(teachers.length * W).fill(-1);
  const sectionColour = new Int32Array(sections.length * W).fill(-1);
  const edgeColour = new Int32Array(edgeCount).fill(-1);

  const firstFree = (table: Int32Array, base: number): number => {
    for (let c = 0; c < W; c++) if (table[base + c] === -1) return c;
    throw new Error('baseline: no free colour (capacity precondition violated)');
  };

  for (let e = 0; e < edgeCount; e++) {
    const t = edgeTeacher[e]!;
    const s = edgeSection[e]!;
    const a = firstFree(teacherColour, t * W); // free at the teacher
    const b = firstFree(sectionColour, s * W); // free at the section
    let colour: number;
    if (sectionColour[s * W + a] === -1) {
      colour = a;
    } else if (teacherColour[t * W + b] === -1) {
      colour = b;
    } else {
      // Flip the a/b alternating path that starts at the section. Afterwards `a` is free at both ends. The path
      // cannot reach the teacher: it enters teachers only through colour-a edges and this teacher has none.
      const path: number[] = [];
      let onSection = true;
      let node = s;
      let walking = a;
      for (;;) {
        const edge = onSection ? sectionColour[node * W + walking]! : teacherColour[node * W + walking]!;
        if (edge === -1) break;
        path.push(edge);
        if (path.length > edgeCount) throw new Error('baseline: alternating path overflow');
        node = onSection ? edgeTeacher[edge]! : edgeSection[edge]!;
        onSection = !onSection;
        walking = walking === a ? b : a;
      }
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
      if (sectionColour[s * W + a] !== -1 || teacherColour[t * W + a] !== -1) {
        throw new Error('baseline: recolouring invariant broken');
      }
      colour = a;
    }
    edgeColour[e] = colour;
    teacherColour[t * W + colour] = e;
    sectionColour[s * W + colour] = e;
  }

  // Colour -> slot through a seeded permutation, so slots are not biased towards the lowest colours.
  const random = mulberry32(seed);
  const slotOfColour = Array.from({ length: W }, (_, i) => i);
  for (let i = W - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [slotOfColour[i], slotOfColour[j]] = [slotOfColour[j]!, slotOfColour[i]!];
  }

  const entries: TimetableEntryRow[] = [];
  for (let e = 0; e < edgeCount; e++) {
    const slot = slotOfColour[edgeColour[e]!]!;
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
  return { ok: true, entries: sortEntries(entries, grid.days.map((d) => d.dayOfWeek)) };
}

/** Canonical entry order: assignment id, then day (week order), then period. */
export function sortEntries(entries: TimetableEntryRow[], dayOrder: readonly string[]): TimetableEntryRow[] {
  const dayRank = new Map(dayOrder.map((d, i) => [d as string, i]));
  return [...entries].sort((x, y) => {
    if (x.assignmentId !== y.assignmentId) return x.assignmentId < y.assignmentId ? -1 : 1;
    const dx = dayRank.get(x.dayOfWeek) ?? 99;
    const dy = dayRank.get(y.dayOfWeek) ?? 99;
    return dx !== dy ? dx - dy : x.periodNumber - y.periodNumber;
  });
}
