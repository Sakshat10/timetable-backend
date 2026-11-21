// Pure tests (no database, no server) for the substitution rules: dates, absence/period matching, contradictions, candidate classification, validation.
//   npx tsx test-substitution-core.ts
import {
  absenceCoversSlot, absencesOverlap, adjacency, classifyCandidate, CONSECUTIVE_THRESHOLD, dayCount, eachDate, EXCLUSION_REASONS, isEligibilityReason, isValidDateString, noCandidateMessage, periodRange, weekdayOf, explainCandidate, periodsText, rankCandidates, runThrough, selectionSummary, subjectRank, tierOf, TIER_KEYS,
  type CandidateFacts, type RankInput, type SubjectBasis,
} from './src/modules/substitution/substitution.core.js';
import { absenceShapeIssues, assignReplacementSchema, createAbsenceSchema, createUnavailabilitySchema, listCoverQuerySchema, updateAbsenceSchema } from './src/modules/substitution/substitution.schema.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);

section('DATES');
check('real calendar dates only', isValidDateString('2030-02-28') && !isValidDateString('2030-02-30') && !isValidDateString('2030-13-01') && !isValidDateString('30-01-01') && !isValidDateString('2030-1-1') && isValidDateString('2028-02-29') && !isValidDateString('2030-02-29'));
check('weekday of a calendar date (2030-03-04 is a Monday, 2030-03-10 a Sunday)', weekdayOf('2030-03-04') === 'MONDAY' && weekdayOf('2030-03-10') === 'SUNDAY' && weekdayOf('2030-03-09') === 'SATURDAY');
check('eachDate is inclusive and crosses month/year ends', eachDate('2029-12-30', '2030-01-02').join() === '2029-12-30,2029-12-31,2030-01-01,2030-01-02' && eachDate('2030-03-04', '2030-03-04').length === 1);
check('dayCount is inclusive (leap day included)', dayCount('2028-02-28', '2028-03-01') === 3 && dayCount('2030-01-01', '2030-12-31') === 365);

section('ABSENCE AND PERIODS');
const full = { startDate: '2030-03-04', endDate: '2030-03-06', scope: 'FULL_DAY' as const, fromPeriod: null, toPeriod: null };
const part = { startDate: '2030-03-04', endDate: '2030-03-06', scope: 'PERIODS' as const, fromPeriod: 2, toPeriod: 3 };
check('FULL_DAY covers every period of every day in range, nothing outside', absenceCoversSlot(full, '2030-03-04', 1) && absenceCoversSlot(full, '2030-03-06', 12) && !absenceCoversSlot(full, '2030-03-07', 1) && !absenceCoversSlot(full, '2030-03-03', 1));
check('PERIODS covers only its periods, on each day of the range', absenceCoversSlot(part, '2030-03-05', 2) && absenceCoversSlot(part, '2030-03-05', 3) && !absenceCoversSlot(part, '2030-03-05', 1) && !absenceCoversSlot(part, '2030-03-05', 4));
check('periodRange', periodRange(full).join() === '1,12' && periodRange(part).join() === '2,3');
const other = (over: object) => ({ startDate: '2030-03-06', endDate: '2030-03-08', scope: 'FULL_DAY' as const, fromPeriod: null, toPeriod: null, ...over });
check('contradiction needs BOTH date overlap and period overlap', absencesOverlap(full, other({})) && !absencesOverlap(full, other({ startDate: '2030-03-07' })) && absencesOverlap(full, other({ scope: 'PERIODS', fromPeriod: 5, toPeriod: 6 })) && !absencesOverlap(part, other({ scope: 'PERIODS', fromPeriod: 4, toPeriod: 6 })) && absencesOverlap(part, other({ scope: 'PERIODS', fromPeriod: 3, toPeriod: 6 })));

