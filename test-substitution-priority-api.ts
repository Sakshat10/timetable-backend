// Three-tier substitute prioritization (a teacher of the subject, any other free teacher, last resort: four consecutive periods): candidate selection, the server-side
// re-check at assignment, confirmation, audit, and what must stay true (eligibility, availability, double-booking, isolation, the published timetable untouched).
//   source <guard>/local_test_env.sh && npx tsx test-substitution-priority-api.ts
import 'dotenv/config';
import './test-fixtures/test-security-env.js';
import { createHash, randomUUID } from 'node:crypto';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { eachDate, weekdayOf } from './src/modules/substitution/substitution.core.js';
import { createWorld, destroyWorld, prisma, type World } from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const PASSWORD = 'Prio#Test-Pass-2030';

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\w*\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not a local *_test database');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('PRIO');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('PRIO');
  const worlds: World[] = [worldA, worldB];

  interface Reply { status: number; body: Record<string, any> }
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie: string, payload?: unknown): Promise<Reply> => {
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
  const codeOf = (r: Reply): string | undefined => r.body.errors?.code?.[0];

  try {
    const tokA = await sessionFor(worldA);
    const tokB = await sessionFor(worldB);
    const school = worldA.schoolId;
    let monday = '2030-03-01';
    while (weekdayOf(monday) !== 'MONDAY') monday = eachDate(monday, '2030-03-10')[1]!;

    // ---- the school: 8 periods a day, a BREAK after period 3 (so P3 and P4 are NOT consecutive) --------------------------------------------
    const year = await prisma.academicYear.create({ data: { schoolId: school, name: 'PRIO-A', startDate: new Date('2030-01-01'), endDate: new Date('2030-12-31'), status: 'ACTIVE' } });
    const config = await prisma.scheduleConfig.create({ data: { academicYearId: year.id, periodsPerDay: 8, breakAfterPeriod: 3 } });
    await prisma.scheduleDay.create({ data: { scheduleConfigId: config.id, dayOfWeek: 'MONDAY' } });
    const g8 = await prisma.grade.create({ data: { academicYearId: year.id, name: 'G8', displayOrder: 1 } });
    const sections: string[] = [];
    for (let i = 1; i <= 8; i++) sections.push((await prisma.section.create({ data: { gradeId: g8.id, name: `S${i}`, code: `S${i}` } })).id);
    const sec = (n: number): string => sections[n - 1]!;
    const subj = async (code: string) => (await prisma.subject.create({ data: { schoolId: school, name: code, code } })).id;
    const [MATH, SCI] = [await subj('MATH'), await subj('SCI')] as [string, string];
    const teacher = async (name: string) => (await prisma.teacher.create({ data: { schoolId: school, name } })).id;
    const link = async (teacherId: string, subjectId: string, type: 'PRIMARY' | 'SECONDARY', gradeScope: 'ALL_GRADES' | 'SELECTED_GRADES' = 'ALL_GRADES') => { await prisma.teacherSubject.create({ data: { teacherId, subjectId, type, gradeScope } }); };

    const A = await teacher('A absent');         // the absent teacher: Mon P5 (S1) and P4 (S2)
    const X2 = await teacher('X2 absent');       // second absent teacher: Mon P6,P7,P8 (S3,S4,S5)
    const T1 = await teacher('T1 same-subject, P6-P8');
    const T2 = await teacher('T2 same-subject, P1-P3');
    const T3 = await teacher('T3 other-eligible, free');
    const T4 = await teacher('T4 same-subject, P3-P4');
    const T5 = await teacher('T5 same-subject, free');
    const U = await teacher('U science only');
    const D = await teacher('D selected-no-row');
    await link(A, MATH, 'PRIMARY'); await link(X2, MATH, 'PRIMARY');
    for (const t of [T1, T2, T4, T5]) await link(t, MATH, 'PRIMARY');
    await link(T3, MATH, 'SECONDARY');
    await link(U, SCI, 'PRIMARY');
    await link(D, MATH, 'PRIMARY', 'SELECTED_GRADES');

    const version = await prisma.timetableVersion.create({ data: { schoolId: school, academicYearId: year.id, versionNumber: 1, status: 'PUBLISHED', solutionSource: 'CP_SAT', solverStatus: 'OPTIMAL', weightsVersion: 'V1', inputHash: 'h1', inputSnapshot: {}, metrics: {}, baselineMetrics: {}, publishedAt: new Date() } });
    const lesson = (teacherId: string, sectionNo: number, period: number) => ({ versionId: version.id, teacherId, sectionId: sec(sectionNo), subjectId: MATH, subjectRequirementId: randomUUID(), dayOfWeek: 'MONDAY' as const, periodNumber: period });
    await prisma.timetableEntry.createMany({ data: [
      lesson(A, 1, 5), lesson(A, 2, 4),                                  // A's lessons: X (P5), Y (P4)
      lesson(X2, 3, 6), lesson(X2, 4, 7), lesson(X2, 5, 8),              // X2's lessons
      lesson(T1, 6, 6), lesson(T1, 7, 7), lesson(T1, 8, 8),              // T1: P6,P7,P8
      lesson(T2, 6, 1), lesson(T2, 7, 2), lesson(T2, 8, 3),              // T2: P1,P2,P3
      lesson(T4, 6, 3), lesson(T4, 7, 4),                                // T4: P3,P4 (the break after P3 separates them)
    ] });
    let testAddedTeacher = ''; // the one lesson this test itself adds later (for the double-booking scenario) is not part of the check
    const fingerprint = async () => {
      const rows = await prisma.timetableEntry.findMany({ where: { versionId: version.id, ...(testAddedTeacher ? { teacherId: { not: testAddedTeacher } } : {}) }, orderBy: { id: 'asc' } });
      const v = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: version.id } });
      return createHash('sha256').update(JSON.stringify([rows, v.status, v.revision, v.updatedAt])).digest('hex');
    };
    const before = await fingerprint(); // computed before the test adds anything

    const post = (url: string, body: unknown, tok = tokA) => call('POST', url, tok, body);
    const absence = (teacherId: string) => post('/api/teacher-absences', { teacherId, startDate: monday, endDate: monday, autoAssign: false });
    const covers = async (absenceId: string) => (await call('GET', `/api/substitutions?absenceId=${absenceId}`, tokA)).body.data.items as any[];
    const cands = async (coverId: string, tok = tokA) => (await call('GET', `/api/substitutions/${coverId}/candidates?includeExcluded=true`, tok)).body.data;
    const put = (coverId: string, teacherId: string, confirm?: boolean, tok = tokA) => call('PUT', `/api/substitutions/${coverId}/assignment`, tok, { teacherId, ...(confirm === undefined ? {} : { confirmFourConsecutive: confirm }) });
    const unavailable = async (teacherId: string, period?: number) => (await post('/api/teacher-unavailability', { teacherId, date: monday, ...(period ? { periodNumber: period } : {}) })).body.data.id as string;
    const free = (id: string) => call('DELETE', `/api/teacher-unavailability/${id}`, tokA);
    const tierOf = (c: any, id: string) => c.candidates.find((x: any) => x.id === id)?.tier;
    const ids = (c: any) => (c.candidates as any[]).map((x) => x.id);

    const absA = await absence(A);
    const coversA = await covers(absA.body.data.absence.id);
    const X = coversA.find((c) => c.periodNumber === 5);
    const Y = coversA.find((c) => c.periodNumber === 4);
    check('(setup) A\'s absence needs cover for Monday P5 (target X) and P4 (target Y)', absA.status === 201 && coversA.length === 2 && !!X && !!Y);
    const absX2 = await absence(X2);
    const coversX2 = (await covers(absX2.body.data.absence.id)).sort((a, b) => a.periodNumber - b.periodNumber);
    check('(setup) X2\'s absence needs cover for Monday P6, P7, P8', coversX2.length === 3);

    // ===========================================================================================================
    section('1. Teachers of the subject who avoid four in a row come first; any other free teacher follows; none is excluded for lacking a link');
    const c1 = await cands(X.id);
    check('order for Monday P5: tier 1 = teachers of Maths without four in a row, primary link before secondary, then the lighter weekly workload (T5 has no lessons, T4 two, T2 three, D more) with the secondary link T3 after the primaries, tier 2 = U (no Maths link at all), tier 3 = T1 (would create P5–P8)', ids(c1).join() === [T5, T4, T2, D, T3, U, T1].join(), JSON.stringify(c1.candidates.map((c: any) => `${c.name.split(' ')[0]}:${c.tier}`)));
    check('  tiers: D/T2/T5/T4/T3 = 1 SAME_SUBJECT, U = 2 OTHER_AVAILABLE, T1 = 3 LAST_RESORT', [D, T2, T5, T4, T3].every((t) => tierOf(c1, t) === 1) && tierOf(c1, U) === 2 && tierOf(c1, T1) === 3 && c1.candidates[0].tierKey === 'SAME_SUBJECT' && c1.candidates[0].recommended === true && c1.candidates[5].tierKey === 'OTHER_AVAILABLE');
    const basis = (id: string) => c1.candidates.find((c: any) => c.id === id).subjectBasis;
    check('  the basis is the existing data: PRIMARY link (T2), SECONDARY link (T3), none (U: not a Maths teacher, yet still offered)', basis(T2) === 'PRIMARY_LINK' && basis(T3) === 'SECONDARY_LINK' && basis(U) === null && c1.candidates.find((c: any) => c.id === U).sameSubject === false && c1.candidates.find((c: any) => c.id === T3).sameSubject === true);
    const t4 = c1.candidates.find((c: any) => c.id === T4);
    check('  T4 (lessons P3,P4): the BREAK after P3 means the cover in P5 joins only P4 → run P4–P5 = 2, not 3 — breaks interrupt', t4.consecutive.resultingRun === 2 && t4.consecutive.from === 4 && t4.consecutive.to === 5 && t4.consecutive.createsFourConsecutive === false);
    const t1 = c1.candidates.find((c: any) => c.id === T1);
    check('  T1 (lessons P6,P7,P8): the cover in P5 would give P5–P8 = four consecutive → flagged, needs confirmation, NOT offered while better options exist', t1.consecutive.createsFourConsecutive === true && t1.consecutive.periods.join() === '5,6,7,8' && t1.requiresConfirmation === true && t1.offered === false && /P5–P8/.test(t1.explanation));
    check('  each candidate carries free=true, a cover load for the day, and an explanation', c1.candidates.every((c: any) => c.free === true && c.coverLoadToday === 0 && typeof c.explanation === 'string' && c.explanation.length > 20));
    check('  selection: same-subject available, last resort NOT offered, 1 hidden, recommended = T5 (first: the lightest weekly workload), summary says subject teachers first', c1.selection.sameSubjectAvailable === true && c1.selection.lastResortOffered === false && c1.selection.notOffered === 1 && c1.selection.recommendedTeacherId === T5 && /Free teachers of this subject are listed first/.test(c1.selection.summary));
    check('  U (teaches only science) and D (SELECTED_GRADES, no grade row) are candidates: a temporary cover needs neither a subject link nor a grade eligibility', ids(c1).includes(U) && ids(c1).includes(D) && !(c1.excluded ?? []).some((x: any) => x.teacher.id === U || x.teacher.id === D));
    check('  the absent teacher is excluded', c1.excluded.find((x: any) => x.teacher.id === A).reason === 'IS_ABSENT_TEACHER');

    section('1b. A break stops the run (target P4, teacher with P1,P2,P3)');
    const cY = await cands(Y.id);
    const t2y = cY.candidates.find((c: any) => c.id === T2);
    check('T2 teaches P1–P3 and would cover P4: WITHOUT the break that is four in a row; with the break after P3 the run is only P4, so T2 stays tier 1', t2y.consecutive.resultingRun === 1 && t2y.tier === 1 && t2y.consecutive.createsFourConsecutive === false);
    const t1y = cY.candidates.find((c: any) => c.id === T1);
    check('T1 (P6–P8) covering P4 leaves P5 free, so it stays tier 1 as well (run 1)', t1y.consecutive.resultingRun === 1 && t1y.tier === 1);

    // ===========================================================================================================
    section('2. Existing substitute assignments count toward consecutive periods; a stale list cannot slip a teacher into four in a row');
    const stale = await cands(X.id); // the admin looks at T5: tier 1
    check('(lookup) T5 is tier 1 with no cover load', tierOf(stale, T5) === 1 && stale.candidates.find((c: any) => c.id === T5).coverLoadToday === 0);
    for (const c of coversX2) { const r = await put(c.id, T5); check(`T5 assigned to X2's P${c.periodNumber} (no confirmation needed, run ≤ 3)`, r.status === 200 && r.body.data.selection.tier === 1, JSON.stringify(r.body).slice(0, 160)); }
    const staleAssign = await put(X.id, T5);
    check('assigning T5 from the STALE list (without confirmation) is refused: the server recomputed P5–P8 from the covers just assigned → 409 FOUR_CONSECUTIVE_CONFIRMATION_REQUIRED naming the periods', staleAssign.status === 409 && codeOf(staleAssign) === 'FOUR_CONSECUTIVE_CONFIRMATION_REQUIRED' && staleAssign.body.errors.periods.join() === '5,6,7,8' && /P5–P8/.test(staleAssign.body.message), JSON.stringify(staleAssign.body));
    check('  the request stayed OPEN and unassigned', (await prisma.coverRequest.findUniqueOrThrow({ where: { id: X.id } })).status === 'OPEN');
    const c2 = await cands(X.id);
    const t5 = c2.candidates.find((c: any) => c.id === T5);
    check('now T5 is tier 3 because of the covers (P6,P7,P8 are existing substitute assignments), cover load 3, run P5–P8', t5.tier === 3 && t5.coverLoadToday === 3 && t5.consecutive.periods.join() === '5,6,7,8');
    check('  the candidate list is re-ordered: T4, T2, D, T3 (tier 1), U (tier 2), then the hidden last-resorts T1 and T5', ids(c2).join() === [T4, T2, D, T3, U, T1, T5].join(), JSON.stringify(c2.candidates.map((c: any) => `${c.name.split(' ')[0]}:${c.tier}`)));

    // ===========================================================================================================
    section('3. A teacher of the subject would create four; another free teacher would not → the latter');
    const unT2 = await unavailable(T2, 5); const unT4 = await unavailable(T4, 5); const unT5 = await unavailable(T5, 5); const unD = await unavailable(D, 5); const unT3 = await unavailable(T3, 5);
    const c3 = await cands(X.id);
    check('with every other teacher of Maths unavailable: U (not a Maths teacher, run 1) is tier 2 and is RECOMMENDED over T1 (a Maths teacher, but P5–P8)', ids(c3).join() === [U, T1].join() && tierOf(c3, U) === 2 && tierOf(c3, T1) === 3 && c3.selection.recommendedTeacherId === U && c3.selection.lastResortOffered === false);
    check('  the summary explains that other free teachers are shown because no suitable teacher of the subject is available', /other free teachers are shown/.test(c3.selection.summary) && c3.selection.sameSubjectAvailable === false && c3.selection.otherAvailable === true);

    section('4. No suitable teacher of the subject: ANY other free teacher is offered (no link, no grade eligibility)');
    const unT1 = await unavailable(T1, 5);
    const c4 = await cands(X.id);
    check('T1 also unavailable: only U remains, tier 2 OTHER_AVAILABLE, no last resort; U has no Maths link and no grade row', ids(c4).join() === U && c4.candidates[0].tier === 2 && c4.candidates[0].subjectBasis === null && c4.selection.counts.SAME_SUBJECT === 0 && c4.selection.counts.LAST_RESORT === 0 && (await prisma.teacherSubject.count({ where: { teacherId: U, subjectId: MATH } })) === 0);

    // ===========================================================================================================
    section('5. Every available teacher creates four in a row → a last-resort candidate is offered, with confirmation');
    const unU = await unavailable(U, 5);
    await free(unT1); // T1 (a Maths teacher, P6–P8) is back; everybody else is unavailable
    const c5 = await cands(X.id);
    check('only T1 is available and it creates four in a row: tier 3, OFFERED, lastResortOffered true, summary explains why', ids(c5).join() === T1 && c5.candidates[0].tier === 3 && c5.candidates[0].offered === true && c5.candidates[0].tierKey === 'LAST_RESORT' && c5.selection.lastResortOffered === true && /last-resort/.test(c5.selection.summary) && c5.selection.recommendedTeacherId === null);
    const noConfirm = await put(X.id, T1);
    check('assigning the last-resort teacher WITHOUT confirmation → 409 FOUR_CONSECUTIVE_CONFIRMATION_REQUIRED (periods 5–8), nothing assigned', noConfirm.status === 409 && codeOf(noConfirm) === 'FOUR_CONSECUTIVE_CONFIRMATION_REQUIRED' && noConfirm.body.errors.periods.join() === '5,6,7,8' && (await prisma.coverRequest.findUniqueOrThrow({ where: { id: X.id } })).status === 'OPEN');
    const falseConfirm = await put(X.id, T1, false);
    check('  confirmFourConsecutive=false is the same as omitting it', falseConfirm.status === 409);
    const confirmed = await put(X.id, T1, true);
    check('WITH confirmation the assignment is accepted (200): the four-period warning alone never blocks', confirmed.status === 200 && confirmed.body.data.status === 'ASSIGNED' && confirmed.body.data.replacementTeacher.id === T1 && confirmed.body.data.selection.tier === 3 && confirmed.body.data.selection.consecutive.createsFourConsecutive === true, JSON.stringify(confirmed.body).slice(0, 200));
    const histX = (await call('GET', `/api/substitutions/${X.id}`, tokA)).body.data.history;
    const last = histX[histX.length - 1];
    check('  the audit history records WHO confirmed the last-resort assignment and WHICH periods', last.action === 'ASSIGNED' && last.actor?.id === worldA.adminId && /Last-resort/.test(last.note) && /P5–P8/.test(last.note) && last.toTeacher.id === T1, JSON.stringify(last));
    const confirmedNeedless = await put(Y.id, T2, true);
    check('a confirmation sent for a teacher who does NOT need it is harmless (T2 for P4: no note, tier 1)', confirmedNeedless.status === 200 && confirmedNeedless.body.data.selection.tier === 1 && (await call('GET', `/api/substitutions/${Y.id}`, tokA)).body.data.history.at(-1).note === null);

    // ===========================================================================================================
    section('6. Nobody is free → the request stays unassigned, with a reason');
    await call('DELETE', `/api/substitutions/${X.id}/assignment`, tokA);
    const unT1b = await unavailable(T1, 5);
    const c6 = await cands(X.id);
    check('everybody is unavailable (or absent): no candidates, a clear "no teacher is available" message, summary empty', c6.candidates.length === 0 && /No teacher is available to cover this lesson/.test(c6.message) && /unavailable/.test(c6.message) && /stays unassigned/.test(c6.message) && c6.selection.summary === '' && c6.selection.recommendedTeacherId === null, JSON.stringify(c6.message));
    const tryAny = await put(X.id, T3);
    check('  assigning anyone is refused (409 UNAVAILABLE) and the request stays OPEN', tryAny.status === 409 && codeOf(tryAny) === 'UNAVAILABLE' && (await prisma.coverRequest.findUniqueOrThrow({ where: { id: X.id } })).status === 'OPEN');

    // ===========================================================================================================
    section('7. A candidate who becomes unavailable between lookup and assignment is safely rejected');
    await free(unT3);
    const lookup = await cands(X.id);
    check('(lookup) T3 (a secondary-link Maths teacher) is offered (tier 1)', tierOf(lookup, T3) === 1);
    await unavailable(T3, 5); // changes right after the admin looked
    const lateAssign = await put(X.id, T3);
    check('assigning T3 now → 409 UNAVAILABLE (recomputed on the server); the request stays OPEN', lateAssign.status === 409 && codeOf(lateAssign) === 'UNAVAILABLE' && (await prisma.coverRequest.findUniqueOrThrow({ where: { id: X.id } })).status === 'OPEN');
    check('  a refreshed lookup no longer lists T3', !ids(await cands(X.id)).includes(T3));

    // ===========================================================================================================
    section('8. Double-booking, absence and isolation stay enforced; a temporary cover changes no permanent data');
    for (const id of [unT2, unT4, unT5, unT1b, unD, unU]) await free(id);
    const absT4 = await absence(T4); // T4 absent on Monday: not a candidate, even though free of lessons in P5
    check('(setup) T4 recorded absent: its lessons need cover', absT4.status === 201);
    const c8 = await cands(X.id);
    check('an ABSENT teacher is excluded (T4: ABSENT) and an unavailable one (T3) too', c8.excluded.find((x: any) => x.teacher.id === T4).reason === 'ABSENT' && c8.excluded.find((x: any) => x.teacher.id === T3).reason === 'UNAVAILABLE');
    const absentTry = await put(X.id, T4);
    check('  assigning the absent T4 → 409 ABSENT', absentTry.status === 409 && codeOf(absentTry) === 'ABSENT');
    const linksBefore = await prisma.teacherSubject.count({ where: { teacher: { schoolId: school } } });
    const gradeRowsBefore = await prisma.teacherSubjectGrade.count({ where: { teacherSubject: { teacher: { schoolId: school } } } });
    const uAssign = await put(X.id, U);
    check('U (teaches only science: no Maths link, no grade row) can be assigned as a TEMPORARY cover: 200, tier 2 OTHER_AVAILABLE, no confirmation', uAssign.status === 200 && uAssign.body.data.replacementTeacher.id === U && uAssign.body.data.selection.tierKey === 'OTHER_AVAILABLE' && uAssign.body.data.selection.sameSubject === false);
    const dAssign = await put(X.id, D);
    check('D (SELECTED_GRADES with no grade row) can be assigned too (reassign): 200, tier 1', dAssign.status === 200 && dAssign.body.data.replacementTeacher.id === D && dAssign.body.data.selection.tier === 1);
    check('permanent data untouched: the number of teacher-subject links and grade eligibility rows is exactly what it was, and U still has no Maths link', (await prisma.teacherSubject.count({ where: { teacher: { schoolId: school } } })) === linksBefore && (await prisma.teacherSubjectGrade.count({ where: { teacherSubject: { teacher: { schoolId: school } } } })) === gradeRowsBefore && (await prisma.teacherSubject.count({ where: { teacherId: U, subjectId: MATH } })) === 0);
    await call('DELETE', `/api/substitutions/${X.id}/assignment`, tokA);
    const first = await put(X.id, T2);
    check('T2 assigned to P5', first.status === 200);
    // a second absent teacher with a lesson in P5 → double-booking attempt on T2
    const A2 = await teacher('A2 absent too'); await link(A2, MATH, 'PRIMARY');
    testAddedTeacher = A2;
    await prisma.timetableEntry.create({ data: lesson(A2, 3, 5) });
    const absA2 = await absence(A2);
    const p5b = (await covers(absA2.body.data.absence.id)).find((c) => c.periodNumber === 5);
    const cb = await cands(p5b.id);
    check('T2 (already covering P5) is not offered for ANOTHER P5 lesson: ALREADY_COVERING', cb.excluded.find((x: any) => x.teacher.id === T2).reason === 'ALREADY_COVERING' && !ids(cb).includes(T2));
    const dbl = await put(p5b.id, T2);
    check('  assigning T2 to the second P5 lesson → 409 ALREADY_COVERING (no double-booking)', dbl.status === 409 && codeOf(dbl) === 'ALREADY_COVERING');
    const isoC = await call('GET', `/api/substitutions/${X.id}/candidates`, tokB);
    const isoP = await put(X.id, T3, undefined, tokB);
    check('another school cannot read candidates or assign (403)', isoC.status === 403 && isoP.status === 403);
    const bTeacher = (await prisma.teacher.create({ data: { schoolId: worldB.schoolId, name: 'B school teacher' } })).id;
    await link(bTeacher, MATH, 'PRIMARY');
    check('  and a teacher of another school is never a candidate or assignable here (403)', !ids(await cands(X.id)).includes(bTeacher) && (await put(X.id, bTeacher)).status === 403);

    // ===========================================================================================================
    section('9. The published timetable is never modified');
    const after = await fingerprint();
    check('every published lesson and the version row are byte-for-byte unchanged after all of the above', before === after);
    check('substitution assignments are separate, date-specific records (cover_requests), not edits to timetable_entries', (await prisma.timetableEntry.count({ where: { versionId: version.id, teacherId: T5 } })) === 0 && (await prisma.coverRequest.count({ where: { replacementTeacherId: T5, status: 'ASSIGNED' } })) === 3);

    // ===========================================================================================================
    section('10. Concurrent assignments of ONE teacher to ADJACENT periods cannot slip past the four-in-a-row confirmation');
    {
      const tue = eachDate(monday, '2030-03-20')[1]!;
      const R = await teacher('R free all Tuesday'); await link(R, MATH, 'PRIMARY');
      const absentTeachers: string[] = [];
      for (let i = 0; i < 4; i++) { const e = await teacher(`E${i + 1} absent Tuesday`); await link(e, MATH, 'PRIMARY'); absentTeachers.push(e); }
      await prisma.timetableEntry.createMany({ data: absentTeachers.map((e, i) => ({ versionId: version.id, teacherId: e, sectionId: sec(i + 1), subjectId: MATH, subjectRequirementId: randomUUID(), dayOfWeek: 'TUESDAY' as const, periodNumber: 5 + i })) });
      testAddedTeacher = ''; // the check below compares only R's own bookings
      const tueCovers: any[] = [];
      for (const e of absentTeachers) { const a = await post('/api/teacher-absences', { teacherId: e, startDate: tue, endDate: tue, autoAssign: false }); tueCovers.push(...(await covers(a.body.data.absence.id))); }
      tueCovers.sort((a, b) => a.periodNumber - b.periodNumber);
      check('(setup) four lessons at Tuesday P5–P8 need cover and R is free', tueCovers.length === 4 && tueCovers.map((c) => c.periodNumber).join() === '5,6,7,8');
      let unconfirmedFour = 0; let wrongOutcome = 0; const outcomes: string[] = [];
      for (let round = 0; round < 8; round++) {
        for (const c of tueCovers) await call('DELETE', `/api/substitutions/${c.id}/assignment`, tokA);
        // Rounds 0-3 race naturally. Rounds 4-7 FORCE the interleaving: R's teacher row is held, so all four assignments pass their own cover-row
        // locks and then wait together at R's row; when it is released they evaluate at the same moment, each seeing no booking of the others.
        const gated = round >= 4;
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const holder = gated ? prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT "id" FROM "teachers" WHERE "id" = ${R} FOR UPDATE`; await gate; }, { timeout: 60_000, maxWait: 10_000 }) : null;
        if (gated) await new Promise((r) => setTimeout(r, 300));
        const pending = tueCovers.map((c) => put(c.id, R));
        if (gated) { await new Promise((r) => setTimeout(r, 2_000)); release(); await holder; }
        const results = await Promise.all(pending);
        const ok = results.filter((r) => r.status === 200).length;
        const refused = results.filter((r) => r.status === 409 && codeOf(r) === 'FOUR_CONSECUTIVE_CONFIRMATION_REQUIRED').length;
        const booked = await prisma.coverRequest.count({ where: { replacementTeacherId: R, status: 'ASSIGNED' } });
        outcomes.push(`${ok}/${refused}/${booked}`);
        if (booked >= 4) unconfirmedFour++;
        if (!(ok === 3 && refused === 1 && booked === 3)) wrongOutcome++;
      }
      check(`8 rounds (4 natural races, 4 with the interleaving forced) of four simultaneous assignments of R to P5,P6,P7,P8 (no confirmation): never four unconfirmed in a row; every round commits exactly 3 and asks for confirmation for 1 (ok/refused/booked per round: ${outcomes.join(' ')})`, unconfirmedFour === 0 && wrongOutcome === 0);
    }
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
