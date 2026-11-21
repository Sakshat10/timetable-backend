import { Prisma, type PrismaClient } from '@prisma/client';
import prisma from '../../config/database.js';
import { AppError } from '../../utils/errors.js';
import { gridSchema } from '../timetable-generation/timetable-generation.contracts.js';
import { parseStoredPeriodTimes, type PeriodTime } from '../timetable-generation/timetable-generation.period-times.js';
import { VersionRuleError } from './timetable-version.errors.js';
import { buildView, resolvePeriodTimes, type NameMaps, type ViewBody, type ViewEntryRow, type ViewKind } from './timetable-version.view-core.js';
import { type TimetableViewQuery } from './timetable-version.schema.js';

export interface TimetableView extends ViewBody {
  version: { id: string; academicYearId: string; versionNumber: number; status: string; revision: number };
  subject:
    | { type: 'SECTION'; id: string; name: string; code: string; grade: { id: string; name: string } }
    | { type: 'TEACHER'; id: string; name: string; isActive: boolean };
}

interface VersionRow {
  id: string;
  schoolId: string;
  academicYearId: string;
  versionNumber: number;
  status: string;
  revision: number;
  createdAt: Date;
  periodTimes: unknown;
  periodTimesCapturedAt: Date | null;
  grid: unknown;
}

/**
 * Phase 7F-1: GET /timetable-versions/:id/timetable. Read-only. ONE REPEATABLE READ transaction reads the version, the lessons, every
 * name and the live schedule, so the response describes a single consistent moment (no half-applied edit, no rename between two reads).
 * No row lock is taken: viewing never blocks, and is never blocked by, an edit, a publish or a generation.
 *
 * Isolation: the version, the section or the teacher of ANOTHER school is a 403 (as everywhere in this module); a section of another
 * academic year of this school is a 404; every name lookup is scoped to this school (and, for sections, this academic year), so a row
 * that somehow referenced a foreign entity shows null names, never the foreign school's.
 */
export class TimetableVersionViewService {
  constructor(private readonly db: PrismaClient = prisma) {}

