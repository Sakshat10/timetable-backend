// ---------------------------------------------------------------------------
// Automatic substitution: the coordinated allocator for ONE school day. Pure (no database, no clock): the caller loads the day into an AllocWorld,
// this decides, the caller persists every decision under the same locks and checks as a manual assignment.
//
// It reuses the existing rules, it does not add new ones:
//   hard constraints   classifyCandidate (same school, active, not the absent teacher, not absent, not unavailable, no lesson in the period, no cover in the period)
//   tiers              tierOf (1 same subject, 2 anyone else free, 3 would end with four consecutive periods = last resort), judged by the school's
//                      consecutivePeriodPolicy: ALLOW (no tier 3), PREFER_AVOID (tier 3 is used only when nobody better is free), NEVER_ALLOW (such a teacher is excluded)
//   ranking            compareRanked (subject, grade, weekly workload, covers today, consecutive run, recent covers, name, id)
//
// Coordination: all covers of the day are considered together. Repeatedly the cover with the FEWEST remaining options is decided first (a lesson only one teacher
// can take is not starved by a lesson that has many), its best candidate is RESERVED at once (so nobody is double-booked or put into overlapping periods) and every
// remaining cover is re-evaluated against the new reservation. Ties are broken by period, section and id, so the outcome is deterministic.
// ---------------------------------------------------------------------------
import { classifyCandidate, compareRanked, DEFAULT_CONSECUTIVE_POLICY, isBlockedByPolicy, runThrough, tierOf, type CandidateTier, type ConsecutivePolicy, type ExclusionReason, type SubjectBasis } from './substitution.core.js';

export type UnfilledCode = 'NO_AVAILABLE_TEACHER' | 'NO_QUALIFIED_TEACHER' | 'CONSECUTIVE_PERIODS_NOT_ALLOWED';

export const UNFILLED_MESSAGES: Record<UnfilledCode, string> = {
  NO_AVAILABLE_TEACHER: 'No teacher is free to cover this lesson',
  NO_QUALIFIED_TEACHER: 'No teacher of this subject is free, and temporary cover by other teachers was not allowed',
  CONSECUTIVE_PERIODS_NOT_ALLOWED: 'The only free teachers would end with four or more consecutive teaching periods, which the school\'s policy (NEVER_ALLOW) does not allow',
};

export interface AllocCover { id: string; sectionId: string; period: number; subjectId: string; gradeId: string; absentTeacherId: string; yearId: string }

export interface AllocTeacher {
  id: string;
  name: string;
  isActive: boolean;
  /** Periods of this day in which the teacher is absent / marked unavailable. */
  absentPeriods: ReadonlySet<number>;
  unavailablePeriods: ReadonlySet<number>;
  /** Periods in which the teacher has a lesson of the published timetable (any), and the ones they will actually teach (not inside their own absence). */
  lessonPeriods: ReadonlySet<number>;
  teachingPeriods: ReadonlySet<number>;
  /** Periods in which a cover is already assigned to them: reservations, extended by this allocator. */
  coveringPeriods: Set<number>;
  weeklyLoad: number;
  recentCovers: number;
  basisBySubject: ReadonlyMap<string, SubjectBasis>;
  /** `${subjectId}|${gradeId}` pairs the teacher is linked and grade-eligible for. */
  gradeEligible: ReadonlySet<string>;
}

export interface AllocWorld {
  teachers: AllocTeacher[];
  /** Per academic year: does period k+1 follow period k without a break. */
  continues: (yearId: string) => (k: number) => boolean;
  /** false: a teacher with no subject link may not be used (the school does not permit temporary unqualified cover). */
  allowTemporaryCover: boolean;
  /** The school's four-consecutive-periods policy (default PREFER_AVOID). */
  policy?: ConsecutivePolicy;
}

export interface Option {
  teacherId: string;
  name: string;
  tier: CandidateTier;
  basis: SubjectBasis | null;
  gradeEligible: boolean;
  weeklyLoad: number;
  coverLoad: number;
  runLength: number;
  runFrom: number;
  runTo: number;
  recentCovers: number;
}

export interface AssignedDecision {
  kind: 'ASSIGN';
  coverId: string;
  option: Option;
  /** How many teachers could have taken the lesson when it was decided (tier 1-2), and the next best of them: why this one. */
  optionCount: number;
  alternatives: Option[];
  excludedCounts: Partial<Record<ExclusionReason, number>>;
  temporaryUnqualified: boolean;
  /** The teacher would end with four or more consecutive periods (PREFER_AVOID, nobody better was free). */
  lastResort: boolean;
}
export interface UnfilledDecision { kind: 'UNFILLED'; coverId: string; code: UnfilledCode; message: string; excludedCounts: Partial<Record<ExclusionReason, number>> }
export type Decision = AssignedDecision | UnfilledDecision;

