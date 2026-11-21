import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { type FailureCode, type SolverInput } from './timetable-generation.contracts.js';
import { type NormalizedProblem } from './timetable-generation.normalizer.js';
import { type SolverAttempt } from './timetable-generation.outcome.js';
import { assertValidSolverRequest, serializeSolverRequest } from './timetable-generation.solver-options.js';
import { parseTimePolicy } from './timetable-generation.time-policy.js';
import { interpretSolverOutput } from './timetable-generation.validator.js';

// ---------------------------------------------------------------------------
// SolverClient: the Node boundary around the Python solver subprocess.
//
//   request (Phase 1 contract) -> child_process.spawn -> Python/CP-SAT -> stdout document
//   -> Phase 1 interpretSolverOutput -> SolverAttempt  (+ bounded diagnostics)
//
// What this module DECIDES: how a finished (or killed) process is classified. What it deliberately does NOT decide:
// whether a baseline is used. The approved rule (decisions B / D4) lives in decideOutcome(): only a clean UNKNOWN and a
// watchdog kill may be answered with the baseline; a process fault (unavailable, crash, non-zero exit) and every kind
// of invalid output are failures. Nothing here ever turns a fault into UNKNOWN or into a baseline.
// ---------------------------------------------------------------------------

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The repository root: src/modules/timetable-generation and dist/modules/timetable-generation are the same depth. */
export const REPO_ROOT = path.resolve(MODULE_DIR, '../../..');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
export interface SolverClientConfig {
  /** Absolute path of the Python interpreter (the project virtualenv by default). */
  pythonPath: string;
  /** Absolute path of solver/main.py. */
  entrypointPath: string;
  /** Extra arguments after the entrypoint. Empty in production; tests use it to select a fake solver mode. */
  entrypointArgs: string[];
  /** Working directory of the child (never the caller's). */
  cwd: string;
  /** The force-kill deadline is the request's time limit plus this grace, measured from the moment of spawning. */
  killGraceMs: number;
  /** After SIGTERM, how long to wait before escalating to SIGKILL. */
  terminateWaitMs: number;
  /** After SIGKILL, how long to wait for the exit before declaring the process unkillable. */
  killWaitMs: number;
  /** After the process exits, how long to wait for its stdio to close before giving up on trailing output. */
  drainMs: number;
  maxStdoutBytes: number;
  stderrTailBytes: number;
  /** Keep the raw stdout text in the diagnostics (tests only; off by default so large documents are not retained). */
  keepRawStdout: boolean;
  /** The ONLY environment the child receives. */
  env: Readonly<Record<string, string>>;
}

/** The environment of the solver child: nothing of the application's environment (no database URL, no secrets). */
export const SOLVER_CHILD_ENV: Readonly<Record<string, string>> = Object.freeze({
  PATH: '/usr/bin:/bin',
  PYTHONUNBUFFERED: '1',
  PYTHONDONTWRITEBYTECODE: '1',
  PYTHONNOUSERSITE: '1',
});

const resolveAgainstRepo = (value: string): string => (path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value));

