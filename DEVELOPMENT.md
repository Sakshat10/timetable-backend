# Development Guide

## Current Status

✅ **MODULES 1–10 - COMPLETED**

All endpoints are under the `/api` prefix. The school is never taken from the client: every
authenticated endpoint derives it from the admin's session cookie (`request.admin.schoolId`) and
verifies that the requested resource belongs to that school (404 if it does not exist, 403 if it
belongs to another school). Updates use `PATCH`. There are no DELETE endpoints, except removing a
teacher's grade eligibility (Module 6).

**Public (no session required):** `GET /health`, `POST /api/schools` (rate limited),
`POST /api/admin/register`, `POST /api/admin/login`, `POST /api/admin/logout`.
**Every other endpoint requires the session cookie** (`authMiddleware`).

| Module | Endpoints |
|--------|-----------|
| 1 - School | `POST /api/schools`, `GET /api/schools/:id` |
| 2 - Admin | `POST /api/admin/register`, `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/me` |
| 3 - Academic Year | `POST /api/academic-years`, `GET /api/academic-years`, `GET /api/academic-years/:id`, `PATCH /api/academic-years/:id` (status changes DRAFT → ACTIVE → COMPLETED also go through this PATCH) |
| 4 - Grade | `POST /api/grades`, `GET /api/grades` (optional `?academicYearId=`), `GET /api/grades/:id`, `PATCH /api/grades/:id` |
| 5 - Stream + Section | `POST /api/streams`, `GET /api/grades/:gradeId/streams`, `GET /api/streams/:id`, `PATCH /api/streams/:id`, `POST /api/sections`, `GET /api/grades/:gradeId/sections`, `GET /api/sections/:id`, `PATCH /api/sections/:id` |
| 6 - Subject + Teacher configuration | `POST/GET /api/subjects`, `GET/PATCH /api/subjects/:id`, `POST/GET /api/teachers` (optional `?isActive=`), `GET/PATCH /api/teachers/:id`, `POST/GET /api/teachers/:teacherId/subjects`, `PATCH /api/teacher-subjects/:id`, `POST/GET /api/teacher-subjects/:teacherSubjectId/grades`, `DELETE /api/teacher-subjects/:teacherSubjectId/grades/:gradeId` |
| 7 - Subject Requirements | `POST /api/subject-requirements`, `GET /api/subject-requirements` (optional `?academicYearId=`, `?gradeId=`, `?streamId=`), `GET /api/subject-requirements/:id`, `PATCH /api/subject-requirements/:id` (`periodsPerWeek` only), `DELETE /api/subject-requirements/:id` |
| 8 - Section Subject Teacher | `POST /api/section-subject-teachers`, `GET /api/section-subject-teachers` (optional `?academicYearId=`, `?gradeId=`, `?sectionId=`, `?subjectId=`, `?teacherId=`), `GET /api/section-subject-teachers/:id`, `PATCH /api/section-subject-teachers/:id` (`teacherId` only), `DELETE /api/section-subject-teachers/:id` |
| 9 - Schedule Configuration | `POST /api/schedule-configs`, `GET /api/schedule-configs` (optional `?academicYearId=`), `GET /api/schedule-configs/:id`, `PATCH /api/schedule-configs/:id` (replaces the supplied fields: `workingDays`, `periodsPerDay`, `breakAfterPeriod`). Create body: `{ academicYearId, workingDays, periodsPerDay, breakAfterPeriod }`; no clock times. No DELETE. |
| 10 - Timetable Feasibility | `GET /api/timetable-feasibility?academicYearId=` (read-only readiness report: `READY` / `NOT_READY`, errors, warnings, breakdown, notChecked). Nothing is persisted. |

Academic-year lifecycle rules in force:
- Grades, streams, sections, teacher grade eligibility (create/delete), subject requirements
  (create/update/delete), section subject teacher assignments (create/update/delete) and the schedule
  configuration (create/update) can only be modified while the academic year is `DRAFT`. Reads are always
  allowed.
- Subjects, teachers, and teacher-subject links are school-level masters: no academic-year rule.
- A new teacher-subject link cannot be added to an inactive teacher.

