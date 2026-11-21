// Module 11 - Phase 6: the HTTP API (generation runs + timetable versions), against the real database and the real Fastify app.
//
// The app is built with buildApp() and driven with app.inject() (the real routes, real auth middleware, real sessions created
// by the production login service, real Zod/Swagger wiring). Runners are created by the tests and registered through the same
// handle server.ts uses, so "the runner is triggered" is observed on the real seam. Everything is created under test schools
// and removed at the end; the proof compares all pre-existing tables with their starting fingerprints.
import 'dotenv/config'; // first: the database pool is created when a module imports src/config/database.ts
import './test-fixtures/test-security-env.js'; // a test-only COOKIE_SECRET (production mode refuses the placeholder in .env)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildApp } from './src/app.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { loadGenerationSnapshot } from './src/modules/timetable-generation/timetable-generation.loader.js';
import { normalizeProblem } from './src/modules/timetable-generation/timetable-generation.normalizer.js';
import { GenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner.js';
import { registerGenerationRunner } from './src/modules/timetable-generation/timetable-generation.runner-handle.js';
import { timetableGenerationService } from './src/modules/timetable-generation/timetable-generation.service.js';
import { timetableVersionService } from './src/modules/timetable-version/timetable-version.service.js';
import { DEFAULT_TIME_POLICY } from './src/modules/timetable-generation/timetable-generation.time-policy.js';
import { REPO_ROOT, resolveSolverClientConfig, SubprocessSolverClient, type SolverClient } from './src/modules/timetable-generation/timetable-generation.solver-client.js';
import { validateEntries } from './src/modules/timetable-generation/timetable-generation.validator.js';
import { type TimetableEntryRow } from './src/modules/timetable-generation/timetable-generation.contracts.js';
import {
  assertQueueIsEmpty, captureLogger, createWorld, destroyWorld, EXISTING_TABLES, fastConfig, fingerprint, getRun, newTableCounts, prisma, rawPrisma,
  ScriptedSolver, seedYear, solution, waitFor, waitTerminal, type SeededYear, type World,
} from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);

const FAKE = path.join(REPO_ROOT, 'test-fixtures', 'timetable-generation', 'fake-solvers', 'fake_solver.py');
const PASSWORD = 'Api#Test-Pass-2030';
const UUID0 = '00000000-0000-4000-8000-000000000000';
const TIGHT = { sections: 3, subjects: [6, 6, 6, 6, 5] }; // 29 of 30 weekly slots: the real solve takes seconds

const solverProcesses = (): string[] => spawnSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(`${REPO_ROOT}/solver/main.py`) && !l.includes('ps -axo'));

