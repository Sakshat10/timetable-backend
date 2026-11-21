// Integration + unit tests for the Module 11 SolverClient (Phase 3). NO database, NO server.
//
// Uses the REAL production Python solver for the solver outcomes and a fake solver (one script, many behaviours,
// test-fixtures/timetable-generation/fake-solvers/fake_solver.py) for deterministic fault injection. Everything goes
// through the real async child_process.spawn path.
//
// Requires the solver virtualenv:  cd solver && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
// Run with   npx tsx test-timetable-generation-solver-client.ts
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CONTRACT_VERSION,
  type SolverInput,
  type SolverOptions,
} from './src/modules/timetable-generation/timetable-generation.contracts.js';
import { canonicalJson, hashJson } from './src/modules/timetable-generation/timetable-generation.hash.js';
import { buildSolverInput, type NormalizedProblem } from './src/modules/timetable-generation/timetable-generation.normalizer.js';
import { buildBaseline } from './src/modules/timetable-generation/timetable-generation.baseline.js';
import { decideOutcome, type SolverAttempt } from './src/modules/timetable-generation/timetable-generation.outcome.js';
import { validateEntries } from './src/modules/timetable-generation/timetable-generation.validator.js';
import {
  assertValidSolverRequest,
  buildSolverOptions,
  optionConsistencyIssues,
  serializeSolverRequest,
  SolverRequestError,
  validateSolverRequest,
} from './src/modules/timetable-generation/timetable-generation.solver-options.js';
import {
  classifyProcessResult,
  REPO_ROOT,
  resolveSolverClientConfig,
  SOLVER_CHILD_ENV,
  SolverAbortedError,
  SubprocessSolverClient,
  sanitizeText,
  terminateProcess,
  type SolverClientConfig,
  type SolverClientResult,
} from './src/modules/timetable-generation/timetable-generation.solver-client.js';
import { DEFAULT_TIME_POLICY, resolveDeterministicTimeLimit } from './src/modules/timetable-generation/timetable-generation.time-policy.js';

const REAL_PYTHON = path.join(REPO_ROOT, 'solver', '.venv', 'bin', 'python');
const FAKE = path.join(REPO_ROOT, 'test-fixtures', 'timetable-generation', 'fake-solvers', 'fake_solver.py');
if (!existsSync(REAL_PYTHON)) {
  console.error(`Solver virtualenv not found at ${REAL_PYTHON}. Create it first (see the header of this file).`);
  process.exit(2);
}
// CLIENT_TEST_SECTIONS=1,8 runs only those sections (used for mutation testing); unset runs everything
const WANTED = (process.env.CLIENT_TEST_SECTIONS ?? '').split(',').filter(Boolean).map(Number);
const want = (n: number): boolean => WANTED.length === 0 || WANTED.includes(n);
const RUN_ID = randomUUID().slice(0, 8);
const MARKER_PREFIX = `solver-client-test-${RUN_ID}`;

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number | null): boolean => { if (pid === null) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const processesWith = (needle: string): string[] => spawnSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(needle) && !l.includes('ps -axo'));
async function until(cond: () => boolean, ms: number): Promise<boolean> { const end = Date.now() + ms; while (Date.now() < end) { if (cond()) return true; await sleep(50); } return cond(); }

// ---------------------------------------------------------------------------
// Problem builders
// ---------------------------------------------------------------------------
const WEEK = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
type Tuple = [string, string, string, number];
const allContinue = (K: number): boolean[] => Array.from({ length: K }, (_, i) => i < K - 1);
function coreProblem(D: number, K: number, continues: boolean[], tuples: Tuple[]): NormalizedProblem {
  const W = D * K; const cap = Math.min(32, W);
  const sections = [...new Set(tuples.map((t) => t[1]))].sort(); const teachers = [...new Set(tuples.map((t) => t[2]))].sort();
  const core = {
    contractVersion: CONTRACT_VERSION,
    grid: { days: WEEK.slice(0, D).map((dayOfWeek, index) => ({ index, dayOfWeek: dayOfWeek as 'MONDAY' })), periods: continues.map((c, i) => ({ periodNumber: i + 1, continuesIntoNext: c })), maxTeacherPeriodsPerWeek: 32 },
    sections: sections.map((id) => ({ id })), teachers: teachers.map((id) => ({ id, weeklyCapacity: cap })),
    assignments: tuples.map(([id, s, t, p], i) => ({ id, sectionId: s, subjectId: `subj-${i}`, subjectRequirementId: `req-${i}`, teacherId: t, periodsPerWeek: p })),
    fixedEntries: [],
  };
  return { schoolId: 'school1', academicYear: { id: 'ay', name: 'ay' }, core, derived: { dayCount: D, periodsPerDay: K, weeklySlots: W, teacherCapacity: cap, sectionCount: sections.length, teacherCount: teachers.length, assignmentCount: tuples.length, expectedEntryCount: tuples.reduce((n, t) => n + t[3], 0) }, inputHash: hashJson(core) };
}
const opts = (over: Partial<SolverOptions> = {}): SolverOptions => ({ timeLimitSeconds: 10, seed: 1, numWorkers: 1, reproducible: false, deterministicTimeLimit: null, ...over });
const tiny = (): NormalizedProblem => coreProblem(5, 6, allContinue(6), [['a', 'S', 'T', 5]]);
const request = (problem: NormalizedProblem, options: SolverOptions = opts(), requestId = `req-${randomUUID().slice(0, 8)}`) => ({ problem, input: buildSolverInput(problem, requestId, options) });

interface Golden { cases: Array<{ name: string; dayCount: number; periodsPerDay: number; continues: boolean[]; assignments: Tuple[] }> }
const golden = JSON.parse(readFileSync(path.join(REPO_ROOT, 'test-fixtures/timetable-generation/golden-metrics.json'), 'utf8')) as Golden;
const goldenProblem = (prefix: string): NormalizedProblem => { const c = golden.cases.find((x) => x.name.startsWith(prefix))!; return coreProblem(c.dayCount, c.periodsPerDay, c.continues, c.assignments); };
function heavyTuples(nSections: number, D = 5, K = 8, seed = 5): Tuple[] {
  let s = seed >>> 0; const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out: Tuple[] = []; const demand = new Map<string, number>();
  for (let subj = 0; subj < 10; subj++) { let idx = 1; let load = 0; for (let sec = 0; sec < nSections; sec++) { const p = 1 + Math.floor(rnd() * 6); if (load + p > 32) { idx++; load = 0; } load += p; const sid = `S${String(sec).padStart(3, '0')}`; out.push([`a-${subj}-${sec}`, sid, `T-${subj}-${idx}`, p]); demand.set(sid, (demand.get(sid) ?? 0) + p); } }
  return out.filter((t) => (demand.get(t[1]) ?? 0) <= D * K);
}

