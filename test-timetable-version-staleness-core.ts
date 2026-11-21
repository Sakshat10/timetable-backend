// Module 11 - Phase 7F-3: pure tests (no database) of the version-list query contract and the staleness helpers.
//
//   A  the status filter (single, comma-separated, repeated, duplicates, invalid values)
//   B  includeStaleness and the other list parameters
//   C  the staleness helpers (shape, grouping by input hash)
//   D  the decision itself is the Phase 7D helper, unchanged: its answers still map one to one
//
// Run with   NODE_ENV=production npx tsx test-timetable-version-staleness-core.ts
import 'dotenv/config';
import { cloneBodySchema, listVersionsQuerySchema } from './src/modules/timetable-version/timetable-version.schema.js';
import { assessmentFailed, fromAssessment, groupByInputHash, spreadByHash, unusableSnapshot, type StalenessInfo } from './src/modules/timetable-version/timetable-version.staleness-core.js';
import { assessStaleness } from './src/modules/timetable-version/timetable-version.edit-core.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);

const YEAR = '11111111-1111-4111-8111-111111111111';
const parse = (q: Record<string, unknown>) => listVersionsQuerySchema.safeParse({ academicYearId: YEAR, ...q });
const statuses = (q: Record<string, unknown>): string => JSON.stringify(parse(q).data?.status);

section('A. The status filter');
{
  check('absent: undefined (every status, exactly as before)', parse({}).success && parse({}).data?.status === undefined);
  check('each single status is accepted', statuses({ status: 'DRAFT' }) === '["DRAFT"]' && statuses({ status: 'PUBLISHED' }) === '["PUBLISHED"]' && statuses({ status: 'ARCHIVED' }) === '["ARCHIVED"]');
  check('comma-separated: DRAFT,PUBLISHED and all three', statuses({ status: 'DRAFT,PUBLISHED' }) === '["DRAFT","PUBLISHED"]' && statuses({ status: 'ARCHIVED,DRAFT,PUBLISHED' }) === '["ARCHIVED","DRAFT","PUBLISHED"]');
  check('repeated parameter (an array, as Fastify delivers it): same result', statuses({ status: ['DRAFT', 'ARCHIVED'] }) === '["DRAFT","ARCHIVED"]');
  check('a mix of repeated and comma-separated', statuses({ status: ['DRAFT,PUBLISHED', 'ARCHIVED'] }) === '["DRAFT","PUBLISHED","ARCHIVED"]');
  check('duplicates collapse (DRAFT,DRAFT -> one)', statuses({ status: 'DRAFT,DRAFT' }) === '["DRAFT"]' && statuses({ status: ['DRAFT', 'DRAFT'] }) === '["DRAFT"]');
  check('spaces around a value are tolerated', statuses({ status: ' DRAFT , PUBLISHED ' }) === '["DRAFT","PUBLISHED"]');
  const rejected = ['draft', 'Draft', 'ALL', 'ACTIVE', 'COMPLETED', 'DRAFT;PUBLISHED', 'DRAFT PUBLISHED', '1', 'null'];
  check(`invalid values are rejected: ${rejected.join(', ')}`, rejected.every((v) => !parse({ status: v }).success));
  check('empty value, empty element and lone comma are rejected (never silently "all")', ['', ',', 'DRAFT,', ',DRAFT', 'DRAFT,,PUBLISHED', '  '].every((v) => !parse({ status: v }).success));
  check('one invalid value among valid ones rejects the whole filter', !parse({ status: 'DRAFT,BOGUS' }).success && !parse({ status: ['DRAFT', 'BOGUS'] }).success);
  check('the error names the field and lists the valid values', (() => { const r = parse({ status: 'x' }); return !r.success && r.error.issues[0]!.path[0] === 'status' && /DRAFT, PUBLISHED or ARCHIVED/.test(r.error.issues[0]!.message); })());
  check('a non-string status (number, object) is rejected', !parse({ status: 5 }).success && !parse({ status: { a: 1 } }).success);
}

