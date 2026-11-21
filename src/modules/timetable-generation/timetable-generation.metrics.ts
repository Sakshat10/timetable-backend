import { type NormalizedProblem } from './timetable-generation.normalizer.js';
import {
  TERM_NAMES,
  WEIGHTS_V1,
  WEIGHTS_VERSION,
  type ObjectiveWeights,
  type TermCounts,
  type TimetableEntryRow,
} from './timetable-generation.contracts.js';

// ---------------------------------------------------------------------------
// Independent metric evaluator. The AUTHORITATIVE quality measure of a timetable.
//
// It reads only the entries and the normalized problem. It never looks at the solver's objective value: one-sided
// soft variables can carry slack on an unconverged CP-SAT solution (Phase 0 measured up to 1586 points), so the
// solver's number is diagnostic only. Every persisted metric comes from here.
//
// Canonical term definitions (the CP-SAT model implements exactly these so the two agree at convergence).
// Notation: D = working days, K = periods per day, W = D*K. A "busy" period is one in which the teacher (or
// section) has a lesson. The `continuesIntoNext` flag of period k says period k+1 follows it with no
// break/lunch/timing event in between; a run of consecutive periods never crosses a break.
//
//   teacherRun3           teachers with weekly load >= 3. +1 for every window of 3 consecutive, mutually
//                         continuous periods on one day in which the teacher is busy in all three.
//                         (A run of 3 scores 1, a run of 4 scores 2, a run of 5 scores 3.)
//   teacherRun4Plus       same teachers. +1 for every window of 4 continuous periods all busy.
//                         (A run of 4 scores 1, a run of 5 scores 2.)
//   subjectSameDayExcess  assignments with periodsPerWeek p >= 2. With c = ceil(p / D): when c < K,
//                         sum over days of max(0, lessons that day - c). Nothing is penalised that the
//                         number of days forces.
//   sectionHoles          sections whose demand < W. For every day and k = 1..K-1: +1 when period k+1 is busy
//                         and period k is free (a free period followed later by a lesson, or a late start).
//   dailyLoadExcess       teachers with weekly load >= 3 and sections with demand < W. With cap = ceil(load / D):
//                         when cap < K, sum over days of max(0, periods that day - cap).
//
// weightedObjective = sum(term * WEIGHTS_V1[term]).
// ---------------------------------------------------------------------------

export interface InformationalStats {
  /** Free periods between a teacher's first and last lesson of a day, summed. NOT optimised in V1. */
  teacherGapPeriods: number;
  /** Teacher-days with exactly one lesson. */
  teacherSingleLessonDays: number;
  /** Teacher-days with at least one lesson. */
  teacherBusyDays: number;
  /** Longest run of consecutive teaching periods (breaks end a run). */
  teacherMaxRun: number;
  /** (assignment, day) pairs with the same subject taught 2+ times in a day. */
  sameDayRepeatPairs: number;
  /** Lower bound of the above forced by the week length: sum over assignments of max(0, p - D). */
  forcedSameDayRepeatPairs: number;
  /** Section-days that contain a hole (see sectionHoles). */
  sectionDaysWithHole: number;
}

export interface TimetableMetrics {
  weightsVersion: string;
  weights: ObjectiveWeights;
  terms: TermCounts;
  weightedObjective: number;
  informational: InformationalStats;
}

/**
 * Evaluate a COMPLETE, already-validated timetable (run `validateEntries` first). Results are undefined for
 * entries that reference unknown assignments or slots.
 */
