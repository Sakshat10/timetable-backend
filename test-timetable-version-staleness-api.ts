// Module 11 - Phase 7F-3: version-list filtering and opt-in staleness, against the real database and the real Fastify app (inject).
//
//   1  the list without the new parameters is exactly what it always was
//   2  the status filter (single, several, repeated, duplicates, empty results) and invalid values
//   3  includeStaleness: fresh, changed, not normalizable, unusable snapshot, mixed hashes; agreement with GET .../validation for EVERY version
//   4  efficiency: one live read and one stored snapshot per distinct hash
//   5  clone with and without includeStaleness (and a failing assessment never fails the clone)
//   6  isolation and authorization; read-only; existing endpoints unchanged
//   7  Swagger
//   8  cleanup and proof that nothing existing changed
//
// Run with   NODE_ENV=production npx tsx test-timetable-version-staleness-api.ts
import 'dotenv/config'; // first: the database pool is created when a module imports src/config/database.ts
import './test-fixtures/test-security-env.js'; // a test-only COOKIE_SECRET (production mode refuses the placeholder in .env)
import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { TimetableVersionCloneService } from './src/modules/timetable-version/timetable-version.clone-service.js';
import { TimetableVersionStalenessService } from './src/modules/timetable-version/timetable-version.staleness-service.js';
import {
  assertQueueIsEmpty, captureLogger, createWorld, destroyWorld, EXISTING_TABLES, fastConfig, fingerprint, mustEnqueue, newTableCounts, prisma, rawPrisma, ScriptedSolver, seedYear, sleep,
  solution, waitTerminal, type SeededYear, type SolveCtx, type World,
} from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const md5 = (v: unknown): string => createHash('md5').update(JSON.stringify(v)).digest('hex');

const writerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 10, connectionTimeoutMillis: 30_000 });
const writer = new PrismaClient({ adapter: new PrismaPg(writerPool) });
const PASSWORD = 'Stale#Test-Pass-2030';
const UUID0 = '00000000-0000-4000-8000-000000000000';
const WEEK = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];

interface Reply { status: number; body: any; ms: number }
const OLD_KEYS = ['academicYearId', 'archivedAt', 'baselineMetrics', 'createdAt', 'entryCount', 'id', 'inputHash', 'lockedCount', 'manualEditCount', 'metrics', 'optimal', 'publishedAt', 'revision', 'solutionSource', 'solverStatus', 'status', 'updatedAt', 'versionNumber', 'weightsVersion'];

