// Module 11 - Phase 7F-1: pure tests (no database) of the readable timetable view assembly.
//
//   A  period-time resolution (SNAPSHOT / CURRENT / UNAVAILABLE, changedSinceCapture, the legacy heuristic)
//   B  the grid and the cells (full grid, free slots, order, times attached to periods)
//   C  totals (lessons, locks, manual, free slots, per day, per subject / teacher / section)
//   D  names (resolved, unresolved = null, never invented)
//   E  determinism and purity
//
// Run with   NODE_ENV=production npx tsx test-timetable-version-view-core.ts
import { buildView, resolvePeriodTimes, sameTimes, toHHmm, type NameMaps, type ViewEntryRow, type ViewGrid } from './src/modules/timetable-version/timetable-version.view-core.js';
import { type PeriodTime } from './src/modules/timetable-generation/timetable-generation.period-times.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);

const times = (n: number, shift = 0): PeriodTime[] => Array.from({ length: n }, (_, k) => ({ periodNumber: k + 1, startMinute: 480 + k * 60 + shift, endMinute: 530 + k * 60 + shift }));
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY'];
const grid: ViewGrid = { days: DAYS.map((dayOfWeek, index) => ({ index, dayOfWeek })), periods: [1, 2, 3, 4].map((periodNumber) => ({ periodNumber, continuesIntoNext: periodNumber === 2 })) };
const names: NameMaps = {
  sections: new Map([['s1', { name: 'A', code: 'A', gradeName: 'Grade 8' }], ['s2', { name: 'B', code: 'B', gradeName: 'Grade 8' }]]),
  subjects: new Map([['m', { name: 'Maths', code: 'MATH' }], ['e', { name: 'English', code: 'ENG' }]]),
  teachers: new Map([['t1', { name: 'Ms Rao', isActive: true }], ['t2', { name: 'Mr Khan', isActive: false }]]),
};
let n = 0;
const entry = (over: Partial<ViewEntryRow>): ViewEntryRow => ({ id: `e${++n}`, sectionId: 's1', subjectId: 'm', teacherId: 't1', subjectRequirementId: 'r1', dayOfWeek: 'MONDAY', periodNumber: 1, source: 'GENERATED', isLocked: false, ...over });
const input = (over: Partial<Parameters<typeof resolvePeriodTimes>[0]> = {}): Parameters<typeof resolvePeriodTimes>[0] => ({
  stored: times(4), storedCapturedAt: new Date('2030-01-02T03:04:05.000Z'), live: times(4), liveRead: true, requested: 'snapshot', liveRowsCreatedAfterVersion: false, gridPeriods: [1, 2, 3, 4], ...over,
});

section('A. Period-time resolution');
{
  check('toHHmm: 480 -> 08:00, 545 -> 09:05, 0 -> 00:00, 1439 -> 23:59', toHHmm(480) === '08:00' && toHHmm(545) === '09:05' && toHHmm(0) === '00:00' && toHHmm(1439) === '23:59');
  check('sameTimes: equal, different minute, different length, different order of the same periods', sameTimes(times(4), times(4)) && !sameTimes(times(4), times(4, 1)) && !sameTimes(times(4), times(3)) && sameTimes(times(4), [...times(4)].reverse()));
  const snap = resolvePeriodTimes(input());
  check('stored times + identical live schedule: SNAPSHOT, capturedAt, changedSinceCapture FALSE, complete', snap.info.source === 'SNAPSHOT' && snap.info.capturedAt === '2030-01-02T03:04:05.000Z' && snap.info.changedSinceCapture === false && snap.info.incomplete === false && snap.info.periodRowsCreatedAfterVersion === null);
  check('the SNAPSHOT times are the stored ones', snap.byPeriod.get(1)?.startMinute === 480 && snap.byPeriod.size === 4);
  const moved = resolvePeriodTimes(input({ live: times(4, 30) }));
  check('the live schedule moved by 30 minutes: still SNAPSHOT times (08:00), changedSinceCapture TRUE', moved.info.source === 'SNAPSHOT' && moved.info.changedSinceCapture === true && moved.byPeriod.get(1)?.startMinute === 480);
  const backAgain = resolvePeriodTimes(input({ live: times(4) }));
  check('changed and changed back is NOT reported (a content comparison, not a timestamp)', backAgain.info.changedSinceCapture === false);
  check('a period added or removed in the live schedule counts as changed', resolvePeriodTimes(input({ live: times(5) })).info.changedSinceCapture === true && resolvePeriodTimes(input({ live: times(3) })).info.changedSinceCapture === true);
  check('no live schedule rows at all (null) with stored times: changed TRUE', resolvePeriodTimes(input({ live: null })).info.changedSinceCapture === true);
  check('live not read: nothing is claimed (changedSinceCapture null)', resolvePeriodTimes(input({ live: null, liveRead: false })).info.changedSinceCapture === null);
  check('stored times that do not cover the grid are flagged incomplete', resolvePeriodTimes(input({ stored: times(3), live: times(3) })).info.incomplete === true);

  const legacy = resolvePeriodTimes(input({ stored: null, storedCapturedAt: null, live: null, liveRead: false }));
  check('LEGACY version, default request: UNAVAILABLE, no times, no capture time, changedSinceCapture null, incomplete', legacy.info.source === 'UNAVAILABLE' && legacy.byPeriod.size === 0 && legacy.info.capturedAt === null && legacy.info.changedSinceCapture === null && legacy.info.incomplete === true);
  const legacyCurrent = resolvePeriodTimes(input({ stored: null, storedCapturedAt: null, requested: 'current', liveRowsCreatedAfterVersion: true }));
  check('LEGACY version, explicit current: CURRENT live times, changedSinceCapture NULL (nothing to compare), the heuristic hint is present', legacyCurrent.info.source === 'CURRENT' && legacyCurrent.byPeriod.get(2)?.startMinute === 540 && legacyCurrent.info.changedSinceCapture === null && legacyCurrent.info.periodRowsCreatedAfterVersion === true && legacyCurrent.info.capturedAt === null);
  check('the heuristic false/true follows the input and is null when unknown', resolvePeriodTimes(input({ stored: null, requested: 'current', liveRowsCreatedAfterVersion: false })).info.periodRowsCreatedAfterVersion === false && resolvePeriodTimes(input({ stored: null, requested: 'current', liveRowsCreatedAfterVersion: null })).info.periodRowsCreatedAfterVersion === null);
  const snapCurrent = resolvePeriodTimes(input({ requested: 'current', live: times(4, 30) }));
  check('a version WITH a snapshot, explicit current: the live times, but the comparison is still reported and no heuristic is offered', snapCurrent.info.source === 'CURRENT' && snapCurrent.byPeriod.get(1)?.startMinute === 510 && snapCurrent.info.changedSinceCapture === true && snapCurrent.info.periodRowsCreatedAfterVersion === null && snapCurrent.info.capturedAt === '2030-01-02T03:04:05.000Z');
  check('current with a live schedule missing a grid period: incomplete; with none: incomplete and no times', resolvePeriodTimes(input({ stored: null, requested: 'current', live: times(3) })).info.incomplete === true && resolvePeriodTimes(input({ stored: null, requested: 'current', live: null })).byPeriod.size === 0);
}

