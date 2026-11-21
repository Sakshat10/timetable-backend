-- Protect history from cascade deletion: timetable lessons, substitution cover requests, teacher absences and unavailability no longer disappear when the
-- section, subject or teacher they refer to is deleted (ON DELETE CASCADE -> ON DELETE NO ACTION). The application checks these dependencies first and answers 409;
-- this is the database-level backstop for any path that does not (a future code path, a manual delete).
-- NO ACTION with DEFERRABLE INITIALLY DEFERRED is deliberate: the check runs at COMMIT, after every cascade of the same statement has finished, so deleting a whole school
-- (or a timetable version) still removes its lessons and covers exactly as before, while deleting a section/subject/teacher that still has history fails the transaction.
-- (Plain NO ACTION/RESTRICT are checked too early and would break the school-wide cascade.) Deleting the VERSION a lesson belongs to still cascades (that FK is unchanged).
-- No data is changed; existing rows already satisfy the constraints. Each constraint is dropped and re-added in this one transaction (a brief lock, and a validation scan).
-- Rollback: re-create the same constraints with ON DELETE CASCADE (the "-- DropForeignKey" / "-- AddForeignKey" pairs below, with CASCADE).

-- DropForeignKey
ALTER TABLE "cover_requests" DROP CONSTRAINT "cover_requests_absentTeacherId_fkey";

-- DropForeignKey
ALTER TABLE "cover_requests" DROP CONSTRAINT "cover_requests_replacementTeacherId_fkey";

-- DropForeignKey
ALTER TABLE "cover_requests" DROP CONSTRAINT "cover_requests_sectionId_fkey";

-- DropForeignKey
ALTER TABLE "cover_requests" DROP CONSTRAINT "cover_requests_subjectId_fkey";

-- DropForeignKey
ALTER TABLE "teacher_absences" DROP CONSTRAINT "teacher_absences_teacherId_fkey";

-- DropForeignKey
ALTER TABLE "teacher_unavailabilities" DROP CONSTRAINT "teacher_unavailabilities_teacherId_fkey";

-- DropForeignKey
ALTER TABLE "timetable_entries" DROP CONSTRAINT "timetable_entries_sectionId_fkey";

-- DropForeignKey
ALTER TABLE "timetable_entries" DROP CONSTRAINT "timetable_entries_subjectId_fkey";

-- DropForeignKey
ALTER TABLE "timetable_entries" DROP CONSTRAINT "timetable_entries_teacherId_fkey";

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "timetable_entries" ADD CONSTRAINT "timetable_entries_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "teachers"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "teacher_absences" ADD CONSTRAINT "teacher_absences_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "teachers"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "teacher_unavailabilities" ADD CONSTRAINT "teacher_unavailabilities_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "teachers"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_absentTeacherId_fkey" FOREIGN KEY ("absentTeacherId") REFERENCES "teachers"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_replacementTeacherId_fkey" FOREIGN KEY ("replacementTeacherId") REFERENCES "teachers"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

