// Module 11 - Phase 7F-0 on REAL PostgreSQL: migration integrity, period-time freezing (write-once, recovery), draft-cap enforcement
// (enqueue, persistence safety net, runtime cap changes, legacy overflow) and the HTTP / Swagger contract of DRAFT_LIMIT_REACHED.
//
//   1  migration integrity (columns, constraints, trigger, index, FK action, earlier migrations untouched)
//   2  period times: captured once from the first attempt's snapshot, frozen, reused after recovery, written to the version
//   3  draft cap: enqueue refusal, persistence safety net, runtime cap change, legacy overflow, what does and does not count
//   4  HTTP + Swagger: 409 DRAFT_LIMIT_REACHED, 503 BUSY, run failure code, documentation
//   5  cleanup and proof that nothing existing changed
//
// Run with   NODE_ENV=production npx tsx test-timetable-foundation-db.ts
import 'dotenv/config'; // first: the database pool is created when a module imports src/config/database.ts
import './test-fixtures/test-security-env.js'; // a test-only COOKIE_SECRET (production mode refuses the placeholder in .env)
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { ConfigurationChangedError, DraftLimitReachedError, persistGeneratedVersionOnce, type PersistParams } from './src/modules/timetable-generation/timetable-generation.final-persist.js';
import { canonicalJson } from './src/modules/timetable-generation/timetable-generation.hash.js';
import { loadGenerationSnapshot } from './src/modules/timetable-generation/timetable-generation.loader.js';
import { evaluateMetrics } from './src/modules/timetable-generation/timetable-generation.metrics.js';
import { normalizeProblem } from './src/modules/timetable-generation/timetable-generation.normalizer.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { RunRepository, type RunRecord } from './src/modules/timetable-generation/timetable-generation.run-repository.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { registerGenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner-handle.js';
import {
  assertQueueIsEmpty, captureLogger, createWorld, destroyWorld, enqueueFor, EXISTING_TABLES, fastConfig, fingerprint, getRun, mustEnqueue, newTableCounts, prisma, rawPrisma,
  ScriptedSolver, seedYear, sleep, solution, validEntries, waitTerminal, type SeededYear, type SolveCtx, type World,
} from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const json = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(json(a)) === canonicalJson(json(b));
const errText = (e: unknown): string => `${(e as Error)?.message ?? e} ${JSON.stringify((e as { meta?: unknown })?.meta ?? {})}`;
/** The text of the error a promise rejects with, or '' when it resolves. */
const failure = async (p: PromiseLike<unknown>): Promise<string> => { try { await p; return ''; } catch (e) { return errText(e); } };

const writerPool = new pg.Pool({ connectionString: process.env.DATABASE_URL!, max: 10, connectionTimeoutMillis: 30_000 });
const writer = new PrismaClient({ adapter: new PrismaPg(writerPool) });

const noop = (): void => undefined;
const feasible = (ctx: SolveCtx) => solution(ctx.problem);
const expectedTimes = (n: number, shift = 0) => Array.from({ length: n }, (_, k) => ({ periodNumber: k + 1, startMinute: 480 + k * 60 + shift, endMinute: 480 + k * 60 + 50 + shift }));

async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();
  const world: World = await createWorld('M11FD');
  const world2: World = await createWorld('M11FE');
  const seeded: SeededYear[] = [];
  const mkYear = async (tag: string, o: Parameters<typeof seedYear>[2] = {}): Promise<SeededYear> => { const y = await seedYear(world, tag, o); seeded.push(y); return y; };
  const versionsOf = (yearId: string) => prisma.timetableVersion.findMany({ where: { academicYearId: yearId }, orderBy: { versionNumber: 'asc' } });
  const problemOf = async (y: SeededYear) => { const n = normalizeProblem(await loadGenerationSnapshot(prisma, world.schoolId, y.yearId)); if (!n.ok) throw new Error('not normalisable'); return n.problem; };
  const mkVersion = async (yearId: string, schoolId: string, versionNumber: number, extra: Record<string, unknown> = {}) =>
    prisma.timetableVersion.create({
      data: { schoolId, academicYearId: yearId, versionNumber, status: 'DRAFT', solutionSource: 'BASELINE', solverStatus: 'FEASIBLE', weightsVersion: 'V1', inputHash: 'x', inputSnapshot: {}, metrics: {}, baselineMetrics: {}, ...extra } as never,
    });
  /** Bring the year to exactly `n` DRAFT versions (adds drafts; never deletes). */
  const addDrafts = async (yearId: string, n: number): Promise<void> => {
    const max = (await prisma.timetableVersion.aggregate({ where: { academicYearId: yearId }, _max: { versionNumber: true } }))._max.versionNumber ?? 0;
    await prisma.timetableVersion.createMany({
      data: Array.from({ length: n }, (_, i) => ({ schoolId: world.schoolId, academicYearId: yearId, versionNumber: max + i + 1, status: 'DRAFT' as const, solutionSource: 'BASELINE' as const, solverStatus: 'FEASIBLE' as const, weightsVersion: 'V1', inputHash: 'x', inputSnapshot: {}, metrics: {}, baselineMetrics: {} })),
    });
  };
  const draftCount = (yearId: string) => prisma.timetableVersion.count({ where: { academicYearId: yearId, status: 'DRAFT' } });
  const runCount = (yearId: string) => prisma.timetableGenerationRun.count({ where: { academicYearId: yearId } });
  const drain = () => prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
  const runners: GenerationRunner[] = [];
  const rig = (script: (ctx: SolveCtx) => ReturnType<ScriptedSolver['script']>, config: Partial<ReturnType<typeof fastConfig>> = {}, hooks?: ConstructorParameters<typeof GenerationRunner>[0]['hooks']) => {
    const solver = new ScriptedSolver(script);
    const { logger } = captureLogger();
    const runner = new GenerationRunner({ prisma: rawPrisma, solverClient: solver, config: fastConfig(config), policy: { ...DEFAULT_TIME_POLICY, le10: 10 }, logger, ...(hooks ? { hooks } : {}) });
    runners.push(runner);
    return { runner, solver };
  };
  const execute = async (rg: ReturnType<typeof rig>, runId: string): Promise<RunRecord> => {
    await rg.runner.dispatch();
    const run = await waitTerminal(runId, 90_000);
    await rg.runner.stop(5);
    return run;
  };

  try {
    // =================================================================================================================
    section('1. Migration integrity');
    {
      const migrations = await prisma.$queryRaw<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>`SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name`;
      check('20 migrations are recorded, all finished and none rolled back; the 7F-0 one is followed only by the setup-token migration (security Phase 2) and the two later additive migrations (teacher grade scope, teacher bulk requests, substitutions)', migrations.length === 20 && migrations.every((m) => m.finished_at !== null && m.rolled_back_at === null) && migrations[9]!.migration_name === '20261010100000_add_clone_provenance_and_period_times' && migrations[10]!.migration_name === '20261012120000_add_school_setup_tokens' && migrations[11]!.migration_name === '20261021090000_add_teacher_subject_grade_scope' && migrations[12]!.migration_name === '20261022090000_add_teacher_bulk_requests' && migrations[13]!.migration_name === '20261023090000_add_substitutions' && migrations[14]!.migration_name === '20261024090000_add_curriculum_scope' && migrations[14]!.finished_at !== null && migrations[15]!.migration_name === '20261025090000_protect_history_from_cascade' && migrations[15]!.finished_at !== null && migrations[16]!.migration_name === '20261026090000_protect_cover_requests_from_version_delete' && migrations[16]!.finished_at !== null && migrations[17]!.migration_name === '20261101090000_add_automatic_substitution' && migrations[17]!.finished_at !== null && migrations[18]!.migration_name === '20261102090000_add_consecutive_period_policy' && migrations[18]!.finished_at !== null && migrations[19]!.migration_name === '20261117090000_add_schedule_break_after_period' && migrations[19]!.finished_at !== null, `${migrations.length}`);
      const cols = await prisma.$queryRaw<Array<{ table_name: string; column_name: string; data_type: string; is_nullable: string }>>`
        SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name IN ('timetable_versions','timetable_generation_runs') AND column_name IN ('clonedFromId','periodTimes','periodTimesCapturedAt') ORDER BY table_name, column_name`;
      const col = (t: string, c: string) => cols.find((x) => x.table_name === t && x.column_name === c);
      check('versions: clonedFromId text, periodTimes jsonb, periodTimesCapturedAt timestamptz; all NULLABLE (purely additive)', col('timetable_versions', 'clonedFromId')?.data_type === 'text' && col('timetable_versions', 'periodTimes')?.data_type === 'jsonb' && col('timetable_versions', 'periodTimesCapturedAt')?.data_type === 'timestamp with time zone' && ['clonedFromId', 'periodTimes', 'periodTimesCapturedAt'].every((c) => col('timetable_versions', c)?.is_nullable === 'YES'));
      check('runs: periodTimes jsonb and periodTimesCapturedAt timestamptz, both NULLABLE', col('timetable_generation_runs', 'periodTimes')?.data_type === 'jsonb' && col('timetable_generation_runs', 'periodTimesCapturedAt')?.data_type === 'timestamp with time zone' && col('timetable_generation_runs', 'periodTimes')?.is_nullable === 'YES' && col('timetable_generation_runs', 'periodTimesCapturedAt')?.is_nullable === 'YES');
      const cons = await prisma.$queryRaw<Array<{ conname: string; contype: string; confdeltype: string }>>`SELECT conname, contype::text, confdeltype::text FROM pg_constraint WHERE conname IN ('timetable_versions_clonedFromId_fkey','timetable_versions_period_times_check','timetable_generation_runs_period_times_check','timetable_versions_cloned_from_not_self_check')`;
      check('the self foreign key exists with ON DELETE SET NULL, and the three CHECK constraints exist', cons.find((c) => c.conname === 'timetable_versions_clonedFromId_fkey')?.confdeltype === 'n' && cons.filter((c) => c.contype === 'c').length === 3, JSON.stringify(cons));
      const objs = await prisma.$queryRaw<Array<{ n: string }>>`
        SELECT 'trigger' AS n FROM pg_trigger WHERE tgname = 'timetable_versions_clone_provenance_trigger' AND NOT tgisinternal
        UNION ALL SELECT 'index' FROM pg_indexes WHERE indexname = 'timetable_versions_clonedFromId_idx'
        UNION ALL SELECT 'function' FROM pg_proc WHERE proname = 'timetable_versions_check_clone_provenance'
        UNION ALL SELECT 'earlier-index' FROM pg_indexes WHERE indexname IN ('timetable_versions_one_published_per_year','timetable_generation_runs_one_active_per_year')`;
      check('the provenance trigger, its function and the clonedFromId index exist; the two earlier partial unique indexes are intact', objs.filter((o) => o.n === 'trigger').length === 1 && objs.filter((o) => o.n === 'index').length === 1 && objs.filter((o) => o.n === 'function').length === 1 && objs.filter((o) => o.n === 'earlier-index').length === 2);

      // behaviour
      const yA = await prisma.academicYear.create({ data: { schoolId: world.schoolId, name: 'mig-A', startDate: new Date('2031-01-01'), endDate: new Date('2031-12-31') } });
      const yB = await prisma.academicYear.create({ data: { schoolId: world.schoolId, name: 'mig-B', startDate: new Date('2032-01-01'), endDate: new Date('2032-12-31') } });
      const yC = await prisma.academicYear.create({ data: { schoolId: world2.schoolId, name: 'mig-C', startDate: new Date('2033-01-01'), endDate: new Date('2033-12-31') } });
      const a = await mkVersion(yA.id, world.schoolId, 1);
      check('a new version without provenance or times: all three columns are NULL (every pre-existing row is in this state too)', a.clonedFromId === null && a.periodTimes === null && a.periodTimesCapturedAt === null);
      const b = await mkVersion(yA.id, world.schoolId, 2, { clonedFromId: a.id });
      check('same year, same school: a clone may point at its source', b.clonedFromId === a.id);
      check('another ACADEMIC YEAR of the same school is refused by the trigger (23514)', /cannot be cloned from a version of another academic year or school/.test(await failure(mkVersion(yB.id, world.schoolId, 1, { clonedFromId: a.id }))));
      check('another SCHOOL is refused by the trigger', /cannot be cloned from a version of another academic year or school/.test(await failure(mkVersion(yC.id, world2.schoolId, 1, { clonedFromId: a.id }))));
      const c = await mkVersion(yB.id, world.schoolId, 1);
      check('...and so is re-pointing an existing version at a version of another year (UPDATE OF clonedFromId)', /cannot be cloned from a version of another academic year or school/.test(await failure(prisma.$executeRaw`UPDATE "timetable_versions" SET "clonedFromId" = ${a.id} WHERE "id" = ${c.id}`)) && (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: c.id } })).clonedFromId === null);
      check('a version cannot be its own source (CHECK)', /cloned_from_not_self/.test(await failure(prisma.$executeRaw`UPDATE "timetable_versions" SET "clonedFromId" = "id" WHERE "id" = ${a.id}`)));
      check('a missing source is reported by the foreign key (not the trigger)', /foreign key|clonedFromId_fkey/i.test(await failure(mkVersion(yA.id, world.schoolId, 3, { clonedFromId: randomUUID() }))));
      await prisma.timetableVersion.delete({ where: { id: a.id } });
      check('ON DELETE SET NULL: deleting the source keeps the clone and nulls its provenance (the trigger accepts the NULL)', (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: b.id } })).clonedFromId === null);

      const t = [{ periodNumber: 1, startMinute: 480, endMinute: 530 }];
      check('versions: times without a capture time are refused (CHECK)', /period_times_check/.test(await failure(prisma.$executeRaw`UPDATE "timetable_versions" SET "periodTimes" = ${JSON.stringify(t)}::jsonb WHERE "id" = ${b.id}`)));
      check('versions: a capture time without times is refused', /period_times_check/.test(await failure(prisma.$executeRaw`UPDATE "timetable_versions" SET "periodTimesCapturedAt" = now() WHERE "id" = ${b.id}`)));
      check('versions: times that are not a JSON array are refused', /period_times_check/.test(await failure(prisma.$executeRaw`UPDATE "timetable_versions" SET "periodTimes" = '{"a":1}'::jsonb, "periodTimesCapturedAt" = now() WHERE "id" = ${b.id}`)));
      check('versions: both set with an array is accepted', (await failure(prisma.$executeRaw`UPDATE "timetable_versions" SET "periodTimes" = ${JSON.stringify(t)}::jsonb, "periodTimesCapturedAt" = now() WHERE "id" = ${b.id}`)) === '' && sameJson((await prisma.timetableVersion.findUniqueOrThrow({ where: { id: b.id } })).periodTimes, t));
      const yRun = await mkYear('mig-run', { sections: 1, subjects: [2] });
      const run = await mustEnqueue(world, yRun);
      check('runs: times without a capture time, a capture time without times, and a non-array are all refused', /period_times_check/.test(await failure(prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "periodTimes" = ${JSON.stringify(t)}::jsonb WHERE "id" = ${run.id}`)) && /period_times_check/.test(await failure(prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "periodTimesCapturedAt" = now() WHERE "id" = ${run.id}`)) && /period_times_check/.test(await failure(prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "periodTimes" = '"x"'::jsonb, "periodTimesCapturedAt" = now() WHERE "id" = ${run.id}`)));
      check('a freshly queued run has both columns NULL', run.periodTimes === null && run.periodTimesCapturedAt === null);
      await drain();
    }

    // =================================================================================================================
    section('2. Period times: captured once, frozen, reused after recovery');
    {
      // 2a. the happy path through the real runner
      const y = await mkYear('times-ok');
      const queued = await mustEnqueue(world, y);
      const rg = rig(feasible);
      const run = await execute(rg, queued.id);
      const [v] = await versionsOf(y.yearId);
      check('the run SUCCEEDED and created one version', run.status === 'SUCCEEDED' && !!v, `${run.status} ${run.failureCode}`);
      check('the run captured NO clock times, by design: its snapshot is the empty list (the simplified schedule has none)', sameJson(run.periodTimes, []));
      check('the version carries exactly the run\'s snapshot: [] (not NULL: NULL is a version from before snapshots existed)', sameJson(v!.periodTimes, run.periodTimes) && sameJson(v!.periodTimes, []));
      check('capture time: the same instant on the run and the version, inside the run\'s lifetime', !!run.periodTimesCapturedAt && v!.periodTimesCapturedAt?.getTime() === run.periodTimesCapturedAt.getTime() && run.periodTimesCapturedAt.getTime() >= run.startedAt!.getTime() - 1_000 && run.periodTimesCapturedAt.getTime() <= run.finishedAt!.getTime() + 1_000);
      const problem = await problemOf(y);
      check('the input hash is still the hash of the problem core (times are not part of it)', v!.inputHash === problem.inputHash && !JSON.stringify(v!.inputSnapshot).includes('startMinute'));

      // 2b. the hash does not move when only the times move
      const yh = await mkYear('times-hash', { legacy: true }); // a legacy configuration still has period rows with clock times
      const hashBefore = (await problemOf(yh)).inputHash;
      await writer.schedulePeriod.updateMany({ where: { scheduleConfigId: yh.configId }, data: { startMinute: { increment: 15 }, endMinute: { increment: 15 } } });
      check('changing only the (legacy) period times does not change the input hash: no clock time is read by scheduling', (await problemOf(yh)).inputHash === hashBefore);
      await prisma.scheduleConfig.update({ where: { id: yh.configId }, data: { breakAfterPeriod: 3 } }); // the same year, now in the simplified model with the same single break (after 3)
      check('converting a legacy configuration (one event after period 3) to breakAfterPeriod = 3 leaves the input hash IDENTICAL: existing versions do not become stale', (await problemOf(yh)).inputHash === hashBefore);

      // 2c. the times are the FIRST attempt's snapshot, not whatever the schedule says later
      const y2 = await mkYear('times-frozen', { legacy: true }); // a LEGACY configuration: it still has period rows whose times can be edited
      const q2 = await mustEnqueue(world, y2);
      let edited = false;
      const rg2 = rig(feasible, {}, { onPhase: async (phase) => {
        if (phase === 'SOLVING' && !edited) {
          edited = true; // the school edits its period times while the solver works
          await writer.schedulePeriod.updateMany({ where: { scheduleConfigId: y2.configId }, data: { startMinute: { increment: 30 }, endMinute: { increment: 30 } } });
        }
      } });
      const r2 = await execute(rg2, q2.id);
      const [v2] = await versionsOf(y2.yearId);
      const nowInDb = await prisma.schedulePeriod.findMany({ where: { scheduleConfigId: y2.configId }, orderBy: { periodNumber: 'asc' }, select: { periodNumber: true, startMinute: true, endMinute: true } });
      check('control: the schedule\'s times really changed during the run', sameJson(nowInDb, expectedTimes(6, 30)));
      check('a time-only edit during the run does NOT fail it (times are not scheduling data): SUCCEEDED', r2.status === 'SUCCEEDED' && !!v2, `${r2.status} ${r2.failureCode}`);
      check('NO clock time reaches the run or the version, whatever the legacy rows say or are edited to: both stay []', sameJson(v2!.periodTimes, []) && sameJson(r2.periodTimes, []));

      // 2d. write-once, fenced
      const y3 = await mkYear('times-once');
      const q3 = await mustEnqueue(world, y3);
      const repo = new RunRepository(rawPrisma);
      const tokenA = randomUUID();
      const claimed = (await repo.claimNext(tokenA, 60))!;
      const T1 = expectedTimes(6);
      const T2 = expectedTimes(6, 45);
      check('a wrong token cannot freeze (null), and writes nothing', (await repo.freezePeriodTimes(claimed.id, randomUUID(), T1)) === null && (await getRun(q3.id)).periodTimes === null);
      const first = await repo.freezePeriodTimes(claimed.id, tokenA, T1);
      check('the owner freezes the first value (reused=false) with a capture time', !!first && first.reused === false && sameJson(first.periodTimes, T1) && first.capturedAt instanceof Date);
      const stored1 = await getRun(q3.id);
      const second = await repo.freezePeriodTimes(claimed.id, tokenA, T2);
      const stored2 = await getRun(q3.id);
      check('a second freeze with DIFFERENT times changes nothing and returns the stored value (reused=true)', !!second && second.reused === true && sameJson(second.periodTimes, T1) && sameJson(stored2.periodTimes, T1) && stored2.periodTimesCapturedAt!.getTime() === stored1.periodTimesCapturedAt!.getTime());

      // 2e. recovery: attempt 2 reuses attempt 1's times even though the schedule changed in between
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "leaseExpiresAt" = now() - interval '1 second' WHERE "id" = ${q3.id}`;
      const rec = await repo.recoverStale(2);
      check('the lost attempt is requeued by recovery (the frozen times stay on the run)', rec.requeued.includes(q3.id) && sameJson((await getRun(q3.id)).periodTimes, T1));
      await writer.schedulePeriod.updateMany({ where: { scheduleConfigId: y3.configId }, data: { startMinute: { increment: 45 }, endMinute: { increment: 45 } } });
      const rg3 = rig(feasible);
      const r3 = await execute(rg3, q3.id);
      const [v3] = await versionsOf(y3.yearId);
      check('attempt 2 SUCCEEDED', r3.status === 'SUCCEEDED' && r3.attempts === 2 && !!v3, `${r3.status} attempts=${r3.attempts} ${r3.failureCode}`);
      check('THE RECOVERED ATTEMPT REUSED THE FROZEN TIMES: the version has attempt 1\'s times, not the edited schedule\'s', sameJson(v3!.periodTimes, T1) && sameJson(r3.periodTimes, T1));
      check('...and the capture time is attempt 1\'s, unchanged by the recovery', r3.periodTimesCapturedAt!.getTime() === stored1.periodTimesCapturedAt!.getTime() && v3!.periodTimesCapturedAt!.getTime() === stored1.periodTimesCapturedAt!.getTime());

      // 2f. persistence level: the times are optional, and must describe exactly the problem's periods
      const y4 = await mkYear('times-persist');
      const problem4 = await problemOf(y4);
      const entries4 = validEntries(problem4);
      const base = (r: RunRecord, token: string): PersistParams => ({
        prisma: rawPrisma, run: { id: r.id, schoolId: r.schoolId, academicYearId: r.academicYearId, requestedById: r.requestedById }, token, problem: problem4, entries: entries4,
        version: { solutionSource: 'CP_SAT', solverStatus: 'FEASIBLE', weightsVersion: 'V1', metrics: evaluateMetrics(problem4, entries4), baselineMetrics: evaluateMetrics(problem4, entries4), solverDiagnostics: null },
        resultSummary: {}, lockTimeoutSeconds: 5,
      });
      await drain();
      const q4 = await mustEnqueue(world, y4);
      const tok4 = randomUUID();
      const c4 = (await repo.claimNext(tok4, 60))!;
      let kind = '';
      try { await persistGeneratedVersionOnce({ ...base(c4, tok4), periodTimes: { times: expectedTimes(4), capturedAt: new Date() } }); } catch (e) { kind = e instanceof ConfigurationChangedError ? 'ConfigurationChangedError' : (e as Error).constructor.name; }
      check('times for 4 periods against a 6-period problem: ConfigurationChangedError, nothing written, run still RUNNING', kind === 'ConfigurationChangedError' && (await versionsOf(y4.yearId)).length === 0 && (await getRun(q4.id)).status === 'RUNNING', kind);
      const capturedAt = new Date('2030-05-05T10:00:00.000Z');
      await persistGeneratedVersionOnce({ ...base(c4, tok4), periodTimes: { times: expectedTimes(6), capturedAt } });
      const [v4] = await versionsOf(y4.yearId);
      check('with matching times the version stores them and the given capture time', sameJson(v4!.periodTimes, expectedTimes(6)) && v4!.periodTimesCapturedAt!.getTime() === capturedAt.getTime());
      await drain();
      const q4b = await mustEnqueue(world, y4);
      const tok4b = randomUUID();
      const c4b = (await repo.claimNext(tok4b, 60))!;
      await persistGeneratedVersionOnce(base(c4b, tok4b));
      const v4b = (await versionsOf(y4.yearId)).find((v) => v.versionNumber === 2)!;
      check('without times (a caller that has none) the version stores NULL and NULL (the pairing CHECK holds)', v4b.periodTimes === null && v4b.periodTimesCapturedAt === null && q4b.id !== q4.id);
      await drain();

      // 2g. a stored value that cannot be trusted
      const y5 = await mkYear('times-bad');
      const q5 = await mustEnqueue(world, y5);
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "periodTimes" = '[{"bad":1}]'::jsonb, "periodTimesCapturedAt" = now() WHERE "id" = ${q5.id}`;
      const rg5 = rig(feasible);
      const r5 = await execute(rg5, q5.id);
      check('unreadable stored times: FAILED INTERNAL_INCONSISTENCY, no version, the solver never called', r5.status === 'FAILED' && r5.failureCode === 'INTERNAL_INCONSISTENCY' && (await versionsOf(y5.yearId)).length === 0 && rg5.solver.calls.length === 0, `${r5.status} ${r5.failureCode}`);
      const q5b = await mustEnqueue(world, y5);
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "periodTimes" = ${JSON.stringify(expectedTimes(2))}::jsonb, "periodTimesCapturedAt" = now() WHERE "id" = ${q5b.id}`;
      const rg5b = rig(feasible);
      const r5b = await execute(rg5b, q5b.id);
      check('stored times for 2 periods but the schedule now has 6: FAILED CONFIGURATION_CHANGED, no version, the solver never called', r5b.status === 'FAILED' && r5b.failureCode === 'CONFIGURATION_CHANGED' && (await versionsOf(y5.yearId)).length === 0 && rg5b.solver.calls.length === 0, `${r5b.status} ${r5b.failureCode}`);
    }

    // =================================================================================================================
    section('3. The draft cap');
    {
      const repo = new RunRepository(rawPrisma);
      const y = await mkYear('cap', { sections: 3 });
      const enq = (cap?: number) => repo.enqueue({ schoolId: world.schoolId, academicYearId: y.yearId, requestedById: world.adminId, options: { seed: 1, reproducible: false }, timeLimitSeconds: 10, workers: 2, sectionCount: 3 }, 10_000, cap);

      await addDrafts(y.yearId, 19);
      const at19 = await enq();
      check('19 drafts, cap 20 (the default): the generation is accepted', at19.ok === true);
      await drain();
      await addDrafts(y.yearId, 1);
      const runsBefore = await runCount(y.yearId);
      const at20 = await enq();
      check('20 drafts: REFUSED with DRAFT_LIMIT_REACHED, naming drafts and the cap (equality blocks)', !at20.ok && at20.reason === 'DRAFT_LIMIT_REACHED' && at20.drafts === 20 && at20.max === 20, JSON.stringify(at20));
      check('...and no run row was created', (await runCount(y.yearId)) === runsBefore);

      await addDrafts(y.yearId, 2);
      const legacy = await enq();
      check('legacy overflow: 22 drafts (above the cap) are all kept, and a new generation is refused', (await draftCount(y.yearId)) === 22 && !legacy.ok && legacy.reason === 'DRAFT_LIMIT_REACHED' && legacy.drafts === 22);
      const oldest = (await versionsOf(y.yearId))[0]!;
      await prisma.timetableVersion.deleteMany({ where: { academicYearId: y.yearId, versionNumber: { in: [oldest.versionNumber, oldest.versionNumber + 1, oldest.versionNumber + 2] } } });
      check('deleting down to 19 re-opens generation', (await draftCount(y.yearId)) === 19 && (await enq()).ok === true);
      await drain();

      check('a cap passed lower than the count refuses (5 drafts, cap 3 -> refused; cap 6 -> accepted)', await (async () => { await prisma.timetableVersion.deleteMany({ where: { academicYearId: y.yearId } }); await addDrafts(y.yearId, 5); const low = await enq(3); const high = await enq(6); await drain(); return !low.ok && low.reason === 'DRAFT_LIMIT_REACHED' && high.ok === true; })());
      check('cap 1: no drafts -> accepted; one draft -> refused', await (async () => { await prisma.timetableVersion.deleteMany({ where: { academicYearId: y.yearId } }); const first = await enq(1); await drain(); await addDrafts(y.yearId, 1); const second = await enq(1); return first.ok === true && !second.ok && second.reason === 'DRAFT_LIMIT_REACHED'; })());

      // what counts: only DRAFT versions of THIS year
      await prisma.timetableVersion.deleteMany({ where: { academicYearId: y.yearId } });
      await addDrafts(y.yearId, 2);
      const pub = await mkVersion(y.yearId, world.schoolId, 100, { status: 'PUBLISHED', publishedAt: new Date() });
      await mkVersion(y.yearId, world.schoolId, 101, { status: 'ARCHIVED', publishedAt: new Date(), archivedAt: new Date() });
      const other = await mkYear('cap-other', { sections: 1, subjects: [2] });
      await addDrafts(other.yearId, 5);
      const counted = await enq(3);
      check('2 drafts + 1 PUBLISHED + 1 ARCHIVED here and 5 drafts in another year, cap 3: accepted (only this year\'s DRAFTs count)', counted.ok === true && pub.status === 'PUBLISHED', JSON.stringify(counted));
      await drain();

      // the persistence safety net
      const y2 = await mkYear('cap-persist', { sections: 3 });
      await addDrafts(y2.yearId, 3);
      const q = await mustEnqueue(world, y2); // accepted under the default cap 20
      const rg = rig(feasible, { maxDraftsPerYear: 3 });
      const run = await execute(rg, q.id);
      check('a run queued under a higher cap, persisted under a LOWER one (3 drafts, cap 3): FAILED DRAFT_LIMIT_REACHED', run.status === 'FAILED' && run.failureCode === 'DRAFT_LIMIT_REACHED', `${run.status} ${run.failureCode}`);
      check('the failure names the numbers and is not retried (persist attempted once)', (run.failureDiagnostics as { drafts?: number; max?: number }).drafts === 3 && (run.failureDiagnostics as { max?: number }).max === 3 && /maximum is 3/.test(run.failureMessage ?? ''));
      check('nothing was created: still 3 drafts, no entries, the 3 drafts untouched', (await draftCount(y2.yearId)) === 3 && (await prisma.timetableEntry.count({ where: { version: { academicYearId: y2.yearId } } })) === 0 && (await versionsOf(y2.yearId)).every((v) => v.revision === 1 && v.clonedFromId === null));
      check('the run is final: lease released, no version, the solver was called once (the work was done, only the save refused)', run.leaseExpiresAt === null && run.versionId === null && rg.solver.calls.length === 1);
      await prisma.timetableVersion.deleteMany({ where: { academicYearId: y2.yearId, versionNumber: 1 } });
      const q2 = await mustEnqueue(world, y2);
      const run2 = await execute(rig(feasible, { maxDraftsPerYear: 3 }), q2.id);
      check('after deleting a draft (2 drafts, cap 3) the same year generates: SUCCEEDED, 3 drafts', run2.status === 'SUCCEEDED' && (await draftCount(y2.yearId)) === 3, `${run2.status} ${run2.failureCode}`);
      const q3 = await mustEnqueue(world, y2);
      const run3 = await execute(rig(feasible, { maxDraftsPerYear: 4 }), q3.id);
      check('the cap raised at runtime (3 drafts, cap 4): the next generation SUCCEEDED, 4 drafts', run3.status === 'SUCCEEDED' && (await draftCount(y2.yearId)) === 4);
      let direct = '';
      try { await persistGeneratedVersionOnce({ prisma: rawPrisma, run: { id: q3.id, schoolId: world.schoolId, academicYearId: y2.yearId, requestedById: null }, token: 'x', problem: await problemOf(y2), entries: [], version: { solutionSource: 'CP_SAT', solverStatus: 'FEASIBLE', weightsVersion: 'V1', metrics: {} as never, baselineMetrics: {} as never, solverDiagnostics: null }, resultSummary: {}, lockTimeoutSeconds: 5 }); } catch (e) { direct = (e as Error).constructor.name; }
      check('a persist for a run it does not own is still fenced first (LeaseLostError, before any cap logic)', direct === 'LeaseLostError', direct);
      void DraftLimitReachedError;
    }

    // =================================================================================================================
    section('4. HTTP and Swagger');
    {
      const app = await buildApp();
      const passwordHash = await hashPassword('Api#Test-Pass-2030');
      const email = `cap-${Date.now()}@test.local`;
      await prisma.admin.update({ where: { id: world.adminId }, data: { email, passwordHash } });
      const cookie = (await adminService.loginAdmin({ schoolId: world.schoolId, email, password: 'Api#Test-Pass-2030' })).sessionToken;
      const hdr = { cookie: `session_token=${cookie}` };
      const y = await mkYear('http', { sections: 3 });
      const oldCap = process.env.MAX_DRAFTS_PER_YEAR;
      process.env.MAX_DRAFTS_PER_YEAR = '2';
      registerGenerationRunner(null as never); // no runner: the run stays QUEUED, which is all this section needs
      try {
        await addDrafts(y.yearId, 2);
        const refused = await app.inject({ method: 'POST', url: '/api/timetable-generations', headers: hdr, payload: { academicYearId: y.yearId } });
        const rb = refused.json();
        check('POST at the cap: 409 with data.code DRAFT_LIMIT_REACHED, data.drafts 2 and data.maxDraftsPerYear 2', refused.statusCode === 409 && rb.success === false && rb.data?.code === 'DRAFT_LIMIT_REACHED' && rb.data?.drafts === 2 && rb.data?.maxDraftsPerYear === 2 && /maximum is 2/.test(rb.message), `${refused.statusCode} ${refused.body}`);
        check('...no run was created', (await runCount(y.yearId)) === 0);
        const noAuth = await app.inject({ method: 'POST', url: '/api/timetable-generations', payload: { academicYearId: y.yearId } });
        check('unauthenticated: 401 (the cap is not revealed)', noAuth.statusCode === 401 && !noAuth.body.includes('DRAFT_LIMIT'));
        const yForeign = await prisma.academicYear.create({ data: { schoolId: world2.schoolId, name: 'foreign', startDate: new Date('2034-01-01'), endDate: new Date('2034-12-31') } });
        const foreign = await app.inject({ method: 'POST', url: '/api/timetable-generations', headers: hdr, payload: { academicYearId: yForeign.id } });
        check('another school\'s year: 403, never the cap error (no information about foreign drafts)', foreign.statusCode === 403 && !foreign.body.includes('DRAFT_LIMIT'), `${foreign.statusCode}`);
        await prisma.timetableVersion.deleteMany({ where: { academicYearId: y.yearId, versionNumber: 1 } });
        const accepted = await app.inject({ method: 'POST', url: '/api/timetable-generations', headers: hdr, payload: { academicYearId: y.yearId } });
        check('after deleting one draft (1 draft, cap 2): 202 accepted', accepted.statusCode === 202 && accepted.json().data?.status === 'QUEUED', `${accepted.statusCode} ${accepted.body}`);
        const again = await app.inject({ method: 'POST', url: '/api/timetable-generations', headers: hdr, payload: { academicYearId: y.yearId } });
        check('a second POST while that run is active is still ALREADY_ACTIVE (409 with existingRunId), not the cap error', again.statusCode === 409 && !!again.json().data?.existingRunId && again.json().data?.code === undefined, again.body);
        await drain();

        // a run that FAILED with the code is shown with it
        const failedRun = await prisma.timetableGenerationRun.create({ data: { schoolId: world.schoolId, academicYearId: y.yearId, requestedById: world.adminId, options: { seed: 1, reproducible: false }, timeLimitSeconds: 10, workers: 2, sectionCount: 3, status: 'FAILED', failureCode: 'DRAFT_LIMIT_REACHED', failureMessage: 'The academic year already has 2 draft timetable versions (the maximum is 2).', failureDiagnostics: { drafts: 2, max: 2 }, finishedAt: new Date() } });
        const view = await app.inject({ method: 'GET', url: `/api/timetable-generations/${failedRun.id}`, headers: hdr });
        check('GET of a run that FAILED with it: failure.code DRAFT_LIMIT_REACHED and the numbers in the diagnostics', view.statusCode === 200 && view.json().data.failure.code === 'DRAFT_LIMIT_REACHED' && view.json().data.failure.diagnostics.drafts === 2 && view.json().data.failure.diagnostics.max === 2, view.body);

        // Swagger
        const spec = app.swagger() as any;
        const post = spec.paths['/api/timetable-generations'].post;
        const get = spec.paths['/api/timetable-generations/{id}'].get;
        const codes: string[] = get.responses['200'].content['application/json'].schema.properties.data.properties.failure.properties.code.enum;
        check('Swagger: the run failure.code enum lists DRAFT_LIMIT_REACHED (16 codes)', codes.includes('DRAFT_LIMIT_REACHED') && codes.length === 16, `${codes.length}`);
        check('Swagger: POST documents the cap in its description and in the 409 response', /DRAFT_LIMIT_REACHED/.test(post.description) && /MAX_DRAFTS_PER_YEAR/.test(post.description) && /DRAFT_LIMIT_REACHED/.test(post.responses['409'].description));
        check('Swagger: POST documents 503 as queue full OR busy (BUSY) with a data envelope', /BUSY/.test(post.responses['503'].description) && !!post.responses['503'].content['application/json'].schema.properties.data);
        const docs = await app.inject({ method: 'GET', url: '/docs/json' });
        check('/docs/json serves the same documentation', docs.statusCode === 200 && /DRAFT_LIMIT_REACHED/.test(docs.body));
      } finally {
        if (oldCap === undefined) delete process.env.MAX_DRAFTS_PER_YEAR; else process.env.MAX_DRAFTS_PER_YEAR = oldCap;
        await app.close();
      }

      // BUSY: a concurrent writer holds the year row; the enqueue waits for its lock timeout and answers 503-able BUSY, creating nothing
      const yb = await mkYear('busy', { sections: 1, subjects: [2] });
      const repo = new RunRepository(rawPrisma);
      let release: () => void = noop;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let holding: () => void = noop;
      const holdingStarted = new Promise<void>((resolve) => { holding = resolve; });
      const holder = writer.$transaction(async (tx) => { await tx.$queryRaw`SELECT "id" FROM "academic_years" WHERE "id" = ${yb.yearId} FOR SHARE`; holding(); await held; }, { timeout: 60_000, maxWait: 20_000 });
      await holdingStarted;
      const t0 = Date.now();
      const busy = await repo.enqueue({ schoolId: world.schoolId, academicYearId: yb.yearId, requestedById: world.adminId, options: { seed: 1, reproducible: false }, timeLimitSeconds: 10, workers: 2, sectionCount: 1 }, 10_000);
      const waited = Date.now() - t0;
      release();
      await holder;
      check(`an enqueue blocked behind a year lock gives up after the lock timeout (${Math.round(waited / 1000)} s) with BUSY and creates nothing`, !busy.ok && busy.reason === 'BUSY' && waited >= 9_000 && waited < 25_000 && (await runCount(yb.yearId)) === 0, `${JSON.stringify(busy)} ${waited}ms`);
      check('once the other writer is gone the same enqueue is accepted', (await enqueueFor(world, yb, { sections: 1 })).ok === true);
      await drain();
    }
  } finally {
    section('5. Cleanup and proof that nothing existing changed');
    for (const r of runners) { try { await r.stop(5); } catch { /* already stopped */ } }
    await drain();
    await sleep(200);
    check('exactly the two test schools were deleted (cascade)', (await destroyWorld(world)) === 1 && (await destroyWorld(world2)) === 1);
    check('the new tables are back to their starting counts', JSON.stringify(await newTableCounts()) === JSON.stringify(newBefore));
    const after = await fingerprint();
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, EXISTING_TABLES.every((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h));
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11FD_' } } })) === 0 && (await prisma.school.count({ where: { code: { startsWith: 'M11FE_' } } })) === 0);
    await writer.$disconnect();
    await writerPool.end().catch(noop);
  }
}

main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
