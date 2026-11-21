import { z } from 'zod';
import { publicDiagnostics } from '../timetable-generation/timetable-generation.schema.js';

export const versionParamsSchema = z.object({
  id: z.string({ error: 'version ID is required' }).uuid('Invalid version ID format'),
});

export const VERSION_STATUS_VALUES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;

/**
 * Phase 7F-3: `status` is one status or several, as a comma-separated list (status=DRAFT,PUBLISHED) or a repeated parameter
 * (status=DRAFT&status=PUBLISHED). Exactly DRAFT, PUBLISHED or ARCHIVED (upper case); duplicates collapse; an empty value, an empty
 * element (a trailing comma) or anything else is a 400. Absent: every status, exactly as before.
 */
const statusFilter = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value, ctx): Array<(typeof VERSION_STATUS_VALUES)[number]> | undefined => {
    if (value === undefined) return undefined;
    const parts = (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(',')).map((v) => v.trim());
    const bad = parts.filter((p) => !(VERSION_STATUS_VALUES as readonly string[]).includes(p));
    if (parts.length === 0 || bad.length > 0) {
      ctx.issues.push({ code: 'custom', message: 'status must be DRAFT, PUBLISHED or ARCHIVED (several: comma-separated or repeated)', input: value });
      return z.NEVER;
    }
    return [...new Set(parts)] as Array<(typeof VERSION_STATUS_VALUES)[number]>;
  });

export const listVersionsQuerySchema = z.object({
  academicYearId: z.string({ error: 'academicYearId is required' }).uuid('Invalid academic year ID format'),
  status: statusFilter,
  /** Phase 7F-3: opt-in. Only the literal strings true / false. */
  includeStaleness: z.enum(['true', 'false'], { error: 'includeStaleness must be true or false' }).default('false').transform((v) => v === 'true'),
});

/** Phase 7F-2: POST /timetable-versions/:id/clone. Strict: no field can name a year, a school, lessons or a status. */
export const cloneBodySchema = z.strictObject({
  lockMode: z.enum(['KEEP', 'ALL', 'NONE'], { error: 'lockMode must be KEEP, ALL or NONE' }).default('KEEP'),
  /** Phase 7F-3: opt-in. true adds `staleness` to the response. */
  includeStaleness: z.boolean({ error: 'includeStaleness must be true or false' }).default(false),
});
export type CloneBody = z.output<typeof cloneBodySchema>;
export type CloneBodyInput = z.input<typeof cloneBodySchema>;

/** Phase 7F-1: ?view=section|teacher&id=<uuid>[&periodTimes=snapshot|current]. Unknown query keys are ignored, as on the other version routes. */
export const timetableViewQuerySchema = z.object({
  view: z.enum(['section', 'teacher'], { error: 'view must be section or teacher' }),
  id: z.string({ error: 'id is required (the section or teacher ID)' }).uuid('Invalid section or teacher ID format'),
  periodTimes: z.enum(['snapshot', 'current'], { error: 'periodTimes must be snapshot or current' }).default('snapshot'),
});
export type TimetableViewQuery = z.output<typeof timetableViewQuerySchema>;
export type TimetableViewQueryInput = z.input<typeof timetableViewQuerySchema>;

const entryId = (what: string) => z.string({ error: `${what} is required` }).uuid(`Invalid ${what} format`);
const expectedRevision = z
  .number({ error: 'expectedRevision is required and must be an integer' })
  .int('expectedRevision must be an integer')
  .min(1, 'expectedRevision must be at least 1');

/**
 * Strict: any other key (teacher, subject, section, assignment, ...) is a 400. The day and period are only checked for TYPE here;
 * whether they are a working day and period of THIS timetable is the rule INVALID_SLOT (400), decided against the version's grid.
 */
export const moveBodySchema = z.strictObject({
  entryId: entryId('entry ID'),
  to: z.strictObject({
    dayOfWeek: z.string({ error: 'dayOfWeek is required' }).min(1, 'dayOfWeek is required').max(20, 'dayOfWeek is too long'),
    periodNumber: z.number({ error: 'periodNumber must be an integer' }).int('periodNumber must be an integer'),
  }),
  swapWithEntryId: entryId('swap entry ID').optional(),
  expectedRevision,
});

export const locksBodySchema = z.strictObject({
  entryIds: z
    .array(entryId('entry ID'), { error: 'entryIds must be a list of entry IDs' })
    .min(1, 'entryIds must contain at least one entry')
    .max(1000, 'entryIds can contain at most 1000 entries')
    .refine((ids) => new Set(ids).size === ids.length, 'entryIds must not contain duplicates'),
  locked: z.boolean({ error: 'locked must be true or false' }),
  expectedRevision,
});

