-- CreateEnum
CREATE TYPE "TeacherSubjectType" AS ENUM ('PRIMARY', 'SECONDARY');

-- CreateTable
CREATE TABLE "teacher_subjects" (
    "id" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "type" "TeacherSubjectType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teacher_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teacher_subject_grades" (
    "id" TEXT NOT NULL,
    "teacherSubjectId" TEXT NOT NULL,
    "gradeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "teacher_subject_grades_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject_requirements" (
    "id" TEXT NOT NULL,
    "gradeId" TEXT NOT NULL,
    "streamId" TEXT,
    "subjectId" TEXT NOT NULL,
    "periodsPerWeek" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subject_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "section_subject_teachers" (
    "id" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "subjectRequirementId" TEXT NOT NULL,
    "teacherId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "section_subject_teachers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "teacher_subjects_teacherId_subjectId_key" ON "teacher_subjects"("teacherId", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "teacher_subject_grades_teacherSubjectId_gradeId_key" ON "teacher_subject_grades"("teacherSubjectId", "gradeId");

-- CreateIndex
CREATE INDEX "subject_requirements_gradeId_idx" ON "subject_requirements"("gradeId");

-- CreateIndex
CREATE INDEX "subject_requirements_streamId_idx" ON "subject_requirements"("streamId");

-- CreateIndex
CREATE UNIQUE INDEX "subject_requirements_gradeId_streamId_subjectId_key" ON "subject_requirements"("gradeId", "streamId", "subjectId");

-- CreateIndex
CREATE INDEX "section_subject_teachers_teacherId_idx" ON "section_subject_teachers"("teacherId");

-- CreateIndex
CREATE UNIQUE INDEX "section_subject_teachers_sectionId_subjectRequirementId_key" ON "section_subject_teachers"("sectionId", "subjectRequirementId");

-- AddForeignKey
ALTER TABLE "teacher_subjects" ADD CONSTRAINT "teacher_subjects_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "teachers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_subjects" ADD CONSTRAINT "teacher_subjects_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_subject_grades" ADD CONSTRAINT "teacher_subject_grades_teacherSubjectId_fkey" FOREIGN KEY ("teacherSubjectId") REFERENCES "teacher_subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teacher_subject_grades" ADD CONSTRAINT "teacher_subject_grades_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "grades"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_requirements" ADD CONSTRAINT "subject_requirements_gradeId_fkey" FOREIGN KEY ("gradeId") REFERENCES "grades"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_requirements" ADD CONSTRAINT "subject_requirements_streamId_fkey" FOREIGN KEY ("streamId") REFERENCES "streams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subject_requirements" ADD CONSTRAINT "subject_requirements_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_subject_teachers" ADD CONSTRAINT "section_subject_teachers_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_subject_teachers" ADD CONSTRAINT "section_subject_teachers_subjectRequirementId_fkey" FOREIGN KEY ("subjectRequirementId") REFERENCES "subject_requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "section_subject_teachers" ADD CONSTRAINT "section_subject_teachers_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "teachers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
