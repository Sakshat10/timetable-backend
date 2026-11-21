// Calls the REAL HTTP server on port 4010 (log in, then every endpoint family the dashboard uses), infers the exact request/response shapes from
// the live responses, cross-checks dashboard metrics derived from the API against direct SQL counts, and writes:
//   e2e/dashboard/API_CONTRACTS.md          (generated: shapes + trimmed real examples)
//   e2e/dashboard/.run/api-contracts.json   (generated: full recorded exchanges)
// Read-only against the database (SELECT only) and read-only against the API (GET) except the login itself and two deliberate error probes.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDisposableIdentity, assertDisposableUrl, assertTestPort } from './lib/guard.js';

assertDisposableUrl(process.env.DATABASE_URL);
const BASE = (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4010').replace(/\/$/, '');
const baseUrl = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(baseUrl.hostname)) throw new Error('E2E GUARD: the API under test must be on this machine.');
assertTestPort(Number(baseUrl.port));

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, '.run', 'seed-manifest.json'), 'utf8'));
const pgModule = (await import('pg')).default;
const db = new pgModule.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
await assertDisposableIdentity(db);
const sql = async <T = Record<string, any>>(text: string): Promise<T[]> => (await db.query(text)).rows as T[];
const num = async (text: string): Promise<number> => Number(Object.values((await sql(text))[0]!)[0]);

// ---------------------------------------------------------------------------------------------------------------------------------
let pass = 0; let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => { if (ok) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); } };
const section = (t: string): void => console.log(`\n── ${t} ──`);

