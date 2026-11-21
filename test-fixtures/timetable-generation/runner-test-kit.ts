// Shared kit for the Phase 5 runner tests: real-PostgreSQL seeding, a scripted solver, cleanup with proof.
// Test code only; nothing in the application imports this file.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import rawPrismaClient from '../../src/config/database.js';
import { buildBaseline } from '../../src/modules/timetable-generation/timetable-generation.baseline.js';
import { evaluateMetrics } from '../../src/modules/timetable-generation/timetable-generation.metrics.js';
import { type SolverDiagnostics, type SolverInput, type TimetableEntryRow } from '../../src/modules/timetable-generation/timetable-generation.contracts.js';
import { type NormalizedProblem } from '../../src/modules/timetable-generation/timetable-generation.normalizer.js';
import { type RunnerConfig } from '../../src/modules/timetable-generation/timetable-generation.runner-config.js';
import { RunRepository, type RunRecord } from '../../src/modules/timetable-generation/timetable-generation.run-repository.js';
import { SolverAbortedError, type SolverClient, type SolverClientResult, type SolverRunInfo, type SolveOptions, type SolverRequest } from '../../src/modules/timetable-generation/timetable-generation.solver-client.js';
import { type Logger } from '../../src/modules/timetable-generation/timetable-generation.orchestrator.js';
import type { SolverAttempt } from '../../src/modules/timetable-generation/timetable-generation.outcome.js';

/** The unwrapped client: hand THIS to the code under test (runner, repository, persistence) so its real behaviour is exercised. */
export const rawPrisma = rawPrismaClient;
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The tests' OWN queries go through a client that retries READS after a dropped database connection (a known Neon behaviour),
// so a network hiccup is not reported as a product failure. Writes are never retried (a retry could duplicate them).
const DROPPED = /Connection terminated|ECONNRESET|ETIMEDOUT|EADDRNOTAVAIL|ENETUNREACH|EHOSTUNREACH|EPIPE|Server has closed the connection|terminating connection/i;
const READS = /^(find|count|aggregate|groupBy|\$queryRaw)/;
export const infraRetries = { count: 0 };
export const prisma = rawPrismaClient.$extends({
  query: {
    async $allOperations({ operation, args, query }) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await query(args);
        } catch (error) {
          const text = `${(error as Error)?.message ?? error} ${JSON.stringify((error as { meta?: unknown })?.meta ?? {})}`;
          if (attempt >= 3 || !READS.test(operation) || !DROPPED.test(text)) throw error;
          infraRetries.count++;
          await sleep(300 * (attempt + 1));
        }
      }
    },
  },
});

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 50): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return true;
    await sleep(stepMs);
  }
  return cond();
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshots of the pre-existing tables (counts + content fingerprints) to prove tests change nothing that existed
// ---------------------------------------------------------------------------------------------------------------
export const EXISTING_TABLES = [
  'academic_years', 'admin_sessions', 'admins', 'grades', 'schedule_configs', 'schedule_days', 'schedule_periods', 'schedule_timing_events',
  'schools', 'section_subject_teachers', 'sections', 'streams', 'subject_requirements', 'subjects', 'teacher_subject_grades', 'teacher_subjects', 'teachers',
] as const;
export const NEW_TABLES = ['timetable_versions', 'timetable_entries', 'timetable_generation_runs'] as const;

export async function fingerprint(): Promise<Record<string, { n: number; h: string }>> {
  const out: Record<string, { n: number; h: string }> = {};
  for (const t of EXISTING_TABLES) {
    const r = await prisma.$queryRawUnsafe<Array<{ n: bigint; h: string }>>(`SELECT count(*) AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY id), '')) AS h FROM "${t}" x`);
    out[t] = { n: Number(r[0]!.n), h: r[0]!.h };
  }
  return out;
}
export async function newTableCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of NEW_TABLES) out[t] = Number((await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM "${t}"`))[0]!.n);
  return out;
}

/** Refuse to run when real work is in the queue: a runner under test claims ANY queued run. */
export async function assertQueueIsEmpty(): Promise<void> {
  const n = Number((await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "timetable_generation_runs" WHERE "status" IN ('QUEUED','RUNNING')`)[0]!.n);
  if (n !== 0) throw new Error(`Refusing to run: ${n} QUEUED/RUNNING generation runs exist that this test did not create`);
}

