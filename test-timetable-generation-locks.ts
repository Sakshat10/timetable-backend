// Module 11 - Phase 7E (integration): regenerating a draft while keeping its locked lessons. Real PostgreSQL, the real Fastify app (inject),
// the real runner, the real Python solver where it matters, real kill -9 for recovery. Test schools only; cleaned up at the end.
//
//   1 source validation   2 lock freezing (the POST contract)   3 the freeze race and source deletion   4 end to end (locks preserved,
//   source untouched, new draft valid and publishable)   5 real CP-SAT with locks   6 conflicting locks -> clear failures, no partial version
//   7 the solver / baseline outcome matrix through the runner   8 consistency of the frozen snapshot under concurrent edits   9 crash recovery
//   10 compatibility of the plain (no-lock) path   11 Swagger   12 cleanup and integrity
import 'dotenv/config'; // first: the database pool is created when a module imports src/config/database.ts
import './test-fixtures/test-security-env.js'; // a test-only COOKIE_SECRET (production mode refuses the placeholder in .env)
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { canonicalJson } from './src/modules/timetable-generation/timetable-generation.hash.js';
import { buildBaselineWithFixed } from './src/modules/timetable-generation/timetable-generation.baseline-locks.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { registerGenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner-handle.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { REPO_ROOT, resolveSolverClientConfig, SubprocessSolverClient, type SolverClient } from './src/modules/timetable-generation/timetable-generation.solver-client.js';
import { validateEntries } from './src/modules/timetable-generation/timetable-generation.validator.js';
import { loadGenerationSnapshot } from './src/modules/timetable-generation/timetable-generation.loader.js';
import { normalizeProblem } from './src/modules/timetable-generation/timetable-generation.normalizer.js';
import { configurationHash } from './src/modules/timetable-version/timetable-version.edit-core.js';
import {
  assertQueueIsEmpty, captureLogger, createWorld, destroyWorld, EXISTING_TABLES, fastConfig, fingerprint, getRun, newTableCounts, noSolution, prisma, rawPrisma, ScriptedSolver,
  seedYear, solution, waitFor, waitTerminal, watchdog, type SeededYear, type World,
} from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);

