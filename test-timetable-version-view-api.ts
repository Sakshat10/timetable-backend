// Module 11 - Phase 7F-1: the readable timetable views, against the real database and the real Fastify app (inject).
//
//   1  section views and teacher views: correctness against the stored lessons, names, lock state, source, totals
//   2  empty timetables (a section / teacher without lessons, a version without lessons)
//   3  period times: snapshot, changedSinceCapture, legacy UNAVAILABLE, explicit current, the heuristic hint
//   4  renamed entities (live names) and the single-transaction (REPEATABLE READ) consistency
//   5  isolation: foreign school, cross-year, unknown, malformed, unauthenticated; no foreign name can leak
//   6  read-only: nothing written, no lock taken, validation / staleness / hashes untouched
//   7  Swagger
//   8  performance on a 100-section version
//   9  cleanup and proof that nothing existing changed
//
// Run with   NODE_ENV=production npx tsx test-timetable-version-view-api.ts
import 'dotenv/config'; // first: the database pool is created when a module imports src/config/database.ts
import './test-fixtures/test-security-env.js'; // a test-only COOKIE_SECRET (production mode refuses the placeholder in .env)
import { createHash, randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '@prisma/client';
import pg from 'pg';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { TimetableVersionViewService } from './src/modules/timetable-version/timetable-version.view-service.js';
import {
  assertQueueIsEmpty, captureLogger, createWorld, destroyWorld, EXISTING_TABLES, fastConfig, fingerprint, mustEnqueue, newTableCounts, prisma, rawPrisma, ScriptedSolver, seedYear, sleep, stampLegacyPeriodTimes,
  solution, waitTerminal, type SeededYear, type SolveCtx, type World,
} from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const writerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 10, connectionTimeoutMillis: 30_000 });
const writer = new PrismaClient({ adapter: new PrismaPg(writerPool) });
const PASSWORD = 'View#Test-Pass-2030';
const UUID0 = '00000000-0000-4000-8000-000000000000';
const WEEK = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
const expectedTimes = (n: number, shift = 0) => Array.from({ length: n }, (_, k) => ({ periodNumber: k + 1, startMinute: 480 + k * 60 + shift, endMinute: 530 + k * 60 + shift }));
const md5 = (v: unknown): string => createHash('md5').update(JSON.stringify(v)).digest('hex');

interface Reply { status: number; body: any; ms: number; bytes: number }

