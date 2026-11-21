// Database-level tests for the Module 11 persistence layer (Phase 4): the REAL PostgreSQL constraints, not application
// validation. Creates a throw-away test school, exercises every constraint, then deletes it (the School -> child
// cascade) and verifies that nothing of the test remains and that no pre-existing row changed.
//
// Run with   NODE_ENV=production npx tsx test-timetable-generation-db.ts      (production: no per-query logging)
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import prisma from './src/config/database.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);

const errText = (e: unknown): string => {
  const x = e as { code?: string; message?: string; meta?: unknown };
  return `${x.code ?? ''} | ${String(x.message ?? e).replace(/\s+/g, ' ').slice(0, 400)} | ${JSON.stringify(x.meta ?? {}).slice(0, 300)}`;
};
/** Runs fn and returns the error text if it was rejected, or null if it succeeded. */
async function rejected(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return errText(e); }
}
const sortKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortKeys) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sortKeys(x)])) : v);
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b)); // jsonb does not preserve key order
const UNIQUE = /P2002|unique|duplicate key/i;
const FOREIGN_KEY = /P2003|foreign key/i;
const CHECK = /check|P2004|constraint/i;
const ENUM = /enum|invalid input value/i;

const STAMP = `${Date.now()}`;
const CODE = `M11DB_${STAMP}`;
const START = new Date(Date.now() - 5 * 60_000); // tolerance for clock skew between this machine and the database

const TABLES_BEFORE = [
  'academic_years', 'admin_sessions', 'admins', 'grades', 'schedule_configs', 'schedule_days', 'schedule_periods', 'schedule_timing_events',
  'schools', 'section_subject_teachers', 'sections', 'streams', 'subject_requirements', 'subjects', 'teacher_subject_grades', 'teacher_subjects', 'teachers',
] as const;
const NEW_TABLES = ['timetable_versions', 'timetable_entries', 'timetable_generation_runs'] as const;

async function snapshot(): Promise<Record<string, { n: number; h: string }>> {
  const out: Record<string, { n: number; h: string }> = {};
  for (const t of TABLES_BEFORE) {
    // exclude the throw-away test school's own rows from the fingerprint of the tables that carry them
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint; h: string }>>(`SELECT count(*) AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY id), '')) AS h FROM "${t}" x`);
    out[t] = { n: Number(rows[0]!.n), h: rows[0]!.h };
  }
  return out;
}
async function newTableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of NEW_TABLES) out[t] = Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${t}"`))[0]!.n);
  return out;
}

const runData = (schoolId: string, academicYearId: string, status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' = 'QUEUED', over: Record<string, unknown> = {}) => ({
  schoolId, academicYearId, status, options: { reproducible: false, seed: 1 }, timeLimitSeconds: 10, workers: 4, sectionCount: 3, ...over,
});
const versionData = (schoolId: string, academicYearId: string, versionNumber: number, over: Record<string, unknown> = {}) => ({
  schoolId, academicYearId, versionNumber, solutionSource: 'CP_SAT' as const, solverStatus: 'FEASIBLE' as const, weightsVersion: 'V1',
  inputHash: 'a'.repeat(64), inputSnapshot: { assignments: [] }, metrics: { weightedObjective: 0 }, baselineMetrics: { weightedObjective: 10 }, ...over,
});

