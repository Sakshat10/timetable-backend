// Module 11 - Phase 7F-2: cloning a timetable version into a new DRAFT, against the real database and the real Fastify app (inject).
//
//   1  a successful clone: every copied field, new ids, the new version's state, the response, Location
//   2  the three lock modes (and that `source` is always preserved)
//   3  source immutability (byte-level), clones of PUBLISHED / ARCHIVED / DRAFT / clone-of-clone
//   4  historical period times (frozen, legacy), staleness, and the 7F-1 view of a clone
//   5  isolation and validation (foreign school, unknown, malformed, strict body, unauthenticated), provenance, invalid source states
//   6  the draft cap (sequential rules, runtime cap change, legacy overflow, reservation) and BUSY
//   7  a large copy (100 sections)
//   8  Swagger
//   9  cleanup and proof that nothing existing changed
//
// Run with   NODE_ENV=production npx tsx test-timetable-version-clone-api.ts
import 'dotenv/config'; // first: the database pool is created when a module imports src/config/database.ts
import './test-fixtures/test-security-env.js'; // a test-only COOKIE_SECRET (production mode refuses the placeholder in .env)
import { createHash, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '@prisma/client';
import pg from 'pg';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { canonicalJson } from './src/modules/timetable-generation/timetable-generation.hash.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import {
  assertQueueIsEmpty, captureLogger, createWorld, destroyWorld, EXISTING_TABLES, fastConfig, fingerprint, mustEnqueue, newTableCounts, prisma, rawPrisma, ScriptedSolver, seedYear, sleep, stampLegacyPeriodTimes,
  solution, waitTerminal, type SeededYear, type SolveCtx, type World,
} from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(json(a)) === canonicalJson(json(b));
const md5 = (v: unknown): string => createHash('md5').update(JSON.stringify(v)).digest('hex');

const writerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 10, connectionTimeoutMillis: 30_000 });
const writer = new PrismaClient({ adapter: new PrismaPg(writerPool) });
const PASSWORD = 'Clone#Test-Pass-2030';
const UUID0 = '00000000-0000-4000-8000-000000000000';
const WEEK = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
const expectedTimes = (n: number, shift = 0) => Array.from({ length: n }, (_, k) => ({ periodNumber: k + 1, startMinute: 480 + k * 60 + shift, endMinute: 530 + k * 60 + shift }));

interface Reply { status: number; body: any; headers: Record<string, any>; ms: number }

