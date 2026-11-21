// Deterministic dashboard dataset for the disposable database  timetable_dashboard_e2e_test.
//
//   e2e/dashboard/e2e.sh seed        (never run this file directly: the script passes the explicit environment)
//
// Everything is created through the REAL backend: the Fastify app is built in-process and driven with app.inject (the same handlers,
// validation, services, locks and transactions the HTTP server uses). Timetables come from the real generation pipeline and the real
// OR-Tools solver (seed + "reproducible" option), and are published with the real publish endpoint, so cover requests, automatic
// allocation, held-for-review and obsolescence all happen exactly as in production.
//
// The ONLY direct SQL writes are listed at the end of this file (timestamp back-dating of the HISTORICAL records, so the events feed has
// history older than "now"). They change timestamps only, never status, ownership or any relationship.
//
// Safety: guard first (loopback host + exact database name), identity proof from the server itself, refuses a non-empty database.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDisposableIdentity, assertDisposableUrl, assertTestPort, E2E_DB_NAME } from './lib/guard.js';

const target = assertDisposableUrl(process.env.DATABASE_URL);
assertTestPort(Number(process.env.PORT ?? 0));
if (process.env.NODE_ENV === 'production') throw new Error('E2E GUARD: NODE_ENV=production is not allowed here.');

const here = dirname(fileURLToPath(import.meta.url));
const RUN_DIR = join(here, '.run');
const pgModule = (await import('pg')).default;
const probe = new pgModule.Client({ connectionString: process.env.DATABASE_URL });
await probe.connect();
try {
  await assertDisposableIdentity(probe);
  const used = await probe.query(`SELECT (SELECT count(*) FROM schools)::int AS schools`);
  if ((used.rows[0] as { schools: number }).schools !== 0) throw new Error('The e2e database already contains data. Run: e2e.sh reset --yes --seed');
} finally {
  await probe.end();
}
console.log(`seed: target verified (database=${E2E_DB_NAME} host=${target.host}:${target.port})`);

// Imports that open the connection pool come only AFTER the guard has passed.
const { buildApp } = await import('../../src/app.js');
const { default: prisma } = await import('../../src/config/database.js');
const { createGenerationRunnerFromEnv } = await import('../../src/modules/timetable-generation/timetable-generation.runner.js');
const { registerGenerationRunner } = await import('../../src/modules/timetable-generation/timetable-generation.runner-handle.js');

// ---------------------------------------------------------------------------------------------------------------------------------
// Constants of the dataset
// ---------------------------------------------------------------------------------------------------------------------------------
const SCHOOL = { name: 'Greenfield Public School (E2E)', code: 'E2E_DASHBOARD', schoolType: 'SECONDARY' as const };
const ADMIN = { name: 'E2E Admin', email: 'admin@e2e.local', password: 'E2eAdmin#2026-Dashboard' };

const SUBJECTS: Array<[code: string, name: string]> = [
  ['ENG', 'English'], ['HIN', 'Hindi'], ['SAN', 'Sanskrit'], ['MATH', 'Mathematics'], ['SCI', 'Science'], ['SST', 'Social Science'],
  ['CS', 'Computer Science'], ['PE', 'Physical Education'], ['ART', 'Art'], ['PHY', 'Physics'], ['CHEM', 'Chemistry'], ['BIO', 'Biology'],
  ['ACC', 'Accountancy'], ['BST', 'Business Studies'], ['ECO', 'Economics'],
];

