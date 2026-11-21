// The seam between the HTTP layer and the in-process GenerationRunner.
//
// The API only ENQUEUES a run (a database row) and then gives the runner a hint that work is waiting. It never runs the
// solver itself and never owns a runner: server.ts creates the runner (if GENERATION_RUNNER_ENABLED) and registers it
// here. When no runner is registered (an API-only instance, or a test), the hint is simply dropped and any runner that is
// ticking against the same database picks the run up within one tick.

export interface RunnerTrigger {
  /** A hint that a queued run exists. Never throws and is not awaited. */
  trigger(): void;
}

let current: RunnerTrigger | null = null;

export function registerGenerationRunner(runner: RunnerTrigger | null): void {
  current = runner;
}

export function hasGenerationRunner(): boolean {
  return current !== null;
}

/** Hint the registered runner (if any). A failing runner must never fail the HTTP request that already queued the run. */
export function triggerGenerationRunner(): boolean {
  if (!current) return false;
  try {
    current.trigger();
    return true;
  } catch {
    return false;
  }
}