async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();
  const worldA: World = await createWorld('M11KA');
  const worldB: World = await createWorld('M11KB');
  const app = await buildApp();
  const savedCap = process.env.MAX_DRAFTS_PER_YEAR;

  const login = async (world: World): Promise<string> => {
    const email = `clone-${world.code}@test.local`;
    await prisma.admin.update({ where: { id: world.adminId }, data: { email, passwordHash: await hashPassword(PASSWORD) } });
    return (await adminService.loginAdmin({ schoolId: world.schoolId, email, password: PASSWORD })).sessionToken;
  };
  const tokA = await login(worldA);
  const tokB = await login(worldB);
  const clone = async (versionId: string, body?: unknown, token: string | null = tokA): Promise<Reply> => {
    const t0 = Date.now();
    const res = await app.inject({ method: 'POST', url: `/api/timetable-versions/${versionId}/clone`, ...(token ? { headers: { cookie: `session_token=${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } } : {}), ...(body !== undefined ? { payload: body as never } : {}) });
    return { status: res.statusCode, body: res.json(), headers: res.headers, ms: Date.now() - t0 };
  };
  const getJson = async (url: string, token: string = tokA) => (await app.inject({ method: 'GET', url, headers: { cookie: `session_token=${token}` } })).json();

  const entriesOf = (versionId: string) => prisma.timetableEntry.findMany({ where: { versionId }, orderBy: [{ sectionId: 'asc' }, { dayOfWeek: 'asc' }, { periodNumber: 'asc' }] });
  const slotKey = (e: { sectionId: string; dayOfWeek: string; periodNumber: number }) => `${e.sectionId}|${e.dayOfWeek}|${e.periodNumber}`;
  const versionsOf = (yearId: string) => prisma.timetableVersion.findMany({ where: { academicYearId: yearId }, orderBy: { versionNumber: 'asc' } });
  const drafts = (yearId: string) => prisma.timetableVersion.count({ where: { academicYearId: yearId, status: 'DRAFT' } });
  const drain = () => prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
  /** Everything about a version and its lessons, as one hash (the proof the source was not written). */
  const fingerprintOf = async (versionId: string) => md5({
    version: await prisma.$queryRaw`SELECT * FROM "timetable_versions" WHERE "id" = ${versionId}`,
    entries: await prisma.$queryRaw`SELECT * FROM "timetable_entries" WHERE "versionId" = ${versionId} ORDER BY "id"`,
  });
  const generate = async (year: SeededYear): Promise<Awaited<ReturnType<typeof versionsOf>>[number]> => {
    const solver = new ScriptedSolver((ctx: SolveCtx) => solution(ctx.problem));
    const runner = new GenerationRunner({ prisma: rawPrisma, solverClient: solver, config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: 10 }, logger: captureLogger().logger });
    const queued = await mustEnqueue(worldA, year);
    await runner.dispatch();
    const run = await waitTerminal(queued.id, 90_000);
    await runner.stop(5);
    if (run.status !== 'SUCCEEDED') throw new Error(`setup: generation ${run.status} ${run.failureCode}`);
    await stampLegacyPeriodTimes(run.versionId!, year.configId); // legacy years only (it has period rows): the snapshot the pre-simplification code stored
    return (await versionsOf(year.yearId)).find((v) => v.id === run.versionId)!;
  };
  const gridSnapshot = (periods: number) => ({ grid: { days: WEEK.map((dayOfWeek, index) => ({ index, dayOfWeek })), periods: Array.from({ length: periods }, (_, k) => ({ periodNumber: k + 1, continuesIntoNext: false })), maxTeacherPeriodsPerWeek: 30 } });

  try {
    const yA = await seedYear(worldA, 'clone-a', { sections: 3, legacy: true });
    const yB = await seedYear(worldB, 'clone-b', { sections: 1, subjects: [2] });
    const V = await generate(yA);
    const vEntries = await entriesOf(V.id);
    // a realistic source: two locked lessons, one of them MANUAL, one MANUAL but unlocked
    const lockedOnly = vEntries[0]!;
    const lockedManual = vEntries[1]!;
    const manualOnly = vEntries[2]!;
    await prisma.timetableEntry.update({ where: { id: lockedOnly.id }, data: { isLocked: true } });
    await prisma.timetableEntry.update({ where: { id: lockedManual.id }, data: { isLocked: true, source: 'MANUAL' } });
    await prisma.timetableEntry.update({ where: { id: manualOnly.id }, data: { source: 'MANUAL' } });
    const srcEntries = await entriesOf(V.id);
    const srcBefore = await fingerprintOf(V.id);
    check('setup: a real generated source with its period-time snapshot, 36 lessons, 2 locked, 2 MANUAL', V.status === 'DRAFT' && V.periodTimes !== null && srcEntries.length === 36 && srcEntries.filter((e) => e.isLocked).length === 2 && srcEntries.filter((e) => e.source === 'MANUAL').length === 2);

    // =================================================================================================================
    section('1. A successful clone');
    {
      const r = await clone(V.id);
      const d = r.body.data;
      check('201, success envelope, and a Location header naming the new version', r.status === 201 && r.body.success === true && r.headers.location === `/api/timetable-versions/${d.id}`, `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      check('the response is the new version\'s summary: DRAFT, revision 1, number 2, never published, counts', d.id !== V.id && d.status === 'DRAFT' && d.revision === 1 && d.versionNumber === V.versionNumber + 1 && d.publishedAt === null && d.archivedAt === null && d.entryCount === 36 && d.lockedCount === 2 && d.manualEditCount === 2 && d.academicYearId === yA.yearId);
      check('...plus the provenance: clonedFromId, clonedFromVersionNumber, lockMode KEEP, periodTimesCaptured true', d.clonedFromId === V.id && d.clonedFromVersionNumber === V.versionNumber && d.lockMode === 'KEEP' && d.periodTimesCaptured === true);
      const row = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: d.id } });
      check('the stored row: same school and year as the source, status DRAFT, revision 1, createdBy the cloning admin, clonedFromId the source, publish fields null', row.schoolId === worldA.schoolId && row.academicYearId === yA.yearId && row.status === 'DRAFT' && row.revision === 1 && row.createdById === worldA.adminId && row.clonedFromId === V.id && row.publishedAt === null && row.archivedAt === null && row.publishedById === null);
      check('copied UNCHANGED: input hash, input snapshot, metrics, baseline metrics, solver diagnostics, solution source, solver status, weights version', row.inputHash === V.inputHash && sameJson(row.inputSnapshot, V.inputSnapshot) && sameJson(row.metrics, V.metrics) && sameJson(row.baselineMetrics, V.baselineMetrics) && sameJson(row.solverDiagnostics, V.solverDiagnostics) && row.solutionSource === V.solutionSource && row.solverStatus === V.solverStatus && row.weightsVersion === V.weightsVersion);
      check('copied UNCHANGED: the frozen period times AND their capture instant', sameJson(row.periodTimes, V.periodTimes) && row.periodTimesCapturedAt!.getTime() === V.periodTimesCapturedAt!.getTime());
      const cEntries = await entriesOf(d.id);
      check('36 lessons, NONE of them sharing an id with the source', cEntries.length === 36 && cEntries.every((e) => !srcEntries.some((s) => s.id === e.id)) && new Set(cEntries.map((e) => e.id)).size === 36);
      const bySlot = new Map(srcEntries.map((e) => [slotKey(e), e]));
      check('every lesson sits in the same slot with the same section, subject, teacher, requirement and source', cEntries.every((e) => { const s = bySlot.get(slotKey(e)); return !!s && s.subjectId === e.subjectId && s.teacherId === e.teacherId && s.subjectRequirementId === e.subjectRequirementId && s.source === e.source; }));
      check('KEEP (the default with no body): each lesson keeps its lock flag', cEntries.every((e) => e.isLocked === bySlot.get(slotKey(e))!.isLocked) && cEntries.filter((e) => e.isLocked).length === 2);
      const list = await getJson(`/api/timetable-versions?academicYearId=${yA.yearId}`);
      check('the new draft appears in the version list and its detail is readable', list.data.some((v: any) => v.id === d.id) && (await getJson(`/api/timetable-versions/${d.id}`)).data.entries.length === 36);
      check('the source is not changed (revision, status, every lesson): hash identical', (await fingerprintOf(V.id)) === srcBefore);
      const second = await clone(V.id, {});
      check('cloning again is NOT idempotent: another new draft with the next number, again from the source', second.status === 201 && second.body.data.versionNumber === d.versionNumber + 1 && second.body.data.id !== d.id && second.body.data.clonedFromId === V.id);
      const withBody = await clone(V.id, { lockMode: 'KEEP' });
      check('an explicit lockMode KEEP behaves like the default', withBody.status === 201 && withBody.body.data.lockedCount === 2);
    }

    // =================================================================================================================
    section('2. Lock modes');
    {
      const all = await clone(V.id, { lockMode: 'ALL' });
      const allE = await entriesOf(all.body.data.id);
      check('ALL: 201, every one of the 36 lessons is locked, lockedCount 36, lockMode reported', all.status === 201 && allE.length === 36 && allE.every((e) => e.isLocked) && all.body.data.lockedCount === 36 && all.body.data.lockMode === 'ALL');
      const none = await clone(V.id, { lockMode: 'NONE' });
      const noneE = await entriesOf(none.body.data.id);
      check('NONE: 201, no lesson is locked (the two that were locked in the source are unlocked), lockedCount 0', none.status === 201 && noneE.length === 36 && noneE.every((e) => !e.isLocked) && none.body.data.lockedCount === 0 && none.body.data.lockMode === 'NONE');
      const keep = await clone(V.id, { lockMode: 'KEEP' });
      const keepE = await entriesOf(keep.body.data.id);
      const lockedSlots = new Set(srcEntries.filter((e) => e.isLocked).map(slotKey));
      check('KEEP: exactly the source\'s two locked lessons are locked, in the same slots', keepE.filter((e) => e.isLocked).length === 2 && keepE.every((e) => e.isLocked === lockedSlots.has(slotKey(e))));
      const srcManual = new Set(srcEntries.filter((e) => e.source === 'MANUAL').map(slotKey));
      for (const [mode, rows] of [['ALL', allE], ['NONE', noneE], ['KEEP', keepE]] as const) {
        check(`${mode}: \`source\` is preserved on every lesson (the 2 MANUAL ones stay MANUAL, the 34 GENERATED ones stay GENERATED)`, rows.every((e) => (e.source === 'MANUAL') === srcManual.has(slotKey(e))) && rows.filter((e) => e.source === 'MANUAL').length === 2);
        check(`${mode}: the lessons themselves are identical (same ${rows.length} slots, subjects, teachers)`, rows.length === 36 && rows.every((e) => { const s = srcEntries.find((x) => slotKey(x) === slotKey(e))!; return s.subjectId === e.subjectId && s.teacherId === e.teacherId; }));
      }
      check('every clone so far left the source untouched', (await fingerprintOf(V.id)) === srcBefore);
      const bad = await clone(V.id, { lockMode: 'SOME' });
      const lower = await clone(V.id, { lockMode: 'all' });
      check('an invalid lockMode (SOME, lower-case all): 400 with the field named, nothing created', bad.status === 400 && JSON.stringify(bad.body.errors ?? {}).includes('lockMode') && lower.status === 400);
    }

    // =================================================================================================================
    section('3. Source immutability and every source status');
    {
      const base = await versionsOf(yA.yearId);
      const published = await prisma.timetableVersion.update({ where: { id: base[1]!.id }, data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: worldA.adminId, revision: 5 } });
      const archived = await prisma.timetableVersion.update({ where: { id: base[2]!.id }, data: { status: 'ARCHIVED', publishedAt: new Date(), archivedAt: new Date(), revision: 7 } });
      const pubBefore = await fingerprintOf(published.id);
      const arcBefore = await fingerprintOf(archived.id);
      const cp = await clone(published.id, { lockMode: 'NONE' });
      const ca = await clone(archived.id, { lockMode: 'ALL' });
      check('a PUBLISHED source can be cloned: 201, the clone is a DRAFT, revision 1, not published, provenance points at it', cp.status === 201 && cp.body.data.status === 'DRAFT' && cp.body.data.revision === 1 && cp.body.data.publishedAt === null && cp.body.data.clonedFromId === published.id && cp.body.data.clonedFromVersionNumber === published.versionNumber);
      check('an ARCHIVED source can be cloned the same way', ca.status === 201 && ca.body.data.status === 'DRAFT' && ca.body.data.archivedAt === null && ca.body.data.clonedFromId === archived.id);
      check('THE PUBLISHED AND ARCHIVED SOURCES ARE BYTE-IDENTICAL afterwards (status, revision 5 / 7, publish metadata, every lesson)', (await fingerprintOf(published.id)) === pubBefore && (await fingerprintOf(archived.id)) === arcBefore);
      check('cloning a PUBLISHED version does not disturb the one-published-per-year rule (still exactly one PUBLISHED)', (await prisma.timetableVersion.count({ where: { academicYearId: yA.yearId, status: 'PUBLISHED' } })) === 1);
      const chain = await clone(cp.body.data.id);
      check('a clone of a clone points at its IMMEDIATE parent', chain.status === 201 && chain.body.data.clonedFromId === cp.body.data.id);
      const cloneOfDraft = await clone(V.id);
      check('and a DRAFT source works (already shown): the source stays DRAFT, revision unchanged', cloneOfDraft.status === 201 && (await fingerprintOf(V.id)) === srcBefore);

      // deleting a source keeps its clones
      const throwaway = await clone(V.id);
      const childOfThrowaway = await clone(throwaway.body.data.id);
      const del = await app.inject({ method: 'DELETE', url: `/api/timetable-versions/${throwaway.body.data.id}`, headers: { cookie: `session_token=${tokA}` } });
      const child = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: childOfThrowaway.body.data.id } });
      check('deleting a clone\'s source keeps the clone, its 36 lessons and its times; clonedFromId becomes null (ON DELETE SET NULL)', del.statusCode === 200 && child.clonedFromId === null && (await entriesOf(child.id)).length === 36 && sameJson(child.periodTimes, V.periodTimes));
      // deleting a clone never touches the source
      const victim = await clone(V.id);
      await app.inject({ method: 'DELETE', url: `/api/timetable-versions/${victim.body.data.id}`, headers: { cookie: `session_token=${tokA}` } });
      check('deleting a clone leaves the source untouched', (await fingerprintOf(V.id)) === srcBefore);
      // editing a clone never touches the source
      const editable = await clone(V.id);
      const eList = await entriesOf(editable.body.data.id);
      const lockRes = await app.inject({ method: 'PUT', url: `/api/timetable-versions/${editable.body.data.id}/locks`, headers: { cookie: `session_token=${tokA}`, 'content-type': 'application/json' }, payload: { entryIds: eList.slice(5, 9).map((e) => e.id), locked: true, expectedRevision: 1 } });
      check('a clone is a normal editable draft (locks can be changed, revision grows) and the source is still untouched', lockRes.statusCode === 200 && lockRes.json().data.revision === 2 && (await fingerprintOf(V.id)) === srcBefore);
    }

    // =================================================================================================================
    section('4. Historical period times, staleness, and the 7F-1 view');
    {
      await writer.schedulePeriod.updateMany({ where: { scheduleConfigId: yA.configId }, data: { startMinute: { increment: 30 }, endMinute: { increment: 30 } } });
      const r = await clone(V.id);
      const row = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: r.body.data.id } });
      check('after the school moved every period by 30 minutes, a clone STILL carries the source\'s frozen times (08:00), never the live ones', sameJson(row.periodTimes, expectedTimes(6)) && row.periodTimesCapturedAt!.getTime() === V.periodTimesCapturedAt!.getTime());
      const view = (await getJson(`/api/timetable-versions/${r.body.data.id}/timetable?view=section&id=${yA.sectionIds[0]}`)).data;
      check('the 7F-1 view of the clone: SNAPSHOT times from the source (08:00), the original capture time, changedSinceCapture TRUE', view.periodTimes.source === 'SNAPSHOT' && view.grid.periods[0].startTime === '08:00' && view.periodTimes.capturedAt === V.periodTimesCapturedAt!.toISOString() && view.periodTimes.changedSinceCapture === true);
      await writer.schedulePeriod.updateMany({ where: { scheduleConfigId: yA.configId }, data: { startMinute: { decrement: 30 }, endMinute: { decrement: 30 } } });

      // a legacy source (no stored times)
      const legacy = await prisma.timetableVersion.create({ data: { schoolId: worldA.schoolId, academicYearId: yA.yearId, versionNumber: 200, status: 'DRAFT', solutionSource: 'BASELINE', solverStatus: 'FEASIBLE', weightsVersion: 'V1', inputHash: 'legacy', inputSnapshot: gridSnapshot(6) as never, metrics: {}, baselineMetrics: {} } });
      const rl = await clone(legacy.id);
      const legacyRow = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: rl.body.data.id } });
      check('a LEGACY source (no times): 201, the clone has NO times either (null / null), periodTimesCaptured false; nothing is invented from the live schedule', rl.status === 201 && legacyRow.periodTimes === null && legacyRow.periodTimesCapturedAt === null && rl.body.data.periodTimesCaptured === false && rl.body.data.entryCount === 0);
      const legacyView = (await getJson(`/api/timetable-versions/${rl.body.data.id}/timetable?view=section&id=${yA.sectionIds[0]}`)).data;
      check('...and its view says UNAVAILABLE, exactly like its source\'s', legacyView.periodTimes.source === 'UNAVAILABLE');
      check('an EMPTY source (no lessons) clones into an empty draft', rl.body.data.entryCount === 0 && (await entriesOf(rl.body.data.id)).length === 0);
    }
    {
      // staleness: the clone is exactly as stale as its source, and cloning a stale version works
      const yS = await seedYear(worldA, 'clone-stale', { sections: 3 });
      const S = await generate(yS);
      await prisma.subjectRequirement.update({ where: { id: yS.requirementIds[0]! }, data: { periodsPerWeek: { increment: 1 } } });
      const vSource = (await getJson(`/api/timetable-versions/${S.id}/validation`)).data;
      const rs = await clone(S.id);
      const vClone = (await getJson(`/api/timetable-versions/${rs.body.data.id}/validation`)).data;
      check('a STALE source can be cloned (201); the clone has the SAME input hash and reports the same staleness as its source (both stale)', rs.status === 201 && rs.body.data.inputHash === S.inputHash && vSource.isStale === true && vClone.isStale === true && vClone.configurationHash === vSource.configurationHash, JSON.stringify({ s: vSource.isStale, c: vClone.isStale }));
      const pub = await app.inject({ method: 'POST', url: `/api/timetable-versions/${rs.body.data.id}/publish`, headers: { cookie: `session_token=${tokA}`, 'content-type': 'application/json' }, payload: { expectedRevision: 1, expectedPublishedVersionId: null } });
      check('publishing that stale clone is refused by the EXISTING strict rule (409), exactly as for its source: publishing behaviour is unchanged', pub.statusCode === 409 && ['STALE_CONFIGURATION', 'VALIDATION_FAILED'].includes(pub.json().data?.code), `${pub.statusCode} ${pub.body.slice(0, 150)}`);
    }

    // =================================================================================================================
    section('5. Isolation, validation, provenance and invalid source states');
    {
      const before = await versionsOf(yA.yearId);
      const foreign = await clone(V.id, undefined, tokB);
      check('another school\'s admin cloning this school\'s version: 403, nothing created, nothing leaked', foreign.status === 403 && (await versionsOf(yA.yearId)).length === before.length && !JSON.stringify(foreign.body).includes(yA.yearId));
      const unknown = await clone(UUID0);
      check('unknown version: 404', unknown.status === 404);
      check('malformed version id: 400', (await clone('not-a-uuid')).status === 400);
      check('unauthenticated and garbage-cookie requests: 401', (await clone(V.id, undefined, null)).status === 401 && (await clone(V.id, undefined, 'garbage')).status === 401);
      const accepted: string[] = [];
      for (const key of ['academicYearId', 'schoolId', 'status', 'entries', 'versionNumber', 'clonedFromId', 'createdById']) {
        const r = await clone(V.id, { lockMode: 'KEEP', [key]: key === 'entries' ? [] : 'x' });
        if (r.status !== 400) accepted.push(`${key}:${r.status}`);
      }
      check('the body cannot name a year, school, status, lessons, number, provenance or creator: every such field is a 400', accepted.length === 0, accepted.join(','));
      check('...and none of those requests created a version', (await versionsOf(yA.yearId)).length === before.length);
      const own = await clone((await versionsOf(yB.yearId))[0]?.id ?? UUID0, undefined, tokB);
      check('control: school B has no versions yet, so its admin gets a plain 404 for an unknown id (the 403 above is about ownership)', own.status === 404);

      // provenance: every clone is in the same year and school as its source, by construction and by the database
      const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM "timetable_versions" c JOIN "timetable_versions" s ON s."id" = c."clonedFromId"
        WHERE c."academicYearId" = ${yA.yearId} AND (s."academicYearId" <> c."academicYearId" OR s."schoolId" <> c."schoolId")`;
      const withProv = await prisma.timetableVersion.count({ where: { academicYearId: yA.yearId, clonedFromId: { not: null } } });
      check(`provenance: all ${withProv} clones with a source have the SAME academic year and school as it (0 violations)`, Number(rows[0]!.n) === 0 && withProv > 5);
      const vB = await prisma.timetableVersion.create({ data: { schoolId: worldB.schoolId, academicYearId: yB.yearId, versionNumber: 1, status: 'DRAFT', solutionSource: 'BASELINE', solverStatus: 'FEASIBLE', weightsVersion: 'V1', inputHash: 'x', inputSnapshot: gridSnapshot(6) as never, metrics: {}, baselineMetrics: {} } });
      const trigger = await prisma.$executeRaw`UPDATE "timetable_versions" SET "clonedFromId" = ${V.id} WHERE "id" = ${vB.id}`.then(() => 'allowed', (e) => String(e));
      check('the trigger still refuses a version of another school/year as a clone source, below the API', /cannot be cloned from a version of another academic year or school/.test(trigger), trigger.slice(0, 120));
      const bOwn = await clone(vB.id, { lockMode: 'ALL' }, tokB);
      check('school B can clone its OWN version (control)', bOwn.status === 201 && bOwn.body.data.academicYearId === yB.yearId);
      check('a COMPLETED year refuses: 409 ACADEMIC_YEAR_NOT_EDITABLE with the year status, nothing created', await (async () => {
        const n = (await versionsOf(yB.yearId)).length;
        await prisma.academicYear.update({ where: { id: yB.yearId }, data: { status: 'COMPLETED' } });
        const r = await clone(vB.id, undefined, tokB);
        await prisma.academicYear.update({ where: { id: yB.yearId }, data: { status: 'ACTIVE' } });
        const ok = await clone(vB.id, undefined, tokB);
        return r.status === 409 && r.body.data.code === 'ACADEMIC_YEAR_NOT_EDITABLE' && r.body.data.yearStatus === 'COMPLETED' && (await versionsOf(yB.yearId)).length === n + 1 && ok.status === 201;
      })());
    }

    // =================================================================================================================
    section('6. The draft cap and BUSY');
    {
      const yC = await seedYear(worldA, 'clone-cap', { sections: 1, subjects: [2] });
      const src = await prisma.timetableVersion.create({ data: { schoolId: worldA.schoolId, academicYearId: yC.yearId, versionNumber: 1, status: 'DRAFT', solutionSource: 'BASELINE', solverStatus: 'FEASIBLE', weightsVersion: 'V1', inputHash: 'cap', inputSnapshot: gridSnapshot(6) as never, metrics: {}, baselineMetrics: {} } });
      process.env.MAX_DRAFTS_PER_YEAR = '3';
      const c1 = await clone(src.id);
      const c2 = await clone(src.id);
      check('cap 3: with 1 draft the next two clones are accepted (2, then 3 drafts)', c1.status === 201 && c2.status === 201 && (await drafts(yC.yearId)) === 3);
      const refused = await clone(src.id);
      check('at the cap (equality): 409 DRAFT_LIMIT_REACHED with data.drafts 3, data.maxDraftsPerYear 3, data.pendingRun false; nothing created', refused.status === 409 && refused.body.data.code === 'DRAFT_LIMIT_REACHED' && refused.body.data.drafts === 3 && refused.body.data.maxDraftsPerYear === 3 && refused.body.data.pendingRun === false && (await drafts(yC.yearId)) === 3 && /maximum is 3/.test(refused.body.message), JSON.stringify(refused.body).slice(0, 250));
      const pub = await prisma.timetableVersion.update({ where: { id: c2.body.data.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
      const afterPublish = await clone(src.id);
      check('publishing a draft frees its slot (PUBLISHED does not count): the next clone is accepted again', pub.status === 'PUBLISHED' && afterPublish.status === 201 && (await drafts(yC.yearId)) === 3);
      const cloneOfPublished = await clone(pub.id);
      check('and at the cap even a PUBLISHED source cannot be cloned (the clone would be a 4th draft)', cloneOfPublished.status === 409 && cloneOfPublished.body.data.code === 'DRAFT_LIMIT_REACHED');
      await prisma.timetableVersion.delete({ where: { id: c1.body.data.id } });
      check('deleting a draft frees a slot', (await clone(pub.id)).status === 201);
      // legacy overflow and a lowered cap
      process.env.MAX_DRAFTS_PER_YEAR = '2';
      const over = await clone(src.id);
      check('the cap lowered below the count (3 drafts, cap 2): refused, and NOTHING is deleted', over.status === 409 && over.body.data.drafts === 3 && over.body.data.maxDraftsPerYear === 2 && (await drafts(yC.yearId)) === 3);
      process.env.MAX_DRAFTS_PER_YEAR = '500';
      check('the cap raised: accepted again', (await clone(src.id)).status === 201);

      // an active generation reserves a slot
      process.env.MAX_DRAFTS_PER_YEAR = '5';
      await prisma.timetableVersion.deleteMany({ where: { academicYearId: yC.yearId, id: { not: src.id }, status: 'DRAFT' } });
      await prisma.timetableVersion.deleteMany({ where: { academicYearId: yC.yearId, status: { not: 'DRAFT' } } });
      for (let i = 0; i < 3; i++) await clone(src.id); // src + 3 clones = 4 drafts
      await prisma.timetableGenerationRun.create({ data: { schoolId: worldA.schoolId, academicYearId: yC.yearId, requestedById: worldA.adminId, options: { seed: 1, reproducible: false }, timeLimitSeconds: 10, workers: 2, sectionCount: 1, status: 'QUEUED' } });
      const reserved = await clone(src.id);
      check('4 drafts + a QUEUED generation (a reservation), cap 5: refused 409 DRAFT_LIMIT_REACHED with pendingRun TRUE (4 + 1 = 5)', reserved.status === 409 && reserved.body.data.code === 'DRAFT_LIMIT_REACHED' && reserved.body.data.pendingRun === true && reserved.body.data.drafts === 4 && /generation in progress/.test(reserved.body.message), JSON.stringify(reserved.body).slice(0, 250));
      await drain();
      check('once the generation is over the slot is free again', (await clone(src.id)).status === 201);

      // BUSY: another writer holds the year row
      process.env.MAX_DRAFTS_PER_YEAR = '500';
      const yBusy = await seedYear(worldA, 'clone-busy', { sections: 1, subjects: [2] });
      const srcBusy = await prisma.timetableVersion.create({ data: { schoolId: worldA.schoolId, academicYearId: yBusy.yearId, versionNumber: 1, status: 'DRAFT', solutionSource: 'BASELINE', solverStatus: 'FEASIBLE', weightsVersion: 'V1', inputHash: 'busy', inputSnapshot: gridSnapshot(6) as never, metrics: {}, baselineMetrics: {} } });
      let release: () => void = () => undefined;
      const hold = new Promise<void>((r) => { release = r; });
      let locked: () => void = () => undefined;
      const lockedP = new Promise<void>((r) => { locked = r; });
      const holder = writer.$transaction(async (tx: Prisma.TransactionClient) => { await tx.$queryRaw`SELECT "id" FROM "academic_years" WHERE "id" = ${yBusy.yearId} FOR SHARE`; locked(); await hold; }, { timeout: 60_000, maxWait: 20_000 });
      await lockedP;
      const busy = await clone(srcBusy.id);
      release();
      await holder;
      check('a year held by another writer: after the 5 s lock timeout, 503 BUSY with Retry-After, and nothing created', busy.status === 503 && busy.body.data.code === 'BUSY' && busy.headers['retry-after'] === '2' && busy.ms >= 4_000 && (await versionsOf(yBusy.yearId)).length === 1, `${busy.status} ${busy.ms}ms`);
      check('the same request succeeds once the writer is gone', (await clone(srcBusy.id)).status === 201);
    }
    process.env.MAX_DRAFTS_PER_YEAR = '500';

    // =================================================================================================================
    section('7. A large copy: 100 sections');
    {
      const yP = await prisma.academicYear.create({ data: { schoolId: worldA.schoolId, name: `perf-${randomUUID().slice(0, 6)}`, startDate: new Date('2037-01-01'), endDate: new Date('2037-12-31') } });
      const grade = await prisma.grade.create({ data: { academicYearId: yP.id, name: 'GP', displayOrder: 1 } });
      const sectionIds = Array.from({ length: 100 }, () => randomUUID());
      await prisma.section.createMany({ data: sectionIds.map((id, i) => ({ id, gradeId: grade.id, name: `P${i + 1}`, code: `P${i + 1}` })) });
      const subjectIds = Array.from({ length: 5 }, () => randomUUID());
      await prisma.subject.createMany({ data: subjectIds.map((id, i) => ({ id, schoolId: worldA.schoolId, name: `PS${i}`, code: `PS${i}_${randomUUID().slice(0, 4)}` })) });
      const requirementIds = Array.from({ length: 5 }, () => randomUUID());
      await prisma.subjectRequirement.createMany({ data: requirementIds.map((id, i) => ({ id, gradeId: grade.id, subjectId: subjectIds[i]!, periodsPerWeek: 6 })) });
      const teacherIds = Array.from({ length: 100 }, () => randomUUID());
      await prisma.teacher.createMany({ data: teacherIds.map((id, i) => ({ id, schoolId: worldA.schoolId, name: `PT${i + 1}` })) });
      const big = await prisma.timetableVersion.create({ data: { schoolId: worldA.schoolId, academicYearId: yP.id, versionNumber: 1, status: 'PUBLISHED', publishedAt: new Date(), solutionSource: 'CP_SAT', solverStatus: 'FEASIBLE', weightsVersion: 'V1', inputHash: 'big', inputSnapshot: gridSnapshot(6) as never, metrics: {}, baselineMetrics: {}, periodTimes: expectedTimes(6) as never, periodTimesCapturedAt: new Date() } });
      const rows: Prisma.TimetableEntryCreateManyInput[] = [];
      sectionIds.forEach((sid, i) => { for (let k = 0; k < 29; k++) rows.push({ versionId: big.id, sectionId: sid, subjectId: subjectIds[k % 5]!, teacherId: teacherIds[i]!, subjectRequirementId: requirementIds[k % 5]!, dayOfWeek: WEEK[k % 5] as never, periodNumber: Math.floor(k / 5) + 1, isLocked: k % 7 === 0, source: k % 11 === 0 ? 'MANUAL' : 'GENERATED' }); });
      for (let i = 0; i < rows.length; i += 2_000) await prisma.timetableEntry.createMany({ data: rows.slice(i, i + 2_000) });
      const bigBefore = await fingerprintOf(big.id);
      const srcLocked = rows.filter((r) => r.isLocked).length;
      const r = await clone(big.id, { lockMode: 'KEEP' });
      console.log(`  info: cloning 2,900 lessons took ${r.ms} ms (including auth)`);
      const copied = await entriesOf(r.body.data.id);
      check('2,900 lessons copied in ONE request: 201, all 2,900 present, the lock flags and MANUAL sources of KEEP identical in count', r.status === 201 && copied.length === 2_900 && copied.filter((e) => e.isLocked).length === srcLocked && copied.filter((e) => e.source === 'MANUAL').length === rows.filter((x) => x.source === 'MANUAL').length && r.body.data.entryCount === 2_900);
      check('it finishes well inside the transaction limits (under 20 s on the remote database)', r.ms < 20_000, `${r.ms} ms`);
      const rAll = await clone(big.id, { lockMode: 'ALL' });
      check('ALL on the large source: 2,900 locked', rAll.status === 201 && rAll.body.data.lockedCount === 2_900);
      check('the large PUBLISHED source is byte-identical after both clones', (await fingerprintOf(big.id)) === bigBefore);
    }

    // =================================================================================================================
    section('8. Swagger');
    {
      const spec = app.swagger() as any;
      const op = spec.paths['/api/timetable-versions/{id}/clone']?.post;
      check('POST /api/timetable-versions/{id}/clone is documented: operationId, tag, cookie auth', op?.operationId === 'cloneTimetableVersion' && op.tags.includes('Timetable Version') && JSON.stringify(op.security) === JSON.stringify([{ cookieAuth: [] }]));
      const body = op?.requestBody?.content?.['application/json']?.schema;
      check('the body documents lockMode KEEP|ALL|NONE with default KEEP and forbids other fields', JSON.stringify(body?.properties?.lockMode?.enum) === '["KEEP","ALL","NONE"]' && body?.properties?.lockMode?.default === 'KEEP' && body?.additionalProperties === false);
      check('it documents 201, 400, 401, 403, 404, 409 and 503', ['201', '400', '401', '403', '404', '409', '503'].every((c) => op?.responses?.[c]));
      const data = op.responses['201'].content['application/json'].schema.properties.data.properties;
      check('the 201 body documents the version summary plus clonedFromId, clonedFromVersionNumber, lockMode and periodTimesCaptured', ['id', 'status', 'revision', 'versionNumber', 'entryCount', 'lockedCount', 'clonedFromId', 'clonedFromVersionNumber', 'lockMode', 'periodTimesCaptured'].every((k) => data[k]));
      check('the description explains lock modes, snapshots, staleness, the cap (DRAFT_LIMIT_REACHED, MAX_DRAFTS_PER_YEAR), BUSY and non-idempotence', /KEEP/.test(op.description) && /ALL locks every lesson/.test(op.description) && /DRAFT_LIMIT_REACHED/.test(op.description) && /MAX_DRAFTS_PER_YEAR/.test(op.description) && /BUSY/.test(op.description) && /Not idempotent/.test(op.description) && /period times/.test(op.description));
      check('/docs/json serves it', (await app.inject({ method: 'GET', url: '/docs/json' })).body.includes('cloneTimetableVersion'));
    }
  } finally {
    section('9. Cleanup and proof that nothing existing changed');
    if (savedCap === undefined) delete process.env.MAX_DRAFTS_PER_YEAR; else process.env.MAX_DRAFTS_PER_YEAR = savedCap;
    await drain();
    await app.close();
    await sleep(200);
    check('exactly the two test schools were deleted (cascade)', (await destroyWorld(worldA)) === 1 && (await destroyWorld(worldB)) === 1);
    check('the new tables are back to their starting counts', JSON.stringify(await newTableCounts()) === JSON.stringify(newBefore));
    const after = await fingerprint();
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, EXISTING_TABLES.every((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h));
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11KA_' } } })) === 0 && (await prisma.school.count({ where: { code: { startsWith: 'M11KB_' } } })) === 0);
    await writer.$disconnect();
    await writerPool.end().catch(() => undefined);
  }
}

let finished = false;
process.on('exit', (code) => {
  if (!finished) { console.log(`\nRESULT: pass=${pass} fail=${fail + 1} (the process ended before the suite completed, exit ${code})`); process.exitCode = 1; }
});
main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(async () => {
    await prisma.$disconnect();
    finished = true;
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
