-- A timetable version that substitution cover requests were made from can no longer take them (and, through them, the cover events) with it when it is deleted
-- (ON DELETE CASCADE -> ON DELETE NO ACTION, deferred to COMMIT as in 20261025090000). The application refuses such a delete with a 409 that lists the cover requests;
-- this is the database backstop. Deleting a whole school or academic year still cascades (the check runs after every cascade of the statement). No data is changed.
-- Rollback: recreate the constraint with ON DELETE CASCADE.

-- DropForeignKey
ALTER TABLE "cover_requests" DROP CONSTRAINT "cover_requests_timetableVersionId_fkey";

-- AddForeignKey
ALTER TABLE "cover_requests" ADD CONSTRAINT "cover_requests_timetableVersionId_fkey" FOREIGN KEY ("timetableVersionId") REFERENCES "timetable_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