  async view(schoolId: string, versionId: string, query: TimetableViewQuery): Promise<TimetableView> {
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<VersionRow[]>`
          SELECT "id", "schoolId", "academicYearId", "versionNumber", "status"::text AS "status", "revision", "createdAt", "periodTimes", "periodTimesCapturedAt",
                 "inputSnapshot"->'grid' AS "grid"
          FROM "timetable_versions" WHERE "id" = ${versionId}`;
        const version = rows[0];
        if (!version) throw new AppError(404, 'Timetable version not found');
        if (version.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this timetable version');

        const grid = gridSchema.safeParse(version.grid);
        if (!grid.success) throw new AppError(500, 'The stored timetable could not be read');
        const storedRaw: PeriodTime[] | null = version.periodTimes === null ? null : parseStoredPeriodTimes(version.periodTimes);
        if (version.periodTimes !== null && storedRaw === null) throw new AppError(500, 'The stored period times of this timetable could not be read');
        const noTimes = storedRaw !== null && storedRaw.length === 0; // made under the simplified schedule: no clock times, by design
        const stored: PeriodTime[] | null = noTimes ? null : storedRaw;

        const kind: ViewKind = query.view;
        let subject: TimetableView['subject'];
        let entryWhere: Prisma.TimetableEntryWhereInput;
        if (kind === 'section') {
          const section = await tx.section.findUnique({ where: { id: query.id }, select: { id: true, name: true, code: true, grade: { select: { id: true, name: true, academicYearId: true, academicYear: { select: { schoolId: true } } } } } });
          if (!section) throw new VersionRuleError(404, 'SECTION_NOT_FOUND', 'Section not found');
          if (section.grade.academicYear.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this section');
          if (section.grade.academicYearId !== version.academicYearId) throw new VersionRuleError(404, 'SECTION_NOT_FOUND', 'The section does not belong to this timetable\'s academic year');
          subject = { type: 'SECTION', id: section.id, name: section.name, code: section.code, grade: { id: section.grade.id, name: section.grade.name } };
          entryWhere = { versionId, sectionId: section.id };
        } else {
          const teacher = await tx.teacher.findUnique({ where: { id: query.id }, select: { id: true, name: true, isActive: true, schoolId: true } });
          if (!teacher) throw new VersionRuleError(404, 'TEACHER_NOT_FOUND', 'Teacher not found');
          if (teacher.schoolId !== schoolId) throw new AppError(403, 'You do not have access to this teacher');
          subject = { type: 'TEACHER', id: teacher.id, name: teacher.name, isActive: teacher.isActive };
          entryWhere = { versionId, teacherId: teacher.id };
        }

        const entryRows = await tx.timetableEntry.findMany({
          where: entryWhere,
          select: { id: true, sectionId: true, subjectId: true, teacherId: true, subjectRequirementId: true, dayOfWeek: true, periodNumber: true, source: true, isLocked: true },
        });
        const entries: ViewEntryRow[] = entryRows.map((e) => ({ ...e, source: String(e.source) }));

        // names: scoped to this school (and this academic year for sections)
        const ids = (pick: (e: ViewEntryRow) => string): string[] => [...new Set(entries.map(pick))];
        const [sections, subjects, teachers] = await Promise.all([
          tx.section.findMany({ where: { id: { in: ids((e) => e.sectionId) }, grade: { academicYearId: version.academicYearId, academicYear: { schoolId } } }, select: { id: true, name: true, code: true, grade: { select: { name: true } } } }),
          tx.subject.findMany({ where: { id: { in: ids((e) => e.subjectId) }, schoolId }, select: { id: true, name: true, code: true } }),
          tx.teacher.findMany({ where: { id: { in: ids((e) => e.teacherId) }, schoolId }, select: { id: true, name: true, isActive: true } }),
        ]);
        const names: NameMaps = {
          sections: new Map(sections.map((s) => [s.id, { name: s.name, code: s.code, gradeName: s.grade.name }])),
          subjects: new Map(subjects.map((s) => [s.id, { name: s.name, code: s.code }])),
          teachers: new Map(teachers.map((t) => [t.id, { name: t.name, isActive: t.isActive }])),
        };

        // the live schedule: only when something needs it (a stored snapshot to compare with, or an explicit request)
        const needLive = !noTimes && (stored !== null || query.periodTimes === 'current');
        let live: PeriodTime[] | null = null;
        let liveRowsCreatedAfterVersion: boolean | null = null;
        if (needLive) {
          const liveRows = await tx.schedulePeriod.findMany({ where: { scheduleConfig: { academicYearId: version.academicYearId } }, select: { periodNumber: true, startMinute: true, endMinute: true, createdAt: true }, orderBy: { periodNumber: 'asc' } });
          live = liveRows.length === 0 ? null : liveRows.map((r) => ({ periodNumber: r.periodNumber, startMinute: r.startMinute, endMinute: r.endMinute }));
          liveRowsCreatedAfterVersion = liveRows.length === 0 ? null : liveRows.some((r) => r.createdAt.getTime() > version.createdAt.getTime());
        }

        const times = resolvePeriodTimes({
          stored,
          storedCapturedAt: version.periodTimesCapturedAt,
          live,
          liveRead: needLive,
          requested: query.periodTimes,
          liveRowsCreatedAfterVersion,
          gridPeriods: grid.data.periods.map((p) => p.periodNumber),
          noTimes,
        });
        const body = buildView({ kind, grid: grid.data, entries, names, times });
        return { version: { id: version.id, academicYearId: version.academicYearId, versionNumber: version.versionNumber, status: version.status, revision: version.revision }, subject, ...body };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 30_000 }
    );
  }
}

export const timetableVersionViewService = new TimetableVersionViewService();
