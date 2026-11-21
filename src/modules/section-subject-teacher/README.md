# Module 8 — Section ↔ Subject ↔ Teacher Assignment

A **section subject teacher** assignment records *which teacher teaches which subject to which
section*, for example "Grade 6 / Section A / Mathematics → Rahul".

It is configuration only. It contains **no day, period, workload, availability or `periodsPerWeek`**:
the subject, grade, stream and number of periods are reached through the subject requirement and the
section, and nothing is copied into the assignment. The timetable generator will consume it later.

## Model

`SectionSubjectTeacher { id, sectionId, subjectRequirementId, teacherId }` with a unique index on
`(sectionId, subjectRequirementId)`:

- **One teacher per section + subject requirement** (the database enforces it).
- `teacherId` is *not* part of the unique key, so **one teacher can teach many sections** (6A, 6B, 7A …).
  There is no workload limit and no collision check here; clashes are a timetable concern.
- A requirement may exist with no assignment. Completeness is not enforced; a later feasibility check
  will report requirements that have no teacher.

## Endpoints

All require authentication. The school always comes from the session; there is no `schoolId` in any
URL or body.

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/section-subject-teachers | Body `{ sectionId, subjectRequirementId, teacherId }` |
| GET | /api/section-subject-teachers | List. Optional filters: `academicYearId`, `gradeId`, `sectionId`, `subjectId`, `teacherId` |
| GET | /api/section-subject-teachers/:id | Get one |
| PATCH | /api/section-subject-teachers/:id | Body `{ teacherId }` only |
| DELETE | /api/section-subject-teachers/:id | Remove the assignment row only |

The list answers "everything for a section / teacher / subject / grade / year" with filters
(combinable); each supplied filter must belong to the school. Order: academic year (newest first),
grade, section, subject. Not paginated.

Response: `{ id, sectionId, subjectRequirementId, teacherId, createdAt, updatedAt,
section:{id,name,code}, grade:{id,name,displayOrder,academicYearId}, stream:{id,name,code}|null,
subject:{id,name,code}, subjectRequirement:{id,periodsPerWeek},
teacher:{id,name,employeeCode,isActive} }`.

## Rules

### Section and requirement must match
Same grade, and **exactly the same stream** (`section.streamId === requirement.streamId`, null equals
null). A Science requirement cannot go to a Commerce section; a stream requirement cannot go to a
non-stream section and vice versa.

### Assignments are optional overrides
A section subject WITHOUT an assignment is allowed: timetable generation picks an eligible teacher automatically (see the feasibility
README). An assignment is a hard constraint that generation respects, and it must stay valid (active teacher, subject link, grade
eligibility); otherwise readiness reports a blocker instead of replacing it. Automatic choices are never stored here.

### Teacher eligibility (no fallback)
The teacher must belong to the school, be **active**, have a `TeacherSubject` for the requirement's
subject (**subject qualification**, always required) **and** be allowed to teach the section's grade
(**grade eligibility**): either the link's `gradeScope` is `ALL_GRADES` (an explicit admin choice), or the link is
`SELECTED_GRADES` (the default) and a `TeacherSubjectGrade` row exists for the grade. A missing eligibility row is
never read as permission for other grades. Failures are **400** with a message (inactive, not linked to the
subject, not eligible for the grade).

### Academic-year status
Create, PATCH and DELETE only while the section's academic year is **DRAFT** (otherwise 400). GET and the
list work in every status.

### PATCH
Only `teacherId` can change; `sectionId` / `subjectRequirementId` are rejected with 400 (delete and
re-create instead). **Every PATCH re-validates the resulting state**, even with the same `teacherId`.

### Inactive teachers
An inactive teacher cannot be assigned. If a teacher is deactivated *after* being assigned, the assignment
is **kept** (never auto-deleted or re-assigned) and GET/list show it with `teacher.isActive = false`.
Replacing the teacher with an active, eligible one (PATCH) works, DELETE works in DRAFT, but PATCH with the
same inactive teacher returns 400.

### Isolation and concurrency
Ownership is checked on the section, the requirement (and its subject) and the teacher. Any foreign link,
including a corrupt mixed-school row, is 403 and the list never returns it. Creation runs in a transaction
holding `FOR SHARE` locks on the teacher row, the teacher-subject row and the eligibility row (always in that order), so it
serializes against teacher deactivation and eligibility deletion; the unique index is the final duplicate
backstop (concurrent duplicates give one 201 and one 409).

## Dependency guards
- Module 7: a subject requirement with assignments cannot be deleted (409).
- Module 6: `DELETE /api/teacher-subjects/:id/grades/:gradeId` returns 409 while an assignment for that
  teacher, subject and grade exists.

## Errors

| Status | When |
|--------|------|
| 400 | Validation; academic year not DRAFT; grade/stream mismatch; teacher inactive / not linked to the subject / not eligible for the grade; immutable field on PATCH |
| 401 | Not authenticated |
| 403 | Section, requirement, teacher or assignment belongs to another school |
| 404 | Unknown section, requirement, teacher or assignment |
| 409 | The section already has a teacher for that requirement |