/** `ignoreReserved`: teachers whose reservation of THIS cover's period (made by this run) is disregarded, to ask "who could take it if that reservation moved". */
function evaluate(world: AllocWorld, cover: AllocCover, ignoreReserved: ReadonlySet<string> = new Set()) {
  const excludedCounts: Partial<Record<ExclusionReason, number>> = {};
  const all: Option[] = [];
  const continues = world.continues(cover.yearId);
  const policy = world.policy ?? DEFAULT_CONSECUTIVE_POLICY;
  for (const t of world.teachers) {
    const reason = classifyCandidate({
      isAbsentTeacher: t.id === cover.absentTeacherId,
      isActive: t.isActive,
      isAbsent: t.absentPeriods.has(cover.period),
      isUnavailable: t.unavailablePeriods.has(cover.period),
      hasLessonInPeriod: t.lessonPeriods.has(cover.period),
      isCoveringInPeriod: t.coveringPeriods.has(cover.period) && !ignoreReserved.has(t.id),
    });
    if (reason !== null) { excludedCounts[reason] = (excludedCounts[reason] ?? 0) + 1; continue; }
    const teaching = new Set<number>([...t.teachingPeriods, ...[...t.coveringPeriods].filter((p) => p !== cover.period), cover.period]);
    const run = runThrough(teaching, cover.period, continues);
    if (isBlockedByPolicy(policy, run.length)) { excludedCounts.CONSECUTIVE_NOT_ALLOWED = (excludedCounts.CONSECUTIVE_NOT_ALLOWED ?? 0) + 1; continue; }
    const basis = t.basisBySubject.get(cover.subjectId) ?? null;
    all.push({ teacherId: t.id, name: t.name, tier: tierOf(basis !== null, run.length, policy), basis, gradeEligible: t.gradeEligible.has(`${cover.subjectId}|${cover.gradeId}`), weeklyLoad: t.weeklyLoad, coverLoad: t.coveringPeriods.size, runLength: run.length, runFrom: run.from, runTo: run.to, recentCovers: t.recentCovers });
  }
  const ranked = [...all].sort((a, b) => compareRanked({ ...a, id: a.teacherId }, { ...b, id: b.teacherId }));
  const usable = ranked.filter((o) => world.allowTemporaryCover || o.basis !== null);
  return { ranked, usable, excludedCounts };
}

/** Allocate every cover of one day. Mutates the teachers' coveringPeriods / weeklyLoad / recentCovers as reservations. Returns the decisions in decision order. */
export function allocateDay(world: AllocWorld, covers: readonly AllocCover[]): Decision[] {
  const decisions: Decision[] = [];
  let remaining = [...covers];
  const byId = new Map(world.teachers.map((t) => [t.id, t]));
  while (remaining.length > 0) {
    const evaluated = remaining.map((c) => ({ cover: c, ...evaluate(world, c) }));
    // covers nobody can take stay unassigned; a reservation only removes options, so they cannot become possible later in this run
    const stuck = evaluated.filter((e) => e.usable.length === 0);
    for (const e of stuck) {
      const qualifiedOnly = !world.allowTemporaryCover && e.ranked.some((o) => o.basis === null);
      const code: UnfilledCode = qualifiedOnly ? 'NO_QUALIFIED_TEACHER' : (e.excludedCounts.CONSECUTIVE_NOT_ALLOWED ?? 0) > 0 ? 'CONSECUTIVE_PERIODS_NOT_ALLOWED' : 'NO_AVAILABLE_TEACHER';
      decisions.push({ kind: 'UNFILLED', coverId: e.cover.id, code, message: UNFILLED_MESSAGES[code], excludedCounts: e.excludedCounts });
    }
    const live = evaluated.filter((e) => e.usable.length > 0);
    if (live.length === 0) break;
    live.sort((a, b) =>
      a.usable.length - b.usable.length ||
      a.usable.filter((o) => o.basis !== null).length - b.usable.filter((o) => o.basis !== null).length ||
      a.cover.period - b.cover.period ||
      (a.cover.sectionId < b.cover.sectionId ? -1 : a.cover.sectionId > b.cover.sectionId ? 1 : 0) ||
      (a.cover.id < b.cover.id ? -1 : a.cover.id > b.cover.id ? 1 : 0));
    const next = live[0]!;
    const pick = next.usable[0]!;
    const teacher = byId.get(pick.teacherId)!;
    teacher.coveringPeriods.add(next.cover.period); // reserved: no overlapping cover, counted in the next evaluations
    teacher.weeklyLoad += 1;
    teacher.recentCovers += 1;
    decisions.push({ kind: 'ASSIGN', coverId: next.cover.id, option: pick, optionCount: next.usable.length, alternatives: next.usable.slice(1, 4), excludedCounts: next.excludedCounts, temporaryUnqualified: pick.basis === null, lastResort: pick.tier === 3 });
    remaining = live.slice(1).map((e) => e.cover);
  }
  return repairUnfilled(world, covers, decisions);
}

