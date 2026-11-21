-- Curriculum scope: optional/compulsory flag and per-section applicability for subject requirements.
-- Additive and backward compatible: two new columns with defaults that reproduce the behaviour every existing requirement already had
-- (isOptional = false, sectionScope = 'ALL_SECTIONS' = "every section of the grade/stream"), and one new table that is empty until an admin selects sections.
-- No existing row is changed, no published timetable entry is touched.
-- Rollback (code first): DROP TABLE "subject_requirement_sections"; ALTER TABLE "subject_requirements" DROP COLUMN "isOptional", DROP COLUMN "sectionScope"; DROP TYPE "RequirementScope";
--   (list the SELECTED_SECTIONS requirements first: dropping the column makes them apply to every section again.)

-- CreateEnum
CREATE TYPE "RequirementScope" AS ENUM ('ALL_SECTIONS', 'SELECTED_SECTIONS');

-- AlterTable
ALTER TABLE "subject_requirements" ADD COLUMN     "isOptional" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sectionScope" "RequirementScope" NOT NULL DEFAULT 'ALL_SECTIONS';

-- CreateTable
CREATE TABLE "subject_requirement_sections" (
    "id" TEXT NOT NULL,
    "subjectRequirementId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subject_requirement_sections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subject_requirement_sections_sectionId_idx" ON "subject_requirement_sections"("sectionId");

-- CreateIndex
CREATE UNIQUE INDEX "subject_requirement_sections_subjectRequirementId_sectionId_key" ON "subject_requirement_sections"("subjectRequirementId", "sectionId");

-- AddForeignKey
ALTER TABLE "subject_requirement_sections" ADD CONSTRAINT "subject_requirement_sections_subjectRequirementId_fkey" FOREIGN KEY ("subjectRequirementId") REFERENCES "subject_requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_requirement_sections" ADD CONSTRAINT "subject_requirement_sections_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- A selected section must belong to the requirement's grade and have exactly its stream (the same rule as for assignments), and rows may only exist
-- for a SELECTED_SECTIONS requirement. The service enforces both under a lock; this is the database's own guarantee.
CREATE OR REPLACE FUNCTION "subject_requirement_sections_check"() RETURNS trigger AS $$
DECLARE
  req_grade TEXT; req_stream TEXT; req_scope TEXT; sec_grade TEXT; sec_stream TEXT;
BEGIN
  SELECT "gradeId", "streamId", "sectionScope"::text INTO req_grade, req_stream, req_scope FROM "subject_requirements" WHERE "id" = NEW."subjectRequirementId";
  SELECT "gradeId", "streamId" INTO sec_grade, sec_stream FROM "sections" WHERE "id" = NEW."sectionId";
  IF req_scope IS DISTINCT FROM 'SELECTED_SECTIONS' THEN
    RAISE EXCEPTION 'subject_requirement_sections: the requirement is not SELECTED_SECTIONS' USING ERRCODE = '23514';
  END IF;
  IF req_grade IS DISTINCT FROM sec_grade OR req_stream IS DISTINCT FROM sec_stream THEN
    RAISE EXCEPTION 'subject_requirement_sections: the section is not in the requirement''s grade and stream' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "subject_requirement_sections_check_trg"
  BEFORE INSERT OR UPDATE ON "subject_requirement_sections"
  FOR EACH ROW EXECUTE FUNCTION "subject_requirement_sections_check"();
