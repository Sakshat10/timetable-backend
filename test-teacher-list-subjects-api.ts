// GET /api/teachers returns each teacher's linked subjects ({ id, name, code, type }), [] for none, school-isolated, with the existing isActive filter and ordering intact, in one query.
// buildApp() + app.inject(), real database (disposable local one only), test schools only.
//   source <guard>/local_test_env.sh && npx tsx test-teacher-list-subjects-api.ts
import 'dotenv/config';
import './test-fixtures/test-security-env.js';
import prismaApp from './src/config/database.js';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { createWorld, destroyWorld, prisma, type World } from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const PASSWORD = 'TList#Test-Pass-2030';

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\w*\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not a local *_test database');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('TLIST');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('TLIST');
  const worlds: World[] = [worldA, worldB];

  const call = async (url: string, cookie: string | null) => {
    const res = await app.inject({ method: 'GET', url, ...(cookie ? { headers: { cookie: `session_token=${cookie}` } } : {}) });
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
    const subject = (schoolId: string, name: string, code: string) => prisma.subject.create({ data: { schoolId, name, code } });
    const [math, sci, eng] = [await subject(worldA.schoolId, 'Mathematics', 'MATH'), await subject(worldA.schoolId, 'Science', 'SCI'), await subject(worldA.schoolId, 'English', 'ENG')];
    const foreign = await subject(worldB.schoolId, 'Foreign subject', 'FRN');
    const teacher = (schoolId: string, name: string, isActive = true) => prisma.teacher.create({ data: { schoolId, name, isActive } });
    const none = await teacher(worldA.schoolId, 'Zero Subjects');
    const one = await teacher(worldA.schoolId, 'One Subject');
    const many = await teacher(worldA.schoolId, 'Many Subjects');
    const gone = await teacher(worldA.schoolId, 'Inactive Teacher', false);
    const theirs = await teacher(worldB.schoolId, 'Other School Teacher');
    const link = (teacherId: string, subjectId: string, type: 'PRIMARY' | 'SECONDARY') => prisma.teacherSubject.create({ data: { teacherId, subjectId, type, gradeScope: 'ALL_GRADES' } });
    await link(one.id, math.id, 'PRIMARY');
    await link(many.id, sci.id, 'SECONDARY');
    await link(many.id, math.id, 'PRIMARY');
    await link(many.id, eng.id, 'PRIMARY');
    await link(gone.id, eng.id, 'SECONDARY');
    await link(theirs.id, foreign.id, 'PRIMARY');

    section('1. Authentication');
    check('401 without a session', (await call('/api/teachers', null)).status === 401);

    section('2. Shape and content');
    const res = await call('/api/teachers', tokA);
    const list: any[] = res.body.data;
    const byName = (n: string) => list.find((t) => t.name === n);
    check('200 with the standard envelope and only this school\'s teachers', res.status === 200 && res.body.success === true && res.body.message === 'Teachers retrieved successfully' && list.length === 4 && !list.some((t) => t.id === theirs.id));
    check('every existing teacher field is still there', list.every((t) => ['id', 'schoolId', 'name', 'employeeCode', 'isActive', 'createdAt', 'updatedAt'].every((k) => k in t)) && list.every((t) => t.schoolId === worldA.schoolId));
    check('every teacher has a subjects array, and nothing else was added', list.every((t) => Array.isArray(t.subjects)) && list.every((t) => Object.keys(t).sort().join() === 'createdAt,employeeCode,id,isActive,name,schoolId,subjects,updatedAt'));
    check('a teacher with NO linked subjects has an empty array', Array.isArray(byName('Zero Subjects').subjects) && byName('Zero Subjects').subjects.length === 0);
    check('a teacher with ONE subject: exactly { id, name, code, type }', JSON.stringify(byName('One Subject').subjects) === JSON.stringify([{ id: math.id, name: 'Mathematics', code: 'MATH', type: 'PRIMARY' }]));
    check('a teacher with several subjects lists all of them with their own PRIMARY/SECONDARY type, ordered by subject name', JSON.stringify(byName('Many Subjects').subjects) === JSON.stringify([{ id: eng.id, name: 'English', code: 'ENG', type: 'PRIMARY' }, { id: math.id, name: 'Mathematics', code: 'MATH', type: 'PRIMARY' }, { id: sci.id, name: 'Science', code: 'SCI', type: 'SECONDARY' }]));
    check('the same subject can be PRIMARY for one teacher and SECONDARY for another', byName('Inactive Teacher').subjects[0].type === 'SECONDARY' && byName('Many Subjects').subjects.find((s: any) => s.id === eng.id).type === 'PRIMARY');
    check('the existing name ordering is kept', list.map((t) => t.name).join() === ['Inactive Teacher', 'Many Subjects', 'One Subject', 'Zero Subjects'].join());

    section('3. Filters');
    const active = await call('/api/teachers?isActive=true', tokA);
    const inactive = await call('/api/teachers?isActive=false', tokA);
    check('isActive=true keeps only active teachers, with their subjects', active.body.data.length === 3 && active.body.data.every((t: any) => t.isActive) && active.body.data.find((t: any) => t.name === 'Many Subjects').subjects.length === 3);
    check('isActive=false keeps only the inactive teacher, with their subject', inactive.body.data.length === 1 && inactive.body.data[0].subjects.length === 1 && inactive.body.data[0].subjects[0].code === 'ENG');
    check('an invalid filter is still 400', (await call('/api/teachers?isActive=maybe', tokA)).status === 400);

    section('4. School isolation');
    const other = await call('/api/teachers', tokB);
    check('the other school sees only its own teacher and its own subject', other.body.data.length === 1 && other.body.data[0].id === theirs.id && JSON.stringify(other.body.data[0].subjects) === JSON.stringify([{ id: foreign.id, name: 'Foreign subject', code: 'FRN', type: 'PRIMARY' }]));
    check('school A never sees school B\'s subject anywhere in its response', !JSON.stringify(res.body).includes(foreign.id) && !JSON.stringify(res.body).includes('FRN'));
    // a link that crosses schools (impossible through the API; written directly) must still not leak
    const rogue = await prisma.teacherSubject.create({ data: { teacherId: none.id, subjectId: foreign.id, type: 'SECONDARY', gradeScope: 'ALL_GRADES' } });
    const leak = await call('/api/teachers', tokA);
    check('even a corrupt cross-school link does not expose the other school\'s subject', !JSON.stringify(leak.body).includes(foreign.id) && leak.body.data.find((t: any) => t.name === 'Zero Subjects').subjects.length === 0);
    await prisma.teacherSubject.delete({ where: { id: rogue.id } });

    section('5. One query, no N+1');
    const counts: Record<string, number> = {};
    const wrap = (model: string, fn: string) => {
      const delegate = (prismaApp as any)[model];
      const original = delegate[fn].bind(delegate);
      delegate[fn] = (...args: unknown[]) => { counts[`${model}.${fn}`] = (counts[`${model}.${fn}`] ?? 0) + 1; return original(...args); };
    };
    for (const [m, f] of [['teacher', 'findMany'], ['teacher', 'findUnique'], ['teacherSubject', 'findMany'], ['subject', 'findMany'], ['subject', 'findUnique']] as const) wrap(m, f);
    await call('/api/teachers', tokA);
    check('the list is ONE teacher query with the subjects included (no per-teacher or per-link lookups)', counts['teacher.findMany'] === 1 && !counts['teacherSubject.findMany'] && !counts['subject.findMany'] && !counts['subject.findUnique'] && !counts['teacher.findUnique'], JSON.stringify(counts));

    section('6. Other endpoints are unchanged');
    const single = await call(`/api/teachers/${many.id}`, tokA);
    check('GET /api/teachers/:id still returns the teacher without a subjects field', single.status === 200 && !('subjects' in single.body.data) && single.body.data.name === 'Many Subjects');
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