Subject requirement rules: `periodsPerWeek` is a strict integer 1–40; a streamed grade (by its sections,
else by its streams) requires `streamId` and a non-streamed grade must omit it; one requirement per
(grade, subject) or (grade, stream, subject); a requirement with teacher assignments cannot be deleted (409).

Section subject teacher rules (Module 8): an assignment says "this teacher teaches this subject to this
section" and holds no day, period, workload or availability. One teacher per (section, subject requirement);
one teacher may take any number of sections. The requirement must match the section's grade and exactly its
stream. The teacher must be in the school, active, linked to the subject (`TeacherSubject`) and eligible for
the section's grade, otherwise 400. Grade eligibility is per link: `TeacherSubject.gradeScope` is `SELECTED_GRADES`
(default; needs a `TeacherSubjectGrade` row per grade and academic year) or `ALL_GRADES` (explicit admin choice; no
rows needed). An omitted/empty eligibility is never treated as permission; the subject link is always required.
Narrowing `ALL_GRADES` to `SELECTED_GRADES` is refused (409) while DRAFT-year assignments teach grades without a row. PATCH changes only `teacherId` and always
re-validates, even for the same teacher. A teacher deactivated after being assigned keeps the assignment
(shown with `teacher.isActive = false`). A requirement may exist without an assignment. Dependency guards:
a requirement with assignments cannot be deleted (409), and a grade eligibility that an assignment depends on
cannot be deleted (409).

Schedule configuration rules (Module 9, simplified model): one configuration per academic year (the school's standard weekly
schedule, shared by every grade). It holds the working days (rows; any subset of the week), `periodsPerDay`
(2–12 teaching periods) and exactly ONE break per day, given as `breakAfterPeriod` (1 … periodsPerDay − 1: the period it
comes after). There are no clock times, break durations or other timing events; timetables are generated from period
numbers and the break position only. The break is not a teaching period (weekly capacity = working days × periodsPerDay).
PATCH replaces each supplied field and validates the complete merged schedule before saving. Configurations made before the
simplification (`legacy: true`) stay readable and keep working until saved with `breakAfterPeriod`. Half-days, exams and holidays are NOT part of this configuration
module). Future timetable data must reference `(dayOfWeek, periodNumber)`, never schedule row ids.

Timetable feasibility rules (Module 10): a read-only, stateless report computed from one consistent
(REPEATABLE READ) snapshot; no tables, no migration. `READY` means every deterministic precondition passes; it
does NOT guarantee the solver finds a timetable (the response lists what is `notChecked`). A subject requirement
is defined once per grade/stream but applies independently to every matching section (exact grade + stream
match), so demand is computed per section: 5 periods for sections A, B and C is 15 periods. Checks: schedule
exists; each section's weekly demand fits `working days x periodsPerDay`; every requirement has a teacher (missing
assignments are errors); assigned teachers are active and eligible; a teacher's load is at most
`min(32, weekly slots)`; unassigned demand fits the eligible teachers' remaining capacity (per group plus a pooled
max-flow relaxation that can prove impossibility but not possibility). Sections without requirements and
requirements without sections are warnings (sections cannot be removed).

Known limitations:
- "Only one ACTIVE academic year per school" is not enforced.
- Section creation (Module 5) does not look at subject requirements, so creating sections in the opposite
  mode after requirements exist is not blocked; the scheduler's feasibility check must catch it.

## What Was Implemented

### Backend Structure
- Modular monolith architecture with clean separation of concerns
- Route → Controller → Service → Database pattern
- Centralized error handling
- Consistent API response format
- Zod validation for all inputs

### School Module
- Create schools with validation
- Retrieve schools by ID
- Unique school code enforcement
- School type validation (PRIMARY, SECONDARY, CUSTOM)
- Comprehensive error handling

### Database
- Prisma 7.x with PostgreSQL adapter
- Existing migrations preserved
- All models defined in schema

### Configuration
- Environment variable management
- TypeScript strict mode
- Fastify with CORS and cookies
- Health check endpoint

## Files Created