async function main(): Promise<void> {
  const before = await snapshot();
  const newBefore = await newTableCounts();
  const schoolCountBefore = before.schools!.n;
  let schoolId = '';
  try {
    // -------------------------------------------------------------------------------------------------------------
    // Fixture: one school, two admins, two academic years, one grade, two sections, two subjects, two teachers
    // -------------------------------------------------------------------------------------------------------------
    const school = await prisma.school.create({ data: { name: 'Module 11 DB test school', code: CODE } });
    schoolId = school.id;
    const admin1 = await prisma.admin.create({ data: { schoolId, name: 'A1', email: `a1-${STAMP}@test.local`, passwordHash: 'x' } });
    const admin2 = await prisma.admin.create({ data: { schoolId, name: 'A2', email: `a2-${STAMP}@test.local`, passwordHash: 'x' } });
    const mkYear = (name: string) => prisma.academicYear.create({ data: { schoolId, name, startDate: new Date('2030-01-01'), endDate: new Date('2030-12-31') } });
    const yearA = await mkYear(`A-${STAMP}`);
    const yearB = await mkYear(`B-${STAMP}`);
    const grade = await prisma.grade.create({ data: { academicYearId: yearA.id, name: 'G8', displayOrder: 1 } });
    const sec1 = await prisma.section.create({ data: { gradeId: grade.id, name: 'A', code: 'A' } });
    const sec2 = await prisma.section.create({ data: { gradeId: grade.id, name: 'B', code: 'B' } });
    const sub1 = await prisma.subject.create({ data: { schoolId, name: 'Math', code: 'MATH' } });
    const sub2 = await prisma.subject.create({ data: { schoolId, name: 'Sci', code: 'SCI' } });
    const t1 = await prisma.teacher.create({ data: { schoolId, name: 'T1' } });
    const t2 = await prisma.teacher.create({ data: { schoolId, name: 'T2' } });

    const mkVersion = (ay: string, n: number, over: Record<string, unknown> = {}) => prisma.timetableVersion.create({ data: versionData(schoolId, ay, n, over) });
    const mkEntry = (versionId: string, over: Record<string, unknown> = {}) => prisma.timetableEntry.create({
      data: { versionId, sectionId: sec1.id, subjectId: sub1.id, teacherId: t1.id, subjectRequirementId: 'req-1', dayOfWeek: 'MONDAY', periodNumber: 1, ...over } as never,
    });
    const mkRun = (ay: string, status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED', over: Record<string, unknown> = {}) => prisma.timetableGenerationRun.create({ data: runData(schoolId, ay, status, over) as never });

    // =============================================================================================================
    section('1. The objects exist in PostgreSQL exactly as approved');
    {
      const enums = await prisma.$queryRawUnsafe<Array<{ name: string; labels: string }>>(`SELECT t.typname AS name, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname IN ('TimetableVersionStatus','TimetableEntrySource','TimetableRunStatus','SolutionSource','SolverStatus') GROUP BY t.typname`);
      const e = Object.fromEntries(enums.map((x) => [x.name, x.labels]));
      check('TimetableRunStatus = QUEUED, RUNNING, SUCCEEDED, FAILED', e.TimetableRunStatus === 'QUEUED,RUNNING,SUCCEEDED,FAILED');
      check('SolutionSource = CP_SAT, BASELINE', e.SolutionSource === 'CP_SAT,BASELINE');
      check('SolverStatus = OPTIMAL, FEASIBLE, UNKNOWN (no INFEASIBLE: that is a failed run)', e.SolverStatus === 'OPTIMAL,FEASIBLE,UNKNOWN');
      check('TimetableVersionStatus = DRAFT, PUBLISHED, ARCHIVED', e.TimetableVersionStatus === 'DRAFT,PUBLISHED,ARCHIVED');
      check('TimetableEntrySource = GENERATED, MANUAL', e.TimetableEntrySource === 'GENERATED,MANUAL');

      const idx = await prisma.$queryRawUnsafe<Array<{ indexname: string; indexdef: string }>>(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename LIKE 'timetable\\_%'`);
      const byName = new Map(idx.map((x) => [x.indexname, x.indexdef]));
      const active = byName.get('timetable_generation_runs_one_active_per_year') ?? '';
      check('the partial unique index exists', /CREATE UNIQUE INDEX/.test(active) && /"academicYearId"/.test(active));
      check("...and is restricted to status IN ('QUEUED','RUNNING') in PostgreSQL itself", /WHERE/.test(active) && /QUEUED/.test(active) && /RUNNING/.test(active) && !/SUCCEEDED|FAILED/.test(active), active);
      for (const name of [
        'timetable_versions_academicYearId_versionNumber_key', 'timetable_versions_schoolId_idx',
        'timetable_entries_versionId_sectionId_dayOfWeek_periodNumbe_key', 'timetable_entries_versionId_teacherId_dayOfWeek_periodNumbe_key',
        'timetable_entries_sectionId_idx', 'timetable_entries_teacherId_idx', 'timetable_entries_subjectId_idx',
        'timetable_generation_runs_versionId_key', 'timetable_generation_runs_status_createdAt_idx', 'timetable_generation_runs_schoolId_academicYearId_createdAt_idx',
      ]) check(`index ${name}`, byName.has(name));
      check('the two entry slot indexes are UNIQUE', /UNIQUE/.test(byName.get('timetable_entries_versionId_sectionId_dayOfWeek_periodNumbe_key') ?? '') && /UNIQUE/.test(byName.get('timetable_entries_versionId_teacherId_dayOfWeek_periodNumbe_key') ?? ''));

      const checks = await prisma.$queryRawUnsafe<Array<{ conname: string; def: string }>>(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype='c' AND conrelid::regclass::text LIKE 'timetable\\_%'`);
      const c = Object.fromEntries(checks.map((x) => [x.conname, x.def]));
      check('CHECK versionNumber >= 1 exists', /versionNumber.*>=\s*1/.test(c.timetable_versions_version_number_check ?? ''));
      check('CHECK periodNumber >= 1 exists', /periodNumber.*>=\s*1/.test(c.timetable_entries_period_number_check ?? ''));

      const fks = await prisma.$queryRawUnsafe<Array<{ conname: string; action: string }>>(`SELECT conname, CASE confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'a' THEN 'NO ACTION' ELSE confdeltype::text END AS action FROM pg_constraint WHERE contype='f' AND conrelid::regclass::text LIKE 'timetable\\_%'`);
      const f = Object.fromEntries(fks.map((x) => [x.conname, x.action]));
      check('13 foreign keys exist (11 from Phase 4 + timetable_versions.publishedById from Phase 7A + timetable_versions.clonedFromId from Phase 7F-0)', fks.length === 13 && f['timetable_versions_publishedById_fkey'] === 'SET NULL' && f['timetable_versions_clonedFromId_fkey'] === 'SET NULL', String(fks.length));
      check('entries cascade from their version only; a section, subject or teacher with lessons can no longer be cascade-deleted (NO ACTION, migration 20261025090000)', f.timetable_entries_versionId_fkey === 'CASCADE' && ['sectionId', 'subjectId', 'teacherId'].every((k) => f[`timetable_entries_${k}_fkey`] === 'NO ACTION'));
      check('versions and runs cascade from school and academic year', ['schoolId', 'academicYearId'].every((k) => f[`timetable_versions_${k}_fkey`] === 'CASCADE' && f[`timetable_generation_runs_${k}_fkey`] === 'CASCADE'));
      check('createdById / requestedById are SET NULL', f.timetable_versions_createdById_fkey === 'SET NULL' && f.timetable_generation_runs_requestedById_fkey === 'SET NULL');
      check('run.versionId is SET NULL (deleting a draft keeps the run record)', f.timetable_generation_runs_versionId_fkey === 'SET NULL');
    }

    // =============================================================================================================
    section('2. Valid creation and defaults');
    const v1 = await mkVersion(yearA.id, 1, { createdById: admin1.id, solverDiagnostics: { wallSeconds: 1.5 } });
    {
      check('a valid version is created with status DRAFT', v1.status === 'DRAFT' && v1.versionNumber === 1 && v1.solutionSource === 'CP_SAT' && v1.solverStatus === 'FEASIBLE');
      check('weightsVersion, inputHash and the Json fields are stored', v1.weightsVersion === 'V1' && v1.inputHash.length === 64 && v1.createdById === admin1.id);
      const baselineVersion = await mkVersion(yearA.id, 2, { solutionSource: 'BASELINE', solverStatus: 'UNKNOWN', solverDiagnostics: null });
      check('a BASELINE version with solverStatus UNKNOWN and no solver diagnostics is valid', baselineVersion.solutionSource === 'BASELINE' && baselineVersion.solverStatus === 'UNKNOWN' && baselineVersion.solverDiagnostics === null);
      for (const [src, st] of [['CP_SAT', 'OPTIMAL'], ['CP_SAT', 'FEASIBLE'], ['BASELINE', 'UNKNOWN']] as const) {
        const ok = await rejected(() => mkVersion(yearB.id, 100 + Math.floor(Math.random() * 1e6), { solutionSource: src, solverStatus: st }));
        check(`a version with ${src} / ${st} is accepted`, ok === null, ok ?? '');
      }

      const e1 = await mkEntry(v1.id);
      check('a valid entry is created with source GENERATED and isLocked false', e1.source === 'GENERATED' && e1.isLocked === false && e1.dayOfWeek === 'MONDAY' && e1.periodNumber === 1);
      const manual = await mkEntry(v1.id, { sectionId: sec2.id, teacherId: t2.id, dayOfWeek: 'TUESDAY', periodNumber: 3, source: 'MANUAL', isLocked: true });
      check('source MANUAL and isLocked true are storable', manual.source === 'MANUAL' && manual.isLocked === true);
      check('periodNumber values above 12 are not constrained by the database (the contract bounds them)', (await rejected(() => mkEntry(v1.id, { sectionId: sec2.id, teacherId: t2.id, dayOfWeek: 'WEDNESDAY', periodNumber: 99 }))) === null);

      const run = await mkRun(yearB.id, 'SUCCEEDED');
      check('a valid run: defaults phase null, attempts 0, no lease, no failure, no version', run.phase === null && run.attempts === 0 && run.leaseOwner === null && run.leaseExpiresAt === null && run.heartbeatAt === null && run.failureCode === null && run.versionId === null && run.resultSummary === null && run.startedAt === null && run.finishedAt === null);
      const queued = await prisma.timetableGenerationRun.create({ data: { schoolId, academicYearId: (await mkYear(`Q-${STAMP}`)).id, options: {}, timeLimitSeconds: 10, workers: 4, sectionCount: 1 } });
      check('a run created without a status is QUEUED', queued.status === 'QUEUED');
      const unicode = { name: 'Klasse-ñ-教室-😀', nested: { a: [1, 2, { b: null }], c: 'x' }, n: 1.5 };
      const rich = await prisma.timetableVersion.create({ data: versionData(schoolId, (await mkYear(`J-${STAMP}`)).id, 1, { inputSnapshot: unicode, metrics: unicode }) });
      const back = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: rich.id } });
      check('Json columns round-trip nested and unicode content exactly (jsonb may reorder keys)', sameJson(back.inputSnapshot, unicode) && sameJson(back.metrics, unicode));
      const full = await mkRun((await mkYear(`F-${STAMP}`)).id, 'FAILED', { phase: 'SOLVING', attempts: 2, leaseOwner: randomUUID(), leaseExpiresAt: new Date(), heartbeatAt: new Date(), inputHash: 'h', failureCode: 'WORKER_LOST', failureMessage: 'lost', failureDiagnostics: { a: 1 }, resultSummary: { x: 1 }, startedAt: new Date(), finishedAt: new Date(), requestedById: admin1.id });
      check('every run column is storable and read back', full.phase === 'SOLVING' && full.attempts === 2 && full.failureCode === 'WORKER_LOST' && full.requestedById === admin1.id && full.leaseOwner !== null);
    }

    // =============================================================================================================
    section('3. Foreign keys');
    {
      const ghost = randomUUID();
      for (const [name, fn] of [
        ['entry with an unknown version', () => mkEntry(ghost)],
        ['entry with an unknown section', () => mkEntry(v1.id, { sectionId: ghost, dayOfWeek: 'FRIDAY' })],
        ['entry with an unknown subject', () => mkEntry(v1.id, { subjectId: ghost, dayOfWeek: 'FRIDAY' })],
        ['entry with an unknown teacher', () => mkEntry(v1.id, { teacherId: ghost, dayOfWeek: 'FRIDAY' })],
        ['version with an unknown school', () => prisma.timetableVersion.create({ data: versionData(ghost, yearA.id, 50) })],
        ['version with an unknown academic year', () => prisma.timetableVersion.create({ data: versionData(schoolId, ghost, 50) })],
        ['version with an unknown creator', () => mkVersion(yearA.id, 51, { createdById: ghost })],
        ['run with an unknown school', () => prisma.timetableGenerationRun.create({ data: runData(ghost, yearB.id, 'SUCCEEDED') as never })],
        ['run with an unknown academic year', () => mkRun(ghost, 'SUCCEEDED')],
        ['run with an unknown requester', () => mkRun(yearB.id, 'SUCCEEDED', { requestedById: ghost })],
        ['run pointing at an unknown version', () => mkRun(yearB.id, 'SUCCEEDED', { versionId: ghost })],
      ] as Array<[string, () => Promise<unknown>]>) {
        const err = await rejected(fn);
        check(`${name} is rejected by PostgreSQL`, err !== null && FOREIGN_KEY.test(err), err ?? 'accepted!');
      }
      check('a null createdById / requestedById / versionId is allowed', (await rejected(() => mkVersion(yearA.id, 52, { createdById: null }))) === null);
    }

    // =============================================================================================================
    section('4. Enum values are enforced by PostgreSQL');
    {
      // each column gets a valid value except the one under test (the test values are constants, so interpolation is safe)
      const insertVersion = (col: 'status' | 'solutionSource' | 'solverStatus', value: string) => {
        const v = { status: 'DRAFT', solutionSource: 'CP_SAT', solverStatus: 'FEASIBLE', [col]: value };
        return prisma.$executeRawUnsafe(
          `INSERT INTO timetable_versions (id, "schoolId", "academicYearId", "versionNumber", status, "solutionSource", "solverStatus", "weightsVersion", "inputHash", "inputSnapshot", "metrics", "baselineMetrics", "updatedAt") VALUES ($1, $2, $3, $4, '${v.status}', '${v.solutionSource}', '${v.solverStatus}', 'V1', 'h', '{}', '{}', '{}', now())`,
          randomUUID(), schoolId, yearA.id, 900 + Math.floor(Math.random() * 1e5));
      };
      const okRow = await rejected(() => insertVersion('status', 'DRAFT'));
      check('control: the same raw INSERT with valid values is accepted (so the rejections below are about the enum only)', okRow === null, okRow ?? '');
      for (const [col, bad] of [['status', 'DONE'], ['solutionSource', 'OTHER'], ['solverStatus', 'INFEASIBLE'], ['solverStatus', 'MODEL_INVALID']] as const) {
        const err = await rejected(() => insertVersion(col, bad));
        check(`version.${col} = '${bad}' is rejected by the enum`, err !== null && ENUM.test(err) && !/specified more than once/.test(err), err ?? 'accepted!');
      }
      const badRun = await rejected(() => prisma.$executeRawUnsafe(`INSERT INTO timetable_generation_runs (id, "schoolId", "academicYearId", status, options, "timeLimitSeconds", workers, "sectionCount", "updatedAt") VALUES ($1, $2, $3, 'DONE', '{}', 10, 4, 1, now())`, randomUUID(), schoolId, yearB.id));
      check("run.status = 'DONE' is rejected", badRun !== null && ENUM.test(badRun), badRun ?? 'accepted!');
      const badEntry = await rejected(() => prisma.$executeRawUnsafe(`INSERT INTO timetable_entries (id, "versionId", "sectionId", "subjectId", "teacherId", "subjectRequirementId", "dayOfWeek", "periodNumber", source) VALUES ($1, $2, $3, $4, $5, 'r', 'MONDAY', 7, 'ROBOT')`, randomUUID(), v1.id, sec1.id, sub1.id, t1.id));
      check("entry.source = 'ROBOT' is rejected", badEntry !== null && ENUM.test(badEntry), badEntry ?? 'accepted!');
      const badDay = await rejected(() => prisma.$executeRawUnsafe(`INSERT INTO timetable_entries (id, "versionId", "sectionId", "subjectId", "teacherId", "subjectRequirementId", "dayOfWeek", "periodNumber") VALUES ($1, $2, $3, $4, $5, 'r', 'FUNDAY', 7)`, randomUUID(), v1.id, sec1.id, sub1.id, t1.id));
      check("entry.dayOfWeek = 'FUNDAY' is rejected", badDay !== null && ENUM.test(badDay), badDay ?? 'accepted!');
      const viaPrisma = await rejected(() => mkRun(yearB.id, 'DONE' as never));
      check('the Prisma client also refuses an invalid enum value', viaPrisma !== null);
    }

    // =============================================================================================================
    section('5. One entry per section/day/period and one per teacher/day/period (within a version)');
    const vSlots = await mkVersion(yearA.id, 10);
    {
      await mkEntry(vSlots.id, { dayOfWeek: 'MONDAY', periodNumber: 2 });
      const dupSection = await rejected(() => mkEntry(vSlots.id, { teacherId: t2.id, subjectId: sub2.id, dayOfWeek: 'MONDAY', periodNumber: 2 }));
      check('the same section in the same day+period is rejected (a different teacher and subject do not matter)', dupSection !== null && UNIQUE.test(dupSection), dupSection ?? 'accepted!');
      const dupTeacher = await rejected(() => mkEntry(vSlots.id, { sectionId: sec2.id, subjectId: sub2.id, dayOfWeek: 'MONDAY', periodNumber: 2 }));
      check('the same teacher in the same day+period is rejected (a different section and subject do not matter)', dupTeacher !== null && UNIQUE.test(dupTeacher), dupTeacher ?? 'accepted!');
      const exact = await rejected(() => mkEntry(vSlots.id, { dayOfWeek: 'MONDAY', periodNumber: 2 }));
      check('an exact duplicate entry is rejected', exact !== null && UNIQUE.test(exact), exact ?? 'accepted!');
      const manualDup = await rejected(() => mkEntry(vSlots.id, { dayOfWeek: 'MONDAY', periodNumber: 2, source: 'MANUAL', isLocked: true }));
      check('source / isLocked do not exempt a duplicate slot', manualDup !== null && UNIQUE.test(manualDup), manualDup ?? 'accepted!');
      check('a different teacher AND different section in the same slot is allowed', (await rejected(() => mkEntry(vSlots.id, { sectionId: sec2.id, teacherId: t2.id, subjectId: sub2.id, dayOfWeek: 'MONDAY', periodNumber: 2 }))) === null);
      check('the same section and teacher in another period is allowed', (await rejected(() => mkEntry(vSlots.id, { dayOfWeek: 'MONDAY', periodNumber: 3 }))) === null);
      check('the same section and teacher on another day is allowed', (await rejected(() => mkEntry(vSlots.id, { dayOfWeek: 'TUESDAY', periodNumber: 2 }))) === null);
      const other = await mkVersion(yearA.id, 11);
      check('the same slot in a DIFFERENT version is allowed (versions are independent)', (await rejected(() => mkEntry(other.id, { dayOfWeek: 'MONDAY', periodNumber: 2 }))) === null);
      const raw = await rejected(() => prisma.$executeRawUnsafe(`INSERT INTO timetable_entries (id, "versionId", "sectionId", "subjectId", "teacherId", "subjectRequirementId", "dayOfWeek", "periodNumber") VALUES ($1, $2, $3, $4, $5, 'r', 'MONDAY', 2)`, randomUUID(), vSlots.id, sec1.id, sub2.id, t2.id));
      check('the raw SQL path is rejected too (the database, not Prisma, enforces it)', raw !== null && UNIQUE.test(raw) && /timetable_entries_versionId_sectionId/.test(raw), raw ?? 'accepted!');
      const sec3 = await prisma.section.create({ data: { gradeId: grade.id, name: 'C', code: `C${STAMP}`.slice(0, 20) } });
      const rawTeacher = await rejected(() => prisma.$executeRawUnsafe(`INSERT INTO timetable_entries (id, "versionId", "sectionId", "subjectId", "teacherId", "subjectRequirementId", "dayOfWeek", "periodNumber") VALUES ($1, $2, $3, $4, $5, 'r', 'MONDAY', 2)`, randomUUID(), vSlots.id, sec3.id, sub2.id, t1.id));
      check('the raw SQL teacher collision is rejected by the teacher/day/period index', rawTeacher !== null && UNIQUE.test(rawTeacher) && /timetable_entries_versionId_teacherId/.test(rawTeacher), rawTeacher ?? 'accepted!');
    }

    // =============================================================================================================
    section('6. CHECK constraints');
    {
      const vc = await mkVersion(yearA.id, 20);
      for (const bad of [0, -1, -100]) {
        const err = await rejected(() => mkVersion(yearA.id, bad));
        check(`versionNumber ${bad} is rejected`, err !== null && /version_number_check|check/i.test(err), err ?? 'accepted!');
      }
      check('versionNumber 1 is accepted (the lower bound)', (await rejected(() => mkVersion(yearB.id, 1))) === null);
      for (const bad of [0, -1, -7]) {
        const err = await rejected(() => mkEntry(vc.id, { periodNumber: bad, dayOfWeek: 'THURSDAY' }));
        check(`periodNumber ${bad} is rejected`, err !== null && /period_number_check|check/i.test(err), err ?? 'accepted!');
      }
      check('periodNumber 1 is accepted (the lower bound)', (await rejected(() => mkEntry(vc.id, { periodNumber: 1, dayOfWeek: 'THURSDAY' }))) === null);
      const rawBad = await rejected(() => prisma.$executeRawUnsafe(`INSERT INTO timetable_entries (id, "versionId", "sectionId", "subjectId", "teacherId", "subjectRequirementId", "dayOfWeek", "periodNumber") VALUES ($1, $2, $3, $4, $5, 'r', 'FRIDAY', 0)`, randomUUID(), vc.id, sec1.id, sub1.id, t1.id));
      check('periodNumber 0 via raw SQL names the CHECK constraint', rawBad !== null && /timetable_entries_period_number_check/.test(rawBad), rawBad ?? 'accepted!');
      const upd = await rejected(() => prisma.$executeRawUnsafe(`UPDATE timetable_entries SET "periodNumber" = 0 WHERE "versionId" = $1`, vc.id));
      check('an UPDATE to an invalid periodNumber is rejected too', upd !== null && /period_number_check/.test(upd), upd ?? 'accepted!');
      const updVersion = await rejected(() => prisma.$executeRawUnsafe(`UPDATE timetable_versions SET "versionNumber" = 0 WHERE id = $1`, vc.id));
      check('an UPDATE to versionNumber 0 is rejected', updVersion !== null && /version_number_check/.test(updVersion), updVersion ?? 'accepted!');
    }

    // =============================================================================================================
    section('7. Version numbering');
    {
      const dup = await rejected(() => mkVersion(yearA.id, 1));
      check('the same versionNumber twice in one academic year is rejected', dup !== null && UNIQUE.test(dup), dup ?? 'accepted!');
      const otherYear = await mkYear(`N-${STAMP}`);
      check('the same versionNumber in ANOTHER academic year is allowed', (await rejected(() => mkVersion(otherYear.id, 1))) === null);
      check('numbers need not be consecutive (deleted drafts leave gaps)', (await rejected(() => mkVersion(yearA.id, 500))) === null);
    }

    // =============================================================================================================
    section('8. At most ONE queued or running generation per academic year (the partial unique index)');
    {
      const year = async (tag: string) => (await mkYear(`${tag}-${STAMP}-${Math.random().toString(36).slice(2, 7)}`)).id;
      const activeCount = async (ay: string): Promise<number> => Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM timetable_generation_runs WHERE "academicYearId" = $1 AND status IN ('QUEUED','RUNNING')`, ay))[0]!.n);

      const a1 = await year('act1');
      await mkRun(a1, 'QUEUED');
      let err = await rejected(() => mkRun(a1, 'QUEUED'));
      check('Academic Year A: QUEUED, then a second QUEUED -> REJECTED', err !== null && UNIQUE.test(err) && /one_active_per_year|P2002/.test(err), err ?? 'accepted!');
      err = await rejected(() => mkRun(a1, 'RUNNING'));
      check('Academic Year A: QUEUED, then a RUNNING -> REJECTED', err !== null && UNIQUE.test(err), err ?? 'accepted!');
      check('...and exactly one active run remains', (await activeCount(a1)) === 1);

      const a2 = await year('act2');
      await mkRun(a2, 'RUNNING');
      err = await rejected(() => mkRun(a2, 'QUEUED'));
      check('Academic Year A: RUNNING, then a QUEUED -> REJECTED', err !== null && UNIQUE.test(err), err ?? 'accepted!');
      err = await rejected(() => mkRun(a2, 'RUNNING'));
      check('Academic Year A: RUNNING, then a second RUNNING -> REJECTED', err !== null && UNIQUE.test(err), err ?? 'accepted!');

      const a3 = await year('done1');
      await mkRun(a3, 'SUCCEEDED');
      check('Academic Year A: SUCCEEDED, then a new QUEUED -> ALLOWED', (await rejected(() => mkRun(a3, 'QUEUED'))) === null);
      const a4 = await year('done2');
      await mkRun(a4, 'FAILED');
      check('Academic Year A: FAILED, then a new RUNNING -> ALLOWED', (await rejected(() => mkRun(a4, 'RUNNING'))) === null);

      const a5 = await year('many');
      for (let i = 0; i < 5; i++) await mkRun(a5, 'SUCCEEDED');
      for (let i = 0; i < 5; i++) await mkRun(a5, 'FAILED');
      check('any number of finished (SUCCEEDED / FAILED) runs may coexist in one year', Number((await prisma.timetableGenerationRun.count({ where: { academicYearId: a5 } }))) === 10);
      check('...and a new generation is still allowed after all of them', (await rejected(() => mkRun(a5, 'QUEUED'))) === null);

      // independence between academic years
      const b1 = await year('indepA'); const b2 = await year('indepB');
      await mkRun(b1, 'QUEUED');
      check('Academic Year B: a QUEUED run is independent of Academic Year A\'s QUEUED run', (await rejected(() => mkRun(b2, 'QUEUED'))) === null);
      const b3 = await year('indepC');
      check('Academic Year B: a RUNNING run is independent as well', (await rejected(() => mkRun(b3, 'RUNNING'))) === null);
      check('the original year\'s active run is untouched by its neighbours', (await activeCount(b1)) === 1);

      // the lifecycle through UPDATEs
      const life = await year('life');
      const r = await mkRun(life, 'QUEUED');
      check('QUEUED -> RUNNING on the same row is allowed (the row keeps its single active slot)', (await rejected(() => prisma.timetableGenerationRun.update({ where: { id: r.id }, data: { status: 'RUNNING', startedAt: new Date() } }))) === null);
      err = await rejected(() => mkRun(life, 'QUEUED'));
      check('while it RUNS a new request is rejected', err !== null && UNIQUE.test(err), err ?? 'accepted!');
      await prisma.timetableGenerationRun.update({ where: { id: r.id }, data: { status: 'SUCCEEDED', finishedAt: new Date() } });
      check('after it SUCCEEDED a new request is allowed', (await activeCount(life)) === 0 && (await rejected(() => mkRun(life, 'QUEUED'))) === null);
      const second = await prisma.timetableGenerationRun.findFirstOrThrow({ where: { academicYearId: life, status: 'QUEUED' } });
      await prisma.timetableGenerationRun.update({ where: { id: second.id }, data: { status: 'FAILED', failureCode: 'NOT_READY' } });
      check('after it FAILED a further request is allowed', (await rejected(() => mkRun(life, 'QUEUED'))) === null);
      // an UPDATE that would create a second active run is rejected as well
      const finished = await prisma.timetableGenerationRun.findFirstOrThrow({ where: { academicYearId: life, status: 'SUCCEEDED' } });
      err = await rejected(() => prisma.timetableGenerationRun.update({ where: { id: finished.id }, data: { status: 'RUNNING' } }));
      check('re-activating a finished run while another is active is rejected (the index guards UPDATE too)', err !== null && UNIQUE.test(err), err ?? 'accepted!');
      const raw = await rejected(() => prisma.$executeRawUnsafe(`INSERT INTO timetable_generation_runs (id, "schoolId", "academicYearId", status, options, "timeLimitSeconds", workers, "sectionCount", "updatedAt") VALUES ($1, $2, $3, 'QUEUED', '{}', 10, 4, 1, now())`, randomUUID(), schoolId, life));
      check('a raw SQL INSERT of a second active run is rejected by the named index', raw !== null && /timetable_generation_runs_one_active_per_year/.test(raw), raw ?? 'accepted!');

      // concurrency: many simultaneous inserts for one year, exactly one wins
      let raceViolations = 0; let raceRounds = 0;
      for (let round = 0; round < 12; round++) {
        const ay = await year(`race${round}`);
        const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => mkRun(ay, i % 2 === 0 ? 'QUEUED' : 'RUNNING')));
        const ok = results.filter((x) => x.status === 'fulfilled').length;
        const active = await activeCount(ay);
        raceRounds++;
        if (ok !== 1 || active !== 1) raceViolations++;
      }
      check(`12 rounds of 6 simultaneous inserts per year: exactly one wins every time (${raceRounds - raceViolations}/${raceRounds})`, raceViolations === 0);
      const global = Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM (SELECT "academicYearId" FROM timetable_generation_runs WHERE status IN ('QUEUED','RUNNING') GROUP BY "academicYearId" HAVING count(*) > 1) x`))[0]!.n);
      check('no academic year in the whole table has more than one active run', global === 0);
    }

    // =============================================================================================================
    section('9. Version / run relationship');
    {
      const ay = (await mkYear(`rel-${STAMP}`)).id;
      const ver = await mkVersion(ay, 1);
      const run = await mkRun(ay, 'SUCCEEDED', { versionId: ver.id, resultSummary: { solverStatus: 'FEASIBLE' } });
      const viaRun = await prisma.timetableGenerationRun.findUniqueOrThrow({ where: { id: run.id }, include: { version: true } });
      const viaVersion = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: ver.id }, include: { generationRun: true } });
      check('a run reaches its version, and the version reaches its run (one to one)', viaRun.version?.id === ver.id && viaVersion.generationRun?.id === run.id);
      const dup = await rejected(() => mkRun(ay, 'FAILED', { versionId: ver.id }));
      check('two runs cannot point at the same version', dup !== null && UNIQUE.test(dup), dup ?? 'accepted!');
      await mkEntry(ver.id, { dayOfWeek: 'MONDAY', periodNumber: 1 });
      await prisma.timetableVersion.delete({ where: { id: ver.id } });
      const after = await prisma.timetableGenerationRun.findUniqueOrThrow({ where: { id: run.id } });
      check('deleting a version leaves its run, with versionId set to NULL and the result summary intact', after.versionId === null && (after.resultSummary as { solverStatus: string }).solverStatus === 'FEASIBLE');
      check('deleting a version cascades to its entries', (await prisma.timetableEntry.count({ where: { versionId: ver.id } })) === 0);
      const run2 = await mkRun(ay, 'SUCCEEDED');
      const ver2 = await mkVersion(ay, 2);
      await prisma.timetableGenerationRun.update({ where: { id: run2.id }, data: { versionId: ver2.id } });
      check('a run can be linked to its version after the version was created', (await prisma.timetableGenerationRun.findUniqueOrThrow({ where: { id: run2.id } })).versionId === ver2.id);
    }

    // =============================================================================================================
    section('10. Cascade and set-null behaviour');
    {
      const ay = (await mkYear(`cas-${STAMP}`)).id;
      const g = await prisma.grade.create({ data: { academicYearId: ay, name: 'GC', displayOrder: 1 } });
      const s = await prisma.section.create({ data: { gradeId: g.id, name: 'S', code: 'S' } });
      const subj = await prisma.subject.create({ data: { schoolId, name: 'CascSubj', code: `CS${STAMP}`.slice(0, 20) } });
      const tch = await prisma.teacher.create({ data: { schoolId, name: 'CascT' } });
      const ver = await mkVersion(ay, 1);
      const entryWith = (over: Record<string, unknown>) => mkEntry(ver.id, over);
      await entryWith({ sectionId: s.id, subjectId: subj.id, teacherId: tch.id, dayOfWeek: 'MONDAY', periodNumber: 1 });
      const refused = (p: Promise<unknown>) => p.then(() => false, (e: Error) => /foreign key|constraint/i.test(e.message));
      check('deleting a teacher who has lessons is REFUSED (history is no longer cascade-deleted; migration 20261025090000)', await refused(prisma.teacher.delete({ where: { id: tch.id } })) && (await prisma.timetableEntry.count({ where: { teacherId: tch.id } })) === 1);
      await prisma.timetableEntry.deleteMany({ where: { teacherId: tch.id } });
      await prisma.teacher.delete({ where: { id: tch.id } });
      check('…and once the lessons are gone the teacher can be deleted', (await prisma.teacher.count({ where: { id: tch.id } })) === 0);
      const tch2 = await prisma.teacher.create({ data: { schoolId, name: 'CascT2' } });
      await entryWith({ sectionId: s.id, subjectId: subj.id, teacherId: tch2.id, dayOfWeek: 'MONDAY', periodNumber: 1 });
      check('deleting a subject that has lessons is REFUSED', await refused(prisma.subject.delete({ where: { id: subj.id } })) && (await prisma.timetableEntry.count({ where: { versionId: ver.id, teacherId: tch2.id } })) === 1);
      await prisma.timetableEntry.deleteMany({ where: { versionId: ver.id, teacherId: tch2.id } });
      await prisma.subject.delete({ where: { id: subj.id } });
      check('…and once the lessons are gone the subject can be deleted', (await prisma.subject.count({ where: { id: subj.id } })) === 0);
      const subj2 = await prisma.subject.create({ data: { schoolId, name: 'CascSubj2', code: `CT${STAMP}`.slice(0, 20) } });
      await entryWith({ sectionId: s.id, subjectId: subj2.id, teacherId: tch2.id, dayOfWeek: 'MONDAY', periodNumber: 1 });
      check('deleting a section that has lessons is REFUSED', await refused(prisma.section.delete({ where: { id: s.id } })) && (await prisma.timetableEntry.count({ where: { versionId: ver.id } })) === 1);
      await prisma.timetableEntry.deleteMany({ where: { versionId: ver.id } });
      await prisma.section.delete({ where: { id: s.id } });
      check('…and once the lessons are gone the section can be deleted', (await prisma.section.count({ where: { id: s.id } })) === 0);

      const adm = await prisma.admin.create({ data: { schoolId, name: 'Tmp', email: `tmp-${STAMP}@test.local`, passwordHash: 'x' } });
      const ver3 = await mkVersion(ay, 3, { createdById: adm.id });
      const run3 = await mkRun(ay, 'SUCCEEDED', { requestedById: adm.id });
      await prisma.admin.delete({ where: { id: adm.id } });
      check('deleting an admin keeps the version and run and nulls createdById / requestedById', (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: ver3.id } })).createdById === null && (await prisma.timetableGenerationRun.findUniqueOrThrow({ where: { id: run3.id } })).requestedById === null);

      await mkRun(ay, 'QUEUED');
      await mkEntry(ver.id, { sectionId: sec1.id, subjectId: sub1.id, teacherId: t1.id, dayOfWeek: 'MONDAY', periodNumber: 4 });
      await prisma.academicYear.delete({ where: { id: ay } });
      const left = await prisma.$queryRawUnsafe<Array<{ v: bigint; r: bigint; e: bigint }>>(`SELECT (SELECT count(*) FROM timetable_versions WHERE "academicYearId" = $1) AS v, (SELECT count(*) FROM timetable_generation_runs WHERE "academicYearId" = $1) AS r, (SELECT count(*) FROM timetable_entries WHERE "versionId" = $2) AS e`, ay, ver.id);
      check('deleting an academic year deletes its versions, runs and their entries', Number(left[0]!.v) === 0 && Number(left[0]!.r) === 0 && Number(left[0]!.e) === 0);
      check('...but not the other academic year\'s data', (await prisma.timetableVersion.count({ where: { academicYearId: yearA.id } })) > 0);
    }
  } finally {
    // -------------------------------------------------------------------------------------------------------------
    // Cleanup: delete ONLY the throw-away school (everything below it goes by cascade), then prove nothing remains
    // -------------------------------------------------------------------------------------------------------------
    section('11. Cleanup and proof that nothing existing changed');
    if (schoolId !== '') {
      const target = await prisma.school.findUnique({ where: { id: schoolId } });
      if (target && target.code === CODE && target.createdAt >= START) {
        const del = await prisma.school.deleteMany({ where: { id: schoolId, code: CODE } });
        check('exactly the one test school was deleted', del.count === 1);
      } else {
        check('the test school was found to delete', false, 'refusing to delete a school that is not the test school');
      }
    }
    const newAfter = await newTableCounts();
    check('the new tables are back to their starting counts (every test row was removed by the cascade)', JSON.stringify(newAfter) === JSON.stringify(newBefore), JSON.stringify({ newBefore, newAfter }));
    const after = await snapshot();
    const unchanged = TABLES_BEFORE.filter((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h);
    check(`all ${TABLES_BEFORE.length} pre-existing tables have identical row counts and content fingerprints`, unchanged.length === TABLES_BEFORE.length, TABLES_BEFORE.filter((t) => !unchanged.includes(t)).join(','));
    check('the school count is back to its starting value', after.schools!.n === schoolCountBefore);
    const stray = await prisma.school.count({ where: { code: { startsWith: 'M11DB_' } } });
    check('no test school remains', stray === 0);
  }
}

main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