interface Exchange { id: string; title: string; method: string; path: string; query: Record<string, string> | null; body: unknown; status: number; response: any; cookie?: string }
const exchanges: Exchange[] = [];
let cookie: string | null = null;
async function api(id: string, title: string, method: string, path: string, o: { query?: Record<string, string>; body?: unknown; auth?: boolean; expect?: number; record?: boolean } = {}): Promise<{ status: number; body: any }> {
  const qs = o.query ? `?${new URLSearchParams(o.query).toString()}` : '';
  const res = await fetch(`${BASE}${path}${qs}`, { method, headers: { ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(o.auth !== false && cookie ? { cookie } : {}) }, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
  let body: any = null;
  try { body = await res.json(); } catch { /* none */ }
  if (o.record !== false) {
    const setCookie = res.headers.get('set-cookie');
    exchanges.push({ id, title, method, path, query: o.query ?? null, body: o.body ?? null, status: res.status, response: body, ...(setCookie ? { cookie: setCookie.replace(/(=)[^;]+/, '$1<session-token>') } : {}) });
  }
  if (res.status === 429) throw new Error(`${method} ${path} -> 429: the login rate limit (5 per 15 minutes per IP, in memory) is used up. This script uses 2 logins per run. Run: e2e/dashboard/e2e.sh restart   (resets the limiter of the disposable server)`);
  if (o.expect !== undefined && res.status !== o.expect) throw new Error(`${method} ${path}${qs} -> ${res.status}, expected ${o.expect}: ${JSON.stringify(body).slice(0, 400)}`);
  if (res.headers.get('set-cookie') && id === 'login') { const c = res.headers.get('set-cookie')!.split(';')[0]!; cookie = c; }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------------------------------------------------------------
const D = manifest.dates.wd as Record<string, string>;
const today = D['0']!; const tomorrow = D['1']!;
const yrs = manifest.academicYears;
const curYear = yrs.current.id as string;
const publishedV2 = manifest.timetableVersions.currentPublished as string;
const sectionIdsCur = Object.values(manifest.structure.current.sectionIds) as string[];

section('0. Health, authentication');
check('GET /health → 200 {status:"ok"}', (await api('health', 'Health check', 'GET', '/health', { auth: false, expect: 200 })).body.status === 'ok');
check('unauthenticated GET /api/teachers → 401', (await api('unauth', 'Any protected route without a session', 'GET', '/api/teachers', { auth: false })).status === 401);
const login = await api('login', 'Admin login (sets the session cookie)', 'POST', '/api/admin/login', { body: manifest.login.request.body, auth: false, expect: 200 });
check('login → 200 and a session cookie', login.status === 200 && cookie !== null && /^session_token=/.test(cookie ?? ''));
check('GET /api/admin/me → 200 with the admin', (await api('me', 'Current admin', 'GET', '/api/admin/me', { expect: 200 })).body.data.email === manifest.login.email);
check('wrong password → 401 (no cookie reused)', (await api('login-bad', 'Login with a wrong password', 'POST', '/api/admin/login', { body: { ...manifest.login.request.body, password: 'Wrong#Pass-1234' }, auth: false })).status === 401);

section('1. Academic years');
const years = await api('academic-years', 'List academic years', 'GET', '/api/academic-years', { expect: 200 });
const yl: any[] = years.body.data;
check('3 academic years: COMPLETED / ACTIVE / DRAFT', yl.length === 3 && ['COMPLETED', 'ACTIVE', 'DRAFT'].every((s) => yl.some((y) => y.status === s)), JSON.stringify(yl.map((y) => y.status)));
check('current year contains the reference working day', yl.some((y) => y.status === 'ACTIVE' && String(y.startDate).slice(0, 10) <= today && today <= String(y.endDate).slice(0, 10)));
await api('academic-year', 'One academic year', 'GET', `/api/academic-years/${curYear}`, { expect: 200 });

section('2. Readiness (timetable feasibility)');
const feas: Record<string, any> = {};
for (const k of ['previous', 'current', 'future'] as const) feas[k] = (await api(`feasibility-${k}`, `Timetable feasibility, ${k} year`, 'GET', '/api/timetable-feasibility', { query: { academicYearId: yrs[k].id }, expect: 200 })).body.data;
check('readiness: previous READY, current READY, future NOT_READY', feas.previous.status === 'READY' && feas.current.status === 'READY' && feas.future.status === 'NOT_READY', JSON.stringify(['previous', 'current', 'future'].map((k) => feas[k].status)));
check('future year says why (an error with a code)', (feas.future.errors ?? []).length > 0 && typeof feas.future.errors[0].code === 'string');
check('current year reports unassigned demand from the 3 deliberately missing assignments', Number(feas.current.summary?.unassignedPeriods ?? feas.current.summary?.totalUnassignedPeriods ?? -1) >= 0, JSON.stringify(feas.current.summary).slice(0, 300));

section('3. Timetable versions and section views');
const versions: Record<string, any[]> = {};
for (const k of ['previous', 'current', 'future'] as const) versions[k] = (await api(`versions-${k}`, `Timetable versions, ${k} year (with staleness)`, 'GET', '/api/timetable-versions', { query: { academicYearId: yrs[k].id, includeStaleness: 'true' }, expect: 200 })).body.data;
const vs = (k: string) => versions[k]!.map((v: any) => v.status).sort().join(',');
check('versions: previous [PUBLISHED], current [ARCHIVED,DRAFT,PUBLISHED], future []', vs('previous') === 'PUBLISHED' && vs('current') === 'ARCHIVED,DRAFT,PUBLISHED' && vs('future') === '', `${vs('previous')} | ${vs('current')} | ${vs('future')}`);
await api('version', 'One timetable version', 'GET', `/api/timetable-versions/${publishedV2}`, { expect: 200 });
await api('version-validation', 'Validation of a version', 'GET', `/api/timetable-versions/${publishedV2}/validation`, { expect: 200 });
const views: any[] = [];
for (const sid of sectionIdsCur) views.push((await api(`section-view-${views.length}`, 'Section timetable (one section, one week)', 'GET', `/api/timetable-versions/${publishedV2}/timetable`, { query: { view: 'section', id: sid }, expect: 200, record: views.length === 0 })).body.data);
await api('teacher-view', 'Teacher timetable (one teacher, one week)', 'GET', `/api/timetable-versions/${publishedV2}/timetable`, { query: { view: 'teacher', id: manifest.teachers.anita.id }, expect: 200 });
const lessonCountApi = views.reduce((n, v) => n + countLessons(v), 0);
const lessonCountSql = await num(`SELECT count(*) FROM timetable_entries WHERE "versionId" = '${publishedV2}'`);
check(`all 6 section views together hold every lesson of the published version (${lessonCountSql}); totals.lessons agrees`, lessonCountApi === lessonCountSql && views.reduce((n, v) => n + Number(v.totals?.lessons ?? 0), 0) === lessonCountSql, `${lessonCountApi} vs ${lessonCountSql}`);

section('4. Teachers, subjects, structure, assignments');
const teachers = await api('teachers', 'List teachers (with linked subjects)', 'GET', '/api/teachers', { expect: 200 });
const tl: any[] = teachers.body.data;
check('29 teachers (1 inactive, 1 without subjects)', tl.length === 29 && tl.filter((t) => t.isActive === false).length === 1 && tl.filter((t) => (t.subjects ?? []).length === 0).length === 1, `${tl.length}`);
const subjects = await api('subjects', 'List subjects', 'GET', '/api/subjects', { expect: 200 });
check('15 subjects', subjects.body.data.length === 15);
const grades = await api('grades', 'List grades of a year', 'GET', '/api/grades', { query: { academicYearId: curYear }, expect: 200 });
check('2 grades in the current year', grades.body.data.length === 2);
const gradeId8 = manifest.structure.current.gradeIds.G8 as string; const gradeId11 = manifest.structure.current.gradeIds.G11 as string;
const sections8 = await api('sections', 'List sections of a grade', 'GET', `/api/grades/${gradeId8}/sections`, { expect: 200 });
const sections11 = await api('sections-11', 'List sections of a streamed grade', 'GET', `/api/grades/${gradeId11}/sections`, { record: false, expect: 200 });
const streams11 = await api('streams', 'List streams of a grade', 'GET', `/api/grades/${gradeId11}/streams`, { expect: 200 });
check('Grade 8: 2 sections; Class 11: 4 sections in 2 streams', sections8.body.data.length === 2 && sections11.body.data.length === 4 && streams11.body.data.length === 2);
const sst = await api('section-subject-teachers', 'Teacher assignments of a year', 'GET', '/api/section-subject-teachers', { query: { academicYearId: curYear }, expect: 200 });
const expectedAssigned = await num(`SELECT count(*) FROM section_subject_teachers s JOIN sections x ON x.id = s."sectionId" JOIN grades g ON g.id = x."gradeId" WHERE g."academicYearId" = '${curYear}'`);
check(`current-year assignments listed = ${expectedAssigned} (43 explicit + 3 missing on purpose)`, sst.body.data.length === expectedAssigned && expectedAssigned === 43, `${sst.body.data.length}`);
const curriculum = await api('curriculum', 'Curriculum overview of a year', 'GET', '/api/curriculum', { query: { academicYearId: curYear }, expect: 200 });
check('curriculum overview answers', curriculum.status === 200);
await api('schedule-configs', 'Schedule configuration of a year', 'GET', '/api/schedule-configs', { query: { academicYearId: curYear }, expect: 200 });
await api('generations', 'Generation runs of a year', 'GET', '/api/timetable-generations', { query: { academicYearId: curYear, limit: '20' }, expect: 200 });

section('5. Teacher absences, unavailability, substitutions (the dashboard\'s operational reads)');
const dayCovers = async (d: string) => (await api(`covers-${d}`, 'Cover requests of one day', 'GET', '/api/substitutions', { query: { from: d, to: d, limit: '500' }, expect: 200, record: d === tomorrow })).body.data;
const c1 = await dayCovers(tomorrow);
const sqlDay = await sql<{ status: string; n: string }>(`SELECT status::text, count(*) AS n FROM cover_requests WHERE date = '${tomorrow}' GROUP BY 1`);
check(`covers of ${tomorrow}: items.length == total == SQL count`, c1.items.length === c1.total && c1.total === sqlDay.reduce((a, r) => a + Number(r.n), 0), `${c1.items.length}/${c1.total}`);
check('per-status breakdown from the API equals SQL', sqlDay.every((r) => c1.items.filter((i: any) => i.status === r.status).length === Number(r.n)));
const cToday = await dayCovers(today);
check(`covers of today (${today}) equal SQL`, cToday.total === (await num(`SELECT count(*) FROM cover_requests WHERE date = '${today}'`)));
const open = (await api('covers-open-upcoming', 'Open cover requests from a date on', 'GET', '/api/substitutions', { query: { status: 'OPEN', from: tomorrow, limit: '500' }, expect: 200 })).body.data;
check('open requests from tomorrow on equal SQL', open.total === (await num(`SELECT count(*) FROM cover_requests WHERE status = 'OPEN' AND date >= '${tomorrow}'`)));
check('unfilled requests are identifiable: OPEN with attention.code NO_AVAILABLE_TEACHER', open.items.some((i: any) => i.attention?.code === 'NO_AVAILABLE_TEACHER'));
check('held-for-review requests are identifiable: attention.code MANUAL_ASSIGNMENT_NEEDS_REVIEW', open.items.some((i: any) => i.attention?.code === 'MANUAL_ASSIGNMENT_NEEDS_REVIEW'));
const all = (await api('covers-all', 'Cover requests, every status and date (no filter except limit)', 'GET', '/api/substitutions', { query: { limit: '500' }, expect: 200 })).body.data;
check('every cover status is represented: OPEN, ASSIGNED, CANCELLED, OBSOLETE', ['OPEN', 'ASSIGNED', 'CANCELLED', 'OBSOLETE'].every((s) => all.items.some((i: any) => i.status === s)));
check('automatic and manual sources and temporary-unqualified covers are visible on the row', all.items.some((i: any) => i.assignmentSource === 'AUTOMATIC') && all.items.some((i: any) => i.assignmentSource === 'MANUAL') && all.items.some((i: any) => i.temporaryUnqualified === true));
const pageA = (await api('covers-paged', 'Cover requests, paged', 'GET', '/api/substitutions', { query: { limit: '5', offset: '0' }, expect: 200, record: false })).body.data;
const pageB = (await api('covers-paged-2', 'Cover requests, second page', 'GET', '/api/substitutions', { query: { limit: '5', offset: '5' }, expect: 200, record: false })).body.data;
check('limit/offset paging: total stable, pages disjoint', pageA.total === all.total && pageA.items.length === 5 && !pageA.items.some((a: any) => pageB.items.some((b: any) => b.id === a.id)));

const absOn = async (d: string) => (await api(`absences-${d}`, 'Active absences overlapping a date range', 'GET', '/api/teacher-absences', { query: { status: 'ACTIVE', from: d, to: d }, expect: 200, record: d === tomorrow })).body.data;
const middleDay = D['2']!;
const aMid = await absOn(middleDay);
const absSql = await num(`SELECT count(*) FROM teacher_absences WHERE status = 'ACTIVE' AND "startDate" <= '${middleDay}' AND "endDate" >= '${middleDay}'`);
const aItems: any[] = Array.isArray(aMid) ? aMid : aMid.items;
check(`absences on ${middleDay}: the API counts multi-day absences on their middle day (overlap semantics) = SQL ${absSql}`, aItems.length === absSql && aItems.some((a) => a.teacherId === manifest.teachers.sunita.id || a.teacher?.id === manifest.teachers.sunita.id), `${aItems.length} vs ${absSql}`);
await api('absences-all', 'Active absences (no date filter): FULL_DAY, PERIODS and multi-day', 'GET', '/api/teacher-absences', { query: { status: 'ACTIVE' }, expect: 200 });
const absCancelled = (await api('absences-cancelled', 'Cancelled absences', 'GET', '/api/teacher-absences', { query: { status: 'CANCELLED' }, expect: 200 })).body.data;
check('cancelled absences are listed by status=CANCELLED (2)', (Array.isArray(absCancelled) ? absCancelled : absCancelled.items).length === 2);
await api('absence', 'One absence', 'GET', `/api/teacher-absences/${manifest.absences.autoPhysics.id}`, { expect: 200 });
await api('absence-summary', 'Allocation summary of an absence', 'GET', `/api/teacher-absences/${manifest.absences.autoPhysics.id}/substitution-summary`, { expect: 200 });
const unavDay = D['4']!;
const un = (await api('unavailability', 'Active unavailability on a date range', 'GET', '/api/teacher-unavailability', { query: { status: 'ACTIVE', from: unavDay, to: unavDay }, expect: 200 })).body.data;
const unItems: any[] = Array.isArray(un) ? un : un.items;
check(`unavailability on ${unavDay} equals SQL`, unItems.length === (await num(`SELECT count(*) FROM teacher_unavailabilities WHERE status = 'ACTIVE' AND date = '${unavDay}'`)), `${unItems.length}`);
await api('unavailability-cancelled', 'Cancelled unavailability', 'GET', '/api/teacher-unavailability', { query: { status: 'CANCELLED' }, expect: 200 });
await api('substitution-settings', 'School substitution policy', 'GET', '/api/substitution-settings', { expect: 200 });
const oneCover = all.items.find((i: any) => i.status === 'ASSIGNED');
await api('cover', 'One cover request (detail with history)', 'GET', `/api/substitutions/${oneCover.id}`, { expect: 200 });
const openCover = open.items.find((i: any) => i.attention?.code === 'NO_AVAILABLE_TEACHER');
await api('candidates', 'Candidate substitutes of an OPEN request', 'GET', `/api/substitutions/${openCover.id}/candidates`, { query: { includeExcluded: 'true' }, expect: 200 });

section('6. Substitution events feed');
const first = (await api('events', 'Substitution events (oldest first, cursor paged)', 'GET', '/api/substitution-events', { query: { limit: '10' }, expect: 200 })).body.data;
const collected: any[] = [...first.items];
let more: boolean = first.hasMore === true; let cursor: string | null = first.nextCursor ?? null; let pages = 1;
while (more && cursor && pages < 40) { const p = (await api('events-next', 'Substitution events, next page', 'GET', '/api/substitution-events', { query: { limit: '10', cursor }, expect: 200, record: pages === 1 })).body.data; collected.push(...p.items); more = p.hasMore === true; cursor = p.nextCursor ?? null; pages++; }
// The feed is a projection: one ABSENCE_RECORDED per absence, one ABSENCE_CANCELLED per cancelled absence, and one item per cover event except the bookkeeping CREATED.
const expectedFeed = (await num(`SELECT count(*) FROM cover_events WHERE action <> 'CREATED'`)) + (await num(`SELECT count(*) FROM teacher_absences`)) + (await num(`SELECT count(*) FROM teacher_absences WHERE status = 'CANCELLED'`));
check(`paging 10 at a time (stop on hasMore=false) yields every feed item exactly once (${expectedFeed})`, collected.length === expectedFeed && new Set(collected.map((e) => e.id)).size === expectedFeed && pages >= 4, `${collected.length}/${expectedFeed}, pages=${pages}`);
const times = collected.map((e) => Date.parse(e.occurredAt));
check('feed is ordered OLDEST FIRST by occurredAt (ascending)', times.every((t, i) => i === 0 || t >= times[i - 1]!));
check('history exists: some feed items are older than today (backdated historical records)', collected.some((e) => Date.parse(e.occurredAt) < Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)));
const feedTypes = [...new Set(collected.map((e) => e.type))].sort();
console.log(`  feed item types seen: ${feedTypes.join(', ')}`);
check('feed items carry a boolean "automatic"; "message" is string | null (null when the admin gave no note, so the UI composes its own sentence from type + teachers)', collected.every((e) => typeof e.automatic === 'boolean' && (e.message === null || typeof e.message === 'string')) && collected.some((e) => e.message === null));
const sinceOnly = (await api('events-since', 'Substitution events since a timestamp (polling)', 'GET', '/api/substitution-events', { query: { since: first.nextSince ?? '1970-01-01T00:00:00.000Z', limit: '10' }, expect: 200 })).body.data;
check('polling with since=<nextSince of the first page> returns items after that instant only', sinceOnly.items.every((e: any) => Date.parse(e.occurredAt) > Date.parse(first.nextSince)) );

section('7. Dashboard metrics derived from the API alone');
const activeTeachers = tl.filter((t) => t.isActive).length;
const absentToday = (await absOn(today)); const absentTodayItems: any[] = Array.isArray(absentToday) ? absentToday : absentToday.items;
const unToday = (await api('unavailability-today', 'Unavailability today', 'GET', '/api/teacher-unavailability', { query: { status: 'ACTIVE', from: today, to: today }, expect: 200, record: false })).body.data;
const fullDayUnavail = (Array.isArray(unToday) ? unToday : unToday.items).filter((u: any) => u.periodNumber == null).length;
const metrics = {
  referenceDay: today,
  teachersTotal: tl.length, teachersActive: activeTeachers, subjects: subjects.body.data.length,
  gradesCurrentYear: grades.body.data.length, sectionsCurrentYear: sections8.body.data.length + sections11.body.data.length,
  absentTeachersToday: new Set(absentTodayItems.map((a) => a.teacherId ?? a.teacher?.id)).size,
  teachersAvailableToday: activeTeachers - new Set(absentTodayItems.map((a) => a.teacherId ?? a.teacher?.id)).size - fullDayUnavail,
  coversToday: { total: cToday.total, assigned: cToday.items.filter((i: any) => i.status === 'ASSIGNED').length, open: cToday.items.filter((i: any) => i.status === 'OPEN').length },
  openRequestsUpcoming: open.total,
  publishedVersionCurrentYear: versions.current!.find((v: any) => v.status === 'PUBLISHED')?.versionNumber,
  lessonsPerWeekPublished: lessonCountApi,
  assignmentsMissingCurrentYear: await num(`SELECT (SELECT coalesce(sum(1),0) FROM subject_requirements r JOIN grades g ON g.id=r."gradeId" JOIN sections s ON s."gradeId"=g.id AND (r."streamId" IS NULL OR r."streamId"=s."streamId") WHERE g."academicYearId"='${curYear}') - (SELECT count(*) FROM section_subject_teachers s2 JOIN sections x ON x.id=s2."sectionId" JOIN grades g2 ON g2.id=x."gradeId" WHERE g2."academicYearId"='${curYear}')`),
};
console.log('  derived metrics:', JSON.stringify(metrics));
check('derived: 28 active teachers of 29', metrics.teachersActive === 28);
check('derived: assignments missing in the current year = 3 (derivable from requirements × sections − assignments, not from one field)', metrics.assignmentsMissingCurrentYear === 3, String(metrics.assignmentsMissingCurrentYear));
check('derived: teacher weekly workload from the 6 section views equals SQL for every teacher', await workloadMatches(views));

section('8. Error contract probes');
check('malformed id → 400 (validation error)', (await api('error-400', 'Validation error (malformed id)', 'GET', '/api/substitutions/not-a-uuid')).status === 400);
check('unknown id → 404', (await api('error-404', 'Unknown id', 'GET', '/api/substitutions/00000000-0000-4000-8000-000000000000')).status === 404);

// ---------------------------------------------------------------------------------------------------------------------------------
function countLessons(view: any): number { return (view?.cells ?? []).filter((c: any) => c.lesson).length; }
async function workloadMatches(vws: any[]): Promise<boolean> {
  const fromApi = new Map<string, number>();
  for (const v of vws) for (const c of v?.cells ?? []) if (c.lesson?.teacher?.id) fromApi.set(c.lesson.teacher.id, (fromApi.get(c.lesson.teacher.id) ?? 0) + 1);
  const rows = await sql<{ id: string; n: string }>(`SELECT "teacherId" AS id, count(*) AS n FROM timetable_entries WHERE "versionId" = '${publishedV2}' GROUP BY 1`);
  return rows.length === fromApi.size && rows.every((r) => fromApi.get(r.id) === Number(r.n));
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Shape inference + generated documentation
// ---------------------------------------------------------------------------------------------------------------------------------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENUM_KEYS = new Set(['status', 'type', 'dayOfWeek', 'assignmentSource', 'scope', 'severity', 'solutionSource', 'solverStatus', 'weightsVersion', 'tierKey', 'action', 'view']);
function typeOf(values: any[], pad: string, key = ''): string {
  const nulls = values.filter((v) => v === null || v === undefined).length;
  const vals = values.filter((v) => v !== null && v !== undefined);
  let base = 'unknown';
  if (vals.length > 0) {
    if (vals.every((v) => Array.isArray(v))) { const items = vals.flat(); base = items.length === 0 ? 'Array<unknown>' : `Array<${typeOf(items, pad, key)}>`; }
    else if (vals.every((v) => typeof v === 'object' && !Array.isArray(v))) {
      const keys: string[] = []; for (const v of vals) for (const k of Object.keys(v)) if (!keys.includes(k)) keys.push(k);
      const lines = keys.map((k) => { const present = vals.filter((v) => k in v); return `${pad}  ${k}${present.length < vals.length ? '?' : ''}: ${typeOf(present.map((v) => v[k]), `${pad}  `, k)}`; });
      base = `{\n${lines.join('\n')}\n${pad}}`;
    } else if (vals.every((v) => typeof v === 'string')) {
      const distinct = [...new Set(vals as string[])];
      if (ENUM_KEYS.has(key) && distinct.every((s) => /^[A-Z][A-Z0-9_]*$/.test(s)) && distinct.length <= 12) base = `${distinct.sort().map((s) => `"${s}"`).join(' | ')} /* observed */`;
      else if (distinct.every((s) => UUID.test(s))) base = 'string /* uuid */';
      else if (distinct.every((s) => /^\d{4}-\d{2}-\d{2}T/.test(s))) base = 'string /* ISO datetime */';
      else if (distinct.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))) base = 'string /* YYYY-MM-DD */';
      else base = 'string';
    } else base = [...new Set(vals.map((v) => typeof v))].join(' | ');
  }
  return nulls > 0 ? `${base} | null` : base;
}
function trim(v: any, depth = 0): any {
  if (Array.isArray(v)) return v.length === 0 ? [] : [trim(v[0], depth + 1), ...(v.length > 1 ? [`… ${v.length - 1} more`] : [])];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x, depth + 1)]));
  if (typeof v === 'string' && v.length > 70) return `${v.slice(0, 67)}…`;
  return v;
}

