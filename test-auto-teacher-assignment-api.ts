// Optional explicit teacher assignments: readiness, REAL generation (Python CP-SAT), validation and publishing with automatically chosen teachers,
// plus DELETE /api/teacher-subjects/:id. buildApp() + app.inject(), real database (disposable local one only), test schools only.
//   source <guard>/local_test_env.sh && npx tsx test-auto-teacher-assignment-api.ts
import 'dotenv/config';
import './test-fixtures/test-security-env.js';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { registerGenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner-handle.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { resolveSolverClientConfig, SubprocessSolverClient } from './src/modules/timetable-generation/timetable-generation.solver-client.js';
import { captureLogger, createWorld, destroyWorld, fastConfig, prisma, rawPrisma, seedYear, waitTerminal, type SeededYear, type World } from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const PASSWORD = 'AutoT#Test-Pass-2030';

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\w*\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not a local *_test database');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('AUTOT');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('AUTOT');
  const worlds: World[] = [worldA, worldB];
  const runners: GenerationRunner[] = [];

  interface Reply { status: number; body: Record<string, any> }
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie: string | null, payload?: unknown): Promise<Reply> => {
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

  try {
    const tokA = await sessionFor(worldA);
    const tokB = await sessionFor(worldB);
    registerGenerationRunner({ trigger: () => runner.trigger() });
    const { logger } = captureLogger();
    const runner = new GenerationRunner({ prisma: rawPrisma, solverClient: new SubprocessSolverClient(resolveSolverClientConfig({}, {})), config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: 30 }, logger });
    runners.push(runner);
    runner.start();

    /** A year whose teachers exist and are eligible, but with NO explicit assignment at all. */
    const freshYear = async (tag: string, o: Parameters<typeof seedYear>[2] = {}): Promise<SeededYear> => {
      const y = await seedYear(worldA, tag, o);
      await prisma.sectionSubjectTeacher.deleteMany({ where: { section: { grade: { academicYearId: y.yearId } } } });
      return y;
    };
    const feas = async (y: SeededYear, tok = tokA) => (await call('GET', `/api/timetable-feasibility?academicYearId=${y.yearId}`, tok)).body.data;
    const generate = async (y: SeededYear, tok = tokA) => {
      const r = await call('POST', '/api/timetable-generations', tok, { academicYearId: y.yearId });
      if (r.status !== 202) return { post: r, run: null as any };
      const run = await waitTerminal(r.body.data.generationRunId, 120_000);
      return { post: r, run };
    };
    const entriesOf = async (tok: string, versionId: string): Promise<any[]> => (await call('GET', `/api/timetable-versions/${versionId}`, tok)).body.data.entries;
    const codesOf = (list: Array<{ code: string }> | undefined): string[] => (list ?? []).map((e) => e.code);
    /** Is every lesson taught by a teacher who is qualified (link) and eligible (ALL_GRADES or an eligibility row) for that grade? */
    const allEligible = async (entries: any[], y: SeededYear): Promise<boolean> => {
      const sections = await prisma.section.findMany({ where: { id: { in: y.sectionIds } }, select: { id: true, gradeId: true } });
      const gradeOf = new Map(sections.map((s) => [s.id, s.gradeId]));
      for (const e of entries) {
        const link = await prisma.teacherSubject.findUnique({ where: { teacherId_subjectId: { teacherId: e.teacherId, subjectId: e.subjectId } }, include: { grades: true } });
        if (!link) return false;
        if (link.gradeScope !== 'ALL_GRADES' && !link.grades.some((g) => g.gradeId === gradeOf.get(e.sectionId))) return false;
      }
      return true;
    };
    const noCollisions = (entries: any[]): boolean => {
      const seen = new Set<string>();
      for (const e of entries) { const k = `${e.teacherId}|${e.dayOfWeek}|${e.periodNumber}`; if (seen.has(k)) return false; seen.add(k); }
      const sec = new Set<string>();
      for (const e of entries) { const k = `${e.sectionId}|${e.dayOfWeek}|${e.periodNumber}`; if (sec.has(k)) return false; sec.add(k); }
      return true;
    };

    // ===========================================================================================================
    section('1. No explicit assignment: READY, auto-chosen teachers, REAL solver, validation, publishing');
    const y1 = await freshYear('auto1');
    check('the year has no explicit assignment at all', (await prisma.sectionSubjectTeacher.count({ where: { section: { grade: { academicYearId: y1.yearId } } } })) === 0);
    const f1 = await feas(y1);
    check('feasibility: READY with no errors (missing explicit teachers are not a blocker)', f1.status === 'READY' && f1.errors.length === 0, JSON.stringify(codesOf(f1.errors)));
    check('  one TEACHER_AUTO_ASSIGNED warning per requirement (3 subjects)', codesOf(f1.warnings).filter((c) => c === 'TEACHER_AUTO_ASSIGNED').length === 3);
    check('  no MISSING_TEACHER_ASSIGNMENT error any more', !codesOf(f1.errors).includes('MISSING_TEACHER_ASSIGNMENT'));
    const g1 = await generate(y1);
    check('generation is accepted (202) and the real CP-SAT run SUCCEEDS', g1.post.status === 202 && g1.run?.status === 'SUCCEEDED', `${g1.post.status} ${g1.run?.status} ${g1.run?.failureCode}`);
    const entries1 = g1.run?.versionId ? await entriesOf(tokA, g1.run.versionId) : [];
    check('  the timetable has every lesson (3 sections × 12 periods = 36)', entries1.length === 36, String(entries1.length));
    check('  every lesson is taught by a qualified and eligible teacher of THIS school', (await allEligible(entries1, y1)) && entries1.every((e) => [...y1.teacherIds, y1.spareTeacherId].includes(e.teacherId)));
    check('  no teacher and no section is double-booked', noCollisions(entries1));
    check('  generation created no section-subject-teacher rows (automatic choices are not stored as assignments)', (await prisma.sectionSubjectTeacher.count({ where: { section: { grade: { academicYearId: y1.yearId } } } })) === 0);
    const val1 = (await call('GET', `/api/timetable-versions/${g1.run.versionId}/validation`, tokA)).body.data;
    check('validation: valid, not stale, publishable', val1.valid === true && val1.isStale === false && val1.informational.publishable === true, JSON.stringify(val1.violations?.slice(0, 2)));
    const pub = await call('POST', `/api/timetable-versions/${g1.run.versionId}/publish`, tokA, { expectedRevision: 1, expectedPublishedVersionId: null });
    check('publishing the draft with auto-chosen teachers works (200)', pub.status === 200, JSON.stringify(pub.body).slice(0, 200));
    const val1b = (await call('GET', `/api/timetable-versions/${g1.run.versionId}/validation`, tokA)).body.data;
    check('  and it is still valid and not stale afterwards', val1b.valid === true && val1b.isStale === false);

    // ===========================================================================================================
    section('2. Explicit assignments stay hard overrides');
    const y2 = await freshYear('auto2');
    const explicit = await call('POST', '/api/section-subject-teachers', tokA, { sectionId: y2.sectionIds[0], subjectRequirementId: y2.requirementIds[0], teacherId: y2.spareTeacherId });
    check('explicit assignment of the (eligible) spare teacher → 201', explicit.status === 201, JSON.stringify(explicit.body));
    const f2 = await feas(y2);
    check('feasibility READY; only the 8 other pairs are auto-assigned', f2.status === 'READY' && f2.summary.assignments === 1, JSON.stringify(f2.summary));
    const g2 = await generate(y2);
    check('generation SUCCEEDS', g2.run?.status === 'SUCCEEDED', `${g2.post.status} ${g2.run?.failureCode}`);
    const entries2 = g2.run?.versionId ? await entriesOf(tokA, g2.run.versionId) : [];
    const sub0 = entries2.filter((e) => e.sectionId === y2.sectionIds[0] && e.subjectId === y2.subjectIds[0]);
    check('  the explicitly assigned teacher teaches exactly that section and subject (all its periods)', sub0.length === 5 && sub0.every((e) => e.teacherId === y2.spareTeacherId), JSON.stringify(sub0.map((e) => e.teacherId)));
    check('  all lessons eligible, no collisions', (await allEligible(entries2, y2)) && noCollisions(entries2));

    // ===========================================================================================================
    section('3. Eligibility semantics: SELECTED_GRADES without rows is never used; ALL_GRADES is');
    const y3 = await freshYear('auto3');
    const t3 = (await prisma.teacher.create({ data: { schoolId: worldA.schoolId, name: 'Link without grades' } })).id;
    const link3 = await call('POST', `/api/teachers/${t3}/subjects`, tokA, { subjectId: y3.subjectIds[0], type: 'SECONDARY' });
    check('a teacher linked to the subject with the default SELECTED_GRADES and NO eligibility rows', link3.status === 201 && link3.body.data.gradeScope === 'SELECTED_GRADES');
    const g3 = await generate(y3);
    const e3 = g3.run?.versionId ? await entriesOf(tokA, g3.run.versionId) : [];
    check('generation SUCCEEDS, and that teacher teaches NOTHING (no eligibility by omission)', g3.run?.status === 'SUCCEEDED' && e3.length === 36 && !e3.some((e) => e.teacherId === t3), `${g3.run?.status} ${e3.length}`);
    const y3b = await freshYear('auto3b');
    const t3b = (await prisma.teacher.create({ data: { schoolId: worldA.schoolId, name: 'All grades teacher' } })).id;
    await call('POST', `/api/teachers/${t3b}/subjects`, tokA, { subjectId: y3b.subjectIds[0], type: 'SECONDARY', gradeScope: 'ALL_GRADES' });
    const g3b = await generate(y3b);
    const e3b = g3b.run?.versionId ? await entriesOf(tokA, g3b.run.versionId) : [];
    check('an ALL_GRADES teacher (no eligibility rows) IS used (load is balanced across the 3 eligible teachers)', g3b.run?.status === 'SUCCEEDED' && e3b.some((e) => e.teacherId === t3b && e.subjectId === y3b.subjectIds[0]), `${g3b.run?.status}`);
    check('  and is never given another subject (subject qualification)', e3b.filter((e) => e.teacherId === t3b).every((e) => e.subjectId === y3b.subjectIds[0]));
    check('  all lessons eligible, no collisions', (await allEligible(e3b, y3b)) && noCollisions(e3b));

    // ===========================================================================================================
    section('4. Genuine blockers remain');
    const y4 = await freshYear('auto4');
    const subj1Link = await prisma.teacherSubject.findFirstOrThrow({ where: { teacherId: y4.teacherIds[1]!, subjectId: y4.subjectIds[1]! } });
    const del = await call('DELETE', `/api/teacher-subjects/${subj1Link.id}`, tokA);
    check('(uses the new DELETE) removing the only teacher of subject 1 → 200', del.status === 200, JSON.stringify(del.body));
    const f4 = await feas(y4);
    check('a subject with NO eligible active teacher: NOT_READY with NO_ELIGIBLE_TEACHER', f4.status === 'NOT_READY' && codesOf(f4.errors).includes('NO_ELIGIBLE_TEACHER'), JSON.stringify(codesOf(f4.errors)));
    const g4 = await call('POST', '/api/timetable-generations', tokA, { academicYearId: y4.yearId });
    check('  and generation is refused (400 NOT_READY), nothing is queued', g4.status === 400, String(g4.status));
    const y4b = await freshYear('auto4b');
    await prisma.teacher.update({ where: { id: y4b.teacherIds[2]! }, data: { isActive: false } });
    check('an INACTIVE only-teacher is not a candidate: NO_ELIGIBLE_TEACHER', codesOf((await feas(y4b)).errors).includes('NO_ELIGIBLE_TEACHER'));
    // capacity: 1 working day × 6 periods = 6 slots, so a teacher takes at most 6 periods
    const y4c = await freshYear('auto4c', { sections: 4, days: 1, periodsPerDay: 6, subjects: [2, 2, 2] });
    await prisma.teacherSubjectGrade.deleteMany({ where: { id: y4c.spareEligibilityId } });
    const f4c = await feas(y4c);
    check('eligible teacher exists but capacity is short (8 periods needed, 6 available): the real capacity error, not READY', f4c.status === 'NOT_READY' && codesOf(f4c.errors).includes('ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT') && !codesOf(f4c.errors).includes('MISSING_TEACHER_ASSIGNMENT'), JSON.stringify(codesOf(f4c.errors)));
    const y4d = await freshYear('auto4d');
    const wrong = await prisma.teacher.create({ data: { schoolId: worldA.schoolId, name: 'Not eligible' } });
    await prisma.sectionSubjectTeacher.create({ data: { sectionId: y4d.sectionIds[0]!, subjectRequirementId: y4d.requirementIds[0]!, teacherId: wrong.id } });
    const f4d = await feas(y4d);
    check('an INVALID explicit assignment (teacher not qualified) is a blocker: ASSIGNED_TEACHER_NOT_ELIGIBLE', f4d.status === 'NOT_READY' && codesOf(f4d.errors).includes('ASSIGNED_TEACHER_NOT_ELIGIBLE'), JSON.stringify(codesOf(f4d.errors)));
    const g4d = await call('POST', '/api/timetable-generations', tokA, { academicYearId: y4d.yearId });
    check('  generation is refused; the assignment is NOT silently replaced', g4d.status === 400 && (await prisma.sectionSubjectTeacher.count({ where: { teacherId: wrong.id } })) === 1, String(g4d.status));

    // ===========================================================================================================
    section('5. Staleness: changing eligibility after generation makes the draft stale');
    const y5 = await freshYear('auto5');
    const g5 = await generate(y5);
    const used = (await entriesOf(tokA, g5.run.versionId)).map((e) => e.teacherId);
    const extra = (await prisma.teacher.create({ data: { schoolId: worldA.schoolId, name: 'Late arrival' } })).id;
    await call('POST', `/api/teachers/${extra}/subjects`, tokA, { subjectId: y5.subjectIds[0], type: 'SECONDARY', gradeScope: 'ALL_GRADES' });
    const v5 = (await call('GET', `/api/timetable-versions/${g5.run.versionId}/validation`, tokA)).body.data;
    check('a new eligible teacher changes the automatic choice: the draft is still valid but STALE and not publishable', used.length === 36 && v5.valid === true && v5.isStale === true && v5.informational.publishable === false, JSON.stringify({ valid: v5.valid, stale: v5.isStale }));

    // ===========================================================================================================
    section('6. DELETE /api/teacher-subjects/:id');
    const y6 = await freshYear('del');
    const mkTeacherLink = async (subjectId: string, over: { eligible?: boolean } = {}) => {
      const t = (await prisma.teacher.create({ data: { schoolId: worldA.schoolId, name: 'Deletable' } })).id;
      const l = await prisma.teacherSubject.create({ data: { teacherId: t, subjectId, type: 'PRIMARY' } });
      if (over.eligible) await prisma.teacherSubjectGrade.create({ data: { teacherSubjectId: l.id, gradeId: y6.gradeId } });
      return { teacherId: t, linkId: l.id };
    };
    const free = await mkTeacherLink(y6.subjectIds[0]!, { eligible: true });
    const d1 = await call('DELETE', `/api/teacher-subjects/${free.linkId}`, tokA);
    check('an unused link (with an eligibility row) → 200', d1.status === 200 && d1.body.success === true, JSON.stringify(d1.body));
    check('  only the link and its own eligibility row are gone; the teacher and the subject remain', (await prisma.teacherSubject.count({ where: { id: free.linkId } })) === 0 && (await prisma.teacherSubjectGrade.count({ where: { teacherSubjectId: free.linkId } })) === 0 && (await prisma.teacher.count({ where: { id: free.teacherId } })) === 1 && (await prisma.subject.count({ where: { id: y6.subjectIds[0]! } })) === 1);
    check('  deleting it again → 404', (await call('DELETE', `/api/teacher-subjects/${free.linkId}`, tokA)).status === 404);

    const used6 = await mkTeacherLink(y6.subjectIds[0]!, { eligible: true });
    await prisma.sectionSubjectTeacher.create({ data: { sectionId: y6.sectionIds[0]!, subjectRequirementId: y6.requirementIds[0]!, teacherId: used6.teacherId } });
    const d2 = await call('DELETE', `/api/teacher-subjects/${used6.linkId}`, tokA);
    check('a link with a section assignment in a DRAFT year → 409, nothing deleted (no cascade)', d2.status === 409 && /assignment/i.test(d2.body.message) && (await prisma.teacherSubject.count({ where: { id: used6.linkId } })) === 1 && (await prisma.teacherSubjectGrade.count({ where: { teacherSubjectId: used6.linkId } })) === 1 && (await prisma.sectionSubjectTeacher.count({ where: { teacherId: used6.teacherId } })) === 1, JSON.stringify(d2.body));
    await prisma.academicYear.update({ where: { id: y6.yearId }, data: { status: 'COMPLETED' } });
    const d3 = await call('DELETE', `/api/teacher-subjects/${used6.linkId}`, tokA);
    check('the same link once the year is COMPLETED (history) → 200; the assignment row itself is untouched', d3.status === 200 && (await prisma.sectionSubjectTeacher.count({ where: { teacherId: used6.teacherId } })) === 1, JSON.stringify(d3.body));

    // published lessons that came from an AUTOMATIC choice (no assignment row exists) also protect the link
    const e1Teacher = entries1[0].teacherId as string;
    const e1Subject = entries1[0].subjectId as string;
    const publishedLink = await prisma.teacherSubject.findUniqueOrThrow({ where: { teacherId_subjectId: { teacherId: e1Teacher, subjectId: e1Subject } } });
    const d4 = await call('DELETE', `/api/teacher-subjects/${publishedLink.id}`, tokA);
    check('a link whose lessons are in a PUBLISHED timetable (auto-chosen, no assignment row) → 409, nothing deleted', d4.status === 409 && /published/i.test(d4.body.message) && (await prisma.teacherSubject.count({ where: { id: publishedLink.id } })) === 1, JSON.stringify(d4.body));

    check('another school → 403', (await call('DELETE', `/api/teacher-subjects/${publishedLink.id}`, tokB)).status === 403);
    check('unknown id → 404', (await call('DELETE', '/api/teacher-subjects/00000000-0000-4000-8000-000000000000', tokA)).status === 404);
    check('not a UUID → 400', (await call('DELETE', '/api/teacher-subjects/nope', tokA)).status === 400);
    check('unauthenticated → 401', (await call('DELETE', `/api/teacher-subjects/${publishedLink.id}`, null)).status === 401);
    check('  the foreign / unauthenticated attempts deleted nothing', (await prisma.teacherSubject.count({ where: { id: publishedLink.id } })) === 1);
    const race = await mkTeacherLink(y3.subjectIds[0]!);
    const both = await Promise.all([call('DELETE', `/api/teacher-subjects/${race.linkId}`, tokA), call('DELETE', `/api/teacher-subjects/${race.linkId}`, tokA), call('DELETE', `/api/teacher-subjects/${race.linkId}`, tokA)]);
    check('concurrent deletes of one link: exactly one 200, the rest 404, never 500', both.filter((r) => r.status === 200).length === 1 && both.filter((r) => r.status === 404).length === 2, both.map((r) => r.status).join());

    // ===========================================================================================================
    section('7. Cross-school isolation of the automatic choice');
    const foreignSubject = await prisma.subject.create({ data: { schoolId: worldB.schoolId, name: 'Foreign', code: 'FRN' } });
    const foreignTeacher = await prisma.teacher.create({ data: { schoolId: worldB.schoolId, name: 'Foreign teacher' } });
    await prisma.teacherSubject.create({ data: { teacherId: foreignTeacher.id, subjectId: foreignSubject.id, type: 'PRIMARY', gradeScope: 'ALL_GRADES' } });
    const f7 = await feas(y1, tokB);
    check('school B cannot read school A\'s readiness (403/404, no data)', (await call('GET', `/api/timetable-feasibility?academicYearId=${y1.yearId}`, tokB)).status !== 200 && !f7);
    const g7 = await call('POST', '/api/timetable-generations', tokB, { academicYearId: y2.yearId });
    check('school B cannot start generation for school A\'s year (403/404)', g7.status === 403 || g7.status === 404, String(g7.status));
    check('no lesson of any generated timetable uses a teacher of another school', [entries1, entries2, e3, e3b].every((es) => es.every((e) => e.teacherId !== foreignTeacher.id)));
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
