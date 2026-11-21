// ---------------------------------------------------------------------------
// Curriculum: pure rules (no database). A curriculum is the set of subject requirements of one grade (or one stream of it) in one academic year:
// WHAT must be taught and how many periods a week. WHO teaches it (teacher-subject links, grade eligibility, assignments) is a separate concern.
// ---------------------------------------------------------------------------

export type Scope = 'ALL_SECTIONS' | 'SELECTED_SECTIONS';
export type Classification = 'COMMON' | 'GRADE_SPECIFIC' | 'STREAM_SPECIFIC' | 'SECTION_SPECIFIC';

/** One subject of a curriculum, normalised for comparison (sectionIds sorted, empty for ALL_SECTIONS). */
export interface Line { subjectId: string; periodsPerWeek: number; isOptional: boolean; sectionScope: Scope; sectionIds: string[] }

export const normalizeLine = (l: { subjectId: string; periodsPerWeek: number; isOptional?: boolean | undefined; sectionScope?: Scope | undefined; sectionIds?: readonly string[] | undefined }): Line => {
  const scope = l.sectionScope ?? 'ALL_SECTIONS';
  return { subjectId: l.subjectId, periodsPerWeek: l.periodsPerWeek, isOptional: l.isOptional ?? false, sectionScope: scope, sectionIds: scope === 'SELECTED_SECTIONS' ? [...new Set(l.sectionIds ?? [])].sort() : [] };
};

export function changesBetween(from: Line, to: Line): string[] {
  const out: string[] = [];
  if (from.periodsPerWeek !== to.periodsPerWeek) out.push('periodsPerWeek');
  if (from.isOptional !== to.isOptional) out.push('isOptional');
  if (from.sectionScope !== to.sectionScope || from.sectionIds.join() !== to.sectionIds.join()) out.push('sections');
  return out;
}

export interface Plan<E extends Line> {
  create: Line[];
  update: Array<{ id: string; from: E; to: Line; changes: string[] }>;
  remove: E[];
  unchanged: number;
}

/** What it takes to turn the EXISTING curriculum into the DESIRED one (matched by subject). Deterministic: ordered by subject id. */
export function planCurriculum<E extends Line & { id: string }>(existing: readonly E[], desired: readonly Line[]): Plan<E> {
  const have = new Map(existing.map((e) => [e.subjectId, e]));
  const want = new Map(desired.map((d) => [d.subjectId, d]));
  const create = [...want.values()].filter((d) => !have.has(d.subjectId)).sort((a, b) => (a.subjectId < b.subjectId ? -1 : 1));
  const remove = [...have.values()].filter((e) => !want.has(e.subjectId)).sort((a, b) => (a.subjectId < b.subjectId ? -1 : 1));
  const update: Plan<E>['update'] = [];
  let unchanged = 0;
  for (const d of [...want.values()].sort((a, b) => (a.subjectId < b.subjectId ? -1 : 1))) {
    const e = have.get(d.subjectId);
    if (!e) continue;
    const changes = changesBetween(e, d);
    if (changes.length === 0) unchanged++;
    else update.push({ id: e.id, from: e, to: d, changes });
  }
  return { create, update, remove, unchanged };
}

export interface ReqRow extends Line { id: string; gradeId: string; streamId: string | null }

export interface ClassifyContext {
  /** grades (of the academic year) that require each subject */
  gradesOfSubject: Map<string, Set<string>>;
  /** streams of a grade that require each subject, keyed `${subjectId}|${gradeId}` */
  streamsOfSubjectInGrade: Map<string, Set<string>>;
  /** number of streams each grade has */
  streamCount: Map<string, number>;
}

export function buildClassifyContext(requirements: readonly ReqRow[], streamCount: Map<string, number>): ClassifyContext {
  const gradesOfSubject = new Map<string, Set<string>>();
  const streamsOfSubjectInGrade = new Map<string, Set<string>>();
  for (const r of requirements) {
    (gradesOfSubject.get(r.subjectId) ?? gradesOfSubject.set(r.subjectId, new Set()).get(r.subjectId)!).add(r.gradeId);
    if (r.streamId) {
      const key = `${r.subjectId}|${r.gradeId}`;
      (streamsOfSubjectInGrade.get(key) ?? streamsOfSubjectInGrade.set(key, new Set()).get(key)!).add(r.streamId);
    }
  }
  return { gradesOfSubject, streamsOfSubjectInGrade, streamCount };
}

/**
 * How widely a requirement applies, derived from the data (nothing about any particular curriculum is built in):
 *   SECTION_SPECIFIC  restricted to selected sections
 *   STREAM_SPECIFIC   belongs to a stream, and not every stream of the grade requires that subject
 *   COMMON            the subject is required in more than one grade of the year
 *   GRADE_SPECIFIC    the subject is required in this grade only
 */
export function classifyRequirement(r: ReqRow, ctx: ClassifyContext): Classification {
  if (r.sectionScope === 'SELECTED_SECTIONS') return 'SECTION_SPECIFIC';
  if (r.streamId !== null) {
    const streams = ctx.streamsOfSubjectInGrade.get(`${r.subjectId}|${r.gradeId}`)?.size ?? 0;
    if (streams < (ctx.streamCount.get(r.gradeId) ?? 0)) return 'STREAM_SPECIFIC';
  }
  return (ctx.gradesOfSubject.get(r.subjectId)?.size ?? 0) > 1 ? 'COMMON' : 'GRADE_SPECIFIC';
}

export type IssueCode = 'GROUP_WITHOUT_CURRICULUM' | 'CURRICULUM_WITHOUT_SECTIONS' | 'SECTION_DEMAND_EXCEEDS_SLOTS' | 'MIXED_GRADE_MODE';
export interface Issue { code: IssueCode; severity: 'ERROR' | 'WARNING'; gradeId: string; streamId: string | null; sectionId?: string; message: string }

/** Weekly demand of one section: the periods of every requirement that applies to it. */
export function sectionDemand(section: { id: string }, requirements: readonly ReqRow[]): number {
  return requirements.reduce((sum, r) => sum + (r.sectionScope === 'ALL_SECTIONS' || r.sectionIds.includes(section.id) ? r.periodsPerWeek : 0), 0);
}