type Scope = 'ALL' | Array<'G8' | 'G11'>;
interface TeacherDef { key: string; name: string; code: string; subjects: Array<[subject: string, type: 'PRIMARY' | 'SECONDARY', scope: Scope]>; inactive?: boolean }
// Different subjects, grade eligibility (ALL_GRADES vs explicit grade rows) and workloads. SAN (Vikram) and ART (Lata/Meera) are thin on purpose.
const TEACHERS: TeacherDef[] = [
  { key: 'anita', name: 'Anita Sharma', code: 'T001', subjects: [['ENG', 'PRIMARY', 'ALL']] },
  { key: 'rohit', name: 'Rohit Verma', code: 'T002', subjects: [['ENG', 'PRIMARY', ['G11']], ['HIN', 'SECONDARY', ['G8']]] },
  { key: 'sunita', name: 'Sunita Rao', code: 'T003', subjects: [['HIN', 'PRIMARY', ['G8']]] },
  { key: 'manoj', name: 'Manoj Tiwari', code: 'T004', subjects: [['HIN', 'PRIMARY', 'ALL']] },
  { key: 'vikram', name: 'Vikram Joshi', code: 'T005', subjects: [['SAN', 'PRIMARY', ['G8']]] },
  { key: 'priya', name: 'Priya Nair', code: 'T006', subjects: [['MATH', 'PRIMARY', 'ALL'], ['CS', 'SECONDARY', ['G11']]] },
  { key: 'arjun', name: 'Arjun Mehta', code: 'T007', subjects: [['MATH', 'PRIMARY', ['G11']]] },
  { key: 'kavita', name: 'Kavita Singh', code: 'T008', subjects: [['MATH', 'PRIMARY', ['G8', 'G11']], ['SCI', 'SECONDARY', ['G8']]] },
  { key: 'deepak', name: 'Deepak Kulkarni', code: 'T009', subjects: [['SCI', 'PRIMARY', ['G8']], ['BIO', 'SECONDARY', ['G11']]] },
  { key: 'neha', name: 'Neha Gupta', code: 'T010', subjects: [['SST', 'PRIMARY', ['G8']], ['ECO', 'SECONDARY', ['G11']]] },
  { key: 'imran', name: 'Imran Khan', code: 'T011', subjects: [['SST', 'PRIMARY', ['G8']]] },
  { key: 'rahul', name: 'Rahul Desai', code: 'T012', subjects: [['CS', 'PRIMARY', 'ALL'], ['MATH', 'SECONDARY', ['G8']]] },
  { key: 'sneha', name: 'Sneha Iyer', code: 'T013', subjects: [['CS', 'PRIMARY', ['G8', 'G11']]] },
  { key: 'karan', name: 'Karan Malhotra', code: 'T014', subjects: [['PE', 'PRIMARY', 'ALL']] },
  { key: 'meera', name: 'Meera Pillai', code: 'T015', subjects: [['PE', 'PRIMARY', 'ALL'], ['ART', 'SECONDARY', ['G8']]] },
  { key: 'lata', name: 'Lata Bhatt', code: 'T016', subjects: [['ART', 'PRIMARY', ['G8']]] },
  { key: 'suresh', name: 'Suresh Reddy', code: 'T017', subjects: [['PHY', 'PRIMARY', ['G11']]] },
  { key: 'anil', name: 'Anil Kapoor', code: 'T018', subjects: [['PHY', 'PRIMARY', ['G11']], ['SCI', 'SECONDARY', ['G8']]] },
  { key: 'pooja', name: 'Pooja Menon', code: 'T019', subjects: [['CHEM', 'PRIMARY', ['G11']]] },
  { key: 'farhan', name: 'Farhan Ali', code: 'T020', subjects: [['CHEM', 'PRIMARY', ['G11']], ['PHY', 'SECONDARY', ['G11']]] },
  { key: 'divya', name: 'Divya Krishnan', code: 'T021', subjects: [['BIO', 'PRIMARY', ['G11']]] },
  { key: 'harish', name: 'Harish Patel', code: 'T022', subjects: [['ACC', 'PRIMARY', ['G11']]] },
  { key: 'rekha', name: 'Rekha Joshi', code: 'T023', subjects: [['ACC', 'PRIMARY', ['G11']], ['BST', 'SECONDARY', ['G11']]] },
  { key: 'sanjay', name: 'Sanjay Bose', code: 'T024', subjects: [['BST', 'PRIMARY', ['G11']]] },
  { key: 'tara', name: 'Tara Chatterjee', code: 'T025', subjects: [['ECO', 'PRIMARY', ['G11']]] },
  { key: 'nitin', name: 'Nitin Agarwal', code: 'T026', subjects: [['ECO', 'PRIMARY', ['G11']], ['SST', 'SECONDARY', ['G8']]] },
  { key: 'ishita', name: 'Ishita Banerjee', code: 'T027', subjects: [['ENG', 'PRIMARY', ['G8']]] },
  { key: 'ramesh', name: 'Ramesh Yadav', code: 'T028', subjects: [['MATH', 'PRIMARY', ['G8']]], inactive: true },
  { key: 'aditi', name: 'Aditi Saxena', code: 'T029', subjects: [] },
];

// Sections: A and B everywhere. Class 11 has the two streams COM and SCI; its sections carry the stream.
type SectionKey = 'G8-A' | 'G8-B' | '11C-A' | '11C-B' | '11S-A' | '11S-B';
const SECTION_KEYS: SectionKey[] = ['G8-A', 'G8-B', '11C-A', '11C-B', '11S-A', '11S-B'];
type CurriculumKey = 'G8' | '11C' | '11S';
const CURRICULUM: Record<CurriculumKey, Array<[subject: string, periods: number, optional?: boolean]>> = {
  G8: [['ENG', 5], ['HIN', 4], ['SAN', 3], ['MATH', 6], ['SCI', 5], ['SST', 5], ['CS', 2], ['PE', 2], ['ART', 1]],
  '11C': [['ENG', 5], ['ACC', 6], ['BST', 5], ['ECO', 5], ['MATH', 5, true], ['CS', 3, true], ['PE', 2]],
  '11S': [['ENG', 5], ['PHY', 6], ['CHEM', 6], ['BIO', 5], ['MATH', 6], ['CS', 2, true], ['PE', 2]],
};
// Explicit teacher per (section, subject). Some are left out per year on purpose (see MISSING_CURRENT and the future year).
const ASSIGN: Record<string, Record<string, string>> = {
  'G8-A': { ENG: 'ishita', HIN: 'sunita', SAN: 'vikram', MATH: 'kavita', SCI: 'deepak', SST: 'neha', CS: 'rahul', PE: 'karan', ART: 'lata' },
  'G8-B': { ENG: 'anita', HIN: 'manoj', SAN: 'vikram', MATH: 'priya', SCI: 'deepak', SST: 'imran', CS: 'sneha', PE: 'meera', ART: 'lata' },
  '11C-A': { ENG: 'rohit', ACC: 'harish', BST: 'sanjay', ECO: 'tara', MATH: 'arjun', CS: 'sneha', PE: 'karan' },
  '11C-B': { ENG: 'rohit', ACC: 'rekha', BST: 'sanjay', ECO: 'nitin', MATH: 'arjun', CS: 'rahul', PE: 'karan' },
  '11S-A': { ENG: 'anita', PHY: 'suresh', CHEM: 'pooja', BIO: 'divya', MATH: 'priya', CS: 'priya', PE: 'meera' },
  '11S-B': { ENG: 'anita', PHY: 'anil', CHEM: 'farhan', BIO: 'divya', MATH: 'arjun', CS: 'rahul', PE: 'meera' },
};
/** Missing in the CURRENT year (the generator allocates an eligible teacher for them). */
const MISSING_CURRENT = new Set(['11C-B:ECO', 'G8-B:ART', '11S-B:CS']);

// The simplified schedule: working days + teaching periods per day + exactly ONE break (after period 4). No clock times.
const PERIODS_PER_DAY = 7;
const BREAK_AFTER_PERIOD = 4;
const WORKING_DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];