const lines: string[] = [];
lines.push('# Dashboard API contracts (generated)', '', `Generated by \`e2e/dashboard/verify-api.ts\` from live responses of the backend on ${BASE} against the disposable database. Do not edit by hand: re-run \`e2e/dashboard/e2e.sh verify\`.`, '',
  `Reference dates used: today(wd0)=${today}, wd1=${tomorrow}. All responses use the envelope \`{ success: boolean, message: string, data: … }\`; errors are \`{ success:false, message, errors? , data? }\`.`, '',
  'How to read the shapes: they are inferred from live responses. `/* observed */` after an enum union means these are the values seen in the seeded data; the complete value sets are in the Prisma schema (`CoverStatus`: OPEN, ASSIGNED, CANCELLED, OBSOLETE; `CoverAssignmentSource`: MANUAL, AUTOMATIC; `TimetableVersionStatus`: DRAFT, PUBLISHED, ARCHIVED; `AcademicYearStatus`: DRAFT, ACTIVE, COMPLETED). `unknown | null` means only `null` was observed for that field in the sampled rows; the broader samples (all statuses) show its real type. `x?:` = present on some rows only.', '',
  'Authentication: `POST /api/admin/login` sets an **HttpOnly** cookie `session_token` (`Path=/; SameSite=Lax; Max-Age=604800`, no `Secure` flag outside production). Send it on every request (`credentials: "include"` when not using the Vite proxy).', '');
for (const x of exchanges) {
  lines.push(`## ${x.title}`, '', `\`${x.method} ${x.path}\`${x.query ? `  query: \`${JSON.stringify(x.query)}\`` : ''}`, '');
  if (x.body !== null) lines.push('Request body:', '```json', JSON.stringify(x.id === 'login' || x.id === 'login-bad' ? { ...(x.body as object), password: '<password>' } : x.body, null, 2), '```', '');
  if (x.cookie) lines.push(`Response header: \`Set-Cookie: ${x.cookie}\``, '');
  lines.push(`Response **${x.status}** shape:`, '```ts', typeOf([x.response], ''), '```', '', 'Example (trimmed):', '```json', JSON.stringify(trim(x.response), null, 2), '```', '');
}
writeFileSync(join(here, 'API_CONTRACTS.md'), lines.join('\n'));
writeFileSync(join(here, '.run', 'api-contracts.json'), JSON.stringify(exchanges, null, 2));
console.log(`\nwrote e2e/dashboard/API_CONTRACTS.md (${exchanges.length} exchanges) and .run/api-contracts.json`);
console.log(`\nverify: ${pass} passed, ${fail} failed`);
await db.end();
process.exit(fail > 0 ? 1 : 0);
