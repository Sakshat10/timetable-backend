## Automatic substitution review (migration 20261102090000_add_consecutive_period_policy)
- School policy for four consecutive periods: `GET/PUT /api/substitution-settings` (`ALLOW`, `PREFER_AVOID` default, `NEVER_ALLOW`); PREFER_AVOID now assigns a last resort automatically (it previously left the lesson OPEN); NEVER_ALLOW refuses automatic and manual assignment (`409 FOUR_CONSECUTIVE_NOT_ALLOWED`).
- Publishing a version now reconciles and allocates its cover requests after the commit (`data.substitution` in the publish response); a request replacing an admin's manual assignment is held for review, never auto-filled.
- Event feed: composite `(time, id)` cursor (`nextCursor`/`cursor`); the time-only `nextSince` could skip events written together.
- Allocator: augmenting-path repair (maximum lessons covered per period); 28-day fairness window is exactly 28 days; admin cancel reasons that collide with the system's are refused; changing an absence's teacher is a clear 400; 409s list the lessons needing attention; assigning the allocator's own teacher pins it as MANUAL.

## Automatic substitution (migration 20261101090000_add_automatic_substitution)
- `POST /api/teacher-absences` and `PATCH /api/teacher-absences/:id` now assign substitutes automatically (coordinated, deterministic, idempotent; see `src/modules/substitution/README.md`). The response keeps every existing field and adds `automaticAllocation`. Opt out per request with `autoAssign: false`.
- New: `POST /api/teacher-absences/:id/auto-assign`, `GET /api/teacher-absences/:id/substitution-summary`, `POST /api/substitutions/auto-assign`, `GET /api/substitution-events`.
- Cover requests gain `assignmentSource`, `temporaryUnqualified`, `attention`; history events gain `details`; new event actions `AUTO_ASSIGNED`, `AUTO_UNFILLED`, `AUTO_RELEASED`.
- Candidate ranking now follows: subject, grade eligibility, weekly workload, covers today, consecutive run, recent covers (fairness), name. This reorders some candidate lists compared with before (existing tests updated).
- An automatic assignment gives way when its substitute becomes absent/unavailable or its absence is cancelled/shrunk; manual assignments keep their old 409 behaviour.

# Changelog

All notable changes to the School Timetable Management System Backend will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Changed - Simplified school schedule: no clock times (migration 20261117090000_add_schedule_break_after_period)
- The schedule is now **working days + teaching periods per day + exactly one break** (`breakAfterPeriod`, `1 … periodsPerDay − 1`). `POST/PATCH /api/schedule-configs` no longer accept `periods` or `timingEvents` (400, clear message); `periodsPerDay` is 2–12. Responses add `breakAfterPeriod`, `weeklyTeachingCapacity`, `legacy`, and keep `periods` / `timingEvents` / `timeline` with `null` / empty times.
- Timetable generation, feasibility, staleness, publish checks and substitution period indexing read period numbers and the break position through one helper (`effectiveSchedule`); the break is not a teaching period. No scheduling code reads a clock time.
- New generation runs store no clock times (`periodTimes = []`); the version view reports `periodTimes.source: "NONE"` (new value) with null times. Versions generated before keep their stored snapshot / no snapshot unchanged and stay readable (published, archived, cloned).
- Migration (additive, local only, NOT applied to Neon): nullable `schedule_configs.breakAfterPeriod` + CHECK; backfilled only for configurations with exactly one timing event after a teaching period. Ambiguous legacy configurations stay `legacy: true` and keep working until saved with the simplified form. Legacy period / timing-event rows and stored snapshots are never deleted or rewritten.
- Breaking for clients: the old create/update body. `test-schedule-config-api.sh` was rewritten for the new model; new `test-schedule-simplified-api.ts`.