async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();
  const worldA: World = await createWorld('M11SA');
  const worldB: World = await createWorld('M11SB');
  const app = await buildApp();
  const savedCap = process.env.MAX_DRAFTS_PER_YEAR;

  const login = async (world: World): Promise<string> => {
    const email = `stale-${world.code}@test.local`;
    await prisma.admin.update({ where: { id: world.adminId }, data: { email, passwordHash: await hashPassword(PASSWORD) } });
    return (await adminService.loginAdmin({ schoolId: world.schoolId, email, password: PASSWORD })).sessionToken;
  };
  const tokA = await login(worldA);
  const tokB = await login(worldB);
  const call = async (method: 'GET' | 'POST', url: string, token: string | null = tokA, payload?: unknown): Promise<Reply> => {
    const t0 = Date.now();
    const res = await app.inject({ method, url, ...(token ? { headers: { cookie: `session_token=${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) } } : {}), ...(payload !== undefined ? { payload: payload as never } : {}) });
    return { status: res.statusCode, body: res.json(), ms: Date.now() - t0 };
  };
  const list = (yearId: string, qs = '', token: string | null = tokA) => call('GET', `/api/timetable-versions?academicYearId=${yearId}${qs}`, token);
  const clone = (id: string, body?: unknown, token: string | null = tokA) => call('POST', `/api/timetable-versions/${id}/clone`, token, body);
  const validation = async (id: string) => (await call('GET', `/api/timetable-versions/${id}/validation`)).body;
  const generate = async (year: SeededYear) => {
    const solver = new ScriptedSolver((ctx: SolveCtx) => solution(ctx.problem));
    const runner = new GenerationRunner({ prisma: rawPrisma, solverClient: solver, config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: 10 }, logger: captureLogger().logger });
    const queued = await mustEnqueue(worldA, year);
    await runner.dispatch();
    const run = await waitTerminal(queued.id, 90_000);
    await runner.stop(5);
    if (run.status !== 'SUCCEEDED') throw new Error(`setup: generation ${run.status} ${run.failureCode}`);
    return prisma.timetableVersion.findUniqueOrThrow({ where: { id: run.versionId! } });
  };
  const ids = (r: Reply): string[] => r.body.data.map((v: any) => v.id);
  const gridSnapshot = { grid: { days: WEEK.map((dayOfWeek, index) => ({ index, dayOfWeek })), periods: [{ periodNumber: 1, continuesIntoNext: false }], maxTeacherPeriodsPerWeek: 30 } };

  try {
    const yA = await seedYear(worldA, 'stale-a', { sections: 3 });
    const yE = await seedYear(worldA, 'stale-e', { sections: 1, subjects: [2] }); // only drafts
    const yB = await seedYear(worldB, 'stale-b', { sections: 1, subjects: [2] });
    const V = await generate(yA);
    // a family of versions with the SAME configuration: V (DRAFT), two clones (DRAFT), one PUBLISHED, one ARCHIVED
    const c1 = (await clone(V.id)).body.data;
    const c2 = (await clone(V.id)).body.data;
    const toPub = (await clone(V.id)).body.data;
    const toArc = (await clone(V.id)).body.data;
    const P = await prisma.timetableVersion.update({ where: { id: toPub.id }, data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: worldA.adminId } });
    const A = await prisma.timetableVersion.update({ where: { id: toArc.id }, data: { status: 'ARCHIVED', publishedAt: new Date(), archivedAt: new Date() } });
    const draftIds = [V.id, c1.id, c2.id];
    check('setup: V, two clones, a PUBLISHED and an ARCHIVED version, all with one configuration (one input hash)', (await prisma.timetableVersion.count({ where: { academicYearId: yA.yearId } })) === 5 && new Set((await prisma.timetableVersion.findMany({ where: { academicYearId: yA.yearId } })).map((v) => v.inputHash)).size === 1);
    // another year of the same school, with drafts and a legacy-style unusable one for later
    const E1 = await generate(yE);
    const eOther = (await clone(E1.id)).body.data;
    // a foreign school's version
    const vB = await prisma.timetableVersion.create({ data: { schoolId: worldB.schoolId, academicYearId: yB.yearId, versionNumber: 1, status: 'DRAFT', solutionSource: 'BASELINE', solverStatus: 'FEASIBLE', weightsVersion: 'V1', inputHash: 'b', inputSnapshot: gridSnapshot as never, metrics: {}, baselineMetrics: {} } });

    // =================================================================================================================
    section('1. Without the new parameters the list is exactly what it always was');
    {
      const r = await list(yA.yearId);
      check('200, five versions, newest first (version numbers 5,4,3,2,1)', r.status === 200 && r.body.data.length === 5 && r.body.data.map((v: any) => v.versionNumber).join() === '5,4,3,2,1');
      check('every item has EXACTLY the pre-7F-3 keys (no isStale, no staleReason)', r.body.data.every((v: any) => JSON.stringify(Object.keys(v).sort()) === JSON.stringify(OLD_KEYS)), Object.keys(r.body.data[0]).join());
      const explicit = await list(yA.yearId, '&includeStaleness=false');
      check('includeStaleness=false is byte-identical to omitting it', JSON.stringify(explicit.body.data) === JSON.stringify(r.body.data));
      check('counts are right: 36 lessons each, V has none locked', r.body.data.every((v: any) => v.entryCount === 36));
      check('another academic year\'s versions never appear', !ids(r).includes(E1.id) && !ids(r).includes(eOther.id) && ids(r).length === 5);
    }

    // =================================================================================================================
    section('2. The status filter');
    {
      const all = (await list(yA.yearId)).body.data as any[];
      const byStatus = (...ss: string[]) => all.filter((v) => ss.includes(v.status));
      const same = (r: Reply, expected: any[]) => r.status === 200 && JSON.stringify(r.body.data) === JSON.stringify(expected);
      check('status=DRAFT: exactly the three drafts, items identical to the unfiltered list, newest first', same(await list(yA.yearId, '&status=DRAFT'), byStatus('DRAFT')) && byStatus('DRAFT').length === 3);
      check('status=PUBLISHED: exactly the published version', same(await list(yA.yearId, '&status=PUBLISHED'), byStatus('PUBLISHED')) && byStatus('PUBLISHED')[0].id === P.id);
      check('status=ARCHIVED: exactly the archived version', same(await list(yA.yearId, '&status=ARCHIVED'), byStatus('ARCHIVED')) && byStatus('ARCHIVED')[0].id === A.id);
      check('status=DRAFT,PUBLISHED (comma-separated): drafts and the published one, in one version-number order', same(await list(yA.yearId, '&status=DRAFT,PUBLISHED'), byStatus('DRAFT', 'PUBLISHED')) && byStatus('DRAFT', 'PUBLISHED').length === 4);
      check('status=PUBLISHED&status=ARCHIVED (repeated): published and archived', same(await list(yA.yearId, '&status=PUBLISHED&status=ARCHIVED'), byStatus('PUBLISHED', 'ARCHIVED')));
      check('all three statuses = the unfiltered list; duplicates collapse (DRAFT,DRAFT = DRAFT)', same(await list(yA.yearId, '&status=ARCHIVED,DRAFT,PUBLISHED'), all) && same(await list(yA.yearId, '&status=DRAFT,DRAFT&status=DRAFT'), byStatus('DRAFT')));
      const noPublished = await list(yE.yearId, '&status=PUBLISHED');
      check('a status with no versions: 200 with an empty list (not a 404)', noPublished.status === 200 && noPublished.body.data.length === 0 && noPublished.body.success === true);
      check('the other year: its drafts only, and nothing of this year', JSON.stringify(ids(await list(yE.yearId, '&status=DRAFT'))) === JSON.stringify([eOther.id, E1.id]));
      check('filtered items keep correct counts and are ordered by versionNumber descending', (await list(yA.yearId, '&status=DRAFT')).body.data.every((v: any, i: number, a: any[]) => v.entryCount === 36 && (i === 0 || a[i - 1].versionNumber > v.versionNumber)));
      const notRejected: string[] = [];
      for (const bad of ['draft', 'BOGUS', 'ACTIVE', '', 'DRAFT,', 'DRAFT,,PUBLISHED', 'ALL']) {
        const r = await list(yA.yearId, `&status=${bad}`);
        if (r.status !== 400 || !JSON.stringify(r.body.errors ?? {}).includes('status')) notRejected.push(`${bad}:${r.status}`);
      }
      const repeatedBad = await list(yA.yearId, '&status=DRAFT&status=BOGUS');
      if (repeatedBad.status !== 400) notRejected.push(`repeated:${repeatedBad.status}`);
      check('invalid status values (draft, BOGUS, ACTIVE, empty, trailing comma, double comma, ALL, a bad value among repeated ones) are all 400 with the field named; none is silently "all"', notRejected.length === 0, notRejected.join(','));
      check('invalid includeStaleness (yes, 1, TRUE, empty) is 400 naming the field', await (async () => { for (const bad of ['yes', '1', 'TRUE', '']) { const r = await list(yA.yearId, `&includeStaleness=${bad}`); if (r.status !== 400 || !JSON.stringify(r.body.errors ?? {}).includes('includeStaleness')) return false; } return true; })());
      check('missing and malformed academicYearId are still 400', (await call('GET', '/api/timetable-versions')).status === 400 && (await call('GET', '/api/timetable-versions?academicYearId=nope')).status === 400);
    }

    // =================================================================================================================
    section('3. includeStaleness');
    {
      const agree = async (items: any[]): Promise<string> => {
        for (const item of items) {
          if (item.staleReason === 'SNAPSHOT_UNUSABLE') continue;
          const v = await validation(item.id);
          if (v.data.isStale !== item.isStale || v.data.informational.staleReason !== item.staleReason) return `${item.id}: list ${item.isStale}/${item.staleReason} vs validation ${v.data.isStale}/${v.data.informational.staleReason}`;
        }
        return '';
      };
      // 3a fresh
      const fresh = await list(yA.yearId, '&includeStaleness=true');
      check('a current configuration: all five versions (drafts, PUBLISHED, ARCHIVED) report isStale false / NONE', fresh.status === 200 && fresh.body.data.length === 5 && fresh.body.data.every((v: any) => v.isStale === false && v.staleReason === 'NONE'));
      check('...and each item is the old summary PLUS exactly isStale and staleReason', fresh.body.data.every((v: any) => JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...OLD_KEYS, 'isStale', 'staleReason'].sort())));
      check('THE LIST AGREES WITH GET .../validation for every version (isStale and staleReason)', (await agree(fresh.body.data)) === '', await agree(fresh.body.data));

      // 3b the configuration changes
      await prisma.subjectRequirement.update({ where: { id: yA.requirementIds[0]! }, data: { periodsPerWeek: { increment: 1 } } });
      const changed = await list(yA.yearId, '&includeStaleness=true');
      check('after a configuration change: all five report isStale TRUE / CONFIGURATION_CHANGED', changed.body.data.every((v: any) => v.isStale === true && v.staleReason === 'CONFIGURATION_CHANGED'));
      check('...and again every one agrees with GET .../validation', (await agree(changed.body.data)) === '', await agree(changed.body.data));
      const onlyPub = await list(yA.yearId, '&status=PUBLISHED&includeStaleness=true');
      check('filter and staleness together: only the PUBLISHED version, reported stale', onlyPub.body.data.length === 1 && onlyPub.body.data[0].id === P.id && onlyPub.body.data[0].isStale === true);
      check('without includeStaleness the same list still carries no staleness (it is opt-in)', (await list(yA.yearId, '&status=PUBLISHED')).body.data.every((v: any) => !('isStale' in v) && !('staleReason' in v)));

      // 3c a new generation has a new configuration hash: the list mixes stale and current versions
      const V2 = await generate(yA);
      const mixed = await list(yA.yearId, '&includeStaleness=true');
      const byId = new Map<string, any>(mixed.body.data.map((v: any) => [v.id, v]));
      check('a version generated from the NEW configuration is current (false / NONE) while the five from the old one are stale, in ONE response', mixed.body.data.length === 6 && byId.get(V2.id).isStale === false && byId.get(V2.id).staleReason === 'NONE' && [V.id, c1.id, c2.id, P.id, A.id].every((id) => byId.get(id).isStale === true));
      check('mixed list agrees with GET .../validation for all six', (await agree(mixed.body.data)) === '', await agree(mixed.body.data));
      check('a clone of the NEW version is current too, and its stale source still stale (clones follow their source)', await (async () => { const cc = (await clone(V2.id)).body.data; const r = await list(yA.yearId, '&includeStaleness=true'); const m = new Map<string, any>(r.body.data.map((v: any) => [v.id, v])); return m.get(cc.id).isStale === false && m.get(V2.id).isStale === false && m.get(V.id).isStale === true; })());

      // 3d the configuration is reverted: current again
      await prisma.subjectRequirement.update({ where: { id: yA.requirementIds[0]! }, data: { periodsPerWeek: { decrement: 1 } } });
      const reverted = await list(yA.yearId, '&includeStaleness=true');
      const m2 = new Map<string, any>(reverted.body.data.map((v: any) => [v.id, v]));
      check('the change reverted: the five original versions are current again, and the one from the changed configuration is now stale', [V.id, c1.id, c2.id, P.id, A.id].every((id) => m2.get(id).isStale === false) && m2.get(V2.id).isStale === true);

      // 3e the live configuration no longer forms a valid problem
      const days = await prisma.scheduleDay.findMany({ where: { scheduleConfigId: yA.configId } });
      await prisma.scheduleDay.deleteMany({ where: { scheduleConfigId: yA.configId } });
      const broken = await list(yA.yearId, '&includeStaleness=true');
      check('a live configuration that cannot be normalized (no working days): every version isStale TRUE / CONFIGURATION_NOT_NORMALIZABLE', broken.status === 200 && broken.body.data.every((v: any) => v.isStale === true && v.staleReason === 'CONFIGURATION_NOT_NORMALIZABLE'));
      check('...and every one agrees with GET .../validation', (await agree(broken.body.data)) === '', await agree(broken.body.data));
      await prisma.scheduleDay.createMany({ data: days.map((d) => ({ scheduleConfigId: d.scheduleConfigId, dayOfWeek: d.dayOfWeek })) });
      check('the working days restored: the original versions are current again', (await list(yA.yearId, '&includeStaleness=true')).body.data.filter((v: any) => [V.id, P.id].includes(v.id)).every((v: any) => v.isStale === false));

      // 3f an unusable stored snapshot is reported as not established, and does not disturb the others
      const bad = await prisma.timetableVersion.create({ data: { schoolId: worldA.schoolId, academicYearId: yA.yearId, versionNumber: 100, status: 'DRAFT', solutionSource: 'BASELINE', solverStatus: 'FEASIBLE', weightsVersion: 'V1', inputHash: 'unusable-snapshot', inputSnapshot: { nonsense: true } as never, metrics: {}, baselineMetrics: {} } });
      const withBad = await list(yA.yearId, '&includeStaleness=true');
      const badItem = withBad.body.data.find((v: any) => v.id === bad.id);
      check('a version whose stored snapshot cannot be read: isStale NULL / SNAPSHOT_UNUSABLE (never a guessed false)', badItem.isStale === null && badItem.staleReason === 'SNAPSHOT_UNUSABLE');
      check('...GET .../validation refuses the same version with 409 SNAPSHOT_UNUSABLE (the two stay consistent: it cannot be assessed)', (await call('GET', `/api/timetable-versions/${bad.id}/validation`)).body.data?.code === 'SNAPSHOT_UNUSABLE');
      const hashOf = new Map((await prisma.timetableVersion.findMany({ where: { academicYearId: yA.yearId }, select: { id: true, inputHash: true } })).map((v) => [v.id, v.inputHash]));
      check('...and every other version in the same list is still assessed correctly: current exactly when generated from the original configuration, stale for V2 and its clone (a different hash)', withBad.body.data.filter((v: any) => v.id !== bad.id).every((v: any) => v.isStale === (hashOf.get(v.id) !== V.inputHash) && v.staleReason !== 'SNAPSHOT_UNUSABLE') && withBad.body.data.filter((v: any) => v.id !== bad.id && hashOf.get(v.id) !== V.inputHash).length === 2, JSON.stringify(withBad.body.data.map((v: any) => `${v.versionNumber}:${v.isStale}`)));
      await prisma.timetableVersion.delete({ where: { id: bad.id } });
    }

    // =================================================================================================================
    section('4. Efficiency: one live read, one stored snapshot per distinct hash');
    {
      const familyHashes = new Set((await prisma.timetableVersion.findMany({ where: { academicYearId: yA.yearId } })).map((v) => v.inputHash)).size;
      const probe = { yearReads: 0, snapshotRows: 0, snapshotQueries: 0 };
      const spy = rawPrisma.$extends({
        query: {
          academicYear: { async findUnique({ args, query }) { probe.yearReads++; return query(args); } },
          async $queryRaw({ args, query }) {
            const out = (await query(args)) as unknown[];
            if (JSON.stringify(args).includes('DISTINCT ON')) { probe.snapshotQueries++; probe.snapshotRows += out.length; }
            return out;
          },
        },
      });
      const svc = new TimetableVersionStalenessService(spy as unknown as PrismaClient);
      const all = (await prisma.timetableVersion.findMany({ where: { academicYearId: yA.yearId } })).map((v) => v.id);
      const answers = await svc.assess(worldA.schoolId, yA.yearId, all);
      check(`${all.length} versions with ${familyHashes} distinct input hashes: exactly ONE live configuration read and ${familyHashes} stored snapshots (one per hash, not one per version)`, answers.size === all.length && probe.yearReads === 1 && probe.snapshotQueries === 1 && probe.snapshotRows === familyHashes, JSON.stringify(probe));
      const sameHash = (await prisma.timetableVersion.findMany({ where: { academicYearId: yA.yearId, inputHash: V.inputHash }, select: { id: true } })).map((v) => v.id);
      probe.yearReads = 0; probe.snapshotRows = 0; probe.snapshotQueries = 0;
      await svc.assess(worldA.schoolId, yA.yearId, sameHash);
      check(`${sameHash.length} versions sharing one configuration: ONE stored snapshot is read for all of them`, sameHash.length >= 5 && probe.snapshotRows === 1 && probe.yearReads === 1, JSON.stringify(probe));
      probe.yearReads = 0; probe.snapshotQueries = 0;
      check('no versions: nothing is read at all', (await svc.assess(worldA.schoolId, yA.yearId, [])).size === 0 && probe.yearReads === 0 && probe.snapshotQueries === 0);
      check('versions of ANOTHER school or year given by id are ignored (scoped queries), not assessed', (await svc.assess(worldA.schoolId, yA.yearId, [vB.id, E1.id])).size === 0);
      const one = await call('GET', `/api/timetable-versions/${V.id}/validation`);
      const manyReply = await list(yA.yearId, '&includeStaleness=true');
      console.log(`  info: validation of ONE version ${one.ms} ms; list of ${manyReply.body.data.length} versions with staleness ${manyReply.ms} ms; plain list ${(await list(yA.yearId)).ms} ms`);
      check('the list with staleness for six versions costs about what ONE validation costs (not six times)', manyReply.status === 200 && manyReply.ms <= one.ms * 2.5 + 2_000, `${manyReply.ms} vs ${one.ms}`);
    }

    // =================================================================================================================
    section('5. Clone with and without includeStaleness');
    {
      // the configuration is current for V (reverted above), so a clone of V is current
      const plain = await clone(V.id);
      check('without includeStaleness: 201 and NO staleness field at all (the response is exactly the 7F-2 contract)', plain.status === 201 && !('staleness' in plain.body.data) && plain.body.data.clonedFromId === V.id);
      const keysPlain = Object.keys(plain.body.data).sort();
      const explicitFalse = await clone(V.id, { includeStaleness: false });
      check('includeStaleness: false is the same as omitting it (identical key set)', explicitFalse.status === 201 && JSON.stringify(Object.keys(explicitFalse.body.data).sort()) === JSON.stringify(keysPlain));
      const current = await clone(V.id, { includeStaleness: true, lockMode: 'ALL' });
      check('includeStaleness: true on a current source: 201, staleness {isStale false, reason NONE}, the rest of the response unchanged (lockMode ALL still applied)', current.status === 201 && JSON.stringify(current.body.data.staleness) === '{"isStale":false,"reason":"NONE"}' && current.body.data.lockMode === 'ALL' && current.body.data.lockedCount === 36 && JSON.stringify(Object.keys(current.body.data).filter((k) => k !== 'staleness').sort()) === JSON.stringify(keysPlain));
      const v1 = await validation(current.body.data.id);
      check('...and it agrees with GET .../validation of the new clone', v1.data.isStale === false && v1.data.informational.staleReason === 'NONE');
      // stale: V2 was generated from the changed configuration (now stale) -> its clone is stale
      const V2id = (await prisma.timetableVersion.findFirst({ where: { academicYearId: yA.yearId, inputHash: { not: V.inputHash }, status: 'DRAFT' }, orderBy: { versionNumber: 'asc' } }))!.id;
      const stale = await clone(V2id, { includeStaleness: true });
      const v2 = await validation(stale.body.data.id);
      check('cloning a STALE source with includeStaleness: 201 (a stale version can be cloned), staleness {true, CONFIGURATION_CHANGED}, agreeing with GET .../validation of the clone', stale.status === 201 && JSON.stringify(stale.body.data.staleness) === '{"isStale":true,"reason":"CONFIGURATION_CHANGED"}' && v2.data.isStale === true && v2.data.informational.staleReason === 'CONFIGURATION_CHANGED', JSON.stringify(stale.body.data.staleness));
      const notNorm = await (async () => {
        const days = await prisma.scheduleDay.findMany({ where: { scheduleConfigId: yA.configId } });
        await prisma.scheduleDay.deleteMany({ where: { scheduleConfigId: yA.configId } });
        const r = await clone(V.id, { includeStaleness: true });
        await prisma.scheduleDay.createMany({ data: days.map((d) => ({ scheduleConfigId: d.scheduleConfigId, dayOfWeek: d.dayOfWeek })) });
        return r;
      })();
      check('a live configuration that cannot be normalized: the clone is still created (201) and reports {true, CONFIGURATION_NOT_NORMALIZABLE}', notNorm.status === 201 && notNorm.body.data.staleness.isStale === true && notNorm.body.data.staleness.reason === 'CONFIGURATION_NOT_NORMALIZABLE');
      const unusable = await prisma.timetableVersion.create({ data: { schoolId: worldA.schoolId, academicYearId: yA.yearId, versionNumber: 200, status: 'DRAFT', solutionSource: 'BASELINE', solverStatus: 'FEASIBLE', weightsVersion: 'V1', inputHash: 'unusable-2', inputSnapshot: { nonsense: true } as never, metrics: {}, baselineMetrics: {} } });
      const cu = await clone(unusable.id, { includeStaleness: true });
      check('a source with an unusable snapshot: 201, staleness {null, SNAPSHOT_UNUSABLE}', cu.status === 201 && cu.body.data.staleness.isStale === null && cu.body.data.staleness.reason === 'SNAPSHOT_UNUSABLE');
      check('includeStaleness must be a real boolean: "true", 1 and null are 400 and create nothing', await (async () => { const n = await prisma.timetableVersion.count({ where: { academicYearId: yA.yearId } }); const rs = [await clone(V.id, { includeStaleness: 'true' }), await clone(V.id, { includeStaleness: 1 }), await clone(V.id, { includeStaleness: null })]; return rs.every((r) => r.status === 400 && JSON.stringify(r.body.errors ?? {}).includes('includeStaleness')) && (await prisma.timetableVersion.count({ where: { academicYearId: yA.yearId } })) === n; })());
      check('unknown body fields are still rejected (the strict body is unchanged)', (await clone(V.id, { includeStaleness: true, academicYearId: yA.yearId })).status === 400 && (await clone(V.id, { staleness: true })).status === 400);

      // a failing assessment never fails the clone (service level: the live-configuration read is made to fail AFTER the commit)
      const failing = rawPrisma.$extends({ query: { academicYear: { async findUnique() { throw new Error('simulated failure of the live configuration read'); } } } });
      const svc = new TimetableVersionCloneService({ prisma: failing as unknown as PrismaClient });
      const resilient = await svc.clone({ id: worldA.adminId, schoolId: worldA.schoolId }, V.id, 'KEEP', { includeStaleness: true });
      const stored = await prisma.timetableVersion.findUnique({ where: { id: resilient.id } });
      check('when the assessment itself fails the clone still SUCCEEDS: it exists, with all its lessons, and staleness is {null, ASSESSMENT_FAILED}', !!stored && (await prisma.timetableEntry.count({ where: { versionId: resilient.id } })) === 36 && resilient.staleness?.isStale === null && resilient.staleness?.reason === 'ASSESSMENT_FAILED');
      // the cap is still enforced first
      process.env.MAX_DRAFTS_PER_YEAR = '2';
      const capped = await clone(V.id, { includeStaleness: true });
      process.env.MAX_DRAFTS_PER_YEAR = '500';
      check('the draft cap still refuses (409 DRAFT_LIMIT_REACHED) with includeStaleness: no clone, no staleness field', capped.status === 409 && capped.body.data.code === 'DRAFT_LIMIT_REACHED' && !('staleness' in capped.body.data));
      const prov = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: current.body.data.id } });
      check('a clone made with the flag is the same clone: status DRAFT, revision 1, provenance, frozen period times', prov.status === 'DRAFT' && prov.revision === 1 && prov.clonedFromId === V.id && prov.periodTimes !== null);
    }

    // =================================================================================================================
    section('6. Isolation, authorization, read-only, existing endpoints');
    {
      const foreign = await list(yA.yearId, '&includeStaleness=true&status=DRAFT', tokB);
      check('another school\'s admin: 403 (also with the new parameters), no version and no staleness in the body', foreign.status === 403 && foreign.body.data === undefined && !JSON.stringify(foreign.body).includes('isStale'));
      check('an unknown year: 404; unauthenticated and garbage cookie: 401', (await list(UUID0, '&includeStaleness=true')).status === 404 && (await list(yA.yearId, '&includeStaleness=true', null)).status === 401 && (await list(yA.yearId, '', 'garbage')).status === 401);
      const ownB = await list(yB.yearId, '&includeStaleness=true', tokB);
      check('the other school sees only ITS year: one version, assessed against its own configuration (the synthetic grid-only snapshot is unusable there)', ownB.status === 200 && ownB.body.data.length === 1 && ownB.body.data[0].id === vB.id && ownB.body.data[0].isStale === null && ownB.body.data[0].staleReason === 'SNAPSHOT_UNUSABLE');
      const foreignClone = await clone(V.id, { includeStaleness: true }, tokB);
      check('cloning another school\'s version with includeStaleness: 403, nothing created, nothing leaked', foreignClone.status === 403 && !JSON.stringify(foreignClone.body).includes('isStale') && (await prisma.timetableVersion.count({ where: { academicYearId: yB.yearId } })) === 1);
      check('an unknown version with includeStaleness: 404', (await clone(UUID0, { includeStaleness: true })).status === 404);

      // read-only: listing with staleness writes nothing
      const rowsBefore = md5(await prisma.$queryRaw`SELECT "id","status"::text,"revision","updatedAt","inputHash","periodTimes" FROM "timetable_versions" WHERE "academicYearId" = ${yA.yearId} ORDER BY "id"`);
      const entriesBefore = md5(await prisma.$queryRaw`SELECT e.* FROM "timetable_entries" e JOIN "timetable_versions" v ON v."id" = e."versionId" WHERE v."academicYearId" = ${yA.yearId} ORDER BY e."id"`);
      for (let i = 0; i < 3; i++) await list(yA.yearId, '&includeStaleness=true');
      await list(yA.yearId, '&status=DRAFT,ARCHIVED&includeStaleness=true');
      check('listing with staleness (4 times) changes nothing: version rows (revision, updatedAt, hash) and every lesson are byte-identical', rowsBefore === md5(await prisma.$queryRaw`SELECT "id","status"::text,"revision","updatedAt","inputHash","periodTimes" FROM "timetable_versions" WHERE "academicYearId" = ${yA.yearId} ORDER BY "id"`) && entriesBefore === md5(await prisma.$queryRaw`SELECT e.* FROM "timetable_entries" e JOIN "timetable_versions" v ON v."id" = e."versionId" WHERE v."academicYearId" = ${yA.yearId} ORDER BY e."id"`));

      // existing endpoints keep their contract
      const detail = await call('GET', `/api/timetable-versions/${V.id}`);
      check('GET /timetable-versions/:id still has no staleness fields (it is not part of this phase)', detail.status === 200 && !('isStale' in detail.body.data) && !('staleReason' in detail.body.data) && detail.body.data.entries.length === 36);
      const val = await validation(V.id);
      check('GET .../validation keeps its contract (valid, isStale, informational.staleReason, publishable)', typeof val.data.valid === 'boolean' && typeof val.data.isStale === 'boolean' && typeof val.data.informational.staleReason === 'string' && 'publishable' in val.data.informational);
      const view = await call('GET', `/api/timetable-versions/${V.id}/timetable?view=section&id=${yA.sectionIds[0]}`);
      check('the 7F-1 timetable view is untouched (200, 30 cells)', view.status === 200 && view.body.data.cells.length === 30);
      check('the publish rule is unchanged: a STALE draft is still refused by publish (409), a current one is not refused for staleness', await (async () => {
        const staleDraft = await prisma.timetableVersion.findFirst({ where: { academicYearId: yA.yearId, status: 'DRAFT', inputHash: { not: V.inputHash } }, orderBy: { versionNumber: 'asc' } });
        if (!staleDraft) return false;
        const r = await call('POST', `/api/timetable-versions/${staleDraft.id}/publish`, tokA, { expectedRevision: staleDraft.revision, expectedPublishedVersionId: P.id });
        return r.status === 409 && ['STALE_CONFIGURATION', 'VALIDATION_FAILED'].includes(r.body.data?.code);
      })());
    }

    // =================================================================================================================
    section('7. Swagger');
    {
      const spec = app.swagger() as any;
      const get = spec.paths['/api/timetable-versions'].get;
      const params = (get.parameters ?? []) as Array<{ name: string; in: string; required?: boolean; schema?: any }>;
      check('the list documents the status and includeStaleness query parameters (optional) next to the required academicYearId', params.some((p) => p.name === 'status' && p.in === 'query' && !p.required) && JSON.stringify(params.find((p) => p.name === 'includeStaleness')?.schema?.enum) === '["true","false"]' && params.find((p) => p.name === 'academicYearId')?.required === true);
      const props = get.responses['200'].content['application/json'].schema.properties.data.items.properties;
      check('the list item documents isStale (nullable boolean) and staleReason (with the five reasons) next to the summary fields', props.isStale?.nullable === true && props.isStale?.type === 'boolean' && ['NONE', 'CONFIGURATION_CHANGED', 'CONFIGURATION_NOT_NORMALIZABLE', 'SNAPSHOT_UNUSABLE', 'ASSESSMENT_FAILED'].every((r) => props.staleReason?.enum?.includes(r)) && !!props.entryCount && !!props.revision);
      check('the list description explains the filter forms, the opt-in default, agreement with validation, and the null case', /comma-separated/.test(get.description) && /repeated/.test(get.description) && /includeStaleness=true/.test(get.description) && /validation/.test(get.description) && /SNAPSHOT_UNUSABLE/.test(get.description) && /exactly what it always was/.test(get.description));
      check('the list documents the 400 for an invalid status or includeStaleness', /invalid status/i.test(get.responses['400'].description) && /includeStaleness/.test(get.responses['400'].description));
      const post = spec.paths['/api/timetable-versions/{id}/clone'].post;
      const body = post.requestBody.content['application/json'].schema;
      const staleness = post.responses['201'].content['application/json'].schema.properties.data.properties.staleness;
      check('the clone documents includeStaleness (boolean, default false) and forbids other fields', body.properties.includeStaleness?.type === 'boolean' && body.properties.includeStaleness?.default === false && body.additionalProperties === false && JSON.stringify(body.properties.lockMode.enum) === '["KEEP","ALL","NONE"]');
      check('the clone 201 documents the optional staleness object (isStale nullable, reason enum) and the description says it is opt-in and never fails the clone', staleness?.properties?.isStale?.nullable === true && staleness?.properties?.reason?.enum?.includes('ASSESSMENT_FAILED') && /includeStaleness: true/.test(post.description) && /never fails the clone/.test(post.description));
      check('no Swagger `example` keyword was added (project convention)', !JSON.stringify(get).includes('"example"') && !JSON.stringify(post).includes('"example"'));
      check('/docs/json serves it', (await app.inject({ method: 'GET', url: '/docs/json' })).body.includes('includeStaleness'));
    }
  } finally {
    section('8. Cleanup and proof that nothing existing changed');
    if (savedCap === undefined) delete process.env.MAX_DRAFTS_PER_YEAR; else process.env.MAX_DRAFTS_PER_YEAR = savedCap;
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    await app.close();
    await sleep(200);
    check('exactly the two test schools were deleted (cascade)', (await destroyWorld(worldA)) === 1 && (await destroyWorld(worldB)) === 1);
    check('the new tables are back to their starting counts', JSON.stringify(await newTableCounts()) === JSON.stringify(newBefore));
    const after = await fingerprint();
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, EXISTING_TABLES.every((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h));
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11SA_' } } })) === 0 && (await prisma.school.count({ where: { code: { startsWith: 'M11SB_' } } })) === 0);
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
