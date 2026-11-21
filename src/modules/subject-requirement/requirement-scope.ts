import { type Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors.js';

type Tx = Prisma.TransactionClient;

export const MAX_SELECTED_SECTIONS = 200;

/**
 * Validate a section selection for a requirement of (gradeId, streamId): every section must exist, belong to the school, and be in the requirement's grade with EXACTLY its stream
 * (the same rule as for teacher assignments: a non-streamed requirement applies only to non-streamed sections). Returns the distinct, sorted ids. Throws 400 with a field error
 * naming the first problem, 403 for another school's section.
 */
export async function validateSectionSelection(tx: Tx, schoolId: string, requirement: { gradeId: string; streamId: string | null }, sectionIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(sectionIds)].sort();
  if (ids.length === 0) throw new AppError(400, 'Validation failed', { sectionIds: ['Select at least one section, or use ALL_SECTIONS'] });
  const sections = await tx.section.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, gradeId: true, streamId: true, grade: { select: { academicYear: { select: { schoolId: true } } } } } });
  const byId = new Map(sections.map((s) => [s.id, s]));
  for (const id of ids) {
    const s = byId.get(id);
    if (!s) throw new AppError(400, 'Validation failed', { sectionIds: [`Section ${id} does not exist`] });
    if (s.grade.academicYear.schoolId !== schoolId) throw new AppError(403, 'You do not have access to one of the selected sections');
    if (s.gradeId !== requirement.gradeId) throw new AppError(400, 'Validation failed', { sectionIds: [`Section "${s.name}" belongs to a different grade than the requirement`] });
    if (s.streamId !== requirement.streamId) {
      throw new AppError(400, 'Validation failed', { sectionIds: [`Section "${s.name}" is ${s.streamId === null ? 'not in a stream' : 'in a different stream'}, but the requirement is ${requirement.streamId === null ? 'not stream-specific' : 'for another stream'}`] });
    }
  }
  return ids;
}

/**
 * Teacher assignment guard: a SELECTED_SECTIONS requirement applies only to its sections. The requirement row is share-locked first, so a concurrent scope change (which takes it
 * FOR UPDATE) waits for this transaction, or the check below sees its result.
 */
export async function assertSectionInScope(tx: Tx, requirementId: string, sectionId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ sectionScope: string }>>`SELECT "sectionScope"::text AS "sectionScope" FROM "subject_requirements" WHERE "id" = ${requirementId} FOR SHARE`;
  const scope = rows[0]?.sectionScope;
  if (scope === undefined) throw new AppError(404, 'Subject requirement not found');
  if (scope !== 'SELECTED_SECTIONS') return;
  const member = await tx.subjectRequirementSection.findUnique({ where: { subjectRequirementId_sectionId: { subjectRequirementId: requirementId, sectionId } }, select: { id: true } });
  if (!member) throw new AppError(400, 'The subject requirement is configured for selected sections only, and this section is not one of them');
}
