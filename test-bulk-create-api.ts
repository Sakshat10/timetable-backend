// Bulk creation: POST /api/subjects/bulk, /api/teachers/bulk (idempotent) and /api/grades/bulk (grade -> streams -> sections).
// buildApp() + app.inject() (real routes, auth, sessions), real database, test schools only (removed at the end).
// MUST run against the disposable local database:   source <guard>/local_test_env.sh && npx tsx test-bulk-create-api.ts
import 'dotenv/config';
import './test-fixtures/test-security-env.js';
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
const PASSWORD = 'Bulk#Test-Pass-2030';

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '') || !/_test\b/.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing to run: DATABASE_URL is not the local *_test database');
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('BULK');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('BULK');
  const worlds: World[] = [worldA, worldB];

  interface Reply { status: number; body: Record<string, any>; headers: Record<string, any> }
  const call = async (method: 'GET' | 'POST', url: string, cookie: string | null, payload?: unknown, headers: Record<string, string> = {}): Promise<Reply> => {
    const res = await app.inject({ method, url, headers: { ...(cookie ? { cookie: `session_token=${cookie}` } : {}), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    let body: Record<string, any> = {};
    try { body = JSON.parse(res.body); } catch { /* not JSON */ }
    return { status: res.statusCode, body, headers: res.headers };
  };
  const sessionFor = async (world: World): Promise<string> => {
    const admin = await prisma.admin.findUniqueOrThrow({ where: { id: world.adminId } });
    await prisma.admin.update({ where: { id: admin.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
    return (await adminService.loginAdmin({ schoolId: world.schoolId, email: admin.email, password: PASSWORD })).sessionToken;
  };

  try {
    const tokA = await sessionFor(worldA);
    const tokB = await sessionFor(worldB);
    const keys = (r: Reply): string[] => Object.keys(r.body.errors ?? {});
    const subjectCount = (w: World) => prisma.subject.count({ where: { schoolId: w.schoolId } });
    const teacherCount = (w: World) => prisma.teacher.count({ where: { schoolId: w.schoolId } });

    // =====================================================================================================
    section('SUBJECTS: POST /api/subjects/bulk');
    const s1 = await call('POST', '/api/subjects/bulk', tokA, { subjects: [{ name: '  Mathematics ', code: ' math ' }, { name: 'Science', code: 'sci-1' }, { name: 'English', code: 'ENG' }] });
    check('3 valid subjects → 201 in input order, normalised', s1.status === 201 && s1.body.data?.map((d: any) => d.code).join() === 'MATH,SCI-1,ENG' && s1.body.data[0].name === 'Mathematics', JSON.stringify(s1.body));
    check('  all 3 persisted for the school', (await subjectCount(worldA)) === 3);
    const single = await call('POST', '/api/subjects', tokA, { name: 'Single', code: 'SGL' });
    check('single-record endpoint still works (201) and sees bulk codes as duplicates', single.status === 201 && (await call('POST', '/api/subjects', tokA, { name: 'x', code: 'math' })).status === 409);

    const before = await subjectCount(worldA);
    const sBad = await call('POST', '/api/subjects/bulk', tokA, { subjects: [{ name: 'Fine', code: 'FINE' }, { name: '', code: 'bad code!' }, { name: 'Fine2', code: 'FINE2' }] });
    check('one invalid row → 400 with row-specific keys, nothing created', sBad.status === 400 && keys(sBad).some((k) => k.startsWith('subjects.1.')) && (await subjectCount(worldA)) === before, JSON.stringify(sBad.body));
    const sDupReq = await call('POST', '/api/subjects/bulk', tokA, { subjects: [{ name: 'A', code: 'DUPX' }, { name: 'B', code: 'dupx' }] });
    check('in-request duplicate code (case-insensitive) → 400 on the second row, nothing created', sDupReq.status === 400 && keys(sDupReq).includes('subjects.1.code') && (await subjectCount(worldA)) === before, JSON.stringify(sDupReq.body));
    const sConflict = await call('POST', '/api/subjects/bulk', tokA, { subjects: [{ name: 'New1', code: 'NEW1' }, { name: 'Maths again', code: 'MATH' }, { name: 'New2', code: 'NEW2' }] });
    check('code already in the school → 409 on that row; the other rows are rolled back (not created)', sConflict.status === 409 && keys(sConflict).join() === 'subjects.1.code' && (await subjectCount(worldA)) === before && (await prisma.subject.count({ where: { schoolId: worldA.schoolId, code: { in: ['NEW1', 'NEW2'] } } })) === 0, JSON.stringify(sConflict.body));
    check('empty list → 400', (await call('POST', '/api/subjects/bulk', tokA, { subjects: [] })).status === 400);
    check('missing "subjects" → 400', (await call('POST', '/api/subjects/bulk', tokA, {})).status === 400);
    const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ name: `${p} ${i}`, code: `${p}${i}` }));
    const s101 = await call('POST', '/api/subjects/bulk', tokA, { subjects: many(101, 'CAP') });
    check('101 subjects → 400 (cap is 100), nothing created', s101.status === 400 && (await subjectCount(worldA)) === before);
    const s100 = await call('POST', '/api/subjects/bulk', tokA, { subjects: many(100, 'OK') });
    check('exactly 100 subjects → 201', s100.status === 201 && s100.body.data?.length === 100, String(s100.status));
    const sB = await call('POST', '/api/subjects/bulk', tokB, { subjects: [{ name: 'Mathematics', code: 'MATH' }] });
    check('school isolation: the same code in another school is allowed (201) and lands in that school only', sB.status === 201 && (await subjectCount(worldB)) === 1 && (await prisma.subject.count({ where: { schoolId: worldA.schoolId, code: 'MATH' } })) === 1);
    check('unauthenticated → 401', (await call('POST', '/api/subjects/bulk', null, { subjects: many(1, 'NA') })).status === 401);
    const race = await Promise.all([1, 2, 3, 4].map(() => call('POST', '/api/subjects/bulk', tokA, { subjects: [{ name: 'R1', code: 'RACE1' }, { name: 'R2', code: 'RACE2' }, { name: 'R3', code: 'RACE3' }] })));
    check('4 concurrent identical requests: exactly one 201, the rest 409', race.filter((r) => r.status === 201).length === 1 && race.filter((r) => r.status === 409).length === 3, race.map((r) => r.status).join());
    check('  exactly 3 rows exist (no partial/double creation)', (await prisma.subject.count({ where: { schoolId: worldA.schoolId, code: { startsWith: 'RACE' } } })) === 3);

    // =====================================================================================================
    section('TEACHERS: POST /api/teachers/bulk (atomic + idempotent)');
    const idem = (k: string) => ({ 'idempotency-key': k });
    const t1body = { teachers: [{ name: ' Asha ', employeeCode: ' t-001 ' }, { name: 'Ravi' }, { name: 'Meena', employeeCode: '', isActive: false }, { name: 'Ravi' }] };
    const t1 = await call('POST', '/api/teachers/bulk', tokA, t1body, idem('key-aaaa-0001'));
    check('4 teachers → 201, normalised, order kept (incl. two identical no-code names)', t1.status === 201 && t1.body.replayed === false && t1.body.data?.length === 4 && t1.body.data[0].employeeCode === 'T-001' && t1.body.data[0].name === 'Asha' && t1.body.data[2].isActive === false && t1.body.data[1].employeeCode === null, JSON.stringify(t1.body));
    check('  4 teachers persisted', (await teacherCount(worldA)) === 4);
    const t1b = await call('POST', '/api/teachers/bulk', tokA, t1body, idem('key-aaaa-0001'));
    check('retry: same key + same body → 200, replayed, the SAME ids, header set', t1b.status === 200 && t1b.body.replayed === true && t1b.headers['idempotent-replay'] === 'true' && JSON.stringify(t1b.body.data.map((d: any) => d.id)) === JSON.stringify(t1.body.data.map((d: any) => d.id)), JSON.stringify(t1b.body));
    check('  no duplicates created by the retry (still 4)', (await teacherCount(worldA)) === 4);
    const t1c = await call('POST', '/api/teachers/bulk', tokA, { teachers: [{ name: 'Different' }] }, idem('key-aaaa-0001'));
    check('same key + DIFFERENT body → 409 with a clear message, nothing created', t1c.status === 409 && /different request body/i.test(t1c.body.message) && (await teacherCount(worldA)) === 4, JSON.stringify(t1c.body));
    const reordered = await call('POST', '/api/teachers/bulk', tokA, { teachers: [t1body.teachers[1], t1body.teachers[0], t1body.teachers[2], t1body.teachers[3]] }, idem('key-aaaa-0001'));
    check('same key + same rows in a different order → 409 (order is part of the request)', reordered.status === 409);
    check('missing Idempotency-Key → 400', (await call('POST', '/api/teachers/bulk', tokA, { teachers: [{ name: 'X' }] })).status === 400);
    check('too-short / illegal Idempotency-Key → 400', (await call('POST', '/api/teachers/bulk', tokA, { teachers: [{ name: 'X' }] }, idem('short'))).status === 400 && (await call('POST', '/api/teachers/bulk', tokA, { teachers: [{ name: 'X' }] }, idem('bad key with spaces!'))).status === 400);
    check('nothing was created by the rejected requests', (await teacherCount(worldA)) === 4);

    const tConflict = await call('POST', '/api/teachers/bulk', tokA, { teachers: [{ name: 'N1', employeeCode: 'NEW-1' }, { name: 'N2', employeeCode: 'T-001' }, { name: 'N3' }] }, idem('key-bbbb-0002'));
    check('employee code already in the school → 409 on that row; other rows rolled back', tConflict.status === 409 && Object.keys(tConflict.body.errors ?? {}).join() === 'teachers.1.employeeCode' && (await teacherCount(worldA)) === 4, JSON.stringify(tConflict.body));
    check('  the failed request stored no idempotency record (rolled back with the teachers)', (await prisma.teacherBulkRequest.count({ where: { schoolId: worldA.schoolId, idempotencyKey: 'key-bbbb-0002' } })) === 0);
    const tFixed = await call('POST', '/api/teachers/bulk', tokA, { teachers: [{ name: 'N1', employeeCode: 'NEW-1' }, { name: 'N3' }] }, idem('key-bbbb-0002'));
    check('  the same key can be reused with a corrected body → 201', tFixed.status === 201 && (await teacherCount(worldA)) === 6, JSON.stringify(tFixed.body));
    const tDupReq = await call('POST', '/api/teachers/bulk', tokA, { teachers: [{ name: 'A', employeeCode: 'dup-9' }, { name: 'B', employeeCode: 'DUP-9' }] }, idem('key-cccc-0003'));
    check('in-request duplicate employee code → 400 on the second row', tDupReq.status === 400 && Object.keys(tDupReq.body.errors ?? {}).includes('teachers.1.employeeCode') && (await teacherCount(worldA)) === 6);
    const tInvalid = await call('POST', '/api/teachers/bulk', tokA, { teachers: [{ name: 'Ok' }, { name: '   ' }] }, idem('key-dddd-0004'));
    check('invalid row (blank name) → 400 keyed teachers.1.name, nothing created', tInvalid.status === 400 && Object.keys(tInvalid.body.errors ?? {}).includes('teachers.1.name') && (await teacherCount(worldA)) === 6);
    const t101 = await call('POST', '/api/teachers/bulk', tokA, { teachers: Array.from({ length: 101 }, (_, i) => ({ name: `T${i}` })) }, idem('key-eeee-0005'));
    check('101 teachers → 400 (cap is 100)', t101.status === 400);
    const t100 = await call('POST', '/api/teachers/bulk', tokA, { teachers: Array.from({ length: 100 }, (_, i) => ({ name: `Bulk ${i}` })) }, idem('key-ffff-0006'));
    check('exactly 100 teachers → 201', t100.status === 201 && t100.body.data?.length === 100);
    check('unauthenticated → 401', (await call('POST', '/api/teachers/bulk', null, { teachers: [{ name: 'X' }] }, idem('key-gggg-0007'))).status === 401);

    const conc = await Promise.all(Array.from({ length: 12 }, () => call('POST', '/api/teachers/bulk', tokA, { teachers: Array.from({ length: 5 }, (_, i) => ({ name: `Conc ${i}` })) }, idem('key-conc-0008'))));
    const created = conc.filter((r) => r.status === 201);
    const replays = conc.filter((r) => r.status === 200);
    check('12 CONCURRENT requests with one key: exactly one 201, all others 200 replays', created.length === 1 && replays.length === 11, conc.map((r) => r.status).join());
    check('  exactly 5 teachers exist (never duplicated)', (await prisma.teacher.count({ where: { schoolId: worldA.schoolId, name: { startsWith: 'Conc ' } } })) === 5);
    check('  every response carries the same 5 ids', new Set(conc.map((r) => JSON.stringify(r.body.data.map((d: any) => d.id)))).size === 1);
    const concDiff = await Promise.all(['one', 'two', 'three', 'four'].map((n) => call('POST', '/api/teachers/bulk', tokA, { teachers: [{ name: `Diff ${n}` }] }, idem('key-diff-0009'))));
    check('4 concurrent requests, one key, DIFFERENT bodies: one 201, the rest 409; exactly one teacher created', concDiff.filter((r) => r.status === 201).length === 1 && concDiff.filter((r) => r.status === 409).length === 3 && (await prisma.teacher.count({ where: { schoolId: worldA.schoolId, name: { startsWith: 'Diff ' } } })) === 1, concDiff.map((r) => r.status).join());
    const concCode = await Promise.all([1, 2, 3].map((n) => call('POST', '/api/teachers/bulk', tokA, { teachers: [{ name: `Coded ${n}`, employeeCode: 'RACE-CODE' }, { name: `Coded extra ${n}` }] }, idem(`key-code-000${n}`))));
    check('concurrent requests with DIFFERENT keys racing on one employee code: one 201, rest 409, nothing partial', concCode.filter((r) => r.status === 201).length === 1 && concCode.filter((r) => r.status === 409).length === 2 && (await prisma.teacher.count({ where: { schoolId: worldA.schoolId, name: { startsWith: 'Coded ' } } })) === 2, concCode.map((r) => r.status).join());
    check('  the losers left no idempotency rows', (await prisma.teacherBulkRequest.count({ where: { schoolId: worldA.schoolId, idempotencyKey: { startsWith: 'key-code-' } } })) === 1);

    const tOther = await call('POST', '/api/teachers/bulk', tokB, t1body, idem('key-aaaa-0001'));
    check('school isolation: the same key in another school is independent (201, new teachers there)', tOther.status === 201 && tOther.body.replayed === false && (await teacherCount(worldB)) === 4);
    check('  and school B teacher ids differ from school A\'s', tOther.body.data.every((d: any) => !t1.body.data.some((a: any) => a.id === d.id)) && tOther.body.data.every((d: any) => d.schoolId === worldB.schoolId));
    const singleTeacher = await call('POST', '/api/teachers', tokA, { name: 'Single teacher', employeeCode: 'SGL-1' });
    check('single-record teacher endpoint unchanged (201) and sees bulk codes as duplicates (409)', singleTeacher.status === 201 && (await call('POST', '/api/teachers', tokA, { name: 'x', employeeCode: 't-001' })).status === 409);

    // =====================================================================================================
    section('GRADE STRUCTURE: POST /api/grades/bulk');
    const mkYear = async (world: World, name: string, status: 'DRAFT' | 'ACTIVE' = 'DRAFT') => (await prisma.academicYear.create({ data: { schoolId: world.schoolId, name, startDate: new Date('2031-01-01'), endDate: new Date('2031-12-31'), status } })).id;
    const yearA = await mkYear(worldA, 'BULK-A');
    const counts = async (yearId: string) => ({
      grades: await prisma.grade.count({ where: { academicYearId: yearId } }),
      streams: await prisma.stream.count({ where: { grade: { academicYearId: yearId } } }),
      sections: await prisma.section.count({ where: { grade: { academicYearId: yearId } } }),
    });
    const same = (a: { grades: number; streams: number; sections: number }, b: typeof a) => a.grades === b.grades && a.streams === b.streams && a.sections === b.sections;
    const post = (body: unknown, tok = tokA) => call('POST', '/api/grades/bulk', tok, body);
    const structure = {
      academicYearId: yearA,
      grades: [
        { name: 'Grade 6', displayOrder: 1, sections: [{ name: 'Section A', code: 'A' }, { name: 'Section B', code: 'B' }] },
        { name: 'Grade 11', displayOrder: 2, streams: [{ name: 'Science', code: 'sci' }, { name: 'Commerce', code: 'COM' }], sections: [{ name: 'Sci A', code: 'A', streamCode: 'SCI' }, { name: 'Sci B', code: 'B', streamCode: 'sci' }, { name: 'Com A', code: 'A', streamCode: 'COM' }] },
        { name: 'Nursery', displayOrder: 3 },
        { name: 'Grade 12', displayOrder: 4, streams: [{ name: 'Arts', code: 'ART' }] },
      ],
    };
    const g1 = await post(structure);
    check('nested structure → 201', g1.status === 201, JSON.stringify(g1.body).slice(0, 400));
    const gData = g1.body.data?.grades ?? [];
    check('  4 grades, with nested streams and sections, ids present, input order kept', gData.map((g: any) => g.name).join() === 'Grade 6,Grade 11,Nursery,Grade 12' && gData[1].streams.length === 2 && gData[1].sections.length === 3 && gData[0].sections.length === 2 && gData[2].sections.length === 0 && gData[3].streams.length === 1 && !!gData[0].id);
    check('  stream codes normalised (uppercase); sections reference the right stream ids', gData[1].streams[0].code === 'SCI' && gData[1].sections[1].streamId === gData[1].streams[0].id && gData[1].sections[2].streamId === gData[1].streams[1].id && gData[0].sections[0].streamId === null);
    check('  database counts: 4 grades, 3 streams, 5 sections', same(await counts(yearA), { grades: 4, streams: 3, sections: 5 }), JSON.stringify(await counts(yearA)));
    const sameCodeTwoStreams = await prisma.section.count({ where: { gradeId: gData[1].id, code: 'A' } });
    check('  the same section code in two different streams is allowed (2 × "A")', sameCodeTwoStreams === 2);
    const followUnstreamed = await call('POST', '/api/sections', tokA, { gradeId: gData[1].id, name: 'Loose', code: 'Z' });
    check('  existing single-record rules still apply afterwards: a non-streamed section in the streamed grade → 400', followUnstreamed.status === 400);
    const followStreamed = await call('POST', '/api/sections', tokA, { gradeId: gData[1].id, streamId: gData[1].streams[0].id, name: 'Sci C', code: 'C' });
    check('  and a streamed section can still be added (201)', followStreamed.status === 201);

    const base = await counts(yearA);
    const expectRejected = async (name: string, body: unknown, status: number, keyIncludes?: string, tok = tokA) => {
      const r = await post(body, tok);
      check(`${name} → ${status}${keyIncludes ? ` (${keyIncludes})` : ''}, nothing created`, r.status === status && (keyIncludes === undefined || keys(r).some((k) => k.includes(keyIncludes))) && same(await counts(yearA), base), `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    };
    const yb = (grades: unknown[]) => ({ academicYearId: yearA, grades });
    await expectRejected('existing grade name in the year', yb([{ name: 'New G', displayOrder: 10, streams: [{ name: 'S', code: 'S' }], sections: [{ name: 'a', code: 'A', streamCode: 'S' }] }, { name: 'Grade 6', displayOrder: 11 }]), 409, 'grades.1.name');
    await expectRejected('existing display order in the year', yb([{ name: 'Another', displayOrder: 1 }]), 409, 'grades.0.displayOrder');
    await expectRejected('duplicate grade name inside the request', yb([{ name: 'D', displayOrder: 20 }, { name: 'D', displayOrder: 21 }]), 400, 'grades.1.name');
    await expectRejected('duplicate display order inside the request', yb([{ name: 'D1', displayOrder: 20 }, { name: 'D2', displayOrder: 20 }]), 400, 'grades.1.displayOrder');
    await expectRejected('duplicate stream code (case-insensitive) in one grade', yb([{ name: 'G', displayOrder: 20, streams: [{ name: 'One', code: 'x' }, { name: 'Two', code: 'X' }] }]), 400, 'streams.1.code');
    await expectRejected('duplicate stream name (case-insensitive) in one grade', yb([{ name: 'G', displayOrder: 20, streams: [{ name: 'Science', code: 'A' }, { name: 'SCIENCE', code: 'B' }] }]), 400, 'streams.1.name');
    await expectRejected('section names a stream that is not declared', yb([{ name: 'G', displayOrder: 20, streams: [{ name: 'S', code: 'S' }], sections: [{ name: 'a', code: 'A', streamCode: 'NOPE' }] }]), 400, 'sections.0.streamCode');
    await expectRejected('section with streamCode but the grade declares no streams', yb([{ name: 'G', displayOrder: 20, sections: [{ name: 'a', code: 'A', streamCode: 'S' }] }]), 400, 'sections.0.streamCode');
    await expectRejected('mixed streamed and non-streamed sections in one grade', yb([{ name: 'G', displayOrder: 20, streams: [{ name: 'S', code: 'S' }], sections: [{ name: 'a', code: 'A', streamCode: 'S' }, { name: 'b', code: 'B' }] }]), 400, 'sections.1.streamCode');
    await expectRejected('streams declared next to non-streamed sections', yb([{ name: 'G', displayOrder: 20, streams: [{ name: 'S', code: 'S' }], sections: [{ name: 'a', code: 'A' }] }]), 400, 'streams');
    await expectRejected('duplicate section code in the same (grade, stream)', yb([{ name: 'G', displayOrder: 20, sections: [{ name: 'a', code: 'A' }, { name: 'a2', code: 'A' }] }]), 400, 'sections.1.code');
    await expectRejected('blank grade name / invalid displayOrder (single-record rules reused)', yb([{ name: '  ', displayOrder: 0 }]), 400, 'grades.0');
    await expectRejected('21 grades (cap 20)', yb(Array.from({ length: 21 }, (_, i) => ({ name: `Cap${i}`, displayOrder: 100 + i }))), 400);
    await expectRejected('11 streams in one grade (cap 10)', yb([{ name: 'G', displayOrder: 20, streams: Array.from({ length: 11 }, (_, i) => ({ name: `S${i}`, code: `S${i}` })) }]), 400);
    await expectRejected('31 sections in one grade (cap 30)', yb([{ name: 'G', displayOrder: 20, sections: Array.from({ length: 31 }, (_, i) => ({ name: `s${i}`, code: `C${i}` })) }]), 400);
    await expectRejected('201 sections in total (cap 200)', yb(Array.from({ length: 7 }, (_, g) => ({ name: `T${g}`, displayOrder: 200 + g, sections: Array.from({ length: g === 6 ? 21 : 30 }, (_, i) => ({ name: `s${i}`, code: `C${i}` })) }))), 400, 'grades');
    await expectRejected('empty grades list', yb([]), 400);
    await expectRejected('invalid academicYearId format', { academicYearId: 'nope', grades: [{ name: 'G', displayOrder: 20 }] }, 400);

    const max = await post({ academicYearId: await mkYear(worldA, 'BULK-MAX'), grades: Array.from({ length: 20 }, (_, g) => ({ name: `M${g}`, displayOrder: g + 1, ...(g < 6 ? { streams: Array.from({ length: 10 }, (_, i) => ({ name: `S${i}`, code: `S${i}` })), sections: Array.from({ length: 30 }, (_, i) => ({ name: `s${i}`, code: `C${i}`, streamCode: `S${i % 10}` })) } : {}) })) });
    check('a request at the limits (20 grades, 10 streams, 30 sections, 180 sections total) → 201', max.status === 201, JSON.stringify(max.body).slice(0, 300));

    // authorization, isolation, lifecycle
    const yearActive = await mkYear(worldA, 'BULK-ACTIVE', 'ACTIVE');
    const rActive = await post({ academicYearId: yearActive, grades: [{ name: 'G', displayOrder: 1 }] });
    check('non-DRAFT academic year → 400 and nothing created', rActive.status === 400 && /DRAFT/.test(rActive.body.message) && (await prisma.grade.count({ where: { academicYearId: yearActive } })) === 0, JSON.stringify(rActive.body));
    const rForeign = await post({ academicYearId: yearA, grades: [{ name: 'Foreign', displayOrder: 50 }] }, tokB);
    check('another school\'s academic year → 403, nothing created', rForeign.status === 403 && same(await counts(yearA), base), JSON.stringify(rForeign.body));
    const rMissing = await post({ academicYearId: '00000000-0000-4000-8000-000000000000', grades: [{ name: 'G', displayOrder: 1 }] });
    check('unknown academic year → 404', rMissing.status === 404);
    check('unauthenticated → 401', (await call('POST', '/api/grades/bulk', null, structure)).status === 401);
    const yearB = await mkYear(worldB, 'BULK-B');
    const rB = await post({ academicYearId: yearB, grades: [{ name: 'Grade 6', displayOrder: 1 }] }, tokB);
    check('school isolation: the same grade name/order in another school\'s year is fine (201)', rB.status === 201);

    // concurrency + rollback: identical structures in parallel; the loser must leave NOTHING behind
    const yearC = await mkYear(worldA, 'BULK-RACE');
    const raceBody = { academicYearId: yearC, grades: [{ name: 'R', displayOrder: 1, streams: [{ name: 'S1', code: 'S1' }, { name: 'S2', code: 'S2' }], sections: [{ name: 'a', code: 'A', streamCode: 'S1' }, { name: 'b', code: 'B', streamCode: 'S2' }] }, { name: 'R2', displayOrder: 2, sections: [{ name: 'a', code: 'A' }] }] };
    const gr = await Promise.all([1, 2, 3, 4, 5].map(() => post(raceBody)));
    check('5 concurrent identical structure requests: exactly one 201, the rest 409', gr.filter((r) => r.status === 201).length === 1 && gr.filter((r) => r.status === 409).length === 4, gr.map((r) => r.status).join());
    check('  rollback: exactly one structure exists (2 grades, 2 streams, 3 sections), no orphans from the losers', same(await counts(yearC), { grades: 2, streams: 2, sections: 3 }), JSON.stringify(await counts(yearC)));
    const orphans = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "sections" s LEFT JOIN "grades" g ON g."id" = s."gradeId" WHERE g."id" IS NULL`;
    check('  no section without a grade anywhere', orphans[0]!.n === 0);
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
