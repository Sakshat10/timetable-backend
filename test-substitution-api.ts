// Substitution workflow: absences, unavailability, lessons needing cover (published timetable), candidates, assignment lifecycle, concurrency,
// republishing, history, school isolation and the database constraints. buildApp() + app.inject(), real database (disposable local one only).
//   source <guard>/local_test_env.sh && npx tsx test-substitution-api.ts
import 'dotenv/config';
import './test-fixtures/test-security-env.js';
import { randomUUID } from 'node:crypto';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { registerGenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner-handle.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { eachDate, weekdayOf } from './src/modules/substitution/substitution.core.js';
import { captureLogger, createWorld, destroyWorld, fastConfig, prisma, rawPrisma, ScriptedSolver, seedYear, solution, waitTerminal, type World } from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const PASSWORD = 'Subst#Test-Pass-2030';
const UUID0 = '00000000-0000-4000-8000-000000000000';

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\w*\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not a local *_test database');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('SUBST');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('SUBST');
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
  const codeOf = (r: Reply): string | undefined => r.body.errors?.code?.[0];

  try {
    const tokA = await sessionFor(worldA);
    const tokB = await sessionFor(worldB);
    // a second admin of school A, to prove "who did it" is recorded per admin
    const admin2 = await prisma.admin.create({ data: { schoolId: worldA.schoolId, name: 'Second Admin', email: `second-${Date.now()}@test.local`, passwordHash: 'x' } });
    await prisma.admin.update({ where: { id: admin2.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
    const tokA2 = (await adminService.loginAdmin({ schoolId: worldA.schoolId, email: admin2.email, password: PASSWORD })).sessionToken;

    // ===========================================================================================================
    // World A: a published timetable built directly, so every lesson is known
    // ===========================================================================================================
    const school = worldA.schoolId;
    let monday = '2030-03-01';
    while (weekdayOf(monday) !== 'MONDAY') monday = eachDate(monday, '2030-03-10')[1]!;
    const [d1, d2, d3, d4] = eachDate(monday, '2030-03-20').slice(0, 4) as [string, string, string, string]; // Mon, Tue, Wed, Thu
    const sunday = eachDate(monday, '2030-03-20')[6]!;
    const year = await prisma.academicYear.create({ data: { schoolId: school, name: 'SUBST-A', startDate: new Date('2030-01-01'), endDate: new Date('2030-12-31'), status: 'ACTIVE' } });
    const g8 = await prisma.grade.create({ data: { academicYearId: year.id, name: 'G8', displayOrder: 1 } });
    const sec = async (name: string) => (await prisma.section.create({ data: { gradeId: g8.id, name, code: name } })).id;
    const [sec1, sec2, sec3] = [await sec('S1'), await sec('S2'), await sec('S3')] as [string, string, string];
    const subj = async (code: string) => (await prisma.subject.create({ data: { schoolId: school, name: code, code } })).id;
    const [MATH, SCI, ENG] = [await subj('MATH'), await subj('SCI'), await subj('ENG')] as [string, string, string];
    const teacher = async (name: string, isActive = true) => (await prisma.teacher.create({ data: { schoolId: school, name, isActive } })).id;
    const link = async (teacherId: string, subjectId: string, gradeScope: 'ALL_GRADES' | 'SELECTED_GRADES', withRow = false) => {
      const l = await prisma.teacherSubject.create({ data: { teacherId, subjectId, type: 'PRIMARY', gradeScope } });
      if (withRow) await prisma.teacherSubjectGrade.create({ data: { teacherSubjectId: l.id, gradeId: g8.id } });
    };
    const A = await teacher('A absent');
    const B = await teacher('B all-grades');
    const C = await teacher('C selected-with-row');
    const D = await teacher('D selected-no-row');
    const E = await teacher('E science-only');
    const F = await teacher('F inactive', false);
    const G = await teacher('G teaching');
    const H = await teacher('H unavailable');
    const I = await teacher('I absent too');
    const J = await teacher('J spare');
    const K = await teacher('K second absent');
    await link(A, MATH, 'ALL_GRADES'); await link(A, SCI, 'ALL_GRADES');
    for (const t of [B, F, G, H, I, J, K]) await link(t, MATH, 'ALL_GRADES');
    await link(C, MATH, 'SELECTED_GRADES', true);
    await link(D, MATH, 'SELECTED_GRADES', false);
    await link(E, SCI, 'ALL_GRADES');

    const mkVersion = async (status: 'PUBLISHED' | 'DRAFT' | 'ARCHIVED', n: number) => prisma.timetableVersion.create({
      data: { schoolId: school, academicYearId: year.id, versionNumber: n, status, solutionSource: 'CP_SAT', solverStatus: 'OPTIMAL', weightsVersion: 'V1', inputHash: `h${n}`, inputSnapshot: {}, metrics: {}, baselineMetrics: {},
        ...(status !== 'DRAFT' ? { publishedAt: new Date() } : {}), ...(status === 'ARCHIVED' ? { archivedAt: new Date() } : {}) },
    });
    const lesson = (versionId: string, teacherId: string, sectionId: string, subjectId: string, day: string, period: number) => ({ versionId, teacherId, sectionId, subjectId, subjectRequirementId: randomUUID(), dayOfWeek: day as never, periodNumber: period });
    const v1 = await mkVersion('PUBLISHED', 1);
    await prisma.timetableEntry.createMany({ data: [
      lesson(v1.id, A, sec1, MATH, 'MONDAY', 1),   // L1
      lesson(v1.id, A, sec1, MATH, 'MONDAY', 2),   // L2
      lesson(v1.id, A, sec2, SCI, 'MONDAY', 3),    // L3
      lesson(v1.id, A, sec1, MATH, 'TUESDAY', 1),  // L4
      lesson(v1.id, A, sec1, ENG, 'TUESDAY', 2),   // L5 (nobody is qualified for ENG)
      lesson(v1.id, G, sec2, MATH, 'MONDAY', 1),   // G teaches in Mon period 1
      lesson(v1.id, K, sec3, MATH, 'MONDAY', 1),   // K's lesson (Mon p1)
    ] });
    const draft = await mkVersion('DRAFT', 2);
    await prisma.timetableEntry.createMany({ data: [lesson(draft.id, B, sec3, MATH, 'WEDNESDAY', 1)] }); // a DRAFT lesson of B: must never be used

    const post = (url: string, body: unknown, tok = tokA) => call('POST', url, tok, body);
    const covers = async (query = '', tok = tokA) => (await call('GET', `/api/substitutions${query}`, tok)).body.data as { total: number; items: any[] };
    const find = (items: any[], dateS: string, period: number, sectionId: string) => items.find((c) => c.date === dateS && c.periodNumber === period && c.section.id === sectionId);

    // ===========================================================================================================
    section('1. Authentication on every route');
    const probes: Array<[string, string, unknown?]> = [
      ['POST', '/api/teacher-absences', { teacherId: UUID0, startDate: '2030-03-04', endDate: '2030-03-04' }], ['GET', '/api/teacher-absences'], ['GET', `/api/teacher-absences/${UUID0}`], ['PATCH', `/api/teacher-absences/${UUID0}`, { reason: 'x' }], ['POST', `/api/teacher-absences/${UUID0}/cancel`, {}],
      ['POST', '/api/teacher-unavailability', { teacherId: UUID0, date: '2030-03-04' }], ['GET', '/api/teacher-unavailability'], ['DELETE', `/api/teacher-unavailability/${UUID0}`],
      ['GET', '/api/substitutions'], ['GET', `/api/substitutions/${UUID0}`], ['GET', `/api/substitutions/${UUID0}/candidates`], ['PUT', `/api/substitutions/${UUID0}/assignment`, { teacherId: UUID0 }], ['DELETE', `/api/substitutions/${UUID0}/assignment`], ['POST', `/api/substitutions/${UUID0}/cancel`, {}],
    ];
    const unauth = await Promise.all(probes.map(([m, u, b]) => call(m as 'GET', u, null, b)));
    check('all 14 routes answer 401 without a session', unauth.every((r) => r.status === 401), unauth.map((r) => r.status).join());

    // ===========================================================================================================
    section('2. Absence validation');
    const abs = (body: unknown, tok = tokA) => post('/api/teacher-absences', { autoAssign: false, ...(body as object) }, tok); // these tests exercise the MANUAL lifecycle
    const base = { teacherId: A, startDate: d1, endDate: d2 };
    for (const [name, body] of [
      ['end before start', { ...base, endDate: eachDate('2030-03-01', monday)[0] }], ['impossible date', { ...base, startDate: '2030-02-30' }], ['wrong format', { ...base, startDate: '04/03/2030' }],
      ['longer than 366 days', { ...base, startDate: '2030-01-01', endDate: '2031-01-05' }], ['FULL_DAY with periods', { ...base, scope: 'FULL_DAY', fromPeriod: 1, toPeriod: 2 }],
      ['PERIODS without periods', { ...base, scope: 'PERIODS' }], ['periods reversed', { ...base, scope: 'PERIODS', fromPeriod: 3, toPeriod: 2 }], ['period 13', { ...base, scope: 'PERIODS', fromPeriod: 1, toPeriod: 13 }],
      ['teacher not a uuid', { ...base, teacherId: 'x' }], ['missing dates', { teacherId: A }],
    ] as Array<[string, unknown]>) {
      const r = await abs(body);
      check(`${name} → 400`, r.status === 400, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    }
    check('unknown teacher → 404', (await abs({ ...base, teacherId: UUID0 })).status === 404);
    const foreignTeacher = (await prisma.teacher.create({ data: { schoolId: worldB.schoolId, name: 'Foreign' } })).id;
    check('another school\'s teacher → 403', (await abs({ ...base, teacherId: foreignTeacher })).status === 403);
    check('nothing was created by the rejected requests', (await prisma.teacherAbsence.count({ where: { schoolId: school } })) === 0);

    // ===========================================================================================================
    section('3. Absence recorded: lessons of the PUBLISHED timetable need cover');
    const a1 = await abs({ teacherId: A, startDate: d1, endDate: d2, reason: '  flu ' });
    check('absence Mon-Tue recorded (201), reason trimmed, status ACTIVE, creator recorded', a1.status === 201 && a1.body.data.absence.status === 'ACTIVE' && a1.body.data.absence.reason === 'flu' && a1.body.data.absence.createdById === worldA.adminId, JSON.stringify(a1.body).slice(0, 200));
    check('  5 lessons need cover (Mon: 3, Tue: 2)', a1.body.data.coverRequestsCreated === 5, String(a1.body.data.coverRequestsCreated));
    const absenceA = a1.body.data.absence.id as string;
    const list1 = await covers(`?absenceId=${absenceA}`);
    check('  listed as OPEN, from the PUBLISHED version 1, with section/subject/period/date', list1.total === 5 && list1.items.every((c) => c.status === 'OPEN' && c.timetableVersion.status === 'PUBLISHED' && c.timetableVersion.versionNumber === 1 && c.absentTeacher.id === A && c.replacementTeacher === null));
    const L1 = find(list1.items, d1, 1, sec1); const L2 = find(list1.items, d1, 2, sec1); const L3 = find(list1.items, d1, 3, sec2); const L4 = find(list1.items, d2, 1, sec1); const L5 = find(list1.items, d2, 2, sec1);
    check('  each lesson is identified by date + period + section + subject', !!L1 && !!L2 && !!L3 && !!L4 && !!L5 && L1.subject.code === 'MATH' && L3.subject.code === 'SCI' && L5.subject.code === 'ENG' && L1.dayOfWeek === 'MONDAY' && L4.dayOfWeek === 'TUESDAY');
    check('  a DRAFT timetable is never a source: no cover for the draft lesson on Wednesday', list1.items.every((c) => c.timetableVersion.id === v1.id));
    const aWed = await abs({ teacherId: B, startDate: d3, endDate: d3 });
    check('  an absence on a day where the teacher only has a DRAFT lesson creates nothing', aWed.status === 201 && aWed.body.data.coverRequestsCreated === 0);
    await call('POST', `/api/teacher-absences/${aWed.body.data.absence.id}/cancel`, tokA);
    const aNoYear = await abs({ teacherId: A, startDate: '2031-03-04', endDate: '2031-03-05' });
    check('  an absence outside every academic year is recorded but needs no cover (and says so)', aNoYear.status === 201 && aNoYear.body.data.coverRequestsCreated === 0 && aNoYear.body.data.datesWithoutPublishedTimetable === 2);
    await call('POST', `/api/teacher-absences/${aNoYear.body.data.absence.id}/cancel`, tokA);
    const aWeekend = await abs({ teacherId: A, startDate: eachDate(monday, '2030-03-20')[5]!, endDate: sunday });
    check('  a weekend with no lessons creates nothing', aWeekend.status === 201 && aWeekend.body.data.coverRequestsCreated === 0);
    await call('POST', `/api/teacher-absences/${aWeekend.body.data.absence.id}/cancel`, tokA);

    section('3b. Contradictory absences');
    const ovl = await abs({ teacherId: A, startDate: d2, endDate: d3 });
    check('overlapping dates (full day) → 409 ABSENCE_OVERLAP naming the other absence', ovl.status === 409 && codeOf(ovl) === 'ABSENCE_OVERLAP' && ovl.body.errors.absenceId[0] === absenceA, JSON.stringify(ovl.body));
    const okAfter = await abs({ teacherId: A, startDate: d3, endDate: d4, scope: 'PERIODS', fromPeriod: 4, toPeriod: 5 });
    check('a later non-overlapping absence is fine (201)', okAfter.status === 201);
    const ovlPeriods = await abs({ teacherId: A, startDate: d3, endDate: d3, scope: 'PERIODS', fromPeriod: 5, toPeriod: 6 });
    const noOvlPeriods = await abs({ teacherId: A, startDate: d3, endDate: d3, scope: 'PERIODS', fromPeriod: 6, toPeriod: 7 });
    check('same day: overlapping periods → 409, disjoint periods → 201', ovlPeriods.status === 409 && noOvlPeriods.status === 201);
    for (const id of [okAfter.body.data.absence.id, noOvlPeriods.body.data.absence.id]) await call('POST', `/api/teacher-absences/${id}/cancel`, tokA);
    const race = await Promise.all([1, 2, 3, 4, 5].map(() => abs({ teacherId: K, startDate: d1, endDate: d1 })));
    check('5 simultaneous identical absences: exactly one 201, the rest 409, no duplicate cover', race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409).length === 4 && (await prisma.coverRequest.count({ where: { absentTeacherId: K, status: 'OPEN' } })) === 1, race.map((r) => r.status).join());
    const absenceK = race.find((r) => r.status === 201)!.body.data.absence.id as string;
    const inactiveAbs = await abs({ teacherId: F, startDate: d1, endDate: d1 });
    check('an INACTIVE teacher can be recorded absent, but is not absent by default', inactiveAbs.status === 201 && inactiveAbs.body.data.coverRequestsCreated === 0);
    await call('POST', `/api/teacher-absences/${inactiveAbs.body.data.absence.id}/cancel`, tokA);

    // ===========================================================================================================
    section('4. Replacement candidates (a temporary cover needs availability only; subject teachers are preferred)');
    const names = async (id: string, tok = tokA) => ((await call('GET', `/api/substitutions/${id}/candidates`, tok)).body.data.candidates as Array<{ name: string }>).map((c) => c.name[0]).sort().join('');
    const c1 = await call('GET', `/api/substitutions/${L1.id}/candidates?includeExcluded=true`, tokA);
    const reasonOf = (letter: string) => c1.body.data.excluded.find((x: any) => x.teacher.name.startsWith(letter))?.reason;
    check('Monday p1 MATH (grade 8): every free active teacher is a candidate: B, C, D, E, H, I, J (qualification and grade eligibility are not required)', (c1.body.data.candidates as any[]).map((c) => c.name[0]).sort().join('') === 'BCDEHIJ', JSON.stringify(c1.body.data.candidates.map((c: any) => c.name)));
    check('  D (SELECTED_GRADES, no eligibility row) is a candidate: no grade eligibility is needed for a temporary cover, and none is created', reasonOf('D') === undefined && (c1.body.data.candidates as any[]).some((c) => c.name.startsWith('D')));
    check('  E (teaches only science) is a candidate too, as an OTHER teacher (tier 2); F (inactive): INACTIVE; A: IS_ABSENT_TEACHER', reasonOf('E') === undefined && (c1.body.data.candidates as any[]).find((c) => c.name.startsWith('E')).tier === 2 && reasonOf('F') === 'INACTIVE' && reasonOf('A') === 'IS_ABSENT_TEACHER');
    check('  G (has a Monday p1 lesson in the published timetable): TEACHING_ANOTHER_LESSON; K (absent that day AND teaching): ABSENT, the first failing rule', reasonOf('G') === 'TEACHING_ANOTHER_LESSON' && reasonOf('K') === 'ABSENT');
    const aI = await abs({ teacherId: I, startDate: d1, endDate: d1 });
    const unH = await post('/api/teacher-unavailability', { teacherId: H, date: d1, periodNumber: 1, reason: 'training' });
    check('I is recorded absent on Monday, H unavailable for Monday p1', aI.status === 201 && unH.status === 201 && unH.body.data.wholeDay === false);
    const c1b = await call('GET', `/api/substitutions/${L1.id}/candidates?includeExcluded=true`, tokA);
    const reasonB = (letter: string) => c1b.body.data.excluded.find((x: any) => x.teacher.name.startsWith(letter))?.reason;
    check('  now I is ABSENT and H is UNAVAILABLE; the valid candidates are B, C, D, E, J', reasonB('I') === 'ABSENT' && reasonB('H') === 'UNAVAILABLE' && (c1b.body.data.candidates as any[]).map((c) => c.name[0]).sort().join('') === 'BCDEJ');
    check('  Monday p2 (G teaches only in p1, H is unavailable only for p1, I is absent all day): G and H are candidates for p2, I is not', (await names(L2.id)) === 'BCDEGHJ');
    const wholeDay = await post('/api/teacher-unavailability', { teacherId: J, date: d1 });
    check('  a WHOLE-DAY unavailability removes J from every period of that day', wholeDay.status === 201 && wholeDay.body.data.wholeDay === true && (await names(L2.id)) === 'BCDEGH');
    await call('DELETE', `/api/teacher-unavailability/${wholeDay.body.data.id}`, tokA);
    check('  removing the unavailability (soft) brings J back', (await names(L2.id)) === 'BCDEGHJ');
    const c5 = await call('GET', `/api/substitutions/${L5.id}/candidates`, tokA);
    check('ENG lesson: nobody teaches ENG, yet every free teacher is still offered (tier 2): nobody is excluded for lacking a subject link', c5.status === 200 && c5.body.data.candidates.length > 0 && c5.body.data.candidates.every((c: any) => c.tier === 2 && c.sameSubject === false) && c5.body.data.selection.sameSubjectAvailable === false && !c5.body.data.message, JSON.stringify(c5.body.data.selection));
    const c3x = (await call('GET', `/api/substitutions/${L3.id}/candidates`, tokA)).body.data;
    check('SCI lesson: E (the science teacher) is tier 1 and listed first; the free MATH teachers follow as tier 2', c3x.candidates[0].name.startsWith('E') && c3x.candidates[0].tier === 1 && c3x.candidates.slice(1).every((c: any) => c.tier === 2) && (await names(L3.id)) === 'BCDEGHJ');

    // ===========================================================================================================
    section('5. Assignment: availability is enforced (no qualification is needed)');
    const put = (id: string, teacherId: string, tok = tokA) => call('PUT', `/api/substitutions/${id}/assignment`, tok, { teacherId });
    const reject = async (name: string, teacherId: string, status: number, code: string) => {
      const r = await put(L1.id, teacherId);
      check(`${name} → ${status} ${code}`, r.status === status && codeOf(r) === code, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    };
    await reject('inactive teacher', F, 400, 'INACTIVE');
    await reject('the absent teacher', A, 400, 'IS_ABSENT_TEACHER');
    await reject('teacher with a lesson in that period', G, 409, 'TEACHING_ANOTHER_LESSON');
    await reject('teacher marked unavailable', H, 409, 'UNAVAILABLE');
    await reject('teacher absent that day', I, 409, 'ABSENT');
    check('teacher of another school → 403', (await put(L1.id, foreignTeacher)).status === 403);
    check('unknown teacher → 404, teacher id not a uuid → 400', (await put(L1.id, UUID0)).status === 404 && (await call('PUT', `/api/substitutions/${L1.id}/assignment`, tokA, { teacherId: 'x' })).status === 400);
    check('unknown cover request → 404', (await put(UUID0, B)).status === 404);
    check('none of the rejected attempts changed the request', (await prisma.coverRequest.findUniqueOrThrow({ where: { id: L1.id } })).status === 'OPEN');

    section('5b. Assign, reassign, unassign, cancel, history');
    const asB = await put(L1.id, B);
    check('B (ALL_GRADES) assigned → ASSIGNED, replacement B, assigner and time recorded', asB.status === 200 && asB.body.data.status === 'ASSIGNED' && asB.body.data.replacementTeacher.id === B && asB.body.data.assignedById === worldA.adminId && !!asB.body.data.assignedAt, JSON.stringify(asB.body).slice(0, 200));
    const again = await put(L1.id, B);
    check('assigning the same teacher again is a no-op (200, no extra history)', again.status === 200 && (await prisma.coverEvent.count({ where: { coverRequestId: L1.id, action: { in: ['ASSIGNED', 'REASSIGNED'] } } })) === 1);
    const re = await put(L1.id, C, tokA2);
    check('reassigned to C (SELECTED_GRADES with a row) by the SECOND admin → REASSIGNED', re.status === 200 && re.body.data.replacementTeacher.id === C && re.body.data.assignedById === admin2.id);
    const bFree = await call('GET', `/api/substitutions/${L1.id}/candidates`, tokA);
    check('  B is free again; C (now covering this lesson) is not a candidate for ANOTHER lesson in that period', (bFree.body.data.candidates as any[]).some((c) => c.name.startsWith('B')) && true);
    const L6 = find((await covers(`?absenceId=${absenceK}`)).items, d1, 1, sec3);
    const c6 = await call('GET', `/api/substitutions/${L6.id}/candidates?includeExcluded=true`, tokA);
    check('  K\'s Monday p1 lesson: C is ALREADY_COVERING, B is valid', c6.body.data.excluded.find((x: any) => x.teacher.name.startsWith('C'))?.reason === 'ALREADY_COVERING' && (c6.body.data.candidates as any[]).some((c) => c.name.startsWith('B')));
    const dupBook = await put(L6.id, C);
    check('  assigning C there is refused: 409 ALREADY_COVERING', dupBook.status === 409 && codeOf(dupBook) === 'ALREADY_COVERING');
    const unas = await call('DELETE', `/api/substitutions/${L1.id}/assignment`, tokA);
    check('unassign: ASSIGNED → OPEN, replacement removed', unas.status === 200 && unas.body.data.status === 'OPEN' && unas.body.data.replacementTeacher === null && unas.body.data.assignedById === null);
    check('unassigning an OPEN request → 409 NOT_ASSIGNED', codeOf(await call('DELETE', `/api/substitutions/${L1.id}/assignment`, tokA)) === 'NOT_ASSIGNED');
    await put(L1.id, B);
    const cancelled = await post(`/api/substitutions/${L1.id}/cancel`, { reason: 'lesson dropped' }, tokA2);
    check('cancel an ASSIGNED request → CANCELLED (reason, who and when kept)', cancelled.status === 200 && cancelled.body.data.status === 'CANCELLED' && cancelled.body.data.cancelReason === 'lesson dropped' && cancelled.body.data.cancelledById === admin2.id && !!cancelled.body.data.cancelledAt);
    check('  a cancelled request cannot be assigned, unassigned or cancelled again (409 COVER_CANCELLED)', codeOf(await put(L1.id, B)) === 'COVER_CANCELLED' && codeOf(await call('DELETE', `/api/substitutions/${L1.id}/assignment`, tokA)) === 'COVER_CANCELLED' && codeOf(await post(`/api/substitutions/${L1.id}/cancel`, {})) === 'COVER_CANCELLED');
    check('  its candidates cannot be listed either (409)', (await call('GET', `/api/substitutions/${L1.id}/candidates`, tokA)).status === 409);
    const hist = (await call('GET', `/api/substitutions/${L1.id}`, tokA)).body.data;
    const trail = hist.history.map((h: any) => `${h.action}:${h.fromStatus ?? '-'}>${h.toStatus}`).join(' | ');
    check('history: CREATED, ASSIGNED, REASSIGNED, UNASSIGNED, ASSIGNED, CANCELLED in order, with statuses', trail === 'CREATED:->OPEN | ASSIGNED:OPEN>ASSIGNED | REASSIGNED:ASSIGNED>ASSIGNED | UNASSIGNED:ASSIGNED>OPEN | ASSIGNED:OPEN>ASSIGNED | CANCELLED:ASSIGNED>CANCELLED', trail);
    const re2 = hist.history[2];
    check('  the REASSIGNED event names who (second admin), from B to C, and when', re2.actor.id === admin2.id && re2.actor.name === 'Second Admin' && re2.fromTeacher.name === 'B all-grades' && re2.toTeacher.name === 'C selected-with-row' && !!re2.createdAt);
    check('  creation by recording the absence is attributed to the admin who recorded it', hist.history[0].actor?.id === worldA.adminId);
    check('  the request still shows the absent teacher, lesson, version and last replacement history', hist.absentTeacher.id === A && hist.section.id === sec1 && hist.timetableVersion.versionNumber === 1);

    // ===========================================================================================================
    section('6. Concurrency');
    const L2b = L2; // Monday p2, MATH, sec1 (absent A)
    const [x, y] = await Promise.all([put(L6.id, B), put(L2b.id, B)]);
    // L6 is Monday p1 and L2 is Monday p2: different periods, both fine; use two covers in the SAME period instead:
    check('(setup) B can cover two lessons in DIFFERENT periods', x.status === 200 && y.status === 200);
    await call('DELETE', `/api/substitutions/${L6.id}/assignment`, tokA);
    await call('DELETE', `/api/substitutions/${L2b.id}/assignment`, tokA);
    const L1new = (await covers(`?absenceId=${absenceA}&status=OPEN`)).items.find((c: any) => c.date === d1 && c.periodNumber === 1 && c.section.id === sec1);
    check('(setup) L1 was cancelled; the lessons in Monday p1 that still need cover: only K\'s', L1new === undefined);
    // two lessons in one period: K's (sec3) and a fresh one for J in sec2? use A's cover for a different absence is not possible, so create one more absent teacher
    const M = await teacher('M absent third');
    await link(M, MATH, 'ALL_GRADES');
    await prisma.timetableEntry.create({ data: lesson(v1.id, M, sec1, MATH, 'MONDAY', 4) });
    await prisma.timetableEntry.create({ data: lesson(v1.id, A, sec2, MATH, 'MONDAY', 4) });
    const aM = await abs({ teacherId: M, startDate: d1, endDate: d1 });
    const aA2 = await abs({ teacherId: A, startDate: d1, endDate: d1, scope: 'PERIODS', fromPeriod: 4, toPeriod: 4 });
    check('(setup) two lessons in Monday period 4 need cover (M\'s and A\'s)', aM.body.data.coverRequestsCreated === 1 && aA2.status === 409);
    // A's first absence already covers Mon; the A lesson at p4 was added AFTER it was created: reconcile through list
    const p4 = (await covers(`?status=OPEN&from=${d1}&to=${d1}`)).items.filter((c: any) => c.periodNumber === 4);
    check('(setup) a later sync adds A\'s new Monday p4 lesson to the existing absence: 2 requests in period 4', p4.length === 2, JSON.stringify(p4.map((c: any) => c.absentTeacher.name)));
    const ts4 = new Date(`${d1}T00:00:00.000Z`);
    const [r1, r2] = await Promise.all([put(p4[0].id, B), put(p4[1].id, B)]);
    check('the SAME teacher assigned to two lessons of one period simultaneously: exactly one 200, the other 409', [r1.status, r2.status].sort().join() === '200,409', `${r1.status},${r2.status} ${JSON.stringify(r1.body).slice(0, 80)}`);
    check('  the database holds exactly one ASSIGNED booking of B for that slot', (await prisma.coverRequest.count({ where: { replacementTeacherId: B, status: 'ASSIGNED', periodNumber: 4 } })) === 1);
    const [q1, q2] = await Promise.all([put(p4[0].id, J), put(p4[0].id, C)]);
    const finalRow = await prisma.coverRequest.findUniqueOrThrow({ where: { id: p4[0].id } });
    check('two simultaneous assignments of different teachers to ONE request both succeed in turn; the final state is a single consistent replacement', q1.status === 200 && q2.status === 200 && finalRow.status === 'ASSIGNED' && [J, C].includes(finalRow.replacementTeacherId!) && (await prisma.coverEvent.count({ where: { coverRequestId: p4[0].id, action: { in: ['ASSIGNED', 'REASSIGNED'] } } })) >= 2);
    const target = p4.find((c: any) => c.id !== p4[0].id)!;
    const [asn, una] = await Promise.all([put(target.id, H), post('/api/teacher-unavailability', { teacherId: H, date: d1, periodNumber: 4 })]);
    check('assigning H while H is simultaneously marked unavailable: exactly one wins, never both', (asn.status === 200) !== (una.status === 201) && [asn.status, una.status].every((s) => [200, 201, 409].includes(s)), `${asn.status},${una.status}`);
    const booked4 = await prisma.coverRequest.findFirstOrThrow({ where: { schoolId: school, status: 'ASSIGNED', periodNumber: 4, date: ts4 } });
    const absAssigned = await abs({ teacherId: booked4.replacementTeacherId, startDate: d1, endDate: d1, scope: 'PERIODS', fromPeriod: 4, toPeriod: 4 });
    check('a teacher already assigned to cover a lesson cannot be recorded absent for that slot: 409 TEACHER_IS_COVERING', absAssigned.status === 409 && codeOf(absAssigned) === 'TEACHER_IS_COVERING', JSON.stringify(absAssigned.body));
    const unavBusy = await post('/api/teacher-unavailability', { teacherId: booked4.replacementTeacherId, date: d1, periodNumber: 4 });
    check('  nor marked unavailable for it', unavBusy.status === 409 && codeOf(unavBusy) === 'TEACHER_IS_COVERING');

    // ===========================================================================================================
    section('7. Unavailability: validation, duplicates, removal');
    check('invalid period / date / missing teacher → 400', (await post('/api/teacher-unavailability', { teacherId: J, date: d1, periodNumber: 13 })).status === 400 && (await post('/api/teacher-unavailability', { teacherId: J, date: 'x' })).status === 400 && (await post('/api/teacher-unavailability', { date: d1 })).status === 400);
    check('unknown teacher → 404, another school\'s → 403', (await post('/api/teacher-unavailability', { teacherId: UUID0, date: d1 })).status === 404 && (await post('/api/teacher-unavailability', { teacherId: foreignTeacher, date: d1 })).status === 403);
    const u1 = await post('/api/teacher-unavailability', { teacherId: J, date: d2, periodNumber: 2 });
    check('duplicate (teacher, date, period) → 409', u1.status === 201 && (await post('/api/teacher-unavailability', { teacherId: J, date: d2, periodNumber: 2 })).status === 409);
    const lu = (await call('GET', `/api/teacher-unavailability?teacherId=${J}&from=${d2}&to=${d2}`, tokA)).body.data as any[];
    check('listing filters by teacher and dates', lu.length === 1 && lu[0].id === u1.body.data.id);
    const rm = await call('DELETE', `/api/teacher-unavailability/${u1.body.data.id}`, tokA2);
    check('removal is soft and records who: status CANCELLED', rm.status === 200 && rm.body.data.status === 'CANCELLED' && rm.body.data.cancelledById === admin2.id && (await call('DELETE', `/api/teacher-unavailability/${u1.body.data.id}`, tokA)).status === 409);
    check('  after removal the slot can be marked again', (await post('/api/teacher-unavailability', { teacherId: J, date: d2, periodNumber: 2 })).status === 201);

    // ===========================================================================================================
    section('8. Absence update and cancellation');
    const assignedOne = (await covers(`?absenceId=${absenceA}&status=OPEN`)).items.find((c: any) => c.date === d1 && c.periodNumber === 2);
    await put(assignedOne.id, B);
    const shrink = await call('PATCH', `/api/teacher-absences/${absenceA}`, tokA, { endDate: d1, scope: 'PERIODS', fromPeriod: 3, toPeriod: 3, autoAssign: false });
    check('shrinking so that an ASSIGNED substitution would fall outside → 409 ASSIGNED_COVERS_OUTSIDE, nothing changed', shrink.status === 409 && codeOf(shrink) === 'ASSIGNED_COVERS_OUTSIDE' && (await prisma.teacherAbsence.findUniqueOrThrow({ where: { id: absenceA } })).endDate.toISOString().slice(0, 10) === d2);
    const cancelAbsBlocked = await call('POST', `/api/teacher-absences/${absenceA}/cancel`, tokA);
    check('cancelling an absence with an ASSIGNED substitution → 409 ASSIGNED_COVERS_EXIST', cancelAbsBlocked.status === 409 && codeOf(cancelAbsBlocked) === 'ASSIGNED_COVERS_EXIST');
    await call('DELETE', `/api/substitutions/${assignedOne.id}/assignment`, tokA);
    for (const c of (await covers(`?absenceId=${absenceA}&status=ASSIGNED`)).items) await call('DELETE', `/api/substitutions/${c.id}/assignment`, tokA);
    const openBeforeShrink = (await covers(`?absenceId=${absenceA}&status=OPEN`)).total; // every lesson of the absence still needing cover (the explicitly cancelled one excluded)
    const shrink2 = await call('PATCH', `/api/teacher-absences/${absenceA}`, tokA, { endDate: d1, scope: 'PERIODS', fromPeriod: 3, toPeriod: 3, autoAssign: false });
    const afterShrink = await covers(`?absenceId=${absenceA}`);
    check('after unassigning: shrink to Monday p3 only → OPEN requests outside are CANCELLED, the lesson inside stays OPEN', shrink2.status === 200 && afterShrink.items.filter((c: any) => c.status === 'OPEN').length === 1 && afterShrink.items.find((c: any) => c.status === 'OPEN').periodNumber === 3 && shrink2.body.data.coverRequestsCancelled >= 2, JSON.stringify(shrink2.body).slice(0, 300));
    const grow = await call('PATCH', `/api/teacher-absences/${absenceA}`, tokA2, { endDate: d2, scope: 'FULL_DAY', autoAssign: false });
    const afterGrow = await covers(`?absenceId=${absenceA}&status=OPEN`);
    check('growing it back to the full two days REOPENS the lessons the shrink dropped (no duplicates)', grow.status === 200 && afterGrow.total === openBeforeShrink && openBeforeShrink >= 5 && new Set(afterGrow.items.map((c: any) => `${c.date}|${c.periodNumber}|${c.section.id}`)).size === openBeforeShrink && grow.body.data.coverRequestsReopened >= 2, JSON.stringify(grow.body).slice(0, 300));
    check('  the update is attributed to the second admin', (await prisma.teacherAbsence.findUniqueOrThrow({ where: { id: absenceA } })).updatedById === admin2.id);
    check('update validation: contradictory fields → 400; empty body → 400; a different teacher cannot be set', (await call('PATCH', `/api/teacher-absences/${absenceA}`, tokA, { scope: 'FULL_DAY', fromPeriod: 1, toPeriod: 2 })).status === 400 && (await call('PATCH', `/api/teacher-absences/${absenceA}`, tokA, {})).status === 400 && (await call('PATCH', `/api/teacher-absences/${absenceA}`, tokA, { endDate: '2030-01-01' })).status === 400);
    const olap = await call('PATCH', `/api/teacher-absences/${absenceK}`, tokA, { startDate: d1, endDate: d2 });
    check('update to an overlapping window of the SAME teacher is checked (K has no other absence: ok)', olap.status === 200);
    const cancelA = await call('POST', `/api/teacher-absences/${absenceA}/cancel`, tokA);
    const afterCancel = await covers(`?absenceId=${absenceA}`);
    check('cancelling the absence (no assignments) cancels every OPEN request; the absence stays as CANCELLED with who and when', cancelA.status === 200 && cancelA.body.data.absence.status === 'CANCELLED' && !!cancelA.body.data.absence.cancelledAt && cancelA.body.data.absence.cancelledById === worldA.adminId && afterCancel.items.every((c: any) => c.status === 'CANCELLED'), JSON.stringify(cancelA.body).slice(0, 300));
    check('  a cancelled absence cannot be changed or cancelled again (409)', (await call('PATCH', `/api/teacher-absences/${absenceA}`, tokA, { reason: 'x' })).status === 409 && (await call('POST', `/api/teacher-absences/${absenceA}/cancel`, tokA)).status === 409);
    check('  the cancelled absence no longer blocks a new one for the same dates', (await abs({ teacherId: A, startDate: d1, endDate: d1 })).status === 201);
    const la = (await call('GET', `/api/teacher-absences?teacherId=${A}&status=CANCELLED`, tokA)).body.data as any[];
    check('listing absences shows cover counts per status', la.some((a) => a.id === absenceA && a.covers.CANCELLED >= 4));
    check('get one absence', (await call('GET', `/api/teacher-absences/${absenceA}`, tokA)).body.data.id === absenceA);

    // ===========================================================================================================
    section('9. A new timetable version is published while substitutions exist');
    const aR = await abs({ teacherId: M, startDate: d4, endDate: d4 }); // Thursday: M has no lesson in v1
    check('(setup) M has no Thursday lesson in version 1', aR.status === 201 && aR.body.data.coverRequestsCreated === 0);
    await prisma.timetableEntry.create({ data: lesson(v1.id, M, sec2, MATH, 'THURSDAY', 1) });
    const openBefore = (await covers(`?absenceId=${aR.body.data.absence.id}`)).items;
    check('(setup) the sync adds M\'s Thursday lesson from version 1', openBefore.length === 1 && openBefore[0].timetableVersion.versionNumber === 1);
    const pending = openBefore[0];
    await put(pending.id, B);
    const assignedBefore = (await covers(`?absenceId=${aM.body.data.absence.id}`)).items[0];
    await put(assignedBefore.id, J);
    // version 2 is published: it ARCHIVES version 1 (what the publish service does, in one transaction); lessons moved
    await prisma.$transaction(async (tx) => {
      await tx.timetableVersion.update({ where: { id: v1.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
      await tx.timetableEntry.deleteMany({ where: { versionId: draft.id } });
      await tx.timetableVersion.update({ where: { id: draft.id }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
      await tx.timetableEntry.createMany({ data: [
        lesson(draft.id, M, sec2, MATH, 'THURSDAY', 2),  // M's Thursday lesson MOVED from p1 to p2
        lesson(draft.id, M, sec1, MATH, 'MONDAY', 4),    // M's Monday p4 lesson unchanged
      ] });
    });
    const afterPub = (await covers(`?from=${d1}`)).items;
    const oldThu = afterPub.find((c: any) => c.id === pending.id);
    const oldMon = afterPub.find((c: any) => c.id === assignedBefore.id);
    check('after publishing version 2: the pending (ASSIGNED) Thursday request from version 1 is OBSOLETE, history kept (replacement B still on record)', oldThu.status === 'OBSOLETE' && oldThu.replacementTeacher?.id === B && oldThu.timetableVersion.versionNumber === 1 && !!oldThu.obsoleteAt);
    const newThu = afterPub.find((c: any) => c.date === d4 && c.status === 'OPEN' && c.absentTeacher.id === M);
    check('  a NEW request exists from version 2 with the lesson\'s NEW period (2), OPEN: the obsolete lesson data is not applied silently', !!newThu && newThu.periodNumber === 2 && newThu.timetableVersion.versionNumber === 2 && newThu.supersedesId === pending.id && newThu.replacementTeacher === null);
    check('  M\'s Monday p4 request (ASSIGNED to J) is also obsolete and re-created OPEN from version 2 (the assignment is NOT carried over)', oldMon.status === 'OBSOLETE' && afterPub.some((c: any) => c.date === d1 && c.periodNumber === 4 && c.absentTeacher.id === M && c.status === 'OPEN' && c.timetableVersion.versionNumber === 2));
    const obsHist = (await call('GET', `/api/substitutions/${pending.id}`, tokA)).body.data.history.map((h: any) => `${h.action}:${h.fromStatus ?? '-'}>${h.toStatus}`);
    check('  the history of the obsolete request ends with OBSOLETED (system action)', obsHist[obsHist.length - 1] === 'OBSOLETED:ASSIGNED>OBSOLETE');
    check('  an obsolete request cannot be assigned, unassigned or cancelled (409 COVER_OBSOLETE)', codeOf(await put(pending.id, C)) === 'COVER_OBSOLETE' && codeOf(await call('DELETE', `/api/substitutions/${pending.id}/assignment`, tokA)) === 'COVER_OBSOLETE' && codeOf(await post(`/api/substitutions/${pending.id}/cancel`, {})) === 'COVER_OBSOLETE');
    check('  J (covering the obsolete Monday p4 request) is free again: the booking was released', (await prisma.coverRequest.count({ where: { replacementTeacherId: J, status: 'ASSIGNED', periodNumber: 4, date: new Date(`${d1}T00:00:00.000Z`) } })) === 0);
    const candNew = await call('GET', `/api/substitutions/${newThu.id}/candidates`, tokA);
    check('  candidates for the new request use version 2 (B is valid: his Thursday p1/p2 is free in version 2)', candNew.status === 200 && (candNew.body.data.candidates as any[]).some((c) => c.name.startsWith('B')));
    const stale = await put(newThu.id, B);
    check('  and the new request can be assigned normally', stale.status === 200 && stale.body.data.status === 'ASSIGNED');
    check('past-dated requests are left alone by obsolescence (history of lessons that already happened)', (await prisma.coverRequest.count({ where: { schoolId: school, status: 'OBSOLETE', date: { lt: new Date(`${d1}T00:00:00.000Z`) } } })) === 0);

    // ===========================================================================================================
    section('10. School isolation');
    const someCover = newThu.id as string;
    const iso = await Promise.all([
      call('GET', `/api/teacher-absences/${absenceK}`, tokB), call('PATCH', `/api/teacher-absences/${absenceK}`, tokB, { reason: 'x' }), call('POST', `/api/teacher-absences/${absenceK}/cancel`, tokB),
      call('GET', `/api/substitutions/${someCover}`, tokB), call('GET', `/api/substitutions/${someCover}/candidates`, tokB), call('PUT', `/api/substitutions/${someCover}/assignment`, tokB, { teacherId: foreignTeacher }),
      call('DELETE', `/api/substitutions/${someCover}/assignment`, tokB), call('POST', `/api/substitutions/${someCover}/cancel`, tokB, {}), call('DELETE', `/api/teacher-unavailability/${u1.body.data.id}`, tokB),
    ]);
    check('another school\'s admin gets 403 on every operation on school A\'s records', iso.every((r) => r.status === 403), iso.map((r) => r.status).join());
    check('  and cannot see them in lists (school B has none)', (await covers('', tokB)).total === 0 && ((await call('GET', '/api/teacher-absences', tokB)).body.data as any[]).length === 0 && ((await call('GET', '/api/teacher-unavailability', tokB)).body.data as any[]).length === 0);
    check('  filtering by a teacher of school A as school B → 403', (await call('GET', `/api/teacher-absences?teacherId=${A}`, tokB)).status === 403);
    const aB = await abs({ teacherId: foreignTeacher, startDate: d1, endDate: d1 }, tokB);
    check('  school B can record its own absence; it never produces cover from school A\'s timetable', aB.status === 201 && aB.body.data.coverRequestsCreated === 0 && (await covers('', tokB)).total === 0);
    check('  school A\'s records are untouched by all of this', (await prisma.teacherAbsence.findUniqueOrThrow({ where: { id: absenceK } })).status === 'ACTIVE');

    // ===========================================================================================================
    section('11. Database constraints (the rules hold even for direct writes)');
    const raw = async (fn: () => Promise<unknown>) => { try { await fn(); return 'ok'; } catch (e) { return String((e as Error).message).slice(0, 400); } };
    const ts = new Date(`${d1}T00:00:00.000Z`);
    const mk = (over: object) => ({ schoolId: school, absenceId: absenceK, timetableVersionId: draft.id, date: ts, dayOfWeek: 'MONDAY' as const, periodNumber: 9, sectionId: sec3, subjectId: MATH, absentTeacherId: K, status: 'OPEN' as const, ...over });
    check('end date before start date is rejected by the database', /check|constraint/i.test(await raw(() => prisma.teacherAbsence.create({ data: { schoolId: school, teacherId: K, startDate: new Date('2030-03-05'), endDate: new Date('2030-03-04'), scope: 'FULL_DAY' } }))));
    check('an absence longer than 366 days is rejected by the database', /check|constraint/i.test(await raw(() => prisma.teacherAbsence.create({ data: { schoolId: school, teacherId: K, startDate: new Date('2030-01-01'), endDate: new Date('2031-06-01'), scope: 'FULL_DAY' } }))));
    check('FULL_DAY with periods / PERIODS without periods are rejected by the database', /check|constraint/i.test(await raw(() => prisma.teacherAbsence.create({ data: { schoolId: school, teacherId: K, startDate: ts, endDate: ts, scope: 'FULL_DAY', fromPeriod: 1, toPeriod: 2 } }))) && /check|constraint/i.test(await raw(() => prisma.teacherAbsence.create({ data: { schoolId: school, teacherId: K, startDate: ts, endDate: ts, scope: 'PERIODS' } }))));
    check('an OPEN request with a replacement, an ASSIGNED one without, and the absent teacher as replacement are all rejected', /check|constraint/i.test(await raw(() => prisma.coverRequest.create({ data: mk({ replacementTeacherId: B }) }))) && /check|constraint/i.test(await raw(() => prisma.coverRequest.create({ data: mk({ status: 'ASSIGNED' }) }))) && /check|constraint/i.test(await raw(() => prisma.coverRequest.create({ data: mk({ status: 'ASSIGNED', replacementTeacherId: K }) }))));
    const live = await prisma.coverRequest.findFirstOrThrow({ where: { schoolId: school, status: 'ASSIGNED' } });
    check('a second LIVE request for the same lesson and date is rejected by the unique index', /unique/i.test(await raw(() => prisma.coverRequest.create({ data: mk({ absenceId: live.absenceId, sectionId: live.sectionId, date: live.date, periodNumber: live.periodNumber, timetableVersionId: live.timetableVersionId, absentTeacherId: live.absentTeacherId }) }))));
    const booked = await prisma.coverRequest.findFirstOrThrow({ where: { schoolId: school, status: 'ASSIGNED', NOT: { id: live.id } } }).catch(() => null);
    check('a replacement cannot hold two ASSIGNED requests for one date and period (unique index)', /unique/i.test(await raw(() => prisma.coverRequest.create({ data: mk({ status: 'ASSIGNED', replacementTeacherId: live.replacementTeacherId, date: live.date, periodNumber: live.periodNumber, sectionId: sec3 }) }))) || booked === null);
    check('unavailability: a period outside 1..12 and a duplicate whole-day record are rejected', /check|constraint/i.test(await raw(() => prisma.teacherUnavailability.create({ data: { schoolId: school, teacherId: J, date: ts, periodNumber: 0 } }))) && /unique/i.test(await raw(async () => { await prisma.teacherUnavailability.create({ data: { schoolId: school, teacherId: J, date: ts } }); await prisma.teacherUnavailability.create({ data: { schoolId: school, teacherId: J, date: ts } }); })));

    // ===========================================================================================================
    section('12. REAL publish through the API: a second version replaces the first while substitutions exist');
    const { logger } = captureLogger();
    registerGenerationRunner({ trigger: () => runner.trigger() });
    const runner = new GenerationRunner({ prisma: rawPrisma, solverClient: new ScriptedSolver((ctx) => solution(ctx.problem)), config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: 30 }, logger });
    runners.push(runner);
    runner.start();
    const ry = await seedYear(worldA, 'subst-real');
    await prisma.academicYear.update({ where: { id: ry.yearId }, data: { startDate: new Date('2032-01-01'), endDate: new Date('2032-12-31') } });
    const generate = async (): Promise<string> => {
      const r = await post('/api/timetable-generations', { academicYearId: ry.yearId });
      if (r.status !== 202) throw new Error(`generation rejected: ${JSON.stringify(r.body).slice(0, 200)}`);
      const run = await waitTerminal(r.body.data.generationRunId, 90_000);
      if (run.status !== 'SUCCEEDED') throw new Error(`generation failed: ${run.failureCode}`);
      return run.versionId!;
    };
    const publish = (v: string, published: string | null) => post(`/api/timetable-versions/${v}/publish`, { expectedRevision: 1, expectedPublishedVersionId: published });
    const real1 = await generate();
    const p1 = await publish(real1, null);
    check('version 1 published through the API', p1.status === 200, JSON.stringify(p1.body).slice(0, 160));
    let m2032 = '2032-03-01';
    while (weekdayOf(m2032) !== 'MONDAY') m2032 = eachDate(m2032, '2032-03-20')[1]!;
    const week = eachDate(m2032, '2032-03-20').slice(0, 5);
    const absReal = await abs({ teacherId: ry.teacherIds[0], startDate: week[0], endDate: week[4] });
    const lessonsPerWeek = ry.subjectPeriods[0]! * ry.sectionIds.length;
    check('the teacher of subject 0 is absent for a school week: their published lessons need cover', absReal.status === 201 && absReal.body.data.coverRequestsCreated === lessonsPerWeek, `${absReal.body.data.coverRequestsCreated} vs ${lessonsPerWeek}`);
    const realCovers = (await covers(`?absenceId=${absReal.body.data.absence.id}`)).items;
    const eligibleSpare = ry.spareTeacherId;
    const candidatesReal = await call('GET', `/api/substitutions/${realCovers[0].id}/candidates`, tokA);
    check('the seeded spare teacher (eligible for subject 0 and grade) is a valid candidate', (candidatesReal.body.data.candidates as any[]).some((c) => c.id === eligibleSpare));
    const asReal = await put(realCovers[0].id, eligibleSpare);
    check('assigned', asReal.status === 200);
    const real2 = await generate();
    const p2 = await post(`/api/timetable-versions/${real2}/publish`, { expectedRevision: 1, expectedPublishedVersionId: real1 });
    check('version 2 published through the API (version 1 is archived)', p2.status === 200 && (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: real1 } })).status === 'ARCHIVED', JSON.stringify(p2.body).slice(0, 160));
    const afterReal = await covers(`?absenceId=${absReal.body.data.absence.id}`);
    const fresh2 = afterReal.items.filter((c: any) => c.timetableVersion.id === real2);
    check('every version-1 request is OBSOLETE and a full new set from version 2 exists (nothing lost, nothing duplicated). Since the publish now allocates automatically: the new requests are ASSIGNED automatically, EXCEPT the lesson the ADMIN had assigned, which stays OPEN for review', afterReal.items.filter((c: any) => c.status === 'OBSOLETE').length === lessonsPerWeek && fresh2.length === lessonsPerWeek && fresh2.filter((c: any) => c.status === 'OPEN').length === 1 && fresh2.find((c: any) => c.status === 'OPEN').supersedesId === realCovers[0].id && fresh2.find((c: any) => c.status === 'OPEN').attention?.code === 'MANUAL_ASSIGNMENT_NEEDS_REVIEW' && fresh2.filter((c: any) => c.status === 'ASSIGNED').every((c: any) => c.assignmentSource === 'AUTOMATIC'), `${afterReal.total}: ${afterReal.items.map((c: any) => c.status).join()}`);
    check('  the obsolete assignment stays in the history of the old request (replacement on record, event OBSOLETED)', (await call('GET', `/api/substitutions/${realCovers[0].id}`, tokA)).body.data.history.some((h: any) => h.action === 'OBSOLETED' && h.fromStatus === 'ASSIGNED'));
    const sync2 = await covers(`?absenceId=${absReal.body.data.absence.id}`);
    check('reading again changes nothing (the reconciliation is idempotent)', sync2.total === afterReal.total);
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
