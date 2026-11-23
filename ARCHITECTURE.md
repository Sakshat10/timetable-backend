# Architecture

This document describes how the backend is built today. For setup and day-to-day commands see
[DEVELOPMENT.md](DEVELOPMENT.md); for each feature's endpoints and rules see the `README.md` inside the module folders.

## 1. Overview

A single Node.js process serves a REST API (Fastify, TypeScript) backed by PostgreSQL (Prisma). Timetable solving runs in a
separate Python process (OR-Tools CP-SAT) that the Node process starts on demand. There is no message broker: the database is
also the job queue for timetable generation.

```
 Frontend (separate repo)
        │  HTTP/JSON, session cookie
        ▼
 ┌──────────────────────────────── Node.js process ────────────────────────────────┐
 │  Fastify app (src/app.ts)                                                       │
 │    CORS · cookies · Swagger (/docs) · /health · /api/* routes                   │
 │      route → authMiddleware → controller (Zod) → service (rules + Prisma)       │
 │                                                                                 │
 │  Generation runner (in the same process, started by src/server.ts)              │
 │    polls the queue table → claims a run → spawns ──────────────┐                │
 └───────────────────────────────┬─────────────────────────────────│───────────────┘
                                 │ Prisma + pg pool                │ JSON on stdin/stdout
                                 ▼                                 ▼
                           PostgreSQL                     Python solver (solver/main.py)
                                                          OR-Tools CP-SAT, no DB, no network
```

| Layer | Technology |
|---|---|
| HTTP | Fastify 5, `@fastify/cookie`, `@fastify/cors`, `@fastify/swagger` and swagger-ui |
| Validation | Zod 4 in the controllers |
| Data access | Prisma 7 with the `pg` driver adapter (`src/config/database.ts`) |
| Database | PostgreSQL; schema and migrations in `prisma/` |
| Solver | Python, OR-Tools CP-SAT (`solver/`) |

## 2. Request lifecycle

1. `buildApp()` (`src/app.ts`) validates the security configuration first (`COOKIE_SECRET`, `TRUST_PROXY`,
   `SETUP_TOKEN_TTL_HOURS`); an invalid value stops start-up. It then registers CORS (origin from `FRONTEND_URL`, credentials on),
   cookies, Swagger, `GET /health` and every module's routes under the `/api` prefix.
2. A route declares its Swagger schema and a `preHandler`: `authMiddleware` for authenticated routes, plus a rate limiter for the
   public ones.
3. The controller parses the body, query and params with Zod and calls the service. Validation failures become a `400` with
   field-level `errors`.
4. The service applies the business rules and talks to Prisma, often inside a transaction.
5. The controller returns the standard envelope; thrown errors pass through `handleError` (section 8).

`src/server.ts` is the process entry point: it connects to the database, builds the app, listens on `PORT`/`HOST`, starts the
generation runner (unless `GENERATION_RUNNER_ENABLED=false`) and, on `SIGINT`/`SIGTERM`, stops the runner (running generations
are requeued) and disconnects Prisma.

## 3. Authentication and school isolation

- **Accounts**: a school is created with `POST /api/schools`, which returns a one-time setup token. The first admin registers
  with that token (`POST /api/admin/register`); further admins are added by an authenticated admin (`POST /api/admins`). The token
  is stored only as a SHA-256 hash, is consumed atomically and expires (`SETUP_TOKEN_TTL_HOURS`). An operator can issue a new one
  with the `setup-token` CLI.
- **Passwords**: hashed with PBKDF2 (SHA-512), `src/utils/password.ts`.
- **Sessions**: login creates a random token, sets it in an `HttpOnly` cookie named `session_token` (7 days; `Secure` and
  `SameSite=Strict` in production, `Lax` otherwise) and stores only its SHA-256 hash in `admin_sessions`.
- **`authMiddleware`** reads the cookie, validates the session and attaches `request.admin` (`id`, `schoolId`, `email`, `name`).
  A missing or invalid session is `401`.
- **Isolation**: services never accept a school id from the client. They use `request.admin.schoolId` and check that every
  referenced record belongs to that school: an unknown id is `404`, a record of another school is `403`. There is a single admin
  role; every admin of a school has the same permissions.