section('B. The grid and the cells');
{
  const e1 = entry({ dayOfWeek: 'TUESDAY', periodNumber: 3 });
  const e2 = entry({ dayOfWeek: 'MONDAY', periodNumber: 1, subjectId: 'e', teacherId: 't2' });
  const view = buildView({ kind: 'section', grid, entries: [e1, e2], names, times: resolvePeriodTimes(input()) });
  check('the cells are the FULL grid: 3 days x 4 periods = 12, free slots included', view.cells.length === 12 && view.cells.filter((c) => c.lesson === null).length === 10);
  check('cells are ordered by day (week order) then period', view.cells.map((c) => `${c.dayOfWeek[0]}${c.periodNumber}`).join(',') === 'M1,M2,M3,M4,T1,T2,T3,T4,W1,W2,W3,W4');
  check('each lesson sits exactly in its slot', view.cells.find((c) => c.dayOfWeek === 'MONDAY' && c.periodNumber === 1)?.lesson?.entryId === e2.id && view.cells.find((c) => c.dayOfWeek === 'TUESDAY' && c.periodNumber === 3)?.lesson?.entryId === e1.id);
  check('the periods carry minutes, HH:mm, and continuesIntoNext', view.grid.periods[0]!.startTime === '08:00' && view.grid.periods[0]!.endTime === '08:50' && view.grid.periods[1]!.startMinute === 540 && view.grid.periods[1]!.continuesIntoNext === true && view.grid.periods[2]!.continuesIntoNext === false);
  check('days carry their index', view.grid.days.map((d) => `${d.index}:${d.dayOfWeek}`).join() === '0:MONDAY,1:TUESDAY,2:WEDNESDAY');
  const unavailable = buildView({ kind: 'section', grid, entries: [e1], names, times: resolvePeriodTimes(input({ stored: null, live: null, liveRead: false })) });
  check('UNAVAILABLE times: every period has null minutes and null HH:mm (nothing invented)', unavailable.grid.periods.every((p) => p.startMinute === null && p.endMinute === null && p.startTime === null && p.endTime === null) && unavailable.periodTimes.source === 'UNAVAILABLE');
  const shuffledGrid: ViewGrid = { days: [...grid.days].reverse(), periods: [...grid.periods].reverse() };
  const again = buildView({ kind: 'section', grid: shuffledGrid, entries: [e2, e1], names, times: resolvePeriodTimes(input()) });
  check('input order does not matter: a shuffled grid and entry list give the identical view', JSON.stringify(again) === JSON.stringify(view));
}