export function resolveSolverClientConfig(
  env: Record<string, string | undefined> = process.env,
  overrides: Partial<SolverClientConfig> = {}
): SolverClientConfig {
  const policy = parseTimePolicy(env);
  const pythonPath = resolveAgainstRepo(env.SOLVER_PYTHON?.trim() || path.join('solver', '.venv', 'bin', 'python'));
  const entrypointPath = resolveAgainstRepo(env.SOLVER_ENTRYPOINT?.trim() || path.join('solver', 'main.py'));
  return {
    pythonPath,
    entrypointPath,
    entrypointArgs: [],
    cwd: path.dirname(entrypointPath),
    killGraceMs: policy.killGraceSeconds * 1000,
    terminateWaitMs: 5_000,
    killWaitMs: 5_000,
    drainMs: 2_000,
    maxStdoutBytes: 64 * 1024 * 1024,
    stderrTailBytes: 8 * 1024,
    keepRawStdout: false,
    env: SOLVER_CHILD_ENV,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export interface SolverRequest {
  /** The problem the output will be validated against. */
  problem: NormalizedProblem;
  /** The exact request to send (must belong to `problem`: checked before anything is spawned). */
  input: SolverInput;
}

export type KillReason = 'TIMEOUT' | 'ABORT' | 'OUTPUT_TOO_LARGE';

export interface SolverRunInfo {
  startedAt: string;
  spawned: boolean;
  pid: number | null;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  timeLimitSeconds: number;
  killGraceMs: number;
  /** Milliseconds after spawning at which the force-kill fires: time limit + grace. */
  killDeadlineMs: number;
  timeout: {
    /** The process was still running when the time limit passed (before the grace elapsed). */
    exceededBudget: boolean;
    killReason: KillReason | null;
    signalsSent: string[];
    escalated: boolean;
    /** From the first signal until the process was gone. */
    terminationMs: number | null;
    /** The process still had not exited after SIGKILL and the wait. */
    unkillable: boolean;
  };
  stdin: {
    bytes: number;
    written: boolean;
    error: string | null;
    /** Always false: end-of-input is never used to start the solver (the Python reader is self-delimiting). */
    closedByClient: false;
  };
  stdoutBytes: number;
  stderrBytes: number;
  /** The last bytes of stderr, sanitised and bounded. Never treated as a failure by itself. */
  stderrTail: string;
  stderrTruncated: boolean;
  rawStdout?: string;
  solverStatus: string | null;
  stoppedBy: string | null;
  failureCode: FailureCode | null;
}

export interface SolverClientResult {
  attempt: SolverAttempt;
  info: SolverRunInfo;
}

export interface SolveOptions {
  /** Aborting terminates the child (SIGTERM, then SIGKILL) and rejects with SolverAbortedError. For graceful shutdown. */
  signal?: AbortSignal;
}

export class SolverAbortedError extends Error {
  constructor(public readonly info: SolverRunInfo) {
    super('The solver run was aborted');
    this.name = 'SolverAbortedError';
  }
}

/** The seam a future out-of-process worker or HTTP client can replace. */
export interface SolverClient {
  solve(request: SolverRequest, options?: SolveOptions): Promise<SolverClientResult>;
}

// ---------------------------------------------------------------------------
// Bounded text helpers
// ---------------------------------------------------------------------------
const MAX_MESSAGE_CHARS = 500;

/** Printable, bounded text: control characters other than newline and tab become '?'. */
export function sanitizeText(text: string, maxChars: number): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '?');
  return cleaned.length <= maxChars ? cleaned : `${cleaned.slice(0, maxChars)}…`;
}

function lastLine(text: string, maxChars: number): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return sanitizeText(lines[lines.length - 1] ?? '', maxChars);
}

// ---------------------------------------------------------------------------
// Classification of a finished process (pure, so the whole matrix is testable without spawning anything)
// ---------------------------------------------------------------------------
export interface ClassifyInput {
  problem: NormalizedProblem;
  requestId: string;
  /** The process could not be started at all. */
  startFailure: string | null;
  exitCode: number | null;
  signal: string | null;
  killReason: KillReason | null;
  /** The process had not exited even after SIGKILL. */
  unkillable: boolean;
  stdout: string;
  outputOverflow: boolean;
  stderrTail: string;
}

export interface Classification {
  attempt: SolverAttempt;
  solverStatus: string | null;
  stoppedBy: string | null;
}

const EXIT_CODE_MEANING: Record<number, string> = {
  2: 'the solver could not answer the request (unparseable input or no usable requestId)',
  3: 'the solver hit an internal error',
  4: 'the solver stopped because it believed its parent process had died',
};

function fault(code: 'SOLVER_INVALID_OUTPUT', message: string): SolverAttempt {
  return {
    kind: 'FAULT',
    code,
    message: sanitizeText(message, MAX_MESSAGE_CHARS),
    problems: [{ code: 'CONTRACT_VIOLATION', message: sanitizeText(message, MAX_MESSAGE_CHARS) }],
    diagnostics: null,
  };
}

