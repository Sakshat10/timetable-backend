import { z } from 'zod';
import { type RunRecord } from './timetable-generation.run-repository.js';

// ---------------------------------------------------------------------------
// Request schemas (the HTTP surface of Module 11)
// ---------------------------------------------------------------------------

const uuid = (what: string) => z.string({ error: `${what} is required` }).uuid(`Invalid ${what} format`);

/**
 * The only knobs an admin may turn. The time limit, the number of solver workers and everything about the Python process are
 * server-side policy: a strict object makes any other key (timeLimitSeconds, workers, python, ...) a 400 instead of being
 * silently ignored.
 */
export const generationOptionsSchema = z.strictObject({
  seed: z.number({ error: 'seed must be an integer' }).int('seed must be an integer').min(0, 'seed must be between 0 and 2147483647').max(2_147_483_647, 'seed must be between 0 and 2147483647').optional(),
  reproducible: z.boolean({ error: 'reproducible must be true or false' }).optional(),
  /** Phase 7E: regenerate from this DRAFT, keeping its locked lessons. Omitted: a plain generation. */
  sourceVersionId: z.string({ error: 'sourceVersionId must be a version ID' }).uuid('Invalid sourceVersionId format').optional(),
});

export const startGenerationSchema = z.object({
  academicYearId: uuid('academic year ID'),
  options: generationOptionsSchema.optional(),
});

export const generationParamsSchema = z.object({ id: uuid('generation ID') });

export const listGenerationsQuerySchema = z.object({
  academicYearId: uuid('academic year ID'),
  limit: z.coerce.number({ error: 'limit must be an integer' }).int('limit must be an integer').min(1, 'limit must be between 1 and 100').max(100, 'limit must be between 1 and 100').default(50),
});

export type StartGenerationBody = z.input<typeof startGenerationSchema>;
export type StartGenerationInput = z.output<typeof startGenerationSchema>;
export type GenerationParams = z.input<typeof generationParamsSchema>;
export type ListGenerationsQuery = z.input<typeof listGenerationsQuerySchema>;

// ---------------------------------------------------------------------------
// Public view of a run
// ---------------------------------------------------------------------------

export const RUN_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'] as const;
// One list: the contract's (a second copy here could drift from it).
export { FAILURE_CODES } from './timetable-generation.contracts.js';

export interface GenerationRunView {
  id: string;
  academicYearId: string;
  status: RunRecord['status'];
  phase: string | null;
  attempts: number;
  seed: number | null;
  reproducible: boolean | null;
  timeLimitSeconds: number;
  workers: number;
  sectionCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  /** The generated version. Null while running, after a failure, and after the version was deleted (the run keeps result.versionId). */
  versionId: string | null;
  /**
   * true when the run produced a version that was deleted afterwards. `versionId` is the CURRENT link (it becomes null on delete);
   * `result.versionId` is the historical identifier and may no longer resolve. Computed, not stored.
   */
  versionDeleted: boolean;
  /** The draft this run was started from (provenance; may no longer exist), or null for a plain generation. */
  sourceVersionId: string | null;
  /** How many locked lessons were frozen into the run (0 for a plain generation). */
  lockedEntryCount: number;
  /** Present once the run SUCCEEDED. */
  result: Record<string, unknown> | null;
  /** Present once the run FAILED. */
  failure: { code: string; message: string; diagnostics: unknown } | null;
}

// ---------------------------------------------------------------------------
// Bounded, scrubbed diagnostics. Stored diagnostics were written for operators: they may carry process ids, the tail of the
// solver's stderr (which can contain file-system paths) or a database error message. The API never returns those.
// ---------------------------------------------------------------------------
const HIDDEN_KEYS = new Set(['stderrTail', 'pid', 'leaseOwner', 'token', 'error', 'stack', 'stdin', 'stdoutBytes', 'stderrBytes', 'inputHash', 'cwd', 'path', 'command', 'args', 'env']);
const MAX_STRING = 300;
const MAX_ARRAY = 25;
const MAX_KEYS = 40;
const MAX_DEPTH = 6;
const MAX_TOTAL_CHARS = 16_000;

function scrub(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => scrub(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let kept = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (HIDDEN_KEYS.has(key)) continue;
      if (kept++ >= MAX_KEYS) break;
      out[key] = scrub(item, depth + 1);
    }
    return out;
  }
  return null;
}

export function publicDiagnostics(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const clean = scrub(value, 0);
  const text = JSON.stringify(clean) ?? 'null';
  return text.length <= MAX_TOTAL_CHARS ? clean : { truncated: true, preview: text.slice(0, 2_000) };
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toRunView(run: RunRecord): GenerationRunView {
  const options = (typeof run.options === 'object' && run.options !== null ? run.options : {}) as { seed?: unknown; reproducible?: unknown; sourceVersionId?: unknown; lockedEntries?: unknown };
  let result: Record<string, unknown> | null = null;
  if (run.status === 'SUCCEEDED' && typeof run.resultSummary === 'object' && run.resultSummary !== null) {
    result = publicDiagnostics(run.resultSummary) as Record<string, unknown>;
  }
  return {
    id: run.id,
    academicYearId: run.academicYearId,
    status: run.status,
    phase: run.phase,
    attempts: run.attempts,
    seed: typeof options.seed === 'number' ? options.seed : null,
    reproducible: typeof options.reproducible === 'boolean' ? options.reproducible : null,
    timeLimitSeconds: run.timeLimitSeconds,
    workers: run.workers,
    sectionCount: run.sectionCount,
    createdAt: run.createdAt.toISOString(),
    startedAt: iso(run.startedAt),
    completedAt: iso(run.finishedAt),
    updatedAt: run.updatedAt.toISOString(),
    versionId: run.versionId,
    sourceVersionId: typeof options.sourceVersionId === 'string' ? options.sourceVersionId : null,
    lockedEntryCount: Array.isArray(options.lockedEntries) ? options.lockedEntries.length : 0,
    versionDeleted: run.status === 'SUCCEEDED' && run.versionId === null && typeof (result as { versionId?: unknown } | null)?.versionId === 'string',
    result,
    failure:
      run.status === 'FAILED'
        ? { code: run.failureCode ?? 'INTERNAL_INCONSISTENCY', message: (run.failureMessage ?? 'The generation failed').slice(0, 1_000), diagnostics: publicDiagnostics(run.failureDiagnostics) }
        : null,
  };
}