```
src/
├── config/
│   └── database.ts              # Prisma client with pg adapter
├── modules/
│   └── school/
│       ├── school.schema.ts     # Zod validation schemas
│       ├── school.service.ts    # Business logic
│       ├── school.controller.ts # Request handlers
│       ├── school.routes.ts     # Route definitions
│       └── README.md            # Module documentation
├── types/
│   └── api.ts                   # Common API types
├── utils/
│   └── errors.ts                # Error handling utilities
├── app.ts                       # Fastify app setup
└── server.ts                    # Server entry point

Root files:
├── README.md                    # Project documentation
├── .env.example                 # Environment template
├── .gitignore                   # Git ignore rules
├── test-school-api.sh           # API test script
└── DEVELOPMENT.md               # This file
```

## How to Run

### Start Development Server
```bash
npm run dev
```

Server starts at: http://localhost:4000

### Test the API
```bash
# Run automated tests
./test-school-api.sh

# Or test manually
curl -X POST http://localhost:4000/api/schools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test School",
    "code": "TEST123",
    "schoolType": "SECONDARY"
  }'
```

### Validate TypeScript
```bash
npx tsc --noEmit
```

### Generate Prisma Client
```bash
npm run prisma:generate
```

## Next Modules to Implement

> Modules 1–9 above are implemented. The original plan's Module 4 (Grade & Stream) and Module 5
> (Section) shipped as Module 4 (Grades) and Module 5 (Streams + Sections), the original
> Modules 6–8 (Subject, Teacher, Teacher Subject Eligibility) shipped together as Module 6, and the
> original Module 9 (Subject Requirements) shipped as Module 7, the original Module 10 (Section Subject
> Teacher Assignments) shipped as Module 8, and the original Module 11 (Schedule Configuration) shipped as
> Module 9. Feasibility validation (part of the original Module 12 requirements) was delivered separately as
> Module 10.
> The sections below keep their original labels and are unreviewed proposals: implemented modules
> use `PATCH` (not `PUT`), derive the school from the session (no `:schoolId` path parameter), and
> only have DELETE endpoints where explicitly decided. Confirm each API design before implementing.

### MODULE 12 - TIMETABLE GENERATION
**Priority: Medium** (Requires scheduler integration)

Endpoints needed:
- POST /api/academic-years/:academicYearId/timetables/generate - Generate timetable
- GET /api/timetables/:id - Get timetable
- GET /api/timetables/:id/sections/:sectionId - Section view
- GET /api/timetables/:id/teachers/:teacherId - Teacher view
- POST /api/timetables/:id/publish - Publish timetable
- POST /api/timetables/:id/lock-period - Lock specific period

Requirements:
- Feasibility validation before generation (delivered as Module 10)
- Communicate with scheduler service
- Store generated timetable
- Lock/unlock period functionality
- Publish immutability enforcement

## Development Standards

### Code Organization
- One module per domain entity
- Keep routes, controllers, services separate
- Reuse common utilities
- Document complex business logic

### API Standards
- All endpoints use `/api` prefix
- RESTful naming conventions
- Consistent response format
- Proper HTTP status codes
- Zod validation for all inputs

### Security
- Validate all inputs
- Never trust client data
- Use parameterized queries (Prisma handles this)
- All endpoints except the public bootstrap ones require the session cookie (`authMiddleware`)
- Scope all operations to authenticated admin's school

### Error Handling
- Use AppError for controlled errors
- Return useful validation messages
- Don't expose internal errors to clients
- Log unexpected errors server-side

### Testing
- Manual testing with curl/Postman
- Create test scripts for each module
- Test success and error cases
- Validate all validation rules

## Common Patterns

### Creating a New Module

1. Create module folder: `src/modules/{module-name}/`
2. Create schema: `{module}.schema.ts` with Zod validation
3. Create service: `{module}.service.ts` with business logic
4. Create controller: `{module}.controller.ts` with request handlers
5. Create routes: `{module}.routes.ts` with route definitions
6. Register routes in `src/app.ts`
7. Create module README with API documentation
8. Create test script

### Example Service Method
```typescript
async createEntity(data: CreateEntityInput): Promise<Entity> {
  // 1. Validate business rules
  // 2. Check for conflicts
  // 3. Create the entity
  // 4. Return the result
}
```