// ---------------------------------------------------------------------------------------------------------------
// A throw-away school with a fully configured, READY academic year
// ---------------------------------------------------------------------------------------------------------------
export interface World {
  schoolId: string;
  code: string;
  adminId: string;
}

export async function createWorld(prefix: string): Promise<World> {
  const code = `${prefix}_${Date.now()}`;
  const school = await prisma.school.create({ data: { name: `${prefix} test school`, code } });
  const admin = await prisma.admin.create({ data: { schoolId: school.id, name: 'Test admin', email: `admin-${Date.now()}@test.local`, passwordHash: 'x' } });
  return { schoolId: school.id, code, adminId: admin.id };
}

export async function destroyWorld(world: World): Promise<number> {
  const r = await prisma.school.deleteMany({ where: { id: world.schoolId, code: world.code } });
  return r.count;
}

export interface SeededYear {
  yearId: string;
  gradeId: string;
  configId: string;
  sectionIds: string[];
  subjectIds: string[];
  teacherIds: string[];
  spareTeacherId: string;
  requirementIds: string[];
  assignmentIds: string[];
  /** TeacherSubjectGrade rows of the assigned teachers (one per subject). */
  eligibilityIds: string[];
  spareEligibilityId: string;
  subjectPeriods: number[];
}

export interface SeedOptions {
  sections?: number;
  days?: number;
  periodsPerDay?: number;
  /** Subject periods per week; one teacher per subject. */
  subjects?: number[];
  /** Period numbers followed by a break. One entry = the simplified single break; several = a legacy configuration. Default [3]. */
  breakAfter?: number[];
  /** Build a legacy (pre-simplification) configuration with clock times, even with a single break. */
  legacy?: boolean;
}

const WEEK = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;

/**
 * Seeding is dozens of sequential writes over a remote database; a dropped connection or a pool timeout (both seen on Neon) must
 * not be reported as a product failure. A failed attempt is simply repeated with a NEW year: whatever the failed attempt left
 * behind belongs to the test school and disappears with it (cascade).
 */
export async function seedYear(world: World, tag: string, o: SeedOptions = {}): Promise<SeededYear> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await seedYearOnce(world, tag, o);
    } catch (error) {
      const text = `${(error as Error)?.message ?? error}`;
      if (attempt >= 3 || !/timed out|Connection terminated|ECONNRESET|ETIMEDOUT|EADDRNOTAVAIL|ENETUNREACH|EHOSTUNREACH|EPIPE|Server has closed the connection|terminating connection|Can't reach database/i.test(text)) throw error;
      infraRetries.count++;
      await sleep(1_000 * attempt);
    }
  }
}