// ---------------------------------------------------------------------------
// Client factories
// ---------------------------------------------------------------------------
const fakeClient = (mode: string, over: Partial<SolverClientConfig> = {}, extraArg = `${MARKER_PREFIX}-${mode}`): SubprocessSolverClient =>
  new SubprocessSolverClient(resolveSolverClientConfig({}, { entrypointPath: FAKE, entrypointArgs: [mode, extraArg], cwd: path.dirname(FAKE), killGraceMs: 300, terminateWaitMs: 400, killWaitMs: 3000, drainMs: 1000, ...over }));
const realClient = (over: Partial<SolverClientConfig> = {}): SubprocessSolverClient => new SubprocessSolverClient(resolveSolverClientConfig({}, over));
const run = (client: SubprocessSolverClient, problem = tiny(), options: SolverOptions = opts()): Promise<SolverClientResult> => client.solve(request(problem, options));
const baselineOf = (problem: NormalizedProblem) => { const b = buildBaseline(problem, 1); if (!b.ok) throw new Error('baseline'); return b.entries; };

// ===========================================================================
section('1. Option construction and boundary validation (pure)');
if (want(1)) {
  const budget = (sections: number, elapsedMs = 0, over: Partial<Parameters<typeof buildSolverOptions>[0]> = {}) => buildSolverOptions({ sectionCount: sections, elapsedMs, seed: 7, numWorkers: 4, reproducible: false, ...over });
  const r10 = budget(10); const r11 = budget(11); const r51 = budget(51); const r101 = budget(101); const r999 = budget(999);
  check('the policy budgets are 10 / 60 / 120 / 180 s', r10.ok && r10.options.timeLimitSeconds === 10 && r11.ok && r11.options.timeLimitSeconds === 60 && r51.ok && r51.options.timeLimitSeconds === 120 && r101.ok && r101.options.timeLimitSeconds === 180 && r999.ok && r999.options.timeLimitSeconds === 180);
  const spent = budget(40, 12_500);
  check('the solver receives the REMAINING budget: 60 s - 12.5 s spent = 47 s', spent.ok && spent.options.timeLimitSeconds === 47 && spent.budgetSeconds === 60);
  check('the remaining budget never exceeds the policy budget', [0, 1, 999, 30_000].every((ms) => { const r = budget(40, ms); return r.ok && r.options.timeLimitSeconds <= 60; }));
  const edge = budget(40, 59_000); const over = budget(40, 59_001); const gone = budget(40, 75_000);
  check('exactly 1 s left is still startable; less than 1 whole second is BUDGET_EXHAUSTED', edge.ok && edge.options.timeLimitSeconds === 1 && !over.ok && over.reason === 'BUDGET_EXHAUSTED' && !gone.ok && gone.remainingSeconds === 0);
  const custom = buildSolverOptions({ sectionCount: 5, elapsedMs: 0, seed: 1, numWorkers: 2, reproducible: false, policy: { ...DEFAULT_TIME_POLICY, le10: 25 } });
  check('a custom policy is honoured (and clamped to its maximum)', custom.ok && custom.options.timeLimitSeconds === 25);
  const repro = budget(40, 12_500, { reproducible: true });
  // CHANGED ON PURPOSE (reproducibility fix): the limit used to be derived from the REMAINING 47 s, which made identical inputs get different
  // search budgets depending on how long earlier database work took. It now comes from the POLICY budget (60 s for 40 sections), so the
  // remaining time (47 s) must NOT influence it. The wall-clock limit (timeLimitSeconds) still follows the remaining budget, asserted above.
  check('reproducible=true carries a deterministic limit derived from the POLICY budget (60 s), not from the remaining time (47 s)', repro.ok && repro.options.reproducible && repro.options.deterministicTimeLimit === resolveDeterministicTimeLimit(60) && repro.options.deterministicTimeLimit !== resolveDeterministicTimeLimit(47) && repro.options.timeLimitSeconds === 47);
  check('reproducible=false always carries deterministicTimeLimit=null', r10.ok && r10.options.deterministicTimeLimit === null);
  check('every option set the builder produces is consistent', [budget(3), budget(60, 1000, { reproducible: true }), budget(200, 5000, { reproducible: true })].every((r) => r.ok && optionConsistencyIssues(r.options).length === 0));
  check('a negative or non-finite elapsed time is rejected', (() => { try { budget(5, -1); return false; } catch { /* ok */ } try { budget(5, Number.NaN); return false; } catch { return true; } })());
  check('the seed and worker count pass through untouched', r10.ok && r10.options.seed === 7 && r10.options.numWorkers === 4);

  check('inconsistent: reproducible without a limit', optionConsistencyIssues(opts({ reproducible: true, deterministicTimeLimit: null })).length === 1);
  check('inconsistent: a limit without reproducible', optionConsistencyIssues(opts({ reproducible: false, deterministicTimeLimit: 5 })).length === 1);
  check('consistent combinations have no issues', optionConsistencyIssues(opts({ reproducible: true, deterministicTimeLimit: 5 })).length === 0 && optionConsistencyIssues(opts()).length === 0);

  const problem = tiny(); const good = buildSolverInput(problem, 'r1', opts());
  check('a well-formed request validates', validateSolverRequest(problem, good).length === 0);
  check('the contradictory options Zod would accept are refused at the boundary', validateSolverRequest(problem, buildSolverInput(problem, 'r1', opts({ reproducible: true, deterministicTimeLimit: null }))).length === 1 && validateSolverRequest(problem, buildSolverInput(problem, 'r1', opts({ reproducible: false, deterministicTimeLimit: 3 }))).length === 1);
  check('a Zod-invalid request is refused', validateSolverRequest(problem, { ...good, options: opts({ numWorkers: 0 }) }).length > 0 && validateSolverRequest(problem, { ...good, requestId: '' }).length > 0);
  const other = coreProblem(5, 6, allContinue(6), [['a', 'S', 'T', 4]]);
  check('a request that does not belong to the problem is refused (input hash differs)', validateSolverRequest(other, good).some((m) => m.includes('input hash')));
  check('assertValidSolverRequest throws a SolverRequestError', (() => { try { assertValidSolverRequest(problem, { ...good, requestId: '' }); return false; } catch (e) { return e instanceof SolverRequestError && e.issues.length > 0; } })());
  check('the issue list is bounded', validateSolverRequest(problem, { ...good, sections: [], teachers: [], assignments: [], weights: {} as never }).length <= 11);

  const a = serializeSolverRequest(good); const b = serializeSolverRequest(JSON.parse(JSON.stringify(good)));
  const shuffled = Object.fromEntries(Object.entries(good).reverse()) as SolverInput;
  check('request serialization is deterministic', a === b);
  check('request serialization does not depend on key order', serializeSolverRequest(shuffled) === a);
  check('the request is one compact line with a single trailing newline', a.endsWith('\n') && !a.slice(0, -1).includes('\n') && a === `${canonicalJson(good)}\n`);
  check('the serialized request parses back to the same request', canonicalJson(JSON.parse(a)) === canonicalJson(good));
}