section('B. includeStaleness and the other parameters');
{
  check('absent: false', parse({}).data?.includeStaleness === false);
  check('"true" -> true, "false" -> false', parse({ includeStaleness: 'true' }).data?.includeStaleness === true && parse({ includeStaleness: 'false' }).data?.includeStaleness === false);
  check('only the literals true/false: TRUE, 1, yes, empty are rejected', ['TRUE', 'True', '1', '0', 'yes', 'on', ''].every((v) => !parse({ includeStaleness: v }).success));
  check('the error names the field', (() => { const r = parse({ includeStaleness: 'maybe' }); return !r.success && r.error.issues[0]!.path[0] === 'includeStaleness'; })());
  check('academicYearId stays required and a UUID', !listVersionsQuerySchema.safeParse({}).success && !listVersionsQuerySchema.safeParse({ academicYearId: 'x' }).success);
  const both = parse({ status: 'PUBLISHED', includeStaleness: 'true' });
  check('both together', both.success && JSON.stringify(both.data?.status) === '["PUBLISHED"]' && both.data?.includeStaleness === true);
  check('unknown query keys are ignored, as before', parse({ foo: 'bar' }).success);
  check('the clone body takes the same flag as a real boolean', cloneBodySchema.safeParse({ includeStaleness: true }).success && !cloneBodySchema.safeParse({ includeStaleness: 'true' }).success);
}

section('C. The helpers');
{
  const info = (i: StalenessInfo) => JSON.stringify(i);
  check('an assessment maps one to one: fresh -> {false, NONE}', info(fromAssessment({ stale: false, reason: 'NONE' })) === '{"isStale":false,"reason":"NONE"}');
  check('changed -> {true, CONFIGURATION_CHANGED}; not normalizable -> {true, CONFIGURATION_NOT_NORMALIZABLE}', fromAssessment({ stale: true, reason: 'CONFIGURATION_CHANGED' }).isStale === true && fromAssessment({ stale: true, reason: 'CONFIGURATION_NOT_NORMALIZABLE' }).reason === 'CONFIGURATION_NOT_NORMALIZABLE');
  check('an unusable snapshot and a failed assessment are null (not established), never false', unusableSnapshot().isStale === null && unusableSnapshot().reason === 'SNAPSHOT_UNUSABLE' && assessmentFailed().isStale === null && assessmentFailed().reason === 'ASSESSMENT_FAILED');
  const rows = [{ id: 'a', inputHash: 'h1' }, { id: 'b', inputHash: 'h2' }, { id: 'c', inputHash: 'h1' }, { id: 'd', inputHash: 'h1' }];
  const groups = groupByInputHash(rows);
  check('grouping by input hash: 2 groups, h1 holds a, c, d in order', groups.size === 2 && JSON.stringify(groups.get('h1')) === '["a","c","d"]' && JSON.stringify(groups.get('h2')) === '["b"]');
  const spread = spreadByHash(groups, new Map<string, StalenessInfo>([['h1', { isStale: true, reason: 'CONFIGURATION_CHANGED' }], ['h2', { isStale: false, reason: 'NONE' }]]));
  check('every version of a hash receives that hash\'s answer', spread.size === 4 && ['a', 'c', 'd'].every((id) => spread.get(id)!.isStale === true) && spread.get('b')!.isStale === false);
  check('a hash with no answer leaves its versions out (the caller reports them as not established)', spreadByHash(groups, new Map()).size === 0);
  check('empty input gives empty output', groupByInputHash([]).size === 0 && spreadByHash(new Map(), new Map()).size === 0);
}

section('D. The decision is the unchanged Phase 7D helper');
{
  const core = (extra: Record<string, unknown> = {}) => ({ contractVersion: 'x', grid: { days: [], periods: [], maxTeacherPeriodsPerWeek: 30 }, sections: [], teachers: [], assignments: [], fixedEntries: [], ...extra }) as never;
  check('identical cores: not stale, NONE', assessStaleness(core(), core()).stale === false && assessStaleness(core(), core()).reason === 'NONE');
  check('a changed core: stale, CONFIGURATION_CHANGED', assessStaleness(core(), core({ sections: [{ id: 'x' }] })).reason === 'CONFIGURATION_CHANGED');
  check('no fresh core: stale, CONFIGURATION_NOT_NORMALIZABLE', assessStaleness(core(), null).reason === 'CONFIGURATION_NOT_NORMALIZABLE');
  check('fixed entries (history of locks) do not make a version stale: the configuration hash ignores them, as before', assessStaleness(core({ fixedEntries: [{ assignmentId: 'a', dayOfWeek: 'MONDAY', periodNumber: 1 }] }), core()).stale === false);
}

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