section('SHAPE VALIDATION');
const t = '00000000-0000-4000-8000-000000000001';
const okShape = (o: object) => createAbsenceSchema.safeParse({ teacherId: t, startDate: '2030-03-04', endDate: '2030-03-05', ...o }).success;
check('valid full-day and partial-day absences', okShape({}) && okShape({ scope: 'PERIODS', fromPeriod: 1, toPeriod: 2 }) && okShape({ scope: 'FULL_DAY' }) && okShape({ reason: '  flu  ' }));
check('end before start, impossible dates, bad format are rejected', !okShape({ endDate: '2030-03-03' }) && !okShape({ startDate: '2030-02-30' }) && !okShape({ startDate: '04/03/2030' }) && !okShape({ endDate: undefined }));
check('longer than 366 days is rejected, exactly 366 is fine', !okShape({ startDate: '2030-01-01', endDate: '2031-01-02' }) && okShape({ startDate: '2030-01-01', endDate: '2031-01-01' }));
check('FULL_DAY with periods and PERIODS without periods are contradictions', !okShape({ scope: 'FULL_DAY', fromPeriod: 1, toPeriod: 2 }) && !okShape({ fromPeriod: 1 }) && !okShape({ scope: 'PERIODS' }) && !okShape({ scope: 'PERIODS', fromPeriod: 1 }));
check('period range must be 1..12 and ordered', !okShape({ scope: 'PERIODS', fromPeriod: 0, toPeriod: 2 }) && !okShape({ scope: 'PERIODS', fromPeriod: 1, toPeriod: 13 }) && !okShape({ scope: 'PERIODS', fromPeriod: 3, toPeriod: 2 }) && !okShape({ scope: 'PERIODS', fromPeriod: 1.5, toPeriod: 2 }));
check('teacher id must be a UUID; unknown scope rejected', !okShape({ teacherId: 'x' }) && !okShape({ scope: 'HALF' }));
check('blank reason becomes null; reason is capped at 500', createAbsenceSchema.parse({ teacherId: t, startDate: '2030-03-04', endDate: '2030-03-04', reason: '   ' }).reason === null && !okShape({ reason: 'x'.repeat(501) }));
check('update needs at least one field', !updateAbsenceSchema.safeParse({}).success && updateAbsenceSchema.safeParse({ reason: 'x' }).success);
check('absenceShapeIssues on a merged record names the field', absenceShapeIssues({ startDate: '2030-03-05', endDate: '2030-03-04' }).some((i) => i.path === 'endDate'));
check('unavailability: whole day (no period) or one period 1..12', createUnavailabilitySchema.safeParse({ teacherId: t, date: '2030-03-04' }).success && createUnavailabilitySchema.safeParse({ teacherId: t, date: '2030-03-04', periodNumber: 3 }).success && !createUnavailabilitySchema.safeParse({ teacherId: t, date: '2030-03-04', periodNumber: 13 }).success);
check('assignment needs a teacher UUID', assignReplacementSchema.safeParse({ teacherId: t }).success && !assignReplacementSchema.safeParse({ teacherId: 'nope' }).success && !assignReplacementSchema.safeParse({}).success);
check('cover list status filter: comma list of known statuses only', JSON.stringify(listCoverQuerySchema.parse({ status: 'OPEN,ASSIGNED' }).status) === '["OPEN","ASSIGNED"]' && !listCoverQuerySchema.safeParse({ status: 'OPEN,DONE' }).success && listCoverQuerySchema.parse({}).status === undefined);

