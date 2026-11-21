// Automatic substitution end to end: buildApp() + app.inject() against the disposable local *_test database.
//   source <guard>/local_test_env.sh && npx tsx test-auto-substitution-api.ts
import 'dotenv/config';
import './test-fixtures/test-security-env.js';
import { createHash, randomUUID } from 'node:crypto';
import { buildApp } from './src/app.js';
import appPrisma from './src/config/database.js';
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
const PASSWORD = 'AutoSubst#Test-2030';
const UUID0 = '00000000-0000-4000-8000-000000000000';

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\w*\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not a local *_test database');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('AUTOSUB');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('AUTOSUB');
  const worlds: World[] = [worldA, worldB];

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
    const school = worldA.schoolId;
    let monday = '2030-03-01';
    while (weekdayOf(monday) !== 'MONDAY') monday = eachDate(monday, '2030-03-10')[1]!;
    const mondayN = (n: number): string => { const d = new Date(`${monday}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + 7 * n); return d.toISOString().slice(0, 10); };

    // ---- school: 8 periods, a BREAK after period 3 --------------------------------------------------------------------------------------
    const year = await prisma.academicYear.create({ data: { schoolId: school, name: 'AUTO-A', startDate: new Date('2030-01-01'), endDate: new Date('2030-12-31'), status: 'ACTIVE' } });
    const config = await prisma.scheduleConfig.create({ data: { academicYearId: year.id, periodsPerDay: 8, breakAfterPeriod: 3 } });
    await prisma.scheduleDay.create({ data: { scheduleConfigId: config.id, dayOfWeek: 'MONDAY' } });
    const g8 = await prisma.grade.create({ data: { academicYearId: year.id, name: 'G8', displayOrder: 1 } });
    const sections: string[] = [];
    for (let i = 1; i <= 12; i++) sections.push((await prisma.section.create({ data: { gradeId: g8.id, name: `S${i}`, code: `S${i}` } })).id);
    const sec = (n: number): string => sections[n - 1]!;
    const subj = async (code: string) => (await prisma.subject.create({ data: { schoolId: school, name: code, code } })).id;
    const [MATH, SCI, ENG] = [await subj('MATH'), await subj('SCI'), await subj('ENG')] as [string, string, string];
    const teacher = async (name: string, over: { schoolId?: string; isActive?: boolean } = {}) => (await prisma.teacher.create({ data: { schoolId: over.schoolId ?? school, name, ...(over.isActive === false ? { isActive: false } : {}) } })).id;
    const link = async (teacherId: string, subjectId: string, type: 'PRIMARY' | 'SECONDARY', gradeScope: 'ALL_GRADES' | 'SELECTED_GRADES' = 'ALL_GRADES') => (await prisma.teacherSubject.create({ data: { teacherId, subjectId, type, gradeScope } })).id;

    // absent-able teachers
    const [A1, A2, A3, A4] = [await teacher('A1 absent maths'), await teacher('A2 absent science'), await teacher('A3 absent maths'), await teacher('A4 absent maths')] as [string, string, string, string];
    // pool
    const M1 = await teacher('M1 maths, heavy week'); await link(M1, MATH, 'PRIMARY');
    const M2 = await teacher('M2 maths, free'); await link(M2, MATH, 'PRIMARY');
    const M2b = await teacher('M2b maths, free'); await link(M2b, MATH, 'PRIMARY');
    const M3 = await teacher('M3 maths secondary'); await link(M3, MATH, 'SECONDARY');
    const AAA = await teacher('AAA maths, selected grades, no grade row'); await link(AAA, MATH, 'PRIMARY', 'SELECTED_GRADES');
    const SC = await teacher('SC science'); await link(SC, SCI, 'PRIMARY');
    const SCM = await teacher('SCM science and maths'); await link(SCM, SCI, 'PRIMARY'); await link(SCM, MATH, 'PRIMARY');
    const MF = await teacher('MF maths, lesson far away (P8)'); await link(MF, MATH, 'PRIMARY');
    const MG = await teacher('MG maths, lesson adjacent (P5)'); await link(MG, MATH, 'PRIMARY');
    const MC = await teacher('MC maths, lessons P5-P7'); await link(MC, MATH, 'PRIMARY');
    const U1 = await teacher('U1 english, one lesson'); await link(U1, ENG, 'PRIMARY');
    const U2 = await teacher('U2 english, free'); await link(U2, ENG, 'PRIMARY');
    const INACT = await teacher('INACT inactive maths', { isActive: false }); await link(INACT, MATH, 'PRIMARY');
    const POOL = [A1, A2, A3, A4, M1, M2, M2b, M3, AAA, SC, SCM, MF, MG, MC, U1, U2, INACT];

    const version = await prisma.timetableVersion.create({ data: { schoolId: school, academicYearId: year.id, versionNumber: 1, status: 'PUBLISHED', solutionSource: 'CP_SAT', solverStatus: 'OPTIMAL', weightsVersion: 'V1', inputHash: 'h1', inputSnapshot: {}, metrics: {}, baselineMetrics: {}, publishedAt: new Date() } });
    const lesson = (teacherId: string, sectionNo: number, period: number, subjectId: string) => ({ versionId: version.id, teacherId, sectionId: sec(sectionNo), subjectId, subjectRequirementId: randomUUID(), dayOfWeek: 'MONDAY' as const, periodNumber: period });
    await prisma.timetableEntry.createMany({ data: [
      lesson(A1, 1, 2, MATH), lesson(A1, 2, 3, MATH), lesson(A1, 1, 6, MATH),
      lesson(A2, 3, 2, SCI), lesson(A2, 4, 4, SCI),
      lesson(A3, 5, 2, MATH), lesson(A3, 6, 4, MATH),
      lesson(A4, 7, 2, MATH),
      lesson(M1, 8, 1, MATH), lesson(M1, 8, 2, MATH), lesson(M1, 8, 5, MATH), lesson(M1, 8, 7, MATH), lesson(M1, 8, 8, MATH),
      lesson(MF, 9, 8, MATH), lesson(MG, 9, 5, MATH), lesson(MC, 10, 5, MATH), lesson(MC, 10, 6, MATH), lesson(MC, 10, 7, MATH),
      lesson(U1, 11, 8, ENG),
    ] });
    const timetableFingerprint = async (versionId = version.id) => {
      const rows = await prisma.timetableEntry.findMany({ where: { versionId }, orderBy: { id: 'asc' } });
      const v = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: versionId } });
      return createHash('sha256').update(JSON.stringify([rows, v.status, v.revision, v.updatedAt])).digest('hex');
    };
    const v1RowsHash = createHash('sha256').update(JSON.stringify(await prisma.timetableEntry.findMany({ where: { versionId: version.id }, orderBy: { id: 'asc' } }))).digest('hex');
    const permanent = async () => JSON.stringify([
      await prisma.teacherSubject.count({ where: { teacher: { schoolId: school } } }),
      await prisma.teacherSubjectGrade.count({ where: { teacherSubject: { teacher: { schoolId: school } } } }),
      await prisma.sectionSubjectTeacher.count({ where: { teacher: { schoolId: school } } }),
    ]);
    const permanentBefore = await permanent();

    const post = (url: string, body: unknown, tok = tokA) => call('POST', url, tok, body);
    /** Everyone in the pool except `keep` is unavailable all day on `date`: scenarios control who can cover. */
    const only = async (date: string, keep: string[]) => { for (const t of POOL) if (!keep.includes(t)) await post('/api/teacher-unavailability', { teacherId: t, date }); };
    const absent = (teacherId: string, date: string, extra: Record<string, unknown> = {}) => post('/api/teacher-absences', { teacherId, startDate: date, endDate: date, ...extra });
    const coversOf = async (absenceId: string, tok = tokA) => (await call('GET', `/api/substitutions?absenceId=${absenceId}&status=OPEN,ASSIGNED`, tok)).body.data.items as any[];
    const coverAt = (items: any[], period: number) => items.find((c) => c.periodNumber === period);
    const auto = (a: any) => a.body.data.automaticAllocation;
    const eventsOf = async (coverId: string) => (await prisma.coverEvent.findMany({ where: { coverRequestId: coverId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
    const noDoubleBooking = async () => {
      const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM (SELECT 1 FROM "cover_requests" WHERE "schoolId" = ${school} AND "status" = 'ASSIGNED'::"CoverStatus" GROUP BY "replacementTeacherId", "date", "periodNumber" HAVING count(*) > 1) x`;
      return Number(rows[0]!.n) === 0;
    };

    // ===========================================================================================================
    section('1. One absent teacher, one lesson (partial-day): the best free teacher is assigned at once');
    const d1 = mondayN(0);
    await only(d1, [M1, M2, M3, AAA, U1, U2, INACT, SC]);
    const r1 = await absent(A1, d1, { scope: 'PERIODS', fromPeriod: 6, toPeriod: 6 });
    const a1 = auto(r1);
    check('POST /teacher-absences → 201; the existing fields are still there (absence, coverRequestsCreated, datesWithoutPublishedTimetable, ambiguousDates)', r1.status === 201 && !!r1.body.data.absence.id && r1.body.data.coverRequestsCreated === 1 && r1.body.data.datesWithoutPublishedTimetable === 0 && Array.isArray(r1.body.data.ambiguousDates));
    check('automaticAllocation summary: 1 affected lesson, 1 assigned automatically, 0 unfilled, 0 temporary', a1.status === 'COMPLETED' && a1.totalAffectedLessons === 1 && a1.assigned === 1 && a1.automaticallyAssigned === 1 && a1.unfilled === 0 && a1.temporaryUnqualifiedCovers === 0 && a1.needsAdminAttention === 0, JSON.stringify(a1).slice(0, 300));
    const c1 = a1.covers[0];
    check('  M2 is chosen: a maths teacher, grade-eligible (ALL_GRADES) and with no lessons; not M1 (busy week), not AAA (no grade row), not M3 (secondary), not the unqualified', c1.replacementTeacher.id === M2 && c1.status === 'ASSIGNED' && c1.assignmentSource === 'AUTOMATIC' && c1.temporaryUnqualified === false && c1.attention === null);
    const ev1 = await eventsOf(c1.id);
    check('  the audit trail has CREATED then AUTO_ASSIGNED (actor = the admin who recorded the absence)', ev1.map((e) => e.action).join() === 'CREATED,AUTO_ASSIGNED' && ev1[1]!.actorAdminId === worldA.adminId && ev1[1]!.toTeacherId === M2);
    const det = ev1[1]!.details as any;
    check('  the event explains WHY: tier, subject basis, grade eligibility, workload, run, number of candidates, the next best and the exclusion counts', det.mode === 'AUTOMATIC' && det.tierKey === 'SAME_SUBJECT' && det.subjectBasis === 'PRIMARY_LINK' && det.gradeEligible === true && det.weeklyLoad === 0 && det.consecutive.resultingRun === 1 && det.candidatesConsidered >= 3 && det.nextBest.length >= 1 && det.excludedCounts.UNAVAILABLE >= 1 && Array.isArray(det.rankingOrder));
    const detail = await call('GET', `/api/substitutions/${c1.id}`, tokA);
    check('  GET /substitutions/:id exposes assignmentSource, temporaryUnqualified, attention and each history event\'s details', detail.body.data.assignmentSource === 'AUTOMATIC' && detail.body.data.temporaryUnqualified === false && detail.body.data.attention === null && detail.body.data.history[1].action === 'AUTO_ASSIGNED' && detail.body.data.history[1].details.tierKey === 'SAME_SUBJECT');
    const cd = (await call('GET', `/api/substitutions/${c1.id}/candidates?includeExcluded=true`, tokA)).body.data;
    check('  the candidates list shows gradeEligible, weeklyLoad, recentCovers and temporaryUnqualified, and why others were excluded', cd.candidates.every((c: any) => typeof c.gradeEligible === 'boolean' && typeof c.weeklyLoad === 'number' && typeof c.temporaryUnqualified === 'boolean') && Array.isArray(cd.excluded) && cd.excluded.some((x: any) => x.reason === 'ASSIGNED_ALREADY' || x.reason === 'ALREADY_COVERING' || x.reason === 'UNAVAILABLE'));

    section('2. One absent teacher, several lessons (full-day), fair distribution, no overlapping assignment');
    const d2 = mondayN(1);
    await only(d2, [M2, M2b]);
    const r2 = await absent(A1, d2);
    const a2 = auto(r2);
    check('three lessons (P2, P3, P6) → all assigned automatically', a2.totalAffectedLessons === 3 && a2.assigned === 3 && a2.automaticallyAssigned === 3 && a2.unfilled === 0);
    const per2 = new Map<string, number>(); for (const c of a2.covers) per2.set(c.replacementTeacher.id, (per2.get(c.replacementTeacher.id) ?? 0) + 1);
    check('  split between the two equal teachers, not all to one (fair distribution)', per2.size === 2 && Math.max(...per2.values()) === 2, JSON.stringify([...per2]));
    check('  nobody is double-booked', await noDoubleBooking());

    section('3. Fairness across days: yesterday\'s substitute is not chosen again when an equal teacher exists');
    const d3 = mondayN(2);
    await only(d3, [M2, M2b]);
    const first3 = auto(await absent(A2, d3, { scope: 'PERIODS', fromPeriod: 4, toPeriod: 4 })).covers[0].replacementTeacher.id;
    const d3b = mondayN(3);
    await only(d3b, [M2, M2b]);
    const second3 = auto(await absent(A2, d3b, { scope: 'PERIODS', fromPeriod: 4, toPeriod: 4 })).covers[0].replacementTeacher.id;
    check('two consecutive weeks, same pool: different substitutes (fewer recent covers wins)', first3 !== second3, `${first3} ${second3}`);

    section('4. Multiple absent teachers on the same day: coordinated, nobody double-booked, scarce teachers kept for the lessons that need them');
    const d4 = mondayN(4);
    await only(d4, [M2, SCM]);
    const r4a = await absent(A2, d4, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2 }); // science P2: only SCM teaches it
    const r4b = await absent(A4, d4, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2 }); // maths P2: M2 or SCM
    check('science lesson → SCM (the only science teacher), maths lesson → M2 (SCM is already reserved in P2)', auto(r4a).covers[0].replacementTeacher.id === SCM && auto(r4b).covers[0].replacementTeacher.id === M2);
    // one request carrying BOTH absent teachers' lessons at once: the second absence is recorded with autoAssign=false, then one allocation handles both
    const d4b = mondayN(5);
    await only(d4b, [M2, SCM]);
    const x4 = await absent(A4, d4b, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2, autoAssign: false });
    const y4 = await absent(A2, d4b, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2, autoAssign: false });
    check('(setup) two absences recorded with autoAssign=false stay OPEN', auto(x4).status === 'DISABLED' && auto(x4).assigned === 0 && auto(x4).unfilled === 1 && auto(y4).unfilled === 1);
    const range = await post('/api/substitutions/auto-assign', { from: d4b, to: d4b });
    const coversBoth = [...(await coversOf(x4.body.data.absence.id)), ...(await coversOf(y4.body.data.absence.id))];
    const sciCover = coversBoth.find((c) => c.subject.code === 'SCI');
    const mathCover = coversBoth.find((c) => c.subject.code === 'MATH');
    check('one coordinated run over BOTH lessons: even though the maths lesson sorts first, SCM goes to science and M2 to maths (scarcity-aware)', range.status === 200 && range.body.data.run.assigned === 2 && sciCover.replacementTeacher.id === SCM && mathCover.replacementTeacher.id === M2, JSON.stringify(range.body.data.run));
    check('  an absent teacher is never used as a substitute for another absent teacher (A2 and A4 are absent but also free of lessons in other periods)', !coversBoth.some((c) => [A1, A2, A3, A4].includes(c.replacementTeacher.id)));
    check('  nobody is double-booked', await noDoubleBooking());

    section('5. Qualified preferred; grade-eligible preferred; lower workload; consecutive-period preference');
    const d5 = mondayN(6);
    await only(d5, [M1, M2, M3, AAA, U2]);
    check('qualified over unqualified, grade-eligible (ALL_GRADES) M2 over AAA (primary but no grade row, earlier name), and lighter week M2 over M1', auto(await absent(A4, d5)).covers[0].replacementTeacher.id === M2);
    const d5b = mondayN(7);
    await only(d5b, [M1, AAA]);
    check('with only M1 (5 lessons a week) and AAA (not grade-eligible, no lessons): AAA is not preferred by grade but M1 is not either: grade-eligibility is equal (neither), the LIGHTER week wins → AAA', auto(await absent(A4, d5b)).covers[0].replacementTeacher.id === AAA);
    const d5c = mondayN(8);
    await only(d5c, [MF, MG]);
    check('equal weekly load (1 lesson each): the teacher whose P8 lesson is far from the P4 cover beats the one whose P5 lesson is adjacent (shorter consecutive run)', auto(await absent(A3, d5c, { scope: 'PERIODS', fromPeriod: 4, toPeriod: 4 })).covers[0].replacementTeacher.id === MF);
    const d5d = mondayN(9);
    await only(d5d, [MC]);
    const four = auto(await absent(A3, d5d, { scope: 'PERIODS', fromPeriod: 4, toPeriod: 4 }));
    check('only MC is free and would teach P4-P7 (four in a row): under the default PREFER_AVOID it is assigned as a LAST RESORT, said so in the history', four.assigned === 1 && four.covers[0].replacementTeacher.id === MC && /LAST RESORT/.test((await eventsOf(four.covers[0].id))[1]!.note ?? '') && ((await eventsOf(four.covers[0].id))[1]!.details as any).lastResort === true, JSON.stringify(four.covers[0]).slice(0, 200));
    const d5e = mondayN(10);
    await only(d5e, [M1, U1]);
    const lessonConflict = auto(await absent(A1, d5e, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2 }));
    check('M1 has a lesson in P2 and U1 does not: M1 is excluded by the timetable conflict, U1 covers (temporary, unqualified)', lessonConflict.covers[0].replacementTeacher.id === U1);

    section('6. Temporary unqualified cover and the fallback switch');
    const d6 = mondayN(11);
    await only(d6, [U2]);
    const linksBefore = await permanent();
    const r6 = await absent(A4, d6);
    const a6 = auto(r6);
    check('only an English teacher is free: assigned as TEMPORARY, UNQUALIFIED cover and reported as such', a6.assigned === 1 && a6.temporaryUnqualifiedCovers === 1 && a6.covers[0].temporaryUnqualified === true && a6.covers[0].replacementTeacher.id === U2);
    const ev6 = await eventsOf(a6.covers[0].id);
    check('  the history note says so, and the permanent teaching data is unchanged (no link, no grade row)', /TEMPORARY, UNQUALIFIED/.test(ev6[1]!.note ?? '') && (ev6[1]!.details as any).temporaryUnqualified === true && (await permanent()) === linksBefore);
    const d6b = mondayN(12);
    await only(d6b, [U2]);
    const r6b = await absent(A4, d6b, { allowTemporaryCover: false });
    check('allowTemporaryCover=false: the same situation leaves the lesson OPEN with NO_QUALIFIED_TEACHER', auto(r6b).assigned === 0 && auto(r6b).covers[0].attention.code === 'NO_QUALIFIED_TEACHER' && auto(r6b).allowTemporaryCover === false);

    section('7. No substitute available: stays OPEN, reported once, retried safely, filled when someone becomes free');
    const d7 = mondayN(13);
    await only(d7, []);
    const r7 = await absent(A4, d7);
    const a7 = auto(r7);
    check('nobody free: 1 affected, 0 assigned, 1 unfilled needing attention (NO_AVAILABLE_TEACHER)', a7.totalAffectedLessons === 1 && a7.assigned === 0 && a7.unfilled === 1 && a7.needsAdminAttention === 1 && a7.covers[0].status === 'OPEN' && a7.covers[0].attention.code === 'NO_AVAILABLE_TEACHER');
    const unfilledId = a7.covers[0].id;
    const again = await post(`/api/teacher-absences/${r7.body.data.absence.id}/auto-assign`, {});
    const again2 = await post(`/api/teacher-absences/${r7.body.data.absence.id}/auto-assign`, {});
    const unfilledEvents = (await eventsOf(unfilledId)).filter((e) => e.action === 'AUTO_UNFILLED').length;
    check('retrying (twice) is idempotent: still unfilled, and the "no substitute" event was written once', again.status === 200 && again2.status === 200 && again2.body.data.unfilled === 1 && unfilledEvents === 1, `events=${unfilledEvents}`);
    const mark = await prisma.teacherUnavailability.findFirstOrThrow({ where: { teacherId: M2, date: new Date(`${d7}T00:00:00.000Z`), status: 'ACTIVE' } });
    await call('DELETE', `/api/teacher-unavailability/${mark.id}`, tokA);
    const filled = await post(`/api/teacher-absences/${r7.body.data.absence.id}/auto-assign`, {});
    check('M2 becomes free → POST /teacher-absences/:id/auto-assign assigns it and clears the attention flag', filled.body.data.assigned === 1 && filled.body.data.run.assigned === 1 && filled.body.data.covers[0].replacementTeacher.id === M2 && filled.body.data.covers[0].attention === null);
    const inactiveOnly = mondayN(14);
    await only(inactiveOnly, [INACT]);
    check('an inactive teacher is never chosen (the only "free" teacher is inactive → unfilled)', auto(await absent(A4, inactiveOnly)).unfilled === 1);
    const d7c = mondayN(15);
    await only(d7c, [M2]);
    const manualFirst = await absent(A1, d7c, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2, autoAssign: false });
    const mc = (await coversOf(manualFirst.body.data.absence.id))[0];
    await call('PUT', `/api/substitutions/${mc.id}/assignment`, tokA, { teacherId: M2 });
    const blocked = auto(await absent(A4, d7c, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2 }));
    check('a teacher already assigned as a substitute in that period is excluded (ALREADY_COVERING): the second lesson stays OPEN', blocked.assigned === 0 && blocked.unfilled === 1);
    check('the absent teacher is excluded as a substitute (A3 absent, A4 absent: neither covers the other)', !(await prisma.coverRequest.findMany({ where: { schoolId: school, status: 'ASSIGNED', replacementTeacherId: { in: [A1, A2, A3, A4] } } })).length);

    // ===========================================================================================================
    section('8. Manual override respects, and is respected by, the allocator');
    const d8 = mondayN(16);
    await only(d8, [M2, M2b, M3]);
    const r8 = await absent(A4, d8);
    const c8 = auto(r8).covers[0];
    check('(setup) automatically assigned to a qualified free teacher (M2 or M2b: whoever has fewer recent covers)', [M2, M2b].includes(c8.replacementTeacher.id) && c8.assignmentSource === 'AUTOMATIC');
    const re8 = await call('PUT', `/api/substitutions/${c8.id}/assignment`, tokA, { teacherId: M3 });
    check('the admin reassigns to M3 through the existing API: 200, now MANUAL', re8.status === 200 && re8.body.data.replacementTeacher.id === M3 && re8.body.data.assignmentSource === 'MANUAL' && re8.body.data.temporaryUnqualified === false);
    const h8 = (await eventsOf(c8.id)).map((e) => e.action).join();
    check('  the history keeps the automatic assignment and records the REASSIGNED (previous substitute replaced)', h8 === 'CREATED,AUTO_ASSIGNED,REASSIGNED');
    const run8 = await post(`/api/teacher-absences/${r8.body.data.absence.id}/auto-assign`, {});
    const patch8 = await call('PATCH', `/api/teacher-absences/${r8.body.data.absence.id}`, tokA, { reason: 'still ill' });
    const range8 = await post('/api/substitutions/auto-assign', { from: d8, to: d8 });
    const now8 = (await call('GET', `/api/substitutions/${c8.id}`, tokA)).body.data;
    check('re-running the allocator (absence endpoint, absence edit, range endpoint) NEVER overwrites the admin\'s choice', run8.body.data.run.assigned === 0 && patch8.status === 200 && range8.body.data.run.assigned === 0 && now8.replacementTeacher.id === M3 && now8.assignmentSource === 'MANUAL');
    const un8 = await call('DELETE', `/api/substitutions/${c8.id}/assignment`, tokA);
    check('unassigning reopens the request (source cleared)', un8.status === 200 && un8.body.data.status === 'OPEN' && un8.body.data.assignmentSource === null);
    const reauto = await post(`/api/teacher-absences/${r8.body.data.absence.id}/auto-assign`, {});
    check('once the assignment is explicitly removed the allocator may fill it again', reauto.body.data.run.assigned === 1 && reauto.body.data.covers[0].assignmentSource === 'AUTOMATIC');
    const cancel8 = await call('POST', `/api/substitutions/${c8.id}/cancel`, tokA, { reason: 'class dismissed' });
    const afterCancel = await post(`/api/teacher-absences/${r8.body.data.absence.id}/auto-assign`, {});
    check('a cancelled cover request is final: the allocator does not resurrect it', cancel8.status === 200 && afterCancel.body.data.totalAffectedLessons === 0 && (await prisma.coverRequest.findUniqueOrThrow({ where: { id: c8.id } })).status === 'CANCELLED');

    // ===========================================================================================================
    section('9. Absence edit, cancellation, and a substitute who is later absent / unavailable');
    const d9 = mondayN(17);
    await only(d9, [M2, M2b, M3]);
    const r9 = await absent(A1, d9, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2 });
    const abs9 = r9.body.data.absence.id;
    check('(setup) A1 absent P2 only → one lesson assigned', auto(r9).assigned === 1);
    const grow = await call('PATCH', `/api/teacher-absences/${abs9}`, tokA, { fromPeriod: 2, toPeriod: 6 });
    const g = grow.body.data.automaticAllocation;
    check('the periods are extended (P2-P6): the new lessons (P3, P6) are created AND assigned automatically; the existing assignment is untouched', grow.status === 200 && grow.body.data.coverRequestsCreated === 2 && g.totalAffectedLessons === 3 && g.assigned === 3 && g.run.assigned === 2);
    const before9 = (await prisma.coverEvent.findMany({ where: { schoolId: school } })).map((e) => e.id);
    const shrink = await call('PATCH', `/api/teacher-absences/${abs9}`, tokA, { fromPeriod: 6, toPeriod: 6 });
    const s = shrink.body.data.automaticAllocation;
    check('shrunk to P6 only: the P2/P3 lessons fall outside, their AUTOMATIC assignments are cancelled with the absence (no 409), P6 stays assigned', shrink.status === 200 && shrink.body.data.coverRequestsCancelled === 2 && s.totalAffectedLessons === 1 && s.assigned === 1);
    const cancelledCovers = await prisma.coverRequest.findMany({ where: { absenceId: abs9, status: 'CANCELLED' } });
    check('  cancelled with ABSENCE_CHANGED, the replacement kept for history', cancelledCovers.length === 2 && cancelledCovers.every((c) => c.cancelReason === 'ABSENCE_CHANGED' && c.replacementTeacherId !== null));
    const back = await call('PATCH', `/api/teacher-absences/${abs9}`, tokA, { fromPeriod: 2, toPeriod: 6 });
    check('extended again: the dropped lessons are REOPENED (no duplicate requests) and assigned again automatically', back.body.data.coverRequestsReopened === 2 && back.body.data.automaticAllocation.assigned === 3 && (await prisma.coverRequest.count({ where: { absenceId: abs9 } })) === 3);
    const manualAfter = await coversOf(abs9);
    await call('PUT', `/api/substitutions/${coverAt(manualAfter, 6).id}/assignment`, tokA, { teacherId: M3 });
    const shrinkManual = await call('PATCH', `/api/teacher-absences/${abs9}`, tokA, { fromPeriod: 2, toPeriod: 3 });
    check('a MANUALLY assigned lesson blocks shrinking the absence (409 ASSIGNED_COVERS_OUTSIDE), exactly as before', shrinkManual.status === 409 && codeOf(shrinkManual) === 'ASSIGNED_COVERS_OUTSIDE');
    const cancelManual = await post(`/api/teacher-absences/${abs9}/cancel`, {});
    check('and a manual assignment blocks cancelling the absence (409 ASSIGNED_COVERS_EXIST); nothing was changed by the refused calls', cancelManual.status === 409 && codeOf(cancelManual) === 'ASSIGNED_COVERS_EXIST' && (await prisma.coverRequest.count({ where: { absenceId: abs9, status: 'ASSIGNED' } })) === 3);
    await call('DELETE', `/api/substitutions/${coverAt(manualAfter, 6).id}/assignment`, tokA);
    const cancelOk = await post(`/api/teacher-absences/${abs9}/cancel`, {});
    check('after the manual assignment is removed, cancelling the absence cancels the automatic assignments too', cancelOk.status === 200 && cancelOk.body.data.automaticAssignmentsCancelled >= 2 && (await prisma.coverRequest.count({ where: { absenceId: abs9, status: { in: ['OPEN', 'ASSIGNED'] } } })) === 0);
    const afterIds = new Set((await prisma.coverEvent.findMany({ where: { schoolId: school } })).map((e) => e.id));
    check('historical audit events are preserved: every event that existed before the edit/cancel still exists', before9.every((id) => afterIds.has(id)));

    const d9b = mondayN(18);
    await only(d9b, [M2, M2b, U2]);
    const r9b = await absent(A1, d9b, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2 });
    const sub9 = auto(r9b).covers[0].replacementTeacher.id;
    const absSub = await absent(sub9, d9b);
    const cv9 = (await call('GET', `/api/substitutions/${auto(r9b).covers[0].id}`, tokA)).body.data;
    check('the automatic substitute is then recorded ABSENT: the absence is accepted (201), the lesson is released and given to another teacher', absSub.status === 201 && cv9.status === 'ASSIGNED' && cv9.replacementTeacher.id !== sub9 && cv9.history.some((h: any) => h.action === 'AUTO_RELEASED' && h.fromTeacher.id === sub9) && (await noDoubleBooking()));
    const d9c = mondayN(19);
    await only(d9c, [M2, M2b, U2]);
    const r9c = await absent(A1, d9c, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2 });
    const sub9c = auto(r9c).covers[0].replacementTeacher.id;
    const unav = await post('/api/teacher-unavailability', { teacherId: sub9c, date: d9c });
    const cv9c = (await call('GET', `/api/substitutions/${auto(r9c).covers[0].id}`, tokA)).body.data;
    check('the automatic substitute is marked UNAVAILABLE: accepted (201), released and reallocated, reported in automaticReallocation', unav.status === 201 && unav.body.data.automaticReallocation.run.assigned === 1 && cv9c.replacementTeacher.id !== sub9c && cv9c.status === 'ASSIGNED');
    const d9d = mondayN(20);
    await only(d9d, [M2, M2b]);
    const r9d = await absent(A1, d9d, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2, autoAssign: false });
    const cov9d = (await coversOf(r9d.body.data.absence.id))[0];
    await call('PUT', `/api/substitutions/${cov9d.id}/assignment`, tokA, { teacherId: M2 });
    const absManualSub = await absent(M2, d9d);
    check('a MANUALLY assigned substitute cannot be recorded absent (409 TEACHER_IS_COVERING), as before', absManualSub.status === 409 && codeOf(absManualSub) === 'TEACHER_IS_COVERING');

    // ===========================================================================================================
    section('10. Duplicate submission, retry after a failed allocation, ambiguous result');
    const d10 = mondayN(21);
    await only(d10, [M2, M2b]);
    const r10 = await absent(A1, d10);
    const dup = await absent(A1, d10);
    const snap = async (absenceId: string) => JSON.stringify((await coversOf(absenceId)).map((c) => [c.id, c.status, c.replacementTeacher?.id]).sort());
    check('submitting the same absence twice: the second is a 409 ABSENCE_OVERLAP naming the first; no duplicate absence, requests or assignments', dup.status === 409 && codeOf(dup) === 'ABSENCE_OVERLAP' && dup.body.errors.absenceId[0] === r10.body.data.absence.id && (await prisma.coverRequest.count({ where: { absenceId: r10.body.data.absence.id } })) === 3 && (await prisma.teacherAbsence.count({ where: { teacherId: A1, startDate: new Date(`${d10}T00:00:00.000Z`), status: 'ACTIVE' } })) === 1);
    const snap1 = await snap(r10.body.data.absence.id);
    const retried = await post(`/api/teacher-absences/${r10.body.data.absence.id}/auto-assign`, {});
    check('an ambiguous result is recovered with GET .../substitution-summary and POST .../auto-assign: nothing changes, nothing is duplicated', retried.body.data.run.assigned === 0 && snap1 === (await snap(r10.body.data.absence.id)) && (await call('GET', `/api/teacher-absences/${r10.body.data.absence.id}/substitution-summary`, tokA)).body.data.assigned === 3);

    const d10b = mondayN(22);
    await only(d10b, [M2, M2b]);
    let calls = 0; let armed = true;
    const original = appPrisma.$transaction.bind(appPrisma);
    (appPrisma as any).$transaction = (...args: any[]) => { calls++; if (armed && calls >= 2) { armed = false; return Promise.reject(new Error('simulated database failure')); } return (original as any)(...args); };
    let r10b: Reply;
    try { r10b = await absent(A1, d10b, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2 }); } finally { (appPrisma as any).$transaction = original; }
    check('the allocation fails after the absence was committed: still 201, absence recorded, automaticAllocation.status FAILED with a retry hint, nothing leaked', r10b.status === 201 && auto(r10b).status === 'FAILED' && /auto-assign/.test(auto(r10b).error) && !/simulated/.test(JSON.stringify(r10b.body)) && auto(r10b).assigned === 0 && auto(r10b).unfilled === 1);
    const retry10b = await post(`/api/teacher-absences/${r10b.body.data.absence.id}/auto-assign`, {});
    check('  the retry completes the work', retry10b.body.data.assigned === 1 && retry10b.body.data.run.assigned === 1);

    // ===========================================================================================================
    section('11. Concurrency');
    const d11 = mondayN(23);
    await only(d11, [M2]);
    const both = await Promise.all([absent(A1, d11, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2 }), absent(A4, d11, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2 })]);
    const assignedP2 = await prisma.coverRequest.count({ where: { schoolId: school, date: new Date(`${d11}T00:00:00.000Z`), periodNumber: 2, status: 'ASSIGNED' } });
    check('two cover requests chasing the same only-available teacher in the same period: both absences are recorded, EXACTLY ONE gets M2', both.every((b) => b.status === 201) && assignedP2 === 1 && (await noDoubleBooking()));
    const d11b = mondayN(24);
    await only(d11b, [M2, M2b, M3]);
    const four4 = await Promise.all([absent(A1, d11b), absent(A2, d11b), absent(A3, d11b), absent(A4, d11b)]);
    const rowsP = await prisma.coverRequest.findMany({ where: { schoolId: school, date: new Date(`${d11b}T00:00:00.000Z`), status: 'ASSIGNED' } });
    const byslot = new Set(rowsP.map((r) => `${r.replacementTeacherId}|${r.periodNumber}`));
    const p2 = rowsP.filter((r) => r.periodNumber === 2);
    check('four absences submitted simultaneously: all recorded (201), no overlapping assignment, P2 (4 lessons) has exactly 3 substitutes for 3 teachers, none of them absent', four4.every((b) => b.status === 201) && byslot.size === rowsP.length && p2.length === 3 && !rowsP.some((r) => [A1, A2, A3, A4].includes(r.replacementTeacherId!)) && (await noDoubleBooking()));
    let okAll = true; let statuses = '';
    for (let k = 0; k < 4; k++) {
      const dk = mondayN(25 + k);
      await only(dk, [M2, M2b, M3]);
      const rk = await absent(A4, dk, { autoAssign: false });
      const ck = (await coversOf(rk.body.data.absence.id))[0];
      const [x, y] = await Promise.all([post(`/api/teacher-absences/${rk.body.data.absence.id}/auto-assign`, {}), call('PUT', `/api/substitutions/${ck.id}/assignment`, tokA, { teacherId: M3 })]);
      const fin = await prisma.coverRequest.findUniqueOrThrow({ where: { id: ck.id } });
      statuses += `${x.status}/${y.status} `;
      const evs = (await eventsOf(ck.id)).map((e) => e.action);
      if (![200].includes(x.status) || ![200].includes(y.status) || fin.status !== 'ASSIGNED' || fin.assignmentSource !== 'MANUAL' || fin.replacementTeacherId !== M3 || (await prisma.coverRequest.count({ where: { id: ck.id, status: 'ASSIGNED' } })) !== 1 || !(await noDoubleBooking())) okAll = false;
      void evs;
    }
    check('manual and automatic assignment racing for one lesson (4 rounds): no error, exactly one live assignment, the admin\'s choice wins (the manual call ends MANUAL M3 whichever ran first)', okAll, statuses);

    // ===========================================================================================================
    section('12. Past dates are never assigned automatically');
    const pastYear = await prisma.academicYear.create({ data: { schoolId: school, name: 'AUTO-PAST', startDate: new Date('2020-01-01'), endDate: new Date('2020-12-31'), status: 'DRAFT' } });
    const pastVersion = await prisma.timetableVersion.create({ data: { schoolId: school, academicYearId: pastYear.id, versionNumber: 1, status: 'PUBLISHED', solutionSource: 'CP_SAT', solverStatus: 'OPTIMAL', weightsVersion: 'V1', inputHash: 'h-past', inputSnapshot: {}, metrics: {}, baselineMetrics: {}, publishedAt: new Date() } });
    await prisma.timetableEntry.create({ data: { versionId: pastVersion.id, teacherId: A1, sectionId: sec(1), subjectId: MATH, subjectRequirementId: randomUUID(), dayOfWeek: 'MONDAY', periodNumber: 2 } });
    const r12 = await absent(A1, '2020-03-02');
    check('an absence in the past still creates its request but it is not assigned automatically: reported as PAST_DATE needing the admin', r12.status === 201 && auto(r12).totalAffectedLessons === 1 && auto(r12).assigned === 0 && auto(r12).skippedPastDates === 1 && auto(r12).covers[0].attention.code === 'PAST_DATE' && auto(r12).run.skippedPast === 1);

    // ===========================================================================================================
    section('13. Events feed');
    const feed = await call('GET', '/api/substitution-events?limit=500', tokA);
    const types = new Set((feed.body.data.items as any[]).map((i) => i.type));
    check('GET /substitution-events returns the persistent events for notifications: absence recorded, auto-assigned, no substitute, assignment changed, replaced, cancelled, released', feed.status === 200 && ['ABSENCE_RECORDED', 'SUBSTITUTE_AUTO_ASSIGNED', 'NO_SUBSTITUTE_AVAILABLE', 'SUBSTITUTE_REPLACED', 'ASSIGNMENT_CANCELLED', 'SUBSTITUTE_RELEASED', 'ABSENCE_CANCELLED'].every((t) => types.has(t)), [...types].join());
    const items = feed.body.data.items as any[];
    check('  items are ordered oldest first, carry teacher names, the cover request id and the explanation details; nextSince continues the feed', items.every((x, i) => i === 0 || items[i - 1].occurredAt <= x.occurredAt) && items.find((x) => x.type === 'SUBSTITUTE_AUTO_ASSIGNED').toTeacher.name.length > 0 && !!items.find((x) => x.type === 'SUBSTITUTE_AUTO_ASSIGNED').coverRequestId && !!items.find((x) => x.type === 'SUBSTITUTE_AUTO_ASSIGNED').details);
    const empty = await call('GET', `/api/substitution-events?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`, tokA);
    const badSince = await call('GET', '/api/substitution-events?since=nonsense', tokA);
    check('  `since` in the future → no items; an invalid `since` → 400', empty.body.data.items.length === 0 && badSince.status === 400);
    check('  the feed is school-scoped: school B sees none of school A\'s events', (await call('GET', '/api/substitution-events', tokB)).body.data.items.length === 0);

    // ===========================================================================================================
    section('14. Security');
    const secured: Array<[string, string, unknown?]> = [['POST', `/api/teacher-absences/${UUID0}/auto-assign`, {}], ['GET', `/api/teacher-absences/${UUID0}/substitution-summary`], ['POST', '/api/substitutions/auto-assign', {}], ['GET', '/api/substitution-events']];
    let unauth = true;
    for (const [m, u, b] of secured) { const r = await call(m as 'GET', u, null, b); if (r.status !== 401) unauth = false; }
    check('every new endpoint needs authentication (401 without a session)', unauth);
    check('invalid ids: a malformed absence id → 400, an unknown one → 404 (auto-assign and summary)', (await post('/api/teacher-absences/not-a-uuid/auto-assign', {})).status === 400 && (await post(`/api/teacher-absences/${UUID0}/auto-assign`, {})).status === 404 && (await call('GET', `/api/teacher-absences/${UUID0}/substitution-summary`, tokA)).status === 404);
    check('invalid teacher ids on POST /teacher-absences: malformed → 400, unknown → 404', (await absent('nope', mondayN(30))).status === 400 && (await absent(UUID0, mondayN(30))).status === 404);
    const absOfA = r10.body.data.absence.id;
    const foreignTeacher = await teacher('Foreign teacher', { schoolId: worldB.schoolId });
    const foreignAbsence = await post('/api/teacher-absences', { teacherId: A1, startDate: mondayN(31), endDate: mondayN(31) }, tokB);
    check('cross-school: school B cannot auto-assign (403), read the summary (403) or record an absence for school A\'s teacher (403); school A cannot assign another school\'s teacher (403)', (await post(`/api/teacher-absences/${absOfA}/auto-assign`, {}, tokB)).status === 403 && (await call('GET', `/api/teacher-absences/${absOfA}/substitution-summary`, tokB)).status === 403 && foreignAbsence.status === 403 && (await call('PUT', `/api/substitutions/${(await coversOf(absOfA))[0].id}/assignment`, tokA, { teacherId: foreignTeacher })).status === 403);
    check('the range endpoint only ever touches the caller\'s school: school B\'s run assigns nothing of school A', (await post('/api/substitutions/auto-assign', {}, tokB)).body.data.run.considered === 0);
    check('the allocator never picks another school\'s teacher (every substitute assigned in school A belongs to school A)', (await prisma.coverRequest.count({ where: { schoolId: school, status: 'ASSIGNED', replacementTeacher: { schoolId: { not: school } } } })) === 0);

    // ===========================================================================================================
    section('15. Republish: a new published version, then re-allocation');
    const d15 = mondayN(35);
    await only(d15, [M2, M2b]);
    const r15 = await absent(A1, d15, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2 });
    const old15 = auto(r15).covers[0];
    await prisma.timetableVersion.update({ where: { id: version.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
    const v2 = await prisma.timetableVersion.create({ data: { schoolId: school, academicYearId: year.id, versionNumber: 2, status: 'PUBLISHED', solutionSource: 'CP_SAT', solverStatus: 'OPTIMAL', weightsVersion: 'V1', inputHash: 'h2', inputSnapshot: {}, metrics: {}, baselineMetrics: {}, publishedAt: new Date() } });
    const entries1 = await prisma.timetableEntry.findMany({ where: { versionId: version.id } });
    await prisma.timetableEntry.createMany({ data: entries1.map((e) => ({ versionId: v2.id, teacherId: e.teacherId, sectionId: e.sectionId, subjectId: e.subjectId, subjectRequirementId: e.subjectRequirementId, dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber })) });
    const v2Before = await timetableFingerprint(v2.id);
    await call('GET', `/api/substitutions?absenceId=${r15.body.data.absence.id}`, tokA); // reconciliation: old request OBSOLETE, a new OPEN one from v2
    const states = (await prisma.coverRequest.findMany({ where: { absenceId: r15.body.data.absence.id }, orderBy: { createdAt: 'asc' } })).map((c) => c.status).join();
    check('after the new version is published the old assignment is OBSOLETE (history kept) and a fresh OPEN request exists; assignments are not carried over silently', states === 'OBSOLETE,OPEN');
    const redo = await post('/api/substitutions/auto-assign', { from: d15, to: d15 });
    check('POST /substitutions/auto-assign allocates the new request from the new version; the published lessons of the new version are unchanged', redo.body.data.run.assigned === 1 && (await prisma.coverRequest.count({ where: { absenceId: r15.body.data.absence.id, status: 'ASSIGNED' } })) === 1 && v2Before === (await timetableFingerprint(v2.id)));
    check('  the obsolete request keeps its full history, including the automatic assignment', (await eventsOf(old15.id)).map((e) => e.action).join() === 'CREATED,AUTO_ASSIGNED,OBSOLETED');

    // ===========================================================================================================
    section('16. Integrity: the published timetable and permanent teaching data were never touched');
    const v1Rows = await prisma.timetableEntry.findMany({ where: { versionId: version.id }, orderBy: { id: 'asc' } });
    check('the published version\'s lessons (hash taken before any allocation) are byte-for-byte unchanged by every allocation above (only its status changed by the republish in section 15, done by the test itself)', createHash('sha256').update(JSON.stringify(v1Rows)).digest('hex') === v1RowsHash && v1Rows.length === 19);
    check('no automatic assignment created or changed a teacher-subject link, a grade eligibility row or a section assignment', (await permanent()) === permanentBefore);
    check('the database invariant holds at the end: no teacher has two assigned covers in one period', await noDoubleBooking());
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
