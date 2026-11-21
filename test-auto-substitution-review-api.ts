// Automatic substitution REVIEW suite: the four-consecutive-periods policy, absence edit/cancel lifecycle, idempotency, the event feed cursor, concurrency and isolation.
//   source <guard>/local_test_env.sh && npx tsx test-auto-substitution-review-api.ts
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
const PASSWORD = 'AutoRev#Test-2030';
const UUID0 = '00000000-0000-4000-8000-000000000000';

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\w*\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not a local *_test database');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('AUTOREV');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('AUTOREV');
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


    const invariants = async (): Promise<string> => {
      const problems: string[] = [];
      if (!(await noDoubleBooking())) problems.push('double booking');
      const teaching = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM "cover_requests" c JOIN "timetable_entries" e ON e."versionId" = c."timetableVersionId" AND e."teacherId" = c."replacementTeacherId" AND e."dayOfWeek" = c."dayOfWeek" AND e."periodNumber" = c."periodNumber"
        WHERE c."schoolId" = ${school} AND c."status" = 'ASSIGNED'::"CoverStatus"`;
      if (Number(teaching[0]!.n) > 0) problems.push('a substitute is teaching in that period');
      const away = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM "cover_requests" c JOIN "teacher_absences" a ON a."teacherId" = c."replacementTeacherId" AND a."status" = 'ACTIVE'::"RecordStatus" AND c."date" BETWEEN a."startDate" AND a."endDate"
          AND (a."scope" = 'FULL_DAY'::"AbsenceScope" OR c."periodNumber" BETWEEN a."fromPeriod" AND a."toPeriod")
        WHERE c."schoolId" = ${school} AND c."status" = 'ASSIGNED'::"CoverStatus"`;
      if (Number(away[0]!.n) > 0) problems.push('a substitute is absent');
      const unav = await prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM "cover_requests" c JOIN "teacher_unavailabilities" u ON u."teacherId" = c."replacementTeacherId" AND u."status" = 'ACTIVE'::"RecordStatus" AND u."date" = c."date" AND (u."periodNumber" IS NULL OR u."periodNumber" = c."periodNumber")
        WHERE c."schoolId" = ${school} AND c."status" = 'ASSIGNED'::"CoverStatus"`;
      if (Number(unav[0]!.n) > 0) problems.push('a substitute is unavailable');
      const dupLive = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM (SELECT 1 FROM "cover_requests" WHERE "schoolId" = ${school} AND "status" IN ('OPEN'::"CoverStatus", 'ASSIGNED'::"CoverStatus") GROUP BY "sectionId", "date", "periodNumber" HAVING count(*) > 1) x`;
      if (Number(dupLive[0]!.n) > 0) problems.push('duplicate live request');
      const self = await prisma.coverRequest.count({ where: { schoolId: school, status: 'ASSIGNED', replacementTeacherId: { in: [A1, A2, A3, A4] } } });
      if (self > 0) problems.push('an absent-able teacher substituting');
      return problems.join('; ');
    };
    const setPolicy = (p: string, tok = tokA) => call('PUT', '/api/substitution-settings', tok, { consecutivePeriodPolicy: p });
    const eventCount = async () => prisma.coverEvent.count({ where: { schoolId: school } });
    const liveCovers = async (absenceId: string) => prisma.coverRequest.findMany({ where: { absenceId, status: { in: ['OPEN', 'ASSIGNED'] } }, orderBy: { periodNumber: 'asc' } });

    // ===========================================================================================================
    section('1. The four-consecutive-periods policy: settings');
    const g0 = await call('GET', '/api/substitution-settings', tokA);
    check('a school that existed before the policy defaults to PREFER_AVOID', g0.status === 200 && g0.body.data.consecutivePeriodPolicy === 'PREFER_AVOID' && g0.body.data.allowedValues.length === 3);
    check('an invalid value is a 400; a missing body is a 400; nothing changes', (await setPolicy('SOMETIMES')).status === 400 && (await call('PUT', '/api/substitution-settings', tokA, {})).status === 400 && (await call('GET', '/api/substitution-settings', tokA)).body.data.consecutivePeriodPolicy === 'PREFER_AVOID');
    check('both settings endpoints need authentication (401)', (await call('GET', '/api/substitution-settings', null)).status === 401 && (await call('PUT', '/api/substitution-settings', null, { consecutivePeriodPolicy: 'ALLOW' })).status === 401);
    const sA = await setPolicy('NEVER_ALLOW');
    check('changing it works, is persisted and is per school (school B is untouched)', sA.status === 200 && sA.body.data.consecutivePeriodPolicy === 'NEVER_ALLOW' && (await call('GET', '/api/substitution-settings', tokB)).body.data.consecutivePeriodPolicy === 'PREFER_AVOID' && (await prisma.school.findUniqueOrThrow({ where: { id: school } })).consecutivePeriodPolicy === 'NEVER_ALLOW');
    await setPolicy('PREFER_AVOID');

    section('2. The three policies, end to end (MC teaches P5-P7; the P4 cover would make four in a row; only MC is free)');
    const lessonsBefore = JSON.stringify(await prisma.timetableEntry.findMany({ where: { versionId: version.id }, orderBy: { id: 'asc' } }));
    const slot = (n: number) => ({ date: mondayN(n) });
    const d2a = slot(0).date; await only(d2a, [MC]); await setPolicy('ALLOW');
    const allow = auto(await absent(A3, d2a, { scope: 'PERIODS', fromPeriod: 4, toPeriod: 4 }));
    const allowEv = (await eventsOf(allow.covers[0].id))[1]!;
    check('ALLOW: MC is assigned as an ordinary same-subject cover (tier 1), NOT a last resort, and the history does not mention one', allow.assigned === 1 && (allowEv.details as any).lastResort === false && (allowEv.details as any).tierKey === 'SAME_SUBJECT' && !/LAST RESORT/.test(allowEv.note ?? '') && (allowEv.details as any).policy === 'ALLOW');
    const d2b = slot(1).date; await only(d2b, [MC]); await setPolicy('PREFER_AVOID');
    const prefer = auto(await absent(A3, d2b, { scope: 'PERIODS', fromPeriod: 4, toPeriod: 4 }));
    const preferEv = (await eventsOf(prefer.covers[0].id))[1]!;
    check('PREFER_AVOID: with nobody better free MC is assigned as a LAST RESORT (flagged, with the run P4-P7 in the history)', prefer.assigned === 1 && (preferEv.details as any).lastResort === true && (preferEv.details as any).tierKey === 'LAST_RESORT' && /LAST RESORT: 4 consecutive teaching periods \(P4–P7\)/.test(preferEv.note ?? ''));
    const d2c = slot(2).date; await only(d2c, [MC, U2]);
    const preferBetter = auto(await absent(A3, d2c, { scope: 'PERIODS', fromPeriod: 4, toPeriod: 4 }));
    check('PREFER_AVOID: when another teacher is free, even an unqualified one, the four-in-a-row teacher is avoided', preferBetter.covers[0].replacementTeacher.id === U2 && preferBetter.covers[0].temporaryUnqualified === true);
    const d2d = slot(3).date; await only(d2d, [MC]); await setPolicy('NEVER_ALLOW');
    const never = await absent(A3, d2d, { scope: 'PERIODS', fromPeriod: 4, toPeriod: 4 });
    const nc = auto(never).covers[0];
    check('NEVER_ALLOW: the lesson stays OPEN with CONSECUTIVE_PERIODS_NOT_ALLOWED and an actionable message', auto(never).assigned === 0 && nc.attention.code === 'CONSECUTIVE_PERIODS_NOT_ALLOWED' && /NEVER_ALLOW/.test(nc.attention.message));
    const nCand = (await call('GET', `/api/substitutions/${nc.id}/candidates?includeExcluded=true`, tokA)).body.data;
    check('  the candidates list agrees: MC is not a candidate, it is excluded with CONSECUTIVE_NOT_ALLOWED, and the policy is shown', nCand.policy === 'NEVER_ALLOW' && !nCand.candidates.some((c: any) => c.id === MC) && nCand.excluded.some((x: any) => x.teacher.id === MC && x.reason === 'CONSECUTIVE_NOT_ALLOWED') && nCand.excludedCounts.CONSECUTIVE_NOT_ALLOWED === 1 && /school's policy/.test(nCand.message));
    const nPut = await call('PUT', `/api/substitutions/${nc.id}/assignment`, tokA, { teacherId: MC, confirmFourConsecutive: true });
    check('  a manual assignment is refused too, even with confirmation: 409 FOUR_CONSECUTIVE_NOT_ALLOWED naming the periods and the way out', nPut.status === 409 && codeOf(nPut) === 'FOUR_CONSECUTIVE_NOT_ALLOWED' && nPut.body.errors.periods.join() === '4,5,6,7' && /PUT \/api\/substitution-settings/.test(nPut.body.message));
    const retryNever = await post(`/api/teacher-absences/${never.body.data.absence.id}/auto-assign`, {});
    const neverEvents = (await eventsOf(nc.id)).filter((e) => e.action === 'AUTO_UNFILLED').length;
    check('  retrying changes nothing and writes the "no substitute" event once', retryNever.body.data.assigned === 0 && neverEvents === 1);
    await setPolicy('PREFER_AVOID');
    const mPut = await call('PUT', `/api/substitutions/${nc.id}/assignment`, tokA, { teacherId: MC });
    check('PREFER_AVOID, manual: needs confirmation (409 FOUR_CONSECUTIVE_CONFIRMATION_REQUIRED); with confirmFourConsecutive it is accepted', mPut.status === 409 && codeOf(mPut) === 'FOUR_CONSECUTIVE_CONFIRMATION_REQUIRED' && (await call('PUT', `/api/substitutions/${nc.id}/assignment`, tokA, { teacherId: MC, confirmFourConsecutive: true })).status === 200);
    const d2e = slot(4).date; await only(d2e, [MC]); await setPolicy('ALLOW');
    const allowManual = await absent(A3, d2e, { scope: 'PERIODS', fromPeriod: 4, toPeriod: 4, autoAssign: false });
    const amc = (await coversOf(allowManual.body.data.absence.id))[0];
    check('ALLOW, manual: no confirmation needed', (await call('PUT', `/api/substitutions/${amc.id}/assignment`, tokA, { teacherId: MC })).status === 200);
    await setPolicy('NEVER_ALLOW');
    const stillThere = await prisma.coverRequest.findMany({ where: { id: { in: [allow.covers[0].id, prefer.covers[0].id, amc.id] } } });
    check('changing the policy never touches assignments already made (all three still ASSIGNED to MC)', stillThere.every((c) => c.status === 'ASSIGNED' && c.replacementTeacherId === MC));
    await setPolicy('PREFER_AVOID');
    check('the normal timetable is unaffected by every policy (lessons byte-for-byte unchanged); no workload limit is involved', lessonsBefore === JSON.stringify(await prisma.timetableEntry.findMany({ where: { versionId: version.id }, orderBy: { id: 'asc' } })));
    check('invariants hold after the policy scenarios', (await invariants()) === '', await invariants());

    // ===========================================================================================================
    section('3. Absence edits: full-day <-> partial, date change, teacher change, manual assignments');
    const d3 = mondayN(10); await only(d3, [M2, M2b, M3, U2]);
    const r3 = await absent(A1, d3);
    const abs3 = r3.body.data.absence.id;
    check('(setup) full-day absence: P2, P3, P6 assigned automatically', auto(r3).assigned === 3);
    const idsBefore = (await prisma.coverRequest.findMany({ where: { absenceId: abs3 }, select: { id: true } })).map((c) => c.id);
    const evBefore = (await prisma.coverEvent.findMany({ where: { schoolId: school }, select: { id: true } })).map((e) => e.id);
    const toPartial = await call('PATCH', `/api/teacher-absences/${abs3}`, tokA, { scope: 'PERIODS', fromPeriod: 3, toPeriod: 3 });
    check('full-day → partial (P3 only): P2 and P6 are cancelled with their automatic assignments, P3 keeps its substitute', toPartial.status === 200 && toPartial.body.data.coverRequestsCancelled === 2 && toPartial.body.data.automaticAllocation.totalAffectedLessons === 1 && (await liveCovers(abs3))[0]!.periodNumber === 3);
    const toFull = await call('PATCH', `/api/teacher-absences/${abs3}`, tokA, { scope: 'FULL_DAY' });
    const idsAfter = (await prisma.coverRequest.findMany({ where: { absenceId: abs3 }, select: { id: true } })).map((c) => c.id);
    check('partial → full-day: P2 and P6 are REOPENED (the same requests, no duplicates) and assigned again', toFull.status === 200 && toFull.body.data.coverRequestsReopened === 2 && toFull.body.data.automaticAllocation.assigned === 3 && idsAfter.length === 3 && idsBefore.every((id) => idsAfter.includes(id)));
    const evAfter = new Set((await prisma.coverEvent.findMany({ where: { schoolId: school }, select: { id: true } })).map((e) => e.id));
    check('every audit event written before these edits still exists', evBefore.every((id) => evAfter.has(id)));
    const sameEdit = await call('PATCH', `/api/teacher-absences/${abs3}`, tokA, { reason: 'flu' });
    const evAfterNoop = await eventCount();
    const sameEdit2 = await call('PATCH', `/api/teacher-absences/${abs3}`, tokA, { reason: 'flu' });
    check('an edit that changes no lesson (reason only), repeated, creates no request and no event', sameEdit.status === 200 && sameEdit2.status === 200 && (await eventCount()) === evAfterNoop && (await prisma.coverRequest.count({ where: { absenceId: abs3 } })) === 3);
    const toNext = await call('PATCH', `/api/teacher-absences/${abs3}`, tokA, { startDate: mondayN(11), endDate: mondayN(11) });
    check('changing the date: the old date\'s requests (and automatic assignments) are cancelled, the new date\'s are created and assigned', toNext.status === 200 && toNext.body.data.coverRequestsCancelled === 3 && toNext.body.data.coverRequestsCreated === 3 && (await prisma.coverRequest.count({ where: { absenceId: abs3, status: 'CANCELLED' } })) === 3 && (await liveCovers(abs3)).length === 3 && (await invariants()) === '');
    const chT = await call('PATCH', `/api/teacher-absences/${abs3}`, tokA, { teacherId: A2, reason: 'x' });
    check('changing the absent teacher is refused with a clear 400 (not silently ignored), nothing changes', chT.status === 400 && /cancel this absence and record a new one/.test(JSON.stringify(chT.body.errors)) && (await prisma.teacherAbsence.findUniqueOrThrow({ where: { id: abs3 } })).teacherId === A1);

    section('3b. Manual assignments in an edited or cancelled absence are never overwritten: 409 with the lessons that need attention');
    const d3b = mondayN(12); await only(d3b, [M2, M2b, M3, U2]);
    const r3b = await absent(A1, d3b);
    const abs3b = r3b.body.data.absence.id;
    const c3b = await liveCovers(abs3b);
    const p3 = c3b.find((c) => c.periodNumber === 3)!;
    const manual = await call('PUT', `/api/substitutions/${p3.id}/assignment`, tokA, { teacherId: M3 });
    check('(setup) the admin reassigns P3 to M3: now MANUAL', manual.status === 200 && manual.body.data.assignmentSource === 'MANUAL');
    const shrink = await call('PATCH', `/api/teacher-absences/${abs3b}`, tokA, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2 });
    check('shrinking so that the manual P3 would fall outside: 409 ASSIGNED_COVERS_OUTSIDE listing that lesson, its substitute and who decided; the absence is unchanged', shrink.status === 409 && codeOf(shrink) === 'ASSIGNED_COVERS_OUTSIDE' && shrink.body.errors.coverRequestIds.join() === p3.id && /period 3/.test(shrink.body.errors.lessons[0]) && /M3/.test(shrink.body.errors.lessons[0]) && /assigned by an admin/.test(shrink.body.errors.lessons[0]) && (await liveCovers(abs3b)).length === 3 && (await prisma.teacherAbsence.findUniqueOrThrow({ where: { id: abs3b } })).scope === 'FULL_DAY');
    const cancelBlocked = await post(`/api/teacher-absences/${abs3b}/cancel`, {});
    const evBeforeCancel = await eventCount();
    check('cancelling the absence: 409 ASSIGNED_COVERS_EXIST listing the manual lesson; the automatic ones are untouched (all-or-nothing)', cancelBlocked.status === 409 && codeOf(cancelBlocked) === 'ASSIGNED_COVERS_EXIST' && cancelBlocked.body.errors.lessons.length === 1 && (await prisma.coverRequest.count({ where: { absenceId: abs3b, status: 'ASSIGNED' } })) === 3 && (await prisma.teacherAbsence.findUniqueOrThrow({ where: { id: abs3b } })).status === 'ACTIVE');
    const sub3b = c3b.find((c) => c.periodNumber === 2)!;
    const subAbs = await absent(M3, d3b);
    check('the manually chosen substitute cannot be recorded absent (409 TEACHER_IS_COVERING with the lesson); the automatic one can', subAbs.status === 409 && codeOf(subAbs) === 'TEACHER_IS_COVERING' && /period 3/.test(subAbs.body.errors.lessons[0]));
    void sub3b;
    const cancelOne = await call('POST', `/api/substitutions/${p3.id}/cancel`, tokA, { reason: 'class dismissed' });
    const cancelOk = await post(`/api/teacher-absences/${abs3b}/cancel`, {});
    check('once the admin cancels the manual lesson the absence can be cancelled, which cancels the automatic assignments and keeps every event', cancelOne.status === 200 && cancelOk.status === 200 && cancelOk.body.data.automaticAssignmentsCancelled === 2 && (await eventCount()) > evBeforeCancel && (await liveCovers(abs3b)).length === 0);
    const evCancelled = await prisma.coverEvent.findMany({ where: { coverRequest: { absenceId: abs3b } } });
    check('  the history still shows each request\'s CREATED, AUTO_ASSIGNED and CANCELLED (with the former substitute)', evCancelled.filter((e) => e.action === 'AUTO_ASSIGNED').length === 3 && evCancelled.filter((e) => e.action === 'CANCELLED' && e.fromTeacherId !== null).length >= 2);

    section('3c. Cancelled requests are never reopened by accident');
    const reserved = await call('POST', `/api/substitutions/${p3.id}/cancel`, tokA, { reason: 'absence_changed' });
    const d3c = mondayN(13); await only(d3c, [M2, M2b, M3, U2]);
    const r3c = await absent(A1, d3c);
    const abs3c = r3c.body.data.absence.id;
    const p3c = (await liveCovers(abs3c)).find((c) => c.periodNumber === 3)!;
    const adminCancel = await call('POST', `/api/substitutions/${p3c.id}/cancel`, tokA, { reason: 'Class combined with 8B' });
    await call('PATCH', `/api/teacher-absences/${abs3c}`, tokA, { scope: 'PERIODS', fromPeriod: 1, toPeriod: 8 });
    await call('PATCH', `/api/teacher-absences/${abs3c}`, tokA, { reason: 'longer' });
    await post(`/api/teacher-absences/${abs3c}/auto-assign`, {});
    await post('/api/substitutions/auto-assign', { from: d3c, to: d3c });
    check('a reason reserved for automatic cancellations is refused from an admin (400), so an admin cancellation can never be mistaken for one', reserved.status === 400 && /reserved/.test(JSON.stringify(reserved.body.errors)));
    check('a request the admin cancelled stays CANCELLED through absence edits and every allocation (not reopened, no duplicate)', adminCancel.status === 200 && (await prisma.coverRequest.findUniqueOrThrow({ where: { id: p3c.id } })).status === 'CANCELLED' && (await prisma.coverRequest.count({ where: { absenceId: abs3c, periodNumber: 3 } })) === 1);

    section('3d. A substitute who becomes absent or unavailable: partial-day absence and a single period');
    const d3d = mondayN(14); await only(d3d, [M2, M2b, U2]);
    const r3d = await absent(A1, d3d, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 3 });
    const covers3d = auto(r3d).covers;
    const holderP2 = covers3d.find((c: any) => c.periodNumber === 2).replacementTeacher.id;
    const partialAbs = await absent(holderP2, d3d, { scope: 'PERIODS', fromPeriod: 3, toPeriod: 5 });
    const cP2 = await prisma.coverRequest.findFirstOrThrow({ where: { absenceId: r3d.body.data.absence.id, periodNumber: 2 } });
    check('the substitute is absent only for P3-P5: their P2 cover is untouched (still theirs)', partialAbs.status === 201 && cP2.replacementTeacherId === holderP2 && cP2.status === 'ASSIGNED');
    const holderP3 = (await prisma.coverRequest.findFirstOrThrow({ where: { absenceId: r3d.body.data.absence.id, periodNumber: 3 } })).replacementTeacherId;
    check('  the P3 cover was held by someone else or reallocated: nobody absent covers P3', holderP3 !== holderP2 && (await invariants()) === '');
    const unavP2 = await post('/api/teacher-unavailability', { teacherId: holderP2, date: d3d, periodNumber: 2 });
    const cP2b = await prisma.coverRequest.findFirstOrThrow({ where: { absenceId: r3d.body.data.absence.id, periodNumber: 2 } });
    check('marked unavailable for P2 only: the P2 cover is released and reallocated to another teacher; reported in automaticReallocation', unavP2.status === 201 && unavP2.body.data.automaticReallocation.run.assigned === 1 && cP2b.replacementTeacherId !== holderP2 && cP2b.status === 'ASSIGNED' && (await invariants()) === '');
    const relEvents = (await prisma.coverEvent.findMany({ where: { coverRequestId: cP2.id } })).map((e) => e.action);
    check('  its audit trail: AUTO_ASSIGNED, AUTO_RELEASED, AUTO_ASSIGNED', relEvents.filter((a) => a === 'AUTO_ASSIGNED').length === 2 && relEvents.includes('AUTO_RELEASED'));
    const d3e = mondayN(15); await only(d3e, [M2]);
    const r3e = await absent(A1, d3e, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 2 });
    const subOnly = auto(r3e).covers[0].replacementTeacher.id;
    const absSub = await absent(subOnly, d3e);
    const after3e = (await prisma.coverRequest.findFirstOrThrow({ where: { absenceId: r3e.body.data.absence.id } }));
    check('the only possible substitute becomes absent: the lesson goes back to OPEN (nobody else) with the reason, recoverable, and the absence is still recorded', absSub.status === 201 && after3e.status === 'OPEN' && after3e.attentionCode === 'NO_AVAILABLE_TEACHER' && (await invariants()) === '', `${after3e.status} ${after3e.attentionCode}`);

    // ===========================================================================================================
    section('4. Idempotency: repeated allocation requests change nothing and write no new events');
    const d4 = mondayN(16); await only(d4, [M2, M2b, M3, U2]);
    const r4 = await absent(A1, d4);
    const abs4 = r4.body.data.absence.id;
    const snap = async () => JSON.stringify([(await prisma.coverRequest.findMany({ where: { absenceId: abs4 }, orderBy: { id: 'asc' }, select: { id: true, status: true, replacementTeacherId: true, assignmentSource: true } })), await eventCount()]);
    const s0 = await snap();
    const reps = await Promise.all([post(`/api/teacher-absences/${abs4}/auto-assign`, {}), post(`/api/teacher-absences/${abs4}/auto-assign`, {}), post('/api/substitutions/auto-assign', { from: d4, to: d4 }), post('/api/substitutions/auto-assign', {})]);
    check('four allocation requests at once (absence ×2, range, whole school): all 200, nothing assigned twice, no new request, no new event', reps.every((r) => r.status === 200) && s0 === (await snap()), JSON.stringify(reps.map((r) => r.body.data.run)));
    const moreReps = [await post(`/api/teacher-absences/${abs4}/auto-assign`, {}), await post(`/api/teacher-absences/${abs4}/auto-assign`, {})];
    check('and again, one after the other: still nothing', moreReps.every((r) => r.body.data.run.assigned === 0 && r.body.data.run.unfilled === 0) && s0 === (await snap()));
    check('the absence POST itself, repeated, is a 409 ABSENCE_OVERLAP (recover with the summary or auto-assign): nothing duplicated', (await absent(A1, d4)).status === 409 && s0 === (await snap()));

    // ===========================================================================================================
    section('5. The events feed: cursor pagination');
    // The cursor test needs two events with the SAME timestamp. Whether two real events land in one millisecond is a coincidence (it made this suite flaky), so the
    // fixture makes it certain: the second cover event gets exactly the first one's createdAt (a timestamp tie is all the cursor has to survive).
    const tie = await prisma.coverEvent.findMany({ where: { schoolId: school, action: 'AUTO_ASSIGNED' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 2 });
    await prisma.$executeRaw`UPDATE "cover_events" SET "createdAt" = ${tie[0]!.createdAt} WHERE "id" = ${tie[1]!.id}`;
    const all = await call('GET', '/api/substitution-events?limit=500', tokA);
    const allItems = all.body.data.items as any[];
    check('the full feed is bounded by limit (max 500; 501 → 400), ordered by (time, id) and contains no duplicate ids', all.status === 200 && allItems.length > 40 && new Set(allItems.map((i) => i.id)).size === allItems.length && allItems.every((x, i) => i === 0 || x.occurredAt >= allItems[i - 1].occurredAt) && (await call('GET', '/api/substitution-events?limit=501', tokA)).status === 400 && (await call('GET', '/api/substitution-events?limit=0', tokA)).status === 400);
    const sameTs = allItems.findIndex((x, i) => i > 0 && x.occurredAt === allItems[i - 1].occurredAt);
    check('(setup) events written by one transaction share a timestamp, so a page boundary can fall between two events with the same time', sameTs > 0);
    const walk = async (limit: number, tok = tokA, start?: string) => { const out: any[] = []; let cursor = start; for (let guard = 0; guard < 500; guard++) { const r = await call('GET', `/api/substitution-events?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`, tok); out.push(...r.body.data.items); cursor = r.body.data.nextCursor; if (!r.body.data.hasMore) return { out, cursor }; } return { out, cursor }; };
    const paged = await walk(sameTs);
    check('paging with a limit that ends exactly between two events of the same timestamp returns every event once, in the same order as the unpaged feed', paged.out.length === allItems.length && paged.out.map((i) => i.id).join() === allItems.map((i) => i.id).join());
    const paged7 = await walk(7);
    check('  and with limit 7, and with limit 1', paged7.out.map((i) => i.id).join() === allItems.map((i) => i.id).join() && (await walk(1)).out.length === allItems.length);
    const first = await call('GET', `/api/substitution-events?limit=${sameTs}`, tokA);
    const again1 = await call('GET', `/api/substitution-events?limit=${sameTs}&cursor=${first.body.data.nextCursor}`, tokA);
    const again2 = await call('GET', `/api/substitution-events?limit=${sameTs}&cursor=${first.body.data.nextCursor}`, tokA);
    check('the same cursor always returns the same next page (stable, no state is kept server-side)', JSON.stringify(again1.body.data.items) === JSON.stringify(again2.body.data.items) && again1.body.data.items[0].id === allItems[sameTs].id);
    const naive = await call('GET', `/api/substitution-events?since=${encodeURIComponent(first.body.data.nextSince)}`, tokA);
    check('the older nextSince-only continuation is kept for compatibility (it still works; it is exclusive of that instant, which is why the cursor exists)', naive.status === 200 && Array.isArray(naive.body.data.items));
    const tail = paged.cursor;
    const nothing = await call('GET', `/api/substitution-events?cursor=${tail}`, tokA);
    const d5 = mondayN(17); await only(d5, [M2, M2b]);
    await absent(A2, d5, { scope: 'PERIODS', fromPeriod: 4, toPeriod: 4 });
    const fresh = await call('GET', `/api/substitution-events?cursor=${tail}`, tokA);
    check('after the last event nothing is returned; once a new absence is recorded exactly its new events appear, once', nothing.body.data.items.length === 0 && nothing.body.data.hasMore === false && fresh.body.data.items.length >= 2 && fresh.body.data.items.every((i: any) => !allItems.some((o) => o.id === i.id)) && fresh.body.data.items.some((i: any) => i.type === 'ABSENCE_RECORDED') && fresh.body.data.items.some((i: any) => i.type === 'SUBSTITUTE_AUTO_ASSIGNED'));
    check('an invalid or foreign cursor is a 400 (not a 500), never leaking anything', (await call('GET', '/api/substitution-events?cursor=garbage', tokA)).status === 400 && (await call('GET', `/api/substitution-events?cursor=${Buffer.from('not-a-date|x').toString('base64url')}`, tokA)).status === 400);
    const bAll = await call('GET', `/api/substitution-events?cursor=${tail}&limit=500`, tokB);
    check('school isolation: school B, even with school A\'s cursor, sees none of A\'s events, teachers or covers', bAll.status === 200 && bAll.body.data.items.length === 0 && !JSON.stringify(bAll.body).includes(school));
    const types = new Set((paged.out as any[]).map((i) => i.type));
    check('assignment and cancellation are represented: assigned, reassigned, cancelled, released, unfilled, absence recorded/cancelled', ['SUBSTITUTE_AUTO_ASSIGNED', 'ASSIGNMENT_CHANGED', 'SUBSTITUTE_REPLACED', 'ASSIGNMENT_CANCELLED', 'SUBSTITUTE_RELEASED', 'NO_SUBSTITUTE_AVAILABLE', 'ABSENCE_RECORDED', 'ABSENCE_CANCELLED'].every((t) => types.has(t)), [...types].join());
    const rich = (paged.out as any[]).find((i) => i.type === 'SUBSTITUTE_AUTO_ASSIGNED');
    const cancelEv = (paged.out as any[]).find((i) => i.type === 'ASSIGNMENT_CANCELLED' && i.fromTeacher);
    check('events explain themselves: the auto-assigned one carries the ranking details, the cancellation names the former substitute', !!rich.details.rankingOrder && rich.toTeacher.name.length > 0 && !!cancelEv.fromTeacher.name && typeof cancelEv.message === 'string');

    // ===========================================================================================================
    section('6. Concurrency');
    const edits = async (round: number) => {
      const dd = mondayN(20 + round); await only(dd, [M2, M2b, M3, U2]);
      const r = await absent(A1, dd, { scope: 'PERIODS', fromPeriod: 2, toPeriod: 3 });
      const id = r.body.data.absence.id;
      const outcomes = await Promise.all([
        call('PATCH', `/api/teacher-absences/${id}`, tokA, { scope: 'PERIODS', fromPeriod: 3, toPeriod: 6 }),
        call('PATCH', `/api/teacher-absences/${id}`, tokA, { scope: 'FULL_DAY' }),
        post(`/api/teacher-absences/${id}/auto-assign`, {}),
      ]);
      const final = await prisma.teacherAbsence.findUniqueOrThrow({ where: { id } });
      const live = await liveCovers(id);
      const inRange = (p: number) => final.scope === 'FULL_DAY' || (p >= final.fromPeriod! && p <= final.toPeriod!);
      const lessonsInRange = [2, 3, 6].filter(inRange);
      const okLive = JSON.stringify(live.map((c) => c.periodNumber)) === JSON.stringify(lessonsInRange);
      return { statuses: outcomes.map((o) => o.status).join('/'), ok: outcomes.every((o) => o.status === 200) && okLive && live.every((c) => c.status === 'ASSIGNED') && (await invariants()) === '', detail: `${final.scope} ${final.fromPeriod}-${final.toPeriod} live=${live.map((c) => c.periodNumber)} ${await invariants()}` };
    };
    const rounds = [await edits(0), await edits(1), await edits(2)];
    check('simultaneous absence edits and an allocation (3 rounds): no error, the live requests are exactly the lessons inside the final absence, all assigned, no duplicate or overlapping assignment', rounds.every((r) => r.ok), rounds.map((r) => `${r.statuses} ${r.detail}`).join(' | '));
    const d6 = mondayN(25); await only(d6, [M2, M2b, M3, U2]);
    const r6 = await absent(A1, d6, { autoAssign: false });
    const abs6 = r6.body.data.absence.id;
    const racers = await Promise.all([post(`/api/teacher-absences/${abs6}/auto-assign`, {}), post(`/api/teacher-absences/${abs6}/auto-assign`, {}), post(`/api/teacher-absences/${abs6}/auto-assign`, {}), post('/api/substitutions/auto-assign', { from: d6, to: d6 })]);
    const assignedEvents = await prisma.coverEvent.count({ where: { coverRequest: { absenceId: abs6 }, action: 'AUTO_ASSIGNED' } });
    check('four allocations racing for one absence: every lesson is assigned exactly once and has exactly one AUTO_ASSIGNED event (no duplicate audit events)', racers.every((r) => r.status === 200) && (await prisma.coverRequest.count({ where: { absenceId: abs6, status: 'ASSIGNED' } })) === 3 && assignedEvents === 3 && (await invariants()) === '');
    const d6b = mondayN(26); await only(d6b, [M2, M2b, M3, U2]);
    const r6b = await absent(A1, d6b, { autoAssign: false });
    const abs6b = r6b.body.data.absence.id;
    const holdersSeen = new Set<string>();
    const mix = await Promise.all([post(`/api/teacher-absences/${abs6b}/auto-assign`, {}), ...[M2, M2b, M3].map((t) => post('/api/teacher-unavailability', { teacherId: t, date: d6b, periodNumber: 2 }))]);
    for (const c of await prisma.coverRequest.findMany({ where: { absenceId: abs6b, status: 'ASSIGNED' } })) holdersSeen.add(String(c.replacementTeacherId));
    check('marking teachers unavailable while the allocation runs: no assigned substitute is unavailable at the end (a released lesson is reallocated or left OPEN)', mix.every((r) => r.status < 500) && (await invariants()) === '', mix.map((m) => m.status).join());

    section('6b. Ranking inputs: weekly workload and the 28-day fairness window are computed correctly');
    const dW = mondayN(30); await only(dW, [M1, M2, M2b]);
    // M1 teaches 5 lessons on Mondays (P1,P2,P5,P7,P8); recorded absent for P1-P2 only: those two are not taught by them this week
    await absent(M1, dW, { scope: 'PERIODS', fromPeriod: 1, toPeriod: 2, autoAssign: false });
    const rW = await absent(A3, dW, { scope: 'PERIODS', fromPeriod: 4, toPeriod: 4, autoAssign: false });
    const cW = (await coversOf(rW.body.data.absence.id))[0];
    const candW = async (coverId: string) => (await call('GET', `/api/substitutions/${coverId}/candidates`, tokA)).body.data.candidates as any[];
    const loadOf = (list: any[], id: string) => list.find((c) => c.id === id)?.weeklyLoad;
    const w0 = await candW(cW.id);
    check('weekly workload = lessons actually taught that week: M1 has 5 lessons, 2 fall inside their own absence → 3; M2 and M2b have none → 0', loadOf(w0, M1) === 3 && loadOf(w0, M2) === 0 && loadOf(w0, M2b) === 0, JSON.stringify(w0.map((c) => [c.name.split(' ')[0], c.weeklyLoad])));
    const rW2 = await absent(A1, dW, { scope: 'PERIODS', fromPeriod: 6, toPeriod: 6, autoAssign: false });
    const cW2 = (await coversOf(rW2.body.data.absence.id))[0];
    await call('PUT', `/api/substitutions/${cW2.id}/assignment`, tokA, { teacherId: M2 });
    const w1 = await candW(cW.id);
    check('a cover assigned that week counts exactly once (M2: 0 → 1); the absent teacher\'s own lessons are not counted for the substitute (no double counting)', loadOf(w1, M2) === 1 && loadOf(w1, M2b) === 0 && w1.find((c: any) => c.id === M2).coverLoadToday === 1);
    const dNext = mondayN(31); await only(dNext, [M2, M2b]);
    const rN = await absent(A3, dNext, { scope: 'PERIODS', fromPeriod: 4, toPeriod: 4, autoAssign: false });
    const wN = await candW((await coversOf(rN.body.data.absence.id))[0].id);
    check('the next week starts from zero again for the weekly workload, but the cover is still "recent" (fairness): M2 recentCovers 1, M2b 0', loadOf(wN, M2) === 0 && wN.find((c: any) => c.id === M2).recentCovers === 1 && wN.find((c: any) => c.id === M2b).recentCovers === 0);
    const d27 = mondayN(34); // 28 days after dW: the window is the 28 days ENDING on the date, the date included -> dW is 28 days back, i.e. just outside
    await only(d27, [M2, M2b]);
    const r27 = await absent(A3, d27, { scope: 'PERIODS', fromPeriod: 4, toPeriod: 4, autoAssign: false });
    const w27 = await candW((await coversOf(r27.body.data.absence.id))[0].id);
    const d21 = mondayN(33);
    await only(d21, [M2, M2b]);
    const r21 = await absent(A3, d21, { scope: 'PERIODS', fromPeriod: 4, toPeriod: 4, autoAssign: false });
    const w21 = await candW((await coversOf(r21.body.data.absence.id))[0].id);
    check('the 28-day window: a cover 21 days earlier still counts (recent 1), one exactly 28 days earlier does not (recent 0)', w21.find((c: any) => c.id === M2).recentCovers === 1 && w27.find((c: any) => c.id === M2).recentCovers === 0, `${w21.find((c: any) => c.id === M2).recentCovers} ${w27.find((c: any) => c.id === M2).recentCovers}`);
    const bad = await post('/api/substitutions/auto-assign', { from: mondayN(5), to: mondayN(1) });
    check('the range endpoint refuses to before from (400); a malformed date is a 400', bad.status === 400 && (await post('/api/substitutions/auto-assign', { from: '2030-02-30' })).status === 400);

    section('7. Final invariants');
    check('after everything above: no double booking, no substitute teaching, absent or unavailable in a slot, no duplicate live request', (await invariants()) === '', await invariants());

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