section('C. Totals');
{
  const entries = [
    entry({ dayOfWeek: 'MONDAY', periodNumber: 1, isLocked: true }),
    entry({ dayOfWeek: 'MONDAY', periodNumber: 2, subjectId: 'e', source: 'MANUAL' }),
    entry({ dayOfWeek: 'TUESDAY', periodNumber: 1, subjectId: 'e', teacherId: 't2', isLocked: true, source: 'MANUAL' }),
  ];
  const v = buildView({ kind: 'section', grid, entries, names, times: resolvePeriodTimes(input()) });
  check('lessons 3, locked 2, manual 2, free slots 9', v.totals.lessons === 3 && v.totals.lockedLessons === 2 && v.totals.manualLessons === 2 && v.totals.freeSlots === 9);
  check('per day: Monday 2, Tuesday 1, Wednesday 0', JSON.stringify(v.totals.perDay) === JSON.stringify([{ dayOfWeek: 'MONDAY', lessons: 2 }, { dayOfWeek: 'TUESDAY', lessons: 1 }, { dayOfWeek: 'WEDNESDAY', lessons: 0 }]));
  check('by subject: English 2 then Maths 1 (most lessons first)', v.totals.bySubject.map((s) => `${s.name}:${s.lessons}`).join() === 'English:2,Maths:1');
  check('section view carries byTeacher and no bySection', v.totals.byTeacher?.map((t) => `${t.name}:${t.lessons}`).join() === 'Ms Rao:2,Mr Khan:1' && v.totals.bySection === undefined);
  const teacher = buildView({ kind: 'teacher', grid, entries: [entry({ sectionId: 's1' }), entry({ sectionId: 's2', dayOfWeek: 'TUESDAY' }), entry({ sectionId: 's2', dayOfWeek: 'WEDNESDAY' })], names, times: resolvePeriodTimes(input()) });
  check('teacher view carries bySection (grade + section name) and no byTeacher', teacher.totals.bySection?.map((s) => `${s.name}:${s.lessons}`).join() === 'Grade 8 B:2,Grade 8 A:1' && teacher.totals.byTeacher === undefined);
  const empty = buildView({ kind: 'section', grid, entries: [], names, times: resolvePeriodTimes(input()) });
  check('EMPTY timetable: the full grid of free slots, zero totals, empty breakdowns', empty.cells.length === 12 && empty.cells.every((c) => c.lesson === null) && empty.totals.lessons === 0 && empty.totals.freeSlots === 12 && empty.totals.bySubject.length === 0 && empty.totals.byTeacher?.length === 0 && empty.totals.perDay.every((d) => d.lessons === 0));
  const outside = buildView({ kind: 'section', grid, entries: [entry({ dayOfWeek: 'SATURDAY' }), entry({ periodNumber: 9 }), entry({ dayOfWeek: 'MONDAY', periodNumber: 2 })], names, times: resolvePeriodTimes(input()) });
  check('lessons outside the grid are COUNTED and reported (outsideGrid), never silently dropped or placed', outside.totals.outsideGrid === 2 && outside.totals.lessons === 3 && outside.cells.filter((c) => c.lesson).length === 1 && outside.totals.freeSlots === 11);
}

section('D. Names');
{
  const v = buildView({ kind: 'teacher', grid, entries: [entry({ sectionId: 's2', subjectId: 'e', teacherId: 't2' })], names, times: resolvePeriodTimes(input()) });
  const lesson = v.cells.find((c) => c.lesson)!.lesson!;
  check('section, subject and teacher names, codes and the grade are resolved', lesson.section.name === 'B' && lesson.section.gradeName === 'Grade 8' && lesson.subject.name === 'English' && lesson.subject.code === 'ENG' && lesson.teacher.name === 'Mr Khan' && lesson.teacher.isActive === false);
  const unknown = buildView({ kind: 'section', grid, entries: [entry({ sectionId: 'x', subjectId: 'y', teacherId: 'z' })], names, times: resolvePeriodTimes(input()) });
  const l2 = unknown.cells.find((c) => c.lesson)!.lesson!;
  check('an id that could not be resolved in scope shows null names (never a made-up or foreign name), the id stays', l2.section.name === null && l2.subject.name === null && l2.teacher.name === null && l2.teacher.isActive === null && l2.teacher.id === 'z');
  check('lock state and source are carried exactly', (() => { const c = buildView({ kind: 'section', grid, entries: [entry({ isLocked: true, source: 'MANUAL' })], names, times: resolvePeriodTimes(input()) }).cells.find((x) => x.lesson)!.lesson!; return c.isLocked === true && c.source === 'MANUAL'; })());
}

section('E. Determinism and purity');
{
  const entries = [entry({}), entry({ periodNumber: 2, subjectId: 'e' })];
  const frozen = JSON.stringify(entries);
  const a = JSON.stringify(buildView({ kind: 'section', grid, entries, names, times: resolvePeriodTimes(input()) }));
  const b = JSON.stringify(buildView({ kind: 'section', grid, entries, names, times: resolvePeriodTimes(input()) }));
  check('the same input gives byte-identical output, and the input is not mutated', a === b && JSON.stringify(entries) === frozen);
}

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
