// Module 11 - Phase 6: the REAL server process (src/server.ts) over real HTTP: the runner is started by server.ts, a generation
// is queued through the API and completed by that runner with the real Python solver, and SIGTERM stops the server cleanly.
// Also: GENERATION_RUNNER_ENABLED=false gives an API-only instance that queues but never solves.
import 'dotenv/config';
import './test-fixtures/test-security-env.js'; // a test-only COOKIE_SECRET (production mode refuses the placeholder in .env)
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { adminService } from './src/modules/admin/admin.service.js';
import { hashPassword } from './src/utils/password.js';
import { REPO_ROOT } from './src/modules/timetable-generation/timetable-generation.solver-client.js';
import { assertQueueIsEmpty, createWorld, destroyWorld, EXISTING_TABLES, fingerprint, newTableCounts, prisma, seedYear, waitFor } from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (t: string): void => console.log(`\n── ${t} ──`);
const solverProcesses = (): string[] => spawnSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(`${REPO_ROOT}/solver/main.py`) && !l.includes('ps -axo'));

interface Server { child: ChildProcess; out: () => string; exited: Promise<{ code: number | null; signal: string | null }>; base: string }
async function startServer(port: number, env: Record<string, string>): Promise<Server> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: REPO_ROOT, env: { ...process.env, NODE_ENV: 'production', PORT: String(port), LOG_LEVEL: 'warn', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout?.on('data', (d: Buffer) => { out = (out + d.toString()).slice(-6_000); });
  child.stderr?.on('data', (d: Buffer) => { out = (out + d.toString()).slice(-6_000); });
  const exited = new Promise<{ code: number | null; signal: string | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
  const base = `http://127.0.0.1:${port}`;
  const up = await waitFor(async () => { try { return (await fetch(`${base}/health`)).ok; } catch { return false; } }, 60_000, 250);
  if (!up) throw new Error(`server did not start: ${out}`);
  return { child, out: () => out, exited, base };
}

async function main(): Promise<void> {
  await assertQueueIsEmpty();
  const before = await fingerprint();
  const newBefore = await newTableCounts();
  const world = await createWorld('M11SV');
  const admin = await prisma.admin.findUniqueOrThrow({ where: { id: world.adminId } });
  await prisma.admin.update({ where: { id: admin.id }, data: { passwordHash: await hashPassword('Srv#Test-Pass-2030') } });
  const token = (await adminService.loginAdmin({ schoolId: world.schoolId, email: admin.email, password: 'Srv#Test-Pass-2030' })).sessionToken;
  const http = async (s: Server, method: string, url: string, body?: unknown): Promise<{ status: number; body: any; headers: Headers }> => {
    const res = await fetch(`${s.base}${url}`, { method, headers: { cookie: `session_token=${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
  };
  const servers: Server[] = [];
  try {
    section('1. server.ts starts the runner; a run is queued over HTTP and completed by it (real Python)');
    const year = await seedYear(world, 'srv', { sections: 3, subjects: [6, 6, 6, 6, 5] });
    const s1 = await startServer(4123, {});
    servers.push(s1);
    check('the server started and announces the runner', /generation runner started/i.test(s1.out()), s1.out().slice(-300));
    const post = await http(s1, 'POST', '/api/timetable-generations', { academicYearId: year.yearId, options: { seed: 5 } });
    const id: string = post.body.data?.generationRunId;
    check('POST over HTTP: 202 with a Location header', post.status === 202 && post.headers.get('location') === `/api/timetable-generations/${id}`, `${post.status}`);
    const seen = new Set<string>();
    let last: any = null;
    await waitFor(async () => { last = (await http(s1, 'GET', `/api/timetable-generations/${id}`)).body.data; seen.add(last?.status); return last?.status === 'SUCCEEDED' || last?.status === 'FAILED'; }, 120_000, 150);
    check(`the server's own runner solved it: ${[...seen].join(' -> ')}`, last?.status === 'SUCCEEDED' && last?.result?.solutionSource === 'CP_SAT' && typeof last.versionId === 'string', JSON.stringify(last)?.slice(0, 300));
    const ver = await http(s1, 'GET', `/api/timetable-versions/${last.versionId}`);
    check('the version is readable over HTTP with all 87 entries', ver.status === 200 && ver.body.data.entries.length === 87, `${ver.status}`);
    const docs = await fetch(`${s1.base}/docs/json`);
    check('Swagger is served by the real server and lists the generation endpoints', docs.ok && Object.keys((await docs.json() as any).paths).filter((p) => /timetable-(generations|versions)/.test(p)).length === 10); // Phase 6: 4 paths; Phase 7 added moves, locks, validation, publish; Phase 7F-1 added the timetable view; Phase 7F-2 added the clone

    section('2. SIGTERM while a solve is running: the runner stops gracefully and the run is requeued, not lost');
    const year2 = await seedYear(world, 'srv2', { sections: 3, subjects: [6, 6, 6, 6, 5] });
    const p2 = await http(s1, 'POST', '/api/timetable-generations', { academicYearId: year2.yearId });
    const id2: string = p2.body.data.generationRunId;
    await waitFor(() => solverProcesses().length >= 1, 60_000, 100);
    check('the real Python solver is running inside the server', solverProcesses().length >= 1);
    const t0 = Date.now();
    s1.child.kill('SIGTERM');
    const exit = await s1.exited;
    check(`the server exits cleanly (code 0) on SIGTERM within the grace period (${Date.now() - t0} ms)`, exit.code === 0 && Date.now() - t0 < 30_000, JSON.stringify(exit));
    check('no solver process is left behind', await waitFor(() => solverProcesses().length === 0, 8_000, 200));
    const afterStop = await prisma.timetableGenerationRun.findUniqueOrThrow({ where: { id: id2 } });
    check('the interrupted run went back to QUEUED without consuming an attempt (attempts 0), unowned', afterStop.status === 'QUEUED' && afterStop.attempts === 0 && afterStop.leaseOwner === null, `${afterStop.status} ${afterStop.attempts}`);

    section('3. A new server instance picks the requeued run up and finishes it');
    const s2 = await startServer(4124, {});
    servers.push(s2);
    const done = await waitFor(async () => (await prisma.timetableGenerationRun.findUniqueOrThrow({ where: { id: id2 } })).status === 'SUCCEEDED', 120_000, 200);
    check('the restarted server completed the run', done);
    s2.child.kill('SIGTERM');
    check('and also exits cleanly', (await s2.exited).code === 0);

    section('4. GENERATION_RUNNER_ENABLED=false: an API-only instance queues but never solves');
    const year3 = await seedYear(world, 'srv3');
    const s3 = await startServer(4125, { GENERATION_RUNNER_ENABLED: 'false' });
    servers.push(s3);
    const p3 = await http(s3, 'POST', '/api/timetable-generations', { academicYearId: year3.yearId });
    check('POST is accepted (202)', p3.status === 202, `${p3.status}`);
    await new Promise((r) => setTimeout(r, 4_000));
    const row3 = await prisma.timetableGenerationRun.findUniqueOrThrow({ where: { id: p3.body.data.generationRunId } });
    check('the run stays QUEUED and unclaimed; no solver process exists', row3.status === 'QUEUED' && row3.attempts === 0 && solverProcesses().length === 0, row3.status);
    s3.child.kill('SIGTERM');
    check('the API-only instance exits cleanly', (await s3.exited).code === 0);
  } finally {
    section('5. Cleanup and proof that nothing existing changed, nothing is left running');
    for (const s of servers) if (s.child.exitCode === null) s.child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 1_500));
    await prisma.$executeRaw`UPDATE "timetable_generation_runs" SET "status" = 'FAILED'::"TimetableRunStatus", "failureCode" = 'NOT_READY', "finishedAt" = now() WHERE "status" IN ('QUEUED','RUNNING')`;
    check('exactly the one test school was deleted (cascade)', (await destroyWorld(world)) === 1);
    check('the new tables are back to their starting counts', JSON.stringify(await newTableCounts()) === JSON.stringify(newBefore));
    const after = await fingerprint();
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, EXISTING_TABLES.every((t) => before[t]!.n === after[t]!.n && before[t]!.h === after[t]!.h));
    check('no test school, server or solver process remains', (await prisma.school.count({ where: { code: { startsWith: 'M11SV_' } } })) === 0 && servers.every((s) => s.child.exitCode !== null || s.child.signalCode !== null) && solverProcesses().length === 0);
  }
}

main()
  .catch((e) => { fail++; console.error('UNEXPECTED ERROR', e); })
  .finally(async () => { await prisma.$disconnect(); console.log(`\nRESULT: pass=${pass} fail=${fail}`); process.exit(fail === 0 ? 0 : 1); });
