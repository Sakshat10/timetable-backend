// Regression test for HTTP 500 on POST /api/teachers/:teacherId/subjects.
// Root cause that was reproduced: the database the server pointed at had no "teacher_subjects"."gradeScope" column (the
// 20261021090000_add_teacher_subject_grade_scope migration was not applied to it), so Prisma threw P2022 on the first query.
// Covers: (1) the schema/migration guard that fails with a clear message instead of a mysterious 500, (2) the error handler's server-side
// diagnostics and its generic client response, (3) the endpoint's success, validation, conflict and authorization responses.
// MUST run against the disposable local database:   source <guard>/local_test_env.sh && npx tsx test-teacher-subject-create-api.ts
import 'dotenv/config';
import './test-fixtures/test-security-env.js';
import { readdirSync } from 'node:fs';
import { Prisma } from '@prisma/client';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { handleError } from './src/utils/errors.js';
import { hashPassword } from './src/utils/password.js';
import { createWorld, destroyWorld, prisma, type World } from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const PASSWORD = 'TsCreate#Test-Pass-2030';

function fakeReply() {
  const out: { status: number; body: any } = { status: 0, body: null };
  const reply: any = { status(code: number) { out.status = code; return reply; }, send(body: unknown) { out.body = body; return reply; } };
  return { reply, out };
}
function captureErrors<T>(fn: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { return { result: fn(), lines }; } finally { console.error = original; }
}

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\w*\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not a local *_test database');

  section('SCHEMA GUARD: the database has every migration the code needs');
  const applied = await prisma.$queryRaw<Array<{ migration_name: string }>>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`.catch(() => []); // no table: nothing is recorded as applied
  const appliedNames = new Set(applied.map((m) => m.migration_name));
  const pending = readdirSync('prisma/migrations', { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).filter((n) => !appliedNames.has(n));
  check('no migration is pending on this database (otherwise run `prisma migrate deploy` against it)', pending.length === 0, `pending: ${pending.join(', ')}`);
  const col = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'teacher_subjects' AND column_name = 'gradeScope'`;
  check('teacher_subjects.gradeScope exists (the column whose absence caused the 500)', col[0]!.n === 1);
  if (pending.length > 0 || col[0]!.n !== 1) {
    console.log('\nThis database is behind the code: run `prisma migrate deploy` against it, then rerun. Stopping before the endpoint tests.');
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    await prisma.$disconnect();
    process.exit(1);
  }

  section('ERROR HANDLER: generic client response, useful server-side log');
  {
    const err = new Prisma.PrismaClientKnownRequestError('Invalid `prisma.teacherSubject.findUnique()` invocation: SELECT secret_sql_text', { code: 'P2022', clientVersion: 'test', meta: { modelName: 'TeacherSubject', column: 'teacher_subjects.gradeScope' } });
    const { reply, out } = fakeReply();
    const { lines } = captureErrors(() => handleError(err, reply));
    check('P2022 → 500 with the generic message', out.status === 500 && out.body?.message === 'An unexpected error occurred' && out.body?.success === false);
    check('  the response body leaks no code, SQL, model or column', JSON.stringify(out.body) === JSON.stringify({ success: false, message: 'An unexpected error occurred' }));
    const log = lines.join('\n');
    check('  the server log names the Prisma code, model and column', /code=P2022/.test(log) && /model=TeacherSubject/.test(log) && /column=teacher_subjects\.gradeScope/.test(log), log);
    check('  the server log says the schema is behind the code and how to fix it', /schema is behind the code/.test(log) && /prisma migrate deploy/.test(log));
    const other = fakeReply();
    const { lines: l2 } = captureErrors(() => handleError(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2004', clientVersion: 'test' }), other.reply));
    check('another Prisma error → 500 generic, logged with its code but without the migration hint', other.out.status === 500 && /code=P2004/.test(l2.join('\n')) && !/migrate deploy/.test(l2.join('\n')));
    const dup = fakeReply();
    handleError(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: 'test', meta: { target: ['teacherId'] } }), dup.reply);
    check('existing behaviour kept: unique violation P2002 → 409', dup.out.status === 409);
  }

  section('ENDPOINT: POST /api/teachers/:teacherId/subjects');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('TSCREATE');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('TSCREATE');
  const worlds: World[] = [worldA, worldB];
  const call = async (url: string, cookie: string | null, payload?: unknown) => {
    const res = await app.inject({ method: 'POST', url, ...(cookie ? { headers: { cookie: `session_token=${cookie}` } } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
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
    const teacher = async (w: World, over: { isActive?: boolean } = {}) => (await prisma.teacher.create({ data: { schoolId: w.schoolId, name: 'T', ...over } })).id;
    const subject = async (w: World, code: string) => (await prisma.subject.create({ data: { schoolId: w.schoolId, name: code, code } })).id;
    const url = (t: string) => `/api/teachers/${t}/subjects`;
    const sub1 = await subject(worldA, 'MATH');
    const sub2 = await subject(worldA, 'SCI');
    const foreignSubject = await subject(worldB, 'MATH');
    const t1 = await teacher(worldA);

    const ok = await call(url(t1), tokA, { subjectId: sub1, type: 'PRIMARY' });
    check('valid body → 201, gradeScope defaults to SELECTED_GRADES, subject summary included', ok.status === 201 && ok.body.data?.gradeScope === 'SELECTED_GRADES' && ok.body.data?.type === 'PRIMARY' && ok.body.data?.subject?.code === 'MATH', JSON.stringify(ok.body));
    const row = await prisma.teacherSubject.findUnique({ where: { teacherId_subjectId: { teacherId: t1, subjectId: sub1 } } });
    check('  the row is stored with gradeScope SELECTED_GRADES', row?.gradeScope === 'SELECTED_GRADES');
    const all = await call(url(t1), tokA, { subjectId: sub2, type: 'SECONDARY', gradeScope: 'ALL_GRADES' });
    check('explicit ALL_GRADES → 201 and stored', all.status === 201 && all.body.data?.gradeScope === 'ALL_GRADES');
    const dup = await call(url(t1), tokA, { subjectId: sub1, type: 'SECONDARY' });
    check('same (teacher, subject) again → 409 conflict (not 500)', dup.status === 409, JSON.stringify(dup.body));
    check('missing type → 400', (await call(url(t1), tokA, { subjectId: sub1 })).status === 400);
    check('missing subjectId → 400', (await call(url(t1), tokA, { type: 'PRIMARY' })).status === 400);
    check('subjectId not a UUID → 400', (await call(url(t1), tokA, { subjectId: 'nope', type: 'PRIMARY' })).status === 400);
    check('invalid type → 400', (await call(url(t1), tokA, { subjectId: sub1, type: 'MAIN' })).status === 400);
    check('invalid gradeScope → 400', (await call(url(await teacher(worldA)), tokA, { subjectId: sub1, type: 'PRIMARY', gradeScope: 'MANY' })).status === 400);
    check('teacherId not a UUID → 400', (await call('/api/teachers/not-a-uuid/subjects', tokA, { subjectId: sub1, type: 'PRIMARY' })).status === 400);
    check('unknown teacher → 404', (await call(url('00000000-0000-4000-8000-000000000000'), tokA, { subjectId: sub1, type: 'PRIMARY' })).status === 404);
    check('unknown subject → 404', (await call(url(await teacher(worldA)), tokA, { subjectId: '00000000-0000-4000-8000-000000000000', type: 'PRIMARY' })).status === 404);
    check('another school\'s teacher → 403', (await call(url(t1), tokB, { subjectId: foreignSubject, type: 'PRIMARY' })).status === 403);
    check('another school\'s subject for this school\'s teacher → 403', (await call(url(await teacher(worldA)), tokA, { subjectId: foreignSubject, type: 'PRIMARY' })).status === 403);
    check('inactive teacher → 400', (await call(url(await teacher(worldA, { isActive: false })), tokA, { subjectId: sub1, type: 'PRIMARY' })).status === 400);
    check('unauthenticated → 401', (await call(url(t1), null, { subjectId: sub1, type: 'PRIMARY' })).status === 401);
    const concTeacher = await teacher(worldA);
    const conc = await Promise.all([1, 2, 3, 4].map(() => call(url(concTeacher), tokA, { subjectId: sub1, type: 'PRIMARY' })));
    check('4 concurrent identical requests: exactly one 201, the rest 409, never 500', conc.filter((r) => r.status === 201).length === 1 && conc.filter((r) => r.status === 409).length === 3, conc.map((r) => r.status).join());
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