async function seedYearOnce(world: World, tag: string, o: SeedOptions = {}): Promise<SeededYear> {
  const nSections = o.sections ?? 3;
  const days = o.days ?? 5;
  const ppd = o.periodsPerDay ?? 6;
  const subjectPeriods = o.subjects ?? [5, 4, 3];
  const breakAfter = o.breakAfter ?? [3];
  const uniq = randomUUID().slice(0, 8);
  const { schoolId } = world;

  const year = await prisma.academicYear.create({ data: { schoolId, name: `${tag}-${uniq}`, startDate: new Date('2030-01-01'), endDate: new Date('2030-12-31') } });
  const grade = await prisma.grade.create({ data: { academicYearId: year.id, name: 'G8', displayOrder: 1 } });
  const sectionIds = Array.from({ length: nSections }, () => randomUUID());
  await prisma.section.createMany({ data: sectionIds.map((id, i) => ({ id, gradeId: grade.id, name: `S${i + 1}`, code: `S${i + 1}` })) });

  const subjectIds: string[] = [];
  const teacherIds: string[] = [];
  const eligibilityIds: string[] = [];
  const requirementIds: string[] = [];
  for (let i = 0; i < subjectPeriods.length; i++) {
    const subject = await prisma.subject.create({ data: { schoolId, name: `Subject ${i}`, code: `SUB${i}_${uniq}` } });
    const teacher = await prisma.teacher.create({ data: { schoolId, name: `Teacher ${i}` } });
    const link = await prisma.teacherSubject.create({ data: { teacherId: teacher.id, subjectId: subject.id, type: 'PRIMARY' } });
    const eligibility = await prisma.teacherSubjectGrade.create({ data: { teacherSubjectId: link.id, gradeId: grade.id } });
    const requirement = await prisma.subjectRequirement.create({ data: { gradeId: grade.id, subjectId: subject.id, periodsPerWeek: subjectPeriods[i]! } });
    subjectIds.push(subject.id); teacherIds.push(teacher.id); eligibilityIds.push(eligibility.id); requirementIds.push(requirement.id);
  }
  // a second teacher, eligible for the first subject but assigned to nothing (for "the assignment changed" mutations)
  const spare = await prisma.teacher.create({ data: { schoolId, name: 'Spare teacher' } });
  const spareLink = await prisma.teacherSubject.create({ data: { teacherId: spare.id, subjectId: subjectIds[0]!, type: 'SECONDARY' } });
  const spareEligibility = await prisma.teacherSubjectGrade.create({ data: { teacherSubjectId: spareLink.id, gradeId: grade.id } });

  const assignmentIds: string[] = [];
  const rows = [];
  for (const sectionId of sectionIds) {
    for (let i = 0; i < subjectIds.length; i++) {
      const id = randomUUID();
      assignmentIds.push(id);
      rows.push({ id, sectionId, subjectRequirementId: requirementIds[i]!, teacherId: teacherIds[i]! });
    }
  }
  await prisma.sectionSubjectTeacher.createMany({ data: rows });

  // The SIMPLIFIED schedule (working days + periods per day + ONE break position): no clock times, no period rows, no timing events.
  // `legacy: true` (or two or more breaks) builds a pre-simplification configuration instead: breakAfterPeriod NULL, real period rows with clock times and one
  // timing event per break position. Those exist only to test historical compatibility.
  const legacy = o.legacy === true || breakAfter.length > 1;
  const config = await prisma.scheduleConfig.create({ data: { academicYearId: year.id, periodsPerDay: ppd, ...(legacy ? {} : { breakAfterPeriod: breakAfter[0] ?? null }) } });
  await prisma.scheduleDay.createMany({ data: WEEK.slice(0, days).map((dayOfWeek) => ({ scheduleConfigId: config.id, dayOfWeek })) });
  if (legacy) {
    await prisma.schedulePeriod.createMany({
      data: Array.from({ length: ppd }, (_, k) => ({ scheduleConfigId: config.id, periodNumber: k + 1, startMinute: 480 + k * 60, endMinute: 480 + k * 60 + 50 })),
    });
    for (const after of breakAfter) {
      await prisma.scheduleTimingEvent.create({ data: { scheduleConfigId: config.id, eventType: 'BREAK', afterPeriodNumber: after, startMinute: 480 + (after - 1) * 60 + 50, endMinute: 480 + after * 60 } });
    }
  }
  return { yearId: year.id, gradeId: grade.id, configId: config.id, sectionIds, subjectIds, teacherIds, spareTeacherId: spare.id, requirementIds, assignmentIds, eligibilityIds, spareEligibilityId: spareEligibility.id, subjectPeriods };
}

/**
 * HISTORICAL COMPATIBILITY FIXTURE. Before the simplified schedule (migration 20261117090000) every run stored the schedule's clock times with the version it created.
 * New runs no longer do (they store an empty list). To test that such OLD versions stay readable, this writes exactly what the old code wrote: the year's CURRENT
 * schedule_periods rows as the version's snapshot. Only meaningful for a LEGACY year (seedYear(..., { legacy: true })), which still has period rows.
 */
export async function stampLegacyPeriodTimes(versionId: string, configId: string): Promise<void> {
  const rows = await prisma.schedulePeriod.findMany({ where: { scheduleConfigId: configId }, orderBy: { periodNumber: 'asc' }, select: { periodNumber: true, startMinute: true, endMinute: true } });
  if (rows.length === 0) return;
  await prisma.$executeRaw`UPDATE "timetable_versions" SET "periodTimes" = ${JSON.stringify(rows)}::jsonb, "periodTimesCapturedAt" = now() WHERE "id" = ${versionId}`;
}