- **Rate limits** (in memory, per client address and per process): login 5 per 15 minutes, admin registration 3 per hour, school
  creation 1 per 24 hours. `TRUST_PROXY` controls which proxy headers determine the client address; run one instance, or enforce
  limits at the proxy as well.

## 4. Module organisation

Each feature lives in `src/modules/<name>/` and follows the same layering:

| File | Role |
|---|---|
| `<name>.routes.ts` | Route registration, Swagger schemas, `preHandler` |
| `<name>.controller.ts` | Zod parsing, status codes, response envelope |
| `<name>.service.ts` | Business rules and Prisma access |
| `<name>.schema.ts` | Zod schemas and inferred types |

Larger modules split pure logic into `*.core.ts` files (no database, no clock) so the rules can be tested exhaustively.

| Group | Modules |
|---|---|
| Identity | `school`, `admin` |
| School structure | `academic-year`, `grade`, `stream`, `section`, `subject`, `teacher`, `teacher-subject`, `teacher-subject-grade` |
| Teaching configuration | `subject-requirement`, `section-subject-teacher`, `curriculum` |
| Schedule | `schedule-config` |
| Timetabling | `timetable-feasibility`, `timetable-generation`, `timetable-version` |
| Substitution | `substitution` |
| Record management | `record-deletion` (dependency-checked deletion and deactivation; history is retired, not erased) |

Shared code: `src/config` (database client, Swagger, security configuration), `src/middleware` (authentication, rate limiting),
`src/types` (envelope types), `src/utils` (errors, password and token helpers).

## 5. Data access (Prisma and PostgreSQL)

- One shared `PrismaClient` over a `pg` pool (`src/config/database.ts`): connection timeout 20 s, TCP keep-alive, connections
  recycled after 30 minutes, pool errors logged without connection details.
- Models: `School`, `Admin`, `SchoolSetupToken`, `AdminSession`, `AcademicYear`, `Grade`, `Stream`, `Section`, `Subject`,
  `Teacher`, `TeacherSubject`, `TeacherSubjectGrade`, `SubjectRequirement` (+ per-section scope), `SectionSubjectTeacher`,
  `ScheduleConfig` (+ days, periods, timing events), `TimetableVersion`, `TimetableEntry`, `TimetableGenerationRun`,
  `TeacherAbsence`, `TeacherUnavailability`, `CoverRequest`, `CoverEvent`, `TeacherBulkRequest`.
- Every table that belongs to a school carries `schoolId`. Academic years have the status `DRAFT`, `ACTIVE` or `COMPLETED`.
- Concurrency is handled in the database: transactions, row locks (`FOR UPDATE` / `FOR SHARE`), advisory locks, partial unique
  indexes and optimistic `revision` numbers, rather than in application memory. Several invariants (for example one active
  generation run per academic year) are enforced by partial unique indexes written in the migration SQL.
- Schema changes are SQL migrations in `prisma/migrations/`.

## 6. Timetable generation

### Schedule model
A school's weekly schedule (`schedule-config`) is: working days, periods per day and one break position per day
(`breakAfterPeriod`). There are no clock times. The break is not a teaching period; it only ends a run of consecutive lessons.
Older configurations and versions that still carry clock times remain readable.

### Lifecycle of a generation
1. **Request**: `POST /api/timetable-generations` validates the request and queues a run (`QUEUED`), returning `202` with a
   `Location` header. Nothing is solved inside the request. Runs can also start from an existing draft with locked lessons.
2. **Queue**: the database is the queue. The runner (`timetable-generation.runner.ts`) ticks periodically, claims runs under a
   lease it keeps alive with a heartbeat, and limits concurrency. A run whose worker died is recovered when its lease expires; a
   graceful shutdown requeues it without consuming an attempt. At most one run per academic year is active at a time.
3. **Execution** (`timetable-generation.orchestrator.ts`), one clock for the whole run:
   fresh consistent snapshot of the year (REPEATABLE READ) → year must be `DRAFT` → feasibility must be `READY` →
   normalisation into the immutable solver problem and its input hash → a validated TypeScript baseline timetable →
   solver subprocess with the remaining time budget → interpretation → validation → independent metrics.
