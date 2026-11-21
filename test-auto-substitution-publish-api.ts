// Automatic substitution after a REAL publish: real generation pipeline (scripted solver), real POST /timetable-versions/:id/publish, real cover lifecycle.
//   source <guard>/local_test_env.sh && npx tsx test-auto-substitution-publish-api.ts
import 'dotenv/config';
import './test-fixtures/test-security-env.js';
import { createHash } from 'node:crypto';
import { buildApp } from './src/app.js';
import appPrisma from './src/config/database.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { substitutionService } from './src/modules/substitution/substitution.service.js';
import { hashPassword } from './src/utils/password.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { registerGenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner-handle.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { eachDate, weekdayOf } from './src/modules/substitution/substitution.core.js';
import { captureLogger, createWorld, destroyWorld, fastConfig, prisma, rawPrisma, ScriptedSolver, seedYear, solution, waitTerminal, type SeededYear, type World } from './test-fixtures/timetable-generation/runner-test-kit.js';
import { type SolverClient } from './src/modules/timetable-generation/timetable-generation.solver-client.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const PASSWORD = 'AutoPub#Test-2030';

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\w*\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not a local *_test database');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('AUTOPUB');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('AUTOPUB');
  const worlds: World[] = [worldA, worldB];
  const runners: GenerationRunner[] = [];

  interface Reply { status: number; body: Record<string, any> }
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie: string | null, payload?: unknown): Promise<Reply> => {
    const res = await app.inject({ method, url, ...(cookie ? { headers: { cookie: `session_token=${cookie}` } } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
    let body: Record<string, any> = {};
    try { body = JSON.parse(res.body); } catch { /* not JSON */ }
    return { status: res.statusCode, body };
  };
  const sessionFor = async (world: World): Promise<string> => {
    const admin = await prisma.admin.findUniqueOrThrow({ where: { id: world.adminId } });
    await prisma.admin.update({ where: { id: admin.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
    return (await adminService.loginAdmin({ schoolId: world.schoolId, email: admin.email, password: PASSWORD })).sessionToken;
  };
  let forwardTo: GenerationRunner | null = null;
  registerGenerationRunner({ trigger: () => forwardTo?.trigger() });
  const makeRunner = (solver: SolverClient): GenerationRunner => {
    const { logger } = captureLogger();
    const r = new GenerationRunner({ prisma: rawPrisma, solverClient: solver, config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: 30 }, logger });
    runners.push(r);
    return r;
  };

  try {
    const tokA = await sessionFor(worldA);
    const tokB = await sessionFor(worldB);
    const scripted = makeRunner(new ScriptedSolver((ctx) => solution(ctx.problem)));
    forwardTo = scripted;
    scripted.start();
    const school = worldA.schoolId;
    const year: SeededYear = await seedYear(worldA, 'pub', { sections: 3 });
    const generate = async (): Promise<string> => {
      const r = await call('POST', '/api/timetable-generations', tokA, { academicYearId: year.yearId });
      if (r.status !== 202) throw new Error(`generation rejected: ${JSON.stringify(r.body)}`);
      const run = await waitTerminal(r.body.data.generationRunId, 90_000);
      if (run.status !== 'SUCCEEDED') throw new Error(`generation failed: ${run.failureCode}`);
      return run.versionId!;
    };
    const publish = (versionId: string, expectedPublishedVersionId: string | null, tok = tokA) => call('POST', `/api/timetable-versions/${versionId}/publish`, tok, { expectedRevision: 1, expectedPublishedVersionId });
    const lessonsHash = async (versionId: string) => createHash('sha256').update(JSON.stringify(await prisma.timetableEntry.findMany({ where: { versionId }, orderBy: { id: 'asc' } }))).digest('hex');
    let monday = '2030-03-01';
    while (weekdayOf(monday) !== 'MONDAY') monday = eachDate(monday, '2030-03-10')[1]!;
    const mondayN = (n: number): string => { const d = new Date(`${monday}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + 7 * n); return d.toISOString().slice(0, 10); };
    const T0 = year.teacherIds[0]!;
    const SPARE = year.spareTeacherId;
    const coversOf = async (absenceId: string) => prisma.coverRequest.findMany({ where: { absenceId }, orderBy: [{ createdAt: 'asc' }, { periodNumber: 'asc' }, { id: 'asc' }] });
    const liveBad = async () => {
      // after a reconciliation no OPEN/ASSIGNED request may belong to a version that is not the published one, nobody is double booked
      const stale = await prisma.coverRequest.count({ where: { schoolId: school, status: { in: ['OPEN', 'ASSIGNED'] }, timetableVersion: { status: { not: 'PUBLISHED' } }, date: { gte: new Date() } } });
      const dbl = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM (SELECT 1 FROM "cover_requests" WHERE "schoolId" = ${school} AND "status" = 'ASSIGNED'::"CoverStatus" GROUP BY "replacementTeacherId", "date", "periodNumber" HAVING count(*) > 1) x`;
      const dup = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM (SELECT 1 FROM "cover_requests" WHERE "schoolId" = ${school} AND "status" IN ('OPEN'::"CoverStatus", 'ASSIGNED'::"CoverStatus") GROUP BY "sectionId", "date", "periodNumber" HAVING count(*) > 1) x`;
      return stale + Number(dbl[0]!.n) + Number(dup[0]!.n);
    };

    // ===========================================================================================================
    section('1. First publish: the hook runs after the commit and reports; with no cover requests there is nothing to do');
    const v1 = await generate();
    const p1 = await publish(v1, null);
    check('publish → 200 with the usual fields AND data.substitution { status COMPLETED, run }', p1.status === 200 && p1.body.data.status === 'PUBLISHED' && p1.body.data.versionId === v1 && p1.body.data.archivedVersionId === null && p1.body.data.substitution.status === 'COMPLETED' && p1.body.data.substitution.run.considered === 0);
    const v1Hash = await lessonsHash(v1);

    section('2. An absence on the published timetable is assigned automatically');
    const d = mondayN(2);
    const abs = await call('POST', '/api/teacher-absences', tokA, { teacherId: T0, startDate: d, endDate: d });
    const absId = abs.body.data.absence.id;
    const a = abs.body.data.automaticAllocation;
    check('(setup) T0 absent on a Monday: its lessons are all assigned automatically', abs.status === 201 && a.totalAffectedLessons >= 1 && a.assigned === a.totalAffectedLessons && a.unfilled === 0, JSON.stringify(a).slice(0, 200));
    const covers1 = await coversOf(absId);
    // one assignment is changed by the admin; one is left automatic
    const manualTarget = covers1.find((c) => c.status === 'ASSIGNED')!;
    const manualPut = await call('PUT', `/api/substitutions/${manualTarget.id}/assignment`, tokA, { teacherId: manualTarget.replacementTeacherId });
    check('(setup) the admin confirms one automatic choice by assigning that same teacher: it becomes MANUAL (and a repeat is a no-op)', manualPut.status === 200 && manualPut.body.data.assignmentSource === 'MANUAL' && (await call('PUT', `/api/substitutions/${manualTarget.id}/assignment`, tokA, { teacherId: manualTarget.replacementTeacherId })).body.data.assignmentSource === 'MANUAL' && (await prisma.coverEvent.count({ where: { coverRequestId: manualTarget.id, action: 'ASSIGNED' } })) === 1, JSON.stringify(manualPut.body).slice(0, 200));
    const manualTeacher = manualTarget.replacementTeacherId as string;
    const eventsBefore = await prisma.coverEvent.findMany({ where: { schoolId: school }, select: { id: true } });

    // ===========================================================================================================
    section('3. Publishing a NEWER version: old requests become OBSOLETE, new ones are created and assigned, the admin\'s choice is held for review');
    const v2 = await generate();
    const p2 = await publish(v2, v1);
    const sub2 = p2.body.data.substitution;
    check('publish v2 → 200, v1 archived by the same transaction, data.substitution COMPLETED', p2.status === 200 && p2.body.data.archivedVersionId === v1 && sub2.status === 'COMPLETED');
    const all = await coversOf(absId);
    const old = all.filter((c) => c.timetableVersionId === v1);
    const fresh = all.filter((c) => c.timetableVersionId === v2);
    check('every old request is OBSOLETE (future dates, history kept) and every lesson has a NEW request from v2', old.length === covers1.length && old.every((c) => c.status === 'OBSOLETE') && fresh.length === covers1.length && fresh.every((c) => c.supersedesId !== null));
    const heldFresh = fresh.filter((c) => c.supersedesId === manualTarget.id);
    const autoFresh = fresh.filter((c) => c.supersedesId !== manualTarget.id);
    check('the new requests for lessons the system had assigned are assigned automatically, from the new version', autoFresh.length >= 0 && autoFresh.every((c) => c.status === 'ASSIGNED' && c.assignmentSource === 'AUTOMATIC') && sub2.run.assigned === autoFresh.length, JSON.stringify(sub2.run));
    check('the lesson an ADMIN had assigned is NOT silently replaced: its new request stays OPEN with MANUAL_ASSIGNMENT_NEEDS_REVIEW naming the earlier choice', heldFresh.length === 1 && heldFresh[0]!.status === 'OPEN' && heldFresh[0]!.attentionCode === 'MANUAL_ASSIGNMENT_NEEDS_REVIEW' && /had assigned/.test(heldFresh[0]!.attentionNote ?? '') && sub2.run.heldForReview === 1);
    const oldManual = old.find((c) => c.id === manualTarget.id)!;
    check('the old manual request keeps its record: OBSOLETE, the substitute and source MANUAL are still on it', oldManual.status === 'OBSOLETE' && oldManual.replacementTeacherId === manualTeacher && oldManual.assignmentSource === 'MANUAL');
    const eventsAfter = new Set((await prisma.coverEvent.findMany({ where: { schoolId: school }, select: { id: true } })).map((e) => e.id));
    check('all earlier audit events are intact; the obsoleted requests gained an OBSOLETED event', eventsBefore.every((e) => eventsAfter.has(e.id)) && (await prisma.coverEvent.count({ where: { action: 'OBSOLETED', coverRequest: { absenceId: absId } } })) === old.length);
    check('the admin can resolve the held lesson with the normal endpoint, and an allocation run never touches it before that', (await call('POST', `/api/teacher-absences/${absId}/auto-assign`, tokA, {})).body.data.run.assigned === 0 && (await call('PUT', `/api/substitutions/${heldFresh[0]!.id}/assignment`, tokA, { teacherId: manualTeacher, confirmFourConsecutive: true })).status === 200);
    check('both published lesson sets are untouched by all substitution work (v1 unchanged, v2 unchanged); nothing is unpublished', (await lessonsHash(v1)) === v1Hash && (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: v2 } })).status === 'PUBLISHED' && (await liveBad()) === 0);

    // ===========================================================================================================
    section('4. Past dates are never allocated after a publish');
    const pastYear = await prisma.academicYear.create({ data: { schoolId: school, name: 'AUTOPUB-PAST', startDate: new Date('2020-01-01'), endDate: new Date('2020-12-31'), status: 'DRAFT' } });
    const pastVersion = await prisma.timetableVersion.create({ data: { schoolId: school, academicYearId: pastYear.id, versionNumber: 1, status: 'PUBLISHED', solutionSource: 'CP_SAT', solverStatus: 'OPTIMAL', weightsVersion: 'V1', inputHash: 'h-past', inputSnapshot: {}, metrics: {}, baselineMetrics: {}, publishedAt: new Date() } });
    const someEntry = await prisma.timetableEntry.findFirstOrThrow({ where: { versionId: v2, teacherId: T0 } });
    await prisma.timetableEntry.create({ data: { versionId: pastVersion.id, teacherId: T0, sectionId: someEntry.sectionId, subjectId: someEntry.subjectId, subjectRequirementId: someEntry.subjectRequirementId, dayOfWeek: 'MONDAY', periodNumber: 2 } });
    const pastAbs = await call('POST', '/api/teacher-absences', tokA, { teacherId: T0, startDate: '2020-03-02', endDate: '2020-03-02' });
    const run = await call('POST', '/api/substitutions/auto-assign', tokA, {});
    check('an absence in the past: its request stays OPEN (PAST_DATE) through the explicit allocation as well', pastAbs.body.data.automaticAllocation.assigned === 0 && run.body.data.run.assigned === 0 && (await prisma.coverRequest.count({ where: { absenceId: pastAbs.body.data.absence.id, status: 'ASSIGNED' } })) === 0);

    // ===========================================================================================================
    section('5. A failed allocation after a publish leaves the publish intact and the new requests OPEN and recoverable');
    const d5 = mondayN(3);
    const abs5 = await call('POST', '/api/teacher-absences', tokA, { teacherId: T0, startDate: d5, endDate: d5 });
    const absId5 = abs5.body.data.absence.id;
    check('(setup) assigned on v2', abs5.body.data.automaticAllocation.assigned === abs5.body.data.automaticAllocation.totalAffectedLessons);
    const v3 = await generate();
    const realAfterPublish = substitutionService.afterPublish.bind(substitutionService);
    const realTx = appPrisma.$transaction.bind(appPrisma);
    (substitutionService as any).afterPublish = async (...args: any[]) => {
      let calls = 0;
      (appPrisma as any).$transaction = (...t: any[]) => { calls++; return calls >= 2 ? Promise.reject(new Error('simulated allocation failure')) : (realTx as any)(...t); }; // 1st = the reconciliation, 2nd = the allocation
      try { return await (realAfterPublish as any)(...args); } finally { (appPrisma as any).$transaction = realTx; }
    };
    let p3: Reply;
    try { p3 = await publish(v3, v2); } finally { (substitutionService as any).afterPublish = realAfterPublish; }
    check('the publish itself succeeds (200, v3 PUBLISHED, v2 ARCHIVED); data.substitution is FAILED with a retry hint and no internal detail', p3.status === 200 && p3.body.data.status === 'PUBLISHED' && p3.body.data.substitution.status === 'FAILED' && /POST \/api\/substitutions\/auto-assign/.test(p3.body.data.substitution.error) && !/simulated/.test(JSON.stringify(p3.body)) && (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: v2 } })).status === 'ARCHIVED');
    const afterFail = await coversOf(absId5);
    const newOnes = afterFail.filter((c) => c.timetableVersionId === v3);
    check('the reconciliation had committed: old requests OBSOLETE, new v3 requests exist and are OPEN (nothing half-assigned), consistent and recoverable', afterFail.filter((c) => c.timetableVersionId === v2).every((c) => c.status === 'OBSOLETE') && newOnes.length > 0 && newOnes.every((c) => c.status === 'OPEN' && c.replacementTeacherId === null) && (await liveBad()) === 0);
    const recovered = await call('POST', '/api/substitutions/auto-assign', tokA, {});
    const recoveredAgain = await call('POST', '/api/substitutions/auto-assign', tokA, {});
    check('POST /substitutions/auto-assign recovers them (assigned automatically); a second call changes nothing', recovered.body.data.run.assigned >= newOnes.length && recoveredAgain.body.data.run.assigned === 0 && (await prisma.coverRequest.count({ where: { absenceId: absId5, timetableVersionId: v3, status: 'ASSIGNED' } })) === newOnes.length && (await liveBad()) === 0);

    // ===========================================================================================================
    section('6. Publishing while allocations are running (3 rounds)');
    let prev = v3;
    let allOk = true; let detail = '';
    for (let round = 0; round < 3; round++) {
      const dd = mondayN(4 + round);
      const ab = await call('POST', '/api/teacher-absences', tokA, { teacherId: T0, startDate: dd, endDate: dd, autoAssign: false });
      const next = await generate();
      const results = await Promise.all([
        publish(next, prev),
        call('POST', `/api/teacher-absences/${ab.body.data.absence.id}/auto-assign`, tokA, {}),
        call('POST', '/api/substitutions/auto-assign', tokA, {}),
        call('POST', '/api/substitutions/auto-assign', tokA, {}),
      ]);
      await call('GET', '/api/substitutions?status=OPEN,ASSIGNED&limit=500', tokA); // reconciliation (a read; it allocates nothing)
      const settle = await call('POST', '/api/substitutions/auto-assign', tokA, {});
      const live = await prisma.coverRequest.findMany({ where: { absenceId: ab.body.data.absence.id, status: { in: ['OPEN', 'ASSIGNED'] } } });
      const published = await prisma.timetableVersion.findMany({ where: { academicYearId: year.yearId, status: 'PUBLISHED' } });
      const ok = results[0].status === 200 && results.slice(1).every((r) => r.status === 200) && published.length === 1 && published[0]!.id === next && live.every((c) => c.timetableVersionId === next) && live.length > 0 && live.every((c) => c.status === 'ASSIGNED') && (await liveBad()) === 0 && settle.status === 200;
      if (!ok) { allOk = false; detail += ` round${round}: ${results.map((r) => r.status).join('/')} published=${published.length} live=${live.map((c) => `${c.status}@${c.timetableVersionId === next ? 'new' : 'old'}`).join(',')} bad=${await liveBad()}`; }
      prev = next;
    }
    check('publishing a new version while absence/range allocations run: every call succeeds, exactly one version is published, after reconciliation every live request belongs to it and is assigned, nobody is double booked, nothing duplicated', allOk, detail);

    // ===========================================================================================================
    section('7. Isolation and authentication of the publish hook');
    check('school B cannot publish school A\'s version (403) and the hook never runs for it; school B has no cover requests or events', (await publish(v3, null, tokB)).status === 403 && (await prisma.coverRequest.count({ where: { schoolId: worldB.schoolId } })) === 0 && (await call('GET', '/api/substitution-events', tokB)).body.data.items.length === 0);
    check('publishing without a session is a 401 and runs nothing', (await call('POST', `/api/timetable-versions/${v3}/publish`, null, { expectedRevision: 1, expectedPublishedVersionId: null })).status === 401);
    const events = await call('GET', '/api/substitution-events?limit=500', tokA);
    check('the feed shows the post-publish work: obsoleted lessons are not noise for the admin (COVER_OBSOLETED type), automatic assignments and the review hold are visible', events.body.data.items.some((i: any) => i.type === 'COVER_OBSOLETED') && events.body.data.items.some((i: any) => i.type === 'SUBSTITUTE_AUTO_ASSIGNED') && events.body.data.items.some((i: any) => i.type === 'NO_SUBSTITUTE_AVAILABLE' && i.details?.code === 'MANUAL_ASSIGNMENT_NEEDS_REVIEW'));
    void SPARE;
  } finally {
    registerGenerationRunner(null);
    for (const r of runners) { try { await r.stop(5); } catch { /* already stopped */ } }
    await app.close();
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    let removed = 0;
    for (const w of worlds) removed += await destroyWorld(w);
    console.log(`\ncleanup: ${removed} test school(s) removed`);
    await prisma.$disconnect();
  }
  console.log(`\nRESULT: pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
