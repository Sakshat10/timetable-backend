# Module 10 — Timetable Feasibility (pre-generation validation)

A **read-only, stateless readiness report** for one academic year. It answers: *"Is this year's
configuration ready to attempt timetable generation, and if not, exactly why?"* It does **not** generate a
timetable, does not call the solver, and **persists nothing**: the report is computed from the current
configuration on every request.

## Endpoint

`GET /api/timetable-feasibility?academicYearId=<uuid>` — authenticated. The school always comes from the
session (`request.admin.schoolId`); there is no `schoolId` parameter. Allowed for **DRAFT, ACTIVE and
COMPLETED** academic years (reads are unrestricted everywhere in this API). A non-DRAFT year adds an
`ACADEMIC_YEAR_NOT_DRAFT` warning because its configuration can no longer be changed.

| Status | When |
|--------|------|
| 200 | A report (`READY` or `NOT_READY`; an unready school is a valid result) |
| 400 | Missing or malformed `academicYearId` |
| 401 | Not authenticated |
| 403 | The academic year belongs to another school |
| 404 | Unknown academic year |

## What READY means

**`READY` = every deterministic precondition checked here passes, so the configuration is ready to attempt
generation. It does NOT guarantee that a timetable exists** — the solver may still find none.
`NOT_READY` = at least one blocking error. Warnings never block. Every response lists, in `notChecked`,
what this check does *not* prove.

## Demand expansion (the central rule)

A `SubjectRequirement` is defined **once** per grade (and optional stream) but applies **independently to
every matching section**. It applies to a section when `requirement.gradeId == section.gradeId` and
`requirement.streamId == section.streamId` (null equals null) — exactly the rule Module 8 enforces for
assignments.

```
demand(section) = sum of periodsPerWeek over the requirements that apply to it
```

Grade 8, Mathematics 5 periods/week, sections A, B, C → A: 5, B: 5, C: 5 = **15 periods of demand**
(not 5). If A and B have a teacher and C does not: `total 15, assigned 10, unassigned 5`. A streamed
requirement applies only to sections in its stream. Demand is therefore derived at section level:
`summary.totalDemandPeriods = assignedPeriods + unassignedPeriods`.

## Capacity

- **Weekly slots** `W = working days × periodsPerDay` (Module 9). Timing events never consume slots.
- **Teacher capacity** `min(32, W)`: a teacher cannot exceed the 32-period workload limit nor the number of
  slots in the week. Assigned load is per academic year.

## Errors (block READY)

| Code | Meaning |
|------|---------|
| `SCHEDULE_CONFIG_MISSING`, `NO_WORKING_DAYS`, `NO_PERIODS`, `SCHEDULE_CONFIG_INVALID` | No usable time grid |
| `NO_SECTIONS`, `NO_SUBJECT_REQUIREMENTS` | Nothing to schedule |
| `SECTION_CAPACITY_EXCEEDED` | A section's weekly demand exceeds the weekly slots |
| `REQUIREMENT_EXCEEDS_TEACHER_CAPACITY` | One requirement needs more periods than a teacher can teach (Module 7 allows up to 40) |
| `MISSING_TEACHER_ASSIGNMENT` | **No longer emitted.** Explicit teacher assignments are optional; see `TEACHER_AUTO_ASSIGNED` (warning) |
| `TEACHER_ALLOCATION_FAILED` | Eligible teachers exist, but the automatic allocation cannot fit every unassigned section into their weekly capacity (whole sections cannot be split; the allocation is a heuristic) |
| `INVALID_ASSIGNMENT` | Grade/stream mismatch, requirement outside the year, or cross-school teacher/subject |
| `INACTIVE_ASSIGNED_TEACHER` | An assigned teacher is inactive (grouped per teacher) |
| `ASSIGNED_TEACHER_NOT_ELIGIBLE` | An assigned teacher lacks the subject link or grade eligibility (a link with `gradeScope` `ALL_GRADES` is eligible for every grade) |
| `TEACHER_CAPACITY_EXCEEDED` | Assigned load above `min(32, W)` (`details.limitSource` = `MAX_WORKLOAD` or `WEEKLY_SLOTS`) |
| `NO_ELIGIBLE_TEACHER` | Unassigned demand for a (grade, subject) with no active eligible teacher |
| `ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT` | Unassigned demand exceeds the eligible teachers' remaining capacity (`kind` = `GROUP` or `POOLED`) |

## Warnings (never block)

`SECTION_HAS_NO_REQUIREMENTS` and `REQUIREMENT_HAS_NO_SECTIONS` (with a `reason`; sections cannot be
removed or deactivated, so strays must not block generation), `MIXED_GRADE_MODE`, `SECTION_AT_FULL_CAPACITY`,
`TEACHER_AT_FULL_CAPACITY`, `ACADEMIC_YEAR_NOT_DRAFT`.

## Pooled capacity check (max-flow)

For unassigned demand, each (grade, subject) group may use its **eligible active teachers'** remaining
capacity (`min(32, W)` minus their assigned load). A small dependency-free Edmonds–Karp max-flow
(`timetable-feasibility.maxflow.ts`) checks that all groups together can be served, and a minimum cut names
the competing groups and teachers. **This is a relaxation: it treats demand as divisible, so a failure
PROVES the configuration impossible, but a pass does NOT prove it is possible.** Whole per-section blocks
(one teacher per section + subject) and exact placement are solver-level concerns.

## Response

`{ academicYear, status, statusMeaning, generatedAt, limits, summary, errors, warnings, breakdown, notChecked }`.
Each issue: `{ code, severity, message, hint, entity, details }`. `breakdown` is always included:
`sections` (demand/assigned/unassigned per section), `teachers` (load and remaining capacity) and
`subjectGroups` (per grade + subject, with eligible teachers and their remaining capacity). Results are
sorted, so the same database state always yields the same report (only `generatedAt` differs).

## Architecture

`route → controller → service → loader (Prisma) → pure analyzer → report`.

- `timetable-feasibility.loader.ts` — the only database code: ~10 batched reads (no per-section or per-teacher
  queries) inside one **REPEATABLE READ** transaction, so a report is a consistent snapshot even while
  the configuration is edited. It takes no locks and never blocks writers.
- `timetable-feasibility.analyzer.ts` — pure and deterministic; reusable by the future generation module.
- `timetable-feasibility.maxflow.ts` — the max-flow helper.

No tables, no migration. The report is advisory: it is a snapshot, so generation must re-validate.

## Not checked (left to the solver)

Exact slot placement, teacher/section collisions at specific slots, whole-block packing of unassigned
demand, subject distribution, consecutive periods, workload balance, locked periods, adjustments, half-days
and exams.

## Optional explicit teachers (automatic allocation)

A section subject without an explicit section-subject-teacher assignment is **not** a blocker. Generation chooses its teacher
(`teacher-allocator.ts`, shared by this report and by the generation normalizer, so they cannot disagree). Candidates are active
teachers of the school with a subject link that covers the grade: `gradeScope` `ALL_GRADES`, or an explicit eligibility row. A
`SELECTED_GRADES` link without a row for the grade is never a candidate. Explicit assignments are hard, validated, and their load is
subtracted from capacity first; an invalid explicit assignment stays a blocker (`ASSIGNED_TEACHER_NOT_ELIGIBLE`, `INACTIVE_ASSIGNED_TEACHER`)
and is never silently replaced. Blockers that remain: `NO_ELIGIBLE_TEACHER`, `ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT`,
`TEACHER_ALLOCATION_FAILED`. The warning `TEACHER_AUTO_ASSIGNED` lists the sections whose teacher will be chosen automatically.
