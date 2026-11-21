import { type Prisma } from '@prisma/client';
import prisma from '../../config/database.js';
import { AppError } from '../../utils/errors.js';

type Tx = Prisma.TransactionClient;

/**
 * Permanent deletion of records that were created by mistake or are no longer used.
 *
 * The schema cascades almost everywhere (a deleted section would silently delete its timetable lessons, a deleted teacher their assignments and cover history), so NOTHING here
 * relies on a cascade to do the work: every dependency that would be lost is checked first, and any one of them refuses the delete with a 409 that names what is in the way
 * (`errors.blockedBy`). Records whose history must be kept are retired instead (a teacher is deactivated with PATCH /api/teachers/:id { isActive: false }), never erased.
 *
 * Concurrency: the record is locked FOR UPDATE before its dependents are counted. Everything that attaches a new dependent (an assignment, a timetable lesson, a requirement, a section)
 * takes a share/key lock on the same row, so a dependent either committed before the count (and blocks the delete) or waits for this transaction and then fails its own foreign key.
 * Lock order is always: academic year (FOR SHARE) -> grade -> the record itself, the same direction as every other writer.
 */

const DRAFT_ONLY = (what: string) => `${what} can only be modified while the academic year is in DRAFT status`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Refuse (409) when any dependency exists; the message and `errors.blockedBy` say exactly which, so the admin knows what to remove first. */
function refuseIfBlocked(what: string, blockers: Array<string | null>, hint: string): void {
  const found = blockers.filter((b): b is string => b !== null);
  if (found.length === 0) return;
  throw new AppError(409, `${what} cannot be deleted: ${found.join('; ')}. ${hint}`, { blockedBy: found });
}

const count = (n: number, one: string, many?: string): string | null => (n > 0 ? plural(n, one, many) : null);

/** Timetable lessons of ANY version (draft, published, archived) that reference a record, with the versions named: history is never deleted through a cascade. */
async function lessonBlocker(tx: Tx, where: Prisma.TimetableEntryWhereInput): Promise<string | null> {
  const total = await tx.timetableEntry.count({ where });
  if (total === 0) return null;
  const versions = await tx.timetableEntry.findMany({ where, distinct: ['versionId'], select: { version: { select: { versionNumber: true, status: true } } }, take: 20 });
  const list = versions.map((v) => `version ${v.version.versionNumber} (${v.version.status.toLowerCase()})`).sort().join(', ');
  return `${plural(total, 'timetable lesson')} in ${list}`;
}

