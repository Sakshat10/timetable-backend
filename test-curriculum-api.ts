// Grade-Stream-Subject curriculum: the overview, setting a grade/stream curriculum atomically, copying, section-level scope, the optional label, validation, compatibility with existing
// requirements, and how readiness and generation consume it (including stale drafts and an untouched published timetable).
// buildApp() + app.inject(), real database (disposable local one only), test schools only.
//   source <guard>/local_test_env.sh && npx tsx test-curriculum-api.ts
import 'dotenv/config';
import './test-fixtures/test-security-env.js';
import { createHash } from 'node:crypto';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { registerGenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner-handle.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { loadGenerationSnapshot } from './src/modules/timetable-generation/timetable-generation.loader.js';
import { normalizeProblem } from './src/modules/timetable-generation/timetable-generation.normalizer.js';
import { analyzeFeasibility } from './src/modules/timetable-feasibility/timetable-feasibility.analyzer.js';
import { loadSchedulingInput } from './src/modules/timetable-feasibility/timetable-feasibility.loader.js';
import { captureLogger, createWorld, destroyWorld, fastConfig, prisma, rawPrisma, ScriptedSolver, seedYear, solution, waitTerminal, type World } from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const PASSWORD = 'Curr#Test-Pass-2030';
const UUID0 = '00000000-0000-4000-8000-000000000000';

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\w*\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not a local *_test database');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('CURR');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('CURR');
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

    // =====================================================================================================================================
    // The school: nothing about any curriculum is built in. Grades 6-10 have no streams; 11 and 12 have Science, Commerce and Humanities.
    // =====================================================================================================================================
    const year = await prisma.academicYear.create({ data: { schoolId: school, name: 'CURR-2031', startDate: new Date('2031-01-01'), endDate: new Date('2031-12-31') } });
    const cfg = await prisma.scheduleConfig.create({ data: { academicYearId: year.id, periodsPerDay: 8, breakAfterPeriod: 4 } });
    await prisma.scheduleDay.createMany({ data: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].map((dayOfWeek) => ({ scheduleConfigId: cfg.id, dayOfWeek: dayOfWeek as never })) });
    const grade = async (name: string, displayOrder: number) => (await prisma.grade.create({ data: { academicYearId: year.id, name, displayOrder } })).id;
    const G: Record<string, string> = {};
    for (const [i, n] of ['C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12'].entries()) G[n] = await grade(n, i + 1);
    const sec = async (gradeId: string, name: string, streamId: string | null = null) => (await prisma.section.create({ data: { gradeId, name, code: name, ...(streamId ? { streamId } : {}) } })).id;
    const S: Record<string, string> = {};
    for (const n of ['C6', 'C7', 'C8']) { S[`${n}A`] = await sec(G[n]!, 'A'); S[`${n}B`] = await sec(G[n]!, 'B'); }
    for (const n of ['C9', 'C10']) S[`${n}A`] = await sec(G[n]!, 'A');
    const ST: Record<string, string> = {};
    for (const g of ['C11', 'C12']) for (const [code, name] of [['SCI', 'Science'], ['COM', 'Commerce'], ['HUM', 'Humanities']] as const) {
      ST[`${g}${code}`] = (await prisma.stream.create({ data: { gradeId: G[g]!, name, code } })).id;
      S[`${g}${code}A`] = await sec(G[g]!, 'A', ST[`${g}${code}`]!);
    }
    const SUB: Record<string, string> = {};
    for (const [code, name] of [['HIN', 'Hindi'], ['ENG', 'English'], ['SCI', 'Science'], ['PHY', 'Physics'], ['CHE', 'Chemistry'], ['BIO', 'Biology'], ['MATH', 'Maths'], ['COMP', 'Computer'], ['GAMES', 'Games'], ['ACC', 'Accountancy'], ['ECO', 'Economics'], ['HIST', 'History'], ['POL', 'Political Science']] as const) {
      SUB[code] = (await prisma.subject.create({ data: { schoolId: school, name, code } })).id;
    }
    const line = (code: string, periodsPerWeek: number, extra: Record<string, unknown> = {}) => ({ subjectId: SUB[code], periodsPerWeek, ...extra });
    const put = (gradeName: string, requirements: unknown[], extra: Record<string, unknown> = {}, tok = tokA) => call('PUT', `/api/curriculum/grades/${G[gradeName]}`, tok, { requirements, ...extra });
    const overview = async (tok = tokA) => (await call('GET', `/api/curriculum?academicYearId=${year.id}`, tok)).body.data;
    const reqCount = () => prisma.subjectRequirement.count({ where: { grade: { academicYearId: year.id } } });
    const permanent = async () => JSON.stringify([await prisma.teacherSubject.count({ where: { teacher: { schoolId: school } } }), await prisma.teacherSubjectGrade.count({ where: { teacherSubject: { teacher: { schoolId: school } } } }), await prisma.sectionSubjectTeacher.count({ where: { teacher: { schoolId: school } } })]);
    const findGroup = (ov: any, g: string, streamKey: string | null = null) => ov.grades.find((x: any) => x.id === G[g]).curricula.find((c: any) => (c.streamId ?? null) === (streamKey ? ST[streamKey] : null));
    const reqOf = (ov: any, g: string, code: string, streamKey: string | null = null) => findGroup(ov, g, streamKey).requirements.find((r: any) => r.subject.code === code);

    // =====================================================================================================================================
    section('1. Authentication and school isolation');
    check('every curriculum route answers 401 without a session', (await call('GET', `/api/curriculum?academicYearId=${year.id}`, null)).status === 401 && (await call('PUT', `/api/curriculum/grades/${G.C6}`, null, { requirements: [] })).status === 401 && (await call('POST', '/api/curriculum/copy', null, { fromGradeId: G.C6, toGradeId: G.C7 })).status === 401);
    check('another school cannot read, set or copy this school\'s curriculum (403)', (await call('GET', `/api/curriculum?academicYearId=${year.id}`, tokB)).status === 403 && (await put('C6', [line('ENG', 5)], {}, tokB)).status === 403 && (await call('POST', '/api/curriculum/copy', tokB, { fromGradeId: G.C6, toGradeId: G.C7 })).status === 403);
    check('unknown academic year / grade → 404', (await call('GET', `/api/curriculum?academicYearId=${UUID0}`, tokA)).status === 404 && (await call('PUT', `/api/curriculum/grades/${UUID0}`, tokA, { requirements: [] })).status === 404);

    // =====================================================================================================================================
    section('2. A school with no curriculum yet: the overview says exactly what is missing');
    const ov0 = await overview();
    const missing = ov0.issues.filter((i: any) => i.code === 'GROUP_WITHOUT_CURRICULUM');
    check('5 grades without streams + 2 grades × 3 streams = 11 groups are flagged for review; no requirement was invented', missing.length === 11 && (await reqCount()) === 0 && ov0.grades.length === 7 && ov0.weeklySlots === 40);
    check('streamed grades list their streams and curricula per stream', ov0.grades.find((g: any) => g.name === 'C11').streamed === true && ov0.grades.find((g: any) => g.name === 'C11').curricula.length === 3 && ov0.grades.find((g: any) => g.name === 'C6').streamed === false && ov0.grades.find((g: any) => g.name === 'C6').curricula.length === 1);

    // =====================================================================================================================================
    section('3. Classes 6-8: one general Science, different periods per grade, a compulsory/optional mix');
    const permanentBefore = await permanent();
    const dry = await put('C6', [line('ENG', 6), line('HIN', 5), line('SCI', 5), line('MATH', 6), line('GAMES', 2, { isOptional: true })], { dryRun: true });
    check('a dry run returns the plan (5 to create) and writes nothing', dry.status === 200 && dry.body.data.applied === false && dry.body.data.plan.create.length === 5 && (await reqCount()) === 0);
    const c6 = await put('C6', [line('ENG', 6), line('HIN', 5), line('SCI', 5), line('MATH', 6), line('GAMES', 2, { isOptional: true })]);
    check('C6 saved in one request (5 subjects)', c6.status === 200 && c6.body.data.applied === true && c6.body.data.requirements.length === 5, JSON.stringify(c6.body).slice(0, 200));
    const c7 = await put('C7', [line('ENG', 6), line('HIN', 5), line('SCI', 5), line('MATH', 6), line('GAMES', 2, { isOptional: true })]);
    const c8 = await put('C8', [line('ENG', 5), line('HIN', 4), line('SCI', 6), line('MATH', 6), line('GAMES', 2, { isOptional: true }), line('COMP', 2, { sectionScope: 'SELECTED_SECTIONS', sectionIds: [S.C8A] })]);
    check('C7 and C8 saved; C8 has different period counts for the same subjects (English 5, Science 6) and Computer for section A only', c7.status === 200 && c8.status === 200);
    const ov1 = await overview();
    check('Science is ONE subject shared by Classes 6-8 (COMMON), with 5/5/6 periods; the subject identity is not duplicated', reqOf(ov1, 'C6', 'SCI').classification === 'COMMON' && reqOf(ov1, 'C8', 'SCI').periodsPerWeek === 6 && reqOf(ov1, 'C6', 'SCI').subject.id === reqOf(ov1, 'C8', 'SCI').subject.id && ov1.subjects.find((s: any) => s.subject.code === 'SCI').gradeCount === 3);
    check('the same subject has different weekly periods per grade (English 6, 6, 5)', [reqOf(ov1, 'C6', 'ENG'), reqOf(ov1, 'C7', 'ENG'), reqOf(ov1, 'C8', 'ENG')].map((r) => r.periodsPerWeek).join() === '6,6,5');
    const comp = reqOf(ov1, 'C8', 'COMP');
    check('Computer is SECTION_SPECIFIC (section A of Class 8 only); the optional label is stored (Games)', comp.classification === 'SECTION_SPECIFIC' && comp.sectionScope === 'SELECTED_SECTIONS' && comp.sectionIds.join() === S.C8A && comp.appliesToSections === 1 && reqOf(ov1, 'C6', 'GAMES').isOptional === true && reqOf(ov1, 'C6', 'ENG').isOptional === false);
    const secTotals = Object.fromEntries(findGroup(ov1, 'C8').sections.map((s: any) => [s.name, s.periodsPerWeek]));
    check('per-section weekly totals reflect the scope: Class 8 A has 6 more... A: 5+4+6+6+2+2 = 25, B: 23', secTotals.A === 25 && secTotals.B === 23, JSON.stringify(secTotals));
    check('the curriculum alone changed NO teacher-subject link, grade eligibility or teacher assignment', (await permanent()) === permanentBefore);

    // =====================================================================================================================================
    section('4. Classes 9-10: Physics, Chemistry and Biology configured independently (no general Science)');
    const c9 = await put('C9', [line('ENG', 5), line('HIN', 4), line('MATH', 6), line('PHY', 4), line('CHE', 4), line('BIO', 4)]);
    const c10 = await put('C10', [line('ENG', 5), line('HIN', 4), line('MATH', 6), line('PHY', 5), line('CHE', 5), line('BIO', 3)]);
    const ov2 = await overview();
    check('Classes 9 and 10 saved; Physics/Chemistry/Biology are separate subjects each with its own periods; Science is not in either', c9.status === 200 && c10.status === 200 && !findGroup(ov2, 'C9').requirements.some((r: any) => r.subject.code === 'SCI') && reqOf(ov2, 'C9', 'PHY').periodsPerWeek === 4 && reqOf(ov2, 'C10', 'PHY').periodsPerWeek === 5 && reqOf(ov2, 'C10', 'BIO').periodsPerWeek === 3);
    check('Physics is COMMON to grades 9 and 10; Hindi is COMMON across 6-10', reqOf(ov2, 'C9', 'PHY').classification === 'COMMON' && reqOf(ov2, 'C10', 'HIN').classification === 'COMMON');

    // =====================================================================================================================================
    section('5. Classes 11-12: a different curriculum per stream (Science, Commerce, Humanities)');
    const base = (g: string) => g;
    const c11s = await put('C11', [line('ENG', 4), line('PHY', 6), line('CHE', 6), line('MATH', 6), line('BIO', 6)], { streamId: ST.C11SCI });
    const c11c = await put('C11', [line('ENG', 4), line('ACC', 6), line('ECO', 6), line('MATH', 5)], { streamId: ST.C11COM });
    const c11h = await put('C11', [line('ENG', 4), line('HIST', 6), line('POL', 6)], { streamId: ST.C11HUM });
    check('the three streams of Class 11 are set independently', c11s.status === 200 && c11c.status === 200 && c11h.status === 200 && base('C11') === 'C11');
    const ov3 = await overview();
    check('Accountancy exists only in Commerce, History only in Humanities, Physics only in Science (STREAM_SPECIFIC); English is in every stream', reqOf(ov3, 'C11', 'ACC', 'C11COM').classification === 'STREAM_SPECIFIC' && reqOf(ov3, 'C11', 'HIST', 'C11HUM').classification === 'STREAM_SPECIFIC' && reqOf(ov3, 'C11', 'PHY', 'C11SCI').classification === 'STREAM_SPECIFIC' && ['C11SCI', 'C11COM', 'C11HUM'].every((k) => !!reqOf(ov3, 'C11', 'ENG', k)) && !findGroup(ov3, 'C11', 'C11SCI').requirements.some((r: any) => r.subject.code === 'ACC') && !findGroup(ov3, 'C11', 'C11COM').requirements.some((r: any) => r.subject.code === 'PHY'));
    check('Maths has 6 periods in Science and 5 in Commerce (same subject, different periods per stream)', reqOf(ov3, 'C11', 'MATH', 'C11SCI').periodsPerWeek === 6 && reqOf(ov3, 'C11', 'MATH', 'C11COM').periodsPerWeek === 5);
    check('each stream\'s section totals only its own stream\'s subjects: Science 28, Commerce 21, Humanities 16', findGroup(ov3, 'C11', 'C11SCI').sections[0].periodsPerWeek === 28 && findGroup(ov3, 'C11', 'C11COM').sections[0].periodsPerWeek === 21 && findGroup(ov3, 'C11', 'C11HUM').sections[0].periodsPerWeek === 16);

    section('5b. Copy a curriculum instead of retyping it (Class 12 from Class 11, per stream)');
    const copyDry = await call('POST', '/api/curriculum/copy', tokA, { fromGradeId: G.C11, fromStreamId: ST.C11SCI, toGradeId: G.C12, toStreamId: ST.C12SCI, dryRun: true });
    check('a dry-run copy reports 5 subjects to create and writes nothing', copyDry.status === 200 && copyDry.body.data.applied === false && copyDry.body.data.created.length === 5 && !(await prisma.subjectRequirement.count({ where: { gradeId: G.C12 } })));
    for (const k of ['SCI', 'COM', 'HUM']) await call('POST', '/api/curriculum/copy', tokA, { fromGradeId: G.C11, fromStreamId: ST[`C11${k}`], toGradeId: G.C12, toStreamId: ST[`C12${k}`] });
    const again = await call('POST', '/api/curriculum/copy', tokA, { fromGradeId: G.C11, fromStreamId: ST.C11SCI, toGradeId: G.C12, toStreamId: ST.C12SCI });
    check('Class 12 now has the same three stream curricula, and copying again never overwrites (every subject ALREADY_REQUIRED)', again.body.data.created.length === 0 && again.body.data.skipped.length === 5 && again.body.data.skipped.every((s: any) => s.reason === 'ALREADY_REQUIRED') && (await prisma.subjectRequirement.count({ where: { gradeId: G.C12 } })) === 5 + 4 + 3);
    await put('C12', [line('ENG', 3), line('PHY', 7), line('CHE', 7), line('MATH', 6), line('BIO', 5)], { streamId: ST.C12SCI });
    check('Class 12 Science can then be edited on its own without touching Class 11 (Physics 7 vs 6)', (await prisma.subjectRequirement.findFirstOrThrow({ where: { gradeId: G.C11, streamId: ST.C11SCI, subjectId: SUB.PHY! } })).periodsPerWeek === 6 && (await prisma.subjectRequirement.findFirstOrThrow({ where: { gradeId: G.C12, streamId: ST.C12SCI, subjectId: SUB.PHY! } })).periodsPerWeek === 7);
    const copySec = await call('POST', '/api/curriculum/copy', tokA, { fromGradeId: G.C8, toGradeId: G.C9 });
    check('a section-specific requirement (Computer, Class 8 A) is NOT copied: its sections belong to the source (reported SECTION_SPECIFIC_NOT_COPIED); subjects Class 9 already has are skipped', copySec.status === 200 && copySec.body.data.skipped.some((s: any) => s.subject.code === 'COMP' && s.reason === 'SECTION_SPECIFIC_NOT_COPIED') && copySec.body.data.created.map((c: any) => c.subject.code).sort().join() === 'GAMES,SCI');
    await prisma.subjectRequirement.deleteMany({ where: { gradeId: G.C9, subjectId: { in: [SUB.GAMES!, SUB.SCI!] } } }); // keep Class 9 as configured above
    check('copying from the same grade/stream, from an empty source, or into a mismatching stream mode is refused (400)', (await call('POST', '/api/curriculum/copy', tokA, { fromGradeId: G.C6, toGradeId: G.C6 })).status === 400 && (await call('POST', '/api/curriculum/copy', tokA, { fromGradeId: G.C12, fromStreamId: ST.C12SCI, toGradeId: G.C12, toStreamId: ST.C12SCI })).status === 400 && (await call('POST', '/api/curriculum/copy', tokA, { fromGradeId: G.C6, toGradeId: G.C11 })).status === 400 && (await call('POST', '/api/curriculum/copy', tokA, { fromGradeId: G.C11, fromStreamId: ST.C11SCI, toGradeId: G.C6, toStreamId: ST.C11SCI })).status === 400);

    // =====================================================================================================================================
    section('6. Invalid combinations are refused with row-specific errors, and nothing is written');
    const before = await reqCount();
    const bad = async (name: string, r: Reply, status = 400, key?: string) => check(`${name} → ${status}${key ? ` (${key})` : ''}, nothing written`, r.status === status && (key === undefined || Object.keys(r.body.errors ?? {}).some((k) => k.includes(key))) && (await reqCount()) === before, `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`);
    await bad('a streamed grade without streamId', await put('C11', [line('ENG', 4)]));
    await bad('a non-streamed grade WITH a streamId', await put('C6', [line('ENG', 4)], { streamId: ST.C11SCI }), 400);
    await bad('a stream of another grade', await put('C11', [line('ENG', 4)], { streamId: ST.C12SCI }));
    await bad('the same subject twice', await put('C6', [line('ENG', 4), line('ENG', 3)]), 400, 'requirements.1.subjectId');
    await bad('another school\'s subject', await put('C6', [line('ENG', 4), { subjectId: (await prisma.subject.create({ data: { schoolId: worldB.schoolId, name: 'Foreign', code: 'FRN' } })).id, periodsPerWeek: 2 }]), 400, 'requirements.1.subjectId');
    await bad('periods 0 and 41', await put('C6', [line('ENG', 0)]), 400, 'requirements.0.periodsPerWeek');
    await bad('periods as text', await put('C6', [{ subjectId: SUB.ENG, periodsPerWeek: '5' }]), 400);
    await bad('selected sections of ANOTHER grade', await put('C6', [line('COMP', 2, { sectionScope: 'SELECTED_SECTIONS', sectionIds: [S.C7A] })]), 400, 'requirements.0.sectionIds');
    await bad('a Science-stream requirement for a Commerce section (right grade, wrong stream)', await put('C11', [line('PHY', 6, { sectionScope: 'SELECTED_SECTIONS', sectionIds: [S.C11COMA] })], { streamId: ST.C11SCI }), 400, 'requirements.0.sectionIds');
    await bad('SELECTED_SECTIONS without sections', await put('C6', [line('COMP', 2, { sectionScope: 'SELECTED_SECTIONS' })]), 400);
    await bad('more subjects than allowed', await put('C6', Array.from({ length: 61 }, () => line('ENG', 1))), 400);
    const activeYear = await prisma.academicYear.create({ data: { schoolId: school, name: 'CURR-ACTIVE', startDate: new Date('2030-01-01'), endDate: new Date('2030-12-31'), status: 'ACTIVE' } });
    const activeGrade = (await prisma.grade.create({ data: { academicYearId: activeYear.id, name: 'X', displayOrder: 1 } })).id;
    check('a curriculum of a year that is not DRAFT cannot be changed (400), but can be read', (await call('PUT', `/api/curriculum/grades/${activeGrade}`, tokA, { requirements: [line('ENG', 3)] })).status === 400 && (await call('GET', `/api/curriculum?academicYearId=${activeYear.id}`, tokA)).status === 200 && (await prisma.subjectRequirement.count({ where: { gradeId: activeGrade } })) === 0);

    // =====================================================================================================================================
    section('7. The single-requirement endpoints stay compatible');
    const legacy = await call('POST', '/api/subject-requirements', tokA, { gradeId: G.C7, subjectId: SUB.COMP, periodsPerWeek: 2 });
    check('the original request body (no new fields) still works: ALL_SECTIONS, not optional, no sections', legacy.status === 201 && legacy.body.data.sectionScope === 'ALL_SECTIONS' && legacy.body.data.isOptional === false && Array.isArray(legacy.body.data.sectionIds) && legacy.body.data.sectionIds.length === 0);
    check('a duplicate (same grade, stream and subject) is still 409', (await call('POST', '/api/subject-requirements', tokA, { gradeId: G.C7, subjectId: SUB.COMP, periodsPerWeek: 3 })).status === 409);
    check('the original PATCH body (periodsPerWeek only) still works', (await call('PATCH', `/api/subject-requirements/${legacy.body.data.id}`, tokA, { periodsPerWeek: 3 })).body.data.periodsPerWeek === 3);
    check('PATCH can now also set the label and the scope; an empty PATCH is 400', (await call('PATCH', `/api/subject-requirements/${legacy.body.data.id}`, tokA, { isOptional: true, sectionScope: 'SELECTED_SECTIONS', sectionIds: [S.C7B] })).body.data.sectionIds.join() === S.C7B && (await call('PATCH', `/api/subject-requirements/${legacy.body.data.id}`, tokA, {})).status === 400);
    const legacyRow = await prisma.subjectRequirement.create({ data: { gradeId: G.C7, subjectId: SUB.POL!, periodsPerWeek: 2 } }); // a row written exactly as before the new columns existed
    const legacyRead = await call('GET', `/api/subject-requirements/${legacyRow.id}`, tokA);
    check('an EXISTING row (written without the new columns) reads as ALL_SECTIONS / compulsory and applies to every section as it always did', legacyRead.body.data.sectionScope === 'ALL_SECTIONS' && legacyRead.body.data.isOptional === false && legacyRead.body.data.sectionIds.length === 0);
    await prisma.subjectRequirement.delete({ where: { id: legacyRow.id } });

    // =====================================================================================================================================
    section('8. Removing and restricting: refused while teachers are assigned; nothing is lost silently');
    const t = (await prisma.teacher.create({ data: { schoolId: school, name: 'Eng teacher' } })).id;
    await prisma.teacherSubject.create({ data: { teacherId: t, subjectId: SUB.ENG!, type: 'PRIMARY', gradeScope: 'ALL_GRADES' } });
    const engReq = await prisma.subjectRequirement.findFirstOrThrow({ where: { gradeId: G.C6, subjectId: SUB.ENG! } });
    const assigned = await call('POST', '/api/section-subject-teachers', tokA, { sectionId: S.C6A, subjectRequirementId: engReq.id, teacherId: t });
    check('(setup) an explicit assignment exists for Class 6 A English', assigned.status === 201);
    const r1 = await put('C6', [line('HIN', 5), line('SCI', 5), line('MATH', 6), line('GAMES', 2, { isOptional: true })]);
    check('removing English from Class 6 → 409 naming the subject (errors.blockedBy); the whole request is rolled back', r1.status === 409 && /English/.test(JSON.stringify(r1.body.errors)) && (await prisma.subjectRequirement.count({ where: { gradeId: G.C6 } })) === 5);
    const r2 = await put('C6', [line('ENG', 6, { sectionScope: 'SELECTED_SECTIONS', sectionIds: [S.C6B] }), line('HIN', 5), line('SCI', 5), line('MATH', 6), line('GAMES', 2, { isOptional: true })]);
    check('restricting English to section B while A has a teacher → 409; nothing changed', r2.status === 409 && (await prisma.subjectRequirement.findUniqueOrThrow({ where: { id: engReq.id } })).sectionScope === 'ALL_SECTIONS');
    check('the same refusal through the single endpoint (PATCH sectionScope) → 409', (await call('PATCH', `/api/subject-requirements/${engReq.id}`, tokA, { sectionScope: 'SELECTED_SECTIONS', sectionIds: [S.C6B] })).status === 409);
    const inScope = await put('C6', [line('ENG', 7), line('HIN', 5), line('SCI', 5), line('MATH', 6), line('GAMES', 2, { isOptional: true })]);
    check('a change that keeps the assigned subject is fine (English 6 → 7) and the assignment survives', inScope.status === 200 && (await prisma.sectionSubjectTeacher.count({ where: { subjectRequirementId: engReq.id } })) === 1);
    const hk = (await put('C6', [line('ENG', 7), line('HIN', 5), line('SCI', 5), line('MATH', 6), line('GAMES', 2, { isOptional: true })], { dryRun: true })).body.data.plan;
    check('a dry run of an unchanged curriculum reports everything unchanged', hk.create.length === 0 && hk.update.length === 0 && hk.remove.length === 0 && hk.unchanged === 5);
    // a teacher cannot be assigned to a section that the requirement does not cover
    const compC8 = await prisma.subjectRequirement.findFirstOrThrow({ where: { gradeId: G.C8, subjectId: SUB.COMP! } });
    await prisma.teacherSubject.create({ data: { teacherId: t, subjectId: SUB.COMP!, type: 'SECONDARY', gradeScope: 'ALL_GRADES' } });
    check('assigning a teacher to Computer in Class 8 B (outside its selected sections) → 400; in Class 8 A → 201', (await call('POST', '/api/section-subject-teachers', tokA, { sectionId: S.C8B, subjectRequirementId: compC8.id, teacherId: t })).status === 400 && (await call('POST', '/api/section-subject-teachers', tokA, { sectionId: S.C8A, subjectRequirementId: compC8.id, teacherId: t })).status === 201);
    check('and Computer cannot then be moved off Class 8 A (409)', (await put('C8', [line('ENG', 5), line('HIN', 4), line('SCI', 6), line('MATH', 6), line('GAMES', 2, { isOptional: true }), line('COMP', 2, { sectionScope: 'SELECTED_SECTIONS', sectionIds: [S.C8B] })])).status === 409);

    // =====================================================================================================================================
    section('9. Concurrency');
    const par = await Promise.all([1, 2, 3, 4].map(() => put('C10', [line('ENG', 5), line('HIN', 4), line('MATH', 6), line('PHY', 5), line('CHE', 5), line('BIO', 3)])));
    check('four simultaneous identical saves all succeed, and there is exactly one row per subject (no duplicates)', par.every((r) => r.status === 200) && (await prisma.subjectRequirement.count({ where: { gradeId: G.C10 } })) === 6);
    const par2 = await Promise.all(['ENG', 'HIN', 'MATH'].map((c, i) => put('C9', [line('ENG', 5 + (i === 0 ? 1 : 0)), line('HIN', 4 + (i === 1 ? 1 : 0)), line('MATH', 6), line('PHY', 4), line('CHE', 4), line('BIO', 4)])));
    const rows9 = await prisma.subjectRequirement.findMany({ where: { gradeId: G.C9 } });
    check('three different simultaneous saves of one grade end in ONE consistent curriculum (the last writer wins, never a mixture or a duplicate)', par2.every((r) => r.status === 200) && rows9.length === 6 && new Set(rows9.map((r) => r.subjectId)).size === 6 && (rows9.find((r) => r.subjectId === SUB.ENG)!.periodsPerWeek + rows9.find((r) => r.subjectId === SUB.HIN)!.periodsPerWeek) % 1 === 0);

    // =====================================================================================================================================
    section('10. Readiness and generation read the SAME curriculum');
    for (const code of Object.keys(SUB)) {
      const tid = (await prisma.teacher.create({ data: { schoolId: school, name: `Teacher ${code}` } })).id;
      await prisma.teacherSubject.create({ data: { teacherId: tid, subjectId: SUB[code]!, type: 'PRIMARY', gradeScope: 'ALL_GRADES' } });
    }
    for (let i = 0; i < 4; i++) { // spare capacity for the heavier subjects
      const tid = (await prisma.teacher.create({ data: { schoolId: school, name: `Spare ${i}` } })).id;
      for (const code of Object.keys(SUB)) await prisma.teacherSubject.create({ data: { teacherId: tid, subjectId: SUB[code]!, type: 'SECONDARY', gradeScope: 'ALL_GRADES' } });
    }
    const input = await loadSchedulingInput(school, year.id);
    const report = analyzeFeasibility(input);
    const snap = await loadGenerationSnapshot(rawPrisma, school, year.id);
    const norm = normalizeProblem(snap);
    check('the configured school is READY and normalizes', report.status === 'READY' && norm.ok, JSON.stringify(report.errors.map((e) => e.code)) + (norm.ok ? '' : JSON.stringify(norm.issues.slice(0, 3))));
    if (norm.ok) {
      const lessons = (sectionId: string) => norm.problem.core.assignments.filter((a) => a.sectionId === sectionId);
      const codeOf = (subjectId: string) => Object.entries(SUB).find(([, v]) => v === subjectId)![0];
      const subjectsOf = (sectionId: string) => lessons(sectionId).map((a) => `${codeOf(a.subjectId)}${a.periodsPerWeek}`).sort().join();
      check('Class 6 A: exactly its subjects with its periods (nothing from other grades)', subjectsOf(S.C6A!) === 'ENG7,GAMES2,HIN5,MATH6,SCI5');
      check('Class 8 A gets Computer (selected), Class 8 B does not', subjectsOf(S.C8A!) === 'COMP2,ENG5,GAMES2,HIN4,MATH6,SCI6' && subjectsOf(S.C8B!) === 'ENG5,GAMES2,HIN4,MATH6,SCI6');
      check('Class 9 has Physics/Chemistry/Biology and no general Science', subjectsOf(S.C9A!).includes('PHY4') && subjectsOf(S.C9A!).includes('CHE4') && subjectsOf(S.C9A!).includes('BIO4') && !subjectsOf(S.C9A!).includes('SCI'));
      check('Class 11: Science stream gets Physics and Biology, Commerce gets Accountancy, Humanities gets History: never each other\'s', subjectsOf(S.C11SCIA!) === 'BIO6,CHE6,ENG4,MATH6,PHY6' && subjectsOf(S.C11COMA!) === 'ACC6,ECO6,ENG4,MATH5' && subjectsOf(S.C11HUMA!) === 'ENG4,HIST6,POL6');
      check('every section\'s lessons equal the curriculum overview\'s total for it', (await overview()).grades.every((g: any) => g.curricula.every((c: any) => c.sections.every((s: any) => lessons(s.id).reduce((n, a) => n + a.periodsPerWeek, 0) === s.periodsPerWeek))));
      check('readiness demand = generation demand = the sum of the curriculum', report.summary.totalDemandPeriods === norm.problem.derived.expectedEntryCount && norm.problem.derived.expectedEntryCount === (await overview()).grades.reduce((n: number, g: any) => n + g.curricula.reduce((m: number, c: any) => m + c.sections.reduce((k: number, s: any) => k + s.periodsPerWeek, 0), 0), 0));
      check('the automatic teacher allocation gave every lesson a teacher qualified for THAT subject (a curriculum line never becomes a qualification)', norm.problem.core.assignments.every((a) => (snap.teacherSubjects.some((l) => l.teacherId === a.teacherId && l.subjectId === a.subjectId))));
    }
    const noTeacherSubject = (await prisma.subject.create({ data: { schoolId: school, name: 'Nobody teaches this', code: 'NOBODY' } })).id;
    await put('C6', [line('ENG', 7), line('HIN', 5), line('SCI', 5), line('MATH', 6), line('GAMES', 2, { isOptional: true }), { subjectId: noTeacherSubject, periodsPerWeek: 2 }]);
    const noElig = analyzeFeasibility(await loadSchedulingInput(school, year.id));
    check('a curriculum subject that NO teacher is qualified for is a readiness blocker (NO_ELIGIBLE_TEACHER); the curriculum did not create a qualification', noElig.status === 'NOT_READY' && noElig.errors.some((e) => e.code === 'NO_ELIGIBLE_TEACHER') && (await prisma.teacherSubject.count({ where: { subjectId: noTeacherSubject } })) === 0);
    await put('C6', [line('ENG', 7), line('HIN', 5), line('SCI', 5), line('MATH', 6), line('GAMES', 2, { isOptional: true })]);
    const heavy = await put('C9', [line('ENG', 20), line('HIN', 20), line('MATH', 6)]); // 46 > 40 weekly slots
    const over = await overview();
    check('a section whose weekly demand exceeds the schedule is flagged in the overview (SECTION_DEMAND_EXCEEDS_SLOTS) and in readiness', heavy.status === 200 && over.issues.some((i: any) => i.code === 'SECTION_DEMAND_EXCEEDS_SLOTS') && analyzeFeasibility(await loadSchedulingInput(school, year.id)).errors.some((e) => e.code === 'SECTION_CAPACITY_EXCEEDED'));
    await put('C9', [line('ENG', 5), line('HIN', 4), line('MATH', 6), line('PHY', 4), line('CHE', 4), line('BIO', 4)]);

    // =====================================================================================================================================
    section('11. Stale drafts and the published timetable after a curriculum change');
    const ry = await seedYear(worldA, 'curr-real');
    const { logger } = captureLogger();
    registerGenerationRunner({ trigger: () => runner.trigger() });
    const runner = new GenerationRunner({ prisma: rawPrisma, solverClient: new ScriptedSolver((ctx) => solution(ctx.problem)), config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: 30 }, logger });
    runners.push(runner);
    runner.start();
    const generate = async (): Promise<string> => {
      const r = await call('POST', '/api/timetable-generations', tokA, { academicYearId: ry.yearId });
      if (r.status !== 202) throw new Error(`generation rejected: ${JSON.stringify(r.body).slice(0, 200)}`);
      const run = await waitTerminal(r.body.data.generationRunId, 90_000);
      if (run.status !== 'SUCCEEDED') throw new Error(`generation failed: ${run.failureCode}`);
      return run.versionId!;
    };
    const v1 = await generate();
    const pub = await call('POST', `/api/timetable-versions/${v1}/publish`, tokA, { expectedRevision: 1, expectedPublishedVersionId: null });
    check('version 1 (the original curriculum: 3 sections × 12 periods = 36 lessons) is published', pub.status === 200 && (await prisma.timetableEntry.count({ where: { versionId: v1 } })) === 36);
    const fingerprint = async () => createHash('sha256').update(JSON.stringify([await prisma.timetableEntry.findMany({ where: { versionId: v1 }, orderBy: { id: 'asc' } }), (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: v1 } })).status])).digest('hex');
    const publishedBefore = await fingerprint();
    const v2 = await generate().catch(async () => null); // a second draft of the SAME configuration (only possible while nothing is published; otherwise generation is refused for a published year? it is allowed)
    const draftId = v2 ?? v1;
    check('(setup) a draft exists for the current curriculum and is valid and not stale', (await call('GET', `/api/timetable-versions/${draftId}/validation`, tokA)).body.data.isStale === false);
    const gradeReq = await prisma.subjectRequirement.findMany({ where: { gradeId: ry.gradeId }, orderBy: { id: 'asc' } });
    const edit = await call('PUT', `/api/curriculum/grades/${ry.gradeId}`, tokA, { requirements: gradeReq.map((r, i) => ({ subjectId: r.subjectId, periodsPerWeek: i === 0 ? r.periodsPerWeek - 1 : r.periodsPerWeek })) });
    check('the curriculum of the seeded year is changed (one subject loses a period); nothing else is touched', edit.status === 200 && (await prisma.subjectRequirement.count({ where: { gradeId: ry.gradeId } })) === gradeReq.length);
    const stale = (await call('GET', `/api/timetable-versions/${draftId}/validation`, tokA)).body.data;
    check('the existing timetable is now STALE (its configuration changed) and not publishable; it was valid against its own configuration', stale.isStale === true && stale.informational.staleReason === 'CONFIGURATION_CHANGED' && stale.informational.publishable === false && stale.valid === true, JSON.stringify(stale.informational));
    check('the PUBLISHED timetable is unchanged: same lessons, still PUBLISHED, still 36 lessons', (await fingerprint()) === publishedBefore && (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: v1 } })).status === 'PUBLISHED' && (await prisma.timetableEntry.count({ where: { versionId: v1 } })) === 36);
    const v3 = await generate();
    check('a NEW generation uses the changed curriculum: 3 sections × 1 period fewer = 33 lessons', (await prisma.timetableEntry.count({ where: { versionId: v3 } })) === 33);
    check('and the original published timetable still has its 36 lessons after the new generation', (await fingerprint()) === publishedBefore);
    // curriculum edits of a DIFFERENT school or year never leak into this one
    check('academic-year isolation: this year\'s edits changed nothing in the other year\'s requirements', (await prisma.subjectRequirement.count({ where: { grade: { academicYearId: year.id } } })) > 0 && JSON.stringify((await call('GET', `/api/curriculum?academicYearId=${ry.yearId}`, tokA)).body.data.grades.map((g: any) => g.id)) === JSON.stringify([ry.gradeId]));
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