section('CANDIDATE CLASSIFICATION (temporary cover: availability only, never qualification)');
const free: CandidateFacts = { isAbsentTeacher: false, isActive: true, isAbsent: false, isUnavailable: false, hasLessonInPeriod: false, isCoveringInPeriod: false };
const f = (o: Partial<CandidateFacts>): CandidateFacts => ({ ...free, ...o });
check('an active teacher who is free is a candidate: no subject link and no grade eligibility is part of the facts at all', classifyCandidate(free) === null && !('link' in free));
check('inactive, absent, unavailable, teaching, covering each have their own reason', classifyCandidate(f({ isActive: false })) === 'INACTIVE' && classifyCandidate(f({ isAbsent: true })) === 'ABSENT' && classifyCandidate(f({ isUnavailable: true })) === 'UNAVAILABLE' && classifyCandidate(f({ hasLessonInPeriod: true })) === 'TEACHING_ANOTHER_LESSON' && classifyCandidate(f({ isCoveringInPeriod: true })) === 'ALREADY_COVERING');
check('the absent teacher is never a candidate', classifyCandidate(f({ isAbsentTeacher: true })) === 'IS_ABSENT_TEACHER');
check('order: the absent teacher, then inactive, then absence, unavailability, lesson, cover', classifyCandidate(f({ isAbsentTeacher: true, isActive: false, isAbsent: true })) === 'IS_ABSENT_TEACHER' && classifyCandidate(f({ isActive: false, isAbsent: true, hasLessonInPeriod: true })) === 'INACTIVE' && classifyCandidate(f({ isAbsent: true, isUnavailable: true })) === 'ABSENT' && classifyCandidate(f({ isUnavailable: true, hasLessonInPeriod: true })) === 'UNAVAILABLE' && classifyCandidate(f({ hasLessonInPeriod: true, isCoveringInPeriod: true })) === 'TEACHING_ANOTHER_LESSON');
check('the qualification reasons no longer exist', !(EXCLUSION_REASONS as readonly string[]).includes('NOT_QUALIFIED') && !(EXCLUSION_REASONS as readonly string[]).includes('NOT_ELIGIBLE_FOR_GRADE') && EXCLUSION_REASONS.length === 7 && EXCLUSION_REASONS[6] === 'CONSECUTIVE_NOT_ALLOWED'); // the 7th is the school's NEVER_ALLOW four-in-a-row policy, decided after scoring
check('choosing the absent or an inactive teacher is a 400; every time conflict is a 409', EXCLUSION_REASONS.every((r) => isEligibilityReason(r) === ['IS_ABSENT_TEACHER', 'INACTIVE'].includes(r)));
check('"nobody is available" message lists the reasons with counts, in correct English, and says the request stays unassigned', noCandidateMessage({ ABSENT: 2, UNAVAILABLE: 1, TEACHING_ANOTHER_LESSON: 3, IS_ABSENT_TEACHER: 1 }) === 'No teacher is available to cover this lesson in this period: 2 teachers are absent in this period; 1 teacher is marked unavailable in this period; 3 teachers have a lesson in this period. The request stays unassigned.' && /no other teachers/i.test(noCandidateMessage({})));
check('singular and plural, and every reason has its phrase', noCandidateMessage({ INACTIVE: 1, ALREADY_COVERING: 1 }) === 'No teacher is available to cover this lesson in this period: 1 teacher is inactive; 1 teacher is already covering another lesson in this period. The request stays unassigned.' && !/qualif|link|eligib/i.test(noCandidateMessage({ ABSENT: 1 })));