section('2. Classification matrix (pure: no process is spawned)');
if (want(2)) {
  const problem = tiny();
  const base = { problem, requestId: 'r1', startFailure: null, exitCode: 0, signal: null, killReason: null, unkillable: false, stdout: '', outputOverflow: false, stderrTail: '' } as const;
  const cls = (over: Partial<Parameters<typeof classifyProcessResult>[0]>): SolverAttempt => classifyProcessResult({ ...base, ...over }).attempt;
  const unknownDoc = JSON.stringify({ contractVersion: '1.0', requestId: 'r1', status: 'UNKNOWN', entries: [], diagnostics: { objectiveValue: null, bestObjectiveBound: null, wallSeconds: 1, numWorkers: 1, seed: 1, ortoolsVersion: 'x', numBooleans: null, numConstraints: null, conflicts: null, branches: null, stoppedBy: 'TIME_LIMIT', messages: [] } });
  check('exit 0 + a valid UNKNOWN document -> NO_SOLUTION', cls({ stdout: unknownDoc }).kind === 'NO_SOLUTION');
  check('exit 0 + whitespace around the document -> parsed', cls({ stdout: `\n\n  ${unknownDoc}  \n\n` }).kind === 'NO_SOLUTION');
  check('start failure -> PROCESS_FAULT SOLVER_UNAVAILABLE', (() => { const a = cls({ startFailure: 'no python', exitCode: null }); return a.kind === 'PROCESS_FAULT' && a.code === 'SOLVER_UNAVAILABLE'; })());
  for (const [code, text] of [[1, ''], [2, 'could not answer'], [3, 'internal error'], [4, 'parent'], [137, '']] as const) {
    const a = cls({ exitCode: code }); check(`non-zero exit ${code} -> PROCESS_FAULT SOLVER_CRASHED ${text ? `("${text}")` : ''}`, a.kind === 'PROCESS_FAULT' && a.code === 'SOLVER_CRASHED' && a.message.includes(`code ${code}`) && (text === '' || a.message.includes(text)));
  }
  check('killed by a signal we did not send -> SOLVER_CRASHED', (() => { const a = cls({ exitCode: null, signal: 'SIGSEGV' }); return a.kind === 'PROCESS_FAULT' && a.code === 'SOLVER_CRASHED' && a.message.includes('SIGSEGV'); })());
  check('empty stdout with exit 0 -> FAULT SOLVER_INVALID_OUTPUT', (() => { const a = cls({ stdout: '  \n' }); return a.kind === 'FAULT' && a.code === 'SOLVER_INVALID_OUTPUT'; })());
  check('non-JSON stdout -> FAULT SOLVER_INVALID_OUTPUT', (() => { const a = cls({ stdout: 'hello' }); return a.kind === 'FAULT' && a.code === 'SOLVER_INVALID_OUTPUT'; })());
  check('output over the cap -> FAULT SOLVER_INVALID_OUTPUT', (() => { const a = cls({ outputOverflow: true, exitCode: null, signal: 'SIGTERM', killReason: 'OUTPUT_TOO_LARGE' }); return a.kind === 'FAULT' && a.code === 'SOLVER_INVALID_OUTPUT'; })());
  check('killed at our deadline (signal) -> KILLED_BY_WATCHDOG', cls({ exitCode: null, signal: 'SIGTERM', killReason: 'TIMEOUT' }).kind === 'KILLED_BY_WATCHDOG');
  check('killed at our deadline, SIGKILL -> KILLED_BY_WATCHDOG', cls({ exitCode: null, signal: 'SIGKILL', killReason: 'TIMEOUT' }).kind === 'KILLED_BY_WATCHDOG');
  check('killed at our deadline, then exited non-zero -> KILLED_BY_WATCHDOG', cls({ exitCode: 7, killReason: 'TIMEOUT' }).kind === 'KILLED_BY_WATCHDOG');
  check('killed at our deadline, exited 0 with no document -> KILLED_BY_WATCHDOG', cls({ exitCode: 0, killReason: 'TIMEOUT', stdout: '' }).kind === 'KILLED_BY_WATCHDOG');
  check('finished cleanly with a document just as the kill fired -> the document is used', cls({ exitCode: 0, killReason: 'TIMEOUT', stdout: unknownDoc }).kind === 'NO_SOLUTION');
  check('an unkillable process with no exit status -> KILLED_BY_WATCHDOG', cls({ exitCode: null, signal: null, killReason: 'TIMEOUT', unkillable: true }).kind === 'KILLED_BY_WATCHDOG');
  check('a crash is NEVER classified as the watchdog and the watchdog is NEVER a crash', cls({ exitCode: 3 }).kind !== 'KILLED_BY_WATCHDOG' && cls({ exitCode: null, signal: 'SIGTERM', killReason: 'TIMEOUT' }).kind !== 'PROCESS_FAULT');
  check('no process fault ever becomes UNKNOWN (NO_SOLUTION) or a result', [cls({ exitCode: 1 }), cls({ exitCode: 3 }), cls({ exitCode: null, signal: 'SIGKILL' }), cls({ startFailure: 'x' }), cls({ stdout: '' }), cls({ stdout: '{' })].every((a) => a.kind === 'PROCESS_FAULT' || a.kind === 'FAULT'));
  check('crash messages are bounded and sanitised', (() => { const a = cls({ exitCode: 3, stderrTail: `${'x'.repeat(5000)}\u0000\u001b[31m` }); return a.kind === 'PROCESS_FAULT' && a.message.length <= 501 && !/[\u0000\u001b]/.test(a.message); })());
  check('sanitizeText replaces control characters and bounds the length', sanitizeText('a\u0000b\u001bc\nd', 100) === 'a?b?c\nd' && sanitizeText('x'.repeat(50), 10).length === 11);
}