async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();
  const app = await buildApp();
  await app.ready();
  const worldA = await createWorld('M11AP');
  await new Promise((r) => setTimeout(r, 5));
  const worldB = await createWorld('M11AP');
  const worlds = [worldA, worldB];
  const runners: GenerationRunner[] = [];

  interface Reply { status: number; body: Record<string, any>; headers: Record<string, any>; text: string }
  const call = async (method: 'GET' | 'POST' | 'DELETE', url: string, cookie: string | null, payload?: unknown): Promise<Reply> => {
    const res = await app.inject({
      method, url, ...(cookie ? { headers: { cookie: `session_token=${cookie}` } } : {}),
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    let body: Record<string, any> = {};
    try { body = JSON.parse(res.body); } catch { /* not JSON */ }
    return { status: res.statusCode, body, headers: res.headers, text: res.body };
  };
  const sessionFor = async (world: World): Promise<string> => {
    const admin = await prisma.admin.findUniqueOrThrow({ where: { id: world.adminId } });
    await prisma.admin.update({ where: { id: admin.id }, data: { passwordHash: await hashPassword(PASSWORD) } });
    // the production login service (the route-level rate limiter is a separate middleware and is not involved here)
    return (await adminService.loginAdmin({ schoolId: world.schoolId, email: admin.email, password: PASSWORD })).sessionToken;
  };
  const tokA = await sessionFor(worldA);
  const tokB = await sessionFor(worldB);

  // hint spy on the real seam: records every trigger; optionally forwards to a real runner
  let triggers = 0;
  let forwardTo: GenerationRunner | null = null;
  registerGenerationRunner({ trigger: () => { triggers++; forwardTo?.trigger(); } });
  const makeRunner = (solver: SolverClient, policyLe10 = 15): GenerationRunner => {
    const { logger } = captureLogger();
    const r = new GenerationRunner({ prisma: rawPrisma, solverClient: solver, config: fastConfig(), policy: { ...DEFAULT_TIME_POLICY, le10: policyLe10 }, logger });
    runners.push(r);
    return r;
  };
  const fakeClient = (mode: string, over: { python?: string } = {}): SubprocessSolverClient =>
    new SubprocessSolverClient(resolveSolverClientConfig({}, { entrypointPath: FAKE, entrypointArgs: [mode, `api-suite-${mode}`], cwd: path.dirname(FAKE), killGraceMs: 300, terminateWaitMs: 400, ...(over.python ? { pythonPath: over.python } : {}) }));
  const deactivateAll = async (): Promise<void> => {
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now(), "leaseOwner" = NULL WHERE "status" IN ('QUEUED','RUNNING')`;
  };
  const mkYear = (world: World, tag: string, o: Parameters<typeof seedYear>[2] = {}): Promise<SeededYear> => seedYear(world, tag, o);
  const post = (tok: string | null, yearId: string | undefined, options?: unknown): Promise<Reply> =>
    call('POST', '/api/timetable-generations', tok, { ...(yearId !== undefined ? { academicYearId: yearId } : {}), ...(options !== undefined ? { options } : {}) });
  const problemOf = async (world: World, y: SeededYear) => { const n = normalizeProblem(await loadGenerationSnapshot(rawPrisma, world.schoolId, y.yearId)); if (!n.ok) throw new Error('not normalisable'); return n.problem; };

  try {
    // ===================================================================================================================
    section('1. Authentication: every endpoint requires an admin session');
    {
      const yA = await mkYear(worldA, 'auth');
      const endpoints: Array<['GET' | 'POST' | 'DELETE', string]> = [
        ['POST', '/api/timetable-generations'], ['GET', `/api/timetable-generations/${UUID0}`], ['GET', `/api/timetable-generations?academicYearId=${yA.yearId}`],
        ['GET', `/api/timetable-versions?academicYearId=${yA.yearId}`], ['GET', `/api/timetable-versions/${UUID0}`], ['DELETE', `/api/timetable-versions/${UUID0}`],
      ];
      for (const [m, u] of endpoints) {
        const none = await call(m, u, null, m === 'POST' ? { academicYearId: yA.yearId } : undefined);
        check(`${m} ${u.split('?')[0]!.replace(UUID0, ':id')} without a session: 401 in the standard envelope`, none.status === 401 && none.body.success === false && typeof none.body.message === 'string', `${none.status}`);
        const bad = await call(m, u, 'not-a-real-session-token', m === 'POST' ? { academicYearId: yA.yearId } : undefined);
        check(`${m} ${u.split('?')[0]!.replace(UUID0, ':id')} with an invalid session: 401`, bad.status === 401, `${bad.status}`);
      }
      check('nothing was queued by the unauthenticated requests', (await prisma.timetableGenerationRun.count({ where: { schoolId: worldA.schoolId } })) === 0);
    }

    // ===================================================================================================================
    section('2. POST /timetable-generations: request validation (400)');
    {
      const y = await mkYear(worldA, 'val');
      const cases: Array<[string, unknown, string]> = [
        ['malformed academicYearId', { academicYearId: 'not-a-uuid' }, 'academicYearId'],
        ['missing academicYearId', {}, 'academicYearId'],
        ['academicYearId is a number', { academicYearId: 5 }, 'academicYearId'],
        ['seed is a fraction', { academicYearId: y.yearId, options: { seed: 1.5 } }, 'options.seed'],
        ['seed is negative', { academicYearId: y.yearId, options: { seed: -1 } }, 'options.seed'],
        ['seed is above 2147483647', { academicYearId: y.yearId, options: { seed: 2_147_483_648 } }, 'options.seed'],
        ['seed is a string', { academicYearId: y.yearId, options: { seed: '7' } }, 'options.seed'],
        ['reproducible is a string', { academicYearId: y.yearId, options: { reproducible: 'yes' } }, 'options.reproducible'],
        ['options is not an object', { academicYearId: y.yearId, options: 5 }, 'options'],
        ['an arbitrary timeout is not accepted (timeLimitSeconds)', { academicYearId: y.yearId, options: { timeLimitSeconds: 600 } }, 'options'],
        ['an arbitrary timeout is not accepted (timeLimit)', { academicYearId: y.yearId, options: { timeLimit: 1 } }, 'options'],
        ['a worker count is not accepted', { academicYearId: y.yearId, options: { workers: 64 } }, 'options'],
        ['solver process controls are not accepted (python)', { academicYearId: y.yearId, options: { python: '/bin/sh' } }, 'options'],
        ['solver process controls are not accepted (args)', { academicYearId: y.yearId, options: { args: ['-c', 'id'] } }, 'options'],
      ];
      for (const [name, payload, field] of cases) {
        const r = await call('POST', '/api/timetable-generations', tokA, payload);
        const errors = r.body.errors as Record<string, string[]> | undefined;
        check(`${name}: 400 with a field-level error`, r.status === 400 && r.body.success === false && errors !== undefined && Object.keys(errors).some((k) => k === field || k.startsWith(`${field}`)), `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      }
      const noBody = await app.inject({ method: 'POST', url: '/api/timetable-generations', headers: { cookie: `session_token=${tokA}` } });
      check('no body at all: 400', noBody.statusCode === 400, `${noBody.statusCode}`);
      const text = await app.inject({ method: 'POST', url: '/api/timetable-generations', headers: { cookie: `session_token=${tokA}`, 'content-type': 'application/json' }, payload: '{not json' });
      check('malformed JSON: 400', text.statusCode === 400, `${text.statusCode}`);
      check('no run was created by any rejected request', (await prisma.timetableGenerationRun.count({ where: { schoolId: worldA.schoolId } })) === 0);
      check('the runner was never triggered by a rejected request', triggers === 0, String(triggers));
    }

    // ===================================================================================================================
    section('3. POST /timetable-generations: academic-year state and ownership');
    {
      const draftNotReady = await mkYear(worldA, 'notready');
      // no explicit teacher AND nobody eligible for that subject (explicit assignments are optional; a subject nobody may teach is not)
      await prisma.sectionSubjectTeacher.delete({ where: { id: draftNotReady.assignmentIds[0]! } });
      await prisma.teacherSubjectGrade.deleteMany({ where: { id: { in: [draftNotReady.eligibilityIds[0]!, draftNotReady.spareEligibilityId] } } });
      const nr = await post(tokA, draftNotReady.yearId);
      check('a DRAFT year that is NOT_READY (no explicit teacher and no eligible teacher): 400 with the readiness errors in data', nr.status === 400 && nr.body.success === false && nr.body.data?.status === 'NOT_READY' && Array.isArray(nr.body.data?.errors) && nr.body.data.errors.some((e: any) => e.code === 'NO_ELIGIBLE_TEACHER'), `${nr.status} ${nr.text.slice(0, 200)}`);
      check('...bounded: at most 50 errors are returned', (nr.body.data?.errors?.length ?? 99) <= 50);

      const active = await mkYear(worldA, 'active');
      await prisma.academicYear.update({ where: { id: active.yearId }, data: { status: 'ACTIVE' } });
      const a = await post(tokA, active.yearId);
      check('an ACTIVE academic year is rejected: 400', a.status === 400 && /DRAFT/.test(a.body.message), `${a.status} ${a.body.message}`);
      const completed = await mkYear(worldA, 'completed');
      await prisma.academicYear.update({ where: { id: completed.yearId }, data: { status: 'COMPLETED' } });
      const c = await post(tokA, completed.yearId);
      check('a COMPLETED academic year is rejected: 400', c.status === 400 && /DRAFT/.test(c.body.message), `${c.status} ${c.body.message}`);

      const foreign = await mkYear(worldB, 'foreign');
      const f = await post(tokA, foreign.yearId);
      check('a foreign academic year: 403', f.status === 403, `${f.status}`);
      check('...the message does not contain the foreign id, name or school', !f.text.includes(foreign.yearId) && !f.text.includes(worldB.schoolId) && !f.text.includes('M11AP'), f.text);
      const unknown = await post(tokA, UUID0);
      check('an unknown academic year: 404', unknown.status === 404, `${unknown.status}`);
      const smuggle = await call('POST', '/api/timetable-generations', tokA, { academicYearId: foreign.yearId, schoolId: worldB.schoolId });
      check('a client-supplied schoolId is ignored: the foreign year is still 403', smuggle.status === 403, `${smuggle.status}`);

      check('none of these requests created a run or triggered the runner', (await prisma.timetableGenerationRun.count({ where: { schoolId: { in: [worldA.schoolId, worldB.schoolId] } } })) === 0 && triggers === 0);
    }

    // ===================================================================================================================
    section('4. POST /timetable-generations: accepted (202), queued, the runner is hinted, nothing is solved in the request');
    let acceptedRunId = '';
    let acceptedYear: SeededYear;
    {
      acceptedYear = await mkYear(worldA, 'accept');
      const calls = { spawn: 0 };
      const t0 = Date.now();
      const r = await post(tokA, acceptedYear.yearId, { seed: 123456, reproducible: true });
      const took = Date.now() - t0;
      acceptedRunId = r.body.data?.generationRunId ?? '';
      check('a valid DRAFT year: 202 Accepted', r.status === 202 && r.body.success === true, `${r.status} ${r.text.slice(0, 200)}`);
      check('Location header points at the new run', r.headers.location === `/api/timetable-generations/${acceptedRunId}`, String(r.headers.location));
      check('the response names the run, the year, status QUEUED and echoes the options', r.body.data?.academicYearId === acceptedYear.yearId && r.body.data?.status === 'QUEUED' && r.body.data?.seed === 123456 && r.body.data?.reproducible === true && r.body.data?.sectionCount === 3, JSON.stringify(r.body.data));
      check('the stored time limit is the server policy (3 sections: 10 s), not client-controlled', r.body.data?.timeLimitSeconds === 10, JSON.stringify(r.body.data));
      const row = await getRun(acceptedRunId);
      check('the run row is QUEUED, attempt 0, no lease, no version, school and requester from the session', row.status === 'QUEUED' && row.attempts === 0 && row.leaseOwner === null && row.versionId === null && row.schoolId === worldA.schoolId && row.requestedById === worldA.adminId, JSON.stringify({ s: row.status, a: row.attempts }));
      check('the options are stored for the run (seed, reproducible)', JSON.stringify(row.options) === JSON.stringify({ seed: 123456, reproducible: true }) || (row.options as any)?.seed === 123456, JSON.stringify(row.options));
      check('the runner was hinted exactly once', triggers === 1, String(triggers));
      check('no solver process was started by the request', solverProcesses().length === 0 && calls.spawn === 0);
      check('no version or entry exists: the request did not solve anything', (await prisma.timetableVersion.count({ where: { academicYearId: acceptedYear.yearId } })) === 0 && (await prisma.timetableEntry.count({ where: { version: { academicYearId: acceptedYear.yearId } } })) === 0);
      check(`the response came back fast (${took} ms), not after a solve`, took < 5_000, `${took}`);
      const stillQueued = await getRun(acceptedRunId);
      check('and the run is still QUEUED a moment later (no hidden worker in the request)', stillQueued.status === 'QUEUED');

      // ---- 409: already QUEUED
      const dupQueued = await post(tokA, acceptedYear.yearId);
      check('a second request for the same year while QUEUED: 409 with the existing run id', dupQueued.status === 409 && dupQueued.body.success === false && dupQueued.body.data?.existingRunId === acceptedRunId, `${dupQueued.status} ${dupQueued.text.slice(0, 200)}`);
      check('...and the runner is not hinted for a rejected request', triggers === 1, String(triggers));
      // ---- 409: already RUNNING
      const token = 'api-suite-token';
      const claimed = await new GenerationRunner({ prisma: rawPrisma, solverClient: new ScriptedSolver(() => { throw new Error('never'); }), config: fastConfig() }).repo.claimNext(token, 60);
      check('(setup) the run is claimed: RUNNING', claimed?.id === acceptedRunId && (await getRun(acceptedRunId)).status === 'RUNNING');
      const dupRunning = await post(tokA, acceptedYear.yearId);
      check('a second request for the same year while RUNNING: 409', dupRunning.status === 409 && dupRunning.body.data?.existingRunId === acceptedRunId, `${dupRunning.status}`);
      check('only one active run exists for the year', (await prisma.timetableGenerationRun.count({ where: { academicYearId: acceptedYear.yearId, status: { in: ['QUEUED', 'RUNNING'] } } })) === 1);
      const dupForeign = await post(tokB, acceptedYear.yearId);
      check('another school cannot learn the existing run id: 403 with no data', dupForeign.status === 403 && dupForeign.body.data === undefined && !dupForeign.text.includes(acceptedRunId), dupForeign.text);
      await deactivateAll();
      const again = await post(tokA, acceptedYear.yearId);
      check('once the run is finished, a new generation is accepted (the year lock was released)', again.status === 202, `${again.status}`);
      await deactivateAll();
    }

    // ===================================================================================================================
    section('5. POST /timetable-generations: reproducible option consistency, default seed, queue limit (503)');
    {
      const y = await mkYear(worldA, 'opts');
      const noOpts = await post(tokA, y.yearId);
      check('no options: accepted with a server-chosen seed in range and reproducible=false', noOpts.status === 202 && Number.isInteger(noOpts.body.data?.seed) && noOpts.body.data.seed >= 0 && noOpts.body.data.seed <= 2_147_483_647 && noOpts.body.data?.reproducible === false, JSON.stringify(noOpts.body.data));
      await deactivateAll();
      const repro = await post(tokA, y.yearId, { reproducible: true });
      check('reproducible=true without a seed: accepted, a seed is chosen and returned so the run can be repeated', repro.status === 202 && repro.body.data?.reproducible === true && Number.isInteger(repro.body.data?.seed), JSON.stringify(repro.body.data));
      const reproRow = await getRun(repro.body.data.generationRunId);
      check('what is stored equals what was returned', (reproRow.options as any).seed === repro.body.data.seed && (reproRow.options as any).reproducible === true);
      await deactivateAll();
      const seed0 = await post(tokA, y.yearId, { seed: 0, reproducible: false });
      check('seed 0 and the maximum seed are valid', seed0.status === 202 && seed0.body.data?.seed === 0, `${seed0.status}`);
      await deactivateAll();
      const seedMax = await post(tokA, y.yearId, { seed: 2_147_483_647 });
      check('seed 2147483647 is valid', seedMax.status === 202 && seedMax.body.data?.seed === 2_147_483_647, `${seedMax.status}`);
      await deactivateAll();

      // queue full: the queue is shared by all schools; limit it to 1 through the same environment variable the runner reads
      const y2 = await mkYear(worldA, 'queue2');
      const y3 = await mkYear(worldB, 'queue3');
      process.env.SOLVER_QUEUE_MAX = '1';
      try {
        const first = await post(tokA, y2.yearId);
        const full = await post(tokB, y3.yearId);
        check('queue limit reached (limit 1): the next request, even from another school, gets 503', first.status === 202 && full.status === 503 && full.body.success === false, `${first.status} ${full.status} ${full.text.slice(0, 160)}`);
        check('...with a Retry-After header and without queue counts in the body', typeof full.headers['retry-after'] === 'string' && !/\d/.test(String(full.body.message)), `${full.headers['retry-after']} ${full.body.message}`);
        check('...and nothing was created for the rejected request', (await prisma.timetableGenerationRun.count({ where: { academicYearId: y3.yearId } })) === 0);
        await deactivateAll();
        const afterDrain = await post(tokB, y3.yearId);
        check('after the queue drains the same request is accepted', afterDrain.status === 202, `${afterDrain.status}`);
      } finally {
        delete process.env.SOLVER_QUEUE_MAX;
        await deactivateAll();
      }
    }

    // ===================================================================================================================
    section('6. GET /timetable-generations/:id');
    {
      const y = await mkYear(worldA, 'get');
      const q = await post(tokA, y.yearId, { seed: 7 });
      const id: string = q.body.data.generationRunId;
      const queued = await call('GET', `/api/timetable-generations/${id}`, tokA);
      const run = queued.body.data;
      check('own run, QUEUED: 200 with the approved fields', queued.status === 200 && run.id === id && run.academicYearId === y.yearId && run.status === 'QUEUED' && run.attempts === 0 && run.seed === 7 && run.reproducible === false && run.sectionCount === 3 && run.timeLimitSeconds === 10 && typeof run.workers === 'number', queued.text.slice(0, 300));
      check('QUEUED: createdAt/updatedAt set, no startedAt/completedAt, no versionId, no result, no failure', typeof run.createdAt === 'string' && typeof run.updatedAt === 'string' && run.startedAt === null && run.completedAt === null && run.versionId === null && run.result === null && run.failure === null);

      const token = 'api-suite-get-token';
      await new GenerationRunner({ prisma: rawPrisma, solverClient: new ScriptedSolver(() => { throw new Error('never'); }), config: fastConfig() }).repo.claimNext(token, 60);
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "phase" = 'SOLVING' WHERE "id" = ${id}`;
      const running = (await call('GET', `/api/timetable-generations/${id}`, tokA)).body.data;
      check('RUNNING: status, phase, attempts 1 and startedAt are reported', running.status === 'RUNNING' && running.phase === 'SOLVING' && running.attempts === 1 && typeof running.startedAt === 'string' && running.completedAt === null, JSON.stringify(running).slice(0, 300));
      const runningText = (await call('GET', `/api/timetable-generations/${id}`, tokA)).text;
      check('the lease owner token, lease times and heartbeat are never exposed', !runningText.includes(token) && !/leaseOwner|leaseExpiresAt|heartbeatAt|requestedById|schoolId|inputHash/.test(runningText), runningText.slice(0, 300));

      // FAILED with diagnostics that contain operator-only detail
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'SOLVER_CRASHED', "failureMessage" = 'The solver process exited with code 3',
        "failureDiagnostics" = ${JSON.stringify({ process: { pid: 4242, exitCode: 3, signal: null, durationMs: 120, stderrTail: 'Traceback /Users/secret/path/solver.py line 9', stdin: { bytes: 10 } }, problems: [{ code: 'X', message: 'm' }], error: 'ECONNRESET postgres://user:pw@host/db', leaseOwner: token })}::jsonb,
        "leaseOwner" = NULL, "finishedAt" = now() WHERE "id" = ${id}`;
      const failedRes = await call('GET', `/api/timetable-generations/${id}`, tokA);
      const failed = failedRes.body.data;
      check('FAILED: code, message and completedAt are reported', failed.status === 'FAILED' && failed.failure?.code === 'SOLVER_CRASHED' && /exited with code 3/.test(failed.failure?.message) && typeof failed.completedAt === 'string' && failed.result === null && failed.versionId === null, failedRes.text.slice(0, 300));
      check('FAILED: useful diagnostics survive (exit code, problems)', failed.failure?.diagnostics?.process?.exitCode === 3 && failed.failure?.diagnostics?.problems?.[0]?.code === 'X');
      check('FAILED: pid, stderr tail, paths, connection strings and tokens are scrubbed', !/4242|stderrTail|Traceback|\/Users\/secret|postgres:\/\/|ECONNRESET|api-suite-get-token|leaseOwner/.test(failedRes.text), failedRes.text.slice(0, 400));
      // oversized diagnostics stay bounded
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "failureDiagnostics" = ${JSON.stringify({ problems: Array.from({ length: 500 }, (_, i) => ({ code: 'P', message: 'x'.repeat(2000), i })) })}::jsonb WHERE "id" = ${id}`;
      const big = await call('GET', `/api/timetable-generations/${id}`, tokA);
      check('very large stored diagnostics are bounded in the response', big.status === 200 && big.text.length < 40_000, `${big.text.length}`);

      // SUCCEEDED
      await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'SUCCEEDED'::"TimetableRunStatus", "failureCode" = NULL, "failureMessage" = NULL, "failureDiagnostics" = NULL, "phase" = 'DONE',
        "resultSummary" = ${JSON.stringify({ solverStatus: 'FEASIBLE', solutionSource: 'CP_SAT', optimal: false, fallbackReason: null, runtimeSeconds: 1.5, weightedObjective: 12, inputHash: 'abc', versionId: UUID0, versionNumber: 1, entryCount: 36 })}::jsonb WHERE "id" = ${id}`;
      const ok = (await call('GET', `/api/timetable-generations/${id}`, tokA)).body.data;
      check('SUCCEEDED: result summary (solverStatus, solutionSource, optimal, runtime, objective) and no failure', ok.status === 'SUCCEEDED' && ok.result?.solverStatus === 'FEASIBLE' && ok.result?.solutionSource === 'CP_SAT' && ok.result?.optimal === false && ok.result?.runtimeSeconds === 1.5 && ok.failure === null, JSON.stringify(ok).slice(0, 300));
      check('SUCCEEDED: the internal input hash is not part of the result', ok.result?.inputHash === undefined);

      // ownership and validation
      const foreign = await call('GET', `/api/timetable-generations/${id}`, tokB);
      check('a run of another school: 403, and the body reveals nothing about it', foreign.status === 403 && !foreign.text.includes(id) && !foreign.text.includes(y.yearId) && !foreign.text.includes('SOLVER_CRASHED'), foreign.text);
      check('an unknown run: 404', (await call('GET', `/api/timetable-generations/${UUID0}`, tokA)).status === 404);
      check('a malformed id: 400 in the standard envelope', (await call('GET', '/api/timetable-generations/not-a-uuid', tokA)).status === 400);
      await deactivateAll();
    }

    // ===================================================================================================================
    section('7. GET /timetable-generations?academicYearId= (list)');
    {
      const y = await mkYear(worldA, 'list');
      const yOther = await mkYear(worldA, 'list-other');
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await post(tokA, y.yearId, { seed: i });
        ids.push(r.body.data.generationRunId);
        await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "id" = ${r.body.data.generationRunId}`;
        await new Promise((res) => setTimeout(res, 25));
      }
      const otherRun = await post(tokA, yOther.yearId);
      await deactivateAll();
      const list = await call('GET', `/api/timetable-generations?academicYearId=${y.yearId}`, tokA);
      const got: string[] = (list.body.data ?? []).map((r: any) => r.id);
      check('lists exactly the runs of the requested year, newest first', list.status === 200 && got.length === 3 && JSON.stringify(got) === JSON.stringify([...ids].reverse()), `${list.status} ${JSON.stringify(got)}`);
      check('runs of another year of the same school are not mixed in', !got.includes(otherRun.body.data.generationRunId));
      const limited = await call('GET', `/api/timetable-generations?academicYearId=${y.yearId}&limit=2`, tokA);
      check('limit is honoured (newest two)', limited.body.data?.length === 2 && limited.body.data[0].id === ids[2], JSON.stringify(limited.body.data?.map((r: any) => r.id)));
      check('limit 0 / 101 / abc: 400', (await call('GET', `/api/timetable-generations?academicYearId=${y.yearId}&limit=0`, tokA)).status === 400 && (await call('GET', `/api/timetable-generations?academicYearId=${y.yearId}&limit=101`, tokA)).status === 400 && (await call('GET', `/api/timetable-generations?academicYearId=${y.yearId}&limit=abc`, tokA)).status === 400);
      const empty = await mkYear(worldA, 'list-empty');
      const e = await call('GET', `/api/timetable-generations?academicYearId=${empty.yearId}`, tokA);
      check('a year with no runs: 200 and an empty list', e.status === 200 && Array.isArray(e.body.data) && e.body.data.length === 0);
      const foreignYear = await call('GET', `/api/timetable-generations?academicYearId=${y.yearId}`, tokB);
      check('a foreign academic year: 403 and no run is disclosed', foreignYear.status === 403 && !foreignYear.text.includes(ids[0]!), foreignYear.text);
      check('an unknown academic year: 404; missing / malformed: 400', (await call('GET', `/api/timetable-generations?academicYearId=${UUID0}`, tokA)).status === 404 && (await call('GET', '/api/timetable-generations', tokA)).status === 400 && (await call('GET', '/api/timetable-generations?academicYearId=zzz', tokA)).status === 400);
      const bList = await call('GET', `/api/timetable-generations?academicYearId=${(await mkYear(worldB, 'list-b')).yearId}`, tokB);
      check('the other school sees only its own (empty) list', bList.status === 200 && bList.body.data.length === 0);
    }

    // ===================================================================================================================
    section('8. REAL end-to-end through the API: POST -> 202 -> poll RUNNING -> SUCCEEDED -> version -> valid timetable (real Python)');
    let e2eVersionId = '';
    let e2eYear: SeededYear;
    {
      e2eYear = await mkYear(worldA, 'e2e', TIGHT);
      const runner = makeRunner(new SubprocessSolverClient(resolveSolverClientConfig({}, {})), 10);
      forwardTo = runner;
      runner.start();
      const t0 = Date.now();
      const r = await post(tokA, e2eYear.yearId, { seed: 99 });
      const postMs = Date.now() - t0;
      const id: string = r.body.data.generationRunId;
      // asynchronous means the run is still waiting or solving when we look (the solve of this tight year takes seconds); the ceiling only guards against the request waiting for it
      const justAfter = (await call('GET', `/api/timetable-generations/${id}`, tokA)).body.data;
      check('POST returns 202 promptly while the solve has not happened yet', r.status === 202 && postMs < 8_000 && ['QUEUED', 'RUNNING'].includes(justAfter?.status), `${r.status} ${postMs} ms, run ${justAfter?.status}`);
      const seen = new Set<string>();
      const phases = new Set<string>();
      let last: any = null;
      await waitFor(async () => {
        last = (await call('GET', `/api/timetable-generations/${id}`, tokA)).body.data;
        seen.add(last.status);
        if (last.phase) phases.add(last.phase);
        return last.status === 'SUCCEEDED' || last.status === 'FAILED';
      }, 120_000, 120);
      check(`polling observed the lifecycle ${[...seen].join(' -> ')}`, seen.has('RUNNING') && last.status === 'SUCCEEDED', `${[...seen].join(',')} ${last?.status} ${JSON.stringify(last?.failure)}`);
      check(`phases were reported while running (${[...phases].join(', ')})`, phases.has('SOLVING') || phases.size >= 2);
      check('the run carries the version id, result summary and timing', typeof last.versionId === 'string' && last.result?.solutionSource === 'CP_SAT' && ['OPTIMAL', 'FEASIBLE'].includes(last.result?.solverStatus) && typeof last.startedAt === 'string' && typeof last.completedAt === 'string' && last.attempts === 1, JSON.stringify(last).slice(0, 400));
      e2eVersionId = last.versionId;

      const v = await call('GET', `/api/timetable-versions/${e2eVersionId}`, tokA);
      const ver = v.body.data;
      check('GET version: DRAFT, version 1, CP_SAT, the metrics and baseline metrics are present', v.status === 200 && ver.status === 'DRAFT' && ver.versionNumber === 1 && ver.solutionSource === 'CP_SAT' && ver.metrics?.weightedObjective !== undefined && ver.baselineMetrics?.weightedObjective !== undefined && ver.weightsVersion === 'V1', v.text.slice(0, 300));
      check('GET version: exactly the expected number of entries (sections x periods per week)', ver.entries.length === 3 * (6 + 6 + 6 + 6 + 5) && ver.entryCount === ver.entries.length, `${ver.entries.length}`);

      // the timetable is really valid: the Phase 1 validator on the entries returned BY THE API, plus independent checks
      const problem = await problemOf(worldA, e2eYear);
      const assignmentOf = new Map((await prisma.sectionSubjectTeacher.findMany({ where: { id: { in: e2eYear.assignmentIds } } })).map((a) => [`${a.sectionId}|${a.subjectRequirementId}`, a]));
      const rows: TimetableEntryRow[] = ver.entries.map((e: any) => ({ assignmentId: assignmentOf.get(`${e.sectionId}|${e.subjectRequirementId}`)!.id, sectionId: e.sectionId, subjectId: e.subjectId, teacherId: e.teacherId, dayOfWeek: e.dayOfWeek, periodNumber: e.periodNumber }));
      const verdict = validateEntries(problem, rows);
      check('the Phase 1 validator accepts the timetable returned by the API', verdict.valid, JSON.stringify(verdict.problems.slice(0, 3)));
      const sectionSlots = new Set(ver.entries.map((e: any) => `${e.sectionId}|${e.dayOfWeek}|${e.periodNumber}`));
      const teacherSlots = new Set(ver.entries.map((e: any) => `${e.teacherId}|${e.dayOfWeek}|${e.periodNumber}`));
      check('independent: no section has two lessons in a slot and no teacher teaches two sections at once', sectionSlots.size === ver.entries.length && teacherSlots.size === ver.entries.length);
      const perReq = new Map<string, number>();
      for (const e of ver.entries) perReq.set(`${e.sectionId}|${e.subjectRequirementId}`, (perReq.get(`${e.sectionId}|${e.subjectRequirementId}`) ?? 0) + 1);
      const reqPeriods = new Map((await prisma.subjectRequirement.findMany({ where: { id: { in: e2eYear.requirementIds } } })).map((q) => [q.id, q.periodsPerWeek]));
      check('independent: every section gets exactly the weekly periods of every requirement, taught by its assigned teacher', [...perReq].every(([k, n]) => n === reqPeriods.get(k.split('|')[1]!)) && perReq.size === 15 && ver.entries.every((e: any) => assignmentOf.get(`${e.sectionId}|${e.subjectRequirementId}`)!.teacherId === e.teacherId));
      const days = new Set(ver.entries.map((e: any) => e.dayOfWeek));
      check('independent: lessons use only the configured working days and periods', [...days].every((d) => ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY'].includes(d as string)) && ver.entries.every((e: any) => e.periodNumber >= 1 && e.periodNumber <= 6));

      const lst = await call('GET', `/api/timetable-versions?academicYearId=${e2eYear.yearId}`, tokA);
      check('GET versions: the new version is listed without entries', lst.status === 200 && lst.body.data.length === 1 && lst.body.data[0].id === e2eVersionId && lst.body.data[0].entryCount === ver.entries.length && lst.body.data[0].entries === undefined, lst.text.slice(0, 300));
      const runs = await call('GET', `/api/timetable-generations?academicYearId=${e2eYear.yearId}`, tokA);
      check('the run list shows the finished run', runs.body.data?.length === 1 && runs.body.data[0].status === 'SUCCEEDED');
      check('no solver process remains', await waitFor(() => solverProcesses().length === 0, 8_000, 200));

      // a second generation creates version 2 and never touches version 1
      const second = await post(tokA, e2eYear.yearId, { seed: 100 });
      const secondRun = await waitTerminal(second.body.data.generationRunId, 120_000);
      const lst2 = await call('GET', `/api/timetable-versions?academicYearId=${e2eYear.yearId}`, tokA);
      check('a second generation creates version 2 (newest first); version 1 is untouched', secondRun.status === 'SUCCEEDED' && lst2.body.data.length === 2 && lst2.body.data[0].versionNumber === 2 && lst2.body.data[1].id === e2eVersionId && lst2.body.data[1].entryCount === ver.entries.length, JSON.stringify(lst2.body.data.map((x: any) => x.versionNumber)));
      forwardTo = null;
      await runner.stop(10);
    }

    // ===================================================================================================================
    section('9. REAL end-to-end: reproducible mode through the API is repeatable; UNKNOWN / watchdog -> BASELINE; faults -> FAILED');
    {
      const yR = await mkYear(worldA, 'repro');
      const runner = makeRunner(new SubprocessSolverClient(resolveSolverClientConfig({}, {})), 10);
      forwardTo = runner;
      runner.start();
      const solverInfos: string[] = [];
      const runOnce = async (): Promise<any[]> => {
        const r = await post(tokA, yR.yearId, { seed: 31337, reproducible: true });
        const run = await waitTerminal(r.body.data.generationRunId, 120_000);
        if (run.status !== 'SUCCEEDED') throw new Error(`reproducible run failed: ${run.failureCode}`);
        const v = (await call('GET', `/api/timetable-versions/${run.versionId}`, tokA)).body.data;
        const diag = (await prisma.timetableVersion.findUniqueOrThrow({ where: { id: run.versionId! }, select: { solverDiagnostics: true } })).solverDiagnostics as { process?: { timeLimitSeconds?: number }; solver?: { stoppedBy?: string; objectiveValue?: number } } | null;
        solverInfos.push(`limit=${diag?.process?.timeLimitSeconds} stoppedBy=${diag?.solver?.stoppedBy} objective=${diag?.solver?.objectiveValue}`);
        return v.entries.map((e: any) => `${e.sectionId}|${e.dayOfWeek}|${e.periodNumber}|${e.subjectId}|${e.teacherId}`).sort();
      };
      const first = await runOnce();
      const second = await runOnce();
      check('reproducible=true with the same seed and input gives the identical timetable twice', first.length > 0 && JSON.stringify(first) === JSON.stringify(second), `${first.length} vs ${second.length}; ${solverInfos.join(' | ')}`);
      forwardTo = null;
      await runner.stop(10);

      const cases: Array<[string, SolverClient, 'SUCCEEDED' | 'FAILED', string]> = [
        ['Python returns a clean UNKNOWN (no solution in budget)', fakeClient('echo'), 'SUCCEEDED', 'BASELINE'],
        ['Python hangs and is killed by the watchdog', fakeClient('hang'), 'SUCCEEDED', 'BASELINE'],
        ['Python is unavailable (interpreter missing)', fakeClient('echo', { python: '/nonexistent/bin/python3' }), 'FAILED', 'SOLVER_UNAVAILABLE'],
        ['Python crashes (exit code 3)', fakeClient('crash3'), 'FAILED', 'SOLVER_CRASHED'],
        ['Python prints malformed output', fakeClient('not-json'), 'FAILED', 'SOLVER_INVALID_OUTPUT'],
      ];
      for (const [name, client, expected, detail] of cases) {
        const y = await mkYear(worldA, 'fault');
        const rn = makeRunner(client, 8);
        forwardTo = rn;
        rn.start();
        const r = await post(tokA, y.yearId);
        const run = await waitTerminal(r.body.data.generationRunId, 90_000);
        const apiRun = (await call('GET', `/api/timetable-generations/${r.body.data.generationRunId}`, tokA)).body.data;
        if (expected === 'SUCCEEDED') {
          const v = (await call('GET', `/api/timetable-versions/${apiRun.versionId}`, tokA)).body.data;
          check(`${name}: API shows SUCCEEDED with the validated baseline (solutionSource=BASELINE, UNKNOWN)`, run.status === 'SUCCEEDED' && apiRun.status === 'SUCCEEDED' && apiRun.result?.solutionSource === detail && v?.solutionSource === detail && v?.solverStatus === 'UNKNOWN' && typeof apiRun.result?.fallbackReason === 'string' && v.entries.length === 36, `${apiRun.status} ${JSON.stringify(apiRun.result)?.slice(0, 200)} ${v?.solutionSource}`);
        } else {
          check(`${name}: API shows FAILED ${detail}, no version, no baseline fallback`, apiRun.status === 'FAILED' && apiRun.failure?.code === detail && apiRun.versionId === null && (await prisma.timetableVersion.count({ where: { academicYearId: y.yearId } })) === 0, `${apiRun.status} ${JSON.stringify(apiRun.failure)?.slice(0, 200)}`);
        }
        forwardTo = null;
        await rn.stop(5);
      }
      check('no solver process remains after the fault cases', await waitFor(() => solverProcesses().length === 0, 8_000, 200));
    }

    // ===================================================================================================================
    section('10. Phase 5 protection still applies through the API: a configuration change during generation');
    {
      const y = await mkYear(worldA, 'race');
      const solver = new ScriptedSolver(async (ctx) => {
        // the admin edits an assignment while the solver is working
        await prisma.sectionSubjectTeacher.update({ where: { id: y.assignmentIds[0]! }, data: { teacherId: y.spareTeacherId } });
        return solution(ctx.problem);
      });
      const rn = makeRunner(solver);
      forwardTo = rn;
      rn.start();
      const r = await post(tokA, y.yearId);
      const run = await waitTerminal(r.body.data.generationRunId, 60_000);
      const api = (await call('GET', `/api/timetable-generations/${r.body.data.generationRunId}`, tokA)).body.data;
      check('the run FAILED with CONFIGURATION_CHANGED (the stale timetable is not persisted)', run.status === 'FAILED' && api.failure?.code === 'CONFIGURATION_CHANGED' && api.versionId === null, `${api.status} ${JSON.stringify(api.failure)?.slice(0, 200)}`);
      check('no version or entries were created', (await prisma.timetableVersion.count({ where: { academicYearId: y.yearId } })) === 0 && (await prisma.timetableEntry.count({ where: { version: { academicYearId: y.yearId } } })) === 0);
      const again = await post(tokA, y.yearId);
      check('after the failure a new generation is accepted again', again.status === 202, `${again.status}`);
      forwardTo = null;
      await rn.stop(5);
      await deactivateAll();
    }

    // ===================================================================================================================
    section('11. Timetable versions: list, get, delete, isolation');
    {
      const y = await mkYear(worldA, 'ver');
      const rn = makeRunner(new ScriptedSolver((ctx) => solution(ctx.problem)));
      forwardTo = rn;
      rn.start();
      const ids: string[] = [];
      const runIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await post(tokA, y.yearId, { seed: i + 1 });
        const run = await waitTerminal(r.body.data.generationRunId, 60_000);
        ids.push(run.versionId!);
        runIds.push(run.id);
      }
      forwardTo = null;
      await rn.stop(5);

      const lst = await call('GET', `/api/timetable-versions?academicYearId=${y.yearId}`, tokA);
      check('list: four versions, newest first, with version numbers 4,3,2,1', lst.status === 200 && JSON.stringify(lst.body.data.map((v: any) => v.versionNumber)) === '[4,3,2,1]' && lst.body.data.every((v: any) => v.entryCount === 36 && v.status === 'DRAFT'), lst.text.slice(0, 200));
      check('list: no inputSnapshot / entries / solver diagnostics in the summaries', !/inputSnapshot|"entries"|solverDiagnostics/.test(lst.text));
      const one = await call('GET', `/api/timetable-versions/${ids[0]}`, tokA);
      check('get: 200 with entries ordered by section, day, period', one.status === 200 && one.body.data.entries.length === 36 && one.body.data.id === ids[0]);
      const e = one.body.data.entries as any[];
      const dayIdx: Record<string, number> = { MONDAY: 0, TUESDAY: 1, WEDNESDAY: 2, THURSDAY: 3, FRIDAY: 4, SATURDAY: 5, SUNDAY: 6 };
      check('get: the ordering holds', e.every((x, i) => i === 0 || e[i - 1].sectionId < x.sectionId || (e[i - 1].sectionId === x.sectionId && (dayIdx[e[i - 1].dayOfWeek]! < dayIdx[x.dayOfWeek]! || (e[i - 1].dayOfWeek === x.dayOfWeek && e[i - 1].periodNumber < x.periodNumber)))));
      check('get: the input snapshot and process internals are not exposed', !/inputSnapshot|stderrTail|"pid"|leaseOwner/.test(one.text));
      check('get: unknown 404, malformed 400, foreign 403', (await call('GET', `/api/timetable-versions/${UUID0}`, tokA)).status === 404 && (await call('GET', '/api/timetable-versions/zzz', tokA)).status === 400 && (await call('GET', `/api/timetable-versions/${ids[0]}`, tokB)).status === 403);
      const fv = await call('GET', `/api/timetable-versions/${ids[0]}`, tokB);
      check('get foreign: the body reveals nothing (no id, no metrics, no entries)', !fv.text.includes(ids[0]!) && !fv.text.includes('metrics') && !fv.text.includes('entries'), fv.text);
      check('list: foreign year 403, unknown year 404, missing 400', (await call('GET', `/api/timetable-versions?academicYearId=${y.yearId}`, tokB)).status === 403 && (await call('GET', `/api/timetable-versions?academicYearId=${UUID0}`, tokA)).status === 404 && (await call('GET', '/api/timetable-versions', tokA)).status === 400);
      const emptyYear = await mkYear(worldA, 'ver-empty');
      check('list: a year without versions gives an empty list', (await call('GET', `/api/timetable-versions?academicYearId=${emptyYear.yearId}`, tokA)).body.data.length === 0);

      // ---- delete rules
      await prisma.timetableVersion.update({ where: { id: ids[1]! }, data: { status: 'PUBLISHED', publishedAt: new Date() } }); // Phase 7A: the status/metadata CHECK requires the publish timestamp
      await prisma.timetableVersion.update({ where: { id: ids[2]! }, data: { status: 'ARCHIVED', publishedAt: new Date(), archivedAt: new Date() } });
      const delPub = await call('DELETE', `/api/timetable-versions/${ids[1]}`, tokA);
      const delArc = await call('DELETE', `/api/timetable-versions/${ids[2]}`, tokA);
      check('DELETE a PUBLISHED version: 409', delPub.status === 409 && /published/i.test(delPub.body.message), `${delPub.status} ${delPub.body.message}`);
      check('DELETE an ARCHIVED version: 409', delArc.status === 409 && /archived/i.test(delArc.body.message), `${delArc.status} ${delArc.body.message}`);
      check('...both still exist with all their entries', (await prisma.timetableVersion.count({ where: { id: { in: [ids[1]!, ids[2]!] } } })) === 2 && (await prisma.timetableEntry.count({ where: { versionId: { in: [ids[1]!, ids[2]!] } } })) === 72);
      const delForeign = await call('DELETE', `/api/timetable-versions/${ids[0]}`, tokB);
      check('DELETE a foreign version: 403 and nothing is deleted', delForeign.status === 403 && (await prisma.timetableVersion.count({ where: { id: ids[0]! } })) === 1);
      check('DELETE unknown: 404; malformed: 400', (await call('DELETE', `/api/timetable-versions/${UUID0}`, tokA)).status === 404 && (await call('DELETE', '/api/timetable-versions/zzz', tokA)).status === 400);

      const runBefore = await prisma.timetableGenerationRun.findUniqueOrThrow({ where: { id: runIds[0]! } });
      const delOk = await call('DELETE', `/api/timetable-versions/${ids[0]}`, tokA);
      check('DELETE a DRAFT version: 200', delOk.status === 200 && delOk.body.success === true, `${delOk.status} ${delOk.text}`);
      check('...the version and its entries are gone (cascade)', (await prisma.timetableVersion.count({ where: { id: ids[0]! } })) === 0 && (await prisma.timetableEntry.count({ where: { versionId: ids[0]! } })) === 0);
      check('...GET and a second DELETE of it are 404', (await call('GET', `/api/timetable-versions/${ids[0]}`, tokA)).status === 404 && (await call('DELETE', `/api/timetable-versions/${ids[0]}`, tokA)).status === 404);
      const runAfter = await prisma.timetableGenerationRun.findUniqueOrThrow({ where: { id: runIds[0]! } });
      check('the run history is intact: still SUCCEEDED, same result summary, timings, attempts and failure fields', runAfter.status === 'SUCCEEDED' && JSON.stringify(runAfter.resultSummary) === JSON.stringify(runBefore.resultSummary) && runAfter.startedAt?.getTime() === runBefore.startedAt?.getTime() && runAfter.finishedAt?.getTime() === runBefore.finishedAt?.getTime() && runAfter.attempts === runBefore.attempts && runAfter.failureCode === null && runAfter.updatedAt.getTime() === runBefore.updatedAt.getTime());
      check('...only its versionId link became null (the existing ON DELETE SET NULL)', runBefore.versionId === ids[0] && runAfter.versionId === null);
      const apiRun = (await call('GET', `/api/timetable-generations/${runIds[0]}`, tokA)).body.data;
      check('the API still reports the run as SUCCEEDED, versionId null, and result.versionId names the deleted draft', apiRun.status === 'SUCCEEDED' && apiRun.versionId === null && apiRun.result?.versionId === ids[0], JSON.stringify(apiRun).slice(0, 300));
      check('other versions and runs of the year were not affected', (await prisma.timetableVersion.count({ where: { academicYearId: y.yearId } })) === 3 && (await prisma.timetableGenerationRun.count({ where: { academicYearId: y.yearId } })) === 4);
      // a deleted version number is never reused by the unique(year, versionNumber): the next generation gets MAX+1
      const rn2 = makeRunner(new ScriptedSolver((ctx) => solution(ctx.problem)));
      forwardTo = rn2;
      rn2.start();
      const next = await post(tokA, y.yearId);
      const nextRun = await waitTerminal(next.body.data.generationRunId, 60_000);
      const nextVer = await prisma.timetableVersion.findUniqueOrThrow({ where: { id: nextRun.versionId! } });
      check('the next generation gets a version number above every existing one (5)', nextVer.versionNumber === 5, String(nextVer.versionNumber));
      forwardTo = null;
      await rn2.stop(5);
    }

    // ===================================================================================================================
    section('12. Service-level isolation (not only the routes)');
    {
      const yB = await mkYear(worldB, 'svc');
      const rnB = makeRunner(new ScriptedSolver((ctx) => solution(ctx.problem)));
      forwardTo = rnB;
      rnB.start();
      const r = await post(tokB, yB.yearId);
      const run = await waitTerminal(r.body.data.generationRunId, 60_000);
      forwardTo = null;
      await rnB.stop(5);
      const reject = async (fn: () => Promise<unknown>): Promise<number | string> => { try { await fn(); return 'resolved'; } catch (e: any) { return e.statusCode ?? 'other'; } };
      check('service.get(run of B) as school A: 403', (await reject(() => timetableGenerationService.get(worldA.schoolId, run.id))) === 403);
      check('service.list(year of B) as school A: 403', (await reject(() => timetableGenerationService.list(worldA.schoolId, yB.yearId, 10))) === 403);
      check('service.start(year of B) as school A: 403', (await reject(() => timetableGenerationService.start({ id: worldA.adminId, schoolId: worldA.schoolId }, { academicYearId: yB.yearId }))) === 403);
      check('versionService.get(version of B) as school A: 403', (await reject(() => timetableVersionService.get(worldA.schoolId, run.versionId!))) === 403);
      check('versionService.list(year of B) as school A: 403', (await reject(() => timetableVersionService.list(worldA.schoolId, yB.yearId))) === 403);
      check('versionService.delete(version of B) as school A: 403, the version survives', (await reject(() => timetableVersionService.delete(worldA.schoolId, run.versionId!))) === 403 && (await prisma.timetableVersion.count({ where: { id: run.versionId! } })) === 1);
      check('...and school B can use its own resources at service level', (await timetableGenerationService.get(worldB.schoolId, run.id)).status === 'SUCCEEDED' && (await timetableVersionService.get(worldB.schoolId, run.versionId!)).entries.length === 36);
      // school B's whole flow through the routes
      check('school B: its own run, version and lists are readable and its version deletable through the API', (await call('GET', `/api/timetable-generations/${run.id}`, tokB)).status === 200 && (await call('GET', `/api/timetable-versions?academicYearId=${yB.yearId}`, tokB)).body.data.length === 1 && (await call('DELETE', `/api/timetable-versions/${run.versionId}`, tokB)).status === 200);
      // a school-A session never reaches B's data through any combination of ids
      const bRunText = (await call('GET', `/api/timetable-generations/${run.id}`, tokA)).text;
      check('school A reading school B\'s run id gets only the generic message', !bRunText.includes(yB.yearId) && !bRunText.includes(worldB.schoolId), bRunText);
    }

    // ===================================================================================================================
    section('13. Swagger / OpenAPI: documented, consistent with the real responses');
    {
      const spec = app.swagger() as any;
      const ops: Array<{ method: string; path: string; op: any }> = [];
      for (const [p, item] of Object.entries<any>(spec.paths)) for (const [m, op] of Object.entries<any>(item)) if (['get', 'post', 'delete', 'put', 'patch'].includes(m)) ops.push({ method: m, path: p, op });
      const mine = ops.filter((o) => o.path.startsWith('/api/timetable-generations') || o.path.startsWith('/api/timetable-versions'));
      const expected = ['POST /api/timetable-generations', 'GET /api/timetable-generations', 'GET /api/timetable-generations/{id}', 'GET /api/timetable-versions', 'GET /api/timetable-versions/{id}', 'DELETE /api/timetable-versions/{id}', 'POST /api/timetable-versions/{id}/moves', 'PUT /api/timetable-versions/{id}/locks', 'GET /api/timetable-versions/{id}/timetable', 'POST /api/timetable-versions/{id}/clone', 'GET /api/timetable-versions/{id}/validation', 'POST /api/timetable-versions/{id}/publish'];
      const found = mine.map((o) => `${o.method.toUpperCase()} ${o.path}`).sort();
      check(`exactly the 12 approved operations are documented (the 6 of Phase 6, the 4 of Phase 7, the timetable view of Phase 7F-1 and the clone of Phase 7F-2): ${found.length}`, JSON.stringify(found) === JSON.stringify([...expected].sort()), found.join(' | '));
      check('every new operation has an operationId, a summary, a description and a tag', mine.every((o) => o.op.operationId && o.op.summary && o.op.description && o.op.tags?.length === 1), '');
      const allIds = ops.map((o) => o.op.operationId).filter(Boolean);
      check('operation ids are unique across the whole API', new Set(allIds).size === allIds.length, allIds.join(','));
      check('every new operation requires the session cookie (cookieAuth) and documents 401', mine.every((o) => JSON.stringify(o.op.security) === JSON.stringify([{ cookieAuth: [] }]) && o.op.responses['401']));
      check('cookieAuth is a defined security scheme', spec.components?.securitySchemes?.cookieAuth?.in === 'cookie');
      const codes = (m: string, p: string) => Object.keys(mine.find((o) => o.method === m && o.path === p)!.op.responses).sort().join(',');
      check('POST documents 202, 400, 401, 403, 404, 409, 503', codes('post', '/api/timetable-generations') === '202,400,401,403,404,409,503', codes('post', '/api/timetable-generations'));
      check('GET run documents 200, 400, 401, 403, 404', codes('get', '/api/timetable-generations/{id}') === '200,400,401,403,404');
      check('GET list documents 200, 400, 401, 403, 404', codes('get', '/api/timetable-generations') === '200,400,401,403,404');
      check('DELETE version documents 200, 400, 401, 403, 404, 409, 503 (503: the confirmed deletion of a published/archived version can time out on a lock)', codes('delete', '/api/timetable-versions/{id}') === '200,400,401,403,404,409,503');
      const postOp = mine.find((o) => o.method === 'post')!.op;
      const bodySchema = postOp.requestBody.content['application/json'].schema;
      check('POST request schema: academicYearId (uuid, required) and options {seed, reproducible, sourceVersionId (Phase 7E)} with no timeout/workers field', bodySchema.required?.includes('academicYearId') && bodySchema.properties.academicYearId.format === 'uuid' && JSON.stringify(Object.keys(bodySchema.properties.options.properties).sort()) === '["reproducible","seed","sourceVersionId"]' && bodySchema.properties.options.additionalProperties === false);
      const runSchema = mine.find((o) => o.method === 'get' && o.path === '/api/timetable-generations/{id}')!.op.responses['200'].content['application/json'].schema.properties.data;
      check('run schema documents the status enum QUEUED/RUNNING/SUCCEEDED/FAILED and the failure codes (13 in Phase 6 + LOCKS_INVALID and NO_SOLUTION_WITH_LOCKS from Phase 7E + DRAFT_LIMIT_REACHED from Phase 7F-0)', JSON.stringify(runSchema.properties.status.enum) === '["QUEUED","RUNNING","SUCCEEDED","FAILED"]' && runSchema.properties.failure.properties.code.enum.length === 16);
      const uuidParams = mine.filter((o) => o.path.includes('{id}')).every((o) => o.op.parameters.some((p: any) => p.name === 'id' && p.in === 'path' && p.required && p.schema.format === 'uuid'));
      check('the {id} path parameters are documented as required UUIDs', uuidParams);
      const qOps = mine.filter((o) => o.method === 'get' && !o.path.includes('{id}'));
      check('the academicYearId query parameters are documented as required UUIDs', qOps.every((o) => o.op.parameters.some((p: any) => p.name === 'academicYearId' && p.in === 'query' && p.required && p.schema.format === 'uuid')));

      // documented properties == the properties the API really returns (a serializer would silently drop undocumented ones)
      const apiRunFull = await prisma.timetableGenerationRun.findFirstOrThrow({ where: { schoolId: worldA.schoolId, status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' } });
      const live = (await call('GET', `/api/timetable-generations/${apiRunFull.id}`, tokA)).body.data;
      check('every field the service produces for a run is documented (and nothing documented is missing)', JSON.stringify(Object.keys(live).sort()) === JSON.stringify(Object.keys(runSchema.properties).sort()), `${Object.keys(live).sort().join(',')} vs ${Object.keys(runSchema.properties).sort().join(',')}`);
      const verSchema = mine.find((o) => o.method === 'get' && o.path === '/api/timetable-versions/{id}')!.op.responses['200'].content['application/json'].schema.properties.data;
      const liveVer = (await call('GET', `/api/timetable-versions/${e2eVersionId}`, tokA)).body.data;
      check('every field of a version (and of each entry) is documented', JSON.stringify(Object.keys(liveVer).sort()) === JSON.stringify(Object.keys(verSchema.properties).sort()) && JSON.stringify(Object.keys(liveVer.entries[0]).sort()) === JSON.stringify(Object.keys(verSchema.properties.entries.items.properties).sort()), `${Object.keys(liveVer).sort().join(',')}`);
      const listSchema = mine.find((o) => o.method === 'get' && o.path === '/api/timetable-versions')!.op.responses['200'].content['application/json'].schema.properties.data.items;
      const liveList = (await call('GET', `/api/timetable-versions?academicYearId=${e2eYear.yearId}`, tokA)).body.data[0];
      const liveListStale = (await call('GET', `/api/timetable-versions?academicYearId=${e2eYear.yearId}&includeStaleness=true`, tokA)).body.data[0];
      const documented = Object.keys(listSchema.properties).sort();
      check('every field of a version summary is documented: the default response has exactly the documented fields minus the two opt-in ones (isStale, staleReason, Phase 7F-3), and with includeStaleness=true exactly all of them', JSON.stringify(Object.keys(liveList).sort()) === JSON.stringify(documented.filter((k) => !['isStale', 'staleReason'].includes(k))) && JSON.stringify(Object.keys(liveListStale).sort()) === JSON.stringify(documented), `${Object.keys(liveList).sort().join(',')} | ${Object.keys(liveListStale).sort().join(',')}`);
      const acc = mine.find((o) => o.method === 'post')!.op.responses['202'].content['application/json'].schema.properties.data;
      const yA2 = await mkYear(worldA, 'swagger');
      const liveAcc = (await post(tokA, yA2.yearId)).body.data;
      // Phase 7E added two OPTIONAL fields that exist only when the request named a source draft; a plain generation's response is unchanged
      check('every field of the 202 response is documented (the two Phase 7E fields are documented as optional and absent from a plain generation)', JSON.stringify(Object.keys(liveAcc).sort()) === JSON.stringify(Object.keys(acc.properties).filter((k) => k !== 'sourceVersionId' && k !== 'lockedEntryCount').sort()) && ['sourceVersionId', 'lockedEntryCount'].every((k) => k in acc.properties), `${Object.keys(liveAcc).sort().join(',')}`);
      await deactivateAll();
      const docs = await app.inject({ method: 'GET', url: '/docs/json' });
      const docsJson = docs.statusCode === 200 ? JSON.parse(docs.body) : null;
      check('Swagger loads: /docs/json and the UI', docs.statusCode === 200 && !!docsJson?.paths?.['/api/timetable-generations'] && (await app.inject({ method: 'GET', url: '/docs' })).statusCode < 400, `${docs.statusCode}`);
      check('the Swagger tags list the two new tags', ['Timetable Generation', 'Timetable Version'].every((t) => spec.tags.some((x: any) => x.name === t)));
      const stale = ops.filter((o) => o.path.includes('timetable-generat') && !expected.includes(`${o.method.toUpperCase()} ${o.path}`));
      check('no stale or extra operation exists under the generation paths', stale.length === 0);
    }

    // ===================================================================================================================
    section('14. Security: nothing sensitive in any response, no controls beyond the contract');
    {
      const y = await mkYear(worldA, 'sec');
      const r = await post(tokA, y.yearId);
      const id: string = r.body.data.generationRunId;
      const row = await getRun(id);
      const sensitive = [tokA, tokB, 'passwordHash', 'leaseOwner', 'leaseExpiresAt', 'heartbeatAt', 'DATABASE_URL', 'COOKIE_SECRET', PASSWORD];
      const bodies = [r.text, (await call('GET', `/api/timetable-generations/${id}`, tokA)).text, (await call('GET', `/api/timetable-generations?academicYearId=${y.yearId}`, tokA)).text, (await call('GET', `/api/timetable-generations/${id}`, tokB)).text, (await call('DELETE', `/api/timetable-versions/${UUID0}`, tokA)).text];
      check('no response contains a session token, a password hash, a lease field, an env secret or the password', bodies.every((b) => sensitive.every((s) => !b.includes(s))));
      check('the run was queued for the session\'s school and admin only', row.schoolId === worldA.schoolId && row.requestedById === worldA.adminId);
      check('the stored worker count and time limit come from server policy', row.workers >= 1 && row.timeLimitSeconds === 10);
      const bigBody = await call('POST', '/api/timetable-generations', tokA, { academicYearId: y.yearId, options: { seed: 1 }, junk: 'x'.repeat(5_000) });
      check('an oversized / unknown top-level key cannot change the run (the existing run still blocks: 409)', bigBody.status === 409 || bigBody.status === 400, `${bigBody.status}`);
      const sqli = await call('GET', `/api/timetable-generations?academicYearId=${encodeURIComponent("' OR 1=1 --")}`, tokA);
      check('an injection string as academicYearId is a plain 400', sqli.status === 400);
      const sqli2 = await call('GET', `/api/timetable-generations/${encodeURIComponent("1; DROP TABLE timetable_generation_runs")}`, tokA);
      check('an injection string as :id is a plain 400 and the table is intact', sqli2.status === 400 && (await prisma.timetableGenerationRun.count()) >= 1);
      await deactivateAll();
    }
  } finally {
    section('15. Cleanup and proof that nothing existing changed, nothing is left running');
    forwardTo = null;
    registerGenerationRunner(null);
    for (const r of runners) { try { await r.stop(5); } catch { /* already stopped */ } }
    await app.close();
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    let deleted = 0;
    for (const w of worlds) deleted += await destroyWorld(w);
    check('exactly the two test schools were deleted (cascade)', deleted === 2, String(deleted));
    const newAfter = await newTableCounts();
    check('the new tables are back to their starting counts (no run, version or entry left)', JSON.stringify(newAfter) === JSON.stringify(newBefore), JSON.stringify({ newBefore, newAfter }));
    const after = await fingerprint();
    const unchanged = EXISTING_TABLES.filter((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h);
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, unchanged.length === EXISTING_TABLES.length, EXISTING_TABLES.filter((t) => !unchanged.includes(t)).join(','));
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11AP_' } } })) === 0);
    check('no solver process remains', solverProcesses().length === 0, solverProcesses().join(' | '));
  }
}

main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(async () => {
    await prisma.$disconnect();
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