section('CONSECUTIVE PERIODS (period order and breaks)');
const noBreaks = adjacency(8, []);
const breakAfter3 = adjacency(8, [3]);
check('adjacency: a break/event after period k separates k and k+1; the last period and period 0 have no successor', breakAfter3(2) && !breakAfter3(3) && breakAfter3(4) && !breakAfter3(8) && !breakAfter3(0) && noBreaks(3));
const set = (...n: number[]) => new Set(n);
check('a teacher with P6,P7,P8 taking P5 ends with P5–P8 = 4 consecutive', (() => { const r = runThrough(set(5, 6, 7, 8), 5, noBreaks); return r.from === 5 && r.to === 8 && r.length === 4; })());
check('lessons in P1,P2,P3 and a cover in P4: WITHOUT a break that is 4 in a row, WITH a break after P3 the run is just P4 (breaks interrupt)', runThrough(set(1, 2, 3, 4), 4, noBreaks).length === 4 && runThrough(set(1, 2, 3, 4), 4, breakAfter3).length === 1);
check('a free period between lessons stops the run (P3 and P5 taught, P4 is the cover): run P3–P5 = 3, but with a break after P3 only P4–P5 = 2', runThrough(set(3, 4, 5), 4, noBreaks).length === 3 && runThrough(set(3, 4, 5), 4, breakAfter3).length === 2);
check('the cover can JOIN two runs: P2,P3 and P5,P6 around a cover in P4 = 5 in a row (still "four or more")', runThrough(set(2, 3, 4, 5, 6), 4, noBreaks).length === 5);
check('the number of lessons in the day is irrelevant: lessons at P1 and P8 and a cover in P4 run only P4', runThrough(set(1, 4, 8), 4, noBreaks).length === 1);
check('the run never leaves the day: a cover in P1 with lessons in P2,P3 is P1–P3', (() => { const r = runThrough(set(1, 2, 3), 1, noBreaks); return r.from === 1 && r.to === 3; })());
check('threshold is four: three in a row is fine, four and five are last-resort', CONSECUTIVE_THRESHOLD === 4 && tierOf(true, 3) === 1 && tierOf(false, 3) === 2 && tierOf(true, 4) === 3 && tierOf(false, 5) === 3 && tierOf(true, 1) === 1);