### Changed - Deleting a PUBLISHED or ARCHIVED timetable version (explicit, confirmed, history-safe)
- `DELETE /api/timetable-versions/:id`: drafts are deleted as before. A published or archived version is deleted only when the body confirms it (`confirmVersionNumber`, `expectedStatus`, `expectedRevision`), the academic year is DRAFT or ACTIVE, and no substitution cover request was made from it. Without the body: 409 `CONFIRMATION_REQUIRED` (the previous 409 for published/archived, now with instructions).
- Nothing is published in its place: the year simply has no published timetable until one is published. Other versions are untouched; only the `clonedFromId` of drafts cloned from it is cleared (existing SET NULL). Response lists what was removed.
- Cover requests (and their events) are never cascade-deleted: 409 `VERSION_HAS_HISTORY` with counts by status. Migration `20261026090000_protect_cover_requests_from_version_delete` (local only; deferred NO ACTION on `cover_requests.timetableVersionId`) is the database backstop.

### Added - Safe deletion of unused records (grades, sections, streams, subjects, teachers, academic years, schedule configurations)
- `DELETE /api/grades|sections|streams|subjects|teachers|academic-years|schedule-configs/:id`. Each refuses with 409 (`errors.blockedBy`) while anything depends on the record; year-scoped structure needs a DRAFT year; teachers with history are deactivated instead (existing `PATCH isActive`). See `src/modules/record-deletion/README.md`.
- Migration `20261025090000_protect_history_from_cascade` (additive; applied locally only): lessons, cover requests, absences and unavailability are no longer cascade-deleted when their section/subject/teacher is deleted (deferred `NO ACTION`); whole-school and version cascades are unchanged.
- A foreign-key conflict caused by a concurrent delete is now 409, not 500.

