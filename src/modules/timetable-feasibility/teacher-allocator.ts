// ---------------------------------------------------------------------------
// Automatic teacher allocation for (section, requirement) pairs that have NO explicit section-subject-teacher assignment.
//
// Pure and deterministic (no database, no randomness, no clock): the same input always gives the same allocation. It is shared by the
// feasibility analyzer (what the report promises) and the generation normalizer (what generation does), so the two cannot disagree.
//
// What it decides: WHICH teacher teaches each unassigned unit. It never decides who is ELIGIBLE: the caller passes, per unit, the exact
// candidate list (active teachers of the school with a subject link that covers the unit's grade: gradeScope ALL_GRADES, or an explicit
// eligibility row). An empty candidate list stays empty: nobody is invented. Explicit assignments are fixed load that is subtracted from
// the teachers' capacity before anything is allocated; they are never moved.
//
// Method: units are placed most-constrained first (fewest candidates, then the most periods), each on the candidate with the most capacity
// left (ties by id), which balances load. A unit that does not fit is placed by a bounded augmenting search that may move already
// auto-allocated units to other candidates. This is a heuristic for an NP-hard packing problem: when it reports a unit as unplaceable the
// problem may still be solvable by hand-picking teachers, which is what explicit assignments are for.
// ---------------------------------------------------------------------------

export interface AllocationUnit {
  /** Stable unique key, e.g. `${sectionId}|${requirementId}`. */
  key: string;
  periods: number;
  /** Eligible, active teachers of the school for this unit's subject and grade. Order does not matter. */
  candidates: readonly string[];
}

export interface AllocationInput {
  units: readonly AllocationUnit[];
  /** Weekly capacity of every teacher (the same for all: min(32, weekly slots)). */
  teacherCapacity: number;
  /** Periods already carried by explicit assignments, per teacher. Missing = 0. */
  fixedLoad: ReadonlyMap<string, number>;
}

export interface AllocationResult {
  /** unit key -> teacher id, for every unit that was placed. */
  assigned: Map<string, string>;
  /** Units with no candidate at all. */
  noCandidates: string[];
  /** Units that have candidates but could not be fitted into their remaining capacity (heuristic verdict). */
  unplaceable: string[];
  /** Total periods per teacher after allocation (fixed + automatic). */
  load: Map<string, number>;
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const MAX_SEARCH_STEPS = 200_000;

export function allocateTeachers(input: AllocationInput): AllocationResult {
  const { teacherCapacity } = input;
  const load = new Map<string, number>(input.fixedLoad);
  const remaining = (teacherId: string): number => teacherCapacity - (load.get(teacherId) ?? 0);

  const assigned = new Map<string, string>();
  const noCandidates: string[] = [];
  const unplaceable: string[] = [];

  const units = new Map(input.units.map((u) => [u.key, { ...u, candidates: [...new Set(u.candidates)].sort(compare) }]));
  const ordered = [...units.values()]
    .filter((u) => {
      if (u.candidates.length === 0) { noCandidates.push(u.key); return false; }
      return true;
    })
    .sort((a, b) => a.candidates.length - b.candidates.length || b.periods - a.periods || compare(a.key, b.key));
  noCandidates.sort(compare);

  const onTeacher = new Map<string, string[]>(); // teacher -> auto-allocated unit keys
  const place = (unitKey: string, teacherId: string): void => {
    assigned.set(unitKey, teacherId);
    load.set(teacherId, (load.get(teacherId) ?? 0) + units.get(unitKey)!.periods);
    onTeacher.set(teacherId, [...(onTeacher.get(teacherId) ?? []), unitKey]);
  };
  const unplace = (unitKey: string): void => {
    const teacherId = assigned.get(unitKey)!;
    assigned.delete(unitKey);
    load.set(teacherId, (load.get(teacherId) ?? 0) - units.get(unitKey)!.periods);
    onTeacher.set(teacherId, (onTeacher.get(teacherId) ?? []).filter((k) => k !== unitKey));
  };

  let steps = 0;
  /** Place `unitKey`, moving already-placed units to other candidates when needed. Every teacher is tried at most once per search. */
  const augment = (unitKey: string, visited: Set<string>, reserved: Set<string>): boolean => {
    const unit = units.get(unitKey)!;
    // direct fit first: the candidate with the most room (balanced), ties by id. A teacher on the current search path is being freed up
    // for a unit further up the path, so a moved unit may not land on it again.
    let best: string | null = null;
    for (const t of unit.candidates) {
      if (!reserved.has(t) && remaining(t) >= unit.periods && (best === null || remaining(t) > remaining(best))) best = t;
    }
    if (best !== null) { place(unitKey, best); return true; }

    for (const t of unit.candidates) {
      if (visited.has(t) || reserved.has(t)) continue;
      visited.add(t);
      reserved.add(t);
      const movable = [...(onTeacher.get(t) ?? [])].sort((a, b) => units.get(b)!.periods - units.get(a)!.periods || compare(a, b));
      for (const other of movable) {
        if (++steps > MAX_SEARCH_STEPS) return false;
        unplace(other);
        if (remaining(t) >= unit.periods && augment(other, visited, reserved)) {
          place(unitKey, t);
          return true;
        }
        // put it back where it was
        if (!assigned.has(other)) place(other, t);
      }
      reserved.delete(t);
    }
    return false;
  };

  for (const unit of ordered) {
    if (steps > MAX_SEARCH_STEPS || !augment(unit.key, new Set(), new Set())) unplaceable.push(unit.key);
  }
  unplaceable.sort(compare);

  return { assigned, noCandidates, unplaceable, load };
}