section('TIERS AND SELECTION ORDER');
const cand = (id: string, basis: SubjectBasis | null, runLength: number, coverLoad = 0, name = id): RankInput => ({ id, name, basis, runLength, coverLoad });
const order = (xs: RankInput[]) => rankCandidates(xs).map((c) => `${c.id}:${c.tier}${c.offered ? '' : '(hidden)'}`).join(' ');
check('a teacher of the subject comes first, then any other free teacher, then the last resort', order([cand('late', 'PRIMARY_LINK', 4), cand('other', null, 1), cand('same', 'SECONDARY_LINK', 2)]) === 'same:1 other:2 late:3(hidden)');
check('a subject teacher who would create four loses to ANY other free teacher who would not (no link or eligibility needed for that)', order([cand('same4', 'PRIMARY_LINK', 4), cand('anyone2', null, 2)]) === 'anyone2:2 same4:3(hidden)');
check('a teacher with no link and no lessons of the subject is tier 2, never excluded', rankCandidates([cand('x', null, 1)])[0]!.tier === 2 && rankCandidates([cand('x', null, 1)])[0]!.sameSubject === false);
check('a teacher who teaches the subject only in the published timetable (no link) is a SAME-subject teacher', rankCandidates([cand('x', 'TEACHES_IN_TIMETABLE', 1)])[0]!.tier === 1);
check('within tier 1 the way the subject is taught ranks first: primary link, secondary link, timetable only', order([cand('t', 'TEACHES_IN_TIMETABLE', 1), cand('s', 'SECONDARY_LINK', 1), cand('p', 'PRIMARY_LINK', 3)]) === 'p:1 s:1 t:1');
check('then (requested priority order) the lighter cover load today, the shorter resulting run, the name, the id', order([cand('c', 'PRIMARY_LINK', 3), cand('a', 'PRIMARY_LINK', 1, 2), cand('b', 'PRIMARY_LINK', 1, 0), cand('d', 'PRIMARY_LINK', 1, 0, 'a-name')]) === 'd:1 b:1 c:1 a:1');
check('within tier 2 the cover load, then the run, the name and the id matter', order([cand('z', null, 2), cand('y', null, 1, 3), cand('x', null, 1, 0)]) === 'x:2 z:2 y:2');
const rich = (id: string, o: Partial<RankInput>, basis: SubjectBasis | null = 'PRIMARY_LINK'): RankInput => ({ id, name: id, basis, runLength: 1, coverLoad: 0, ...o });
check('grade eligibility beats a lighter weekly workload, and both come after the subject basis', order([rich('light', { weeklyLoad: 1 }), rich('eligible', { gradeEligible: true, weeklyLoad: 20 }), rich('sec', { gradeEligible: true, weeklyLoad: 0 }, 'SECONDARY_LINK')]) === 'eligible:1 light:1 sec:1');
check('then the lower weekly workload, before covers today and before the run', order([rich('busy', { weeklyLoad: 25 }), rich('free', { weeklyLoad: 10, coverLoad: 2, runLength: 3 })]) === 'free:1 busy:1');
check('fairness: with everything else equal the teacher with fewer recent covers is chosen, then name', order([rich('b', { recentCovers: 4 }), rich('a', { recentCovers: 4 }), rich('c', { recentCovers: 1 })]) === 'c:1 a:1 b:1');
check('a missing grade/workload/fairness fact is neutral (old callers keep working)', order([rich('b', {}), rich('a', {})]) === 'a:1 b:1');
check('tier 3 is OFFERED only when nobody avoids four in a row; otherwise flagged hidden but still returned', rankCandidates([cand('x', 'PRIMARY_LINK', 4), cand('y', null, 5)]).every((c) => c.tier === 3 && c.offered) && rankCandidates([cand('x', 'PRIMARY_LINK', 4), cand('y', null, 2)]).find((c) => c.id === 'x')!.offered === false);
check('last resort order: subject teachers first (best basis first), then the shorter run', order([cand('o4', null, 4), cand('s5', 'SECONDARY_LINK', 5), cand('p4', 'PRIMARY_LINK', 4)]) === 'p4:3 s5:3 o4:3');
check('no candidates → nothing to rank', rankCandidates([]).length === 0);
check('ranking is deterministic: input order does not matter', (() => { const xs = [cand('a', 'PRIMARY_LINK', 2, 1), cand('b', null, 1), cand('c', 'SECONDARY_LINK', 4), cand('d', 'PRIMARY_LINK', 2, 0), cand('e', null, 5)]; const ref = order(xs); return [[...xs].reverse(), [xs[2]!, xs[0]!, xs[4]!, xs[1]!, xs[3]!]].every((p) => order(p) === ref); })());
check('subjectRank: primary < secondary < timetable < nobody', subjectRank('PRIMARY_LINK') < subjectRank('SECONDARY_LINK') && subjectRank('SECONDARY_LINK') < subjectRank('TEACHES_IN_TIMETABLE') && subjectRank('TEACHES_IN_TIMETABLE') < subjectRank(null));
check('tier keys', TIER_KEYS[1] === 'SAME_SUBJECT' && TIER_KEYS[2] === 'OTHER_AVAILABLE' && TIER_KEYS[3] === 'LAST_RESORT');
check('explanations: the basis, the run, and that a non-subject teacher is a temporary cover that changes nothing', /primary subject/.test(explainCandidate({ tier: 1, basis: 'PRIMARY_LINK', runFrom: 4, runTo: 4, runLength: 1 })) && /secondary subject/.test(explainCandidate({ tier: 1, basis: 'SECONDARY_LINK', runFrom: 4, runTo: 4, runLength: 1 })) && /published timetable/.test(explainCandidate({ tier: 1, basis: 'TEACHES_IN_TIMETABLE', runFrom: 4, runTo: 5, runLength: 2 })) && /Not a teacher of this subject, but free: a temporary cover \(no subject link or grade eligibility is needed or changed\)/.test(explainCandidate({ tier: 2, basis: null, runFrom: 5, runTo: 5, runLength: 1 })) && /4 consecutive periods \(P5–P8\)/.test(explainCandidate({ tier: 3, basis: null, runFrom: 5, runTo: 8, runLength: 4 })) && periodsText({ from: 3, to: 3 }) === 'P3');
check('the summary says which tier is being shown and why', /Free teachers of this subject are listed first/.test(selectionSummary({ tier1: 1, tier2: 0, tier3: 0 })) && /other free teachers are shown/.test(selectionSummary({ tier1: 0, tier2: 2, tier3: 1 })) && /last-resort/.test(selectionSummary({ tier1: 0, tier2: 0, tier3: 1 })) && selectionSummary({ tier1: 0, tier2: 0, tier3: 0 }) === '');

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