### Added - Curriculum (grade / stream / subject relationships)
- Migration `20261024090000_add_curriculum_scope` (additive; applied locally only): `subject_requirements.isOptional`, `subject_requirements.sectionScope`, table `subject_requirement_sections` and a trigger that keeps a selected section inside the requirement's grade and stream. Defaults keep every existing row meaning exactly what it meant.
- New `/api/curriculum` (overview + issues), `PUT /api/curriculum/grades/:gradeId` (replace one grade/stream's curriculum atomically, with `dryRun`), `POST /api/curriculum/copy`. See `src/modules/curriculum/README.md`.
- `subject-requirements` accept and return `isOptional`, `sectionScope`, `sectionIds`. One shared rule (`requirementAppliesToSection`) is used by readiness, generation and the assignment guard.
- No solver, contract, teacher-eligibility, availability or substitution change. Curriculum edits make existing drafts stale through the existing configuration comparison; published timetables are untouched.
- Frontend: new Curriculum page (Setup group), with a review step before saving.

### Changed - Substitutes no longer need a subject link or grade eligibility (school policy)
- A substitution is a temporary, date-specific cover. Every active, free teacher of the school is a candidate; **`NOT_QUALIFIED` and `NOT_ELIGIBLE_FOR_GRADE` are removed** (they were the earlier policy).
- Tiers: SAME_SUBJECT (a teacher-subject link of either type, or lessons of that subject in the published timetable; no four in a row), OTHER_AVAILABLE (any other free teacher; was
  OTHER_ELIGIBLE), LAST_RESORT (four or more consecutive periods; offered only when nothing else is). The candidate field `qualification` is replaced by `subjectBasis`; `selection.counts.OTHER_ELIGIBLE`
  and `selection.otherEligibleAvailable` become `OTHER_AVAILABLE` / `otherAvailable`.
- Assigning a substitute never creates or changes a teacher-subject link, a grade eligibility row or a section assignment. The "nobody can cover" message now lists only availability reasons.

### Fixed - Substitution: the "nobody can cover" explanation
- The candidates `message` and the `excluded[].message` text now read correctly ("8 teachers are not qualified for Hindi (no link to it)", not "8 the teacher is not qualified for this subject"),
  name the subject, and say what to configure when the cause is a missing subject link or missing grade eligibility (there is no override). Selection logic is unchanged and verified:
  SECONDARY teachers are tier 2, and last-resort candidates are never excluded (`test-substitution-fallback-api.ts`).

### Fixed - Substitution: concurrent assignments of one teacher to adjacent periods
- Assignments of the SAME replacement on the SAME date are now decided one at a time (advisory lock after the cover-request row lock). Before, two simultaneous assignments to adjacent periods
  could each see "fewer than four consecutive periods" and both commit, bypassing the last-resort confirmation. Regression test: `test-substitution-priority-api.ts` section 10 (forced interleaving).
### Changed - test only
- `test-timetable-version-clone-concurrency.ts` K8: the persist worker now reacts to freed draft slots instead of polling every ~400 ms (it was starved by the clone workers, so "a persist committed"
  depended on luck). All assertions are unchanged.

### Changed - Substitute candidates are prioritized in three tiers
- `GET /api/substitutions/:id/candidates`: valid replacements are ranked and labelled SAME_SUBJECT (PRIMARY link, no four in a row), OTHER_ELIGIBLE, LAST_RESORT (four or more consecutive
  teaching periods; offered only when nothing else is). Consecutive periods follow the schedule's period order and breaks and count lessons plus covers already assigned that day.
  `candidates` stays a flat list (now ordered, with extra fields) and a new `selection` object is added.
- `PUT /api/substitutions/:id/assignment` accepts `confirmFourConsecutive`; without it a teacher who would end with four or more in a row is `409 FOUR_CONSECUTIVE_CONFIRMATION_REQUIRED`
  (recomputed on the server under the locks). Confirmed last-resort assignments are noted in the history. No schema change.

### Added - Substitution workflow (teacher absence, cover requests, replacements)
- 14 routes under `/api`: `teacher-absences` (create, list, get, patch, cancel), `teacher-unavailability` (create, list, remove), `substitutions` (list, get with history, candidates,
  assign/reassign, unassign, cancel). Lessons come only from the school's PUBLISHED timetable version; eligibility reuses subject links, `gradeScope` and eligibility rows.
- Migration `20261023090000_add_substitutions` (additive: `teacher_absences`, `teacher_unavailabilities`, `cover_requests`, `cover_events`, with CHECKs and partial unique indexes).
- Publishing a newer version makes upcoming requests OBSOLETE (history kept) and creates new ones; publishing itself and the solver contract are unchanged. See `src/modules/substitution/README.md`.

### Changed - Explicit teacher assignments are optional for generation
- A section subject with no section-subject-teacher assignment no longer blocks readiness or generation: a teacher is chosen automatically
  among active, qualified and eligible teachers (`gradeScope` / eligibility rows; no eligibility by omission), within the weekly capacity.
  Explicit assignments remain hard constraints and stay validated; invalid ones remain blockers.
- Feasibility: `MISSING_TEACHER_ASSIGNMENT` is no longer emitted; new warning `TEACHER_AUTO_ASSIGNED`, new error `TEACHER_ALLOCATION_FAILED`.
  Generation issues: `MISSING_ASSIGNMENT` replaced by `NO_ELIGIBLE_TEACHER` and `TEACHER_ALLOCATION_FAILED`. Solver contract unchanged.
- Automatic assignments have synthetic ids (`auto:<sectionId>:<requirementId>`) and are not stored as assignments; locks work on them.
### Added
- `DELETE /api/teacher-subjects/:id`: removes one teacher-subject link; 409 while DRAFT/ACTIVE-year assignments or published lessons depend on it.

### Added - Bulk creation (atomic)
- `POST /api/subjects/bulk` `{ subjects: [{ name, code }] }` (1-100): all-or-nothing, single INSERT; in-request duplicate codes 400, existing codes 409, both keyed by row.
- `POST /api/teachers/bulk` `{ teachers: [{ name, employeeCode?, isActive? }] }` (1-100) with a REQUIRED `Idempotency-Key` header: teachers and the
  idempotency record commit in one transaction. Same key + same body replays the stored result (200, `replayed: true`); same key + different body is 409.
  Migration `20261022090000_add_teacher_bulk_requests` (additive: table `teacher_bulk_requests`).
- `POST /api/grades/bulk` `{ academicYearId, grades: [{ name, displayOrder, streams?: [{ name, code }], sections?: [{ name, code, streamCode? }] }] }`:
  nested grade -> streams -> sections for a DRAFT year of the caller's school, one transaction. Limits: 20 grades, 10 streams/grade, 30 sections/grade, 200 sections/request.
- Existing single-record endpoints are unchanged.

### Added - Teacher grade scope (`teacher_subjects.gradeScope`)
- New enum `GradeScope` (`SELECTED_GRADES` default, `ALL_GRADES`) and column `teacher_subjects.gradeScope`
  (migration `20261021090000_add_teacher_subject_grade_scope`, additive; existing links stay `SELECTED_GRADES`).
- `POST /api/teachers/{teacherId}/subjects` accepts optional `gradeScope`; `PATCH /api/teacher-subjects/{id}` accepts
  `type` and/or `gradeScope`; responses include `gradeScope`. No new routes.
- `ALL_GRADES` links are eligible for every grade in assignment validation, the feasibility report and generation
  (preflight and normalizer). Subject qualification and `SELECTED_GRADES` eligibility are unchanged.
- Narrowing `ALL_GRADES` to `SELECTED_GRADES` returns 409 while DRAFT-year assignments depend on it.

---

## [0.1.0] - 2026-09-28

### Added - MODULE 1: SCHOOL

#### Core Infrastructure
- Initial project setup with TypeScript, Fastify, and Prisma 7.x
- Modular monolith architecture with clean separation of concerns
- Centralized error handling system (`utils/errors.ts`)
- Common API response types (`types/api.ts`)
- Prisma client configuration with PostgreSQL adapter (`config/database.ts`)
- Environment variable management with dotenv
- Health check endpoint (`GET /health`)
- CORS configuration with @fastify/cors
- Cookie support with @fastify/cookie
- Graceful shutdown handling

#### School Module
- **POST /api/schools** - Create a new school
  - Validates name (1-200 chars)
  - Validates code (uppercase, numbers, hyphens, underscores, unique)
  - Validates school type (PRIMARY, SECONDARY, CUSTOM)
  - Returns 201 on success
  - Returns 400 on validation error
  - Returns 409 on duplicate code
  
- **GET /api/schools/:id** - Get school by ID
  - Validates UUID format
  - Returns 200 with school data
  - Returns 400 on invalid UUID
  - Returns 404 if not found

#### Developer Experience
- `npm run dev` - Development server with hot reload
- `npm run build` - Production build
- `npm start` - Run production build
- `npm run prisma:generate` - Generate Prisma client
- `npm run prisma:migrate` - Run migrations
- `npm run prisma:studio` - Open Prisma Studio

#### Documentation
- `README.md` - Project overview and setup guide
- `DEVELOPMENT.md` - Development roadmap with all modules planned
- `QUICK_START.md` - Quick reference for common tasks
- `IMPLEMENTATION_SUMMARY.md` - Detailed implementation notes
- `ARCHITECTURE.md` - System architecture diagrams and patterns
- `CHANGELOG.md` - This file
- `src/modules/school/README.md` - School API documentation
- `.env.example` - Environment variable template
- `test-school-api.sh` - Automated API test script

#### Configuration
- `.gitignore` - Git ignore rules for Node.js, TypeScript, and Prisma
- `tsconfig.json` - TypeScript configuration with strict mode
- `package.json` - NPM scripts and dependencies
- `.env` - Environment variables (not in git)

### Changed
- Updated Prisma schema to use Prisma 7.x configuration pattern
  - Moved datasource URL from `schema.prisma` to `prisma.config.ts`
- Configured TypeScript with `rootDir` and `outDir` for proper builds
- Added comprehensive npm scripts for development workflow

### Technical Details
- Node.js: 24.x
- TypeScript: 6.x
- Fastify: 5.12.5
- Prisma: 7.10.0
- Zod: 4.6.5
- PostgreSQL: Neon Serverless

### Database Schema
All models defined but only School module implemented:
- School ✅
- Admin ⏳
- AcademicYear ⏳
- Grade ⏳
- Stream ⏳
- Section ⏳
- Subject ⏳
- Teacher ⏳
- TeacherSubject ⏳
- SubjectRequirement ⏳
- SectionSubjectTeacher ⏳
- ScheduleConfig ⏳

### Testing
- All test cases passing
- Manual testing with curl
- Automated test script created
- TypeScript compilation: 0 errors

### Known Issues
None

---

## [Unreleased]

### Added - MODULE 2: ADMIN (Authentication)
- POST /api/admin/register, POST /api/admin/login, POST /api/admin/logout, GET /api/admin/me
- PBKDF2-SHA512 password hashing, 7-day sessions stored as SHA-256 hashes, HTTP-only `session_token` cookie
- `authMiddleware` (session cookie -> `request.admin`) and in-memory per-IP rate limiters

### Added - MODULE 3: ACADEMIC YEAR
- POST /api/academic-years, GET /api/academic-years, GET /api/academic-years/:id, PATCH /api/academic-years/:id
- Status workflow DRAFT -> ACTIVE -> COMPLETED, changed through PATCH
- School derived from the session

### Added - MODULE 4: GRADE
- POST /api/grades, GET /api/grades (optional `?academicYearId=`), GET /api/grades/:id, PATCH /api/grades/:id
- Writes only while the academic year is DRAFT

### Added - MODULE 5: STREAM + SECTION
- POST /api/streams, GET /api/grades/:gradeId/streams, GET /api/streams/:id, PATCH /api/streams/:id
- POST /api/sections, GET /api/grades/:gradeId/sections, GET /api/sections/:id, PATCH /api/sections/:id
- A grade's sections are either all streamed or all non-streamed (enforced under concurrency by a row lock)
- Writes only while the academic year is DRAFT

### Added - MODULE 6: SUBJECT + TEACHER CONFIGURATION
- POST /api/subjects, GET /api/subjects, GET /api/subjects/:id, PATCH /api/subjects/:id
- POST /api/teachers, GET /api/teachers (optional `?isActive=`), GET /api/teachers/:id, PATCH /api/teachers/:id
- POST /api/teachers/:teacherId/subjects, GET /api/teachers/:teacherId/subjects, PATCH /api/teacher-subjects/:id
- POST /api/teacher-subjects/:teacherSubjectId/grades, GET /api/teacher-subjects/:teacherSubjectId/grades,
  DELETE /api/teacher-subjects/:teacherSubjectId/grades/:gradeId
- Subject codes and teacher employee codes are normalised to uppercase; grade eligibility writes only while
  the academic year is DRAFT; no new subjects can be added to an inactive teacher

---

### Added - MODULE 7: SUBJECT REQUIREMENTS
- POST /api/subject-requirements, GET /api/subject-requirements (optional `?academicYearId=`, `?gradeId=`, `?streamId=`),
  GET /api/subject-requirements/:id, PATCH /api/subject-requirements/:id (periodsPerWeek only),
  DELETE /api/subject-requirements/:id
- `periodsPerWeek` is a strict integer 1-40 (strings, booleans, arrays and decimals are rejected); these routes use a
  non-coercing validator, other modules are unchanged
- Streamed grade (by sections, else by streams) requires `streamId`; non-streamed grade must omit it
- Writes only while the academic year is DRAFT; delete refused with 409 if teacher assignments reference the requirement
- Migration `20261002220017_add_subject_requirement_constraints`: partial unique index
  `(gradeId, subjectId) WHERE streamId IS NULL` and `CHECK ("periodsPerWeek" > 0)`
- `getGradeMixingMode` in the section service is now exported (no behaviour change)

---

### Added - MODULE 8: SECTION SUBJECT TEACHER ASSIGNMENT
- POST /api/section-subject-teachers, GET /api/section-subject-teachers (optional `?academicYearId=`, `?gradeId=`,
  `?sectionId=`, `?subjectId=`, `?teacherId=`), GET /api/section-subject-teachers/:id,
  PATCH /api/section-subject-teachers/:id (teacherId only), DELETE /api/section-subject-teachers/:id
- One teacher per (section, subject requirement); a teacher may take many sections; no day, period or workload data
- Requirement must match the section's grade and exact stream; teacher must be active, linked to the subject and
  eligible for the section's grade (400 otherwise); PATCH always re-validates; writes only while the year is DRAFT
- A teacher deactivated after assignment keeps the assignment (`teacher.isActive = false` in responses)
- Creation locks the teacher and eligibility rows (`FOR SHARE`) so it serializes against deactivation and eligibility deletion
- Changed (Module 6): `DELETE /api/teacher-subjects/:id/grades/:gradeId` now returns 409 while an assignment for that
  teacher, subject and grade exists (lock-then-count)
- No schema change and no migration (existing unique `(sectionId, subjectRequirementId)` is correct)

---

### Added - MODULE 9: SCHEDULE CONFIGURATION
- POST /api/schedule-configs, GET /api/schedule-configs (optional `?academicYearId=`), GET /api/schedule-configs/:id,
  PATCH /api/schedule-configs/:id (replaces the supplied sections). No DELETE endpoint.
- One configuration per academic year: working days, `periodsPerDay` (1-12), period start/end times and timing events
  (BREAK, LUNCH, ASSEMBLY, OTHER) anchored to the gap after a period. Timing events never count as teaching periods.
- Times are stored as integer minutes since midnight and exposed as `HH:mm`; responses include a computed read-only `timeline`
- The complete merged grid is validated (sequential periods, no overlaps, events fit their gaps) before anything is saved
- Writes only while the academic year is DRAFT (re-checked inside the transaction under a lock); strict non-coercing validation
- Migration `20261003070914_schedule_grid_minutes_and_timing_events` (with an abort-if-not-empty safety guard): period times become
  `startMinute`/`endMinute`, `schedule_days.isWorkingDay`/`displayOrder` removed (a row is a working day), new
  `schedule_timing_events` table, CHECK constraints
- The future scheduler consumes only `workingDays` + `periods` (`toSolverTimeGrid`)

---

### Added - MODULE 10: TIMETABLE FEASIBILITY (pre-generation validation)
- GET /api/timetable-feasibility?academicYearId= - read-only, stateless readiness report; nothing is persisted and there is no
  migration. Allowed for DRAFT, ACTIVE and COMPLETED years; the school comes from the session.
- Status `READY` / `NOT_READY`: READY means all deterministic preconditions pass, it does not guarantee a timetable exists;
  `notChecked` lists what is left to the solver
- Demand is expanded per section: a requirement defined once per grade/stream applies independently to every matching section
- Errors: schedule missing/invalid, no sections/requirements, section capacity, missing/invalid/inactive/ineligible teacher
  assignments, teacher capacity `min(32, weekly slots)`, no or insufficient eligible teachers (per group and a pooled max-flow
  relaxation). Warnings: sections without requirements, requirements without sections, mixed grade mode, full capacity,
  non-DRAFT year
- Always includes a breakdown (sections, teachers, subject groups); results are sorted and deterministic
- Consistent snapshot read (one REPEATABLE READ transaction); loader -> pure analyzer -> report
- Permanent pure-analyzer tests: `test-timetable-feasibility-analyzer.ts`

---

### Planned - MODULE 12: TIMETABLE GENERATION

#### Features
- Generate timetable using scheduler
- Feasibility validation
- Store generated timetable
- Lock/unlock periods
- Publish timetable (immutable)
- Multiple views (section, teacher)

#### Endpoints
- POST /api/academic-years/:academicYearId/timetables/generate
- GET /api/timetables/:id
- GET /api/timetables/:id/sections/:sectionId
- GET /api/timetables/:id/teachers/:teacherId
- POST /api/timetables/:id/publish
- POST /api/timetables/:id/lock-period

---

## Version History

- **0.1.0** (2026-09-28) - Initial release with School module
- **0.0.0** (2026-09-28) - Project initialization

---

## Contribution Guidelines

When adding entries to this changelog:

1. Add new entries under `[Unreleased]` section
2. Use semantic versioning for releases
3. Group changes by type: Added, Changed, Deprecated, Removed, Fixed, Security
4. Include module name in headers
5. List all API endpoints added
6. Note breaking changes clearly
7. Reference issue/PR numbers if applicable

---

## Links

- **Repository**: (Add when available)
- **Documentation**: See README.md
- **Issue Tracker**: (Add when available)

---

**Maintained by**: School Timetable Management System Team  
**Started**: September 28, 2026
