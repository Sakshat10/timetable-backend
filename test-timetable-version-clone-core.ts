// Module 11 - Phase 7F-2: pure tests (no database) of the clone decisions and the request schema.
// Run with   NODE_ENV=production npx tsx test-timetable-version-clone-core.ts
import 'dotenv/config';
import { checkCloneAllowed, DEFAULT_LOCK_MODE, LOCK_MODES, lockedAfterClone } from './src/modules/timetable-version/timetable-version.clone-core.js';
import { cloneBodySchema } from './src/modules/timetable-version/timetable-version.schema.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);

section('A. Lock modes');
check('exactly three modes, KEEP is the default', JSON.stringify(LOCK_MODES) === '["KEEP","ALL","NONE"]' && DEFAULT_LOCK_MODE === 'KEEP');
check('KEEP keeps each flag as it is', lockedAfterClone('KEEP', true) === true && lockedAfterClone('KEEP', false) === false);
check('ALL locks every lesson, whatever it was', lockedAfterClone('ALL', true) === true && lockedAfterClone('ALL', false) === true);
check('NONE unlocks every lesson, whatever it was', lockedAfterClone('NONE', true) === false && lockedAfterClone('NONE', false) === false);

section('B. The refusal rules');
{
  const ok = { yearStatus: 'DRAFT' as const, slots: { drafts: 3, activeRuns: 0 }, max: 20 };
  check('a DRAFT or ACTIVE year with room: allowed', checkCloneAllowed(ok) === null && checkCloneAllowed({ ...ok, yearStatus: 'ACTIVE' }) === null);
  const completed = checkCloneAllowed({ ...ok, yearStatus: 'COMPLETED' });
  check('a COMPLETED year: 409 ACADEMIC_YEAR_NOT_EDITABLE with the status', completed?.status === 409 && completed.code === 'ACADEMIC_YEAR_NOT_EDITABLE' && completed.details.yearStatus === 'COMPLETED');
  check('the year rule wins over the cap rule (no counting needed for a closed year)', checkCloneAllowed({ yearStatus: 'COMPLETED', slots: { drafts: 99, activeRuns: 1 }, max: 20 })?.code === 'ACADEMIC_YEAR_NOT_EDITABLE');
  check('19 drafts: allowed; 20 drafts: refused DRAFT_LIMIT_REACHED (equality blocks)', checkCloneAllowed({ ...ok, slots: { drafts: 19, activeRuns: 0 } }) === null && checkCloneAllowed({ ...ok, slots: { drafts: 20, activeRuns: 0 } })?.code === 'DRAFT_LIMIT_REACHED');
  const pending = checkCloneAllowed({ ...ok, slots: { drafts: 19, activeRuns: 1 } });
  check('19 drafts + a generation in progress: refused, pendingRun true, and the message says so', pending?.code === 'DRAFT_LIMIT_REACHED' && pending.details.pendingRun === true && /generation in progress/.test(pending.message) && pending.details.drafts === 19 && pending.details.maxDraftsPerYear === 20);
  check('18 drafts + a generation: allowed (18 + 1 < 20)', checkCloneAllowed({ ...ok, slots: { drafts: 18, activeRuns: 1 } }) === null);
  check('legacy overflow (22 drafts) and a cap below the count (5 drafts, cap 3): refused', checkCloneAllowed({ ...ok, slots: { drafts: 22, activeRuns: 0 } })?.code === 'DRAFT_LIMIT_REACHED' && checkCloneAllowed({ ...ok, slots: { drafts: 5, activeRuns: 0 }, max: 3 })?.code === 'DRAFT_LIMIT_REACHED');
  check('cap 1: 0 drafts allowed, 1 refused', checkCloneAllowed({ ...ok, slots: { drafts: 0, activeRuns: 0 }, max: 1 }) === null && checkCloneAllowed({ ...ok, slots: { drafts: 1, activeRuns: 0 }, max: 1 }) !== null);
}

section('C. The request body');
{
  const parse = (v: unknown) => cloneBodySchema.safeParse(v);
  check('empty body: lockMode KEEP', parse({}).success && parse({}).data?.lockMode === 'KEEP');
  check('KEEP, ALL, NONE are accepted', LOCK_MODES.every((m) => parse({ lockMode: m }).success && parse({ lockMode: m }).data?.lockMode === m));
  check('lower case, empty, number and null lockMode are rejected', ['keep', '', 1, null, 'ALL '].every((v) => !parse({ lockMode: v }).success));
  check('unknown fields are rejected (the year, school, status, lessons and revision cannot be chosen)', ['academicYearId', 'schoolId', 'status', 'entries', 'expectedRevision', 'versionNumber', 'staleness'].every((k) => !parse({ [k]: 'x' }).success));
  check('includeStaleness (Phase 7F-3) is a valid optional boolean: absent -> false, true/false accepted, strings and numbers rejected', parse({}).data?.includeStaleness === false && parse({ includeStaleness: true }).data?.includeStaleness === true && parse({ includeStaleness: false }).success && ['true', 1, null, 'yes'].every((v) => !parse({ includeStaleness: v }).success));
  check('a non-object body is rejected', !parse('ALL').success && !parse([]).success && !parse(null).success);
}

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
