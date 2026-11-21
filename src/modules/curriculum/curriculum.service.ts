import prisma from '../../config/database.js';
import { AppError, isUniqueViolation } from '../../utils/errors.js';
import { RowErrors } from '../../utils/bulk.js';
import { isGradeStreamed } from '../subject-requirement/subject-requirement.service.js';
import { validateSectionSelection } from '../subject-requirement/requirement-scope.js';
import {
  buildClassifyContext,
  classifyRequirement,
  normalizeLine,
  planCurriculum,
  sectionDemand,
  type Issue,
  type Line,
  type ReqRow,
} from './curriculum.core.js';
import { type CopyCurriculumInput, type ReplaceCurriculumInput } from './curriculum.schema.js';

const DRAFT_ONLY = 'The curriculum can only be modified while the academic year is in DRAFT status';
const STREAMED_MESSAGE = 'This grade uses streams, so streamId is required for its curriculum';
const NOT_STREAMED_MESSAGE = 'This grade is not streamed, so streamId must be omitted for its curriculum';

async function fetchGradeOwned(schoolId: string, gradeId: string) {
  const grade = await prisma.grade.findUnique({ where: { id: gradeId }, include: { academicYear: { select: { id: true, name: true, status: true, schoolId: true } } } });
  if (!grade) throw new AppError(404, 'Grade not found');
  if (grade.academicYear.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this grade');
  return grade;
}

async function resolveStream(gradeId: string, streamId: string | null | undefined): Promise<string | null> {
  if (streamId === undefined || streamId === null) return null;
  const stream = await prisma.stream.findUnique({ where: { id: streamId }, select: { id: true, gradeId: true } });
  if (!stream) throw new AppError(404, 'Stream not found');
  if (stream.gradeId !== gradeId) throw new AppError(400, 'Stream does not belong to the specified grade');
  return stream.id;
}

type Described = Line & { subjectName: string; subjectCode: string };

export class CurriculumService {
  // ===================================================================================================================================================
  // Overview (read-only): the whole curriculum of an academic year, how widely each subject applies, and what needs the admin's review
  // ===================================================================================================================================================
  async getOverview(schoolId: string, academicYearId: string) {
    const year = await prisma.academicYear.findUnique({ where: { id: academicYearId }, select: { id: true, name: true, status: true, schoolId: true } });
    if (!year) throw new AppError(404, 'Academic year not found');
    if (year.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this academic year');

    const inYear = { academicYearId };
    const [grades, streams, sections, requirements, schedule] = await Promise.all([
      prisma.grade.findMany({ where: inYear, select: { id: true, name: true, displayOrder: true }, orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }] }),
      prisma.stream.findMany({ where: { grade: inYear }, select: { id: true, gradeId: true, name: true, code: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
      prisma.section.findMany({ where: { grade: inYear }, select: { id: true, gradeId: true, streamId: true, name: true, code: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
      prisma.subjectRequirement.findMany({ where: { grade: inYear }, include: { subject: { select: { id: true, name: true, code: true } }, sections: { select: { sectionId: true } } }, orderBy: [{ subject: { name: 'asc' } }, { id: 'asc' }] }),
      prisma.scheduleConfig.findUnique({ where: { academicYearId }, select: { periodsPerDay: true, _count: { select: { days: true } } } }),
    ]);
    const weeklySlots = schedule ? schedule.periodsPerDay * schedule._count.days : null;

    const rows: Array<ReqRow & { subject: { id: string; name: string; code: string } }> = requirements.map((r) => ({
      id: r.id, gradeId: r.gradeId, streamId: r.streamId, subjectId: r.subjectId, periodsPerWeek: r.periodsPerWeek, isOptional: r.isOptional, sectionScope: r.sectionScope, sectionIds: r.sections.map((s) => s.sectionId).sort(), subject: r.subject,
    }));
    const streamCount = new Map<string, number>();
    for (const s of streams) streamCount.set(s.gradeId, (streamCount.get(s.gradeId) ?? 0) + 1);
    const ctx = buildClassifyContext(rows, streamCount);

    const issues: Issue[] = [];
    const outGrades = grades.map((g) => {
      const gStreams = streams.filter((s) => s.gradeId === g.id);
      const gSections = sections.filter((s) => s.gradeId === g.id);
      const streamedSections = gSections.filter((s) => s.streamId !== null).length;
      if (streamedSections > 0 && streamedSections < gSections.length) {
        issues.push({ code: 'MIXED_GRADE_MODE', severity: 'WARNING', gradeId: g.id, streamId: null, message: `${g.name} has both streamed and non-streamed sections; its curriculum is configured per stream, so review it.` });
      }
      const streamed = gStreams.length > 0 || streamedSections > 0;
      const groupKeys: Array<string | null> = streamed ? [...gStreams.map((s) => s.id), ...(gSections.some((s) => s.streamId === null) ? [null] : [])] : [null];
      const curricula = groupKeys.map((streamId) => {
        const stream = streamId ? gStreams.find((s) => s.id === streamId)! : null;
        const groupSections = gSections.filter((s) => s.streamId === streamId);
        const groupRows = rows.filter((r) => r.gradeId === g.id && r.streamId === streamId);
        const label = stream ? `${g.name} · ${stream.name}` : g.name;
        if (groupRows.length === 0 && (groupSections.length > 0 || streamed)) {
          issues.push({ code: 'GROUP_WITHOUT_CURRICULUM', severity: 'WARNING', gradeId: g.id, streamId, message: `${label} has no subject requirements yet: its ${groupSections.length} section(s) would have nothing to schedule.` });
        }
        if (groupRows.length > 0 && groupSections.length === 0) {
          issues.push({ code: 'CURRICULUM_WITHOUT_SECTIONS', severity: 'WARNING', gradeId: g.id, streamId, message: `${label} has a curriculum but no sections yet, so nothing will be scheduled for it.` });
        }
        const secDemand = groupSections.map((s) => {
          const demand = sectionDemand(s, groupRows);
          if (weeklySlots !== null && demand > weeklySlots) {
            issues.push({ code: 'SECTION_DEMAND_EXCEEDS_SLOTS', severity: 'ERROR', gradeId: g.id, streamId, sectionId: s.id, message: `${label} / ${s.name} needs ${demand} periods a week but the schedule has only ${weeklySlots} slots.` });
          }
          return { id: s.id, name: s.name, code: s.code, periodsPerWeek: demand };
        });
        return {
          streamId,
          stream: stream ? { id: stream.id, name: stream.name, code: stream.code } : null,
          label,
          sectionCount: groupSections.length,
          sections: secDemand,
          requirements: groupRows.map((r) => ({
            id: r.id, subject: r.subject, periodsPerWeek: r.periodsPerWeek, isOptional: r.isOptional, sectionScope: r.sectionScope, sectionIds: r.sectionIds,
            appliesToSections: r.sectionScope === 'ALL_SECTIONS' ? groupSections.length : r.sectionIds.length,
            classification: classifyRequirement(r, ctx),
          })),
          totalPeriods: groupRows.reduce((n, r) => n + r.periodsPerWeek, 0),
        };
      });
      return { id: g.id, name: g.name, displayOrder: g.displayOrder, streamed, streams: gStreams.map((s) => ({ id: s.id, name: s.name, code: s.code })), sectionCount: gSections.length, curricula };
    });

    // every subject used in the year: where it applies (a subject keeps ONE identity across grades)
    const bySubject = new Map<string, { subject: { id: string; name: string; code: string }; usage: Array<{ gradeId: string; streamId: string | null; periodsPerWeek: number; isOptional: boolean }> }>();
    for (const r of rows) {
      const e = bySubject.get(r.subjectId) ?? { subject: r.subject, usage: [] };
      e.usage.push({ gradeId: r.gradeId, streamId: r.streamId, periodsPerWeek: r.periodsPerWeek, isOptional: r.isOptional });
      bySubject.set(r.subjectId, e);
    }
    return {
      academicYear: { id: year.id, name: year.name, status: year.status },
      weeklySlots,
      grades: outGrades,
      subjects: [...bySubject.values()].sort((a, b) => a.subject.name.localeCompare(b.subject.name)).map((e) => ({ ...e, gradeCount: new Set(e.usage.map((u) => u.gradeId)).size })),
      issues,
    };
  }

  // ===================================================================================================================================================
  // Replace the complete curriculum of one grade (or one stream of it), atomically
  // ===================================================================================================================================================

  /**
   * Make the curriculum of (grade, stream) exactly the given list: subjects not yet required are added, changed ones updated, unlisted ones removed. One transaction, under the grade lock and
   * row locks on the existing requirements (the same locks single-requirement edits take), so it serialises with section creation and teacher assignment. Nothing is written when any line is invalid.
   * Removing a requirement, or restricting its sections, is refused (409) while teacher assignments depend on it. With dryRun the plan is returned and nothing is written.
   * It touches ONLY subject requirements: no teacher-subject link, grade eligibility, assignment or published timetable entry is created or changed.
   */
  async replaceCurriculum(schoolId: string, gradeId: string, input: ReplaceCurriculumInput) {
    const grade = await fetchGradeOwned(schoolId, gradeId);
    if (grade.academicYear.status !== 'DRAFT') throw new AppError(400, DRAFT_ONLY);
    const streamId = await resolveStream(gradeId, input.streamId);

    const errors = new RowErrors();
    const seen = new Map<string, number>();
    input.requirements.forEach((l, i) => {
      const first = seen.get(l.subjectId);
      if (first !== undefined) errors.add(`requirements.${i}.subjectId`, `Duplicate subject: already listed at requirements.${first}`);
      else seen.set(l.subjectId, i);
    });
    const subjects = await prisma.subject.findMany({ where: { schoolId, id: { in: [...seen.keys()] } }, select: { id: true, name: true, code: true } });
    const subjectById = new Map(subjects.map((s) => [s.id, s]));
    input.requirements.forEach((l, i) => { if (!subjectById.has(l.subjectId)) errors.add(`requirements.${i}.subjectId`, 'This subject does not exist in your school'); });
    errors.throwIfAny(400, 'Validation failed');

    const describe = (l: Line): Described => ({ ...l, subjectName: subjectById.get(l.subjectId)?.name ?? l.subjectId, subjectCode: subjectById.get(l.subjectId)?.code ?? '' });

    const run = () => prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "grades" WHERE "id" = ${gradeId} FOR UPDATE`;
      const streamed = await isGradeStreamed(tx, gradeId);
      if (streamed && streamId === null) throw new AppError(400, STREAMED_MESSAGE);
      if (!streamed && streamId !== null) throw new AppError(400, NOT_STREAMED_MESSAGE);

      await tx.$queryRaw`SELECT "id" FROM "subject_requirements" WHERE "gradeId" = ${gradeId} AND "streamId" IS NOT DISTINCT FROM ${streamId} ORDER BY "id" FOR UPDATE`;
      const existingRows = await tx.subjectRequirement.findMany({ where: { gradeId, streamId }, include: { sections: { select: { sectionId: true } }, subject: { select: { id: true, name: true, code: true } } } });
      const existing = existingRows.map((r) => ({ id: r.id, ...normalizeLine({ subjectId: r.subjectId, periodsPerWeek: r.periodsPerWeek, isOptional: r.isOptional, sectionScope: r.sectionScope, sectionIds: r.sections.map((s) => s.sectionId) }) }));
      const nameOf = new Map(existingRows.map((r) => [r.subjectId, r.subject]));

      // the requested lines, with section selections validated against THIS grade and stream
      const rowErrors = new RowErrors();
      const desired: Line[] = [];
      for (const [i, l] of input.requirements.entries()) {
        const line = normalizeLine(l);
        if (line.sectionScope === 'SELECTED_SECTIONS') {
          try { line.sectionIds = await validateSectionSelection(tx, schoolId, { gradeId, streamId }, line.sectionIds); }
          catch (e) { if (e instanceof AppError && e.statusCode === 400) rowErrors.add(`requirements.${i}.sectionIds`, e.errors?.sectionIds?.[0] ?? e.message); else throw e; }
        }
        desired.push(line);
      }
      rowErrors.throwIfAny(400, 'Validation failed');

      const plan = planCurriculum(existing, desired);

      // refuse (409) rather than cascade-delete or strand teacher assignments
      const assignments = existing.length === 0 ? [] : await tx.sectionSubjectTeacher.findMany({ where: { subjectRequirementId: { in: existing.map((e) => e.id) } }, select: { subjectRequirementId: true, sectionId: true } });
      const blockers: string[] = [];
      for (const r of plan.remove) {
        const n = assignments.filter((a) => a.subjectRequirementId === r.id).length;
        if (n > 0) blockers.push(`${nameOf.get(r.subjectId)?.name ?? r.subjectId}: ${n} teacher assignment(s) exist, so it cannot be removed`);
      }
      for (const u of plan.update) {
        if (u.to.sectionScope !== 'SELECTED_SECTIONS') continue;
        const stranded = assignments.filter((a) => a.subjectRequirementId === u.id && !u.to.sectionIds.includes(a.sectionId)).length;
        if (stranded > 0) blockers.push(`${nameOf.get(u.from.subjectId)?.name ?? u.from.subjectId}: ${stranded} teacher assignment(s) exist for sections that would no longer have it`);
      }
      if (blockers.length > 0) throw new AppError(409, 'Some subjects have teacher assignments. Remove those assignments first; nothing was changed.', { blockedBy: blockers });

      const summary = {
        create: plan.create.map(describe),
        update: plan.update.map((u) => ({ id: u.id, subjectId: u.to.subjectId, subjectName: nameOf.get(u.from.subjectId)?.name ?? '', changes: u.changes, from: u.from, to: u.to })),
        remove: plan.remove.map((r) => ({ id: r.id, subjectId: r.subjectId, subjectName: nameOf.get(r.subjectId)?.name ?? r.subjectId, periodsPerWeek: r.periodsPerWeek })),
        unchanged: plan.unchanged,
      };
      if (input.dryRun === true) return { applied: false, gradeId, streamId, plan: summary };

      for (const r of plan.remove) await tx.subjectRequirement.delete({ where: { id: r.id } });
      for (const u of plan.update) {
        const scopeChanged = u.changes.includes('sections');
        if (scopeChanged) await tx.subjectRequirementSection.deleteMany({ where: { subjectRequirementId: u.id } });
        await tx.subjectRequirement.update({ where: { id: u.id }, data: { periodsPerWeek: u.to.periodsPerWeek, isOptional: u.to.isOptional, sectionScope: u.to.sectionScope } });
        if (scopeChanged && u.to.sectionScope === 'SELECTED_SECTIONS') await tx.subjectRequirementSection.createMany({ data: u.to.sectionIds.map((sectionId) => ({ subjectRequirementId: u.id, sectionId })) });
      }
      for (const l of plan.create) {
        await tx.subjectRequirement.create({ data: { gradeId, streamId, subjectId: l.subjectId, periodsPerWeek: l.periodsPerWeek, isOptional: l.isOptional, sectionScope: l.sectionScope, ...(l.sectionIds.length > 0 ? { sections: { create: l.sectionIds.map((sectionId) => ({ sectionId })) } } : {}) } });
      }
      const after = await tx.subjectRequirement.findMany({ where: { gradeId, streamId }, include: { subject: { select: { id: true, name: true, code: true } }, sections: { select: { sectionId: true } } }, orderBy: [{ subject: { name: 'asc' } }, { id: 'asc' }] });
      return {
        applied: true, gradeId, streamId, plan: summary,
        requirements: after.map((r) => ({ id: r.id, subject: r.subject, periodsPerWeek: r.periodsPerWeek, isOptional: r.isOptional, sectionScope: r.sectionScope, sectionIds: r.sections.map((s) => s.sectionId).sort() })),
      };
    }, { timeout: 30_000, maxWait: 10_000 });

    try {
      return await run();
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError(409, 'A requirement for one of these subjects was created at the same time. Reload the curriculum and try again; nothing was changed.');
      throw error;
    }
  }

  // ===================================================================================================================================================
  // Copy a curriculum from another grade/stream (possibly of a previous academic year)
  // ===================================================================================================================================================

  /**
   * Add the source curriculum's subjects to the target grade/stream (a DRAFT year of the same school). Never overwrites: subjects the target already requires are left as they are and reported.
   * Requirements restricted to selected sections are NOT copied (their sections are specific to the source) and are reported for review. Section scopes are not guessed.
   */
  async copyCurriculum(schoolId: string, input: CopyCurriculumInput) {
    const [fromGrade, toGrade] = [await fetchGradeOwned(schoolId, input.fromGradeId), await fetchGradeOwned(schoolId, input.toGradeId)];
    if (toGrade.academicYear.status !== 'DRAFT') throw new AppError(400, DRAFT_ONLY);
    const fromStreamId = await resolveStream(fromGrade.id, input.fromStreamId);
    const toStreamId = await resolveStream(toGrade.id, input.toStreamId);
    if (fromGrade.id === toGrade.id && fromStreamId === toStreamId) throw new AppError(400, 'The source and the target are the same grade/stream');

    const source = await prisma.subjectRequirement.findMany({ where: { gradeId: fromGrade.id, streamId: fromStreamId, subject: { schoolId } }, include: { subject: { select: { id: true, name: true, code: true } } }, orderBy: [{ subject: { name: 'asc' } }, { id: 'asc' }] });
    if (source.length === 0) throw new AppError(400, 'The source has no curriculum to copy');

    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "grades" WHERE "id" = ${toGrade.id} FOR UPDATE`;
      const streamed = await isGradeStreamed(tx, toGrade.id);
      if (streamed && toStreamId === null) throw new AppError(400, STREAMED_MESSAGE);
      if (!streamed && toStreamId !== null) throw new AppError(400, NOT_STREAMED_MESSAGE);
      const present = new Set((await tx.subjectRequirement.findMany({ where: { gradeId: toGrade.id, streamId: toStreamId }, select: { subjectId: true } })).map((r) => r.subjectId));

      const created: Array<{ subject: { id: string; name: string; code: string }; periodsPerWeek: number; isOptional: boolean }> = [];
      const skipped: Array<{ subject: { id: string; name: string; code: string }; reason: 'ALREADY_REQUIRED' | 'SECTION_SPECIFIC_NOT_COPIED' }> = [];
      for (const r of source) {
        if (present.has(r.subjectId)) skipped.push({ subject: r.subject, reason: 'ALREADY_REQUIRED' });
        else if (r.sectionScope === 'SELECTED_SECTIONS') skipped.push({ subject: r.subject, reason: 'SECTION_SPECIFIC_NOT_COPIED' });
        else created.push({ subject: r.subject, periodsPerWeek: r.periodsPerWeek, isOptional: r.isOptional });
      }
      if (input.dryRun !== true) {
        for (const c of created) await tx.subjectRequirement.create({ data: { gradeId: toGrade.id, streamId: toStreamId, subjectId: c.subject.id, periodsPerWeek: c.periodsPerWeek, isOptional: c.isOptional } });
      }
      return { applied: input.dryRun !== true, toGradeId: toGrade.id, toStreamId, created, skipped };
    }, { timeout: 30_000, maxWait: 10_000 });
  }
}

export const curriculumService = new CurriculumService();