section('3. Configuration and process hygiene');
if (want(3)) {
  const cfg = resolveSolverClientConfig({});
  check('the default interpreter and entrypoint are absolute paths inside the project', path.isAbsolute(cfg.pythonPath) && cfg.pythonPath === REAL_PYTHON && cfg.entrypointPath === path.join(REPO_ROOT, 'solver', 'main.py'));
  check('the working directory is the solver directory (never the caller\'s)', cfg.cwd === path.join(REPO_ROOT, 'solver'));
  check('the default kill grace is the policy\'s 20 s', cfg.killGraceMs === 20_000);
  check('the child environment is exactly the allowlist', same(cfg.env, SOLVER_CHILD_ENV) && Object.keys(cfg.env).sort().join() === 'PATH,PYTHONDONTWRITEBYTECODE,PYTHONNOUSERSITE,PYTHONUNBUFFERED');
  check('SOLVER_KILL_GRACE_SECONDS configures the grace', resolveSolverClientConfig({ SOLVER_KILL_GRACE_SECONDS: '7' }).killGraceMs === 7000);
  check('an invalid policy value fails fast', (() => { try { resolveSolverClientConfig({ SOLVER_KILL_GRACE_SECONDS: 'abc' }); return false; } catch { return true; } })());
  const rel = resolveSolverClientConfig({ SOLVER_PYTHON: 'solver/.venv/bin/python', SOLVER_ENTRYPOINT: 'solver/main.py' });
  check('relative overrides resolve against the project root, not the current directory', rel.pythonPath === REAL_PYTHON && rel.entrypointPath === path.join(REPO_ROOT, 'solver', 'main.py'));
  const abs = resolveSolverClientConfig({ SOLVER_PYTHON: '/usr/bin/python3' });
  check('an absolute override is kept as is', abs.pythonPath === '/usr/bin/python3');

  // the same client works whatever the caller's working directory is
  const here = process.cwd();
  process.chdir('/');
  try {
    const r = await realClient().solve(request(tiny()));
    check('the real solver runs correctly when the caller\'s working directory is "/"', r.attempt.kind === 'SOLUTION' && r.info.exitCode === 0);
  } finally { process.chdir(here); }
  const cwdRun = await fakeClient('cwd').solve(request(tiny()));
  check('the child\'s working directory is the configured one', cwdRun.attempt.kind === 'NO_SOLUTION' && cwdRun.attempt.diagnostics.messages.some((m) => m === `cwd=${path.dirname(FAKE)}` || m === `cwd=${path.dirname(FAKE).replace('/private', '')}` || m.endsWith(path.basename(path.dirname(FAKE)))));

  // secrets of the application never reach the child
  const saved = { ...process.env };
  Object.assign(process.env, { DATABASE_URL: 'postgres://user:SUPERSECRETPW@db.example/neon', COOKIE_SECRET: 'cookie-secret-value', AWS_SECRET_ACCESS_KEY: 'aws-secret', MY_API_KEY: 'k-123' });
  try {
    const envRun = await fakeClient('env-dump').solve(request(tiny()));
    const names = envRun.attempt.kind === 'NO_SOLUTION' ? envRun.attempt.diagnostics.messages.map((m) => m.replace('env:', '')) : ['<failed>'];
    // the interpreter / macOS add these themselves; none comes from the application's environment
    const allowed = new Set([...Object.keys(SOLVER_CHILD_ENV), '__PYVENV_LAUNCHER__', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING']);
    check('the child sees only the allowlisted variables (plus the three the interpreter / macOS add themselves)', names.every((n) => allowed.has(n)), names.join(','));
    check('DATABASE_URL, COOKIE_SECRET and other application variables are NOT passed', !names.some((n) => ['DATABASE_URL', 'COOKIE_SECRET', 'AWS_SECRET_ACCESS_KEY', 'MY_API_KEY', 'HOME', 'USER'].includes(n)));
    check('no secret value appears anywhere in the diagnostics', !JSON.stringify(envRun.info).includes('SUPERSECRETPW') && !JSON.stringify(envRun.attempt).includes('cookie-secret-value'));
  } finally { for (const k of ['DATABASE_URL', 'COOKIE_SECRET', 'AWS_SECRET_ACCESS_KEY', 'MY_API_KEY']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }

  // no shell: metacharacters in an argument arrive literally and execute nothing
  const dir = mkdtempSync(path.join(tmpdir(), 'solver-shell-'));
  const pwn = path.join(dir, 'PWNED');
  const nasty = `$(touch ${pwn}); \`touch ${pwn}\` | touch ${pwn} && 'q' "dq" > ${pwn}`;
  const shellRun = await fakeClient('cwd', {}, nasty).solve(request(tiny()));
  check('shell metacharacters in an argument are passed literally and nothing is executed', shellRun.attempt.kind === 'NO_SOLUTION' && shellRun.attempt.diagnostics.messages.some((m) => m === `argv2=${nasty}`) && !existsSync(pwn));
  rmSync(dir, { recursive: true, force: true });
  check('the spawn call uses an argument vector and no shell (static check of the source)', (() => { const src = readFileSync(path.join(REPO_ROOT, 'src/modules/timetable-generation/timetable-generation.solver-client.ts'), 'utf8').replace(/\/\/.*$/gm, ''); return /shell:\s*false/.test(src) && !/shell:\s*true/.test(src) && !/exec(Sync)?\(|execFile|spawnSync/.test(src); })());
}

section('4. Real solver outcomes through async spawn');
if (want(4)) {
  const client = realClient();
  const optimal = await client.solve(request(tiny(), opts({ timeLimitSeconds: 20 })));
  check('OPTIMAL: a SOLUTION from CP-SAT', optimal.attempt.kind === 'SOLUTION' && optimal.attempt.status === 'OPTIMAL');
  check('OPTIMAL: the process exited 0 without a signal, was spawned, has a pid and a duration', optimal.info.exitCode === 0 && optimal.info.signal === null && optimal.info.spawned && optimal.info.pid !== null && optimal.info.durationMs > 0);
  check('OPTIMAL: solverStatus and stoppedBy are recorded, no failure code', optimal.info.solverStatus === 'OPTIMAL' && optimal.info.stoppedBy === 'OPTIMAL' && optimal.info.failureCode === null);
  check('OPTIMAL: the request was written, stdin was NOT closed by the client, nothing timed out', optimal.info.stdin.written && optimal.info.stdin.closedByClient === false && optimal.info.stdin.error === null && optimal.info.timeout.killReason === null && !optimal.info.timeout.exceededBudget);
  check('OPTIMAL: the child process is gone afterwards', !alive(optimal.info.pid));
  if (optimal.attempt.kind === 'SOLUTION') check('OPTIMAL: the entries pass the Phase 1 validator', validateEntries(tiny(), optimal.attempt.entries).valid && optimal.attempt.entries.length === 5);

  const medium = goldenProblem('s50_5d8p');
  const feasible = await client.solve(request(medium, opts({ timeLimitSeconds: 6, numWorkers: 4 })));
  check('FEASIBLE: a SOLUTION with status FEASIBLE (the normal result for a 50-section school)', feasible.attempt.kind === 'SOLUTION' && feasible.attempt.status === 'FEASIBLE');
  check('FEASIBLE: stoppedBy TIME_LIMIT and the whole run stayed inside budget + grace', feasible.info.stoppedBy === 'TIME_LIMIT' && feasible.info.durationMs < 6000 + 3000 && feasible.info.timeout.killReason === null);
  if (feasible.attempt.kind === 'SOLUTION') check('FEASIBLE: valid under the Phase 1 validator', validateEntries(medium, feasible.attempt.entries).valid);

  const unknown = await client.solve(request(medium, opts({ timeLimitSeconds: 60, numWorkers: 2, reproducible: true, deterministicTimeLimit: 0.001 })));
  check('UNKNOWN: NO_SOLUTION with stoppedBy DETERMINISTIC_LIMIT (the one outcome that may use the baseline)', unknown.attempt.kind === 'NO_SOLUTION' && unknown.info.solverStatus === 'UNKNOWN' && unknown.info.stoppedBy === 'DETERMINISTIC_LIMIT' && unknown.info.failureCode === null);
  const unknownOutcome = decideOutcome(unknown.attempt, baselineOf(medium));
  check('UNKNOWN -> decideOutcome: SUCCESS with solutionSource BASELINE', unknownOutcome.kind === 'SUCCESS' && unknownOutcome.solutionSource === 'BASELINE' && validateEntries(medium, unknownOutcome.entries).valid);

  const overloaded = coreProblem(2, 3, allContinue(3), [['a', 'S1', 'T1', 4], ['b', 'S2', 'T1', 3]]);
  const infeasible = await client.solve(request(overloaded));
  check('INFEASIBLE: classified as INFEASIBLE with the certificate in the diagnostics', infeasible.attempt.kind === 'INFEASIBLE' && infeasible.attempt.diagnostics.messages.some((m) => m.includes('teacher T1')) && infeasible.info.solverStatus === 'INFEASIBLE' && infeasible.info.stoppedBy === 'INFEASIBLE');
  check('INFEASIBLE -> decideOutcome: FAILURE INTERNAL_INCONSISTENCY, never the baseline', (() => { const o = decideOutcome(infeasible.attempt, []); return o.kind === 'FAILURE' && o.code === 'INTERNAL_INCONSISTENCY'; })());

  // a Zod-valid request the Python validator rejects (a dangling teacher): INPUT_INVALID -> SOLVER_INPUT_REJECTED
  const core = { ...tiny().core, assignments: tiny().core.assignments.map((a) => ({ ...a, teacherId: 'ghost' })) };
  const dangling: NormalizedProblem = { ...tiny(), core, inputHash: hashJson(core) };
  const rejected = await client.solve(request(dangling));
  check('INPUT_INVALID: a FAULT SOLVER_INPUT_REJECTED, recorded as the failure code', rejected.attempt.kind === 'FAULT' && rejected.attempt.code === 'SOLVER_INPUT_REJECTED' && rejected.info.failureCode === 'SOLVER_INPUT_REJECTED' && rejected.info.solverStatus === 'INPUT_INVALID');
  check('INPUT_INVALID -> decideOutcome: FAILURE', decideOutcome(rejected.attempt, baselineOf(tiny())).kind === 'FAILURE');

  // identity: output of a different request must be refused. The fake answers for another request id.
  const wrongId = await fakeClient('wrong-request-id').solve(request(tiny()));
  check('request/response identity is checked (a document for another request is a FAULT)', wrongId.attempt.kind === 'FAULT' && wrongId.attempt.code === 'SOLVER_INVALID_OUTPUT');
}

section('5. Process faults: never a baseline, never UNKNOWN');
if (want(5)) {
  const problem = tiny();
  const baseline = baselineOf(problem);
  const missingPython = new SubprocessSolverClient(resolveSolverClientConfig({}, { pythonPath: '/nonexistent/bin/python3' }));
  const missingEntry = new SubprocessSolverClient(resolveSolverClientConfig({}, { entrypointPath: '/nonexistent/solver/main.py' }));
  const dir = mkdtempSync(path.join(tmpdir(), 'solver-noexec-'));
  const notExecutable = path.join(dir, 'python'); writeFileSync(notExecutable, '#!/bin/sh\nexit 0\n'); chmodSync(notExecutable, 0o644);
  const noExec = new SubprocessSolverClient(resolveSolverClientConfig({}, { pythonPath: notExecutable }));
  const isDir = new SubprocessSolverClient(resolveSolverClientConfig({}, { pythonPath: dir }));
  for (const [name, client] of [['the Python interpreter is missing', missingPython], ['the solver entrypoint is missing', missingEntry], ['the interpreter is not executable', noExec], ['the interpreter path is a directory', isDir]] as const) {
    const t = Date.now(); const r = await client.solve(request(problem));
    check(`${name}: PROCESS_FAULT SOLVER_UNAVAILABLE, nothing spawned, fast`, r.attempt.kind === 'PROCESS_FAULT' && r.attempt.code === 'SOLVER_UNAVAILABLE' && !r.info.spawned && r.info.pid === null && r.info.failureCode === 'SOLVER_UNAVAILABLE' && Date.now() - t < 500);
    check(`${name}: -> decideOutcome FAILURE SOLVER_UNAVAILABLE (no baseline)`, (() => { const o = decideOutcome(r.attempt, baseline); return o.kind === 'FAILURE' && o.code === 'SOLVER_UNAVAILABLE'; })());
  }
  rmSync(dir, { recursive: true, force: true });
  check('SubprocessSolverClient.installationProblem reports a usable installation as null', realClient().installationProblem() === null);

  const crashRun = await fakeClient('crash3').solve(request(problem));
  check('exit code 3: SOLVER_CRASHED naming the code and the meaning, with the stderr line', crashRun.attempt.kind === 'PROCESS_FAULT' && crashRun.attempt.code === 'SOLVER_CRASHED' && crashRun.attempt.message.includes('code 3') && crashRun.attempt.message.includes('internal error') && crashRun.attempt.message.includes('RuntimeError'));
  check('exit code 3: exit code, stderr tail and failure code are in the diagnostics', crashRun.info.exitCode === 3 && crashRun.info.stderrTail.includes('Traceback') && crashRun.info.failureCode === 'SOLVER_CRASHED' && crashRun.info.timeout.killReason === null);

  const table: Array<[string, string, string]> = [
    ['exit2', 'PROCESS_FAULT', 'SOLVER_CRASHED'], ['exit1', 'PROCESS_FAULT', 'SOLVER_CRASHED'], ['segv', 'PROCESS_FAULT', 'SOLVER_CRASHED'], ['kill9-self', 'PROCESS_FAULT', 'SOLVER_CRASHED'],
    ['exit-no-read', 'PROCESS_FAULT', 'SOLVER_CRASHED'],
    ['not-json', 'FAULT', 'SOLVER_INVALID_OUTPUT'], ['empty', 'FAULT', 'SOLVER_INVALID_OUTPUT'], ['bad-json', 'FAULT', 'SOLVER_INVALID_OUTPUT'], ['array', 'FAULT', 'SOLVER_INVALID_OUTPUT'], ['string', 'FAULT', 'SOLVER_INVALID_OUTPUT'],
    ['wrong-request-id', 'FAULT', 'SOLVER_INVALID_OUTPUT'], ['wrong-version', 'FAULT', 'SOLVER_INVALID_OUTPUT'], ['extra-field', 'FAULT', 'SOLVER_INVALID_OUTPUT'], ['invalid-timetable', 'FAULT', 'SOLVER_INVALID_OUTPUT'],
  ];
  const results = await Promise.all(table.map(async ([mode]) => ({ mode, r: await fakeClient(mode).solve(request(problem)) })));
  for (const [mode, kind, code] of table) {
    const { r } = results.find((x) => x.mode === mode)!;
    const a = r.attempt;
    const ok = a.kind === kind && (a.kind === 'PROCESS_FAULT' || a.kind === 'FAULT') && a.code === code;
    check(`${mode}: ${kind} ${code}`, ok, `${a.kind} ${(a as { code?: string }).code ?? ''}`);
    const outcome = decideOutcome(a, baseline);
    check(`${mode}: decideOutcome is a FAILURE (no silent baseline, no silent UNKNOWN)`, outcome.kind === 'FAILURE' && outcome.code === code);
    check(`${mode}: the failure code is recorded in the diagnostics and nothing was killed by the client`, r.info.failureCode === code && r.info.timeout.killReason === null);
  }
  const sig = results.find((x) => x.mode === 'segv')!.r;
  check('a crash by signal records the signal and says so', sig.info.signal !== null && sig.attempt.kind === 'PROCESS_FAULT' && sig.attempt.message.includes('signal'));
  const k9 = results.find((x) => x.mode === 'kill9-self')!.r;
  check('a process killed by someone else (SIGKILL, e.g. the OOM killer) is a crash, not a watchdog', k9.info.signal === 'SIGKILL' && k9.attempt.kind === 'PROCESS_FAULT');
  const invalidTimetable = results.find((x) => x.mode === 'invalid-timetable')!.r;
  check('an invalid timetable reports the concrete validation problems', invalidTimetable.attempt.kind === 'FAULT' && invalidTimetable.attempt.problems.length > 0 && invalidTimetable.info.solverStatus === 'FEASIBLE');
  const emptyRun = results.find((x) => x.mode === 'empty')!.r;
  check('empty stdout says so', emptyRun.attempt.kind === 'FAULT' && emptyRun.attempt.message.includes('no output') && emptyRun.info.stdoutBytes === 0);
  const noRead = results.find((x) => x.mode === 'exit-no-read')!.r;
  check('a child that exits without reading the request does not crash the client (EPIPE is recorded, not thrown)', noRead.attempt.kind === 'PROCESS_FAULT' && noRead.info.exitCode === 1);
}

section('6. stdout / stderr / request integrity');
if (want(6)) {
  const problem = tiny();
  const ws = await fakeClient('whitespace').solve(request(problem));
  check('extra whitespace around the JSON document is tolerated', ws.attempt.kind === 'NO_SOLUTION' && ws.info.failureCode === null);

  const noise = await fakeClient('stderr-noise').solve(request(problem));
  check('heavy stderr output is NOT a failure', noise.attempt.kind === 'NO_SOLUTION' && noise.info.exitCode === 0);
  check('stderr is counted in full but only a bounded, sanitised tail is kept', noise.info.stderrBytes > 270_000 && noise.info.stderrTail.length <= 8192 && noise.info.stderrTruncated && !/[\u0000\u001b\u0007]/.test(noise.info.stderrTail));

  const big = await fakeClient('big-stdout', { maxStdoutBytes: 1024 * 1024 }, `${MARKER_PREFIX}-big`).solve(request(problem));
  check('stdout above the cap is a FAULT SOLVER_INVALID_OUTPUT and the process is terminated', big.attempt.kind === 'FAULT' && big.attempt.code === 'SOLVER_INVALID_OUTPUT' && big.info.timeout.killReason === 'OUTPUT_TOO_LARGE' && big.info.durationMs < 5000);
  check('the oversize process is gone and the retained diagnostics are small', !alive(big.info.pid) && JSON.stringify(big.info).length < 20_000);

  // the raw stdout of the real solver is exactly one structured document
  const real = await realClient({ keepRawStdout: true }).solve(request(problem));
  const raw = real.info.rawStdout ?? '';
  check('the real solver\'s stdout is exactly one JSON document with nothing around it', raw === raw.trim() && (() => { try { JSON.parse(raw); return true; } catch { return false; } })() && (raw.match(/"contractVersion"/g) ?? []).length === 1);
  check('stdoutBytes equals the bytes of that document', real.info.stdoutBytes === Buffer.byteLength(raw, 'utf8') && real.attempt.kind === 'SOLUTION');
  check('the solver\'s stderr summary line is captured without being a failure', /^solver: status=OPTIMAL/m.test(real.info.stderrTail));

  // a request of several MB goes through unchanged (back-pressure) and byte-identical
  const tuples: Tuple[] = Array.from({ length: 30_000 }, (_, i) => [`assignment-${String(i).padStart(6, '0')}-${'x'.repeat(60)}`, `section-${i % 1500}`, `teacher-${i % 4000}`, 1]);
  const largeProblem = coreProblem(5, 8, allContinue(8), tuples);
  const largeReq = request(largeProblem, opts({ timeLimitSeconds: 30 }));
  const sent = serializeSolverRequest(largeReq.input);
  const echo = await fakeClient('echo', { killGraceMs: 5000 }).solve(largeReq);
  const msgs = echo.attempt.kind === 'NO_SOLUTION' ? echo.attempt.diagnostics.messages : [];
  check(`a ${(Buffer.byteLength(sent) / 1e6).toFixed(1)} MB request is received byte-for-byte by the child (size and sha256)`, msgs.includes(`bytes=${Buffer.byteLength(sent) - 1}`) && msgs.includes(`sha256=${createHash('sha256').update(sent.slice(0, -1)).digest('hex')}`), msgs.slice(0, 2).join(' '));
  check('...and the request write completed without error', echo.info.stdin.written && echo.info.stdin.error === null && echo.info.stdin.bytes === Buffer.byteLength(sent));

  // unicode survives the round trip, in the request and in the solver's output
  const uni = coreProblem(5, 6, allContinue(6), [['aufgabe-ä-😀', 'Klasse-ñ-教室-😀', 'Lehrer-ü', 3], ['b-ß', 'Klasse-ñ-教室-😀', 'Lehrer-é', 2]]);
  const uniEcho = await fakeClient('echo').solve(request(uni));
  check('unicode ids reach the child intact', uniEcho.attempt.kind === 'NO_SOLUTION' && uniEcho.attempt.diagnostics.messages.includes('section0=Klasse-ñ-教室-😀'));
  const uniReal = await realClient().solve(request(uni, opts({ timeLimitSeconds: 20 })));
  check('the real solver round-trips unicode ids and the entries validate', uniReal.attempt.kind === 'SOLUTION' && validateEntries(uni, uniReal.attempt.entries).valid && uniReal.attempt.entries.every((e) => e.sectionId === 'Klasse-ñ-教室-😀'));

  // deterministic serialization on the wire
  const r1 = request(problem, opts(), 'fixed-id'); const r2 = request(problem, opts(), 'fixed-id');
  const e1 = await fakeClient('echo').solve(r1); const e2 = await fakeClient('echo').solve(r2);
  const shaOf = (r: SolverClientResult): string => (r.attempt.kind === 'NO_SOLUTION' ? r.attempt.diagnostics.messages.find((m) => m.startsWith('sha256=')) ?? '' : '');
  check('two runs of the same request put identical bytes on the wire', shaOf(e1) === shaOf(e2) && shaOf(e1) === `sha256=${createHash('sha256').update(serializeSolverRequest(r1.input).slice(0, -1)).digest('hex')}`);
}

section('7. stdin is never closed by the client (the Phase 2 reader is self-delimiting)');
if (want(7)) {
  const problem = tiny();
  const open = await Promise.all(Array.from({ length: 12 }, () => fakeClient('echo').solve(request(problem))));
  check('12 runs: the child still sees stdin OPEN after it has read the whole request', open.every((r) => r.attempt.kind === 'NO_SOLUTION' && r.attempt.diagnostics.messages.includes('stdin_open=true')));
  check('12 runs: the diagnostics state that the client never closed stdin', open.every((r) => r.info.stdin.closedByClient === false && r.info.stdin.written));
  const slow = await fakeClient('slow-start').solve(request(problem));
  check('a child that starts reading late still gets the request', slow.attempt.kind === 'NO_SOLUTION' && slow.attempt.diagnostics.messages.includes('stdin_open=true'));
  check('the client source never closes or ends the stdin stream', (() => { const src = readFileSync(path.join(REPO_ROOT, 'src/modules/timetable-generation/timetable-generation.solver-client.ts'), 'utf8').replace(/\/\/.*$/gm, ''); return !/stdin\??\.end\(|stdin\??\.close\(|stdio:\s*\[\s*'ignore'/.test(src); })());

  // reliability: the REAL solver, async spawn, stdin left open
  const client = realClient();
  const small = request(problem, opts({ timeLimitSeconds: 10 }));
  let seqBad = 0; const seqStart = Date.now();
  for (let i = 0; i < 100; i++) {
    const r = await client.solve({ problem, input: { ...small.input, requestId: `seq-${i}` } });
    if (r.attempt.kind !== 'SOLUTION' || r.attempt.status !== 'OPTIMAL' || r.info.timeout.killReason !== null || r.info.durationMs > 8000) seqBad++;
  }
  check(`100 sequential async-spawn runs of the real solver: all OPTIMAL, none hung or was killed (${((Date.now() - seqStart) / 1000).toFixed(0)} s)`, seqBad === 0, `${seqBad} bad`);
  let parBad = 0;
  for (let batch = 0; batch < 6; batch++) {
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => client.solve({ problem, input: { ...small.input, requestId: `par-${batch}-${i}` } })));
    parBad += rs.filter((r) => r.attempt.kind !== 'SOLUTION' || r.info.timeout.killReason !== null).length;
  }
  check('48 concurrent async-spawn runs (batches of 8): all complete, none hung or was killed', parBad === 0, `${parBad} bad`);
}

section('8. Timeout, termination and orphans');
if (want(8)) {
  const problem = tiny();
  const t0 = Date.now();
  const hang = await fakeClient('hang').solve(request(problem, opts({ timeLimitSeconds: 1 })));
  const hangMs = Date.now() - t0;
  check('a solver that never finishes is classified KILLED_BY_WATCHDOG', hang.attempt.kind === 'KILLED_BY_WATCHDOG' && hang.info.failureCode === null);
  check('the kill fires at time limit + grace (1 s + 0.3 s) measured from the spawn, not later', hang.info.killDeadlineMs === 1300 && hangMs >= 1250 && hangMs < 2200, `${hangMs} ms`);
  check('the diagnostics record the timeout: exceeded budget, reason TIMEOUT, SIGTERM only, no escalation', hang.info.timeout.exceededBudget && hang.info.timeout.killReason === 'TIMEOUT' && same(hang.info.timeout.signalsSent, ['SIGTERM']) && !hang.info.timeout.escalated && !hang.info.timeout.unkillable);
  check('the process ended by SIGTERM and no process remains', hang.info.signal === 'SIGTERM' && !alive(hang.info.pid) && processesWith(`${MARKER_PREFIX}-hang`).length === 0);
  check('the total time is limit + grace + a short termination, NOT limit + start-up + timeout + grace', hang.info.durationMs < 1300 + 800);
  check('the watchdog outcome lets the orchestration choose the baseline (decideOutcome)', (() => { const o = decideOutcome(hang.attempt, baselineOf(problem)); return o.kind === 'SUCCESS' && o.solutionSource === 'BASELINE' && o.fallbackReason === 'KILLED_BY_WATCHDOG'; })());

  const stubborn = await fakeClient('ignore-sigterm').solve(request(problem, opts({ timeLimitSeconds: 1 })));
  check('a process that ignores SIGTERM is escalated to SIGKILL after the terminate wait', stubborn.attempt.kind === 'KILLED_BY_WATCHDOG' && same(stubborn.info.timeout.signalsSent, ['SIGTERM', 'SIGKILL']) && stubborn.info.timeout.escalated && stubborn.info.signal === 'SIGKILL');
  check('...it took about limit + grace + terminate wait and left nothing behind', stubborn.info.durationMs >= 1650 && stubborn.info.durationMs < 3500 && !alive(stubborn.info.pid) && processesWith(`${MARKER_PREFIX}-ignore-sigterm`).length === 0, `${stubborn.info.durationMs} ms`);

  const slowTerm = await fakeClient('slow-term-exit0').solve(request(problem, opts({ timeLimitSeconds: 1 })));
  check('a process that exits (code 0, no output) DURING termination is a watchdog result, without escalation', slowTerm.attempt.kind === 'KILLED_BY_WATCHDOG' && slowTerm.info.exitCode === 0 && !slowTerm.info.timeout.escalated && same(slowTerm.info.timeout.signalsSent, ['SIGTERM']));
  const exit7 = await fakeClient('term-exit7').solve(request(problem, opts({ timeLimitSeconds: 1 })));
  check('a process that exits non-zero during termination is still a watchdog result, not a crash', exit7.attempt.kind === 'KILLED_BY_WATCHDOG' && exit7.info.exitCode === 7);

  const partial = await fakeClient('partial-then-hang').solve(request(problem, opts({ timeLimitSeconds: 1 })));
  check('half a document followed by a hang is a watchdog result (the fragment is ignored)', partial.attempt.kind === 'KILLED_BY_WATCHDOG' && partial.info.stdoutBytes > 0);
  const printedThenHung = await fakeClient('output-then-hang').solve(request(problem, opts({ timeLimitSeconds: 1 })));
  check('a complete document from a process that never exits is a watchdog result (it did not finish)', printedThenHung.attempt.kind === 'KILLED_BY_WATCHDOG');

  const grandchild = await fakeClient('grandchild').solve(request(problem, opts({ timeLimitSeconds: 1 })));
  const gcPid = Number(/grandchild=(\d+)/.exec(grandchild.info.stderrTail)?.[1] ?? 0);
  check('a grandchild process was started by the fake', gcPid > 0);
  check('the whole process group is terminated: the grandchild is gone too', await until(() => !alive(gcPid), 3000) && processesWith(`${MARKER_PREFIX}-grandchild`).length === 0);

  // finished late but inside the grace: the grace is real, nothing is killed
  const late = await fakeClient('sleep-then-ok', { killGraceMs: 2000 }).solve(request(problem, opts({ timeLimitSeconds: 1 })));
  check('a solver that finishes after the budget but inside the grace is NOT killed and its result is used', late.attempt.kind === 'NO_SOLUTION' && late.info.timeout.exceededBudget && late.info.timeout.killReason === null && late.info.exitCode === 0);
  const inTime = await fakeClient('sleep-then-ok').solve(request(problem, opts({ timeLimitSeconds: 5 })));
  check('a solver that finishes within the budget is not flagged at all', inTime.attempt.kind === 'NO_SOLUTION' && !inTime.info.timeout.exceededBudget && inTime.info.timeout.killReason === null);

  // terminateProcess in isolation
  const mk = (mode: string) => spawn(REAL_PYTHON, [FAKE, mode, `${MARKER_PREFIX}-term-${mode}`], { cwd: path.dirname(FAKE), env: { ...SOLVER_CHILD_ENV }, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  const feed = (c: ReturnType<typeof mk>) => { c.stdin?.write(serializeSolverRequest(request(problem).input)); c.stderr?.resume(); c.stdout?.resume(); return c; };
  const exitedAlready = feed(mk('exit1')); await new Promise((r) => exitedAlready.once('exit', r));
  const rep0 = await terminateProcess(exitedAlready, { terminateWaitMs: 300, killWaitMs: 1000 });
  check('terminateProcess on a child that already exited: no signal, no error', rep0.alreadyExited && rep0.signalsSent.length === 0 && !rep0.escalated && !rep0.stuck);
  const cooperative = feed(mk('hang')); await sleep(600);
  const rep1 = await terminateProcess(cooperative, { terminateWaitMs: 1000, killWaitMs: 1000 });
  check('a cooperative child ends on SIGTERM', same(rep1.signalsSent, ['SIGTERM']) && !rep1.escalated && !alive(cooperative.pid ?? null) && cooperative.signalCode === 'SIGTERM');
  const resistant = feed(mk('ignore-sigterm')); await sleep(600);
  const rep2 = await terminateProcess(resistant, { terminateWaitMs: 300, killWaitMs: 1000 });
  check('a child ignoring SIGTERM is killed by SIGKILL', same(rep2.signalsSent, ['SIGTERM', 'SIGKILL']) && rep2.escalated && !rep2.stuck && resistant.signalCode === 'SIGKILL' && !alive(resistant.pid ?? null));
  const dying = feed(mk('slow-term-exit0')); await sleep(600);
  const rep3 = await terminateProcess(dying, { terminateWaitMs: 1500, killWaitMs: 1000 });
  check('a child that exits during the terminate wait needs no SIGKILL', same(rep3.signalsSent, ['SIGTERM']) && !rep3.escalated && dying.exitCode === 0);
  const twice = await terminateProcess(cooperative, { terminateWaitMs: 100, killWaitMs: 100 });
  check('terminating twice is harmless', twice.alreadyExited && twice.signalsSent.length === 0);

  // the real solver, aborted mid-solve (graceful shutdown path)
  const heavy = coreProblem(5, 8, allContinue(8), heavyTuples(100));
  const controller = new AbortController();
  const abortStart = Date.now();
  setTimeout(() => controller.abort(), 1500);
  let abortedInfo: SolverAbortedError['info'] | null = null;
  try { await realClient().solve(request(heavy, opts({ timeLimitSeconds: 120, numWorkers: 1 })), { signal: controller.signal }); } catch (e) { if (e instanceof SolverAbortedError) abortedInfo = e.info; }
  check('aborting a real solve terminates the child and rejects with SolverAbortedError', abortedInfo !== null && abortedInfo.timeout.killReason === 'ABORT' && Date.now() - abortStart < 8000, `${Date.now() - abortStart} ms`);
  check('...the real solver is gone (no orphan)', abortedInfo !== null && !alive(abortedInfo.pid) && processesWith('solver/main.py').filter((l) => l.includes(REPO_ROOT)).length === 0);
  const pre = new AbortController(); pre.abort();
  check('an already-aborted signal rejects without spawning anything', await realClient().solve(request(problem), { signal: pre.signal }).then(() => false, (e) => e instanceof SolverAbortedError && e.info.pid === null));
  const finishedController = new AbortController();
  const finishedRun = await realClient().solve(request(problem), { signal: finishedController.signal }); finishedController.abort();
  check('aborting after completion has no effect', finishedRun.attempt.kind === 'SOLUTION');

  // the real solver killed at its deadline (budget 1 s, grace 50 ms on a heavy problem): either it answers in time or the watchdog ends it
  const squeezed = await realClient({ killGraceMs: 50, terminateWaitMs: 2000 }).solve(request(heavy, opts({ timeLimitSeconds: 1, numWorkers: 1 })));
  check('the real solver under a 1 s budget ends as a result or a watchdog kill, never as a fault', ['SOLUTION', 'NO_SOLUTION', 'KILLED_BY_WATCHDOG'].includes(squeezed.attempt.kind), squeezed.attempt.kind);
  check('...within budget + grace + termination, and no process remains', squeezed.info.durationMs < 1050 + 2500 && !alive(squeezed.info.pid));
  console.log(`      (real solver, 1 s budget, 50 ms grace: ${squeezed.attempt.kind} after ${squeezed.info.durationMs} ms)`);
}

section('9. End-to-end rule (decisions B / D4) with real and fake processes');
if (want(9)) {
  const problem = goldenProblem('s10_5d6p');
  const baseline = baselineOf(problem);
  const cases: Array<[string, Promise<SolverClientResult>, 'SUCCESS:CP_SAT' | 'SUCCESS:BASELINE' | 'FAILURE']> = [
    ['real OPTIMAL', realClient().solve(request(problem, opts({ timeLimitSeconds: 60, numWorkers: 4 }))), 'SUCCESS:CP_SAT'],
    ['real UNKNOWN', realClient().solve(request(goldenProblem('s50_5d8p'), opts({ timeLimitSeconds: 60, reproducible: true, deterministicTimeLimit: 0.001 }))), 'SUCCESS:BASELINE'],
    ['hung process killed at the deadline', fakeClient('hang').solve(request(problem, opts({ timeLimitSeconds: 1 }))), 'SUCCESS:BASELINE'],
    ['python crash', fakeClient('crash3').solve(request(problem)), 'FAILURE'],
    ['malformed stdout', fakeClient('not-json').solve(request(problem)), 'FAILURE'],
    ['invalid timetable', fakeClient('invalid-timetable').solve(request(problem)), 'FAILURE'],
    ['python missing', new SubprocessSolverClient(resolveSolverClientConfig({}, { pythonPath: '/nonexistent/python' })).solve(request(problem)), 'FAILURE'],
  ];
  const settled = await Promise.all(cases.map(([, p]) => p));
  cases.forEach(([name, , expected], i) => {
    const o = decideOutcome(settled[i]!.attempt, baseline);
    const got = o.kind === 'SUCCESS' ? `SUCCESS:${o.solutionSource}` : 'FAILURE';
    check(`${name} -> ${expected}`, got === expected, got);
  });
  check('ONLY the clean UNKNOWN and the watchdog kill used the baseline', cases.every(([name], i) => { const o = decideOutcome(settled[i]!.attempt, baseline); return (o.kind === 'SUCCESS' && o.solutionSource === 'BASELINE') === (name === 'real UNKNOWN' || name.startsWith('hung')); }));
}

section('10. No orphan processes');
if (want(10)) {
  await sleep(500);
  const leftovers = processesWith(MARKER_PREFIX);
  check('no fake solver process from this run remains', leftovers.length === 0, leftovers.join(' | '));
  const realLeft = processesWith('solver/main.py').filter((l) => l.includes(REPO_ROOT));
  check('no real solver process remains', realLeft.length === 0, realLeft.join(' | '));
}

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