export function classifyProcessResult(input: ClassifyInput): Classification {
  const none = { solverStatus: null, stoppedBy: null };

  if (input.startFailure !== null) {
    return { attempt: { kind: 'PROCESS_FAULT', code: 'SOLVER_UNAVAILABLE', message: sanitizeText(input.startFailure, MAX_MESSAGE_CHARS) }, ...none };
  }
  if (input.outputOverflow) {
    return { attempt: fault('SOLVER_INVALID_OUTPUT', 'The solver printed more output than allowed'), ...none };
  }

  const text = input.stdout.trim();

  if (input.exitCode === 0) {
    // Killed by our deadline but exited cleanly without a document: the watchdog ended it, there is no result.
    if (input.killReason === 'TIMEOUT' && text === '') return { attempt: { kind: 'KILLED_BY_WATCHDOG' }, ...none };
    if (text === '') return { attempt: fault('SOLVER_INVALID_OUTPUT', 'The solver exited normally but printed no output'), ...none };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { attempt: fault('SOLVER_INVALID_OUTPUT', 'The solver output is not valid JSON'), ...none };
    }
    const attempt = interpretSolverOutput(input.problem, input.requestId, parsed);
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const diagnostics = typeof record.diagnostics === 'object' && record.diagnostics !== null ? (record.diagnostics as Record<string, unknown>) : {};
    return {
      attempt,
      solverStatus: typeof record.status === 'string' ? record.status.slice(0, 40) : null,
      stoppedBy: typeof diagnostics.stoppedBy === 'string' ? diagnostics.stoppedBy.slice(0, 40) : null,
    };
  }

  // The process did not end with a clean exit.
  if (input.killReason === 'TIMEOUT' || (input.unkillable && input.exitCode === null && input.signal === null)) {
    return { attempt: { kind: 'KILLED_BY_WATCHDOG' }, ...none };
  }
  const detail = lastLine(input.stderrTail, 200);
  const suffix = detail ? ` (last stderr line: ${detail})` : '';
  if (input.signal !== null) {
    return { attempt: { kind: 'PROCESS_FAULT', code: 'SOLVER_CRASHED', message: sanitizeText(`The solver process was terminated by signal ${input.signal}${suffix}`, MAX_MESSAGE_CHARS) }, ...none };
  }
  if (input.exitCode !== null) {
    const meaning = EXIT_CODE_MEANING[input.exitCode];
    return {
      attempt: { kind: 'PROCESS_FAULT', code: 'SOLVER_CRASHED', message: sanitizeText(`The solver exited with code ${input.exitCode}${meaning ? `: ${meaning}` : ''}${suffix}`, MAX_MESSAGE_CHARS) },
      ...none,
    };
  }
  return { attempt: { kind: 'PROCESS_FAULT', code: 'SOLVER_CRASHED', message: 'The solver process ended without an exit status' }, ...none };
}

// ---------------------------------------------------------------------------
// Terminating a process (group-wide, with escalation)
// ---------------------------------------------------------------------------
export interface TerminationReport {
  /** The process had already exited when termination was requested. */
  alreadyExited: boolean;
  signalsSent: string[];
  escalated: boolean;
  exitedAfterMs: number | null;
  /** Still alive after SIGKILL and the wait. */
  stuck: boolean;
}

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