export async function enqueueFor(world: World, year: SeededYear | string, over: { seed?: number; reproducible?: boolean; queueMax?: number; sections?: number } = {}) {
  const repo = new RunRepository(prisma);
  const yearId = typeof year === 'string' ? year : year.yearId;
  return repo.enqueue(
    { schoolId: world.schoolId, academicYearId: yearId, requestedById: world.adminId, options: { seed: over.seed ?? 1, reproducible: over.reproducible ?? false }, timeLimitSeconds: 10, workers: 2, sectionCount: over.sections ?? 3 },
    over.queueMax ?? 10_000
  );
}

export async function mustEnqueue(world: World, year: SeededYear | string, over: Parameters<typeof enqueueFor>[2] = {}): Promise<RunRecord> {
  const r = await enqueueFor(world, year, over);
  if (!r.ok) throw new Error(`enqueue refused: ${r.reason}`);
  return r.run;
}

export async function getRun(id: string): Promise<RunRecord> {
  return (await prisma.timetableGenerationRun.findUniqueOrThrow({ where: { id } })) as unknown as RunRecord;
}

export const TERMINAL = ['SUCCEEDED', 'FAILED'];
export async function waitTerminal(id: string, timeoutMs = 60_000): Promise<RunRecord> {
  await waitFor(async () => TERMINAL.includes((await getRun(id)).status), timeoutMs, 100);
  return getRun(id);
}

// ---------------------------------------------------------------------------------------------------------------
// Runner configuration and logging for tests
// ---------------------------------------------------------------------------------------------------------------
export const fastConfig = (over: Partial<RunnerConfig> = {}): RunnerConfig => ({
  enabled: true, workers: 2, concurrency: 2, queueMax: 100, queueTtlMinutes: 30, leaseSeconds: 6, heartbeatSeconds: 1, heartbeatMaxFailures: 3,
  tickSeconds: 1, maxAttempts: 2, shutdownGraceSeconds: 20, persistMaxRetries: 2, persistLockTimeoutSeconds: 5, maxDraftsPerYear: 20, ...over,
});

export function captureLogger(): { logger: Logger; lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }> } {
  const lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
  const add = (level: string) => (fields: Record<string, unknown>, msg: string): void => { lines.push({ level, msg, fields }); };
  return { logger: { info: add('info'), warn: add('warn'), error: add('error') }, lines };
}

// ---------------------------------------------------------------------------------------------------------------
// A scripted SolverClient: deterministic outcomes without a Python process
// ---------------------------------------------------------------------------------------------------------------
export interface SolveCtx {
  problem: NormalizedProblem;
  input: SolverInput;
  signal: AbortSignal | undefined;
  callNo: number;
}

export function fakeInfo(over: Partial<SolverRunInfo> = {}): SolverRunInfo {
  return {
    startedAt: new Date().toISOString(), spawned: true, pid: 4242, durationMs: 5, exitCode: 0, signal: null, timeLimitSeconds: 10, killGraceMs: 20_000, killDeadlineMs: 30_000,
    timeout: { exceededBudget: false, killReason: null, signalsSent: [], escalated: false, terminationMs: null, unkillable: false },
    stdin: { bytes: 100, written: true, error: null, closedByClient: false }, stdoutBytes: 100, stderrBytes: 0, stderrTail: '', stderrTruncated: false,
    solverStatus: null, stoppedBy: null, failureCode: null, ...over,
  };
}

export function diagnostics(objective: number | null, over: Partial<SolverDiagnostics> = {}): SolverDiagnostics {
  return { objectiveValue: objective, bestObjectiveBound: 0, wallSeconds: 0.5, numWorkers: 2, seed: 1, ortoolsVersion: 'scripted', numBooleans: 10, numConstraints: 10, conflicts: 0, branches: 0, stoppedBy: 'TIME_LIMIT', messages: [], ...over };
}

/** A valid CP-SAT-looking timetable: a baseline built with another seed, so it differs from the run's own baseline. */
export function validEntries(problem: NormalizedProblem, seed = 4242): TimetableEntryRow[] {
  const b = buildBaseline(problem, seed);
  if (!b.ok) throw new Error('baseline failed in the test kit');
  return b.entries;
}

