// A standalone runner PROCESS for the crash-recovery tests. It runs a real GenerationRunner against the real database and
// can freeze at a chosen point so that a test can `kill -9` it exactly there. Test code only.
//
// Environment:
//   RUNNER_CONFIG   JSON of RunnerConfig overrides
//   TIME_POLICY     JSON of TimeLimitPolicy overrides
//   SOLVER          "real" (the production Python solver) or "fake:<mode>" (test-fixtures/.../fake_solver.py)
//   HOLD_AT         "" | "phase:<PHASE>" | "persist:afterLocks" | "persist:beforeCommit" | "solver:running"
//   READY_FILE      written (with the pid) when the process reached its HOLD_AT point
//   READY_DELAY_MS  extra wait after a "solver:running" hold point is reached (default 1500)
//   SIGTERM         triggers a graceful runner.stop() and exit code 0
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import prisma from '../../src/config/database.js';
import { GenerationRunner } from '../../src/modules/timetable-generation/timetable-generation.runner.js';
import { resolveSolverClientConfig, SubprocessSolverClient, REPO_ROOT, type SolverClient } from '../../src/modules/timetable-generation/timetable-generation.solver-client.js';
import { DEFAULT_TIME_POLICY } from '../../src/modules/timetable-generation/timetable-generation.time-policy.js';
import { type OrchestratorHooks } from '../../src/modules/timetable-generation/timetable-generation.orchestrator.js';
import { fastConfig } from './runner-test-kit.js';

const hold = process.env.HOLD_AT ?? '';
const readyFile = process.env.READY_FILE ?? '';
const markReady = (): void => { if (readyFile) writeFileSync(readyFile, String(process.pid)); };
const forever = (): Promise<never> => new Promise(() => undefined);

const FAKE = path.join(REPO_ROOT, 'test-fixtures', 'timetable-generation', 'fake-solvers', 'fake_solver.py');
const solverSpec = process.env.SOLVER ?? 'real';
const solverConfig = solverSpec.startsWith('fake:')
  ? resolveSolverClientConfig({}, { entrypointPath: FAKE, entrypointArgs: [solverSpec.slice(5), `worker-${process.pid}`], cwd: path.dirname(FAKE), killGraceMs: 300, terminateWaitMs: 400 })
  : resolveSolverClientConfig({}, {});
const inner = new SubprocessSolverClient(solverConfig);
const solverClient: SolverClient =
  hold === 'solver:running'
    ? {
        async solve(request, options) {
          const running = inner.solve(request, options);
          // freeze point = the production Python process really exists (polled), then a short extra wait so it is mid-solve
          const pythonUp = (): boolean => spawnSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).stdout.split('\n').some((l) => l.includes(`${REPO_ROOT}/solver/main.py`));
          const poll = setInterval(() => { if (pythonUp()) { clearInterval(poll); setTimeout(markReady, Number(process.env.READY_DELAY_MS ?? 700)); } }, 100);
          void running.finally(() => clearInterval(poll)).catch(() => undefined);
          return running;
        },
      }
    : inner;

const hooks: OrchestratorHooks = {};
if (hold.startsWith('phase:')) {
  const phase = hold.slice(6);
  hooks.onPhase = async (p) => { if (p === phase) { markReady(); await forever(); } };
} else if (hold === 'persist:afterLocks') {
  hooks.persist = { afterLocks: async () => { markReady(); await forever(); } };
} else if (hold === 'persist:beforeCommit') {
  // everything is written inside the open transaction; the process dies before the commit
  hooks.persist = { beforeCommit: async () => { markReady(); await forever(); } };
}

const runner = new GenerationRunner({
  prisma,
  solverClient,
  config: fastConfig(JSON.parse(process.env.RUNNER_CONFIG ?? '{}')),
  policy: { ...DEFAULT_TIME_POLICY, ...JSON.parse(process.env.TIME_POLICY ?? '{}') },
  logger: { info: () => undefined, warn: () => undefined, error: (f, m) => console.error(m, JSON.stringify(f)) },
  hooks,
});

process.on('SIGTERM', () => {
  void runner.stop(25).then((summary) => {
    console.log(JSON.stringify({ stopped: true, ...summary, stats: runner.stats }));
    process.exit(0);
  });
});

runner.start();
console.log(JSON.stringify({ started: true, pid: process.pid, hold }));