### Example Controller Method
```typescript
async createEntity(
  request: FastifyRequest<{ Body: CreateEntityInput }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const validatedData = createEntitySchema.parse(request.body);
    const entity = await entityService.createEntity(validatedData);
    
    const response: ApiSuccessResponse<Entity> = {
      success: true,
      message: 'Entity created successfully',
      data: entity,
    };
    
    reply.status(201).send(response);
  } catch (error) {
    handleError(error, reply);
  }
}
```

## Tips

1. **Before writing code**: Check what already exists and reuse it
2. **After implementing**: Run TypeScript validation and test the endpoints
3. **Error messages**: Make them useful for frontend developers
4. **Validation**: Be strict - validate everything
5. **Documentation**: Update module README with API specs
6. **Git**: Commit after each working module

## Performance Considerations

- Use Prisma's `select` to fetch only needed fields
- Use `include` sparingly - only when related data is needed
- Add database indexes for frequently queried fields (already defined in schema)
- Consider pagination for list endpoints (implement when needed)
- Use connection pooling (already configured in database.ts)

## Questions to Ask Before Implementing

1. What validation rules apply?
2. What are the uniqueness constraints?
3. What can be deleted? What requires cascade checks?
4. Who can access this resource? (School scoping)
5. What are the state transitions? (e.g., academic year status)
6. What's the maximum/minimum allowed? (e.g., periods per week)

## Troubleshooting

### TypeScript Errors
```bash
npx tsc --noEmit
```
Fix imports, type definitions, and strict mode issues.

### Prisma Issues
```bash
npm run prisma:generate
npx prisma validate
```

### Database Connection Issues
- Check DATABASE_URL in .env
- Verify Neon database is accessible
- Check pg adapter is properly configured

### Server Not Starting
- Check port 4000 is available
- Verify all dependencies are installed
- Check for syntax errors in recent changes

## Useful Commands

```bash
# Development
npm run dev                    # Start with hot reload
npm run prisma:studio          # Open database GUI

# Validation
npx tsc --noEmit              # Check TypeScript
npx prisma validate            # Check Prisma schema

# Database
npm run prisma:generate        # Generate Prisma client
npm run prisma:migrate         # Create new migration

# Testing
./test-school-api.sh          # Test school endpoints
curl http://localhost:4000/health  # Health check
```

## Environment Variables Reference

```bash
DATABASE_URL=<neon-postgres-url>
PORT=4000
HOST=0.0.0.0
NODE_ENV=development
LOG_LEVEL=info
COOKIE_SECRET=<random-secret>
FRONTEND_URL=http://localhost:3000
```

---

**Last Updated**: October 3, 2026
**Current Module**: MODULE 10 - TIMETABLE FEASIBILITY ✅
**Next Module**: to be decided (see "Next Modules to Implement")

Bulk creation: `POST /api/subjects/bulk`, `POST /api/teachers/bulk` and `POST /api/grades/bulk` are all-or-nothing and reuse the
single-record validation. Errors are keyed by row (`subjects.2.code`, `grades.0.sections.1.streamCode`): request-level rule violations
are 400, conflicts with existing data are 409, and nothing is written in either case. Teacher bulk creation requires an
`Idempotency-Key` header persisted in `teacher_bulk_requests` (unique per school and key, written in the same transaction as the teachers).

Optional teacher assignments: explicit section-subject-teacher rows are overrides. For every (section, requirement) without one, the
generation normalizer (and the feasibility report, with the same allocator) chooses a teacher among the active teachers of the school
who are qualified (`TeacherSubject`) and eligible for the grade (`gradeScope` ALL_GRADES, or a `TeacherSubjectGrade` row). Nothing is
eligible by omission. The choice is deterministic and part of the solver problem and its hash; a later eligibility change makes an
existing draft stale. `DELETE /api/teacher-subjects/:id` removes one teacher-subject link; it is refused (409) while a DRAFT/ACTIVE-year
assignment or a published timetable lesson of that teacher and subject exists.

Substitution (Module 12): teacher absences and unavailability, lessons needing cover from the PUBLISHED timetable, replacement candidates and assignments, with an audit trail.
Rules and routes are in `src/modules/substitution/README.md`. New tables: `teacher_absences`, `teacher_unavailabilities`, `cover_requests`, `cover_events`.