/**
 * Send a signal to the child's whole process group (the child is spawned as a group leader), so a grandchild cannot
 * outlive it. Falls back to the child alone. Returns whether a signal was delivered.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false; // already gone
    }
  }
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (hasExited(child)) return resolve(true);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(hasExited(child));
    }, ms);
    child.once('exit', onExit);
  });
}

/** SIGTERM, wait, escalate to SIGKILL, wait; then sweep the process group. Safe to call on an exited process. */
export async function terminateProcess(child: ChildProcess, options: { terminateWaitMs: number; killWaitMs: number }): Promise<TerminationReport> {
  const started = performance.now();
  const report: TerminationReport = { alreadyExited: hasExited(child), signalsSent: [], escalated: false, exitedAfterMs: null, stuck: false };
  const send = (signal: NodeJS.Signals): void => {
    if (signalGroup(child, signal)) report.signalsSent.push(signal);
  };
  if (!report.alreadyExited) {
    send('SIGTERM');
    if (!(await waitForExit(child, options.terminateWaitMs))) {
      report.escalated = true;
      send('SIGKILL');
      if (!(await waitForExit(child, options.killWaitMs))) report.stuck = true;
    }
    report.exitedAfterMs = Math.round(performance.now() - started);
  }
  if (!report.stuck) signalGroup(child, 'SIGKILL'); // sweep strays of the group (a no-op when it is empty)
  return report;
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------
export class SubprocessSolverClient implements SolverClient {
  readonly config: SolverClientConfig;

  constructor(config: SolverClientConfig = resolveSolverClientConfig()) {
    this.config = config;
  }

  /** Why the solver cannot be started, or null when the installation looks usable. */
  installationProblem(): string | null {
    const { pythonPath, entrypointPath } = this.config;
    try {
      if (!statSync(pythonPath).isFile()) return `The Python interpreter ${path.basename(pythonPath)} is not a file`;
      accessSync(pythonPath, fsConstants.X_OK);
    } catch (error) {
      return `The Python interpreter is not available (${(error as NodeJS.ErrnoException).code ?? 'error'})`;
    }
    try {
      if (!statSync(entrypointPath).isFile()) return 'The solver entrypoint is not a file';
      accessSync(entrypointPath, fsConstants.R_OK);
    } catch (error) {
      return `The solver entrypoint is not available (${(error as NodeJS.ErrnoException).code ?? 'error'})`;
    }
    return null;
  }

  async solve(request: SolverRequest, options: SolveOptions = {}): Promise<SolverClientResult> {
    // A malformed request is a bug of the caller, not a solver fault: it throws before anything is spawned.
    assertValidSolverRequest(request.problem, request.input);
    const cfg = this.config;
    const { problem, input } = request;
    const payload = Buffer.from(serializeSolverRequest(input), 'utf8');
    const timeLimitMs = input.options.timeLimitSeconds * 1000;
    const killDeadlineMs = timeLimitMs + cfg.killGraceMs;
    const startedAt = new Date().toISOString();
    const t0 = performance.now();

    const info: SolverRunInfo = {
      startedAt,
      spawned: false,
      pid: null,
      durationMs: 0,
      exitCode: null,
      signal: null,
      timeLimitSeconds: input.options.timeLimitSeconds,
      killGraceMs: cfg.killGraceMs,
      killDeadlineMs,
      timeout: { exceededBudget: false, killReason: null, signalsSent: [], escalated: false, terminationMs: null, unkillable: false },
      stdin: { bytes: payload.length, written: false, error: null, closedByClient: false },
      stdoutBytes: 0,
      stderrBytes: 0,
      stderrTail: '',
      stderrTruncated: false,
      solverStatus: null,
      stoppedBy: null,
      failureCode: null,
    };

    const finishWith = (classification: Classification): SolverClientResult => {
      info.durationMs = Math.round(performance.now() - t0);
      info.solverStatus = classification.solverStatus;
      info.stoppedBy = classification.stoppedBy;
      const attempt = classification.attempt;
      info.failureCode = attempt.kind === 'PROCESS_FAULT' || attempt.kind === 'FAULT' ? attempt.code : null;
      return { attempt, info };
    };
    const unavailable = (message: string): SolverClientResult =>
      finishWith(classifyProcessResult({ problem, requestId: input.requestId, startFailure: message, exitCode: null, signal: null, killReason: null, unkillable: false, stdout: '', outputOverflow: false, stderrTail: '' }));

    const missing = this.installationProblem();
    if (missing !== null) return unavailable(missing);
    if (options.signal?.aborted) throw new SolverAbortedError(finishWith({ attempt: { kind: 'KILLED_BY_WATCHDOG' }, solverStatus: null, stoppedBy: null }).info);

    let child: ChildProcess;
    try {
      child = spawn(cfg.pythonPath, [cfg.entrypointPath, ...cfg.entrypointArgs], {
        cwd: cfg.cwd,
        env: { ...cfg.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false, // never a shell: the argument vector is passed as is
        detached: true, // own process group, so termination reaches grandchildren too (the parent pid stays Node: the Python watchdog is unaffected)
        windowsHide: true,
      });
    } catch (error) {
      return unavailable(`The solver process could not be started (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    info.spawned = child.pid !== undefined;
    info.pid = child.pid ?? null;

    return new Promise<SolverClientResult>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      let stderrTail = Buffer.alloc(0);
      let outputOverflow = false;
      let startFailure: string | null = null;
      let exited = false;
      let finished = false;
      let killReason: KillReason | null = null;
      let termination: Promise<TerminationReport> | null = null;
      let drainTimer: NodeJS.Timeout | undefined;

      const clearTimers = (): void => {
        clearTimeout(budgetTimer);
        clearTimeout(killTimer);
        clearTimeout(drainTimer);
      };
      const budgetTimer = setTimeout(() => {
        if (!exited) info.timeout.exceededBudget = true;
      }, timeLimitMs);
      const killTimer = setTimeout(() => beginTermination('TIMEOUT'), killDeadlineMs);

      const beginTermination = (reason: KillReason): void => {
        if (exited || killReason !== null || child.pid === undefined) return;
        killReason = reason;
        info.timeout.killReason = reason;
        termination = terminateProcess(child, { terminateWaitMs: cfg.terminateWaitMs, killWaitMs: cfg.killWaitMs }).then((report) => {
          info.timeout.signalsSent = report.signalsSent;
          info.timeout.escalated = report.escalated;
          info.timeout.terminationMs = report.exitedAfterMs;
          info.timeout.unkillable = report.stuck;
          if (report.stuck) void finish();
          return report;
        });
      };

      const onAbort = (): void => beginTermination('ABORT');
      options.signal?.addEventListener('abort', onAbort, { once: true });

      const finish = async (): Promise<void> => {
        if (finished) return;
        finished = true;
        clearTimers();
        options.signal?.removeEventListener('abort', onAbort);
        if (termination !== null) await termination.catch(() => undefined);
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();

        const stdout = Buffer.concat(stdoutChunks).toString('utf8');
        info.stderrTail = sanitizeText(stderrTail.toString('utf8'), cfg.stderrTailBytes);
        info.stderrTruncated = info.stderrBytes > stderrTail.length;
        if (cfg.keepRawStdout) info.rawStdout = stdout;

        if (killReason === 'ABORT') {
          info.durationMs = Math.round(performance.now() - t0);
          reject(new SolverAbortedError(info));
          return;
        }
        resolve(
          finishWith(
            classifyProcessResult({
              problem, requestId: input.requestId, startFailure,
              exitCode: info.exitCode, signal: info.signal, killReason, unkillable: info.timeout.unkillable,
              stdout, outputOverflow, stderrTail: info.stderrTail,
            })
          )
        );
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        if (outputOverflow) return;
        info.stdoutBytes += chunk.length;
        if (info.stdoutBytes > cfg.maxStdoutBytes) {
          outputOverflow = true;
          stdoutChunks.length = 0;
          beginTermination('OUTPUT_TOO_LARGE');
          return;
        }
        stdoutChunks.push(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        info.stderrBytes += chunk.length;
        stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-cfg.stderrTailBytes);
      });
      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        info.stdin.error = error.code ?? 'error'; // EPIPE when the child ends before reading: its exit status decides
      });
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (child.pid === undefined) {
          startFailure = `The solver process could not be started (${error.code ?? 'error'})`;
          void finish();
        }
      });
      child.once('exit', (code, signal) => {
        exited = true;
        info.exitCode = code;
        info.signal = signal;
        clearTimeout(killTimer);
        drainTimer = setTimeout(() => void finish(), cfg.drainMs); // trailing stdio normally closes at once
      });
      child.once('close', () => void finish());

      // The request is written and the pipe is left OPEN. End-of-input is never the signal that the request is complete:
      // the Python reader stops at the end of the JSON document (see solver/timetable_solver/request_reader.py).
      child.stdin?.write(payload, (error) => {
        if (error) info.stdin.error = (error as NodeJS.ErrnoException).code ?? 'error';
        else info.stdin.written = true;
      });
    });
  }
}