export function evaluateMetrics(
  problem: NormalizedProblem,
  entries: readonly TimetableEntryRow[],
  weights: ObjectiveWeights = WEIGHTS_V1,
  weightsVersion: string = WEIGHTS_VERSION
): TimetableMetrics {
  const { dayCount: D, periodsPerDay: K, weeklySlots: W } = problem.derived;
  const dayIndex = new Map(problem.core.grid.days.map((d) => [d.dayOfWeek as string, d.index]));
  const continues = problem.core.grid.periods.map((p) => p.continuesIntoNext);

  const teacherIndex = new Map(problem.core.teachers.map((t, i) => [t.id, i]));
  const sectionIndex = new Map(problem.core.sections.map((s, i) => [s.id, i]));
  const assignmentIndex = new Map(problem.core.assignments.map((a, i) => [a.id, i]));

  const teacherLoad = new Array<number>(problem.core.teachers.length).fill(0);
  const sectionDemand = new Array<number>(problem.core.sections.length).fill(0);
  for (const a of problem.core.assignments) {
    teacherLoad[teacherIndex.get(a.teacherId)!]! += a.periodsPerWeek;
    sectionDemand[sectionIndex.get(a.sectionId)!]! += a.periodsPerWeek;
  }

  const teacherBusy = problem.core.teachers.map(() => new Uint8Array(W));
  const sectionBusy = problem.core.sections.map(() => new Uint8Array(W));
  const perAssignmentDay = problem.core.assignments.map(() => new Array<number>(D).fill(0));
  for (const entry of entries) {
    const day = dayIndex.get(entry.dayOfWeek)!;
    const slot = day * K + (entry.periodNumber - 1);
    teacherBusy[teacherIndex.get(entry.teacherId)!]![slot] = 1;
    sectionBusy[sectionIndex.get(entry.sectionId)!]![slot] = 1;
    perAssignmentDay[assignmentIndex.get(entry.assignmentId)!]![day]! += 1;
  }

  let run3 = 0;
  let run4 = 0;
  let spreadExcess = 0;
  let holes = 0;
  let loadExcess = 0;
  const info: InformationalStats = {
    teacherGapPeriods: 0,
    teacherSingleLessonDays: 0,
    teacherBusyDays: 0,
    teacherMaxRun: 0,
    sameDayRepeatPairs: 0,
    forcedSameDayRepeatPairs: 0,
    sectionDaysWithHole: 0,
  };

  // ---- teachers ---------------------------------------------------------------
  teacherBusy.forEach((busy, t) => {
    const load = teacherLoad[t]!;
    const scored = load >= 3;
    const cap = Math.ceil(load / D);
    for (let d = 0; d < D; d++) {
      const base = d * K;
      let count = 0;
      let first = -1;
      let last = -1;
      let run = 0;
      for (let k = 0; k < K; k++) {
        if (busy[base + k]) {
          count++;
          if (first < 0) first = k;
          last = k;
          run++;
          if (run > info.teacherMaxRun) info.teacherMaxRun = run;
          if (!continues[k]) run = 0;
        } else {
          run = 0;
        }
      }
      if (count > 0) {
        info.teacherBusyDays++;
        if (count === 1) info.teacherSingleLessonDays++;
        info.teacherGapPeriods += last - first + 1 - count;
      }
      if (scored) {
        for (let k = 0; k + 2 < K; k++) {
          if (continues[k] && continues[k + 1] && busy[base + k] && busy[base + k + 1] && busy[base + k + 2]) run3++;
        }
        for (let k = 0; k + 3 < K; k++) {
          if (
            continues[k] && continues[k + 1] && continues[k + 2] &&
            busy[base + k] && busy[base + k + 1] && busy[base + k + 2] && busy[base + k + 3]
          ) {
            run4++;
          }
        }
        if (cap < K) loadExcess += Math.max(0, count - cap);
      }
    }
  });

  // ---- sections ---------------------------------------------------------------
  sectionBusy.forEach((busy, s) => {
    const demand = sectionDemand[s]!;
    if (demand >= W) return; // full sections have no freedom: no holes, no balance term
    const cap = Math.ceil(demand / D);
    for (let d = 0; d < D; d++) {
      const base = d * K;
      let count = 0;
      let dayHasHole = false;
      for (let k = 0; k < K; k++) {
        if (busy[base + k]) count++;
        if (k + 1 < K && busy[base + k + 1] && !busy[base + k]) {
          holes++;
          dayHasHole = true;
        }
      }
      if (dayHasHole) info.sectionDaysWithHole++;
      if (cap < K) loadExcess += Math.max(0, count - cap);
    }
  });

  // ---- subject spread ---------------------------------------------------------
  problem.core.assignments.forEach((a, ai) => {
    const p = a.periodsPerWeek;
    info.forcedSameDayRepeatPairs += Math.max(0, p - D);
    const perDay = perAssignmentDay[ai]!;
    for (const lessons of perDay) if (lessons >= 2) info.sameDayRepeatPairs++;
    if (p < 2) return;
    const cap = Math.ceil(p / D);
    if (cap >= K) return;
    for (const lessons of perDay) spreadExcess += Math.max(0, lessons - cap);
  });

  const terms: TermCounts = {
    teacherRun3: run3,
    teacherRun4Plus: run4,
    subjectSameDayExcess: spreadExcess,
    sectionHoles: holes,
    dailyLoadExcess: loadExcess,
  };
  const weightedObjective = TERM_NAMES.reduce((sum, name) => sum + terms[name] * weights[name], 0);
  return { weightsVersion, weights: { ...weights }, terms, weightedObjective, informational: info };
}
