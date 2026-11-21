// Teacher-subject gradeScope (SELECTED_GRADES | ALL_GRADES): HTTP + database behaviour.
// buildApp() + app.inject() (real routes, auth, sessions), real database, test schools only (cleaned up at the end).
// MUST run against the disposable local database:   source <guard>/local_test_env.sh && npx tsx test-teacher-grade-scope-api.ts
import 'dotenv/config';
import './test-fixtures/test-security-env.js';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { loadGenerationSnapshot } from './src/modules/timetable-generation/timetable-generation.loader.js';
import { normalizeProblem } from './src/modules/timetable-generation/timetable-generation.normalizer.js';
import { createWorld, destroyWorld, prisma, rawPrisma, seedYear, type World } from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const PASSWORD = 'Scope#Test-Pass-2030';

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not the local *_test database');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('GSCOPE');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('GSCOPE');
  const worlds: World[] = [worldA, worldB];

  interface Reply { status: number; body: Record<string, any> }
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: unknown): Promise<Reply> => {
    const res = await app.inject({ method, url, headers: { cookie: `session_token=${cookie}` }, ...(payload !== undefined ? { payload: payload as object } : {}) });
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

    // One DRAFT year: grade G8 (3 sections), 3 subjects each with a requirement (+ their own assigned, eligible teachers) and an unused spare.
    const year = await seedYear(worldA, 'GS');
    const subjectId = year.subjectIds[0]!;
    const requirementId = year.requirementIds[0]!;
    const sectionId = year.sectionIds[0]!;
    const freshTeacher = async (name: string) => (await prisma.teacher.create({ data: { schoolId: worldA.schoolId, name } })).id;
    // the seed pre-assigns every section for every requirement; free requirement 0 so this test controls it
    await prisma.sectionSubjectTeacher.deleteMany({ where: { subjectRequirementId: requirementId } });
    const link = (teacherId: string, body: Record<string, unknown>) => call('POST', `/api/teachers/${teacherId}/subjects`, tokA, { subjectId, type: 'PRIMARY', ...body });
    const assign = (teacherId: string, sId = sectionId) => call('POST', '/api/section-subject-teachers', tokA, { sectionId: sId, subjectRequirementId: requirementId, teacherId });
    const dropAssignmentsOf = (teacherId: string) => prisma.sectionSubjectTeacher.deleteMany({ where: { teacherId } });

    section('CREATE: gradeScope is optional; omission never grants anything');
    const tNone = await freshTeacher('No-preference teacher');
    const created = await link(tNone, {});
    check('teacher-subject created without gradeScope → 201', created.status === 201, JSON.stringify(created.body));
    check('  response carries gradeScope = SELECTED_GRADES (strict default)', created.body.data?.gradeScope === 'SELECTED_GRADES', JSON.stringify(created.body));
    const noneLinkId = created.body.data?.id as string;
    const a1 = await assign(tNone);
    check('  assigning that teacher (no eligibility rows) is still refused (400): omission is not permission', a1.status === 400 && /not eligible/i.test(JSON.stringify(a1.body)), JSON.stringify(a1.body));

    const tAll = await freshTeacher('All-grades teacher');
    const createdAll = await link(tAll, { gradeScope: 'ALL_GRADES' });
    check('teacher-subject created with gradeScope ALL_GRADES → 201 and echoed', createdAll.status === 201 && createdAll.body.data?.gradeScope === 'ALL_GRADES', JSON.stringify(createdAll.body));
    const allLinkId = createdAll.body.data?.id as string;
    const bad = await link(await freshTeacher('Bad scope'), { gradeScope: 'EVERYTHING' });
    check('invalid gradeScope value → 400', bad.status === 400, String(bad.status));

    section('ASSIGNMENT: subject qualification and grade eligibility');
    const a2 = await assign(tAll);
    check('ALL_GRADES teacher with no eligibility rows can be assigned → 201', a2.status === 201, JSON.stringify(a2.body));
    const tNoSubject = await freshTeacher('Unqualified teacher');
    const a3 = await assign(tNoSubject);
    check('a teacher with NO subject link is refused (400) regardless of scope', a3.status === 400 && /not assigned to teach this subject/i.test(JSON.stringify(a3.body)), JSON.stringify(a3.body));
    const tOtherSubj = await freshTeacher('ALL_GRADES for another subject');
    await call('POST', `/api/teachers/${tOtherSubj}/subjects`, tokA, { subjectId: year.subjectIds[1], type: 'PRIMARY', gradeScope: 'ALL_GRADES' });
    const a4 = await assign(tOtherSubj);
    check('ALL_GRADES on a different subject does not qualify the teacher (400)', a4.status === 400, JSON.stringify(a4.body));
    const tSel = await freshTeacher('Explicit-grade teacher');
    const selLink = (await link(tSel, {})).body.data?.id as string;
    const elig = await call('POST', `/api/teacher-subjects/${selLink}/grades`, tokA, { gradeId: year.gradeId });
    check('explicit eligibility row can still be added → 201', elig.status === 201, JSON.stringify(elig.body));
    const a5 = await assign(tSel, year.sectionIds[1]!);
    check('SELECTED_GRADES teacher with an explicit eligibility row is assigned → 201 (existing behaviour)', a5.status === 201, JSON.stringify(a5.body));
    const grade9 = await prisma.grade.create({ data: { academicYearId: year.yearId, name: 'G9', displayOrder: 2 } });
    const sec9 = await prisma.section.create({ data: { gradeId: grade9.id, name: 'N1', code: 'N1' } });
    const req9 = await prisma.subjectRequirement.create({ data: { gradeId: grade9.id, subjectId, periodsPerWeek: 3 } });
    const a6 = await call('POST', '/api/section-subject-teachers', tokA, { sectionId: sec9.id, subjectRequirementId: req9.id, teacherId: tSel });
    check('SELECTED_GRADES teacher is refused for a grade WITHOUT an eligibility row (400, existing behaviour)', a6.status === 400, JSON.stringify(a6.body));
    const a7 = await call('POST', '/api/section-subject-teachers', tokA, { sectionId: sec9.id, subjectRequirementId: req9.id, teacherId: tAll });
    check('ALL_GRADES teacher is accepted for that other grade too (201)', a7.status === 201, JSON.stringify(a7.body));

    section('PATCH: type / gradeScope, narrowing guard, no regressions');
    const emptyPatch = await call('PATCH', `/api/teacher-subjects/${noneLinkId}`, tokA, {});
    check('PATCH with an empty body → 400', emptyPatch.status === 400, String(emptyPatch.status));
    const typeOnly = await call('PATCH', `/api/teacher-subjects/${noneLinkId}`, tokA, { type: 'SECONDARY' });
    check('PATCH type only → 200, scope unchanged', typeOnly.status === 200 && typeOnly.body.data?.type === 'SECONDARY' && typeOnly.body.data?.gradeScope === 'SELECTED_GRADES', JSON.stringify(typeOnly.body));
    const badScopePatch = await call('PATCH', `/api/teacher-subjects/${noneLinkId}`, tokA, { gradeScope: 'NOPE' });
    check('PATCH invalid gradeScope → 400', badScopePatch.status === 400, String(badScopePatch.status));
    const narrow = await call('PATCH', `/api/teacher-subjects/${allLinkId}`, tokA, { gradeScope: 'SELECTED_GRADES' });
    check('narrowing ALL_GRADES → SELECTED_GRADES while DRAFT assignments teach grades without eligibility → 409', narrow.status === 409 && /G8|G9/.test(JSON.stringify(narrow.body)), JSON.stringify(narrow.body));
    const stillAll = await prisma.teacherSubject.findUniqueOrThrow({ where: { id: allLinkId } });
    check('  nothing changed after the refusal', stillAll.gradeScope === 'ALL_GRADES');
    for (const gradeId of [year.gradeId, grade9.id]) await call('POST', `/api/teacher-subjects/${allLinkId}/grades`, tokA, { gradeId });
    const narrowOk = await call('PATCH', `/api/teacher-subjects/${allLinkId}`, tokA, { gradeScope: 'SELECTED_GRADES' });
    check('after the eligibility rows exist for every assigned grade, narrowing → 200', narrowOk.status === 200 && narrowOk.body.data?.gradeScope === 'SELECTED_GRADES', JSON.stringify(narrowOk.body));
    const delBlocked = await call('DELETE', `/api/teacher-subjects/${allLinkId}/grades/${grade9.id}`, tokA);
    check('under SELECTED_GRADES, deleting an eligibility that assignments depend on → 409 (existing guard)', delBlocked.status === 409, JSON.stringify(delBlocked.body));
    const widen = await call('PATCH', `/api/teacher-subjects/${allLinkId}`, tokA, { gradeScope: 'ALL_GRADES' });
    check('widening to ALL_GRADES → 200', widen.status === 200 && widen.body.data?.gradeScope === 'ALL_GRADES', JSON.stringify(widen.body));
    const delOk = await call('DELETE', `/api/teacher-subjects/${allLinkId}/grades/${grade9.id}`, tokA);
    check('under ALL_GRADES the eligibility row can be removed without orphaning the assignment → 204', delOk.status === 204 || delOk.status === 200, JSON.stringify(delOk.body));
    const listed = await call('GET', `/api/teachers/${tAll}/subjects`, tokA);
    check('GET teacher subjects lists gradeScope', listed.status === 200 && JSON.stringify(listed.body).includes('"gradeScope":"ALL_GRADES"'), JSON.stringify(listed.body));

    section('FEASIBILITY and GENERATION preflight honour the scope');
    const feas = await call('GET', `/api/timetable-feasibility?academicYearId=${year.yearId}`, tokA);
    const feasIssues = JSON.stringify(feas.body);
    check('feasibility is reachable', feas.status === 200, String(feas.status));
    check('  ALL_GRADES teacher (no rows for G9) is NOT reported as ASSIGNED_TEACHER_NOT_ELIGIBLE', !new RegExp(`ASSIGNED_TEACHER_NOT_ELIGIBLE[^}]*${tAll}`).test(feasIssues) && !feasIssues.includes(`"teacherId":"${tAll}","reason"`));
    // a SELECTED_GRADES assignment inserted behind the API's back (e.g. rows removed later) IS reported
    const sec9b = await prisma.section.create({ data: { gradeId: grade9.id, name: 'N2', code: 'N2' } });
    await prisma.sectionSubjectTeacher.create({ data: { sectionId: sec9b.id, subjectRequirementId: req9.id, teacherId: tNone } });
    const feas2 = await call('GET', `/api/timetable-feasibility?academicYearId=${year.yearId}`, tokA);
    const errs = (feas2.body.data?.errors ?? feas2.body.errors ?? []) as Array<{ code: string; details?: { teacherId?: string; reason?: string } }>;
    check('SELECTED_GRADES teacher without a row is reported ASSIGNED_TEACHER_NOT_ELIGIBLE', errs.some((e) => e.code === 'ASSIGNED_TEACHER_NOT_ELIGIBLE' && e.details?.teacherId === tNone), JSON.stringify(errs.map((e) => e.code)));
    check('  while the ALL_GRADES teacher is not', !errs.some((e) => e.code === 'ASSIGNED_TEACHER_NOT_ELIGIBLE' && e.details?.teacherId === tAll));
    await dropAssignmentsOf(tNone);
    const snapshot = await loadGenerationSnapshot(rawPrisma, worldA.schoolId, year.yearId);
    const norm = normalizeProblem(snapshot);
    const notEligible = (norm.ok ? [] : norm.issues).filter((i) => i.code === 'TEACHER_NOT_ELIGIBLE'); // now ok: the other pairs are auto-assigned
    check('generation snapshot/normalizer: no TEACHER_NOT_ELIGIBLE for the ALL_GRADES and explicit teachers', notEligible.length === 0, JSON.stringify(notEligible));
    await prisma.teacherSubject.update({ where: { id: allLinkId }, data: { gradeScope: 'SELECTED_GRADES' } });
    await prisma.teacherSubjectGrade.deleteMany({ where: { teacherSubjectId: allLinkId, gradeId: grade9.id } });
    const snapshot2 = await loadGenerationSnapshot(rawPrisma, worldA.schoolId, year.yearId);
    const norm2 = normalizeProblem(snapshot2);
    check('  after narrowing without the G9 row the normalizer rejects the assignment (TEACHER_NOT_ELIGIBLE)', !norm2.ok && norm2.issues.some((i) => i.code === 'TEACHER_NOT_ELIGIBLE'));

    section('CROSS-SCHOOL isolation');
    const foreignPatch = await call('PATCH', `/api/teacher-subjects/${allLinkId}`, tokB, { gradeScope: 'SELECTED_GRADES' });
    check('another school cannot PATCH the scope (403/404)', foreignPatch.status === 403 || foreignPatch.status === 404, String(foreignPatch.status));
    const foreignCreate = await call('POST', `/api/teachers/${tAll}/subjects`, tokB, { subjectId, type: 'SECONDARY', gradeScope: 'ALL_GRADES' });
    check('another school cannot create a link on this teacher (403/404)', foreignCreate.status === 403 || foreignCreate.status === 404, String(foreignCreate.status));
    const foreignAssign = await call('POST', '/api/section-subject-teachers', tokB, { sectionId: year.sectionIds[2], subjectRequirementId: requirementId, teacherId: tAll });
    check('another school cannot assign this ALL_GRADES teacher to this school\'s section (403/404)', foreignAssign.status === 403 || foreignAssign.status === 404, String(foreignAssign.status));
    const unchanged = await prisma.teacherSubject.findUniqueOrThrow({ where: { id: allLinkId } });
    check('  the scope is untouched by the foreign attempts', unchanged.gradeScope === 'SELECTED_GRADES');
    const noAuth = await app.inject({ method: 'PATCH', url: `/api/teacher-subjects/${allLinkId}`, payload: { gradeScope: 'ALL_GRADES' } });
    check('unauthenticated PATCH → 401', noAuth.statusCode === 401, String(noAuth.statusCode));
  } finally {
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