4. **Persistence** (`timetable-generation.final-persist.ts`), one transaction: fence on the run's lease, lock everything the problem
   depends on, re-read the configuration, and re-check that its hash equals the hash of the problem that was solved
   (otherwise `CONFIGURATION_CHANGED` and nothing is written), re-validate, enforce the per-year draft cap, then write a new
   `DRAFT` version with its entries and mark the run `SUCCEEDED`.

Nothing is trusted from enqueue time: the snapshot, feasibility check and hash are recomputed when the run executes.

### Python solver integration
`timetable-generation.solver-client.ts` starts `solver/main.py` (the interpreter defaults to `solver/.venv/bin/python`; override
with `SOLVER_PYTHON` and `SOLVER_ENTRYPOINT`) and exchanges one JSON document each way over stdin/stdout. The contract is defined in
`timetable-generation.contracts.ts` on the TypeScript side and mirrored in `solver/timetable_solver/contract.py`; a test fails if
they drift. The solver has no database or network access. The Node side decides what a failure means: only a clean `UNKNOWN`
result or a watchdog kill may fall back to the validated baseline (`solutionSource = BASELINE`); a crash, an unavailable solver or
invalid output fails the run.

### Snapshots and versions
A `TimetableVersion` stores the exact input it was generated from (`inputSnapshot`, `inputHash`), the weights version, solver
status and diagnostics, and its metrics next to the baseline's. Versions are numbered per academic year. A version is `DRAFT`,
`PUBLISHED` or `ARCHIVED`:

- Only drafts can be edited (move or swap a lesson), locked, deleted or published. Edits are validated in full and use an
  `expectedRevision` check.
- Publishing makes a version `PUBLISHED` and archives the previous published one in the same transaction. It is refused when the
  timetable is invalid or stale.
- **Staleness** uses one strict rule: the live configuration, freshly normalised, must hash to the version's stored hash.
- Published and archived versions are immutable history. Cloning copies a version into a new draft with provenance.
- Views of a version (per section or per teacher) are built from the stored data; legacy versions with stored period times keep
  showing them.

## 7. Substitution workflow

Backend only; the source of lessons is always the school's **published** timetable version.

1. An admin records a teacher absence (or unavailability). Cover requests (`CoverRequest`) are created for the affected lessons of
   the published version for each date. A cover request is a snapshot of one lesson on one date.
2. Substitutes are assigned automatically (`substitution.auto.ts`, with the pure allocator in `substitution.allocator.ts`), one
   transaction per day, serialised per school. Hard constraints: same school, active, not absent, not unavailable, not teaching or
   covering in that period. Candidates are ranked by subject match, grade eligibility, weekly workload, covers that day,
   consecutive run length and recent covers.
3. A school setting, `consecutivePeriodPolicy` (`ALLOW`, `PREFER_AVOID` default, `NEVER_ALLOW`), controls how four consecutive
   periods are treated. A manual assignment or reassignment re-runs the same checks and is recorded as an event; automatic allocation
   only touches `OPEN` requests, so it never overwrites an existing assignment, manual or automatic.
4. Publishing a new version reconciles cover requests: requests tied to a version that is no longer published become `OBSOLETE`
   (history kept) and new ones are created and allocated.
5. Every change writes a `CoverEvent`, which also feeds the events endpoint.

See [src/modules/substitution/README.md](src/modules/substitution/README.md) for the rules and endpoints.

## 8. Errors and validation

- Input is validated with Zod in the controllers; Prisma parameterises every query.
- Services throw `AppError(statusCode, message, errors?)`. `handleError` (`src/utils/errors.ts`) turns Zod errors into `400`,
  `AppError` into its status, known Prisma errors (for example a unique violation) into `409`, and everything else into a generic
  `500` so internals are never leaked.
- Success: `{ "success": true, "message": "...", "data": ... }`. Error: `{ "success": false, "message": "...", "errors"?: ... }`.
  `GET /health` is the one endpoint with a different shape.
- Status codes in use: `200`, `201`, `202` (generation queued), `400`, `401`, `403`, `404`, `409`, `429` (rate limited), `500`.

## 9. Testing structure

Pure-logic tests (`test-*-core.ts`) need no database. API and database tests build the app with `buildApp()` and call it with
`app.inject()` against a disposable local `*_test` database, and refuse to run against anything else. `e2e/dashboard/` provides
that disposable database and a backend on port 4010. The solver has its own `unittest` suite. See [DEVELOPMENT.md](DEVELOPMENT.md).
