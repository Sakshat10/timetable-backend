# Module 7 — Subject Requirements

A subject requirement says **how many periods per week a subject needs** for a grade (non-streamed
grade) or for a stream of a grade (streamed grade). The timetable generator will later use these
numbers to know how many slots to fill. Sections inherit the requirements of their grade/stream; no
per-section rows exist.

## Hierarchy

```
School → Academic Year → Grade → [Stream →] Subject requirement (periodsPerWeek)
                                   Subject (school-level master) ─┘
```

## Endpoints

All endpoints require authentication (session cookie). The school always comes from the session —
there is no `schoolId` in any URL or body.

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/subject-requirements | Create a requirement |
| GET | /api/subject-requirements | List (optional filters `academicYearId`, `gradeId`, `streamId`) |
| GET | /api/subject-requirements/:id | Get one |
| PATCH | /api/subject-requirements/:id | Change `periodsPerWeek`, `isOptional`, `sectionScope` / `sectionIds` (at least one) |
| DELETE | /api/subject-requirements/:id | Delete the requirement row only |

Response shape: `{ id, gradeId, streamId | null, subjectId, periodsPerWeek, isOptional, sectionScope, sectionIds[], createdAt, updatedAt,
subject: {id,name,code}, stream: {id,name,code} | null, grade: {id,name,displayOrder,academicYearId} }`.

List order: academic year (newest first), grade display order, stream name, subject name. Not paginated.

## Business rules

### `periodsPerWeek`
A real JSON **integer from 1 to 40**. `"5"`, `" 5 "`, `true`, arrays, decimals, 0, negatives and
values above 40 are rejected with 400 (field-level error under `errors.periodsPerWeek`). The database
additionally has `CHECK ("periodsPerWeek" > 0)`. No timetable-capacity or teacher-workload validation
happens here.

These routes deliberately bypass Fastify's Ajv validation (which coerces `"5"` → 5 and `true` → 1) and
validate with Zod instead. Module-7 routes only; other modules are unaffected.

### Academic-year status
Create, update and delete only while the grade's academic year is **DRAFT** (otherwise 400). GET and
list work in every status.

### Streamed vs non-streamed grade
1. If the grade has sections, the existing Module 5 section-derived mode decides (a mixed grade is
   treated as streamed, the Module 5 convention).
2. If it has no sections: streamed if it has at least one stream, otherwise non-streamed.

Streamed grade → `streamId` is **required**. Non-streamed grade → `streamId` must be **omitted** (400).
A stream must belong to the supplied grade (400 otherwise); an unknown stream is 404.

### Uniqueness
- Non-streamed: `(gradeId, subjectId)` — partial unique index `WHERE streamId IS NULL`.
- Streamed: `(gradeId, streamId, subjectId)` — the original unique index.

Duplicates return 409 (application pre-check, with the database indexes as the final backstop). Creation
runs in a transaction holding a row lock on the grade (the Module 5 pattern), so the mode check,
duplicate check and insert are serialized against concurrent requirement and section creation.

### Delete guard
If `SectionSubjectTeacher` rows reference the requirement, DELETE returns **409** and nothing is
removed (the FK would otherwise cascade-delete the assignments). No assignment functionality exists
in this module.

## Known limitation
Section creation (Module 5) does not look at requirements. The streamed/non-streamed check happens
when a requirement is created; if a grade's sections are later created in the opposite mode, the
existing requirements are not revalidated. The scheduler's feasibility check must catch this.

## Error summary

| Status | When |
|--------|------|
| 400 | Validation error; academic year not DRAFT; stream from another grade; streamId missing/unexpected for the grade's mode |
| 401 | Not authenticated |
| 403 | Grade, stream, subject or requirement belongs to another school |
| 404 | Unknown grade, stream, subject or requirement |
| 409 | Duplicate requirement; delete blocked by teacher assignments |

## Optional label and section scope (added with the curriculum module)

- `isOptional` (default `false`) is a **label only**: an optional subject is scheduled exactly like a compulsory one. Parallel elective groups (students choosing one of several) are not modelled.
- `sectionScope` is `ALL_SECTIONS` (default; the original meaning: every section of the grade/stream has the subject) or `SELECTED_SECTIONS` with `sectionIds` (only those sections).
  A selected section must belong to the requirement's grade and stream (400 with `errors.sectionIds`; enforced again by a database trigger).
- Rows written before this existed read as compulsory / all sections, so nothing changes for them.
- Restricting a requirement to sections that leave an existing teacher assignment outside its scope is refused (409), and a teacher cannot be assigned to a section outside the scope (400).
- For setting a whole grade at once, with review, see `src/modules/curriculum/README.md`.
