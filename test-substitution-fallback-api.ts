// School policy for substitutes: a substitution is a TEMPORARY, date-specific cover, not a teaching qualification.
//   1. a free teacher of the lesson's subject comes first (identified from existing data: a teacher-subject link of either type, or lessons of that subject in the published timetable);
//   2. otherwise ANY other free teacher of the school is a candidate: NO subject link and NO grade-eligibility row is required, and none is created;
//   3. if every available teacher would end with four consecutive periods, the best is offered as a last resort (explicit confirmation); nobody free → unassigned, with the reason.
// Absence, unavailability, lessons, covers (double-booking) and school isolation stay enforced; the published timetable is never modified.
//   source <guard>/local_test_env.sh && npx tsx test-substitution-fallback-api.ts
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
const PASSWORD = 'Fallback#Test-Pass-2030';

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\w*\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not a local *_test database');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('FALLB');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('FALLB');
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

    // ---- school: 8 periods, a BREAK after period 3 ---------------------------------------------------------------------------------------
    const year = await prisma.academicYear.create({ data: { schoolId: school, name: 'FALLB-A', startDate: new Date('2030-01-01'), endDate: new Date('2030-12-31'), status: 'ACTIVE' } });
    const config = await prisma.scheduleConfig.create({ data: { academicYearId: year.id, periodsPerDay: 8, breakAfterPeriod: 3 } });
    await prisma.scheduleDay.create({ data: { scheduleConfigId: config.id, dayOfWeek: 'MONDAY' } });
    const g8 = await prisma.grade.create({ data: { academicYearId: year.id, name: 'G8', displayOrder: 1 } });
    const sections: string[] = [];
    for (let i = 1; i <= 8; i++) sections.push((await prisma.section.create({ data: { gradeId: g8.id, name: `S${i}`, code: `S${i}` } })).id);
    const sec = (n: number): string => sections[n - 1]!;
    const subj = async (code: string, name: string) => (await prisma.subject.create({ data: { schoolId: school, name, code } })).id;
    const [HIN, MATH] = [await subj('HIN', 'Hindi'), await subj('MATH', 'Maths')] as [string, string];
    const teacher = async (name: string, over: { schoolId?: string; isActive?: boolean } = {}) => (await prisma.teacher.create({ data: { schoolId: over.schoolId ?? school, name, ...(over.isActive === false ? { isActive: false } : {}) } })).id;
    const link = async (teacherId: string, subjectId: string, type: 'PRIMARY' | 'SECONDARY', gradeScope: 'ALL_GRADES' | 'SELECTED_GRADES' = 'ALL_GRADES') => (await prisma.teacherSubject.create({ data: { teacherId, subjectId, type, gradeScope } })).id;

    const anita = await teacher('Anita (absent)');
    const bina = await teacher('Bina (absent)');
    await link(anita, HIN, 'PRIMARY'); await link(bina, HIN, 'PRIMARY');
    const inactiveHindi = await teacher('IN inactive Hindi teacher', { isActive: false }); await link(inactiveHindi, HIN, 'PRIMARY');
    const others: string[] = [];
    for (let i = 1; i <= 8; i++) { const t = await teacher(`N${i} no Hindi link`); await link(t, MATH, 'PRIMARY'); others.push(t); } // Maths teachers, free all day, NO link to Hindi, no Hindi lessons

    const version = await prisma.timetableVersion.create({ data: { schoolId: school, academicYearId: year.id, versionNumber: 1, status: 'PUBLISHED', solutionSource: 'CP_SAT', solverStatus: 'OPTIMAL', weightsVersion: 'V1', inputHash: 'h1', inputSnapshot: {}, metrics: {}, baselineMetrics: {}, publishedAt: new Date() } });
    const lesson = (teacherId: string, sectionNo: number, period: number, subjectId = HIN) => ({ versionId: version.id, teacherId, sectionId: sec(sectionNo), subjectId, subjectRequirementId: randomUUID(), dayOfWeek: 'MONDAY' as const, periodNumber: period });
    await prisma.timetableEntry.createMany({ data: [lesson(anita, 1, 5), lesson(bina, 2, 5)] });
    let addedTeachers: string[] = []; // teachers whose lessons this test adds later (not part of the unchanged-timetable check)
    const fingerprint = async () => {
      const rows = await prisma.timetableEntry.findMany({ where: { versionId: version.id, teacherId: { notIn: addedTeachers } }, orderBy: { id: 'asc' } });
      const v = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: version.id } });
      return createHash('sha256').update(JSON.stringify([rows, v.status, v.revision, v.updatedAt])).digest('hex');
    };
    const before = await fingerprint();

    const post = (url: string, body: unknown, tok = tokA) => call('POST', url, tok, body);
    const absence = (teacherId: string) => post('/api/teacher-absences', { teacherId, startDate: monday, endDate: monday, autoAssign: false });
    const covers = async (absenceId: string) => (await call('GET', `/api/substitutions?absenceId=${absenceId}`, tokA)).body.data.items as any[];
    const cands = async (coverId: string, tok = tokA) => call('GET', `/api/substitutions/${coverId}/candidates?includeExcluded=true`, tok);
    const put = (coverId: string, teacherId: string, confirm?: boolean, tok = tokA) => call('PUT', `/api/substitutions/${coverId}/assignment`, tok, { teacherId, ...(confirm === undefined ? {} : { confirmFourConsecutive: confirm }) });
    const unassign = (coverId: string) => call('DELETE', `/api/substitutions/${coverId}/assignment`, tokA);
    const unavailable = async (teacherId: string, period = 5) => (await post('/api/teacher-unavailability', { teacherId, date: monday, periodNumber: period })).body.data.id as string;
    const free = (id: string) => call('DELETE', `/api/teacher-unavailability/${id}`, tokA);
    const reasonOf = (c: any, id: string) => c.excluded.find((x: any) => x.teacher.id === id)?.reason;
    const ids = (c: any) => (c.candidates as any[]).map((x) => x.id);
    const permanent = async () => JSON.stringify([
      await prisma.teacherSubject.count({ where: { teacher: { schoolId: school } } }),
      await prisma.teacherSubjectGrade.count({ where: { teacherSubject: { teacher: { schoolId: school } } } }),
      await prisma.sectionSubjectTeacher.count({ where: { teacher: { schoolId: school } } }),
    ]);

    const absAnita = await absence(anita);
    const anitaCover = (await covers(absAnita.body.data.absence.id))[0];
    const absBina = await absence(bina);
    const binaCover = (await covers(absBina.body.data.absence.id))[0];
    check('(setup) Anita\'s and Bina\'s Hindi lessons (Monday P5) need cover', !!anitaCover && !!binaCover && anitaCover.subject.name === 'Hindi');
    const permanentBefore = await permanent();

    // ===========================================================================================================
    section('1. The reported situation: nobody free teaches Hindi → ANY other free teacher is offered (no Hindi link, no grade row needed)');
    const r1 = await cands(anitaCover.id);
    const c1 = r1.body.data;
    check('the eight teachers who have NO Hindi link are all candidates (tier 2 OTHER_AVAILABLE), not excluded for "not qualified"', r1.status === 200 && ids(c1).length === 8 && others.every((t) => ids(c1).includes(t)) && c1.candidates.every((c: any) => c.tier === 2 && c.tierKey === 'OTHER_AVAILABLE' && c.sameSubject === false && c.subjectBasis === null) && !c1.message);
    check('  nobody is excluded for qualification: the inactive teacher is INACTIVE, Bina is ABSENT, Anita is IS_ABSENT_TEACHER', reasonOf(c1, inactiveHindi) === 'INACTIVE' && reasonOf(c1, bina) === 'ABSENT' && reasonOf(c1, anita) === 'IS_ABSENT_TEACHER' && c1.excluded.length === 3);
    check('  the summary says no suitable teacher of the subject is available, so other free teachers are shown', /No suitable teacher of this subject is available/.test(c1.selection.summary) && /other free teachers are shown/.test(c1.selection.summary) && c1.selection.sameSubjectAvailable === false && c1.selection.otherAvailable === true);
    check('  each explanation says it is a temporary cover that needs no subject link or grade eligibility', c1.candidates.every((c: any) => /temporary cover \(no subject link or grade eligibility is needed or changed\)/.test(c.explanation)));
    const assigned1 = await put(anitaCover.id, others[0]!);
    check('assigning N1 (no Hindi link) is accepted: 200, ASSIGNED, tier OTHER_AVAILABLE, no confirmation needed', assigned1.status === 200 && assigned1.body.data.status === 'ASSIGNED' && assigned1.body.data.replacementTeacher.id === others[0] && assigned1.body.data.selection.tierKey === 'OTHER_AVAILABLE');
    const hist1 = (await call('GET', `/api/substitutions/${anitaCover.id}`, tokA)).body.data.history.at(-1);
    check('  the history records who assigned whom', hist1.action === 'ASSIGNED' && hist1.actor?.id === worldA.adminId && hist1.toTeacher.id === others[0]);
    check('  PERMANENT data is untouched: no teacher-subject link, grade row or section assignment was created; N1 still has no Hindi link', (await permanent()) === permanentBefore && (await prisma.teacherSubject.count({ where: { teacherId: others[0], subjectId: HIN } })) === 0);
    await unassign(anitaCover.id);

    // ===========================================================================================================
    section('2. A free teacher of the subject comes first, however the school data identifies them (no extra link needed)');
    const sg = await teacher('SG Hindi secondary, SELECTED_GRADES, no grade row'); await link(sg, HIN, 'SECONDARY', 'SELECTED_GRADES');
    const sh = await teacher('SH Hindi secondary, all grades'); await link(sh, HIN, 'SECONDARY', 'ALL_GRADES');
    const tt = await teacher('TT teaches Hindi in the timetable, no link at all');
    addedTeachers = [tt];
    await prisma.timetableEntry.create({ data: lesson(tt, 8, 1) }); // a Hindi lesson of the published timetable, Monday P1: that is how the data says TT teaches Hindi
    const c2 = (await cands(anitaCover.id)).body.data;
    check('order: SH (secondary link, ALL_GRADES: grade-eligible, so first), SG (secondary link, no grade row), TT (teaches Hindi only in the timetable), then the eight others (tier 2)', ids(c2).join() === [sh, sg, tt, ...others].join(), JSON.stringify(c2.candidates.map((c: any) => `${c.name.split(' ')[0]}:${c.tier}`)));
    check('  tier 1 = the three Hindi teachers (basis SECONDARY_LINK, SECONDARY_LINK, TEACHES_IN_TIMETABLE), tier 2 = the others', [sg, sh, tt].every((t) => c2.candidates.find((c: any) => c.id === t).tier === 1) && c2.candidates.find((c: any) => c.id === sg).subjectBasis === 'SECONDARY_LINK' && c2.candidates.find((c: any) => c.id === tt).subjectBasis === 'TEACHES_IN_TIMETABLE' && others.every((t) => c2.candidates.find((c: any) => c.id === t).tier === 2));
    check('  selection: same-subject available, recommended = SH, summary says teachers of this subject come first', c2.selection.sameSubjectAvailable === true && c2.selection.recommendedTeacherId === sh && /Free teachers of this subject are listed first/.test(c2.selection.summary));
    const tAssign = await put(anitaCover.id, tt);
    check('TT is assigned (200, tier 1) although they have no Hindi link; still no link afterwards', tAssign.status === 200 && tAssign.body.data.selection.tier === 1 && tAssign.body.data.selection.subjectBasis === 'TEACHES_IN_TIMETABLE' && (await prisma.teacherSubject.count({ where: { teacherId: tt } })) === 0);
    await unassign(anitaCover.id);

    section('2b. Four in a row: a Hindi teacher who would create it loses to another free teacher who would not');
    const ph = await teacher('PH Hindi primary, P6-P8'); await link(ph, HIN, 'PRIMARY', 'ALL_GRADES');
    addedTeachers = [tt, ph];
    await prisma.timetableEntry.createMany({ data: [lesson(ph, 3, 6), lesson(ph, 4, 7), lesson(ph, 5, 8)] });
    const unSG = await unavailable(sg); const unSH = await unavailable(sh); const unTT = await unavailable(tt);
    const c3 = (await cands(anitaCover.id)).body.data;
    const phCand = c3.candidates.find((c: any) => c.id === ph);
    check('the other Hindi teachers are unavailable: PH (Hindi, primary) would end with P5–P8, so the eight others (tier 2) are listed first and PH is a hidden last resort', ids(c3).slice(0, 8).join() === others.join() && phCand.tier === 3 && phCand.offered === false && phCand.consecutive.periods.join() === '5,6,7,8' && c3.selection.recommendedTeacherId === others[0] && c3.selection.lastResortOffered === false);
    check('  the unavailable Hindi teachers are excluded as UNAVAILABLE', [sg, sh, tt].every((t) => reasonOf(c3, t) === 'UNAVAILABLE'));

    // ===========================================================================================================
    section('3. Everybody available would create four in a row → the best is offered as a LAST RESORT (never excluded); confirmation required');
    const unOthers: string[] = []; for (const t of others) unOthers.push(await unavailable(t));
    const c4 = (await cands(anitaCover.id)).body.data;
    check('only PH is available and it creates four in a row: it is a candidate (tier 3, offered), NOT excluded, with the periods in its explanation', ids(c4).join() === ph && c4.candidates[0].tier === 3 && c4.candidates[0].offered === true && c4.selection.lastResortOffered === true && !c4.excluded.some((x: any) => x.teacher.id === ph) && /P5–P8/.test(c4.candidates[0].explanation) && /nobody else/i.test(c4.candidates[0].explanation));
    const noConfirm = await put(anitaCover.id, ph);
    check('without confirmation → 409 FOUR_CONSECUTIVE_CONFIRMATION_REQUIRED (periods 5–8); nothing assigned', noConfirm.status === 409 && codeOf(noConfirm) === 'FOUR_CONSECUTIVE_CONFIRMATION_REQUIRED' && noConfirm.body.errors.periods.join() === '5,6,7,8' && (await prisma.coverRequest.findUniqueOrThrow({ where: { id: anitaCover.id } })).status === 'OPEN');
    const withConfirm = await put(anitaCover.id, ph, true);
    const hist = (await call('GET', `/api/substitutions/${anitaCover.id}`, tokA)).body.data.history.at(-1);
    check('with confirmation → 200; the history records who confirmed and which periods', withConfirm.status === 200 && withConfirm.body.data.replacementTeacher.id === ph && hist.actor?.id === worldA.adminId && /Last-resort/.test(hist.note) && /P5–P8/.test(hist.note));
    await unassign(anitaCover.id);

    section('3b. A teacher who does NOT teach the subject is a last resort too when every available teacher creates four');
    const nq = await teacher('NQ Maths teacher, P6-P8'); await link(nq, MATH, 'PRIMARY', 'ALL_GRADES');
    addedTeachers = [tt, ph, nq];
    await prisma.timetableEntry.createMany({ data: [lesson(nq, 6, 6, MATH), lesson(nq, 7, 7, MATH), lesson(nq, 8, 8, MATH)] });
    const c5 = (await cands(binaCover.id)).body.data;
    check('PH (Hindi) and NQ (not Hindi) are both offered as last resorts, the subject teacher first', ids(c5).join() === [ph, nq].join() && c5.candidates.every((c: any) => c.tier === 3 && c.offered === true) && c5.selection.counts.LAST_RESORT === 2 && c5.selection.lastResortOffered === true);
    const nqNo = await put(binaCover.id, nq);
    const nqYes = await put(binaCover.id, nq, true);
    check('NQ needs the same confirmation, then is assigned', nqNo.status === 409 && codeOf(nqNo) === 'FOUR_CONSECUTIVE_CONFIRMATION_REQUIRED' && nqYes.status === 200 && nqYes.body.data.replacementTeacher.id === nq);

    // ===========================================================================================================
    section('4. Nobody is free → the request stays unassigned, and says why');
    await unassign(binaCover.id); // NQ stops covering first (a teacher who covers a slot cannot be marked unavailable for it)
    await unavailable(ph); await unavailable(nq);
    const c6 = (await cands(binaCover.id)).body.data;
    check('everyone is unavailable, absent or inactive: no candidates and a clear "no teacher is available" message', c6.candidates.length === 0 && /No teacher is available to cover this lesson/.test(c6.message) && /unavailable/.test(c6.message) && /stays unassigned/.test(c6.message) && c6.selection.summary === '');
    const tryAny = await put(binaCover.id, others[1]!);
    check('  assigning anyone is refused (409 UNAVAILABLE) and the request stays OPEN', tryAny.status === 409 && codeOf(tryAny) === 'UNAVAILABLE' && (await prisma.coverRequest.findUniqueOrThrow({ where: { id: binaCover.id } })).status === 'OPEN');

    // ===========================================================================================================
    section('5. What stays enforced');
    for (const id of [unSG, unSH, unTT, ...unOthers]) await free(id);
    const absN2 = await absence(others[1]!);
    check('(setup) N2 is recorded absent on Monday', absN2.status === 201);
    const c7 = (await cands(anitaCover.id)).body.data;
    check('an ABSENT teacher is excluded (N2: ABSENT) and an unavailable one (PH, NQ: UNAVAILABLE) too; the inactive teacher stays INACTIVE', reasonOf(c7, others[1]!) === 'ABSENT' && reasonOf(c7, ph) === 'UNAVAILABLE' && reasonOf(c7, nq) === 'UNAVAILABLE' && reasonOf(c7, inactiveHindi) === 'INACTIVE');
    const e1 = await put(anitaCover.id, others[1]!); const e2 = await put(anitaCover.id, ph); const e3 = await put(anitaCover.id, inactiveHindi); const e4 = await put(anitaCover.id, anita);
    check('  assigning the absent → 409 ABSENT; the unavailable → 409 UNAVAILABLE; the inactive → 400 INACTIVE; the absent teacher → 400 IS_ABSENT_TEACHER', e1.status === 409 && codeOf(e1) === 'ABSENT' && e2.status === 409 && codeOf(e2) === 'UNAVAILABLE' && e3.status === 400 && codeOf(e3) === 'INACTIVE' && e4.status === 400 && codeOf(e4) === 'IS_ABSENT_TEACHER');
    const sgAssign = await put(anitaCover.id, sg);
    check('SG covers Anita\'s P5 (a Hindi teacher, tier 1)', sgAssign.status === 200 && sgAssign.body.data.selection.tier === 1);
    const cBina = (await cands(binaCover.id)).body.data;
    check('double-booking: SG (already covering P5) is not offered for Bina\'s P5 (ALREADY_COVERING) and cannot be assigned to it (409)', reasonOf(cBina, sg) === 'ALREADY_COVERING' && !ids(cBina).includes(sg) && (await put(binaCover.id, sg)).status === 409 && codeOf(await put(binaCover.id, sg)) === 'ALREADY_COVERING');
    addedTeachers = [tt, ph, nq, others[2]!];
    await prisma.timetableEntry.create({ data: lesson(others[2]!, 5, 5, MATH) }); // N3 teaches a Maths lesson of the published timetable in Monday P5
    const cLesson = (await cands(binaCover.id)).body.data;
    const lessonConflict = await put(binaCover.id, others[2]!);
    check('a teacher with a lesson of the published timetable in that period is excluded (TEACHING_ANOTHER_LESSON) and refused (409), whatever they teach', reasonOf(cLesson, others[2]!) === 'TEACHING_ANOTHER_LESSON' && !ids(cLesson).includes(others[2]!) && lessonConflict.status === 409 && codeOf(lessonConflict) === 'TEACHING_ANOTHER_LESSON');
    const foreignHindi = (await prisma.subject.create({ data: { schoolId: worldB.schoolId, name: 'Hindi', code: 'HIN' } })).id;
    const foreignTeacher = await teacher('Foreign Hindi teacher', { schoolId: worldB.schoolId });
    await link(foreignTeacher, foreignHindi, 'PRIMARY', 'ALL_GRADES');
    const c8 = (await cands(anitaCover.id)).body.data;
    check('school isolation: another school\'s teacher is never a candidate nor listed, cannot be assigned (403), and another school\'s admin cannot read candidates (403)', !ids(c8).includes(foreignTeacher) && !(c8.excluded ?? []).some((x: any) => x.teacher.id === foreignTeacher) && (await put(anitaCover.id, foreignTeacher)).status === 403 && (await cands(anitaCover.id, tokB)).status === 403);
    const after = await fingerprint();
    check('the published timetable (lessons and version) is unchanged by everything above', before === after);
    const linkCountExpected = JSON.parse(permanentBefore)[0] + 4; // links this test itself created for SG, SH, PH, NQ (not by any assignment)
    check('and PERMANENT teaching data was changed only by this test\'s own setup: no assignment created a link, a grade row or a section assignment', JSON.stringify(JSON.parse(await permanent())) === JSON.stringify([linkCountExpected, JSON.parse(permanentBefore)[1], JSON.parse(permanentBefore)[2]]));
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