// ---------------------------------------------------------------------------------------------------------------------------------
// Dates (UTC, the same clock the backend uses for "today")
// ---------------------------------------------------------------------------------------------------------------------------------
const anchor = process.env.E2E_ANCHOR_DATE?.trim() || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new Error('E2E_ANCHOR_DATE must be YYYY-MM-DD');
const parse = (s: string): Date => new Date(`${s}T00:00:00Z`);
const fmt = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number): string => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
const isWorking = (s: string): boolean => { const k = parse(s).getUTCDay(); return k >= 1 && k <= 5; };
const DOW = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const dayName = (s: string): string => DOW[parse(s).getUTCDay()]!;
let ref = anchor;
while (!isWorking(ref)) ref = addDays(ref, 1);
/** k-th working day relative to the reference working day (wd(0) = today, or the next Monday when today is a weekend). */
const wd = (k: number): string => { let d = ref; let left = Math.abs(k); const step = k < 0 ? -1 : 1; while (left > 0) { d = addDays(d, step); if (isWorking(d)) left--; } return d; };
const startYear = Number(anchor.slice(0, 4)) - (Number(anchor.slice(5, 7)) >= 4 ? 0 : 1);
const yearDef = (offset: -1 | 0 | 1) => { const s = startYear + offset; return { name: `${s}-${String(s + 1).slice(2)}`, startDate: `${s}-04-01`, endDate: `${s + 1}-03-31` }; };