export function solution(problem: NormalizedProblem, status: 'OPTIMAL' | 'FEASIBLE' = 'FEASIBLE', over: { objective?: number | null; entries?: TimetableEntryRow[] } = {}): SolverClientResult {
  const entries = over.entries ?? validEntries(problem);
  const truth = evaluateMetrics(problem, entries).weightedObjective;
  const objective = over.objective === undefined ? truth : over.objective;
  const attempt: SolverAttempt = { kind: 'SOLUTION', status, entries, diagnostics: diagnostics(objective, { stoppedBy: status === 'OPTIMAL' ? 'OPTIMAL' : 'TIME_LIMIT' }) };
  return { attempt, info: fakeInfo({ solverStatus: status, stoppedBy: status === 'OPTIMAL' ? 'OPTIMAL' : 'TIME_LIMIT' }) };
}

export const noSolution = (): SolverClientResult => ({ attempt: { kind: 'NO_SOLUTION', diagnostics: diagnostics(null, { stoppedBy: 'DETERMINISTIC_LIMIT' }) }, info: fakeInfo({ solverStatus: 'UNKNOWN', stoppedBy: 'DETERMINISTIC_LIMIT' }) });
export const watchdog = (): SolverClientResult => ({ attempt: { kind: 'KILLED_BY_WATCHDOG' }, info: fakeInfo({ exitCode: null, signal: 'SIGTERM', timeout: { exceededBudget: true, killReason: 'TIMEOUT', signalsSent: ['SIGTERM'], escalated: false, terminationMs: 20, unkillable: false } }) });
export const infeasible = (): SolverClientResult => ({ attempt: { kind: 'INFEASIBLE', diagnostics: diagnostics(null, { stoppedBy: 'INFEASIBLE', messages: ['proved infeasible'] }) }, info: fakeInfo({ solverStatus: 'INFEASIBLE' }) });
export const processFault = (code: 'SOLVER_UNAVAILABLE' | 'SOLVER_CRASHED', message = 'simulated'): SolverClientResult => ({ attempt: { kind: 'PROCESS_FAULT', code, message }, info: fakeInfo({ spawned: code === 'SOLVER_CRASHED', exitCode: code === 'SOLVER_CRASHED' ? 3 : null, failureCode: code }) });
export const outputFault = (code: 'SOLVER_INVALID_OUTPUT' | 'SOLVER_MODEL_INVALID' | 'SOLVER_INPUT_REJECTED', message = 'simulated'): SolverClientResult => ({ attempt: { kind: 'FAULT', code, message, problems: [{ code: 'CONTRACT_VIOLATION', message }], diagnostics: null }, info: fakeInfo({ failureCode: code }) });

export class ScriptedSolver implements SolverClient {
  readonly calls: SolveCtx[] = [];
  inFlight = 0;
  peak = 0;
  constructor(public script: (ctx: SolveCtx) => Promise<SolverClientResult> | SolverClientResult) {}

  async solve(request: SolverRequest, options: SolveOptions = {}): Promise<SolverClientResult> {
    const ctx: SolveCtx = { problem: request.problem, input: request.input, signal: options.signal, callNo: this.calls.length + 1 };
    this.calls.push(ctx);
    this.inFlight++;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      return await this.script(ctx);
    } finally {
      this.inFlight--;
    }
  }
}

/** Sleep that behaves like a real solver subprocess under abort: it rejects with SolverAbortedError. */
export function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new SolverAbortedError(fakeInfo({ timeout: { exceededBudget: false, killReason: 'ABORT', signalsSent: ['SIGTERM'], escalated: false, terminationMs: 1, unkillable: false } })));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = (): void => { clearTimeout(timer); reject(new SolverAbortedError(fakeInfo({ timeout: { exceededBudget: false, killReason: 'ABORT', signalsSent: ['SIGTERM'], escalated: false, terminationMs: 1, unkillable: false } }))); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const feasibleAfter = (ms: number) => (ctx: SolveCtx): Promise<SolverClientResult> => abortableSleep(ms, ctx.signal).then(() => solution(ctx.problem));

export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

export type { PrismaClient };
