// Module 11 - Phase 7F-0: pure tests (no database) for the draft cap and the period-time snapshot.
//
//   A  the draft-slot decision rule (every purpose, equality, legacy overflow, cap 1)
//   B  MAX_DRAFTS_PER_YEAR configuration (default, bounds, malformed values fail fast)
//   C  the DRAFT_LIMIT_REACHED failure code in the contract
//   D  period times: the schema, the grid match, and that they are NOT part of the input hash
//   E  the persist error is never retried as a transient database error
//
// Run with   NODE_ENV=production npx tsx test-timetable-draft-cap-core.ts
import 'dotenv/config'; // first: some imported modules create the database pool
import { DEFAULT_MAX_DRAFTS_PER_YEAR, DRAFT_SLOT_LOCK_NAMESPACE, slotsExhausted, type DraftSlotPurpose } from './src/modules/timetable-generation/timetable-generation.draft-slots.js';
import { FAILURE_CODES } from './src/modules/timetable-generation/timetable-generation.contracts.js';
import { FAILURE_CODES as SCHEMA_CODES } from './src/modules/timetable-generation/timetable-generation.schema.js';
import { DEFAULT_RUNNER_SETTINGS, resolveRunnerConfig } from './src/modules/timetable-generation/timetable-generation.runner-config.js';
import { parsePeriodTimes, periodTimesMatchGrid, periodTimesSchema } from './src/modules/timetable-generation/timetable-generation.period-times.js';
import { ConfigurationChangedError, DraftLimitReachedError, isTransientDbError, LeaseLostError } from './src/modules/timetable-generation/timetable-generation.final-persist.js';
import { normalizeProblem, type GenerationSnapshot } from './src/modules/timetable-generation/timetable-generation.normalizer.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);

const slots = (drafts: number, activeRuns: number) => ({ drafts, activeRuns });
const throws = (fn: () => unknown, re: RegExp): boolean => { try { fn(); return false; } catch (e) { return re.test((e as Error).message); } };

section('A. The draft-slot decision rule');
{
  const purposes: DraftSlotPurpose[] = ['ENQUEUE', 'PERSIST', 'CLONE'];
  check('the default cap is 20 and the lock namespace is separate from the queue-size lock key (7411001)', DEFAULT_MAX_DRAFTS_PER_YEAR === 20 && DRAFT_SLOT_LOCK_NAMESPACE === 7_411_002 && DEFAULT_RUNNER_SETTINGS.maxDraftsPerYear === 20);
  for (const p of ['ENQUEUE', 'PERSIST'] as const) {
    check(`${p}: 19 drafts admit (19 < 20), 20 refuse (equality blocks), 21 refuse`, !slotsExhausted(p, slots(19, 0), 20) && slotsExhausted(p, slots(20, 0), 20) && slotsExhausted(p, slots(21, 0), 20));
    check(`${p}: the active run is the caller's own reservation and is NOT counted twice (19 drafts + 1 run admits)`, !slotsExhausted(p, slots(19, 1), 20));
    check(`${p}: legacy overflow (22 drafts, cap 20) refuses; so does a cap lowered below the count (5 drafts, cap 3)`, slotsExhausted(p, slots(22, 0), 20) && slotsExhausted(p, slots(5, 0), 3));
    check(`${p}: cap 1: 0 drafts admit, 1 refuses`, !slotsExhausted(p, slots(0, 0), 1) && slotsExhausted(p, slots(1, 0), 1));
  }
  check('CLONE: an active run RESERVES a slot: 18 drafts + 1 run admits, 19 + 1 refuses, 20 + 0 refuses', !slotsExhausted('CLONE', slots(18, 1), 20) && slotsExhausted('CLONE', slots(19, 1), 20) && slotsExhausted('CLONE', slots(20, 0), 20));
  check('CLONE: 19 drafts and no run admits exactly one more', !slotsExhausted('CLONE', slots(19, 0), 20));
  check('CLONE: legacy overflow refuses', slotsExhausted('CLONE', slots(22, 0), 20) && slotsExhausted('CLONE', slots(21, 1), 20));
  // the invariant itself: from any state satisfying drafts + active <= cap, admitting through the rules never breaks it
  let violated = 0;
  for (const cap of [1, 2, 5, 20]) {
    for (let d = 0; d <= cap; d++) {
      for (const a of [0, 1]) {
        if (d + a > cap) continue;
        // a clone creates a draft: drafts+1
        if (!slotsExhausted('CLONE', slots(d, a), cap) && d + 1 + a > cap) violated++;
        // an enqueue adds a reservation (only possible when no run is active: the unique index): active 0 -> 1
        if (a === 0 && !slotsExhausted('ENQUEUE', slots(d, a), cap) && d + 1 > cap) violated++;
        // a persist converts its reservation into a draft: drafts+1, active-1
        if (a === 1 && !slotsExhausted('PERSIST', slots(d, a), cap) && d + 1 + 0 > cap) violated++;
      }
    }
  }
  check('exhaustive over caps {1,2,5,20}: no admitted operation can move a legal state past the cap', violated === 0, `${violated} violations`);
  check('every purpose has a decision for the same inputs (no undefined behaviour)', purposes.every((p) => typeof slotsExhausted(p, slots(0, 0), 20) === 'boolean'));
}