async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();
  const worldA: World = await createWorld('M11VA');
  const worldB: World = await createWorld('M11VB');
  const app = await buildApp();

  const login = async (world: World): Promise<string> => {
    const email = `view-${world.code}@test.local`;
    await prisma.admin.update({ where: { id: world.adminId }, data: { email, passwordHash: await hashPassword(PASSWORD) } });
    return (await adminService.loginAdmin({ schoolId: world.schoolId, email, password: PASSWORD })).sessionToken;
  };
  const tokA = await login(worldA);
  const tokB = await login(worldB);
  const get = async (versionId: string, qs: string, token: string | null = tokA): Promise<Reply> => {
    const t0 = Date.now();
    const res = await app.inject({ method: 'GET', url: `/api/timetable-versions/${versionId}/timetable?${qs}`, ...(token ? { headers: { cookie: `session_token=${token}` } } : {}) });
    return { status: res.statusCode, body: res.json(), ms: Date.now() - t0, bytes: Buffer.byteLength(res.body) };
  };
  const api = async (method: 'GET', url: string, token: string = tokA) => (await app.inject({ method, url, headers: { cookie: `session_token=${token}` } })).json();

  const mkVersion = (schoolId: string, yearId: string, versionNumber: number, snapshot: unknown, extra: Record<string, unknown> = {}) =>
    prisma.timetableVersion.create({ data: { schoolId, academicYearId: yearId, versionNumber, status: 'DRAFT', solutionSource: 'BASELINE', solverStatus: 'FEASIBLE', weightsVersion: 'V1', inputHash: 'x', inputSnapshot: snapshot as never, metrics: {}, baselineMetrics: {}, ...extra } as never });
  const gridSnapshot = (periods: number, days = 5) => ({ grid: { days: WEEK.slice(0, days).map((dayOfWeek, index) => ({ index, dayOfWeek })), periods: Array.from({ length: periods }, (_, k) => ({ periodNumber: k + 1, continuesIntoNext: false })), maxTeacherPeriodsPerWeek: 30 } });

  try {
    // ---------------------------------------------------------------------------------------------------- fixtures
    const yA = await seedYear(worldA, 'view-a', { sections: 3, legacy: true }); // a LEGACY schedule (period rows with clock times): the versions below are stamped like the pre-simplification code stamped them
    const yOther = await seedYear(worldA, 'view-other', { sections: 1, subjects: [2] });
    const yB = await seedYear(worldB, 'view-b', { sections: 1, subjects: [2] });
    const solver = new ScriptedSolver((ctx: SolveCtx) => solution(ctx.problem));
    const runner = new GenerationRunner({ prisma: rawPrisma, solverClient: solver, config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: 10 }, logger: captureLogger().logger });
    const queued = await mustEnqueue(worldA, yA);
    await runner.dispatch();
    const run = await waitTerminal(queued.id, 90_000);
    await runner.stop(5);
    const V0 = (await prisma.timetableVersion.findFirst({ where: { academicYearId: yA.yearId } }))!;
    await stampLegacyPeriodTimes(V0.id, yA.configId); // what the old code stored at generation
    const V = (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: V0.id } }));
    check('setup: a real generated version exists, with a (legacy-style) period-time snapshot', run.status === 'SUCCEEDED' && V.periodTimes !== null && V.periodTimesCapturedAt !== null, `${run.status} ${run.failureCode}`);
    const entries = await prisma.timetableEntry.findMany({ where: { versionId: V.id } });
    const sectionEntries = (sectionId: string) => entries.filter((e) => e.sectionId === sectionId);
    // lock two lessons of section 0, one of them also MANUAL
    const s0 = yA.sectionIds[0]!;
    const lockedEntry = sectionEntries(s0)[0]!;
    const manualEntry = sectionEntries(s0)[1]!;
    await prisma.timetableEntry.update({ where: { id: lockedEntry.id }, data: { isLocked: true } });
    await prisma.timetableEntry.update({ where: { id: manualEntry.id }, data: { isLocked: true, source: 'MANUAL' } });
    const names = {
      sections: new Map((await prisma.section.findMany({ where: { id: { in: yA.sectionIds } }, include: { grade: true } })).map((s) => [s.id, s])),
      subjects: new Map((await prisma.subject.findMany({ where: { id: { in: yA.subjectIds } } })).map((s) => [s.id, s])),
      teachers: new Map((await prisma.teacher.findMany({ where: { id: { in: yA.teacherIds } } })).map((t) => [t.id, t])),
    };

    // =================================================================================================================
    section('1. Section and teacher views');
    {
      let allMatch = true; let detail = '';
      for (const sid of yA.sectionIds) {
        const r = await get(V.id, `view=section&id=${sid}`);
        const mine = (await prisma.timetableEntry.findMany({ where: { versionId: V.id, sectionId: sid } }));
        const placed = r.body.data.cells.filter((c: any) => c.lesson);
        const exact = placed.length === mine.length && mine.every((e) => { const c = r.body.data.cells.find((x: any) => x.dayOfWeek === e.dayOfWeek && x.periodNumber === e.periodNumber); return c?.lesson?.entryId === e.id && c.lesson.subject.id === e.subjectId && c.lesson.teacher.id === e.teacherId && c.lesson.section.id === e.sectionId && c.lesson.isLocked === e.isLocked && c.lesson.source === e.source; });
        if (r.status !== 200 || !exact || r.body.data.cells.length !== 30) { allMatch = false; detail = `${sid} ${r.status} ${placed.length}/${mine.length}`; }
      }
      check('SECTION views of all three sections: 200, the full 5x6 grid, and EVERY lesson exactly where the stored entry is (ids, subject, teacher, lock, source)', allMatch, detail);

      const r0 = await get(V.id, `view=section&id=${s0}`);
      const d0 = r0.body.data;
      check('the envelope: success, message, version summary, subject block with the section name, code and grade', r0.body.success === true && d0.version.id === V.id && d0.version.versionNumber === V.versionNumber && d0.version.status === 'DRAFT' && d0.version.revision === V.revision && d0.subject.type === 'SECTION' && d0.subject.id === s0 && d0.subject.name === names.sections.get(s0)!.name && d0.subject.code === names.sections.get(s0)!.code && d0.subject.grade.name === 'G8');
      const lesson = d0.cells.find((c: any) => c.lesson?.entryId === manualEntry.id).lesson;
      check('names are resolved on every lesson: subject name + code, teacher name, section name + grade', d0.cells.filter((c: any) => c.lesson).every((c: any) => c.lesson.subject.name === names.subjects.get(c.lesson.subject.id)!.name && c.lesson.subject.code === names.subjects.get(c.lesson.subject.id)!.code && c.lesson.teacher.name === names.teachers.get(c.lesson.teacher.id)!.name && c.lesson.section.name === names.sections.get(s0)!.name && c.lesson.section.gradeName === 'G8'));
      check('lock state and source are reported: the locked lesson isLocked, the MANUAL one isLocked + MANUAL, the rest GENERATED and unlocked', d0.cells.find((c: any) => c.lesson?.entryId === lockedEntry.id).lesson.isLocked === true && lesson.isLocked === true && lesson.source === 'MANUAL' && d0.cells.filter((c: any) => c.lesson && ![lockedEntry.id, manualEntry.id].includes(c.lesson.entryId)).every((c: any) => !c.lesson.isLocked && c.lesson.source === 'GENERATED'));
      const t = d0.totals;
      check('totals: 12 lessons (5+4+3), 2 locked, 1 manual, 18 free slots of 30, nothing outside the grid', t.lessons === 12 && t.lockedLessons === 2 && t.manualLessons === 1 && t.freeSlots === 18 && t.outsideGrid === 0 && t.perDay.reduce((a: number, d: any) => a + d.lessons, 0) === 12 && t.perDay.length === 5);
      check('by subject: 5 / 4 / 3 lessons with names; by teacher: one teacher per subject; no bySection on a section view', t.bySubject.map((s: any) => s.lessons).join() === '5,4,3' && t.bySubject.every((s: any) => s.name) && t.byTeacher.length === 3 && t.bySection === undefined);
      check('the grid: five working days in week order, six periods with times from the snapshot (08:00-08:50 first)', d0.grid.days.map((d: any) => d.dayOfWeek).join() === WEEK.join() && d0.grid.periods.length === 6 && d0.grid.periods[0].startTime === '08:00' && d0.grid.periods[0].endTime === '08:50' && d0.grid.periods[5].startMinute === 780 && typeof d0.grid.periods[2].continuesIntoNext === 'boolean');
      check('the break after period 3 is reflected as continuesIntoNext false on that period (the seeded schedule has a break there)', d0.grid.periods[2].continuesIntoNext === false);

      // teacher
      const tid = yA.teacherIds[0]!;
      const rt = await get(V.id, `view=teacher&id=${tid}`);
      const dt = rt.body.data;
      const teacherEntries = entries.filter((e) => e.teacherId === tid);
      check('TEACHER view: 200, subject block (name, isActive), the teacher\'s 15 lessons (5 periods x 3 sections) exactly where stored', rt.status === 200 && dt.subject.type === 'TEACHER' && dt.subject.name === names.teachers.get(tid)!.name && dt.subject.isActive === true && dt.cells.filter((c: any) => c.lesson).length === 15 && teacherEntries.every((e) => dt.cells.find((c: any) => c.dayOfWeek === e.dayOfWeek && c.periodNumber === e.periodNumber)?.lesson?.entryId === e.id));
      check('teacher lessons name the SECTION (name + grade) and never collide in a slot; totals: 15 lessons, bySection 3 x 5, no byTeacher', dt.cells.filter((c: any) => c.lesson).every((c: any) => c.lesson.section.name && c.lesson.section.gradeName === 'G8' && c.lesson.teacher.id === tid) && dt.totals.lessons === 15 && dt.totals.bySection.length === 3 && dt.totals.bySection.every((s: any) => s.lessons === 5 && s.name.startsWith('G8 ')) && dt.totals.byTeacher === undefined && dt.totals.freeSlots === 15);
      check('the teacher view reflects the lock/source of the same entries (section 0\'s locked lesson, if it is this teacher\'s)', dt.cells.filter((c: any) => c.lesson).every((c: any) => { const e = entries.find((x) => x.id === c.lesson.entryId)!; const now = e.id === lockedEntry.id ? { l: true, s: 'GENERATED' } : e.id === manualEntry.id ? { l: true, s: 'MANUAL' } : { l: false, s: 'GENERATED' }; return c.lesson.isLocked === now.l && c.lesson.source === now.s; }));
      const asPublished = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: V.id } });
      void asPublished;
      // other statuses
      const pub = await mkVersion(worldA.schoolId, yA.yearId, 90, V.inputSnapshot, { status: 'PUBLISHED', publishedAt: new Date(), publishedById: worldA.adminId });
      const arch = await mkVersion(worldA.schoolId, yA.yearId, 91, V.inputSnapshot, { status: 'ARCHIVED', publishedAt: new Date(), archivedAt: new Date() });
      const rp = await get(pub.id, `view=section&id=${s0}`);
      const ra = await get(arch.id, `view=teacher&id=${tid}`);
      check('PUBLISHED and ARCHIVED versions can be viewed too (status reported)', rp.status === 200 && rp.body.data.version.status === 'PUBLISHED' && ra.status === 200 && ra.body.data.version.status === 'ARCHIVED');
    }

    // =================================================================================================================
    section('2. Empty timetables');
    {
      const extra = await prisma.section.create({ data: { gradeId: yA.gradeId, name: 'Empty', code: 'EMP' } });
      const r = await get(V.id, `view=section&id=${extra.id}`);
      check('a section of the year with no lessons in this version: 200, the full grid of free slots, zero totals', r.status === 200 && r.body.data.cells.length === 30 && r.body.data.cells.every((c: any) => c.lesson === null) && r.body.data.totals.lessons === 0 && r.body.data.totals.freeSlots === 30 && r.body.data.totals.bySubject.length === 0 && r.body.data.subject.name === 'Empty');
      const rt = await get(V.id, `view=teacher&id=${yA.spareTeacherId}`);
      check('a teacher of the school with no lessons (the spare teacher): 200, empty grid', rt.status === 200 && rt.body.data.cells.every((c: any) => c.lesson === null) && rt.body.data.totals.lessons === 0 && rt.body.data.subject.name === 'Spare teacher');
      const bare = await mkVersion(worldA.schoolId, yA.yearId, 92, gridSnapshot(4, 3), { periodTimes: expectedTimes(4), periodTimesCapturedAt: new Date() });
      const rb = await get(bare.id, `view=section&id=${s0}`);
      check('a version with NO lessons at all, its own 3-day x 4-period grid: 200, 12 free slots, times from its own snapshot', rb.status === 200 && rb.body.data.cells.length === 12 && rb.body.data.totals.freeSlots === 12 && rb.body.data.grid.days.length === 3 && rb.body.data.grid.periods.length === 4 && rb.body.data.grid.periods[3].startTime === '11:00');
      const rbt = await get(bare.id, `view=teacher&id=${yA.teacherIds[0]}`);
      check('...and the teacher view of it is empty as well', rbt.status === 200 && rbt.body.data.totals.lessons === 0);
      await prisma.section.delete({ where: { id: extra.id } });
    }

    // =================================================================================================================
    section('3. Period times');
    {
      const q = `view=section&id=${s0}`;
      const base = (await get(V.id, q)).body.data.periodTimes;
      const captured = V.periodTimesCapturedAt!.toISOString();
      check('a generated version: source SNAPSHOT, capturedAt = the stored capture time, changedSinceCapture false', base.source === 'SNAPSHOT' && base.capturedAt === captured && base.changedSinceCapture === false && base.incomplete === false && base.periodRowsCreatedAfterVersion === null);

      await writer.schedulePeriod.updateMany({ where: { scheduleConfigId: yA.configId }, data: { startMinute: { increment: 30 }, endMinute: { increment: 30 } } });
      const moved = (await get(V.id, q)).body.data;
      check('the school moves every period by 30 minutes: changedSinceCapture TRUE, but the view still shows the version\'s OWN times (08:00)', moved.periodTimes.changedSinceCapture === true && moved.periodTimes.source === 'SNAPSHOT' && moved.grid.periods[0].startTime === '08:00' && moved.grid.periods[0].endTime === '08:50');
      const cur = (await get(V.id, `${q}&periodTimes=current`)).body.data;
      check('explicit periodTimes=current: the LIVE times (08:30), source CURRENT, the comparison still reported, capturedAt kept', cur.periodTimes.source === 'CURRENT' && cur.grid.periods[0].startTime === '08:30' && cur.periodTimes.changedSinceCapture === true && cur.periodTimes.capturedAt === captured && cur.periodTimes.periodRowsCreatedAfterVersion === null);
      await writer.schedulePeriod.updateMany({ where: { scheduleConfigId: yA.configId }, data: { startMinute: { decrement: 30 }, endMinute: { decrement: 30 } } });
      check('edited and edited BACK: changedSinceCapture is false again (a content comparison, not a timestamp)', (await get(V.id, q)).body.data.periodTimes.changedSinceCapture === false);
      await writer.schedulePeriod.deleteMany({ where: { scheduleConfigId: yA.configId, periodNumber: 6 } });
      const fewer = (await get(V.id, q)).body.data;
      check('a live period removed: changedSinceCapture TRUE; the version still shows all six of its own times', fewer.periodTimes.changedSinceCapture === true && fewer.grid.periods.every((p: any) => p.startTime !== null) && fewer.periodTimes.incomplete === false);
      const curFewer = (await get(V.id, `${q}&periodTimes=current`)).body.data;
      check('...while CURRENT shows the removed period without times and says the view is incomplete', curFewer.grid.periods[5].startTime === null && curFewer.grid.periods[4].startTime === '12:00' && curFewer.periodTimes.incomplete === true);
      await writer.schedulePeriod.create({ data: { scheduleConfigId: yA.configId, periodNumber: 6, startMinute: 780, endMinute: 830 } });
      check('the period restored: unchanged again', (await get(V.id, q)).body.data.periodTimes.changedSinceCapture === false);

      // legacy: a version without a snapshot
      const legacy = await mkVersion(worldA.schoolId, yA.yearId, 93, V.inputSnapshot);
      const lg = (await get(legacy.id, q)).body.data;
      check('LEGACY version (no stored times), default request: source UNAVAILABLE, no times at all, changedSinceCapture null, nothing invented', lg.periodTimes.source === 'UNAVAILABLE' && lg.periodTimes.capturedAt === null && lg.periodTimes.changedSinceCapture === null && lg.periodTimes.incomplete === true && lg.grid.periods.every((p: any) => p.startMinute === null && p.endMinute === null && p.startTime === null && p.endTime === null));
      check('...but the grid itself (days, periods) is still complete', lg.grid.days.length === 5 && lg.grid.periods.length === 6 && lg.cells.length === 30);
      const lgSnapshotExplicit = (await get(legacy.id, `${q}&periodTimes=snapshot`)).body.data;
      check('an explicit periodTimes=snapshot behaves like the default', lgSnapshotExplicit.periodTimes.source === 'UNAVAILABLE');
      const lgCur = (await get(legacy.id, `${q}&periodTimes=current`)).body.data;
      check('LEGACY with periodTimes=current: the live times (08:00), source CURRENT, changedSinceCapture null (nothing to compare), capturedAt null', lgCur.periodTimes.source === 'CURRENT' && lgCur.grid.periods[0].startTime === '08:00' && lgCur.periodTimes.changedSinceCapture === null && lgCur.periodTimes.capturedAt === null);
      check('...with the heuristic hint FALSE: no live period row was created after this version', lgCur.periodTimes.periodRowsCreatedAfterVersion === false);
      const future = new Date(Date.now() + 3_600_000);
      await prisma.$executeRaw`UPDATE "schedule_periods" SET "createdAt" = ${future} WHERE "scheduleConfigId" = ${yA.configId} AND "periodNumber" = 1`;
      const lgCur2 = (await get(legacy.id, `${q}&periodTimes=current`)).body.data;
      check('a live period row created AFTER the version: the hint turns TRUE (a heuristic, named as such, never a guarantee)', lgCur2.periodTimes.periodRowsCreatedAfterVersion === true);
      check('the hint is never offered for a version that has a snapshot', (await get(V.id, `${q}&periodTimes=current`)).body.data.periodTimes.periodRowsCreatedAfterVersion === null);
      check('malformed periodTimes: 400', (await get(V.id, `${q}&periodTimes=live`)).status === 400);
    }

    // =================================================================================================================
    section('4. Renamed entities and one-transaction consistency');
    {
      const tid = yA.teacherIds[0]!;
      await prisma.teacher.update({ where: { id: tid }, data: { name: 'Renamed Teacher' } });
      await prisma.subject.update({ where: { id: yA.subjectIds[0]! }, data: { name: 'Renamed Subject', code: 'RENSUB' } });
      await prisma.section.update({ where: { id: s0 }, data: { name: 'RenamedSec', code: 'RSC' } });
      await prisma.grade.update({ where: { id: yA.gradeId }, data: { name: 'Renamed Grade' } });
      const r = (await get(V.id, `view=section&id=${s0}`)).body.data;
      const l = r.cells.find((c: any) => c.lesson?.subject.id === yA.subjectIds[0])!.lesson;
      check('after renaming a teacher, a subject (name and code), the section and its grade, the view shows the NEW names (live names)', l.teacher.name === 'Renamed Teacher' && l.subject.name === 'Renamed Subject' && l.subject.code === 'RENSUB' && l.section.name === 'RenamedSec' && l.section.code === 'RSC' && l.section.gradeName === 'Renamed Grade' && r.subject.name === 'RenamedSec' && r.subject.grade.name === 'Renamed Grade');
      const rt = (await get(V.id, `view=teacher&id=${tid}`)).body.data;
      check('...the teacher view too (teacher name, and "Renamed Grade RenamedSec" in bySection)', rt.subject.name === 'Renamed Teacher' && rt.totals.bySection.some((s: any) => s.name === 'Renamed Grade RenamedSec'));
      await prisma.teacher.update({ where: { id: tid }, data: { isActive: false } });
      check('a deactivated teacher still appears with isActive false (history is not hidden)', (await get(V.id, `view=section&id=${s0}`)).body.data.cells.filter((c: any) => c.lesson?.teacher.id === tid).every((c: any) => c.lesson.teacher.isActive === false));
      await prisma.teacher.update({ where: { id: tid }, data: { isActive: true, name: 'Teacher 0' } });

      // REPEATABLE READ: a change committed AFTER the view's transaction began is not seen by it
      let fired = false;
      const ext = rawPrisma.$extends({
        query: {
          teacher: {
            async findMany({ args, query }) {
              if (!fired) {
                fired = true; // after the version and the lessons were read: another admin renames the teacher and unlocks/locks a lesson
                await writer.teacher.update({ where: { id: tid }, data: { name: 'Renamed AFTER the snapshot' } });
                await writer.timetableEntry.update({ where: { id: lockedEntry.id }, data: { isLocked: false } });
              }
              return query(args);
            },
          },
        },
      });
      const svc = new TimetableVersionViewService(ext as unknown as PrismaClient);
      const consistent = await svc.view(worldA.schoolId, V.id, { view: 'section', id: s0, periodTimes: 'snapshot' });
      const seenTeacher = consistent.cells.find((c) => c.lesson?.teacher.id === tid)!.lesson!.teacher.name;
      const seenLocked = consistent.cells.find((c) => c.lesson?.entryId === lockedEntry.id)!.lesson!.isLocked;
      const nowDb = await prisma.teacher.findUniqueOrThrow({ where: { id: tid } });
      check('the concurrent change really happened during the view (control)', fired && nowDb.name === 'Renamed AFTER the snapshot' && (await prisma.timetableEntry.findUniqueOrThrow({ where: { id: lockedEntry.id } })).isLocked === false);
      check('THE VIEW IS ONE CONSISTENT SNAPSHOT: it shows the teacher name and the lock state as of its first read, not the later commit', seenTeacher === 'Teacher 0' && seenLocked === true, `${seenTeacher} locked=${seenLocked}`);
      const next = (await get(V.id, `view=section&id=${s0}`)).body.data;
      check('the NEXT request sees the new state', next.cells.find((c: any) => c.lesson?.teacher.id === tid).lesson.teacher.name === 'Renamed AFTER the snapshot' && next.cells.find((c: any) => c.lesson?.entryId === lockedEntry.id).lesson.isLocked === false);
      await prisma.teacher.update({ where: { id: tid }, data: { name: 'Teacher 0' } });
      await prisma.timetableEntry.update({ where: { id: lockedEntry.id }, data: { isLocked: true } });
    }

    // =================================================================================================================
    section('5. Isolation and input validation');
    {
      const sB = yB.sectionIds[0]!;
      const tB = yB.teacherIds[0]!;
      const s0 = yA.sectionIds[0]!;
      const tA = yA.teacherIds[0]!;
      const vB = await mkVersion(worldB.schoolId, yB.yearId, 1, gridSnapshot(6));
      const r1 = await get(V.id, `view=section&id=${s0}`, tokB);
      check('another school\'s VERSION: 403, and nothing of the timetable in the body', r1.status === 403 && !JSON.stringify(r1.body).includes(s0) && r1.body.data === undefined);
      const r2 = await get(V.id, `view=section&id=${sB}`);
      check('this school\'s version with ANOTHER SCHOOL\'S section: 403', r2.status === 403 && !JSON.stringify(r2.body).includes('Section'));
      const r3 = await get(V.id, `view=teacher&id=${tB}`);
      check('this school\'s version with ANOTHER SCHOOL\'S teacher: 403, no name', r3.status === 403 && !JSON.stringify(r3.body).includes('Teacher 0'));
      const rOtherYear = await get(V.id, `view=section&id=${yOther.sectionIds[0]}`);
      check('a section of ANOTHER ACADEMIC YEAR of the same school: 404 SECTION_NOT_FOUND (it cannot appear in this version)', rOtherYear.status === 404 && rOtherYear.body.data?.code === 'SECTION_NOT_FOUND');
      const rUnknownSec = await get(V.id, `view=section&id=${UUID0}`);
      const rUnknownTeacher = await get(V.id, `view=teacher&id=${UUID0}`);
      check('unknown section: 404 SECTION_NOT_FOUND; unknown teacher: 404 TEACHER_NOT_FOUND', rUnknownSec.status === 404 && rUnknownSec.body.data?.code === 'SECTION_NOT_FOUND' && rUnknownTeacher.status === 404 && rUnknownTeacher.body.data?.code === 'TEACHER_NOT_FOUND');
      check('unknown version: 404', (await get(UUID0, `view=section&id=${s0}`)).status === 404);
      check('a teacher id given to view=section (and a section id to view=teacher) is a 404, never a cross-read', (await get(V.id, `view=section&id=${tA}`)).status === 404 && (await get(V.id, `view=teacher&id=${s0}`)).status === 404);
      check('a section of THIS school but of the other school\'s version is impossible to reach: B\'s admin on B\'s version with A\'s section: 403', (await get(vB.id, `view=section&id=${s0}`, tokB)).status === 403);
      check('B\'s admin on B\'s own version works (control that the 403s are about ownership)', (await get(vB.id, `view=section&id=${sB}`, tokB)).status === 200);
      check('missing view, missing id, bad view, bad id, bad version id: 400 with field errors', (await get(V.id, `id=${s0}`)).status === 400 && (await get(V.id, 'view=section')).status === 400 && (await get(V.id, `view=class&id=${s0}`)).status === 400 && (await get(V.id, 'view=section&id=not-a-uuid')).status === 400 && (await get(V.id, '')).status === 400 && (await get('not-a-uuid', `view=section&id=${s0}`)).status === 400);
      check('a 400 names the field', JSON.stringify((await get(V.id, 'view=section&id=x')).body.errors ?? {}).includes('id'));
      check('unauthenticated: 401; a garbage cookie: 401', (await get(V.id, `view=section&id=${s0}`, null)).status === 401 && (await get(V.id, `view=section&id=${s0}`, 'garbage')).status === 401);
      check('extra query keys are ignored (no error, no effect)', (await get(V.id, `view=section&id=${s0}&schoolId=${worldB.schoolId}&x=1`)).status === 200);

      // a CORRUPT lesson that references another school's teacher and subject (the foreign keys allow it): no foreign name may appear
      const used = new Set((await prisma.timetableEntry.findMany({ where: { versionId: V.id, sectionId: s0 } })).map((e) => `${e.dayOfWeek}|${e.periodNumber}`));
      let freeSlot: [string, number] | null = null;
      for (const d of WEEK) for (let p = 1; p <= 6; p++) if (!freeSlot && !used.has(`${d}|${p}`)) freeSlot = [d, p];
      await prisma.teacher.update({ where: { id: tB }, data: { name: 'FOREIGN SECRET TEACHER' } });
      await prisma.subject.update({ where: { id: yB.subjectIds[0]! }, data: { name: 'FOREIGN SECRET SUBJECT' } });
      const corrupt = await prisma.timetableEntry.create({ data: { versionId: V.id, sectionId: s0, subjectId: yB.subjectIds[0]!, teacherId: tB, subjectRequirementId: yA.requirementIds[0]!, dayOfWeek: freeSlot![0] as never, periodNumber: freeSlot![1] } });
      const leak = await get(V.id, `view=section&id=${s0}`);
      const leakLesson = leak.body.data.cells.find((c: any) => c.lesson?.entryId === corrupt.id)?.lesson;
      check('a corrupt entry pointing at another school\'s teacher and subject: the lesson is shown with NULL names, and the foreign names appear nowhere in the response', leak.status === 200 && !!leakLesson && leakLesson.teacher.name === null && leakLesson.subject.name === null && !JSON.stringify(leak.body).includes('FOREIGN SECRET'));
      await prisma.timetableEntry.delete({ where: { id: corrupt.id } });
    }

    // =================================================================================================================
    section('6. Read-only: nothing written, no lock, staleness and hashes untouched');
    {
      const state = async () => ({
        version: await prisma.$queryRaw`SELECT "id","status"::text,"revision","inputHash","updatedAt","periodTimes","periodTimesCapturedAt","metrics" FROM "timetable_versions" WHERE "academicYearId" = ${yA.yearId} ORDER BY "id"`,
        entries: await prisma.$queryRaw`SELECT * FROM "timetable_entries" WHERE "versionId" = ${V.id} ORDER BY "id"`,
        runs: await prisma.$queryRaw`SELECT "id","status"::text,"updatedAt" FROM "timetable_generation_runs" WHERE "academicYearId" = ${yA.yearId} ORDER BY "id"`,
        counts: await newTableCounts(),
      });
      const validationBefore = (await api('GET', `/api/timetable-versions/${V.id}/validation`)).data;
      const before1 = md5(await state());
      for (let i = 0; i < 3; i++) { await get(V.id, `view=section&id=${yA.sectionIds[i]}`); await get(V.id, `view=teacher&id=${yA.teacherIds[i]}&periodTimes=current`); }
      const after1 = md5(await state());
      const validationAfter = (await api('GET', `/api/timetable-versions/${V.id}/validation`)).data;
      check('six views later: the version rows, ALL entries and the runs are byte-identical (nothing written, revision and updatedAt unchanged)', before1 === after1);
      const strip = (v: any) => JSON.stringify({ ...v, checkedAt: undefined });
      check('GET /validation (valid, isStale, hashes) is exactly the same before and after viewing: staleness behaviour untouched', strip(validationBefore) === strip(validationAfter) && typeof validationBefore.isStale === 'boolean', `${strip(validationBefore).slice(0, 160)}`);

      // no lock: another transaction holds the version row and the year row FOR UPDATE; the view neither waits nor blocks
      let release: () => void = () => undefined;
      const hold = new Promise<void>((r) => { release = r; });
      let locked: () => void = () => undefined;
      const lockedP = new Promise<void>((r) => { locked = r; });
      const holder = writer.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`SELECT "id" FROM "academic_years" WHERE "id" = ${yA.yearId} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "timetable_versions" WHERE "id" = ${V.id} FOR UPDATE`;
        await tx.$queryRaw`SELECT "id" FROM "timetable_entries" WHERE "versionId" = ${V.id} FOR UPDATE`;
        locked();
        await hold;
      }, { timeout: 60_000, maxWait: 20_000 });
      await lockedP;
      const during = await get(V.id, `view=section&id=${s0}`);
      release();
      await holder;
      check('while another transaction holds the year, the version and every entry FOR UPDATE, the view still answers 200 without waiting (it takes no lock)', during.status === 200 && during.ms < 8_000, `${during.status} ${during.ms}ms`);
      // and a view never blocks a writer: start a view and a FOR UPDATE together
      const [viewRes, writerRes] = await Promise.all([get(V.id, `view=teacher&id=${yA.teacherIds[0]}`), writer.$transaction(async (tx) => { await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '3s'`); await tx.$queryRaw`SELECT "id" FROM "timetable_versions" WHERE "id" = ${V.id} FOR UPDATE`; return 'OK'; }).catch((e) => `ERR ${e}`)]);
      check('a writer taking the version FOR UPDATE at the same moment as a view is never delayed by it', viewRes.status === 200 && writerRes === 'OK', String(writerRes));
    }

    // =================================================================================================================
    section('7. Swagger');
    {
      const spec = app.swagger() as any;
      const op = spec.paths['/api/timetable-versions/{id}/timetable']?.get;
      const params = (op?.parameters ?? []) as Array<{ name: string; in: string; required?: boolean; schema?: any }>;
      check('the operation exists with an operationId, the Timetable Version tag, and cookie auth', op?.operationId === 'getTimetableView' && op.tags.includes('Timetable Version') && JSON.stringify(op.security) === JSON.stringify([{ cookieAuth: [] }]));
      check('it documents the path id and the query: view (section|teacher, required), id (required), periodTimes (snapshot|current)', params.some((p) => p.in === 'path' && p.name === 'id') && JSON.stringify(params.find((p) => p.name === 'view')?.schema?.enum) === '["section","teacher"]' && params.find((p) => p.name === 'view')?.required === true && params.find((p) => p.name === 'id' && p.in === 'query')?.required === true && JSON.stringify(params.find((p) => p.name === 'periodTimes')?.schema?.enum) === '["snapshot","current"]');
      check('it documents 200, 400, 401, 403 and 404', ['200', '400', '401', '403', '404'].every((c) => op?.responses?.[c]));
      const data = op.responses['200'].content['application/json'].schema.properties.data.properties;
      check('the 200 body documents version, subject, grid (with times), periodTimes (source, changedSinceCapture), cells (lesson with lock and source) and totals', ['version', 'subject', 'grid', 'periodTimes', 'cells', 'totals'].every((k) => data[k]) && !!data.periodTimes.properties.changedSinceCapture && !!data.cells.items.properties.lesson.properties.isLocked && !!data.cells.items.properties.lesson.properties.source && !!data.grid.properties.periods.items.properties.startTime);
      check('the description explains the snapshot, UNAVAILABLE and current semantics', /UNAVAILABLE/.test(op.description) && /periodTimes=current/.test(op.description) && /changedSinceCapture/.test(op.description) && /heuristic/.test(op.description));
      const docs = await app.inject({ method: 'GET', url: '/docs/json' });
      check('/docs/json serves it', docs.statusCode === 200 && /getTimetableView/.test(docs.body));
    }

    // =================================================================================================================
    section('8. Performance: a version of 100 sections');
    {
      const yP = await prisma.academicYear.create({ data: { schoolId: worldA.schoolId, name: `perf-${randomUUID().slice(0, 6)}`, startDate: new Date('2036-01-01'), endDate: new Date('2036-12-31') } });
      const grade = await prisma.grade.create({ data: { academicYearId: yP.id, name: 'GP', displayOrder: 1 } });
      const config = await prisma.scheduleConfig.create({ data: { academicYearId: yP.id, periodsPerDay: 6 } });
      await prisma.scheduleDay.createMany({ data: WEEK.map((dayOfWeek) => ({ scheduleConfigId: config.id, dayOfWeek: dayOfWeek as never })) });
      await prisma.schedulePeriod.createMany({ data: Array.from({ length: 6 }, (_, k) => ({ scheduleConfigId: config.id, periodNumber: k + 1, startMinute: 480 + k * 60, endMinute: 530 + k * 60 })) });
      const sectionIds = Array.from({ length: 100 }, () => randomUUID());
      await prisma.section.createMany({ data: sectionIds.map((id, i) => ({ id, gradeId: grade.id, name: `P${String(i + 1).padStart(3, '0')}`, code: `P${i + 1}` })) });
      const subjectIds = Array.from({ length: 5 }, () => randomUUID());
      await prisma.subject.createMany({ data: subjectIds.map((id, i) => ({ id, schoolId: worldA.schoolId, name: `PSubject ${i}`, code: `PS${i}_${randomUUID().slice(0, 4)}` })) });
      const requirementIds = Array.from({ length: 5 }, () => randomUUID());
      await prisma.subjectRequirement.createMany({ data: requirementIds.map((id, i) => ({ id, gradeId: grade.id, subjectId: subjectIds[i]!, periodsPerWeek: 6 })) });
      const teacherIds = Array.from({ length: 100 }, () => randomUUID());
      await prisma.teacher.createMany({ data: teacherIds.map((id, i) => ({ id, schoolId: worldA.schoolId, name: `PTeacher ${i + 1}` })) });
      const big = await mkVersion(worldA.schoolId, yP.id, 1, gridSnapshot(6), { periodTimes: expectedTimes(6), periodTimesCapturedAt: new Date() });
      const rows: Prisma.TimetableEntryCreateManyInput[] = [];
      sectionIds.forEach((sid, i) => { for (let k = 0; k < 29; k++) rows.push({ versionId: big.id, sectionId: sid, subjectId: subjectIds[k % 5]!, teacherId: teacherIds[i]!, subjectRequirementId: requirementIds[k % 5]!, dayOfWeek: WEEK[k % 5] as never, periodNumber: Math.floor(k / 5) + 1 }); });
      for (let i = 0; i < rows.length; i += 2_000) await prisma.timetableEntry.createMany({ data: rows.slice(i, i + 2_000) });
      check('setup: a 100-section version with 2,900 lessons (29 of 30 slots per section)', (await prisma.timetableEntry.count({ where: { versionId: big.id } })) === 2_900);

      const time = async (versionId: string, qs: string, token = tokA): Promise<Reply> => { await get(versionId, qs, token); const runs: Reply[] = []; for (let i = 0; i < 3; i++) runs.push(await get(versionId, qs, token)); runs.sort((a, b) => a.ms - b.ms); return runs[1]!; };
      const small = await time(V.id, `view=section&id=${yA.sectionIds[1]}`);
      const bigSection = await time(big.id, `view=section&id=${sectionIds[50]}`);
      const bigTeacher = await time(big.id, `view=teacher&id=${teacherIds[50]}`);
      console.log(`  info: median latency (ms) incl. auth, 3-section version: ${small.ms}; 100-section version: section ${bigSection.ms}, teacher ${bigTeacher.ms}; bytes: ${small.bytes} / ${bigSection.bytes} / ${bigTeacher.bytes}`);
      check('100-section version, a section view: 200, 29 lessons, correct names, 1 free slot', bigSection.status === 200 && bigSection.body.data.totals.lessons === 29 && bigSection.body.data.totals.freeSlots === 1 && bigSection.body.data.cells.find((c: any) => c.lesson).lesson.section.name === 'P051' && bigSection.body.data.cells.find((c: any) => c.lesson).lesson.teacher.name === 'PTeacher 51');
      check('100-section version, a teacher view: 200, 29 lessons', bigTeacher.status === 200 && bigTeacher.body.data.totals.lessons === 29 && bigTeacher.body.data.subject.name === 'PTeacher 51');
      check('latency is acceptable: each view of the 100-section version answers in under 5 s (median of 3, remote database)', bigSection.ms < 5_000 && bigTeacher.ms < 5_000, `${bigSection.ms} / ${bigTeacher.ms}`);
      check('and it does NOT grow with the number of sections: within 2.5 s of the 3-section version\'s latency', bigSection.ms <= small.ms + 2_500 && bigTeacher.ms <= small.ms + 2_500, `${small.ms} vs ${bigSection.ms} / ${bigTeacher.ms}`);
      check('the response stays small (under 60 KB) however large the version is', bigSection.bytes < 60_000 && bigTeacher.bytes < 60_000, `${bigSection.bytes} / ${bigTeacher.bytes}`);
      const every = await Promise.all(Array.from({ length: 10 }, (_, i) => get(big.id, `view=section&id=${sectionIds[i * 10]}`)));
      check('ten concurrent views of the 100-section version all answer 200 with 29 lessons', every.every((r) => r.status === 200 && r.body.data.totals.lessons === 29), every.map((r) => r.status).join());
    }
  } finally {
    section('9. Cleanup and proof that nothing existing changed');
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    await app.close();
    await sleep(200);
    check('exactly the two test schools were deleted (cascade)', (await destroyWorld(worldA)) === 1 && (await destroyWorld(worldB)) === 1);
    check('the new tables are back to their starting counts', JSON.stringify(await newTableCounts()) === JSON.stringify(newBefore));
    const after = await fingerprint();
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, EXISTING_TABLES.every((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h));
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11VA_' } } })) === 0 && (await prisma.school.count({ where: { code: { startsWith: 'M11VB_' } } })) === 0);
    await writer.$disconnect();
    await writerPool.end().catch(() => undefined);
  }
}

let finished = false;
process.on('exit', (code) => {
  if (!finished) { console.log(`\nRESULT: pass=${pass} fail=${fail + 1} (the process ended before the suite completed, exit ${code})`); process.exitCode = 1; }
});
main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(async () => {
    await prisma.$disconnect();
    finished = true;
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