/**
 * Greedy "fewest options first" is not always a maximum assignment: in rare layouts a lesson stays unfilled although moving earlier choices of THIS run would let everyone be covered
 * (about 0.5% of random dense layouts in testing). The only coupling between lessons is the teacher who cannot be in two lessons of one period, so for every lesson left without a
 * teacher we look for an augmenting path inside its period: take teacher T1, whose current lesson moves to T2, whose lesson moves to T3 ... until a free teacher closes the path.
 * Only this run's own assignments move (nothing already assigned by anyone is touched) and every moved lesson is re-ranked, so each stays valid under the same rules.
 */
function repairUnfilled(world: AllocWorld, covers: readonly AllocCover[], decisions: Decision[]): Decision[] {
  const byId = new Map(world.teachers.map((t) => [t.id, t]));
  const coverById = new Map(covers.map((c) => [c.id, c]));
  const unfilled = decisions.filter((d): d is UnfilledDecision => d.kind === 'UNFILLED');
  for (const u of unfilled) {
    const uc = coverById.get(u.coverId)!;
    const holder = new Map<string, string>(); // teacherId -> coverId, for this run's assignments in this period
    const assignedHere = new Map<string, AssignedDecision>();
    for (const d of decisions) if (d.kind === 'ASSIGN' && coverById.get(d.coverId)!.period === uc.period) { holder.set(d.option.teacherId, d.coverId); assignedHere.set(d.coverId, d); }
    if (assignedHere.size === 0) continue;
    const ignore = new Set(holder.keys());
    const optionsOf = (c: AllocCover): string[] => evaluate(world, c, ignore).usable.map((o) => o.teacherId);
    // breadth-first: parent[coverId] = [previous coverId, teacher it wants]
    const parent = new Map<string, { from: string | null; teacher: string | null }>([[uc.id, { from: null, teacher: null }]]);
    const queue = [uc.id];
    let endTeacher: string | null = null;
    let endCover: string | null = null;
    for (let i = 0; i < queue.length && endTeacher === null; i++) {
      const cur = queue[i]!;
      for (const teacherId of optionsOf(coverById.get(cur)!)) {
        const h = holder.get(teacherId);
        if (h === undefined) { endTeacher = teacherId; endCover = cur; break; }
        if (!parent.has(h)) { parent.set(h, { from: cur, teacher: teacherId }); queue.push(h); }
      }
    }
    if (endTeacher === null || endCover === null) continue;
    // walk back: endCover takes endTeacher; the cover that wanted the teacher endCover held takes it; ...
    const moves: Array<{ coverId: string; teacherId: string }> = [{ coverId: endCover, teacherId: endTeacher }];
    for (let c = endCover; ; ) {
      const p = parent.get(c)!;
      if (p.from === null) break;
      moves.push({ coverId: p.from, teacherId: p.teacher! });
      c = p.from;
    }
    // reservations: release the old teachers of the moved lessons, take the new ones
    for (const m of moves) {
      const old = assignedHere.get(m.coverId);
      if (old) { const t = byId.get(old.option.teacherId)!; t.coveringPeriods.delete(uc.period); t.weeklyLoad -= 1; t.recentCovers -= 1; }
    }
    for (const m of moves) { const t = byId.get(m.teacherId)!; t.coveringPeriods.add(uc.period); t.weeklyLoad += 1; t.recentCovers += 1; }
    for (const m of moves) {
      const c = coverById.get(m.coverId)!;
      const ev = evaluate(world, c, new Set([m.teacherId]));
      const pick = ev.usable.find((o) => o.teacherId === m.teacherId)!;
      const decision: AssignedDecision = { kind: 'ASSIGN', coverId: m.coverId, option: pick, optionCount: ev.usable.length, alternatives: ev.usable.filter((o) => o.teacherId !== m.teacherId).slice(0, 3), excludedCounts: ev.excludedCounts, temporaryUnqualified: pick.basis === null, lastResort: pick.tier === 3 };
      const at = decisions.findIndex((d) => d.coverId === m.coverId);
      decisions[at] = decision;
    }
  }
  return decisions;
}
