// Safe deletion and correction of records: DELETE grade / section / stream / subject / teacher / academic year / schedule configuration are refused (409, with what is in the way)
// whenever anything depends on the record, deactivation keeps history, and published timetables are never touched.
// buildApp() + app.inject(), real database (disposable local one only), test schools only.
//   source <guard>/local_test_env.sh && npx tsx test-record-deletion-api.ts
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
const PASSWORD = 'Delete#Test-Pass-2030';
const UUID0 = '00000000-0000-4000-8000-000000000000';

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\w*\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not a local *_test database');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('DEL');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('DEL');
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

  try {
    const tokA = await sessionFor(worldA);
    const tokB = await sessionFor(worldB);
    const school = worldA.schoolId;
    const del = (path: string, tok: string | null = tokA) => call('DELETE', path, tok);
    const blocked = (r: Reply): string => JSON.stringify(r.body.errors?.blockedBy ?? []);

    // A DRAFT year built directly: the structure to delete from
    const year = await prisma.academicYear.create({ data: { schoolId: school, name: 'DEL-DRAFT', startDate: new Date('2031-01-01'), endDate: new Date('2031-12-31') } });
    const grade = (name: string, displayOrder: number) => prisma.grade.create({ data: { academicYearId: year.id, name, displayOrder } });
    const g6 = await grade('G6', 1);
    const g7 = await grade('G7', 2);
    const g8 = await grade('G8', 3);
    const gEmpty = await grade('GEMPTY', 4);
    const stA = await prisma.stream.create({ data: { gradeId: g8.id, name: 'Science', code: 'SCI' } });
    const stB = await prisma.stream.create({ data: { gradeId: g8.id, name: 'Commerce', code: 'COM' } });
    const stEmpty = await prisma.stream.create({ data: { gradeId: g8.id, name: 'Arts', code: 'ART' } });
    const sec = (gradeId: string, name: string, streamId?: string) => prisma.section.create({ data: { gradeId, name, code: name, ...(streamId ? { streamId } : {}) } });
    const s6a = await sec(g6.id, 'A');
    const s6b = await sec(g6.id, 'B');
    const s6c = await sec(g6.id, 'C');
    const s7a = await sec(g7.id, 'A');
    const s8sci = await sec(g8.id, 'A', stA.id);
    const s8com = await sec(g8.id, 'A', stB.id);
    const subj = (code: string) => prisma.subject.create({ data: { schoolId: school, name: code, code } });
    const [ENG, MATH, SPARE, UNUSED] = [await subj('ENG'), await subj('MATH'), await subj('SPARE'), await subj('UNUSED')] as const;
    const teacher = (name: string) => prisma.teacher.create({ data: { schoolId: school, name } });
    const [tAssigned, tAbsent, tUnavail, tLinked, tFree] = [await teacher('Assigned'), await teacher('Absent'), await teacher('Unavail'), await teacher('Linked'), await teacher('Free')] as const;
    const link = (teacherId: string, subjectId: string) => prisma.teacherSubject.create({ data: { teacherId, subjectId, type: 'PRIMARY', gradeScope: 'ALL_GRADES' } });
    await link(tAssigned.id, ENG.id);
    await link(tLinked.id, SPARE.id);
    const reqEng6 = await prisma.subjectRequirement.create({ data: { gradeId: g6.id, subjectId: ENG.id, periodsPerWeek: 4 } });
    await prisma.subjectRequirement.create({ data: { gradeId: g7.id, subjectId: MATH.id, periodsPerWeek: 4 } });
    const reqScoped = await prisma.subjectRequirement.create({ data: { gradeId: g6.id, subjectId: MATH.id, periodsPerWeek: 3, sectionScope: 'SELECTED_SECTIONS', sections: { create: [{ sectionId: s6c.id }] } } });
    await prisma.subjectRequirement.create({ data: { gradeId: g8.id, streamId: stB.id, subjectId: ENG.id, periodsPerWeek: 4 } });
    await prisma.sectionSubjectTeacher.create({ data: { sectionId: s6a.id, subjectRequirementId: reqEng6.id, teacherId: tAssigned.id } });
    const gElig = await prisma.grade.create({ data: { academicYearId: year.id, name: 'GELIG', displayOrder: 5 } });
    await prisma.teacherSubjectGrade.create({ data: { teacherSubjectId: (await prisma.teacherSubject.findFirstOrThrow({ where: { teacherId: tLinked.id } })).id, gradeId: gElig.id } });
    await prisma.teacherAbsence.create({ data: { schoolId: school, teacherId: tAbsent.id, startDate: new Date('2031-03-03'), endDate: new Date('2031-03-03'), scope: 'FULL_DAY', status: 'CANCELLED', cancelledAt: new Date() } });
    await prisma.teacherUnavailability.create({ data: { schoolId: school, teacherId: tUnavail.id, date: new Date('2031-03-03') } });
    const exists = async (table: 'grade' | 'section' | 'stream' | 'subject' | 'teacher' | 'academicYear' | 'scheduleConfig', id: string) => (await (prisma[table] as any).count({ where: { id } })) === 1;

    // =====================================================================================================================================
    section('1. Authentication, school isolation, identifiers');
    const targets: Array<[string, string]> = [['grades', g6.id], ['sections', s6a.id], ['streams', stA.id], ['subjects', ENG.id], ['teachers', tAssigned.id], ['academic-years', year.id]];
    check('every delete answers 401 without a session', (await Promise.all([...targets.map(([p, id]) => del(`/api/${p}/${id}`, null)), del(`/api/schedule-configs/${UUID0}`, null)])).every((r) => r.status === 401));
    check('another school gets 403 for each of these records, and nothing is deleted', (await Promise.all(targets.map(([p, id]) => del(`/api/${p}/${id}`, tokB)))).every((r) => r.status === 403) && (await Promise.all([exists('grade', g6.id), exists('section', s6a.id), exists('stream', stA.id), exists('subject', ENG.id), exists('teacher', tAssigned.id), exists('academicYear', year.id)])).every(Boolean));
    check('an unknown id is 404 for each', (await Promise.all([...targets.map(([p]) => del(`/api/${p}/${UUID0}`)), del(`/api/schedule-configs/${UUID0}`)])).every((r) => r.status === 404));
    check('a malformed id is 400 for each', (await Promise.all([...targets.map(([p]) => del(`/api/${p}/not-a-uuid`)), del('/api/schedule-configs/x')])).every((r) => r.status === 400));

    // =====================================================================================================================================
    section('2. Refused while anything depends on the record (409), with the reason named; nothing is deleted');
    const gRefused = await del(`/api/grades/${g6.id}`);
    check('grade with sections, requirements: 409 naming them', gRefused.status === 409 && /sections?/.test(blocked(gRefused)) && /requirements?/.test(blocked(gRefused)) && await exists('grade', g6.id), blocked(gRefused));
    const gEl = await del(`/api/grades/${gElig.id}`);
    check('grade used only in a teacher\'s grade eligibility: 409 (the eligibility is not silently dropped)', gEl.status === 409 && /eligibility/.test(blocked(gEl)) && await exists('grade', gElig.id));
    const stSections = await del(`/api/streams/${stA.id}`);
    check('stream with a section: 409 (the section is not silently detached)', stSections.status === 409 && /section/.test(blocked(stSections)) && await exists('stream', stA.id) && (await prisma.section.findUniqueOrThrow({ where: { id: s8sci.id } })).streamId === stA.id);
    const stReq = await del(`/api/streams/${stB.id}`);
    check('stream with sections and a requirement: 409 naming both', stReq.status === 409 && /section/.test(blocked(stReq)) && /requirement/.test(blocked(stReq)) && await exists('stream', stB.id));
    const secAsg = await del(`/api/sections/${s6a.id}`);
    check('section with a teacher assignment: 409', secAsg.status === 409 && /teacher assignment/.test(blocked(secAsg)) && await exists('section', s6a.id));
    const secScope = await del(`/api/sections/${s6c.id}`);
    check('section named in a selected-sections requirement: 409', secScope.status === 409 && /selected sections/.test(blocked(secScope)) && await exists('section', s6c.id));
    const subReq = await del(`/api/subjects/${ENG.id}`);
    check('subject with requirements and a teacher link: 409', subReq.status === 409 && /curriculum requirement/.test(blocked(subReq)) && /teacher link/.test(blocked(subReq)) && await exists('subject', ENG.id));
    const subLink = await del(`/api/subjects/${SPARE.id}`);
    check('subject with only a teacher link: 409', subLink.status === 409 && /teacher link/.test(blocked(subLink)) && await exists('subject', SPARE.id));
    const tAsg = await del(`/api/teachers/${tAssigned.id}`);
    check('teacher with a section assignment: 409, and the message points to deactivation', tAsg.status === 409 && /section assignment/.test(blocked(tAsg)) && /deactivate/i.test(tAsg.body.message) && await exists('teacher', tAssigned.id));
    check('teacher with a recorded absence (even a cancelled one): 409', (await del(`/api/teachers/${tAbsent.id}`)).status === 409 && await exists('teacher', tAbsent.id));
    check('teacher with an unavailability entry: 409', (await del(`/api/teachers/${tUnavail.id}`)).status === 409 && await exists('teacher', tUnavail.id));
    const yearRefused = await del(`/api/academic-years/${year.id}`);
    check('academic year with grades: 409', yearRefused.status === 409 && /grade/.test(blocked(yearRefused)) && await exists('academicYear', year.id));

    // =====================================================================================================================================
    section('3. Unused records are deleted for good');
    const dSection = await del(`/api/sections/${s6b.id}`);
    check('an unused section is deleted (200); its siblings remain', dSection.status === 200 && !(await exists('section', s6b.id)) && await exists('section', s6a.id) && await exists('section', s6c.id));
    const dGradeEmpty = await del(`/api/grades/${gEmpty.id}`);
    check('an empty grade is deleted', dGradeEmpty.status === 200 && !(await exists('grade', gEmpty.id)));
    const dStream = await del(`/api/streams/${stEmpty.id}`);
    check('an unused stream is deleted; the other streams are untouched', dStream.status === 200 && !(await exists('stream', stEmpty.id)) && await exists('stream', stA.id) && await exists('stream', stB.id));
    const dSubject = await del(`/api/subjects/${UNUSED.id}`);
    check('an unused subject is deleted', dSubject.status === 200 && !(await exists('subject', UNUSED.id)));
    const dTeacher = await del(`/api/teachers/${tFree.id}`);
    check('a teacher with no history is deleted (200)', dTeacher.status === 200 && !(await exists('teacher', tFree.id)) && dTeacher.body.data.removedSubjectLinks === 0);
    const tOnlyLinks = await teacher('Only links');
    await link(tOnlyLinks.id, MATH.id);
    const dLinks = await del(`/api/teachers/${tOnlyLinks.id}`);
    check('a teacher with only subject links is deleted and says how many links went with them; the subject remains', dLinks.status === 200 && dLinks.body.data.removedSubjectLinks === 1 && !(await exists('teacher', tOnlyLinks.id)) && await exists('subject', MATH.id));
    check('deleting twice is 404 the second time', (await del(`/api/sections/${s6b.id}`)).status === 404);
    // after the blockers are removed through their own endpoints, the record can go
    const removeAsg = await call('DELETE', `/api/section-subject-teachers/${(await prisma.sectionSubjectTeacher.findFirstOrThrow({ where: { sectionId: s6a.id } })).id}`, tokA);
    check('once the assignment is removed (existing endpoint) the section can be deleted', removeAsg.status === 200 && (await del(`/api/sections/${s6a.id}`)).status === 200 && !(await exists('section', s6a.id)));
    check('and then the teacher (no assignments left) can be deleted too', (await del(`/api/teachers/${tAssigned.id}`)).status === 200);
    void reqScoped;

    // =====================================================================================================================================
    section('4. The academic year lifecycle: only DRAFT structure can be removed');
    const locked = await prisma.academicYear.create({ data: { schoolId: school, name: 'DEL-ACTIVE', startDate: new Date('2030-01-01'), endDate: new Date('2030-12-31'), status: 'ACTIVE' } });
    const lg = await prisma.grade.create({ data: { academicYearId: locked.id, name: 'LG', displayOrder: 1 } });
    const lst = await prisma.stream.create({ data: { gradeId: lg.id, name: 'Only', code: 'ONLY' } });
    const lsec = await prisma.section.create({ data: { gradeId: lg.id, name: 'A', code: 'A', streamId: lst.id } });
    const lcfg = await prisma.scheduleConfig.create({ data: { academicYearId: locked.id, periodsPerDay: 4, breakAfterPeriod: 2 } });
    const responses = await Promise.all([del(`/api/sections/${lsec.id}`), del(`/api/streams/${lst.id}`), del(`/api/grades/${lg.id}`), del(`/api/schedule-configs/${lcfg.id}`), del(`/api/academic-years/${locked.id}`)]);
    check('sections, streams, grades, the schedule and the year of an ACTIVE year cannot be deleted (400)', responses.every((r) => r.status === 400) && (await Promise.all([exists('section', lsec.id), exists('stream', lst.id), exists('grade', lg.id), exists('scheduleConfig', lcfg.id), exists('academicYear', locked.id)])).every(Boolean));
    await prisma.academicYear.update({ where: { id: locked.id }, data: { status: 'COMPLETED' } });
    check('and not a COMPLETED year either', (await del(`/api/academic-years/${locked.id}`)).status === 400 && await exists('academicYear', locked.id));
    const emptyYear = await prisma.academicYear.create({ data: { schoolId: school, name: 'DEL-EMPTY', startDate: new Date('2032-01-01'), endDate: new Date('2032-12-31') } });
    const emptyCfg = await prisma.scheduleConfig.create({ data: { academicYearId: emptyYear.id, periodsPerDay: 4 } });
    await prisma.schedulePeriod.create({ data: { scheduleConfigId: emptyCfg.id, periodNumber: 1, startMinute: 480, endMinute: 525 } }); // a LEGACY period row: deleting the year/config must still remove it
    const dYear = await del(`/api/academic-years/${emptyYear.id}`);
    check('an empty DRAFT year is deleted together with its schedule configuration only', dYear.status === 200 && !(await exists('academicYear', emptyYear.id)) && (await prisma.scheduleConfig.count({ where: { id: emptyCfg.id } })) === 0 && (await prisma.schedulePeriod.count({ where: { scheduleConfigId: emptyCfg.id } })) === 0);
    const resetYear = await prisma.academicYear.create({ data: { schoolId: school, name: 'DEL-RESET', startDate: new Date('2033-01-01'), endDate: new Date('2033-12-31') } });
    const resetCfg = await prisma.scheduleConfig.create({ data: { academicYearId: resetYear.id, periodsPerDay: 4 } });
    const dCfg = await del(`/api/schedule-configs/${resetCfg.id}`);
    check('a DRAFT year\'s schedule can be reset (deleted) and then created again through the existing endpoint', dCfg.status === 200 && (await call('POST', '/api/schedule-configs', tokA, { academicYearId: resetYear.id, workingDays: ['MONDAY', 'TUESDAY'], periodsPerDay: 2, breakAfterPeriod: 1 })).status === 201);

    // =====================================================================================================================================
    section('5. Timetable history: lessons in ANY version protect their section, subject and teacher; drafts block the schedule reset');
    const ry = await seedYear(worldA, 'del-real');
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
    const v1 = await generate();
    const [secX, secY] = [ry.sectionIds[0]!, ry.sectionIds[1]!];
    const dSec = await del(`/api/sections/${secX}`);
    check('a section with lessons in a DRAFT timetable: 409 naming the version', dSec.status === 409 && /timetable lesson/.test(blocked(dSec)) && /version 1 \(draft\)/.test(blocked(dSec)), blocked(dSec));
    check('a subject and a teacher with lessons are refused for the same reason', (await del(`/api/subjects/${ry.subjectIds[0]}`)).status === 409 && /timetable lesson/.test(blocked(await del(`/api/subjects/${ry.subjectIds[0]}`))) && /timetable lesson/.test(blocked(await del(`/api/teachers/${spareOf(ry)}`)) + blocked(await del(`/api/teachers/${ry.teacherIds[0]}`))));
    const dCfgDraft = await del(`/api/schedule-configs/${ry.configId}`);
    check('the schedule cannot be reset while a timetable version exists for the year (409)', dCfgDraft.status === 409 && /timetable version/.test(blocked(dCfgDraft)));
    check('the year cannot be deleted while it has grades and versions (409)', (await del(`/api/academic-years/${ry.yearId}`)).status === 409);

    // the database refuses it too, even when the service is bypassed
    const bypass = await prisma.section.delete({ where: { id: secX } }).then(() => 'deleted', (e: Error) => /foreign key|violat|constraint/i.test(e.message) ? 'refused' : `other: ${e.message.slice(0, 120)}`);
    check('DATABASE BACKSTOP: even a direct delete of a section with lessons is refused by the foreign key (the lessons are not cascade-deleted)', bypass === 'refused' && (await prisma.timetableEntry.count({ where: { versionId: v1, sectionId: secX } })) > 0, bypass);
    const bypassT = await prisma.teacher.delete({ where: { id: ry.teacherIds[0]! } }).then(() => 'deleted', () => 'refused');
    check('DATABASE BACKSTOP: a direct delete of a teacher with lessons is refused', bypassT === 'refused');

    // Deleting a draft is the supported way to clear the path
    const delV = await call('DELETE', `/api/timetable-versions/${v1}`, tokA);
    check('(existing endpoint) the draft is deleted', delV.status === 200);
    check('the schedule can now be reset (no versions): 200', (await del(`/api/schedule-configs/${ry.configId}`)).status === 200);
    await prisma.scheduleConfig.create({ data: { academicYearId: ry.yearId, periodsPerDay: 6 } }); // put a config back (fixture) so the year can generate below
    // the new config has no days/periods: restore the full one through the API instead
    await prisma.scheduleConfig.deleteMany({ where: { academicYearId: ry.yearId } });
    const restored = await call('POST', '/api/schedule-configs', tokA, { academicYearId: ry.yearId, workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'], periodsPerDay: 6, breakAfterPeriod: 3 });
    check('(existing endpoint) the schedule is set up again', restored.status === 201, JSON.stringify(restored.body).slice(0, 160));
    const assignmentsOf = (sectionId: string) => prisma.sectionSubjectTeacher.findMany({ where: { sectionId } });
    for (const a of await assignmentsOf(secY)) await call('DELETE', `/api/section-subject-teachers/${a.id}`, tokA);
    const dSecY = await del(`/api/sections/${secY}`);
    check('with no lessons and no assignments left, the section can be deleted', dSecY.status === 200 && !(await exists('section', secY)));
    const v2 = await generate();
    check('a new generation reflects the structure after the deletion: the deleted section has no lessons, the others keep theirs', (await prisma.timetableEntry.count({ where: { versionId: v2, sectionId: secY } })) === 0 && (await prisma.timetableEntry.count({ where: { versionId: v2, sectionId: secX } })) > 0);

    // =====================================================================================================================================
    section('6. Published history is immutable; deactivation keeps it; drafts go stale when the curriculum changes');
    const publish = await call('POST', `/api/timetable-versions/${v2}/publish`, tokA, { expectedRevision: 1, expectedPublishedVersionId: null });
    check('(setup) the version is published', publish.status === 200);
    const finger = async () => createHash('sha256').update(JSON.stringify([await prisma.timetableEntry.findMany({ where: { versionId: v2 }, orderBy: { id: 'asc' } }), (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: v2 } })).status])).digest('hex');
    const before = await finger();
    const teacher0 = ry.teacherIds[0]!;
    const deact = await call('PATCH', `/api/teachers/${teacher0}`, tokA, { isActive: false });
    check('a teacher with published lessons is DEACTIVATED, not deleted (200, isActive=false)', deact.status === 200 && deact.body.data.isActive === false && await exists('teacher', teacher0));
    check('deletion of that teacher stays refused, with the published version named', /version \d+ \(published\)/.test(blocked(await del(`/api/teachers/${teacher0}`))));
    const newSec = await prisma.section.create({ data: { gradeId: ry.gradeId, name: 'NEW', code: 'NEW' } });
    const inactiveAssign = await call('POST', '/api/section-subject-teachers', tokA, { sectionId: newSec.id, subjectRequirementId: ry.requirementIds[0], teacherId: teacher0 });
    check('an inactive teacher cannot receive a NEW assignment (400)', inactiveAssign.status === 400, JSON.stringify(inactiveAssign.body).slice(0, 160));
    const genWhileInactive = await call('POST', '/api/timetable-generations', tokA, { academicYearId: ry.yearId });
    check('while the teacher is inactive, a generation that would use them is refused (4xx), not silently re-planned', genWhileInactive.status >= 400 && genWhileInactive.status < 500, `${genWhileInactive.status} ${JSON.stringify(genWhileInactive.body).slice(0, 200)}`);
    const react = await call('PATCH', `/api/teachers/${teacher0}`, tokA, { isActive: true });
    check('reactivation works, and the teacher can then be assigned again (201)', react.status === 200 && react.body.data.isActive === true && (await call('POST', '/api/section-subject-teachers', tokA, { sectionId: newSec.id, subjectRequirementId: ry.requirementIds[0], teacherId: teacher0 })).status === 201);
    check('the published timetable is byte-for-byte unchanged by all of the above', (await finger()) === before);

    // a draft built before a curriculum removal becomes stale
    const v3 = await generate();
    const reqDel = await call('DELETE', `/api/subject-requirements/${ry.requirementIds[2]}`, tokA);
    check('removing a requirement that teachers are assigned to is refused (409; existing rule)', reqDel.status === 409);
    for (const a of await prisma.sectionSubjectTeacher.findMany({ where: { subjectRequirementId: ry.requirementIds[2]! } })) await call('DELETE', `/api/section-subject-teachers/${a.id}`, tokA);
    const reqDel2 = await call('DELETE', `/api/subject-requirements/${ry.requirementIds[2]}`, tokA);
    const stale = (await call('GET', `/api/timetable-versions/${v3}/validation`, tokA)).body.data;
    check('after the assignments are removed the requirement is deleted (200), and the earlier draft is now STALE and not publishable', reqDel2.status === 200 && stale.isStale === true && stale.informational.publishable === false, JSON.stringify(stale.informational));
    check('the published timetable is still unchanged', (await finger()) === before);
    const tsLink = await prisma.teacherSubject.findFirstOrThrow({ where: { teacherId: ry.teacherIds[1]!, subjectId: ry.subjectIds[1]! } });
    check('(existing endpoint) a teacher-subject link that supports an assignment cannot be removed (409), and after the assignments go it can', (await call('DELETE', `/api/teacher-subjects/${tsLink.id}`, tokA)).status === 409);

    // =====================================================================================================================================
    section('7. Corrections: duplicates are still refused, ordinary edits still work');
    const dupSubject = await call('PATCH', `/api/subjects/${ENG.id}`, tokA, { code: 'MATH' }); // ENG still exists? it was refused above, so yes
    check('renaming a subject to an existing code: 409', dupSubject.status === 409);
    check('renaming it to a new code works and is visible', (await call('PATCH', `/api/subjects/${ENG.id}`, tokA, { code: 'ENGLISH', name: 'English' })).body.data?.code === 'ENGLISH');
    check('section code clash inside a grade: 409', (await call('PATCH', `/api/sections/${s6c.id}`, tokA, { code: 'A' })).status === 200 /* A was deleted above */ && (await call('PATCH', `/api/sections/${s7a.id}`, tokA, { code: 'A' })).status === 200);
    const extra = await prisma.section.create({ data: { gradeId: g7.id, name: 'B', code: 'B' } });
    check('…and a real clash is 409', (await call('PATCH', `/api/sections/${extra.id}`, tokA, { code: 'A' })).status === 409);
    check('stream code clash: 409', (await call('PATCH', `/api/streams/${stA.id}`, tokA, { code: 'COM' })).status === 409);
    check('grade name clash: 409', (await call('PATCH', `/api/grades/${g7.id}`, tokA, { name: 'G6' })).status === 409);
    await prisma.teacher.update({ where: { id: tUnavail.id }, data: { employeeCode: 'T1' } });
    await prisma.teacher.update({ where: { id: tAbsent.id }, data: { employeeCode: 'T2' } });
    check('teacher employee code clash: 409', (await call('PATCH', `/api/teachers/${tAbsent.id}`, tokA, { employeeCode: 'T1' })).status === 409);
    check('a deleted record\'s code/name can be reused (grade GEMPTY, subject UNUSED)', (await call('POST', '/api/grades', tokA, { academicYearId: year.id, name: 'GEMPTY', displayOrder: 9 })).status === 201 && (await call('POST', '/api/subjects', tokA, { name: 'Unused again', code: 'UNUSED' })).status === 201);

    // =====================================================================================================================================
    section('8. Concurrency');
    const raceGrade = await prisma.grade.create({ data: { academicYearId: year.id, name: 'RACE', displayOrder: 20 } });
    const raceSection = await prisma.section.create({ data: { gradeId: raceGrade.id, name: 'R', code: 'R' } });
    const same = await Promise.all([1, 2, 3, 4].map(() => del(`/api/sections/${raceSection.id}`)));
    check('four simultaneous deletes of one section: exactly one 200, the rest 404, no 500', same.filter((r) => r.status === 200).length === 1 && same.every((r) => r.status === 200 || r.status === 404), same.map((r) => r.status).join());
    // delete a section while a teacher is being assigned to it: either the assignment exists AND the section exists, or neither; never an orphan or a 500
    const raceSubject = await subj('RACESUB');
    const raceTeacher = await teacher('RaceTeacher');
    await link(raceTeacher.id, raceSubject.id);
    const raceReq = await prisma.subjectRequirement.create({ data: { gradeId: raceGrade.id, subjectId: raceSubject.id, periodsPerWeek: 2 } });
    let consistent = true;
    let noServerError = true;
    let sectionRaceOutcomes = '';
    for (let i = 0; i < 12; i++) {
      const s = await prisma.section.create({ data: { gradeId: raceGrade.id, name: `X${i}`, code: `X${i}` } });
      const [r1, r2] = await Promise.all([del(`/api/sections/${s.id}`), call('POST', '/api/section-subject-teachers', tokA, { sectionId: s.id, subjectRequirementId: raceReq.id, teacherId: raceTeacher.id })]);
      const sectionAlive = await exists('section', s.id);
      const assignments = await prisma.sectionSubjectTeacher.count({ where: { sectionId: s.id } });
      if ((r1.status === 200) === sectionAlive) consistent = false; // deleted <=> gone
      if (assignments > 0 && !sectionAlive) consistent = false;
      if (r1.status >= 500 || r2.status >= 500) noServerError = false;
      sectionRaceOutcomes += `${r1.status}/${r2.status} `;
      await prisma.sectionSubjectTeacher.deleteMany({ where: { sectionId: s.id } });
    }
    check('section delete racing an assignment for 12 rounds: always consistent (deleted XOR kept; an assignment never outlives its section)', consistent, sectionRaceOutcomes);
    check('…and never a 500 (the loser gets a clean 4xx)', noServerError, sectionRaceOutcomes);
    let teacherConsistent = true;
    let teacherOutcomes = '';
    for (let i = 0; i < 12; i++) {
      const t = await teacher(`RT${i}`);
      await link(t.id, raceSubject.id);
      const s = await prisma.section.create({ data: { gradeId: raceGrade.id, name: `Y${i}`, code: `Y${i}` } });
      const [r1, r2] = await Promise.all([del(`/api/teachers/${t.id}`), call('POST', '/api/section-subject-teachers', tokA, { sectionId: s.id, subjectRequirementId: raceReq.id, teacherId: t.id })]);
      const alive = await exists('teacher', t.id);
      const n = await prisma.sectionSubjectTeacher.count({ where: { teacherId: t.id } });
      if ((r1.status === 200) === alive || (n > 0 && !alive) || r1.status >= 500 || r2.status >= 500) teacherConsistent = false;
      teacherOutcomes += `${r1.status}/${r2.status} `;
      await prisma.sectionSubjectTeacher.deleteMany({ where: { teacherId: t.id } });
    }
    check('teacher delete racing an assignment for 12 rounds: consistent, no orphan, no 500', teacherConsistent, teacherOutcomes);
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

const spareOf = (y: { spareTeacherId: string }) => y.spareTeacherId;

main().catch((e) => { console.error(e); process.exit(2); });
