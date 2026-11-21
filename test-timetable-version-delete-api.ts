// Deleting a timetable version: drafts as before; a PUBLISHED or ARCHIVED version only after explicit confirmation, never over substitution history, never publishing anything in its place.
// buildApp() + app.inject(), real database (disposable local one only), test schools only.
//   source <guard>/local_test_env.sh && npx tsx test-timetable-version-delete-api.ts
import 'dotenv/config';
import './test-fixtures/test-security-env.js';
import { createHash } from 'node:crypto';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { registerGenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner-handle.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { captureLogger, createWorld, destroyWorld, fastConfig, prisma, rawPrisma, ScriptedSolver, seedYear, solution, waitTerminal, type World } from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const PASSWORD = 'VDel#Test-Pass-2030';
const UUID0 = '00000000-0000-4000-8000-000000000000';

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\w*\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not a local *_test database');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('VDEL');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('VDEL');
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
  const code = (r: Reply): string | undefined => r.body.data?.code;

  try {
    const tokA = await sessionFor(worldA);
    const tokB = await sessionFor(worldB);
    const ry = await seedYear(worldA, 'vdel');
    const { logger } = captureLogger();
    const runner = new GenerationRunner({ prisma: rawPrisma, solverClient: new ScriptedSolver((ctx) => solution(ctx.problem)), config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: 30 }, logger });
    runners.push(runner);
    registerGenerationRunner({ trigger: () => runner.trigger() });
    runner.start();

    const generate = async (): Promise<string> => {
      const r = await call('POST', '/api/timetable-generations', tokA, { academicYearId: ry.yearId });
      if (r.status !== 202) throw new Error(`generation rejected: ${JSON.stringify(r.body).slice(0, 200)}`);
      const run = await waitTerminal(r.body.data.generationRunId, 90_000);
      if (run.status !== 'SUCCEEDED') throw new Error(`generation failed: ${run.failureCode}`);
      return run.versionId!;
    };
    const version = (id: string) => prisma.timetableVersion.findUniqueOrThrow({ where: { id } });
    const publish = async (id: string, expectedPublishedVersionId: string | null = null) => call('POST', `/api/timetable-versions/${id}/publish`, null === tokA ? null : tokA, { expectedRevision: (await version(id)).revision, expectedPublishedVersionId });
    const confirmFor = async (id: string, over: Record<string, unknown> = {}) => { const v = await version(id); return { confirmVersionNumber: v.versionNumber, expectedStatus: v.status, expectedRevision: v.revision, ...over }; };
    const del = async (id: string, body?: unknown, tok: string | null = tokA) => call('DELETE', `/api/timetable-versions/${id}`, tok, body);
    const clone = async (id: string) => (await call('POST', `/api/timetable-versions/${id}/clone`, tokA, {})).body.data.id as string;
    const published = async () => (await prisma.timetableVersion.findMany({ where: { academicYearId: ry.yearId, status: 'PUBLISHED' }, select: { id: true } })).map((v) => v.id);
    const lessons = (id: string) => prisma.timetableEntry.count({ where: { versionId: id } });
    const fingerprintOf = async (id: string) => { const v = await version(id); return createHash('sha256').update(JSON.stringify([await prisma.timetableEntry.findMany({ where: { versionId: id }, orderBy: { id: 'asc' } }), v.status, v.revision, v.publishedAt, v.archivedAt])).digest('hex'); };
    const setup = async () => JSON.stringify([await prisma.grade.count({ where: { academicYearId: ry.yearId } }), await prisma.section.count({ where: { gradeId: ry.gradeId } }), await prisma.subjectRequirement.count({ where: { gradeId: ry.gradeId } }), await prisma.sectionSubjectTeacher.count({ where: { section: { gradeId: ry.gradeId } } }), await prisma.scheduleConfig.count({ where: { academicYearId: ry.yearId } }), await prisma.schedulePeriod.count({ where: { scheduleConfig: { academicYearId: ry.yearId } } }), await prisma.teacherSubject.count({ where: { teacher: { schoolId: worldA.schoolId } } })]);

    // =====================================================================================================================================
    section('1. Drafts: unchanged');
    const d1 = await generate();
    const n1 = await lessons(d1);
    check('(setup) a draft with lessons exists', n1 > 0);
    check('401 without a session; 403 for another school; 404 unknown; 400 malformed', (await del(d1, undefined, null)).status === 401 && (await del(d1, undefined, tokB)).status === 403 && (await del(UUID0)).status === 404 && (await del('nope')).status === 400 && await lessons(d1) === n1);
    const dd = await del(d1);
    check('a draft is deleted with NO confirmation (200), its lessons go with it, and the response says so', dd.status === 200 && dd.body.data.status === 'DRAFT' && dd.body.data.lessonsRemoved === n1 && !(await prisma.timetableVersion.findUnique({ where: { id: d1 } })) && await lessons(d1) === 0);
    check('the generation run that made it is kept, with versionId null', (await prisma.timetableGenerationRun.count({ where: { academicYearId: ry.yearId, versionId: null, status: 'SUCCEEDED' } })) === 1);

    // =====================================================================================================================================
    section('2. A published version needs explicit confirmation');
    const v1 = await generate();
    check('(setup) version published', (await publish(v1)).status === 200);
    const notDeleted = async () => (await prisma.timetableVersion.findUnique({ where: { id: v1 } }))?.status === 'PUBLISHED' && await lessons(v1) === n1;
    const noBody = await del(v1);
    check('without a confirmation: 409 CONFIRMATION_REQUIRED naming what to send; nothing deleted', noBody.status === 409 && code(noBody) === 'CONFIRMATION_REQUIRED' && /confirmVersionNumber/.test(noBody.body.message) && await notDeleted(), JSON.stringify(noBody.body).slice(0, 300) + ` deleted? ${await notDeleted()}`);
    const wrongNumber = await del(v1, await confirmFor(v1, { confirmVersionNumber: 99 }));
    check('the wrong version number: 400 CONFIRMATION_MISMATCH', wrongNumber.status === 400 && code(wrongNumber) === 'CONFIRMATION_MISMATCH' && await notDeleted());
    const wrongStatus = await del(v1, await confirmFor(v1, { expectedStatus: 'ARCHIVED' }));
    check('the wrong status (looked at ARCHIVED, it is PUBLISHED): 409 STATUS_CHANGED', wrongStatus.status === 409 && code(wrongStatus) === 'STATUS_CHANGED' && wrongStatus.body.data.status === 'PUBLISHED' && await notDeleted());
    const staleRev = await del(v1, await confirmFor(v1, { expectedRevision: 1000 }));
    check('a stale revision: 409 REVISION_CONFLICT', staleRev.status === 409 && code(staleRev) === 'REVISION_CONFLICT' && await notDeleted());
    check('malformed confirmations are 400 and delete nothing (string number, extra field, DRAFT as expectedStatus, empty object)', (await Promise.all([{ ...(await confirmFor(v1)), confirmVersionNumber: '1' }, { ...(await confirmFor(v1)), extra: true }, await confirmFor(v1, { expectedStatus: 'DRAFT' }), {}].map((b) => del(v1, b)))).every((r) => r.status === 400) && await notDeleted());
    check('another school cannot delete it even with a valid confirmation (403)', (await del(v1, await confirmFor(v1), tokB)).status === 403 && await notDeleted());
    check('an unauthenticated request cannot (401)', (await del(v1, await confirmFor(v1), null)).status === 401 && await notDeleted());

    // =====================================================================================================================================
    section('3. Deleting the published version: nothing else changes, nothing is published in its place');
    const draftA = await generate();
    const draftB = await clone(v1);
    const archivedOld = await generate();
    check('(setup) two drafts and a third draft exist next to the published one', (await version(draftA)).status === 'DRAFT' && (await version(draftB)).status === 'DRAFT' && (await version(archivedOld)).status === 'DRAFT');
    const before = { a: await fingerprintOf(draftA), b: await fingerprintOf(draftB), c: await fingerprintOf(archivedOld), setup: await setup() };
    const cloneParent = (await version(draftB)).clonedFromId;
    const confirmed = await del(v1, await confirmFor(v1));
    check('with the confirmation the published version is deleted (200) and the response lists what went', confirmed.status === 200 && confirmed.body.data.status === 'PUBLISHED' && confirmed.body.data.lessonsRemoved === n1 && confirmed.body.data.publishedVersionNow === null && confirmed.body.data.detachedClones === 1, JSON.stringify(confirmed.body).slice(0, 200));
    check('the version and all of its lessons are gone', !(await prisma.timetableVersion.findUnique({ where: { id: v1 } })) && await lessons(v1) === 0);
    check('the year now has NO published version, and no draft was published on its own', (await published()).length === 0 && (await version(draftA)).status === 'DRAFT' && (await version(draftB)).status === 'DRAFT' && (await version(archivedOld)).status === 'DRAFT');
    check('every other version is byte-for-byte the same (lessons, status, revision, timestamps)', before.a === await fingerprintOf(draftA) && before.b === await fingerprintOf(draftB) && before.c === await fingerprintOf(archivedOld));
    check('the academic year setup is intact (grades, sections, curriculum, assignments, schedule, teacher links)', before.setup === await setup());
    check('the only detached relation is the clone provenance (clonedFromId) of a draft cloned from it', cloneParent === v1 && (await version(draftB)).clonedFromId === null);
    check('the generation run that produced it is kept with versionId null', (await prisma.timetableGenerationRun.count({ where: { academicYearId: ry.yearId, versionId: null } })) >= 2);
    check('deleting it again is 404', (await del(v1, { confirmVersionNumber: 1, expectedStatus: 'PUBLISHED', expectedRevision: 2 })).status === 404);

    // =====================================================================================================================================
    section('4. The no-published-version state is handled cleanly');
    const list = await call('GET', `/api/timetable-versions?academicYearId=${ry.yearId}&status=PUBLISHED`, tokA);
    check('the version list shows no PUBLISHED version (200, empty)', list.status === 200 && list.body.data.length === 0);
    const all = await call('GET', `/api/timetable-versions?academicYearId=${ry.yearId}`, tokA);
    check('the other versions are listed and none is published', all.status === 200 && all.body.data.length === 3 && all.body.data.every((v: any) => v.status === 'DRAFT'));
    check('a remaining draft can still be read, viewed and validated', (await call('GET', `/api/timetable-versions/${draftA}`, tokA)).status === 200 && (await call('GET', `/api/timetable-versions/${draftA}/validation`, tokA)).status === 200);
    const readiness = await call('GET', `/api/timetable-feasibility?academicYearId=${ry.yearId}`, tokA);
    check('readiness (feasibility) is unaffected: still answers, still READY', readiness.status === 200 && readiness.body.data.status === 'READY', JSON.stringify(readiness.body).slice(0, 160));
    const abs = await call('POST', '/api/teacher-absences', tokA, { teacherId: ry.teacherIds[0], startDate: '2030-03-04', endDate: '2030-03-04' });
    check('an absence recorded now needs no cover and says there is no published timetable for the date', abs.status === 201 && abs.body.data.coverRequestsCreated === 0 && abs.body.data.datesWithoutPublishedTimetable === 1, JSON.stringify(abs.body).slice(0, 200));
    await call('POST', `/api/teacher-absences/${abs.body.data.absence.id}/cancel`, tokA);
    const stalePublish = await publish(draftA, v1);
    check('a publish that still expects the deleted version as the published one is refused (409), not applied', stalePublish.status === 409 && (await published()).length === 0);
    const republish = await publish(draftA, null);
    check('publishing a draft with "no published version" expected works (200): an administrator chose it', republish.status === 200 && (await published()).join() === draftA);

    // =====================================================================================================================================
    section('5. An ARCHIVED version can be deleted too');
    const next = await clone(draftA);
    const pub2 = await publish(next, draftA);
    check('(setup) the newer version is published, the first became ARCHIVED', pub2.status === 200 && (await version(draftA)).status === 'ARCHIVED');
    const nextBefore = await fingerprintOf(next);
    const archivedConfirm = await confirmFor(draftA);
    check('the confirmation names the archived status', archivedConfirm.expectedStatus === 'ARCHIVED');
    check('without the confirmation: 409 CONFIRMATION_REQUIRED', code(await del(draftA)) === 'CONFIRMATION_REQUIRED');
    const archivedDel = await del(draftA, archivedConfirm);
    check('with it the archived version is deleted (200); the published one is untouched and still the published version', archivedDel.status === 200 && archivedDel.body.data.status === 'ARCHIVED' && !(await prisma.timetableVersion.findUnique({ where: { id: draftA } })) && (await published()).join() === next && nextBefore === await fingerprintOf(next));

    // =====================================================================================================================================
    section('6. Substitution history is never erased');
    const absence = await call('POST', '/api/teacher-absences', tokA, { teacherId: ry.teacherIds[0], startDate: '2030-03-04', endDate: '2030-03-04', autoAssign: false });
    check('(setup) an absence creates cover requests from the published version', absence.status === 201 && absence.body.data.coverRequestsCreated > 0, JSON.stringify(absence.body).slice(0, 200));
    const covers = await prisma.coverRequest.findMany({ where: { timetableVersionId: next } });
    const first = covers[0]!;
    const assign = await call('PUT', `/api/substitutions/${first.id}/assignment`, tokA, { teacherId: ry.spareTeacherId });
    check('(setup) one cover is assigned to a replacement', assign.status === 200, JSON.stringify(assign.body).slice(0, 160));
    const eventsBefore = await prisma.coverEvent.count({ where: { coverRequest: { timetableVersionId: next } } });
    const blockedDel = await del(next, await confirmFor(next));
    check('deleting the published version is refused: 409 VERSION_HAS_HISTORY listing the cover requests by status', blockedDel.status === 409 && code(blockedDel) === 'VERSION_HAS_HISTORY' && blockedDel.body.data.coverRequestTotal === covers.length && blockedDel.body.data.coverRequests.ASSIGNED === 1 && /never erased/.test(blockedDel.body.message), JSON.stringify(blockedDel.body).slice(0, 240));
    check('the version, its lessons, the cover requests and their events are all still there', (await version(next)).status === 'PUBLISHED' && await lessons(next) === n1 && (await prisma.coverRequest.count({ where: { timetableVersionId: next } })) === covers.length && (await prisma.coverEvent.count({ where: { coverRequest: { timetableVersionId: next } } })) === eventsBefore);
    await call('POST', `/api/teacher-absences/${absence.body.data.absence.id}/cancel`, tokA);
    check('even after the absence is cancelled (covers become CANCELLED history) the version stays protected', code(await del(next, await confirmFor(next))) === 'VERSION_HAS_HISTORY' && (await version(next)).status === 'PUBLISHED');
    const bypass = await prisma.timetableVersion.delete({ where: { id: next } }).then(() => 'deleted', (e: Error) => (/foreign key|constraint/i.test(e.message) ? 'refused' : `other: ${e.message.slice(0, 100)}`));
    check('DATABASE BACKSTOP: a direct delete of that version is refused by the foreign key; its cover requests survive', bypass === 'refused' && (await prisma.coverRequest.count({ where: { timetableVersionId: next } })) === covers.length, bypass);
    check('the teacher absence record itself is untouched', (await prisma.teacherAbsence.count({ where: { id: absence.body.data.absence.id } })) === 1);

    // =====================================================================================================================================
    section('7. A COMPLETED academic year keeps its timetables');
    const other = await seedYear(worldA, 'vdel-done');
    const done = await prisma.timetableVersion.create({ data: { schoolId: worldA.schoolId, academicYearId: other.yearId, versionNumber: 1, status: 'ARCHIVED', publishedAt: new Date(), solutionSource: 'CP_SAT', solverStatus: 'OPTIMAL', weightsVersion: 'w', inputHash: 'h', inputSnapshot: {}, metrics: {}, baselineMetrics: {}, archivedAt: new Date() } });
    await prisma.academicYear.update({ where: { id: other.yearId }, data: { status: 'COMPLETED' } });
    const doneDel = await del(done.id, { confirmVersionNumber: 1, expectedStatus: 'ARCHIVED', expectedRevision: done.revision });
    check('deleting an archived version of a COMPLETED year: 409 ACADEMIC_YEAR_NOT_EDITABLE; it stays', doneDel.status === 409 && code(doneDel) === 'ACADEMIC_YEAR_NOT_EDITABLE' && !!(await prisma.timetableVersion.findUnique({ where: { id: done.id } })));

    // =====================================================================================================================================
    section('8. Concurrency');
    // two simultaneous confirmed deletes of one published version
    const cleanTarget = await generate();
    await call('POST', `/api/timetable-versions/${next}/clone`, tokA, {}); // keep a spare draft around (ignored if capped)
    await prisma.coverRequest.deleteMany({ where: { timetableVersionId: next } }); // fixture: let `next` be archived/deleted below like any version without history
    check('(setup) cover history removed from the fixture so concurrent deletion can be exercised', (await prisma.coverRequest.count({ where: { timetableVersionId: next } })) === 0);
    const twin = await Promise.all([1, 2, 3].map(async () => del(next, await confirmFor(next))));
    const ok = twin.filter((r) => r.status === 200).length;
    check('three simultaneous confirmed deletes of one published version: exactly one 200, the others 404 or 409, never a 500', ok === 1 && twin.every((r) => r.status === 200 || r.status === 404 || r.status === 409), twin.map((r) => r.status).join());
    check('the year has no published version afterwards, and the unrelated draft is still a draft', (await published()).length === 0 && (await version(cleanTarget)).status === 'DRAFT');

    // publish racing delete of the currently published version, several rounds
    let current = cleanTarget;
    await publish(current);
    let consistent = true;
    let noError = true;
    let outcomes = '';
    for (let round = 0; round < 6; round++) {
      const pubNow = (await published())[0]!;
      const challenger = await clone(pubNow);
      const [r1, r2] = await Promise.all([
        confirmFor(pubNow).then((b) => del(pubNow, b)),
        publish(challenger, pubNow),
      ]);
      const pubAfter = await published();
      const deleted = !(await prisma.timetableVersion.findUnique({ where: { id: pubNow } }));
      // two legal outcomes: (delete wins) old gone, nothing published, challenger still a draft, publish refused; (publish wins) old archived and kept, challenger published, delete refused
      const deleteWon = r1.status === 200 && deleted && pubAfter.length === 0 && (await version(challenger)).status === 'DRAFT' && r2.status === 409;
      const publishWon = r2.status === 200 && !deleted && (await version(pubNow)).status === 'ARCHIVED' && pubAfter.join() === challenger && r1.status === 409 && code(r1 as Reply) === 'STATUS_CHANGED';
      if (!deleteWon && !publishWon) consistent = false;
      if (r1.status >= 500 || r2.status >= 500) noError = false;
      outcomes += `${deleteWon ? 'D' : publishWon ? 'P' : '?'}(${r1.status}/${r2.status}) `;
      if (pubAfter.length === 0) await publish(challenger, null); // an administrator publishes again, as the product requires
      current = (await published())[0]!;
      for (const stale of await prisma.timetableVersion.findMany({ where: { academicYearId: ry.yearId, status: { in: ['DRAFT', 'ARCHIVED'] } }, select: { id: true } })) { if (stale.id !== current) { const b = await confirmFor(stale.id).catch(() => null); if (b) await del(stale.id, (await version(stale.id)).status === 'DRAFT' ? undefined : b); } }
    }
    check('publish racing delete (6 rounds): always one of the two legal outcomes, never both, never a published pointer left dangling', consistent, outcomes);
    check('…and never a 500', noError, outcomes);
    check('at most one version is ever published', (await published()).length <= 1);
  } finally {
    for (const r of runners) { try { await r.stop(); } catch { /* already stopped */ } }
    let removed = 0;
    for (const w of worlds) removed += await destroyWorld(w);
    console.log(`\ncleanup: ${removed} test school(s) removed`);
    await app.close();
    await prisma.$disconnect();
  }
  console.log(`\nRESULT: pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