const PASSWORD = 'Lock#Test-Pass-2030';
const UUID0 = '00000000-0000-4000-8000-000000000000';
const TIGHT = { sections: 3, subjects: [6, 6, 6, 6, 5] };
const WORKER = path.join(REPO_ROOT, 'test-fixtures', 'timetable-generation', 'runner-worker.ts');
const solverProcesses = (): string[] => spawnSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(`${REPO_ROOT}/solver/main.py`) && !l.includes('ps -axo'));
const alive = (pid: number | undefined): boolean => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const WEEK5 = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'];
/** PostgreSQL jsonb reorders object keys: compare structurally. */
const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();
  const tmp = mkdtempSync(path.join(tmpdir(), 'locks-'));
  const workers: ChildProcess[] = [];
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('M11LK');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('M11LK');
  const worlds = [worldA, worldB];
  const runners: GenerationRunner[] = [];

  interface Reply { status: number; body: Record<string, any>; text: string }
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, cookie: string | null, payload?: unknown): Promise<Reply> => {
    const res = await app.inject({ method, url, ...(cookie ? { headers: { cookie: `session_token=${cookie}` } } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
    let body: Record<string, any> = {};
    try { body = JSON.parse(res.body); } catch { /* not JSON */ }
    return { status: res.statusCode, body, text: res.body };
  };
  const sessionFor = async (world: World): Promise<string> => {
    const admin = await prisma.admin.findUniqueOrThrow({ where: { id: world.adminId } });
    await prisma.admin.update({ where: { id: admin.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
    return (await adminService.loginAdmin({ schoolId: world.schoolId, email: admin.email, password: PASSWORD })).sessionToken;
  };
  const tokA = await sessionFor(worldA);
  const tokB = await sessionFor(worldB);

  // ---- runners -------------------------------------------------------------------------------------------------------
  let forwardTo: GenerationRunner | null = null;
  registerGenerationRunner({ trigger: () => forwardTo?.trigger() });
  const lockAware = (ctx: { problem: Parameters<typeof buildBaselineWithFixed>[0] }) => {
    const r = buildBaselineWithFixed(ctx.problem, 1);
    if (!r.ok) throw new Error('test fixture: no lock-aware timetable');
    return solution(ctx.problem, 'FEASIBLE', { entries: r.entries });
  };
  const makeRunner = (solver: SolverClient, extra: Partial<ConstructorParameters<typeof GenerationRunner>[0]> = {}, policyLe10 = 30): GenerationRunner => {
    const { logger } = captureLogger();
    const r = new GenerationRunner({ prisma: rawPrisma, solverClient: solver, config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: policyLe10 }, logger, ...extra });
    runners.push(r);
    return r;
  };
  // NOT started: its tick would claim any queued run at any moment. It only works when a POST (or a test) triggers it, so a run stays QUEUED
  // for as long as a test needs to inspect it.
  const scripted = makeRunner(new ScriptedSolver(lockAware));
  forwardTo = scripted;

  const mkYear = (world: World, tag: string, o: Parameters<typeof seedYear>[2] = {}): Promise<SeededYear> => seedYear(world, tag, o);
  const post = (tok: string, body: unknown) => call('POST', '/api/timetable-generations', tok, body);
  /** A plain generation (no source) through the API and runner. */
  const generate = async (tok: string, year: SeededYear): Promise<string> => {
    const r = await post(tok, { academicYearId: year.yearId });
    if (r.status !== 202) throw new Error(`generation rejected: ${r.text}`);
    const run = await waitTerminal(r.body.data.generationRunId, 120_000);
    if (run.status !== 'SUCCEEDED') throw new Error(`generation failed: ${run.failureCode}`);
    return run.versionId!;
  };
  const getV = async (tok: string, id: string) => (await call('GET', `/api/timetable-versions/${id}`, tok)).body.data;
  const lockEntries = async (tok: string, v: string, ids: string[], locked = true) => {
    const d = await getV(tok, v);
    return call('PUT', `/api/timetable-versions/${v}/locks`, tok, { entryIds: ids, locked, expectedRevision: d.revision });
  };
  const freeSlot = (entries: any[], e: any): [string, number] | null => {
    const occ = new Set(entries.filter((x) => x.sectionId === e.sectionId).map((x) => `${x.dayOfWeek}|${x.periodNumber}`));
    const busy = new Set(entries.filter((x) => x.teacherId === e.teacherId).map((x) => `${x.dayOfWeek}|${x.periodNumber}`));
    for (const d of WEEK5) for (let p = 1; p <= 6; p++) if (!occ.has(`${d}|${p}`) && !busy.has(`${d}|${p}`)) return [d, p];
    return null;
  };
  /** A draft with `count` locked lessons spread over its sections, one of them first moved by hand (so it is MANUAL). */
  const draftWithLocks = async (tok: string, year: SeededYear, count: number): Promise<{ v: string; locked: any[] }> => {
    const v = await generate(tok, year);
    const d0 = await getV(tok, v);
    const mover = d0.entries[3];
    const slot = freeSlot(d0.entries, mover);
    if (slot) await call('POST', `/api/timetable-versions/${v}/moves`, tok, { entryId: mover.id, to: { dayOfWeek: slot[0], periodNumber: slot[1] }, expectedRevision: d0.revision });
    const d = await getV(tok, v);
    const step = Math.max(1, Math.floor(d.entries.length / count));
    const ids = new Set<string>([mover.id]);
    for (let i = 0; ids.size < count && i < d.entries.length; i += step) ids.add(d.entries[i].id);
    const r = await lockEntries(tok, v, [...ids]);
    if (r.status !== 200) throw new Error(`lock failed: ${r.text}`);
    const after = await getV(tok, v);
    return { v, locked: after.entries.filter((e: any) => e.isLocked) };
  };
  const fingerprintVersion = async (v: string): Promise<string> => {
    const row = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: v }, select: { revision: true, status: true, metrics: true, inputHash: true, updatedAt: true } });
    const entries = await prisma.timetableEntry.findMany({ where: { versionId: v }, orderBy: { id: 'asc' } });
    return JSON.stringify({ row, entries });
  };
  const versionCount = (yearId: string) => prisma.timetableVersion.count({ where: { academicYearId: yearId } });
  const entryCount = (yearId: string) => prisma.timetableEntry.count({ where: { version: { academicYearId: yearId } } });
  const lockKey = (e: { sectionId: string; subjectRequirementId: string; teacherId: string; dayOfWeek: string; periodNumber: number }) => `${e.sectionId}|${e.subjectRequirementId}|${e.teacherId}|${e.dayOfWeek}|${e.periodNumber}`;
  const failQueuedRuns = async () => { await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now(), "leaseOwner" = NULL WHERE "status" IN ('QUEUED','RUNNING')`; };

  // a custom school where locks can make a timetable impossible although every lock is individually fine (see the pure and Python tests)
  async function seedLockInfeasibleYear(world: World) {
    const { schoolId } = world;
    const uniq = randomUUID().slice(0, 6);
    const year = await prisma.academicYear.create({ data: { schoolId, name: `lockinf-${uniq}`, startDate: new Date('2031-01-01'), endDate: new Date('2031-12-31') } });
    const gX = await prisma.grade.create({ data: { academicYearId: year.id, name: 'GX', displayOrder: 1 } });
    const gY = await prisma.grade.create({ data: { academicYearId: year.id, name: 'GY', displayOrder: 2 } });
    const sX = await prisma.section.create({ data: { gradeId: gX.id, name: 'X', code: 'X' } });
    const sY = await prisma.section.create({ data: { gradeId: gY.id, name: 'Y', code: 'Y' } });
    const subj = async (n: string) => prisma.subject.create({ data: { schoolId, name: `S${n}`, code: `S${n}_${uniq}` } });
    const [sA, sB, sC, sD] = [await subj('A'), await subj('B'), await subj('C'), await subj('D')];
    const [t1, t2, t3] = [await prisma.teacher.create({ data: { schoolId, name: 'T1' } }), await prisma.teacher.create({ data: { schoolId, name: 'T2' } }), await prisma.teacher.create({ data: { schoolId, name: 'T3' } })];
    const eligible = async (teacherId: string, subjectId: string, gradeId: string) => {
      const link = await prisma.teacherSubject.create({ data: { teacherId, subjectId, type: 'PRIMARY' } });
      await prisma.teacherSubjectGrade.create({ data: { teacherSubjectId: link.id, gradeId } });
    };
    await eligible(t1.id, sA.id, gX.id); await eligible(t2.id, sB.id, gX.id); await eligible(t3.id, sC.id, gX.id); await eligible(t1.id, sD.id, gY.id);
    const reqs = {
      A: await prisma.subjectRequirement.create({ data: { gradeId: gX.id, subjectId: sA.id, periodsPerWeek: 10 } }),
      B: await prisma.subjectRequirement.create({ data: { gradeId: gX.id, subjectId: sB.id, periodsPerWeek: 10 } }),
      C: await prisma.subjectRequirement.create({ data: { gradeId: gX.id, subjectId: sC.id, periodsPerWeek: 10 } }),
      D: await prisma.subjectRequirement.create({ data: { gradeId: gY.id, subjectId: sD.id, periodsPerWeek: 20 } }),
    };
    const assignments = {
      A: await prisma.sectionSubjectTeacher.create({ data: { sectionId: sX.id, subjectRequirementId: reqs.A.id, teacherId: t1.id } }),
      B: await prisma.sectionSubjectTeacher.create({ data: { sectionId: sX.id, subjectRequirementId: reqs.B.id, teacherId: t2.id } }),
      C: await prisma.sectionSubjectTeacher.create({ data: { sectionId: sX.id, subjectRequirementId: reqs.C.id, teacherId: t3.id } }),
      D: await prisma.sectionSubjectTeacher.create({ data: { sectionId: sY.id, subjectRequirementId: reqs.D.id, teacherId: t1.id } }),
    };
    const config = await prisma.scheduleConfig.create({ data: { academicYearId: year.id, periodsPerDay: 6, breakAfterPeriod: 3 } }); // the simplified schedule: no period rows, no clock times
    await prisma.scheduleDay.createMany({ data: WEEK5.map((dayOfWeek) => ({ scheduleConfigId: config.id, dayOfWeek: dayOfWeek as 'MONDAY' })) });
    return { yearId: year.id, sX, sY, sA, sB, sC, sD, t1, t2, t3, reqs, assignments };
  }
  type InfYear = Awaited<ReturnType<typeof seedLockInfeasibleYear>>;
  /** A DRAFT version made directly from rows: only the locked lessons (that is all a regeneration reads from its source). */
  async function sourceWithLocks(world: World, y: { yearId: string }, lessons: Array<{ sectionId: string; subjectId: string; teacherId: string; subjectRequirementId: string; dayOfWeek: string; periodNumber: number; source?: 'GENERATED' | 'MANUAL' }>): Promise<string> {
    const n = ((await prisma.timetableVersion.aggregate({ where: { academicYearId: y.yearId }, _max: { versionNumber: true } }))._max.versionNumber ?? 0) + 1;
    const v = await prisma.timetableVersion.create({ data: { schoolId: world.schoolId, academicYearId: y.yearId, versionNumber: n, solutionSource: 'BASELINE', solverStatus: 'UNKNOWN', weightsVersion: 'V1', inputHash: 'x', inputSnapshot: {}, metrics: {}, baselineMetrics: {} } });
    await prisma.timetableEntry.createMany({ data: lessons.map((l) => ({ versionId: v.id, ...l, dayOfWeek: l.dayOfWeek as 'MONDAY', isLocked: true, source: l.source ?? 'GENERATED' })) });
    return v.id;
  }
  const infLessons = (y: InfYear, withExtraLock: boolean) => {
    const slots: Array<[string, number]> = [];
    for (const d of WEEK5.slice(0, 4)) for (let k = 1; k <= 6; k++) slots.push([d, k]);
    const lessons = slots.slice(0, 20).map(([d, k]) => ({ sectionId: y.sY.id, subjectId: y.sD.id, teacherId: y.t1.id, subjectRequirementId: y.reqs.D.id, dayOfWeek: d, periodNumber: k }));
    if (withExtraLock) lessons.push({ sectionId: y.sX.id, subjectId: y.sB.id, teacherId: y.t2.id, subjectRequirementId: y.reqs.B.id, dayOfWeek: 'FRIDAY', periodNumber: 1 });
    return lessons;
  };

  try {
    // ===================================================================================================================
    section('1. The source version: every refusal, and the valid cases');
    const yA = await mkYear(worldA, 'src');
    const { v: v1, locked: lockedV1 } = await draftWithLocks(tokA, yA, 10);
    check('(setup) V1 is a DRAFT with 10 locked lessons, at least one of them MANUAL', lockedV1.length === 10 && lockedV1.some((e: any) => e.source === 'MANUAL'));
    {
      const yOther = await mkYear(worldA, 'src-other');
      const vOther = await generate(tokA, yOther);
      const yB = await mkYear(worldB, 'src-b');
      const vB = await generate(tokB, yB);
      // PUBLISHED and ARCHIVED sources
      const vPub = await generate(tokA, yA);
      const vNext = await generate(tokA, yA);
      const publish = (tok: string, v: string, rev: number, expected: string | null) => call('POST', `/api/timetable-versions/${v}/publish`, tok, { expectedRevision: rev, expectedPublishedVersionId: expected });
      check('(setup) publish one version, then another (the first becomes ARCHIVED)', (await publish(tokA, vPub, 1, null)).status === 200 && (await publish(tokA, vNext, 1, vPub)).status === 200 && (await getV(tokA, vPub)).status === 'ARCHIVED' && (await getV(tokA, vNext)).status === 'PUBLISHED');

      const runsBefore = await prisma.timetableGenerationRun.count({ where: { academicYearId: yA.yearId } });
      const versionsBeforeRefusals = await versionCount(yA.yearId);
      const entriesBeforeRefusals = await entryCount(yA.yearId);
      const refusals: Array<[string, Reply, number, string]> = [
        ['an unknown source version', await post(tokA, { academicYearId: yA.yearId, options: { sourceVersionId: UUID0 } }), 404, 'SOURCE_VERSION_NOT_FOUND'],
        ["another school's version", await post(tokA, { academicYearId: yA.yearId, options: { sourceVersionId: vB } }), 403, 'SOURCE_VERSION_FORBIDDEN'],
        ["a version of another academic year (same school)", await post(tokA, { academicYearId: yA.yearId, options: { sourceVersionId: vOther } }), 400, 'SOURCE_VERSION_WRONG_YEAR'],
        ['a PUBLISHED source', await post(tokA, { academicYearId: yA.yearId, options: { sourceVersionId: vNext } }), 409, 'SOURCE_VERSION_NOT_DRAFT'],
        ['an ARCHIVED source', await post(tokA, { academicYearId: yA.yearId, options: { sourceVersionId: vPub } }), 409, 'SOURCE_VERSION_NOT_DRAFT'],
      ];
      for (const [name, r, status, code] of refusals) {
        check(`${name}: ${status} ${code}, standard envelope`, r.status === status && r.body.success === false && r.body.data?.code === code, `${r.status} ${r.text.slice(0, 160)}`);
      }
      check('the foreign-school refusal reveals nothing about the foreign version', !refusals[1]![1].text.includes(vB) && !refusals[1]![1].text.includes(yB.yearId));
      const malformed = await post(tokA, { academicYearId: yA.yearId, options: { sourceVersionId: 'nope' } });
      check('a malformed sourceVersionId: 400 validation error', malformed.status === 400 && Object.keys(malformed.body.errors ?? {}).some((k) => k.startsWith('options.sourceVersionId')));
      const runsB = await prisma.timetableGenerationRun.count({ where: { academicYearId: yB.yearId } });
      const asB = await post(tokB, { academicYearId: yB.yearId, options: { sourceVersionId: v1 } });
      check("School B naming School A's draft as its source: 403 and nothing created", asB.status === 403 && (await prisma.timetableGenerationRun.count({ where: { academicYearId: yB.yearId } })) === runsB, `${asB.status} ${asB.text.slice(0, 120)}`);
      check('no refused request created a run, and the source is unchanged', (await prisma.timetableGenerationRun.count({ where: { academicYearId: yA.yearId } })) === runsBefore && (await getV(tokA, v1)).lockedCount === 10);
      check('no refused request created a version or entries either', (await versionCount(yA.yearId)) === versionsBeforeRefusals && (await entryCount(yA.yearId)) === entriesBeforeRefusals);
    }

    // ===================================================================================================================
    section('2. Freezing at POST: what is stored, canonical order, zero locks');
    {
      forwardTo = null; // keep the run QUEUED so its stored options can be inspected
      const r = await post(tokA, { academicYearId: yA.yearId, options: { sourceVersionId: v1, seed: 77 } });
      check('a valid DRAFT source: 202 with sourceVersionId and lockedEntryCount in the response', r.status === 202 && r.body.data.sourceVersionId === v1 && r.body.data.lockedEntryCount === 10 && r.body.data.status === 'QUEUED', r.text.slice(0, 200));
      const run = await getRun(r.body.data.generationRunId);
      const opts = run.options as { seed: number; reproducible: boolean; sourceVersionId: string; lockedEntries: Array<Record<string, unknown>> };
      check('the run stores seed, reproducible, the provenance and exactly 10 frozen locks', opts.seed === 77 && opts.reproducible === false && opts.sourceVersionId === v1 && opts.lockedEntries.length === 10);
      const keys = ['assignmentId', 'dayOfWeek', 'periodNumber', 'sectionId', 'subjectRequirementId', 'teacherId', 'source'].sort();
      check('each frozen lock has the contract fields (assignment, day, period) plus the verification fields and the source', opts.lockedEntries.every((l) => JSON.stringify(Object.keys(l).sort()) === JSON.stringify(keys)));
      const dayRank = new Map(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map((d, i) => [d, i]));
      const sortedOk = opts.lockedEntries.every((l, i, all) => i === 0 || (String(all[i - 1]!.assignmentId) < String(l.assignmentId)) || (all[i - 1]!.assignmentId === l.assignmentId && ((dayRank.get(String(all[i - 1]!.dayOfWeek)) ?? 0) < (dayRank.get(String(l.dayOfWeek)) ?? 0) || (all[i - 1]!.dayOfWeek === l.dayOfWeek && Number(all[i - 1]!.periodNumber) < Number(l.periodNumber)))));
      check('the frozen locks are canonically sorted (assignment id, day, period)', sortedOk);
      const assignmentOfEntry = new Map((await prisma.sectionSubjectTeacher.findMany({ where: { section: { grade: { academicYearId: yA.yearId } } } })).map((a) => [`${a.sectionId}|${a.subjectRequirementId}`, a.id]));
      check('each lock is the source lesson: same section, requirement, teacher, day, period and source, resolved to the right assignment', lockedV1.every((e: any) => opts.lockedEntries.some((l) => l.assignmentId === assignmentOfEntry.get(`${e.sectionId}|${e.subjectRequirementId}`) && l.sectionId === e.sectionId && l.subjectRequirementId === e.subjectRequirementId && l.teacherId === e.teacherId && l.dayOfWeek === e.dayOfWeek && l.periodNumber === e.periodNumber && l.source === e.source)));
      check('the run view reports sourceVersionId and lockedEntryCount but never the frozen list', await (async () => { const v = (await call('GET', `/api/timetable-generations/${run.id}`, tokA)).body.data; return v.sourceVersionId === v1 && v.lockedEntryCount === 10 && !JSON.stringify(v).includes('lockedEntries'); })());
      check('the source is not touched by the POST (revision, entries, locks identical)', (await getV(tokA, v1)).lockedCount === 10 && (await getV(tokA, v1)).status === 'DRAFT');
      const dup = await post(tokA, { academicYearId: yA.yearId, options: { sourceVersionId: v1 } });
      check('a second generation for the year while this one is active: 409 with the existing run (as always)', dup.status === 409 && dup.body.data?.existingRunId === run.id);
      await failQueuedRuns();

      // zero locks
      const yZ = await mkYear(worldA, 'zero');
      forwardTo = scripted; // the plain generation of the source needs the runner ...
      const vZ = await generate(tokA, yZ);
      forwardTo = null; // ... the regeneration below must stay QUEUED while its stored options are inspected
      const rz = await post(tokA, { academicYearId: yZ.yearId, options: { sourceVersionId: vZ } });
      check('a source with ZERO locks is accepted: lockedEntryCount 0', rz.status === 202 && rz.body.data.lockedEntryCount === 0 && rz.body.data.sourceVersionId === vZ);
      const rzRun = await getRun(rz.body.data.generationRunId);
      check('...and the stored locks are an empty list, the provenance is recorded', (rzRun.options as { lockedEntries: unknown[] }).lockedEntries.length === 0 && (rzRun.options as { sourceVersionId: string }).sourceVersionId === vZ);
      await failQueuedRuns();
      forwardTo = scripted;
      const rz2 = await post(tokA, { academicYearId: yZ.yearId, options: { sourceVersionId: vZ } });
      const doneZ = await waitTerminal(rz2.body.data.generationRunId, 90_000);
      const plainHash = (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: vZ } })).inputHash;
      const zeroHash = (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: doneZ.versionId! } })).inputHash;
      check('a zero-lock regeneration behaves like a plain one: same input hash as the source (no locks, same configuration), nothing locked', doneZ.status === 'SUCCEEDED' && zeroHash === plainHash && (await getV(tokA, doneZ.versionId!)).lockedCount === 0);
    }

    // ===================================================================================================================
    section('3. The freeze race: the source is changed AND deleted after the POST; the queued run keeps its locks');
    {
      const y = await mkYear(worldA, 'race');
      const { v, locked } = await draftWithLocks(tokA, y, 9);
      const before = new Set(locked.map(lockKey));
      forwardTo = null;
      const r = await post(tokA, { academicYearId: y.yearId, options: { sourceVersionId: v } });
      const runId: string = r.body.data.generationRunId;
      const frozenAtPost = ((await getRun(runId)).options as { lockedEntries: unknown[] }).lockedEntries;
      // 10:02: the admin unlocks everything, then moves a lesson, then deletes the whole draft
      const un = await lockEntries(tokA, v, locked.map((e: any) => e.id), false);
      check('(race) after the POST the admin UNLOCKS every lock of the source', un.status === 200 && (await getV(tokA, v)).lockedCount === 0);
      const delSource = await call('DELETE', `/api/timetable-versions/${v}`, tokA);
      check('(race) ...and then DELETES the source draft', delSource.status === 200 && (await prisma.timetableVersion.count({ where: { id: v } })) === 0);
      check('the frozen locks stored in the queued run did not change', JSON.stringify(((await getRun(runId)).options as { lockedEntries: unknown[] }).lockedEntries) === JSON.stringify(frozenAtPost));
      forwardTo = scripted;
      scripted.trigger();
      const run = await waitTerminal(runId, 120_000);
      check('the run completes SUCCEEDED although its source no longer exists', run.status === 'SUCCEEDED' && run.versionId !== null, `${run.status} ${run.failureCode}`);
      const v2 = await getV(tokA, run.versionId!);
      const kept = new Set(v2.entries.filter((e: any) => e.isLocked).map(lockKey));
      check('the new draft contains EVERY lock the source had at POST time, exactly (and no other lock)', kept.size === before.size && [...before].every((k) => kept.has(k)));
      const runView = (await call('GET', `/api/timetable-generations/${runId}`, tokA)).body.data;
      check('the run view still names the (now deleted) source as provenance and counts the locks', runView.sourceVersionId === v && runView.lockedEntryCount === 9 && runView.status === 'SUCCEEDED');
      check('the result summary carries lockedEntryCount, sourceVersionId and baselineAvailable', runView.result.lockedEntryCount === 9 && runView.result.sourceVersionId === v && typeof runView.result.baselineAvailable === 'boolean');
    }

    // ===================================================================================================================
    section('4. End to end: generate V1, lock, generate V2 from V1');
    {
      const y = await mkYear(worldA, 'e2e');
      const { v: src, locked } = await draftWithLocks(tokA, y, 12);
      const srcBefore = await fingerprintVersion(src);
      const srcDetail = await getV(tokA, src);
      const r = await post(tokA, { academicYearId: y.yearId, options: { sourceVersionId: src } });
      const run = await waitTerminal(r.body.data.generationRunId, 120_000);
      check('the regeneration SUCCEEDED and created a NEW draft', run.status === 'SUCCEEDED' && run.versionId !== null && run.versionId !== src, `${run.status} ${run.failureCode}`);
      const v2 = await getV(tokA, run.versionId!);
      check('V2 is the next version number, a DRAFT, revision 1', v2.versionNumber === srcDetail.versionNumber + 1 && v2.status === 'DRAFT' && v2.revision === 1);
      const v2Keys = new Map<string, any>(v2.entries.map((e: any) => [lockKey(e), e]));
      let allKept = true;
      let allLocked = true;
      let sourcesKept = true;
      for (const e of locked) {
        const copy = v2Keys.get(lockKey(e));
        if (!copy) { allKept = false; continue; }
        if (!copy.isLocked) allLocked = false;
        if (copy.source !== e.source) sourcesKept = false;
      }
      check('EVERY locked lesson of V1 is in V2 with the same section, requirement, teacher, day and period', allKept);
      check('...and is locked in V2 (isLocked = true preserved)', allLocked);
      check('...and keeps its original source (the MANUAL lesson stays MANUAL, GENERATED stays GENERATED)', sourcesKept && v2.entries.some((e: any) => e.isLocked && e.source === 'MANUAL'));
      check('V2 has exactly the 12 locks; every other lesson is unlocked (and GENERATED)', v2.lockedCount === 12 && v2.entries.filter((e: any) => !e.isLocked).every((e: any) => e.source === 'GENERATED'));
      check('V2 has the full set of lessons (36) with new database identities (no id is shared with V1)', v2.entries.length === 36 && v2.entries.every((e: any) => !srcDetail.entries.some((s: any) => s.id === e.id)));
      check('V1 is completely UNTOUCHED (revision, status, metrics, hash, every entry and its lock state)', (await fingerprintVersion(src)) === srcBefore);
      const val = (await call('GET', `/api/timetable-versions/${run.versionId}/validation`, tokA)).body.data;
      check('V2 validates: valid, current (not stale), publishable', val.valid === true && val.isStale === false && val.informational.publishable === true && val.metrics.weightsVersion === 'V1', JSON.stringify(val.informational));
      const row = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: run.versionId! } });
      const snapshotFixed = (row.inputSnapshot as { fixedEntries: unknown[] }).fixedEntries;
      const srcRow = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: src } });
      check('V2\'s stored snapshot records the 12 fixed entries; V1\'s has none; their input hashes differ but their configuration hash is the same', snapshotFixed.length === 12 && (srcRow.inputSnapshot as { fixedEntries: unknown[] }).fixedEntries.length === 0 && row.inputHash !== srcRow.inputHash && configurationHash(row.inputSnapshot as never) === configurationHash(srcRow.inputSnapshot as never));
      check('baselineMetrics is either the full metrics or the explicit unavailable marker (never zeros)', (row.baselineMetrics as { weightedObjective?: number; available?: boolean }).weightedObjective !== undefined ? typeof (row.baselineMetrics as { weightedObjective: number }).weightedObjective === 'number' && (row.baselineMetrics as { terms?: unknown }).terms !== undefined : (row.baselineMetrics as { available?: boolean }).available === false);
      check('the lock-aware baseline existed for this instance, so baselineMetrics holds real numbers', (row.baselineMetrics as { weightedObjective?: number }).weightedObjective !== undefined);
      const summary = (await getRun(run.id)).resultSummary as { lockedEntryCount: number; sourceVersionId: string; baselineAvailable: boolean; entryCount: number };
      check('the result summary: 12 locks, the source id, the baseline was available, 36 entries', summary.lockedEntryCount === 12 && summary.sourceVersionId === src && summary.baselineAvailable === true && summary.entryCount === 36);

      // D-E7: the new draft can be edited normally, including a lesson that was locked at generation
      const preserved = v2.entries.find((e: any) => e.isLocked)!;
      const unlock = await call('PUT', `/api/timetable-versions/${run.versionId}/locks`, tokA, { entryIds: [preserved.id], locked: false, expectedRevision: 1 });
      const slot = freeSlot(v2.entries, preserved);
      const moved = slot ? await call('POST', `/api/timetable-versions/${run.versionId}/moves`, tokA, { entryId: preserved.id, to: { dayOfWeek: slot[0], periodNumber: slot[1] }, expectedRevision: 2 }) : null;
      check('a lesson locked at generation can be UNLOCKED and then MOVED (the historical fixed entries do not block legitimate edits)', unlock.status === 200 && moved !== null && moved.status === 200, moved?.text.slice(0, 200));
      const after = (await call('GET', `/api/timetable-versions/${run.versionId}/validation`, tokA)).body.data;
      check('...and the edited V2 still validates and is publishable', after.valid === true && after.informational.publishable === true && after.violationCount === 0);
      const pub = await call('POST', `/api/timetable-versions/${run.versionId}/publish`, tokA, { expectedRevision: 3, expectedPublishedVersionId: null });
      check('...and can be published (fresh normalization has no locks; the staleness hash ignores them)', pub.status === 200 && (await getV(tokA, run.versionId!)).status === 'PUBLISHED', pub.text.slice(0, 200));
      check('the source V1 is still an untouched DRAFT after V2 was published', (await fingerprintVersion(src)) === srcBefore);
    }

    // ===================================================================================================================
    section('5. REAL CP-SAT with locks (real Python process)');
    {
      const real = makeRunner(new SubprocessSolverClient(resolveSolverClientConfig({}, {})), {}, 10);
      forwardTo = real;
      real.start();
      const y = await mkYear(worldA, 'real', TIGHT);
      const { v: src, locked } = await draftWithLocks(tokA, y, 14);
      const srcBefore = await fingerprintVersion(src);
      const r = await post(tokA, { academicYearId: y.yearId, options: { sourceVersionId: src, seed: 5 } });
      const run = await waitTerminal(r.body.data.generationRunId, 120_000);
      check('the real solver produced V2 from V1 with 14 locks', run.status === 'SUCCEEDED' && run.versionId !== null, `${run.status} ${run.failureCode}`);
      const v2 = await getV(tokA, run.versionId!);
      check('V2 came from CP-SAT (OPTIMAL or FEASIBLE) and contains every one of the 14 locks, locked, with their sources', v2.solutionSource === 'CP_SAT' && locked.every((e: any) => { const c = v2.entries.find((x: any) => lockKey(x) === lockKey(e)); return c && c.isLocked && c.source === e.source; }) && v2.lockedCount === 14, `${v2.solutionSource} ${v2.lockedCount}`);
      check('V2 has 87 lessons and validates (valid, current, publishable)', v2.entries.length === 87 && (await call('GET', `/api/timetable-versions/${run.versionId}/validation`, tokA)).body.data.informational.publishable === true);
      check('V1 is untouched by the real run too', (await fingerprintVersion(src)) === srcBefore);
      check('the run recorded the solver time limit and the locks in its summary', (await getRun(run.id)).resultSummary !== null && ((await getRun(run.id)).resultSummary as { lockedEntryCount: number }).lockedEntryCount === 14);
      forwardTo = scripted;
      await real.stop(10);
      check('no solver process remains', await waitFor(() => solverProcesses().length === 0, 8_000, 200));
    }

    // ===================================================================================================================
    section('6. Locks that do not fit: clear failures, no partial version, the source untouched');
    {
      // 6a: a teaching assignment changed BEFORE the POST -> 400 at the preflight
      const y = await mkYear(worldA, 'bad1');
      const { v: src, locked } = await draftWithLocks(tokA, y, 12);
      // the seeded spare teacher is eligible for subject 0 only: use an assignment of subject 0 that carries a lock
      const subj0Locked = locked.find((e: any) => e.subjectId === y.subjectIds[0]);
      const sourceBefore = await fingerprintVersion(src);
      const versionsBefore = await versionCount(y.yearId);
      const entriesBefore = await entryCount(y.yearId);
      if (!subj0Locked) throw new Error('fixture: no locked lesson of subject 0');
      const a0 = await prisma.sectionSubjectTeacher.findFirstOrThrow({ where: { sectionId: subj0Locked.sectionId, subjectRequirementId: subj0Locked.subjectRequirementId } });
      await prisma.sectionSubjectTeacher.update({ where: { id: a0.id }, data: { teacherId: y.spareTeacherId } });
      const r1 = await post(tokA, { academicYearId: y.yearId, options: { sourceVersionId: src } });
      check('a locked lesson whose teacher changed since: 400 LOCKS_INVALID at the preflight with LOCKED_ENTRY_TEACHER_CHANGED', r1.status === 400 && r1.body.data?.code === 'LOCKS_INVALID' && r1.body.data.issues.some((i: any) => i.code === 'LOCKED_ENTRY_TEACHER_CHANGED'), r1.text.slice(0, 300));
      check('...the issues are structured (code, message, entity, details) and bounded', r1.body.data.issues.every((i: any) => i.code && i.message && i.entity?.type === 'LOCKED_ENTRY') && r1.body.data.issues.length <= 50 && r1.body.data.issueCount >= 1);
      check('...no run was created', (await prisma.timetableGenerationRun.count({ where: { academicYearId: y.yearId, status: { in: ['QUEUED', 'RUNNING'] } } })) === 0);
      await prisma.sectionSubjectTeacher.update({ where: { id: a0.id }, data: { teacherId: a0.teacherId } });

      // 6b: the configuration changes AFTER the POST (while queued) -> the RUN fails with LOCKS_INVALID (authoritative validation)
      forwardTo = null;
      const r2 = await post(tokA, { academicYearId: y.yearId, options: { sourceVersionId: src } });
      check('(6b setup) the POST succeeds while the locks still fit', r2.status === 202);
      await prisma.sectionSubjectTeacher.update({ where: { id: a0.id }, data: { teacherId: y.spareTeacherId } });
      forwardTo = scripted;
      scripted.trigger();
      const run2 = await waitTerminal(r2.body.data.generationRunId, 90_000);
      const fail2 = (await call('GET', `/api/timetable-generations/${run2.id}`, tokA)).body.data;
      check('the run FAILED with LOCKS_INVALID, validated authoritatively against the fresh snapshot', run2.status === 'FAILED' && run2.failureCode === 'LOCKS_INVALID' && fail2.failure.code === 'LOCKS_INVALID', `${run2.status} ${run2.failureCode}`);
      check('...the failure diagnostics list the structured lock issue (LOCKED_ENTRY_TEACHER_CHANGED)', JSON.stringify(fail2.failure.diagnostics).includes('LOCKED_ENTRY_TEACHER_CHANGED'));
      check('...NO version and NO entries were created, the run has no version, and the source is untouched', (await versionCount(y.yearId)) === versionsBefore && (await entryCount(y.yearId)) === entriesBefore && run2.versionId === null && (await fingerprintVersion(src)) === sourceBefore);
      await prisma.sectionSubjectTeacher.update({ where: { id: a0.id }, data: { teacherId: a0.teacherId } });

      // 6c: an assignment deleted and recreated under a NEW id after the POST: not guessed (D-E1)
      forwardTo = null;
      const r3 = await post(tokA, { academicYearId: y.yearId, options: { sourceVersionId: src } });
      check('(6c setup) the POST succeeds', r3.status === 202);
      await prisma.$transaction(async (tx) => {
        await tx.sectionSubjectTeacher.delete({ where: { id: a0.id } });
        await tx.sectionSubjectTeacher.create({ data: { sectionId: a0.sectionId, subjectRequirementId: a0.subjectRequirementId, teacherId: a0.teacherId } });
      });
      forwardTo = scripted;
      scripted.trigger();
      const run3 = await waitTerminal(r3.body.data.generationRunId, 90_000);
      const diag3 = JSON.stringify((await getRun(run3.id)).failureDiagnostics);
      check('a recreated assignment (new id, same teacher) is NOT guessed: FAILED LOCKS_INVALID with LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND', run3.status === 'FAILED' && run3.failureCode === 'LOCKS_INVALID' && diag3.includes('LOCKED_ENTRY_ASSIGNMENT_NOT_FOUND'), `${run3.status} ${run3.failureCode}`);
      check('...and nothing was persisted', (await versionCount(y.yearId)) === versionsBefore && (await entryCount(y.yearId)) === entriesBefore);
      const r3b = await post(tokA, { academicYearId: y.yearId, options: { sourceVersionId: src } });
      check('the admin can simply start again: the POST now freezes the NEW assignment id and the run succeeds', r3b.status === 202 && (await waitTerminal(r3b.body.data.generationRunId, 90_000)).status === 'SUCCEEDED');

      // 6d: the schedule changed (periods removed) after the lock
      const y4 = await mkYear(worldA, 'bad4');
      const v4 = await generate(tokA, y4);
      const late = (await getV(tokA, v4)).entries.find((e: any) => e.periodNumber >= 5);
      if (!late) throw new Error('fixture: a lesson in period 5 or 6');
      check('(6d setup) a lesson in period >= 5 is locked in the source', (await lockEntries(tokA, v4, [late.id])).status === 200);
      const cfg = await prisma.scheduleConfig.findUniqueOrThrow({ where: { academicYearId: y4.yearId } });
      await prisma.$transaction(async (tx) => {
        await tx.scheduleConfig.update({ where: { id: cfg.id }, data: { periodsPerDay: 4 } }); // 6 -> 4 teaching periods (the break after period 3 is still valid)
      });
      const r4 = await post(tokA, { academicYearId: y4.yearId, options: { sourceVersionId: v4 } });
      check('a locked lesson in a period that no longer exists: 400 LOCKS_INVALID with LOCKED_ENTRY_INVALID_PERIOD', r4.status === 400 && r4.body.data?.code === 'LOCKS_INVALID' && r4.body.data.issues.some((i: any) => i.code === 'LOCKED_ENTRY_INVALID_PERIOD'), `${r4.status} ${r4.text.slice(0, 240)}`);

      // 6e: locks that are individually valid but make the timetable IMPOSSIBLE: CP-SAT proves it, there is no baseline
      const inf = await seedLockInfeasibleYear(worldA);
      const srcInf = await sourceWithLocks(worldA, inf, infLessons(inf, true));
      const real = makeRunner(new SubprocessSolverClient(resolveSolverClientConfig({}, {})), {}, 10);
      forwardTo = real;
      real.start();
      const rInf = await post(tokA, { academicYearId: inf.yearId, options: { sourceVersionId: srcInf } });
      check('(6e) the locks pass the preflight (each is fine, pairwise consistent)', rInf.status === 202 && rInf.body.data.lockedEntryCount === 21, rInf.text.slice(0, 200));
      const runInf = await waitTerminal(rInf.body.data.generationRunId, 120_000);
      const infView = (await call('GET', `/api/timetable-generations/${runInf.id}`, tokA)).body.data;
      check('the REAL solver proves the lock set impossible: FAILED INFEASIBLE_HARD_CONSTRAINTS (not NO_SOLUTION_WITH_LOCKS)', runInf.status === 'FAILED' && runInf.failureCode === 'INFEASIBLE_HARD_CONSTRAINTS' && /locked/i.test(infView.failure.message), `${runInf.status} ${runInf.failureCode} ${infView.failure?.message}`);
      check('...no version, no entries, the run has no version, the source draft is untouched', (await prisma.timetableVersion.count({ where: { academicYearId: inf.yearId } })) === 1 && (await prisma.timetableEntry.count({ where: { version: { academicYearId: inf.yearId, id: { not: srcInf } } } })) === 0 && runInf.versionId === null);
      forwardTo = scripted;
      await real.stop(10);
      check('no solver process remains', await waitFor(() => solverProcesses().length === 0, 8_000, 200));
    }

    // ===================================================================================================================
    section('7. The outcome matrix through the real runner (scripted solver, lock-aware baseline)');
    {
      const inf = await seedLockInfeasibleYear(worldA);
      const srcFeasible = await sourceWithLocks(worldA, inf, infLessons(inf, false)); // a lock-aware baseline EXISTS for this one
      const srcImpossible = await sourceWithLocks(worldA, inf, infLessons(inf, true)); // none exists, and no timetable exists at all
      const run = async (solver: ScriptedSolver, source: string, extra: Partial<ConstructorParameters<typeof GenerationRunner>[0]> = {}) => {
        const rn = makeRunner(solver, extra);
        forwardTo = rn;
        rn.start();
        const r = await post(tokA, { academicYearId: inf.yearId, options: { sourceVersionId: source } });
        if (r.status !== 202) throw new Error(`POST refused: ${r.text}`);
        const done = await waitTerminal(r.body.data.generationRunId, 90_000);
        forwardTo = scripted;
        await rn.stop(5);
        return done;
      };
      const countBefore = await prisma.timetableVersion.count({ where: { academicYearId: inf.yearId } });

      // UNKNOWN + a valid lock-aware baseline -> the baseline, with the locks
      const u1 = await run(new ScriptedSolver(() => noSolution()), srcFeasible);
      const u1v = u1.versionId ? await getV(tokA, u1.versionId) : null;
      check('UNKNOWN + a valid lock-aware baseline: SUCCEEDED with the BASELINE and every lock kept', u1.status === 'SUCCEEDED' && u1v?.solutionSource === 'BASELINE' && u1v?.solverStatus === 'UNKNOWN' && infLessons(inf, false).length === 20 && infLessons(inf, false).every((l) => u1v.entries.some((e: any) => lockKey(e) === `${l.sectionId}|${l.subjectRequirementId}|${l.teacherId}|${l.dayOfWeek}|${l.periodNumber}` && e.isLocked)), `${u1.status} ${u1.failureCode}`);
      check('...fallbackReason NO_SOLUTION_WITHIN_BUDGET and the baseline metrics are real numbers', ((await getRun(u1.id)).resultSummary as { fallbackReason: string }).fallbackReason === 'NO_SOLUTION_WITHIN_BUDGET' && ((await prisma.timetableVersion.findUniqueOrThrow({ where: { id: u1.versionId! } })).baselineMetrics as { weightedObjective?: number }).weightedObjective !== undefined);
      const u2 = await run(new ScriptedSolver(() => watchdog()), srcFeasible);
      check('watchdog kill + a valid lock-aware baseline: SUCCEEDED with the BASELINE (KILLED_BY_WATCHDOG)', u2.status === 'SUCCEEDED' && ((await getRun(u2.id)).resultSummary as { fallbackReason: string }).fallbackReason === 'KILLED_BY_WATCHDOG');

      // UNKNOWN / watchdog with NO baseline -> NO_SOLUTION_WITH_LOCKS
      const n1 = await run(new ScriptedSolver(() => noSolution()), srcImpossible);
      const n1v = (await call('GET', `/api/timetable-generations/${n1.id}`, tokA)).body.data;
      check('UNKNOWN + NO lock-aware baseline: FAILED NO_SOLUTION_WITH_LOCKS, and the message says it is not a proof', n1.status === 'FAILED' && n1.failureCode === 'NO_SOLUTION_WITH_LOCKS' && /not prove|does not prove/i.test(n1v.failure.message), `${n1.status} ${n1.failureCode}`);
      const n2 = await run(new ScriptedSolver(() => watchdog()), srcImpossible);
      check('watchdog kill + NO baseline: FAILED NO_SOLUTION_WITH_LOCKS', n2.status === 'FAILED' && n2.failureCode === 'NO_SOLUTION_WITH_LOCKS');
      // INFEASIBLE
      const i1 = await run(new ScriptedSolver(() => ({ attempt: { kind: 'INFEASIBLE', diagnostics: { objectiveValue: null, bestObjectiveBound: null, wallSeconds: 0, numWorkers: 1, seed: 1, ortoolsVersion: 'x', numBooleans: null, numConstraints: null, conflicts: null, branches: null, stoppedBy: 'INFEASIBLE', messages: [] } }, info: noSolution().info })), srcImpossible);
      check('INFEASIBLE + NO baseline: FAILED INFEASIBLE_HARD_CONSTRAINTS (never NO_SOLUTION_WITH_LOCKS)', i1.status === 'FAILED' && i1.failureCode === 'INFEASIBLE_HARD_CONSTRAINTS');
      const i2 = await run(new ScriptedSolver(() => ({ attempt: { kind: 'INFEASIBLE', diagnostics: { objectiveValue: null, bestObjectiveBound: null, wallSeconds: 0, numWorkers: 1, seed: 1, ortoolsVersion: 'x', numBooleans: null, numConstraints: null, conflicts: null, branches: null, stoppedBy: 'INFEASIBLE', messages: [] } }, info: noSolution().info })), srcFeasible);
      check('INFEASIBLE + a valid baseline: FAILED INTERNAL_INCONSISTENCY (the baseline contradicts the solver), as without locks', i2.status === 'FAILED' && i2.failureCode === 'INTERNAL_INCONSISTENCY');
      // solver faults keep their meaning
      const f1 = await run(new ScriptedSolver(() => ({ attempt: { kind: 'PROCESS_FAULT', code: 'SOLVER_CRASHED', message: 'simulated' }, info: noSolution().info })), srcImpossible);
      check('a crashed solver with locks and no baseline: FAILED SOLVER_CRASHED (existing semantics, no fallback)', f1.status === 'FAILED' && f1.failureCode === 'SOLVER_CRASHED');
      // a solver result that VIOLATES a lock is never persisted
      const violating = new ScriptedSolver((ctx) => { const r = buildBaselineWithFixed({ ...ctx.problem, core: { ...ctx.problem.core, fixedEntries: [] } }, 3); if (!r.ok) throw new Error('fixture'); return solution(ctx.problem, 'FEASIBLE', { entries: r.entries }); });
      const bad = await run(violating, srcFeasible);
      check('a solver timetable that ignores the locks is rejected by the authoritative validation: FAILED, nothing persisted', bad.status === 'FAILED' && bad.versionId === null && ['INTERNAL_INCONSISTENCY', 'SOLVER_INVALID_OUTPUT'].includes(bad.failureCode ?? ''), `${bad.status} ${bad.failureCode}`);
      // an INVALID lock-aware baseline is discarded (D-E3): the run continues with CP-SAT
      const invalidBaseline = (problem: Parameters<typeof buildBaselineWithFixed>[0]) => {
        const r = buildBaselineWithFixed({ ...problem, core: { ...problem.core, fixedEntries: [] } }, 9);
        if (!r.ok) throw new Error('fixture');
        return { ok: true as const, entries: r.entries, attempts: 1 };
      };
      const d1 = await run(new ScriptedSolver(lockAware), srcFeasible, { buildBaselineWithFixed: invalidBaseline });
      const d1v = d1.versionId ? await prisma.timetableVersion.findUniqueOrThrow({ where: { id: d1.versionId } }) : null;
      check('an INVALID lock-aware baseline is DISCARDED: the run continues with CP-SAT and SUCCEEDS from CP_SAT', d1.status === 'SUCCEEDED' && d1v?.solutionSource === 'CP_SAT', `${d1.status} ${d1.failureCode}`);
      check('...baselineMetrics says {available: false, reason: BASELINE_REJECTED} (no fabricated numbers) and the summary carries the warning', sameJson(d1v?.baselineMetrics, { available: false, reason: 'BASELINE_REJECTED' }) && JSON.stringify(((await getRun(d1.id)).resultSummary as { warnings: string[] }).warnings).includes('LOCK_AWARE_BASELINE_REJECTED_BY_VALIDATION') && ((await getRun(d1.id)).resultSummary as { baselineAvailable: boolean }).baselineAvailable === false);
      const d2 = await run(new ScriptedSolver(() => noSolution()), srcFeasible, { buildBaselineWithFixed: invalidBaseline });
      check('an invalid baseline + UNKNOWN: it was discarded, so there is no baseline: FAILED NO_SOLUTION_WITH_LOCKS (the invalid timetable is never used)', d2.status === 'FAILED' && d2.failureCode === 'NO_SOLUTION_WITH_LOCKS' && d2.versionId === null);
      // CP-SAT works without a baseline: a solution is persisted with the explicit marker
      const noBaselineOk = await run(new ScriptedSolver(lockAware), srcFeasible, { buildBaselineWithFixed: () => ({ ok: false as const, reason: 'NO_PLACEMENT_FOUND' as const, attempts: 40 }) });
      const nbRow = noBaselineOk.versionId ? await prisma.timetableVersion.findUniqueOrThrow({ where: { id: noBaselineOk.versionId } }) : null;
      check('no lock-aware baseline + a CP-SAT solution: SUCCEEDED, baselineMetrics = {available: false, reason: NO_LOCK_AWARE_BASELINE}', noBaselineOk.status === 'SUCCEEDED' && sameJson(nbRow?.baselineMetrics, { available: false, reason: 'NO_LOCK_AWARE_BASELINE' }));
      check('...and that version\'s API view carries the marker without breaking (metrics are real)', await (async () => { const d = await getV(tokA, noBaselineOk.versionId!); return d.baselineMetrics.available === false && typeof d.metrics.weightedObjective === 'number'; })());
      const produced = await prisma.timetableVersion.count({ where: { academicYearId: inf.yearId } });
      check('exactly the successful runs created versions (the failed ones created none)', produced - countBefore === 4, `${produced - countBefore}`);

      // a configuration change DURING the run (the hash covers the locks, the persist re-normalizes with them). A timing event (a break after
      // period 5) changes the grid, hence the input hash, and leaves every lock valid: only the Phase 5 protection can catch it.
      const y = await mkYear(worldA, 'cfg');
      const { v: src } = await draftWithLocks(tokA, y, 10);
      const cfgRow = await prisma.scheduleConfig.findUniqueOrThrow({ where: { academicYearId: y.yearId } });
      const versionsBefore = await versionCount(y.yearId);
      const racer = new ScriptedSolver(async (ctx) => {
        await prisma.scheduleConfig.update({ where: { id: cfgRow.id }, data: { breakAfterPeriod: 5 } }); // the school moves the break while the solver works: the grid (continuesIntoNext), hence the input hash, changes
        return lockAware(ctx);
      });
      const rn = makeRunner(racer);
      forwardTo = rn;
      rn.start();
      const r = await post(tokA, { academicYearId: y.yearId, options: { sourceVersionId: src } });
      const done = await waitTerminal(r.body.data.generationRunId, 90_000);
      forwardTo = scripted;
      await rn.stop(5);
      check('a configuration change while the locked run is solving: FAILED CONFIGURATION_CHANGED (Phase 5 protection), nothing persisted', done.status === 'FAILED' && done.failureCode === 'CONFIGURATION_CHANGED' && (await versionCount(y.yearId)) === versionsBefore && done.versionId === null, `${done.status} ${done.failureCode}`);
      check('no solver process remains', solverProcesses().length === 0);
    }

    // ===================================================================================================================
    section('8. A consistent frozen snapshot while the source is edited concurrently');
    {
      const y = await mkYear(worldA, 'snap');
      const v = await generate(tokA, y);
      const d = await getV(tokA, v);
      const setX = d.entries.slice(0, 6).map((e: any) => e.id);
      const setY = d.entries.slice(12, 18).map((e: any) => e.id);
      const both = [...setX, ...setY];
      await prisma.$executeRaw`UPDATE "timetable_entries" SET "isLocked" = ("id" = ANY(${setX})) WHERE "id" = ANY(${both})`;
      const keysOf = (ids: string[]) => new Set<string>(d.entries.filter((e: any) => ids.includes(e.id)).map(lockKey));
      const X = keysOf(setX);
      const Y = keysOf(setY);
      let stop = false;
      let toggles = 0;
      const toggler = (async () => {
        let toY = true;
        while (!stop) {
          const target = toY ? setY : setX;
          // ONE statement flips 12 rows: set X, or set Y, is locked, never a mix (an atomic state change by an admin)
          await prisma.$executeRaw`UPDATE "timetable_entries" SET "isLocked" = ("id" = ANY(${target})) WHERE "id" = ANY(${both})`;
          toY = !toY;
          toggles++;
        }
      })();
      forwardTo = null;
      const seen: string[] = [];
      for (let i = 0; i < 12; i++) {
        const r = await post(tokA, { academicYearId: y.yearId, options: { sourceVersionId: v } });
        if (r.status !== 202) { seen.push(`REFUSED ${r.status} ${r.text.slice(0, 120)}`); continue; }
        const frozen = ((await getRun(r.body.data.generationRunId)).options as { lockedEntries: Array<{ sectionId: string; subjectRequirementId: string; teacherId: string; dayOfWeek: string; periodNumber: number }> }).lockedEntries;
        const keys = new Set(frozen.map(lockKey));
        const isSet = (S: Set<string>) => keys.size === S.size && [...S].every((k) => keys.has(k));
        seen.push(isSet(X) ? 'X' : isSet(Y) ? 'Y' : `MIXED(${keys.size})`);
        await failQueuedRuns();
      }
      stop = true;
      await toggler;
      check(`12 POSTs while an admin flips the lock set between X and Y ${toggles} times: every frozen set is exactly X or exactly Y, never a mix (${seen.join(',')})`, seen.length === 12 && seen.every((s) => s === 'X' || s === 'Y'), seen.join(','));
      check(`...the flipping really ran during the POSTs (${toggles} atomic flips)`, toggles >= 10, String(toggles));
      forwardTo = scripted;
    }

    // ===================================================================================================================
    section('9. Crash and recovery with frozen locks (real kill -9, another runner finishes the run)');
    {
      const y = await mkYear(worldA, 'crash');
      const { v: src, locked } = await draftWithLocks(tokA, y, 10);
      forwardTo = null;
      const r = await post(tokA, { academicYearId: y.yearId, options: { sourceVersionId: src } });
      const runId: string = r.body.data.generationRunId;
      const ready = path.join(tmp, 'ready');
      const child = spawn(process.execPath, ['--import', 'tsx', WORKER], { cwd: REPO_ROOT, env: { ...process.env, NODE_ENV: 'production', HOLD_AT: 'phase:BASELINE', READY_FILE: ready, SOLVER: 'fake:echo', RUNNER_CONFIG: '{}' }, stdio: 'ignore' });
      workers.push(child);
      const reached = await waitFor(() => existsSync(ready), 90_000, 100);
      const mid = await getRun(runId);
      check('a worker process claimed the run and froze at the start of the BASELINE phase (the last recorded phase is NORMALIZE; attempt 1)', reached && mid.status === 'RUNNING' && mid.attempts === 1 && mid.phase === 'NORMALIZE', `${mid.status} ${mid.phase}`);
      child.kill('SIGKILL');
      await new Promise((res) => child.once('exit', res));
      // while the run is orphaned, the source is changed and deleted: recovery must not need it
      await call('PUT', `/api/timetable-versions/${src}/locks`, tokA, { entryIds: locked.map((e: any) => e.id), locked: false, expectedRevision: (await getV(tokA, src)).revision });
      await call('DELETE', `/api/timetable-versions/${src}`, tokA);
      check('(the dead worker\'s run is orphaned; meanwhile the source was unlocked and deleted)', (await prisma.timetableVersion.count({ where: { id: src } })) === 0 && (await getRun(runId)).status === 'RUNNING');
      const recovery = makeRunner(new ScriptedSolver(lockAware));
      forwardTo = recovery;
      recovery.start();
      const done = await waitTerminal(runId, 120_000);
      forwardTo = scripted;
      await recovery.stop(5);
      check('another runner recovered the run (attempt 2) and completed it', done.status === 'SUCCEEDED' && done.attempts === 2 && recovery.stats.recoveredRequeued >= 1, `${done.status} attempts=${done.attempts}`);
      const v2 = await getV(tokA, done.versionId!);
      check('the recovered run still preserved every frozen lock (the source was gone: nothing was re-read)', locked.every((e: any) => v2.entries.some((x: any) => lockKey(x) === lockKey(e) && x.isLocked)) && v2.lockedCount === 10);
      check('exactly ONE version exists for the year (the new draft; the source was deleted) and exactly one run produced it', (await prisma.timetableVersion.count({ where: { academicYearId: y.yearId } })) === 1 && (await prisma.timetableGenerationRun.count({ where: { academicYearId: y.yearId, versionId: { not: null } } })) === 1);
      check('the dead worker process is gone', !alive(child.pid));

      // two generations: a second request for the year while one is active
      const yD = await mkYear(worldA, 'dup');
      forwardTo = scripted;
      const { v: srcD } = await draftWithLocks(tokA, yD, 8);
      forwardTo = null;
      const first = await post(tokA, { academicYearId: yD.yearId, options: { sourceVersionId: srcD } });
      const second = await post(tokA, { academicYearId: yD.yearId, options: { sourceVersionId: srcD } });
      check('two generations for one year: the second is 409 (the existing rule), only one run is active, and the second froze nothing', first.status === 202 && second.status === 409 && (await prisma.timetableGenerationRun.count({ where: { academicYearId: yD.yearId, status: { in: ['QUEUED', 'RUNNING'] } } })) === 1);
      await failQueuedRuns();
      forwardTo = scripted;
    }

    // ===================================================================================================================
    section('10. The plain (no-source) generation is exactly what it was');
    {
      const y = await mkYear(worldA, 'plain');
      forwardTo = null;
      const r = await post(tokA, { academicYearId: y.yearId });
      check('the 202 response has exactly its Phase 6 fields (no lock fields)', r.status === 202 && JSON.stringify(Object.keys(r.body.data).sort()) === JSON.stringify(['academicYearId', 'generationRunId', 'reproducible', 'sectionCount', 'seed', 'status', 'timeLimitSeconds']));
      const run = await getRun(r.body.data.generationRunId);
      check('the stored options are exactly {seed, reproducible}: no lockedEntries, no sourceVersionId', JSON.stringify(Object.keys(run.options as object).sort()) === '["reproducible","seed"]');
      forwardTo = scripted;
      scripted.trigger();
      const done = await waitTerminal(run.id, 90_000);
      const row = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: done.versionId! } });
      const plainSummary = (await getRun(run.id)).resultSummary as object;
      check('the result summary has none of the lock keys', done.status === 'SUCCEEDED' && !['sourceVersionId', 'lockedEntryCount', 'baselineAvailable'].some((k) => k in plainSummary));
      check('fixedEntries stay empty in the stored snapshot and the baseline metrics are the full metrics', (row.inputSnapshot as { fixedEntries: unknown[] }).fixedEntries.length === 0 && (row.baselineMetrics as { weightedObjective?: number }).weightedObjective !== undefined && !('available' in (row.baselineMetrics as object)));
      const snapshot = await loadGenerationSnapshot(rawPrisma, worldA.schoolId, y.yearId);
      const plain = normalizeProblem(snapshot);
      check('the plain normalization of the same configuration hashes to the stored input hash', plain.ok && plain.problem.inputHash === row.inputHash);
      const d = await getV(tokA, done.versionId!);
      check('nothing is locked in a plain generation, and every lesson is GENERATED', d.lockedCount === 0 && d.entries.every((e: any) => e.source === 'GENERATED' && e.isLocked === false));
      const view = (await call('GET', `/api/timetable-generations/${run.id}`, tokA)).body.data;
      check('the run view reports sourceVersionId null and lockedEntryCount 0', view.sourceVersionId === null && view.lockedEntryCount === 0);
    }

    // ===================================================================================================================
    section('11. Swagger');
    {
      const spec = app.swagger() as any;
      const postOp = spec.paths['/api/timetable-generations'].post;
      const opts = postOp.requestBody.content['application/json'].schema.properties.options;
      check('POST documents options.sourceVersionId (uuid) and still only seed, reproducible, sourceVersionId', JSON.stringify(Object.keys(opts.properties).sort()) === '["reproducible","seed","sourceVersionId"]' && opts.properties.sourceVersionId.format === 'uuid' && opts.additionalProperties === false);
      check('the description explains the freezing, the failure codes and the baseline caveat', /frozen/.test(postOp.description) && /LOCKS_INVALID/.test(postOp.description) && /NO_SOLUTION_WITH_LOCKS/.test(postOp.description) && /best-effort/.test(postOp.description));
      const view = spec.paths['/api/timetable-generations/{id}'].get.responses['200'].content['application/json'].schema.properties.data.properties;
      check('the run view documents sourceVersionId, lockedEntryCount and 16 failure codes (15 through 7E + DRAFT_LIMIT_REACHED from 7F-0)', !!view.sourceVersionId && !!view.lockedEntryCount && view.failure.properties.code.enum.length === 16 && view.failure.properties.code.enum.includes('LOCKS_INVALID') && view.failure.properties.code.enum.includes('NO_SOLUTION_WITH_LOCKS'));
      const acc = postOp.responses['202'].content['application/json'].schema.properties.data.properties;
      check('the 202 documents the two optional lock fields', !!acc.sourceVersionId && !!acc.lockedEntryCount);
      check('the POST still documents 400, 401, 403, 404, 409 and 503', ['400', '401', '403', '404', '409', '503'].every((c) => postOp.responses[c]));
      const ids = Object.values<any>(spec.paths).flatMap((p) => Object.values<any>(p)).map((o) => o.operationId).filter(Boolean);
      check('operation ids are still unique and no operation was added (7E adds no endpoint)', new Set(ids).size === ids.length && ids.length >= 10);
    }
  } finally {
    section('12. Cleanup and proof that nothing existing changed, nothing is left running');
    forwardTo = null;
    registerGenerationRunner(null);
    for (const w of workers) if (alive(w.pid)) w.kill('SIGKILL');
    for (const r of runners) { try { await r.stop(5); } catch { /* already stopped */ } }
    await app.close();
    await new Promise((r) => setTimeout(r, 1_000));
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    let deleted = 0;
    for (const w of worlds) deleted += await destroyWorld(w);
    check('exactly the two test schools were deleted (cascade)', deleted === 2, String(deleted));
    check('the new tables are back to their starting counts (no run, version or entry left)', JSON.stringify(await newTableCounts()) === JSON.stringify(newBefore), JSON.stringify(await newTableCounts()));
    const after = await fingerprint();
    const unchanged = EXISTING_TABLES.filter((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h);
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, unchanged.length === EXISTING_TABLES.length, EXISTING_TABLES.filter((t) => !unchanged.includes(t)).join(','));
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11LK_' } } })) === 0);
    check('no solver or worker process remains', solverProcesses().length === 0 && workers.every((w) => !alive(w.pid)), solverProcesses().join(' | '));
    rmSync(tmp, { recursive: true, force: true });
  }
}

main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