section('B. MAX_DRAFTS_PER_YEAR configuration');
{
  const res = { cpuCount: 8, totalMemoryBytes: 32 * 1024 ** 3 };
  const cap = (value: string | undefined): number => resolveRunnerConfig(value === undefined ? {} : { MAX_DRAFTS_PER_YEAR: value }, res).config.maxDraftsPerYear;
  check('unset: the agreed default 20', cap(undefined) === 20);
  check('blank: the default', cap('  ') === 20);
  check('1, 20, 500 are accepted as given', cap('1') === 1 && cap('20') === 20 && cap('500') === 500 && cap(' 7 ') === 7);
  check('0 is rejected (a cap of 0 would block all generation)', throws(() => cap('0'), /MAX_DRAFTS_PER_YEAR must be between 1 and 500/));
  check('501 is rejected', throws(() => cap('501'), /MAX_DRAFTS_PER_YEAR must be between 1 and 500/));
  check('negative, decimal, text and exponent forms are rejected (fail fast, never a silent default)', ['-1', '2.5', 'abc', '1e2', '20 drafts'].every((v) => throws(() => cap(v), /MAX_DRAFTS_PER_YEAR must be an integer/)));
}

section('C. The failure code');
{
  check('DRAFT_LIMIT_REACHED is the 16th failure code, appended (no existing code moved)', FAILURE_CODES.length === 16 && FAILURE_CODES[15] === 'DRAFT_LIMIT_REACHED' && FAILURE_CODES[14] === 'NO_SOLUTION_WITH_LOCKS');
  check('the API schema re-exports the same list (it cannot drift)', SCHEMA_CODES === FAILURE_CODES);
  check('codes are unique', new Set(FAILURE_CODES).size === FAILURE_CODES.length);
}

section('D. Period times');
{
  const good = [{ periodNumber: 1, startMinute: 480, endMinute: 530 }, { periodNumber: 2, startMinute: 540, endMinute: 590 }];
  check('a valid 1..n sequence parses', parsePeriodTimes(good)?.length === 2);
  check('empty, unordered, gapped, zero-length and reversed sequences are rejected', [
    [], [good[1], good[0]], [good[0], { periodNumber: 3, startMinute: 600, endMinute: 650 }], [{ periodNumber: 1, startMinute: 480, endMinute: 480 }], [{ periodNumber: 1, startMinute: 530, endMinute: 480 }],
  ].every((v) => parsePeriodTimes(v) === null));
  check('unknown keys, non-integers and out-of-range minutes are rejected', [
    [{ ...good[0], label: 'x' }], [{ periodNumber: 1, startMinute: 480.5, endMinute: 530 }], [{ periodNumber: 1, startMinute: -1, endMinute: 530 }], [{ periodNumber: 1, startMinute: 480, endMinute: 1440 }], 'not an array', null,
  ].every((v) => parsePeriodTimes(v) === null));
  check('more than 12 periods are rejected', parsePeriodTimes(Array.from({ length: 13 }, (_, i) => ({ periodNumber: i + 1, startMinute: i * 10, endMinute: i * 10 + 5 }))) === null && periodTimesSchema.safeParse(good).success);
  check('the grid match: exactly periods 1..periodsPerDay', periodTimesMatchGrid(good as never, 2) && !periodTimesMatchGrid(good as never, 3) && !periodTimesMatchGrid(good as never, 1));

  // times are not scheduling data: the normalizer's input hash is the same whatever the clock times are
  const snapshot: GenerationSnapshot = {
    schoolId: 's', academicYear: { id: 'y', name: 'Y', status: 'DRAFT' },
    schedule: { periodsPerDay: 2, workingDays: ['MONDAY', 'TUESDAY'], periods: [{ periodNumber: 1 }, { periodNumber: 2 }] },
    grades: [{ id: 'g', name: 'G', displayOrder: 1 }], streams: [], sections: [{ id: 'sec', gradeId: 'g', streamId: null, name: 'A', code: 'A' }],
    subjects: [{ id: 'sub', name: 'S', code: 'S', schoolId: 's' }], requirements: [{ id: 'req', gradeId: 'g', streamId: null, subjectId: 'sub', periodsPerWeek: 2 }],
    assignments: [{ id: 'asg', sectionId: 'sec', subjectRequirementId: 'req', teacherId: 't' }],
    teachers: [{ id: 't', schoolId: 's', name: 'T', isActive: true }], teacherSubjects: [{ teacherId: 't', subjectId: 'sub', gradeIds: ['g'] }], timingEvents: [],
  };
  const a = normalizeProblem(snapshot);
  const withTimes = normalizeProblem({ ...snapshot, schedule: { ...snapshot.schedule!, periods: [{ periodNumber: 1, startMinute: 1, endMinute: 2 } as never, { periodNumber: 2, startMinute: 700, endMinute: 760 } as never] } });
  check('the fixture normalises', a.ok && withTimes.ok);
  check('THE EXISTING HASH IS UNCHANGED BY PERIOD TIMES: extra time fields on the snapshot periods do not alter the input hash', a.ok && withTimes.ok && a.problem.inputHash === withTimes.problem.inputHash);
  check('the core carries no clock times at all', a.ok && !JSON.stringify(a.problem.core).includes('startMinute') && !JSON.stringify(a.problem.core).includes('endMinute'));
}

section('E. The persist error is final, never retried');
{
  const err = new DraftLimitReachedError(20, 20);
  check('DraftLimitReachedError carries drafts and max and a message naming both', err.drafts === 20 && err.max === 20 && /20 draft/.test(err.message) && /maximum is 20/.test(err.message));
  check('it is NOT a transient database error (retrying cannot help)', !isTransientDbError(err));
  check('the other final errors still are not transient; a lock timeout still is', !isTransientDbError(new LeaseLostError()) && !isTransientDbError(new ConfigurationChangedError('x')) && isTransientDbError(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })));
}

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
