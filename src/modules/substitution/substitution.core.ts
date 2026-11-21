// ---------------------------------------------------------------------------
// Substitution: pure rules (no database, no clock). Everything here is deterministic and unit-tested.
//
// Dates are calendar dates ("YYYY-MM-DD", no time zone): an absence, a cover request and an unavailability belong to a school day, and the school's
// weekly timetable is keyed by day of the week, so the weekday of a date is the weekday of that calendar date.
// ---------------------------------------------------------------------------

export const DAYS_BY_UTC_INDEX = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
export type DayName = (typeof DAYS_BY_UTC_INDEX)[number];

export const MAX_PERIOD = 12; // the schedule allows at most 12 periods a day
export const MAX_ABSENCE_DAYS = 366;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written as YYYY-MM-DD (2026-02-30 is not one). */
export function isValidDateString(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const toTime = (date: string): number => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));

export function dayCount(startDate: string, endDate: string): number {
  return Math.round((toTime(endDate) - toTime(startDate)) / 86_400_000) + 1;
}

export function weekdayOf(date: string): DayName {
  return DAYS_BY_UTC_INDEX[new Date(toTime(date)).getUTCDay()]!;
}

/** Every date from startDate to endDate inclusive. */
export function eachDate(startDate: string, endDate: string): string[] {
  const out: string[] = [];
  for (let t = toTime(startDate); t <= toTime(endDate); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** A Date from a DATE column (UTC midnight) back to YYYY-MM-DD. */
export const dateToString = (date: Date): string => date.toISOString().slice(0, 10);

export interface PeriodScope {
  scope: 'FULL_DAY' | 'PERIODS';
  fromPeriod: number | null;
  toPeriod: number | null;
}

/** The inclusive period range an absence covers on each of its days (FULL_DAY: every period). */
export function periodRange(a: PeriodScope): [number, number] {
  return a.scope === 'FULL_DAY' ? [1, MAX_PERIOD] : [a.fromPeriod!, a.toPeriod!];
}

export function coversPeriod(a: PeriodScope, period: number): boolean {
  const [from, to] = periodRange(a);
  return period >= from && period <= to;
}

export interface AbsenceLike extends PeriodScope {
  startDate: string;
  endDate: string;
}

export function absenceCoversSlot(a: AbsenceLike, date: string, period: number): boolean {
  return date >= a.startDate && date <= a.endDate && coversPeriod(a, period);
}

/** Two absences contradict each other when their date ranges AND their period ranges both overlap. */
export function absencesOverlap(a: AbsenceLike, b: AbsenceLike): boolean {
  if (a.endDate < b.startDate || b.endDate < a.startDate) return false;
  const [a1, a2] = periodRange(a);
  const [b1, b2] = periodRange(b);
  return a1 <= b2 && b1 <= a2;
}

// ---------------------------------------------------------------------------
// Replacement candidates
// ---------------------------------------------------------------------------

/**
 * Why a teacher cannot take a lesson. Evaluated in THIS order; the first failing rule is the reason reported.
 *
 * School policy: a substitution is a TEMPORARY, date-specific cover, not a teaching qualification. So there is NO rule about subject links or grade eligibility here: a free,
 * active teacher of the school is always a candidate; a teacher of the lesson's subject is merely preferred (see rankCandidates). Only these things exclude a teacher.
 */
export const EXCLUSION_REASONS = [
  'IS_ABSENT_TEACHER',
  'INACTIVE',
  'ABSENT',
  'UNAVAILABLE',
  'TEACHING_ANOTHER_LESSON', // has a lesson of the published timetable in the same period
  'ALREADY_COVERING', // already assigned to cover another lesson in the same period
  'CONSECUTIVE_NOT_ALLOWED', // the school's policy is NEVER_ALLOW and this cover would give them four or more consecutive periods (decided after scoring, not by classifyCandidate)
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const EXCLUSION_MESSAGES: Record<ExclusionReason, string> = {
  IS_ABSENT_TEACHER: 'This is the absent teacher',
  INACTIVE: 'The teacher is inactive',
  ABSENT: 'The teacher is absent in this period',
  UNAVAILABLE: 'The teacher is marked unavailable in this period',
  TEACHING_ANOTHER_LESSON: 'The teacher has a lesson of the published timetable in this period',
  ALREADY_COVERING: 'The teacher is already assigned to cover another lesson in this period',
  CONSECUTIVE_NOT_ALLOWED: 'The school does not allow a substitute to teach four or more consecutive periods, and this cover would',
};

export interface CandidateFacts {
  isAbsentTeacher: boolean;
  isActive: boolean;
  isAbsent: boolean;
  isUnavailable: boolean;
  hasLessonInPeriod: boolean;
  isCoveringInPeriod: boolean;
}

export function classifyCandidate(f: CandidateFacts): ExclusionReason | null {
  if (f.isAbsentTeacher) return 'IS_ABSENT_TEACHER';
  if (!f.isActive) return 'INACTIVE';
  if (f.isAbsent) return 'ABSENT';
  if (f.isUnavailable) return 'UNAVAILABLE';
  if (f.hasLessonInPeriod) return 'TEACHING_ANOTHER_LESSON';
  if (f.isCoveringInPeriod) return 'ALREADY_COVERING';
  return null;
}

/** Choosing the absent teacher or an inactive one is the caller's mistake (400); everything about time is a conflict with the current state (409). */
export const isEligibilityReason = (r: ExclusionReason): boolean => r === 'IS_ABSENT_TEACHER' || r === 'INACTIVE';

export function exclusionMessage(reason: ExclusionReason): string {
  return EXCLUSION_MESSAGES[reason];
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** A clear sentence for "nobody is available", from the per-reason counts of all teachers considered. */
export function noCandidateMessage(counts: Partial<Record<ExclusionReason, number>>): string {
  const n = (r: ExclusionReason): number => counts[r] ?? 0;
  const phrase: Record<Exclude<ExclusionReason, 'IS_ABSENT_TEACHER'>, (k: number) => string> = {
    INACTIVE: (k) => `${plural(k, 'teacher is', 'teachers are')} inactive`,
    ABSENT: (k) => `${plural(k, 'teacher is', 'teachers are')} absent in this period`,
    UNAVAILABLE: (k) => `${plural(k, 'teacher is', 'teachers are')} marked unavailable in this period`,
    TEACHING_ANOTHER_LESSON: (k) => `${plural(k, 'teacher has', 'teachers have')} a lesson in this period`,
    ALREADY_COVERING: (k) => `${plural(k, 'teacher is', 'teachers are')} already covering another lesson in this period`,
    CONSECUTIVE_NOT_ALLOWED: (k) => `${plural(k, 'teacher would', 'teachers would')} end with four or more consecutive periods, which the school's policy does not allow`,
  };
  const parts = EXCLUSION_REASONS.filter((r): r is Exclude<ExclusionReason, 'IS_ABSENT_TEACHER'> => r !== 'IS_ABSENT_TEACHER' && n(r) > 0).map((r) => phrase[r](n(r)));
  if (parts.length === 0) return 'No teacher is available to cover this lesson: there are no other teachers in the school.';
  return `No teacher is available to cover this lesson in this period: ${parts.join('; ')}. The request stays unassigned.`;
}

// ---------------------------------------------------------------------------
// Candidate prioritization: three tiers, and the four-consecutive-periods preference
// ---------------------------------------------------------------------------

/** A teacher who ends up with this many consecutive teaching periods (or more) is a LAST RESORT under PREFER_AVOID, ignored under ALLOW, refused under NEVER_ALLOW. */
export const CONSECUTIVE_THRESHOLD = 4;

/**
 * The school's policy for a substitute who would end with CONSECUTIVE_THRESHOLD or more consecutive teaching periods (schools.consecutivePeriodPolicy).
 *   ALLOW         it is permitted and not even a warning: tiers ignore it (the shorter run is still a late ranking preference).
 *   PREFER_AVOID  the default: avoid it while another teacher can take the lesson; accept it as a LAST RESORT (tier 3). A manual assignment needs the admin's confirmation.
 *   NEVER_ALLOW   such a teacher is never assigned, automatically or manually (excluded with CONSECUTIVE_NOT_ALLOWED).
 * It only judges the run a cover would join. It does not touch the normal timetable's own constraints and is NOT a weekly workload limit.
 */
export const CONSECUTIVE_POLICIES = ['ALLOW', 'PREFER_AVOID', 'NEVER_ALLOW'] as const;
export type ConsecutivePolicy = (typeof CONSECUTIVE_POLICIES)[number];
export const DEFAULT_CONSECUTIVE_POLICY: ConsecutivePolicy = 'PREFER_AVOID';
export const isBlockedByPolicy = (policy: ConsecutivePolicy, runLength: number): boolean => policy === 'NEVER_ALLOW' && runLength >= CONSECUTIVE_THRESHOLD;

export interface Run { from: number; to: number; length: number }

/**
 * The run of consecutive teaching periods that contains `period` once the teacher also teaches it. `teaching` is the set of periods the teacher teaches that
 * day (normal lessons that they will actually teach, plus covers already assigned to them); `continuesIntoNext(k)` says period k+1 follows period k without a
 * break, exactly like the generator's grid: any break, lunch, assembly or other timing event in the gap after period k ends the run there. Adjacency is the
 * period ORDER of the school's schedule, not the number of lessons in the day.
 */
export function runThrough(teaching: ReadonlySet<number>, period: number, continuesIntoNext: (k: number) => boolean): Run {
  let from = period;
  while (teaching.has(from - 1) && continuesIntoNext(from - 1)) from--;
  let to = period;
  while (teaching.has(to + 1) && continuesIntoNext(to)) to++;
  return { from, to, length: to - from + 1 };
}

/** `continuesIntoNext` for a schedule of `periodsPerDay` periods with timing events after the given period numbers. */
export function adjacency(periodsPerDay: number, breakAfter: Iterable<number>): (k: number) => boolean {
  const gaps = new Set(breakAfter);
  return (k) => k >= 1 && k < periodsPerDay && !gaps.has(k);
}

export const TIER_KEYS = { 1: 'SAME_SUBJECT', 2: 'OTHER_AVAILABLE', 3: 'LAST_RESORT' } as const;
export type CandidateTier = 1 | 2 | 3;

/**
 * How the school's existing data says a teacher teaches the lesson's subject, best first. No new link is ever needed: the teacher-subject links and the published timetable already
 * identify the teachers of a subject. Grade scope and eligibility rows are irrelevant for a temporary cover.
 *   PRIMARY_LINK         the subject is the teacher's primary subject (teacher_subjects.type PRIMARY)
 *   SECONDARY_LINK       a secondary subject (teacher_subjects.type SECONDARY)
 *   TEACHES_IN_TIMETABLE no link, but they have lessons of this subject in the published timetable
 *   null                 not a teacher of this subject: still a candidate (tier 2), never excluded for it
 */
export const SUBJECT_BASES = ['PRIMARY_LINK', 'SECONDARY_LINK', 'TEACHES_IN_TIMETABLE'] as const;
export type SubjectBasis = (typeof SUBJECT_BASES)[number];
/** 0 = best. A non-teacher of the subject ranks after all of them. */
export const subjectRank = (basis: SubjectBasis | null): number => (basis === null ? SUBJECT_BASES.length : SUBJECT_BASES.indexOf(basis));

/** 1: a teacher of the subject avoiding four in a row. 2: any other free teacher avoiding it. 3: anyone who would end with four or more in a row. */
export function tierOf(sameSubject: boolean, runLength: number, policy: ConsecutivePolicy = DEFAULT_CONSECUTIVE_POLICY): CandidateTier {
  if (policy !== 'ALLOW' && runLength >= CONSECUTIVE_THRESHOLD) return 3;
  return sameSubject ? 1 : 2;
}

export interface RankInput {
  id: string;
  name: string;
  basis: SubjectBasis | null;
  runLength: number;
  coverLoad: number;
  /** Eligible for the lesson's grade through a teacher-subject link (ALL_GRADES or an explicit grade row). Absent = not known/false. */
  gradeEligible?: boolean;
  /** Periods per week already on the teacher (own lessons they will teach + covers assigned that week). Absent = 0. */
  weeklyLoad?: number;
  /** Covers assigned to the teacher in the trailing 28 days: the fairness tiebreak. Absent = 0. */
  recentCovers?: number;
}
export type Ranked<T extends RankInput> = T & { tier: CandidateTier; sameSubject: boolean; offered: boolean };

/**
 * The selection order, in full (every candidate is already free, active, not absent or unavailable, with no lesson and no other cover in the period):
 *   tier 1  a teacher of the lesson's subject whose cover would NOT give them four consecutive periods
 *   tier 2  any other teacher of the school with the same property
 *   tier 3  whoever would end with four or more consecutive periods
 * Within a tier, in this order: how the subject is taught (primary link, secondary link, teaches it in the timetable; a non-teacher last), eligibility for the lesson's grade,
 * the lower weekly workload, the fewer covers already assigned that day, the shorter resulting run, the fewer recent covers (fairness), then name, then id. Tier 3 is OFFERED only when tiers 1 and 2 are both empty; otherwise those
 * candidates are still returned (and the server still accepts them with a confirmation) but flagged offered=false. Everything is deterministic.
 */
export function rankCandidates<T extends RankInput>(items: readonly T[], policy: ConsecutivePolicy = DEFAULT_CONSECUTIVE_POLICY): Array<Ranked<T>> {
  const tiered = items.filter((c) => !isBlockedByPolicy(policy, c.runLength)).map((c) => ({ ...c, sameSubject: c.basis !== null, tier: tierOf(c.basis !== null, c.runLength, policy) }));
  const betterExists = tiered.some((c) => c.tier !== 3);
  return tiered.map((c) => ({ ...c, offered: c.tier !== 3 || !betterExists })).sort(compareRanked);
}

/** The single ordering used by the candidate list AND the automatic allocator (see rankCandidates). */
export function compareRanked(a: RankInput & { tier: CandidateTier }, b: RankInput & { tier: CandidateTier }): number {
  return (
    a.tier - b.tier ||
    subjectRank(a.basis) - subjectRank(b.basis) ||
    Number(b.gradeEligible ?? false) - Number(a.gradeEligible ?? false) ||
    (a.weeklyLoad ?? 0) - (b.weeklyLoad ?? 0) ||
    a.coverLoad - b.coverLoad ||
    a.runLength - b.runLength ||
    (a.recentCovers ?? 0) - (b.recentCovers ?? 0) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

const periodsText = (r: { from: number; to: number }): string => (r.from === r.to ? `P${r.from}` : `P${r.from}–P${r.to}`);
export { periodsText };

const BASIS_TEXT: Record<SubjectBasis, string> = {
  PRIMARY_LINK: 'Teaches this subject as their primary subject',
  SECONDARY_LINK: 'Teaches this subject as a secondary subject',
  TEACHES_IN_TIMETABLE: 'Has lessons of this subject in the published timetable',
};

/** Why this teacher is where they are in the list, in a sentence the admin can read. */
export function explainCandidate(c: { tier: CandidateTier; basis: SubjectBasis | null; runFrom: number; runTo: number; runLength: number }): string {
  const run = periodsText({ from: c.runFrom, to: c.runTo });
  if (c.tier === 3) return `Would teach ${c.runLength} consecutive periods (${run}) with this cover. Offered only because nobody else can take the lesson without that; assigning needs your confirmation.`;
  const lead = c.basis !== null ? BASIS_TEXT[c.basis] : 'Not a teacher of this subject, but free: a temporary cover (no subject link or grade eligibility is needed or changed)';
  return c.runLength === 1 ? `${lead}; the cover would not join any other teaching period.` : `${lead}; the cover would make ${c.runLength} consecutive periods (${run}), fewer than four.`;
}

/** The sentence above the list: which tier is being shown and why. */
export function selectionSummary(s: { tier1: number; tier2: number; tier3: number }): string {
  if (s.tier1 > 0) return 'Free teachers of this subject are listed first.';
  if (s.tier2 > 0) return 'No suitable teacher of this subject is available for this lesson, so other free teachers are shown. This is a temporary cover: nobody\'s subjects or grades are changed.';
  if (s.tier3 > 0) return 'Nobody can take this lesson without ending up with four consecutive teaching periods, so these last-resort options are offered. Assigning one needs your confirmation.';
  return '';
}