// ---------------------------------------------------------------------------------------------------------------------------------
// HTTP helper (in-process)
// ---------------------------------------------------------------------------------------------------------------------------------
const app = await buildApp({ env: process.env });
await app.ready();
let cookieHeader: string | null = null;
interface Reply { status: number; body: any }
async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await app.inject({ method, url, headers: { ...(cookieHeader ? { cookie: cookieHeader } : {}), ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  let body: any = {};
  try { body = JSON.parse(res.body); } catch { /* not JSON */ }
  return { status: res.statusCode, body };
}
async function must(expected: number | number[], method: Parameters<typeof call>[0], url: string, payload?: unknown, headers: Record<string, string> = {}): Promise<any> {
  const r = await call(method, url, payload, headers);
  const ok = Array.isArray(expected) ? expected.includes(r.status) : r.status === expected;
  if (!ok) throw new Error(`${method} ${url} -> ${r.status} (expected ${expected}): ${JSON.stringify(r.body).slice(0, 700)}`);
  return r.body;
}
const log = (m: string): void => console.log(`seed: ${m}`);

// ---------------------------------------------------------------------------------------------------------------------------------
// Generation runner (real solver, in this process)
// ---------------------------------------------------------------------------------------------------------------------------------
const quiet = { info: () => undefined, warn: (_f: unknown, m: string) => console.log(`seed: runner warning: ${m}`), error: (_f: unknown, m: string) => console.log(`seed: runner error: ${m}`) };
const runner = createGenerationRunnerFromEnv(prisma, process.env, quiet);
if (!runner) throw new Error('The generation runner is disabled');
registerGenerationRunner(runner);
runner.start();

async function generate(yearId: string, seed: number): Promise<string> {
  const accepted = await must(202, 'POST', '/api/timetable-generations', { academicYearId: yearId, options: { seed, reproducible: true } });
  const runId: string = accepted.data.generationRunId;
  const deadline = Date.now() + 8 * 60_000;
  for (;;) {
    const r = await must(200, 'GET', `/api/timetable-generations/${runId}`);
    const status = r.data.status as string;
    if (status === 'SUCCEEDED') return r.data.versionId as string;
    if (status === 'FAILED') throw new Error(`generation failed: ${JSON.stringify(r.data.failure ?? r.data).slice(0, 600)}`);
    if (Date.now() > deadline) throw new Error('generation did not finish in 8 minutes');
    await new Promise((res) => setTimeout(res, 1500));
  }
}
async function publish(versionId: string, expectedPublishedVersionId: string | null): Promise<any> {
  const v = await must(200, 'GET', `/api/timetable-versions/${versionId}`);
  return must(200, 'POST', `/api/timetable-versions/${versionId}/publish`, { expectedRevision: v.data.revision ?? 1, expectedPublishedVersionId });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. School, first admin, session (real bootstrap flow)
// ---------------------------------------------------------------------------------------------------------------------------------
const school = await must(201, 'POST', '/api/schools', SCHOOL);
const schoolId: string = school.data.id;
await must(201, 'POST', '/api/admin/register', { schoolId, setupToken: school.data.setupToken, name: ADMIN.name, email: ADMIN.email, password: ADMIN.password });
{
  const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { schoolId, email: ADMIN.email, password: ADMIN.password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode}`);
  const c = res.cookies[0];
  if (!c) throw new Error('login returned no session cookie');
  cookieHeader = `${c.name}=${c.value}`;
}
log(`school ${SCHOOL.code} + admin ${ADMIN.email} created, session established`);

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. Subjects, teachers, teacher-subject links
// ---------------------------------------------------------------------------------------------------------------------------------
const subjBody = await must(201, 'POST', '/api/subjects/bulk', { subjects: SUBJECTS.map(([code, name]) => ({ code, name })) });
const subjectList: any[] = Array.isArray(subjBody.data) ? subjBody.data : subjBody.data.subjects;
const subjectId: Record<string, string> = Object.fromEntries(subjectList.map((s) => [s.code, s.id]));
if (Object.keys(subjectId).length !== 15) throw new Error(`expected 15 subjects, got ${Object.keys(subjectId).length}`);

const teacherBody = await must(201, 'POST', '/api/teachers/bulk', { teachers: TEACHERS.map((t) => ({ name: t.name, employeeCode: t.code })) }, { 'idempotency-key': 'e2e-dashboard-teachers-0001' });
const teacherList: any[] = Array.isArray(teacherBody.data) ? teacherBody.data : teacherBody.data.teachers;
const teacherId: Record<string, string> = Object.fromEntries(TEACHERS.map((t) => [t.key, teacherList.find((x) => x.employeeCode === t.code).id as string]));
const teacherName: Record<string, string> = Object.fromEntries(TEACHERS.map((t) => [teacherId[t.key]!, t.name]));
const keyOfTeacher: Record<string, string> = Object.fromEntries(TEACHERS.map((t) => [teacherId[t.key]!, t.key]));

const linkId: Record<string, string> = {}; // `${teacherKey}:${subject}` -> teacher_subject id
for (const t of TEACHERS) {
  for (const [subject, type, scope] of t.subjects) {
    const r = await must(201, 'POST', `/api/teachers/${teacherId[t.key]}/subjects`, { subjectId: subjectId[subject], type, ...(scope === 'ALL' ? { gradeScope: 'ALL_GRADES' } : {}) });
    linkId[`${t.key}:${subject}`] = r.data.id;
  }
}
// Deactivated only after its subject links exist (the API refuses to add subjects to an inactive teacher).
for (const t of TEACHERS.filter((x) => x.inactive)) await must(200, 'PATCH', `/api/teachers/${teacherId[t.key]}`, { isActive: false });
log(`${SUBJECTS.length} subjects, ${TEACHERS.length} teachers (1 inactive, 1 without subjects), ${Object.keys(linkId).length} subject links`);

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. One academic year: grades, streams, sections, curriculum, eligibility, schedule, assignments
// ---------------------------------------------------------------------------------------------------------------------------------
interface YearCtx {
  id: string; name: string; gradeIds: { G8: string; G11: string }; streamIds: { COM: string; SCI: string };
  sectionIds: Record<SectionKey, string>; requirementIds: Record<string, string>; // `${CurriculumKey}:${subject}`
  scheduleConfigId: string | null; assignmentIds: Record<string, string>;
}
const SECTION_CURRICULUM: Record<SectionKey, CurriculumKey> = { 'G8-A': 'G8', 'G8-B': 'G8', '11C-A': '11C', '11C-B': '11C', '11S-A': '11S', '11S-B': '11S' };

async function buildYear(offset: -1 | 0 | 1, o: { schedule: boolean; assignments: (section: SectionKey, subject: string) => boolean }): Promise<YearCtx> {
  const def = yearDef(offset);
  const year = await must(201, 'POST', '/api/academic-years', def);
  const yearId: string = year.data.id;
  const structure = await must(201, 'POST', '/api/grades/bulk', {
    academicYearId: yearId,
    grades: [
      { name: 'Grade 8', displayOrder: 8, sections: [{ name: 'Section A', code: 'A' }, { name: 'Section B', code: 'B' }] },
      {
        name: 'Class 11', displayOrder: 11,
        streams: [{ name: 'Commerce', code: 'COM' }, { name: 'Science', code: 'SCI' }],
        sections: [
          { name: 'Commerce A', code: 'A', streamCode: 'COM' }, { name: 'Commerce B', code: 'B', streamCode: 'COM' },
          { name: 'Science A', code: 'A', streamCode: 'SCI' }, { name: 'Science B', code: 'B', streamCode: 'SCI' },
        ],
      },
    ],
  });
  const grades: any[] = structure.data.grades;
  const g8 = grades.find((g) => g.name === 'Grade 8');
  const g11 = grades.find((g) => g.name === 'Class 11');
  const com = g11.streams.find((s: any) => s.code === 'COM');
  const sci = g11.streams.find((s: any) => s.code === 'SCI');
  const sec = (grade: any, name: string): string => grade.sections.find((s: any) => s.name === name).id;
  const sectionIds: Record<SectionKey, string> = { 'G8-A': sec(g8, 'Section A'), 'G8-B': sec(g8, 'Section B'), '11C-A': sec(g11, 'Commerce A'), '11C-B': sec(g11, 'Commerce B'), '11S-A': sec(g11, 'Science A'), '11S-B': sec(g11, 'Science B') };

  // Curriculum (real PUT /curriculum/grades/:gradeId, one call per grade / stream)
  const put = (gradeId: string, streamId: string | null, key: CurriculumKey) =>
    must(200, 'PUT', `/api/curriculum/grades/${gradeId}`, { ...(streamId ? { streamId } : {}), requirements: CURRICULUM[key].map(([s, p, opt]) => ({ subjectId: subjectId[s], periodsPerWeek: p, ...(opt ? { isOptional: true } : {}) })) });
  await put(g8.id, null, 'G8'); await put(g11.id, com.id, '11C'); await put(g11.id, sci.id, '11S');
  const reqs = await prisma.subjectRequirement.findMany({ where: { grade: { academicYearId: yearId } }, select: { id: true, gradeId: true, streamId: true, subject: { select: { code: true } } } });
  const requirementIds: Record<string, string> = {};
  for (const r of reqs) { const k: CurriculumKey = r.gradeId === g8.id ? 'G8' : r.streamId === com.id ? '11C' : '11S'; requirementIds[`${k}:${r.subject.code}`] = r.id; }

  // Eligibility rows for the teachers with explicit grade lists (ALL_GRADES teachers need none)
  for (const t of TEACHERS) for (const [subject, , scope] of t.subjects) {
    if (scope === 'ALL') continue;
    for (const g of scope) await must(201, 'POST', `/api/teacher-subjects/${linkId[`${t.key}:${subject}`]}/grades`, { gradeId: g === 'G8' ? g8.id : g11.id });
  }

  let scheduleConfigId: string | null = null;
  if (o.schedule) {
    const cfg = await must(201, 'POST', '/api/schedule-configs', { academicYearId: yearId, workingDays: WORKING_DAYS, periodsPerDay: PERIODS_PER_DAY, breakAfterPeriod: BREAK_AFTER_PERIOD });
    scheduleConfigId = cfg.data.id;
  }

  const assignmentIds: Record<string, string> = {};
  for (const section of SECTION_KEYS) {
    const cur = SECTION_CURRICULUM[section];
    for (const [subject] of CURRICULUM[cur]) {
      if (!o.assignments(section, subject)) continue;
      const teacher = ASSIGN[section]![subject]!;
      const r = await must(201, 'POST', '/api/section-subject-teachers', { sectionId: sectionIds[section], subjectRequirementId: requirementIds[`${cur}:${subject}`], teacherId: teacherId[teacher] });
      assignmentIds[`${section}:${subject}`] = r.data.id;
    }
  }
  log(`year ${def.name}: grades, 2 streams, 6 sections, curriculum (${reqs.length} requirements), ${Object.keys(assignmentIds).length} explicit assignments${o.schedule ? ', schedule' : ', NO schedule yet'}`);
  return { id: yearId, name: def.name, gradeIds: { G8: g8.id, G11: g11.id }, streamIds: { COM: com.id, SCI: sci.id }, sectionIds, requirementIds, scheduleConfigId, assignmentIds };
}

const feasibility = async (yearId: string) => (await must(200, 'GET', `/api/timetable-feasibility?academicYearId=${yearId}`)).data;
const manifestVersions: Record<string, any> = {};

// ---- previous year: complete, one published timetable, COMPLETED --------------------------------------------------------------------
const prev = await buildYear(-1, { schedule: true, assignments: () => true });
{
  const f = await feasibility(prev.id);
  if (f.status !== 'READY') throw new Error(`previous year not READY: ${JSON.stringify(f.errors).slice(0, 400)}`);
  const v = await generate(prev.id, 101);
  await publish(v, null);
  manifestVersions.previousPublished = v;
  await must(200, 'PATCH', `/api/academic-years/${prev.id}`, { status: 'ACTIVE' });
  await must(200, 'PATCH', `/api/academic-years/${prev.id}`, { status: 'COMPLETED' });
  log(`year ${prev.name}: timetable generated + published, year COMPLETED`);
}

// ---- future year: being prepared (no schedule yet, Class 11 not assigned) -> NOT_READY, DRAFT --------------------------------------------
const future = await buildYear(1, { schedule: false, assignments: (s) => s.startsWith('G8') });
{
  const f = await feasibility(future.id);
  log(`year ${future.name}: readiness ${f.status} (${(f.errors ?? []).length} errors, ${(f.warnings ?? []).length} warnings)`);
}

// ---- current year ---------------------------------------------------------------------------------------------------------------------------
const cur = await buildYear(0, { schedule: true, assignments: (s, subj) => !MISSING_CURRENT.has(`${s}:${subj}`) });
{
  const f = await feasibility(cur.id);
  if (f.status !== 'READY') throw new Error(`current year not READY: ${JSON.stringify(f.errors).slice(0, 600)}`);
}
const v1 = await generate(cur.id, 11);
await publish(v1, null);
log(`year ${cur.name}: version 1 generated + published`);

// Unavailability FIRST, so the allocator respects it for everything that follows.
const U = {
  rahulDay: wd(1), karanP6: wd(2), nehaP2: wd(3), nitinCancelled: wd(4),
};
const unavail: Record<string, any> = {};
unavail.rahulFullDay = (await must(201, 'POST', '/api/teacher-unavailability', { teacherId: teacherId.rahul, date: U.rahulDay, reason: 'Off-site workshop' })).data;
unavail.karanPeriod6 = (await must(201, 'POST', '/api/teacher-unavailability', { teacherId: teacherId.karan, date: U.karanP6, periodNumber: 6, reason: 'Inter-school sports meet' })).data;
unavail.nehaPeriod2 = (await must(201, 'POST', '/api/teacher-unavailability', { teacherId: teacherId.neha, date: U.nehaP2, periodNumber: 2, reason: 'Parent meeting' })).data;
{
  const gone = (await must(201, 'POST', '/api/teacher-unavailability', { teacherId: teacherId.nitin, date: U.nitinCancelled, reason: 'Exam duty (withdrawn)' })).data;
  await must(200, 'DELETE', `/api/teacher-unavailability/${gone.id}`);
  unavail.nitinCancelled = gone;
}

// P1: an absence recorded on version 1; publishing version 2 will make its requests OBSOLETE and hold the admin-confirmed one for review.
const p1Date = wd(7);
const p1 = await must(201, 'POST', '/api/teacher-absences', { teacherId: teacherId.ishita, startDate: p1Date, endDate: p1Date, reason: 'Conference (recorded before the timetable was republished)' });
{
  const covers = await prisma.coverRequest.findMany({ where: { absenceId: p1.data.absence.id, status: 'ASSIGNED' }, orderBy: [{ periodNumber: 'asc' }] });
  if (covers.length === 0) throw new Error('P1 produced no assigned cover');
  await must(200, 'PUT', `/api/substitutions/${covers[0]!.id}/assignment`, { teacherId: covers[0]!.replacementTeacherId }); // the admin confirms one automatic choice -> MANUAL
}
const v2 = await generate(cur.id, 22);
const pub2 = await publish(v2, v1);
log(`year ${cur.name}: version 2 published (v1 archived); republish -> ${JSON.stringify(pub2.data.substitution?.run ?? pub2.data.substitution).slice(0, 160)}`);
const v3 = await generate(cur.id, 33); // stays a DRAFT
await must(200, 'PATCH', `/api/academic-years/${cur.id}`, { status: 'ACTIVE' });
log(`year ${cur.name}: version 3 left as DRAFT, year ACTIVE`);

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. Substitution scenarios on the published version 2
// ---------------------------------------------------------------------------------------------------------------------------------
const entries = await prisma.timetableEntry.findMany({ where: { versionId: v2 }, select: { teacherId: true, dayOfWeek: true, periodNumber: true, sectionId: true, subjectId: true } });
const lessonsOf = (teacher: string, date: string) => entries.filter((e) => e.teacherId === teacherId[teacher] && e.dayOfWeek === dayName(date)).sort((a, b) => a.periodNumber - b.periodNumber);
const absences: Record<string, any> = {};
const createAbsence = async (key: string, teacher: string, date: string, extra: Record<string, unknown> = {}, endDate = date) => {
  const r = await must(201, 'POST', '/api/teacher-absences', { teacherId: teacherId[teacher], startDate: date, endDate, ...extra });
  absences[key] = { id: r.data.absence.id, teacher, date, endDate, allocation: r.data.automaticAllocation, coverRequestsCreated: r.data.coverRequestsCreated };
  return r.data;
};
const coversOf = (absenceId: string) => prisma.coverRequest.findMany({ where: { absenceId }, orderBy: [{ date: 'asc' }, { periodNumber: 'asc' }, { id: 'asc' }] });
const firstOffered = async (coverId: string, avoid: string | null = null) => {
  const r = await must(200, 'GET', `/api/substitutions/${coverId}/candidates`);
  return (r.data.candidates as any[]).find((c) => c.offered !== false && c.tier !== 3 && c.id !== avoid);
};

// S1: automatic assignment, qualified substitutes
await createAbsence('autoPhysics', 'anil', wd(1), { reason: 'Medical leave' });
await createAbsence('autoMaths', 'priya', wd(2), { reason: 'Family emergency' });
await createAbsence('autoEnglishPartial', 'rohit', wd(1), { scope: 'PERIODS', fromPeriod: 3, toPeriod: 5, reason: 'Training workshop' });
await createAbsence('autoToday', 'imran', wd(0), { reason: 'Sick leave' });
// S2: temporary unqualified cover (Vikram is the only Sanskrit teacher)
await createAbsence('temporarySanskrit', 'vikram', wd(3), { reason: 'Personal leave' });
// S2b: a multi-day absence (3 working days): lets the dashboard's date-range filters be checked on the middle day
await createAbsence('multiDay', 'sunita', wd(1), { reason: 'Bereavement leave' }, wd(3));
// S3: unfilled: every free teacher is marked unavailable for that period, then the absence has nobody to cover
{
  const date = wd(4);
  const pick = (['sneha', 'harish', 'tara', 'divya'] as const).map((k) => ({ k, lessons: lessonsOf(k, date) })).find((x) => x.lessons.length > 0);
  if (!pick) throw new Error('no teacher with a lesson on the unfilled-scenario day');
  const period = pick.lessons[0]!.periodNumber;
  const busy = new Set(entries.filter((e) => e.dayOfWeek === dayName(date) && e.periodNumber === period).map((e) => e.teacherId));
  const active = await prisma.teacher.findMany({ where: { schoolId, isActive: true }, select: { id: true } });
  const free = active.filter((t) => !busy.has(t.id));
  for (const t of free) await must(201, 'POST', '/api/teacher-unavailability', { teacherId: t.id, date, periodNumber: period, reason: 'Staff meeting' });
  await createAbsence('unfilled', pick.k, date, { scope: 'PERIODS', fromPeriod: period, toPeriod: period, reason: 'Hospital appointment' });
  absences.unfilled.note = `${free.length} free teachers marked unavailable at period ${period}`;
}
// S4: manual assignment: no automatic allocation, the admin assigns some and leaves some open
{
  const data = await createAbsence('manual', 'kavita', wd(5), { autoAssign: false, reason: 'Examination invigilation elsewhere' });
  const covers = await coversOf(data.absence.id);
  let assigned = 0;
  for (const c of covers) {
    if (assigned >= 3) break;
    const cand = await firstOffered(c.id);
    if (!cand) continue;
    await must(200, 'PUT', `/api/substitutions/${c.id}/assignment`, { teacherId: cand.id });
    assigned++;
  }
  // one lesson that needs no cover at all: a single request cancelled
  const open = (await coversOf(data.absence.id)).filter((c) => c.status === 'OPEN');
  if (open.length > 1) await must(200, 'POST', `/api/substitutions/${open[open.length - 1]!.id}/cancel`, { reason: 'Class combined with Section B for a seminar' });
}
// S5 / S6: a reassignment (REASSIGNED) and an unassignment (UNASSIGNED) of automatic choices
{
  const pool = [...(await coversOf(absences.autoPhysics.id)), ...(await coversOf(absences.autoToday.id))].filter((c) => c.status === 'ASSIGNED' && c.assignmentSource === 'AUTOMATIC');
  let reassigned = false;
  for (const c of pool) {
    const alt = await firstOffered(c.id, c.replacementTeacherId);
    if (!alt) continue;
    await must(200, 'PUT', `/api/substitutions/${c.id}/assignment`, { teacherId: alt.id });
    reassigned = true;
    break;
  }
  if (!reassigned) throw new Error('no automatic cover could be reassigned (no alternative candidate was offered)');
  const a2 = (await coversOf(absences.autoMaths.id)).filter((c) => c.status === 'ASSIGNED');
  if (a2[0]) await must(200, 'DELETE', `/api/substitutions/${a2[0].id}/assignment`);
}
// S7: a cancelled absence (its OPEN requests are cancelled with it)
{
  const data = await createAbsence('cancelled', 'deepak', wd(6), { autoAssign: false, reason: 'Leave withdrawn' });
  await must(200, 'POST', `/api/teacher-absences/${data.absence.id}/cancel`, { reason: 'Teacher is available after all' });
}
// S11: a substitute becomes unavailable AFTER being auto-assigned -> the allocator releases and re-allocates (AUTO_RELEASED)
{
  const target = (await coversOf(absences.autoEnglishPartial.id)).find((c) => c.status === 'ASSIGNED' && c.assignmentSource === 'AUTOMATIC');
  if (target?.replacementTeacherId) {
    await must(201, 'POST', '/api/teacher-unavailability', { teacherId: target.replacementTeacherId, date: fmt(target.date), periodNumber: target.periodNumber, reason: 'Called to the principal\'s office' });
    absences.autoEnglishPartial.releasedSubstitute = { teacher: teacherName[target.replacementTeacherId], period: target.periodNumber };
  }
}

// S8: historical records in the CURRENT year (past working days). Past dates are never allocated automatically, so the admin records them.
const historical: Array<{ key: string; absenceId: string; date: string }> = [];
{
  const h1 = await createAbsence('historyAssigned', 'anita', wd(-3), { reason: 'Medical leave (past)' });
  for (const c of await coversOf(h1.absence.id)) { const cand = await firstOffered(c.id); if (cand) await must(200, 'PUT', `/api/substitutions/${c.id}/assignment`, { teacherId: cand.id }); }
  historical.push({ key: 'historyAssigned', absenceId: h1.absence.id, date: wd(-3) });

  const lessons = lessonsOf('suresh', wd(-2));
  const from = lessons[0]?.periodNumber ?? 1;
  const h2 = await createAbsence('historyPartial', 'suresh', wd(-2), { scope: 'PERIODS', fromPeriod: from, toPeriod: Math.min(from + 2, PERIODS_PER_DAY), reason: 'Seminar (past)' });
  const h2covers = await coversOf(h2.absence.id);
  for (const c of h2covers.slice(0, Math.max(0, h2covers.length - 1))) { const cand = await firstOffered(c.id); if (cand) await must(200, 'PUT', `/api/substitutions/${c.id}/assignment`, { teacherId: cand.id }); }
  historical.push({ key: 'historyPartial', absenceId: h2.absence.id, date: wd(-2) });

  const h3 = await createAbsence('historyCancelled', 'harish', wd(-5), { autoAssign: false, reason: 'Leave (past, withdrawn)' });
  await must(200, 'POST', `/api/teacher-absences/${h3.absence.id}/cancel`, { reason: 'Withdrawn' });
  historical.push({ key: 'historyCancelled', absenceId: h3.absence.id, date: wd(-5) });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. Direct SQL (timestamps only): put the HISTORICAL records back on the day they are about
// ---------------------------------------------------------------------------------------------------------------------------------
for (const h of historical) {
  const day = h.date;
  await prisma.$executeRawUnsafe(`UPDATE "teacher_absences" SET "createdAt" = ($1::date + time '06:40'), "updatedAt" = ($1::date + time '06:40'), "cancelledAt" = CASE WHEN "cancelledAt" IS NULL THEN NULL ELSE ($1::date + time '07:30') END WHERE "id" = $2`, day, h.absenceId);
  await prisma.$executeRawUnsafe(`UPDATE "cover_requests" SET "createdAt" = ($1::date + time '06:40'), "updatedAt" = ($1::date + time '07:20'), "assignedAt" = CASE WHEN "assignedAt" IS NULL THEN NULL ELSE ($1::date + time '07:10') END, "cancelledAt" = CASE WHEN "cancelledAt" IS NULL THEN NULL ELSE ($1::date + time '07:30') END WHERE "absenceId" = $2`, day, h.absenceId);
  await prisma.$executeRawUnsafe(`UPDATE "cover_events" e SET "createdAt" = ($1::date + time '06:40') + (x.rn * interval '1 minute') FROM (SELECT ev."id", row_number() OVER (ORDER BY ev."createdAt", ev."id") AS rn FROM "cover_events" ev JOIN "cover_requests" c ON c."id" = ev."coverRequestId" WHERE c."absenceId" = $2) x WHERE e."id" = x."id"`, day, h.absenceId);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. Verify the dataset really contains every category that was asked for, then write the manifest
// ---------------------------------------------------------------------------------------------------------------------------------
const count = async (sql: string): Promise<number> => Number(((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(sql))[0]!).n);
const checks: Array<[string, number, boolean]> = []; // name, value, required
const add = (name: string, value: number, required = true): void => { checks.push([name, value, required]); };
add('academic years', await count(`SELECT count(*) AS n FROM "academic_years"`));
add('previous/current/future years (COMPLETED/ACTIVE/DRAFT)', await count(`SELECT count(DISTINCT "status") AS n FROM "academic_years"`));
add('grades x 3 years', await count(`SELECT count(*) AS n FROM "grades"`));
add('sections', await count(`SELECT count(*) AS n FROM "sections"`));
add('subjects', await count(`SELECT count(*) AS n FROM "subjects"`));
add('teachers', await count(`SELECT count(*) AS n FROM "teachers"`));
add('timetable versions PUBLISHED', await count(`SELECT count(*) AS n FROM "timetable_versions" WHERE "status" = 'PUBLISHED'`));
add('timetable versions DRAFT', await count(`SELECT count(*) AS n FROM "timetable_versions" WHERE "status" = 'DRAFT'`));
add('timetable versions ARCHIVED', await count(`SELECT count(*) AS n FROM "timetable_versions" WHERE "status" = 'ARCHIVED'`));
add('absences ACTIVE', await count(`SELECT count(*) AS n FROM "teacher_absences" WHERE "status" = 'ACTIVE'`));
add('absences CANCELLED', await count(`SELECT count(*) AS n FROM "teacher_absences" WHERE "status" = 'CANCELLED'`));
add('unavailability ACTIVE', await count(`SELECT count(*) AS n FROM "teacher_unavailabilities" WHERE "status" = 'ACTIVE'`));
add('unavailability CANCELLED', await count(`SELECT count(*) AS n FROM "teacher_unavailabilities" WHERE "status" = 'CANCELLED'`));
add('covers ASSIGNED automatic', await count(`SELECT count(*) AS n FROM "cover_requests" WHERE "status" = 'ASSIGNED' AND "assignmentSource" = 'AUTOMATIC'`));
add('covers ASSIGNED manual', await count(`SELECT count(*) AS n FROM "cover_requests" WHERE "status" = 'ASSIGNED' AND "assignmentSource" = 'MANUAL'`));
add('covers ASSIGNED temporary unqualified', await count(`SELECT count(*) AS n FROM "cover_requests" WHERE "status" = 'ASSIGNED' AND "temporaryUnqualified"`));
add('covers OPEN (all)', await count(`SELECT count(*) AS n FROM "cover_requests" WHERE "status" = 'OPEN'`));
add('covers OPEN on future dates with an allocator reason (unfilled)', await count(`SELECT count(*) AS n FROM "cover_requests" WHERE "status" = 'OPEN' AND "date" >= current_date AND "attentionCode" IS NOT NULL`));
add('covers OPEN held for review', await count(`SELECT count(*) AS n FROM "cover_requests" WHERE "status" = 'OPEN' AND "attentionCode" = 'MANUAL_ASSIGNMENT_NEEDS_REVIEW'`));
add('covers CANCELLED', await count(`SELECT count(*) AS n FROM "cover_requests" WHERE "status" = 'CANCELLED'`));
add('covers OBSOLETE', await count(`SELECT count(*) AS n FROM "cover_requests" WHERE "status" = 'OBSOLETE'`));
add('historical covers (date before today)', await count(`SELECT count(*) AS n FROM "cover_requests" WHERE "date" < current_date`));
for (const action of ['CREATED', 'ASSIGNED', 'REASSIGNED', 'UNASSIGNED', 'CANCELLED', 'OBSOLETED', 'AUTO_ASSIGNED', 'AUTO_UNFILLED']) add(`events ${action}`, await count(`SELECT count(*) AS n FROM "cover_events" WHERE "action" = '${action}'`));
add('events AUTO_RELEASED', await count(`SELECT count(*) AS n FROM "cover_events" WHERE "action" = 'AUTO_RELEASED'`), false);
add('events older than today (history)', await count(`SELECT count(*) AS n FROM "cover_events" WHERE "createdAt" < current_date`));
add('explicit section-subject-teacher assignments', await count(`SELECT count(*) AS n FROM "section_subject_teachers"`));
add('inactive teachers', await count(`SELECT count(*) AS n FROM "teachers" WHERE NOT "isActive"`));
add('teachers without any subject', await count(`SELECT count(*) AS n FROM "teachers" t WHERE NOT EXISTS (SELECT 1 FROM "teacher_subjects" ts WHERE ts."teacherId" = t."id")`));

let missing = 0;
for (const [name, value, required] of checks) {
  const bad = value === 0;
  if (bad && required) missing++;
  console.log(`seed:   ${bad ? (required ? 'MISSING' : 'none   ') : 'ok     '} ${name}: ${value}`);
}

const readiness = { previous: (await feasibility(prev.id)).status, current: (await feasibility(cur.id)).status, future: (await feasibility(future.id)).status };
const manifest = {
  generatedAt: new Date().toISOString(),
  database: { name: E2E_DB_NAME, host: target.host, port: target.port },
  backend: { baseUrl: 'http://127.0.0.1:4010', frontendProxyHint: 'point the frontend dev proxy for /api at http://127.0.0.1:4010' },
  login: { schoolId, email: ADMIN.email, password: ADMIN.password, request: { method: 'POST', path: '/api/admin/login', body: { schoolId, email: ADMIN.email, password: ADMIN.password } } },
  dates: { anchorUtc: anchor, referenceWorkingDay: ref, note: 'wd(0) is today when today is Mon-Fri, otherwise the next Monday. Re-seed (e2e.sh reset --yes --seed) to move the dataset to a new "today".', wd: Object.fromEntries([-5, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7].map((k) => [String(k), wd(k)])) },
  school: { id: schoolId, code: SCHOOL.code, name: SCHOOL.name, consecutivePeriodPolicy: (await must(200, 'GET', '/api/substitution-settings')).data },
  academicYears: { previous: { ...yearDef(-1), id: prev.id, status: 'COMPLETED', readiness: readiness.previous }, current: { ...yearDef(0), id: cur.id, status: 'ACTIVE', readiness: readiness.current }, future: { ...yearDef(1), id: future.id, status: 'DRAFT', readiness: readiness.future } },
  structure: Object.fromEntries([['previous', prev], ['current', cur], ['future', future]].map(([k, y]) => [k as string, { gradeIds: (y as YearCtx).gradeIds, streamIds: (y as YearCtx).streamIds, sectionIds: (y as YearCtx).sectionIds, scheduleConfigId: (y as YearCtx).scheduleConfigId }])),
  subjects: subjectId,
  teachers: Object.fromEntries(TEACHERS.map((t) => [t.key, { id: teacherId[t.key], name: t.name, employeeCode: t.code, inactive: t.inactive === true, subjects: t.subjects.map(([s, ty, sc]) => ({ code: s, type: ty, grades: sc === 'ALL' ? 'ALL_GRADES' : sc })) }])),
  timetableVersions: { previousPublished: manifestVersions.previousPublished, currentArchived: v1, currentPublished: v2, currentDraft: v3 },
  missingAssignmentsCurrentYear: [...MISSING_CURRENT],
  absences, unavailability: Object.fromEntries(Object.entries(unavail).map(([k, v]) => [k, v.id])), historicalAbsenceIds: historical,
  counts: Object.fromEntries(checks.map(([n, v]) => [n, v])),
};
mkdirSync(RUN_DIR, { recursive: true });
writeFileSync(join(RUN_DIR, 'seed-manifest.json'), JSON.stringify(manifest, null, 2));
log(`manifest written: e2e/dashboard/.run/seed-manifest.json`);

await runner.stop(20);
registerGenerationRunner(null);
await app.close();
await prisma.$disconnect();
// An explicit exit: the app's in-memory rate limiter keeps a 10-minute timer alive, which would otherwise hold the process open.
if (missing > 0) { console.error(`seed: ${missing} required category(ies) are missing`); process.exit(1); }
console.log('seed: done');
process.exit(0);
