# Curriculum

Which subjects each grade (or stream of a streamed grade) must be taught, with periods per week, compulsory/optional, and which sections have them. It is configuration per school and per academic year;
nothing about any particular school's subjects is built in.

## Model (reuses `SubjectRequirement`)

```
Academic year → Grade → [Stream →] SubjectRequirement(subject, periodsPerWeek, isOptional, sectionScope) → [SubjectRequirementSection → Section]
```

- A **Subject** is one school-level record: "Science" in Classes 6-8 is the same subject row in three requirements (6, 7, 8) with their own periods. Physics/Chemistry/Biology are separate subjects used in 9-10.
- Grades belong to one academic year, so curricula are per year. A grade without streams has requirements with no stream; a streamed grade has requirements per stream (a requirement never applies to another stream).
- `sectionScope = ALL_SECTIONS` (default) applies to every section of the grade/stream; `SELECTED_SECTIONS` lists sections (`subject_requirement_sections`), which must belong to that grade and stream.
- **Curriculum is not teaching ability.** No curriculum operation creates or changes a teacher-subject link, grade eligibility, section assignment or published entry.

## Endpoints (authenticated; school from the session)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/curriculum?academicYearId=` | grades → groups (grade, or grade+stream) → requirements with `classification`, per-section weekly demand, subject usage across the year, and `issues` |
| PUT | `/api/curriculum/grades/:gradeId` | body `{ streamId?, requirements[], dryRun? }`: make the grade/stream's curriculum exactly this list (add, update, remove) in one transaction. `dryRun` returns the plan and writes nothing. DRAFT years only |
| POST | `/api/curriculum/copy` | add a source grade/stream's subjects to a target (never overwrites; section-specific lines are not copied). `dryRun` supported |

Single-requirement endpoints (`/api/subject-requirements`) keep working and accept the new fields.

Refusals: 400 (validation, row-specific `errors["requirements.N.field"]`), 403 (another school's record), 404, 409 (a removal or scope change would strand a teacher assignment: `errors.blockedBy`; or a concurrent create).

### Classification (derived, never stored)
`SECTION_SPECIFIC` (restricted to selected sections) · `STREAM_SPECIFIC` (has a stream and not every stream of the grade requires it) · `COMMON` (required by more than one grade) · otherwise `GRADE_SPECIFIC`.

### Issues
`GROUP_WITHOUT_CURRICULUM`, `CURRICULUM_WITHOUT_SECTIONS`, `SECTION_DEMAND_EXCEEDS_SLOTS`, `MIXED_GRADE_MODE`. Ambiguous or incomplete existing setups are reported, never repaired automatically.

## How generation uses it
Readiness (`timetable-feasibility`), generation (`timetable-generation.normalizer`) and the assignment guard all call `requirementAppliesToSection` (`timetable-feasibility/requirement-applicability.ts`): grade matches, stream matches exactly,
and for `SELECTED_SECTIONS` the section is listed. The solver only receives (section, subject, periods, fixed teacher), so it is unchanged. A curriculum edit changes the normalized input, so existing drafts become stale and cannot be published;
published timetables are never modified.

## Existing data and deployment
- Existing requirements get `isOptional=false`, `sectionScope=ALL_SECTIONS`: identical behaviour. No subject is assigned to any grade automatically and no period count is invented.
- Deploy: `npx prisma migrate deploy` (additive). Rollback: drop the trigger/function, table `subject_requirement_sections`, the two columns and enum `RequirementScope` (the migration header lists the statements).
- Not applied to any shared or production database by this work.

## Not modelled
Parallel elective groups (students choosing one of several subjects at the same time) and per-section period counts. `isOptional` is a label.