/** expectedPublishedVersionId is REQUIRED but nullable: null states "there was no published version when I looked". */
export const publishBodySchema = z.strictObject({
  expectedRevision,
  expectedPublishedVersionId: z.string({ error: 'expectedPublishedVersionId must be a version ID or null' }).uuid('Invalid expectedPublishedVersionId format').nullable(),
});

/**
 * The explicit confirmation to delete a PUBLISHED or ARCHIVED version (a draft needs none). It names the version number (typed back by the administrator), the status and the
 * revision they were looking at, so a request prepared for one state can never delete a version that has since changed.
 */
export const deleteVersionBodySchema = z.strictObject({
  confirmVersionNumber: z.number({ error: 'confirmVersionNumber must be the number of the version being deleted' }).int('confirmVersionNumber must be a whole number').min(1, 'confirmVersionNumber must be at least 1'),
  expectedStatus: z.enum(['PUBLISHED', 'ARCHIVED'], { error: 'expectedStatus must be PUBLISHED or ARCHIVED' }),
  expectedRevision,
});

export type DeleteVersionBody = z.input<typeof deleteVersionBodySchema>;
export type VersionParams = z.input<typeof versionParamsSchema>;
export type MoveBody = z.input<typeof moveBodySchema>;
export type LocksBody = z.input<typeof locksBodySchema>;
export type PublishBody = z.input<typeof publishBodySchema>;
export type ListVersionsQuery = z.input<typeof listVersionsQuerySchema>;
export type ListVersionsParsed = z.output<typeof listVersionsQuerySchema>;

export const VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'ARCHIVED'] as const;
export const SOLUTION_SOURCES = ['CP_SAT', 'BASELINE'] as const;
export const SOLVER_STATUSES = ['OPTIMAL', 'FEASIBLE', 'UNKNOWN'] as const;
export const DAYS_OF_WEEK = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const;

export interface VersionSummaryView {
  id: string;
  academicYearId: string;
  versionNumber: number;
  status: (typeof VERSION_STATUSES)[number];
  solutionSource: (typeof SOLUTION_SOURCES)[number];
  solverStatus: (typeof SOLVER_STATUSES)[number];
  optimal: boolean;
  weightsVersion: string;
  inputHash: string;
  metrics: unknown;
  baselineMetrics: unknown;
  entryCount: number;
  /** Optimistic-concurrency token: send it back as expectedRevision. Starts at 1 and grows with every successful change. */
  revision: number;
  publishedAt: string | null;
  archivedAt: string | null;
  lockedCount: number;
  manualEditCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EntryView {
  id: string;
  sectionId: string;
  subjectId: string;
  teacherId: string;
  subjectRequirementId: string;
  dayOfWeek: (typeof DAYS_OF_WEEK)[number];
  periodNumber: number;
  source: string;
  isLocked: boolean;
}

export interface VersionDetailView extends VersionSummaryView {
  solverDiagnostics: unknown;
  entries: EntryView[];
}

interface VersionRow {
  id: string;
  academicYearId: string;
  versionNumber: number;
  status: VersionSummaryView['status'];
  solutionSource: VersionSummaryView['solutionSource'];
  solverStatus: VersionSummaryView['solverStatus'];
  weightsVersion: string;
  inputHash: string;
  metrics: unknown;
  baselineMetrics: unknown;
  solverDiagnostics?: unknown;
  revision: number;
  publishedAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EntryCounts {
  total: number;
  locked: number;
  manual: number;
}

export function toVersionSummary(row: VersionRow, counts: EntryCounts): VersionSummaryView {
  return {
    id: row.id,
    academicYearId: row.academicYearId,
    versionNumber: row.versionNumber,
    status: row.status,
    solutionSource: row.solutionSource,
    solverStatus: row.solverStatus,
    optimal: row.solverStatus === 'OPTIMAL',
    weightsVersion: row.weightsVersion,
    inputHash: row.inputHash,
    metrics: row.metrics,
    baselineMetrics: row.baselineMetrics,
    entryCount: counts.total,
    revision: row.revision,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    lockedCount: counts.locked,
    manualEditCount: counts.manual,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toVersionDetail(row: VersionRow, entries: EntryView[]): VersionDetailView {
  const counts: EntryCounts = { total: entries.length, locked: entries.filter((e) => e.isLocked).length, manual: entries.filter((e) => e.source === 'MANUAL').length };
  return { ...toVersionSummary(row, counts), solverDiagnostics: publicDiagnostics(row.solverDiagnostics ?? null), entries };
}