async function ownedYear(schoolId: string, yearId: string) {
  const year = await prisma.academicYear.findUnique({ where: { id: yearId }, select: { id: true, schoolId: true, status: true, name: true } });
  if (!year) throw new AppError(404, 'Academic year not found');
  if (year.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this academic year');
  return year;
}

/** Share-lock the year and re-check DRAFT under the lock, so the year cannot be activated while a structural delete is running. */
async function assertYearDraft(tx: Tx, yearId: string, message: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status"::text AS status FROM "academic_years" WHERE "id" = ${yearId} FOR SHARE`;
  if (rows.length === 0) throw new AppError(404, 'Academic year not found');
  if (rows[0]!.status !== 'DRAFT') throw new AppError(400, message);
}

async function lockGrade(tx: Tx, gradeId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "grades" WHERE "id" = ${gradeId} FOR UPDATE`;
  if (rows.length === 0) throw new AppError(404, 'Grade not found');
}

export class RecordDeletionService {
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  async deleteGrade(schoolId: string, gradeId: string): Promise<void> {
    const grade = await prisma.grade.findUnique({ where: { id: gradeId }, select: { id: true, name: true, academicYear: { select: { id: true, schoolId: true, status: true } } } });
    if (!grade) throw new AppError(404, 'Grade not found');
    if (grade.academicYear.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this grade');
    if (grade.academicYear.status !== 'DRAFT') throw new AppError(400, DRAFT_ONLY('Grades'));

    await prisma.$transaction(async (tx) => {
      await assertYearDraft(tx, grade.academicYear.id, DRAFT_ONLY('Grades'));
      await lockGrade(tx, gradeId);
      const [sections, streams, requirements, eligibility] = await Promise.all([
        tx.section.count({ where: { gradeId } }),
        tx.stream.count({ where: { gradeId } }),
        tx.subjectRequirement.count({ where: { gradeId } }),
        tx.teacherSubjectGrade.count({ where: { gradeId } }),
      ]);
      refuseIfBlocked(`Grade "${grade.name}"`, [count(sections, 'section'), count(streams, 'stream'), count(requirements, 'subject requirement'), count(eligibility, 'teacher grade eligibility entry', 'teacher grade eligibility entries')], 'Remove or move them first. A grade whose sections have timetable lessons keeps its history until those timetable versions are deleted.');
      await tx.grade.delete({ where: { id: gradeId } });
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  async deleteSection(schoolId: string, sectionId: string): Promise<void> {
    const section = await prisma.section.findUnique({ where: { id: sectionId }, select: { id: true, name: true, gradeId: true, grade: { select: { name: true, academicYear: { select: { id: true, schoolId: true, status: true } } } } } });
    if (!section) throw new AppError(404, 'Section not found');
    if (section.grade.academicYear.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this section');
    if (section.grade.academicYear.status !== 'DRAFT') throw new AppError(400, DRAFT_ONLY('Sections'));

    await prisma.$transaction(async (tx) => {
      await assertYearDraft(tx, section.grade.academicYear.id, DRAFT_ONLY('Sections'));
      await lockGrade(tx, section.gradeId);
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "sections" WHERE "id" = ${sectionId} FOR UPDATE`;
      if (locked.length === 0) throw new AppError(404, 'Section not found');
      const [assignments, scoped, covers, lessons] = await Promise.all([
        tx.sectionSubjectTeacher.count({ where: { sectionId } }),
        tx.subjectRequirementSection.count({ where: { sectionId } }),
        tx.coverRequest.count({ where: { sectionId } }),
        lessonBlocker(tx, { sectionId }),
      ]);
      refuseIfBlocked(`Section "${section.grade.name} ${section.name}"`, [count(assignments, 'teacher assignment'), count(scoped, 'subject requirement limited to selected sections', 'subject requirements limited to selected sections'), count(covers, 'substitution cover request'), lessons], 'Remove the assignments, take the section out of any selected-sections requirement, and delete the timetable versions that contain it first.');
      await tx.section.delete({ where: { id: sectionId } });
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  async deleteStream(schoolId: string, streamId: string): Promise<void> {
    const stream = await prisma.stream.findUnique({ where: { id: streamId }, select: { id: true, name: true, gradeId: true, grade: { select: { academicYear: { select: { id: true, schoolId: true, status: true } } } } } });
    if (!stream) throw new AppError(404, 'Stream not found');
    if (stream.grade.academicYear.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this stream');
    if (stream.grade.academicYear.status !== 'DRAFT') throw new AppError(400, DRAFT_ONLY('Streams'));

    await prisma.$transaction(async (tx) => {
      await assertYearDraft(tx, stream.grade.academicYear.id, DRAFT_ONLY('Streams'));
      await lockGrade(tx, stream.gradeId);
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "streams" WHERE "id" = ${streamId} FOR UPDATE`;
      if (locked.length === 0) throw new AppError(404, 'Stream not found');
      const [sections, requirements] = await Promise.all([tx.section.count({ where: { streamId } }), tx.subjectRequirement.count({ where: { streamId } })]);
      // Sections would otherwise silently become "no stream" (the FK is SET NULL) and the requirements would be cascade-deleted
      refuseIfBlocked(`Stream "${stream.name}"`, [count(sections, 'section'), count(requirements, 'subject requirement')], 'Delete those sections and requirements first.');
      await tx.stream.delete({ where: { id: streamId } });
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  async deleteSubject(schoolId: string, subjectId: string): Promise<void> {
    const subject = await prisma.subject.findUnique({ where: { id: subjectId }, select: { id: true, name: true, schoolId: true } });
    if (!subject) throw new AppError(404, 'Subject not found');
    if (subject.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this subject');

    await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "subjects" WHERE "id" = ${subjectId} FOR UPDATE`;
      if (locked.length === 0) throw new AppError(404, 'Subject not found');
      const [requirements, links, covers, lessons] = await Promise.all([
        tx.subjectRequirement.count({ where: { subjectId } }),
        tx.teacherSubject.count({ where: { subjectId } }),
        tx.coverRequest.count({ where: { subjectId } }),
        lessonBlocker(tx, { subjectId }),
      ]);
      refuseIfBlocked(`Subject "${subject.name}"`, [count(requirements, 'curriculum requirement'), count(links, 'teacher link'), count(covers, 'substitution cover request'), lessons], 'Remove the curriculum requirements and teacher links, and delete the timetable versions that use it, first.');
      await tx.subject.delete({ where: { id: subjectId } });
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  /** Returns how many teacher-subject links were removed with the teacher (qualifications only: they carry no history). */
  async deleteTeacher(schoolId: string, teacherId: string): Promise<{ removedSubjectLinks: number }> {
    const teacher = await prisma.teacher.findUnique({ where: { id: teacherId }, select: { id: true, name: true, schoolId: true } });
    if (!teacher) throw new AppError(404, 'Teacher not found');
    if (teacher.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this teacher');

    return prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "teachers" WHERE "id" = ${teacherId} FOR UPDATE`;
      if (locked.length === 0) throw new AppError(404, 'Teacher not found');
      const [assignments, covers, absences, unavailability, lessons] = await Promise.all([
        tx.sectionSubjectTeacher.count({ where: { teacherId } }),
        tx.coverRequest.count({ where: { OR: [{ absentTeacherId: teacherId }, { replacementTeacherId: teacherId }] } }),
        tx.teacherAbsence.count({ where: { teacherId } }),
        tx.teacherUnavailability.count({ where: { teacherId } }),
        lessonBlocker(tx, { teacherId }),
      ]);
      refuseIfBlocked(`Teacher "${teacher.name}"`, [count(assignments, 'section assignment'), count(covers, 'substitution cover request'), count(absences, 'recorded absence'), count(unavailability, 'recorded unavailability entry', 'recorded unavailability entries'), lessons], 'To stop giving this teacher new work while keeping their history, deactivate them instead (PATCH isActive=false).');
      const links = await tx.teacherSubject.deleteMany({ where: { teacherId } }); // qualifications of a teacher who is going away; their grade eligibility rows go with them
      await tx.teacher.delete({ where: { id: teacherId } });
      return { removedSubjectLinks: links.count };
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  async deleteAcademicYear(schoolId: string, yearId: string): Promise<void> {
    const year = await ownedYear(schoolId, yearId);
    if (year.status !== 'DRAFT') throw new AppError(400, `Only a DRAFT academic year can be deleted; "${year.name}" is ${year.status}. Active and completed years keep their history.`);

    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status"::text AS status FROM "academic_years" WHERE "id" = ${yearId} FOR UPDATE`;
      if (rows.length === 0) throw new AppError(404, 'Academic year not found');
      if (rows[0]!.status !== 'DRAFT') throw new AppError(400, `Only a DRAFT academic year can be deleted; "${year.name}" is ${rows[0]!.status}.`);
      const [grades, versions, runs] = await Promise.all([tx.grade.count({ where: { academicYearId: yearId } }), tx.timetableVersion.count({ where: { academicYearId: yearId } }), tx.timetableGenerationRun.count({ where: { academicYearId: yearId } })]);
      refuseIfBlocked(`Academic year "${year.name}"`, [count(grades, 'grade'), count(versions, 'timetable version'), count(runs, 'timetable generation run')], 'Delete the grades and timetable versions first (a year that was ever generated keeps its generation history).');
      await tx.scheduleConfig.deleteMany({ where: { academicYearId: yearId } }); // configuration only: periods, days and breaks
      await tx.academicYear.delete({ where: { id: yearId } });
    });
  }

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  /** "Reset": remove the schedule so it can be set up again. Refused once a timetable has been generated from it. */
  async deleteScheduleConfig(schoolId: string, configId: string): Promise<void> {
    const config = await prisma.scheduleConfig.findUnique({ where: { id: configId }, select: { id: true, academicYearId: true, academicYear: { select: { schoolId: true, status: true } } } });
    if (!config) throw new AppError(404, 'Schedule configuration not found');
    if (config.academicYear.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this schedule configuration');
    if (config.academicYear.status !== 'DRAFT') throw new AppError(400, DRAFT_ONLY('Schedule configuration'));

    await prisma.$transaction(async (tx) => {
      // FOR UPDATE: the same first lock as generation enqueueing and publishing, so a run cannot start between the check and the delete
      const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT "status"::text AS status FROM "academic_years" WHERE "id" = ${config.academicYearId} FOR UPDATE`;
      if (rows.length === 0 || rows[0]!.status !== 'DRAFT') throw new AppError(400, DRAFT_ONLY('Schedule configuration'));
      const [versions, activeRuns] = await Promise.all([
        tx.timetableVersion.count({ where: { academicYearId: config.academicYearId } }),
        tx.timetableGenerationRun.count({ where: { academicYearId: config.academicYearId, status: { in: ['QUEUED', 'RUNNING'] } } }),
      ]);
      refuseIfBlocked('The schedule configuration', [count(versions, 'timetable version built on it'), count(activeRuns, 'timetable generation in progress', 'timetable generations in progress')], 'Delete those timetable versions (or wait for the generation to finish) first. You can also edit the schedule in place instead of resetting it.');
      const deleted = await tx.scheduleConfig.deleteMany({ where: { id: configId } });
      if (deleted.count === 0) throw new AppError(404, 'Schedule configuration not found');
    });
  }
}

export const recordDeletionService = new RecordDeletionService();
