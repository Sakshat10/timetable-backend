# Timetable Backend

REST API for a school timetable maker. A school's admin sets up the academic year (grades, sections, subjects, teachers,
weekly subject requirements, teacher assignments and the weekly schedule), checks feasibility, generates timetables with
a constraint solver, edits and publishes them, and handles teacher absences with automatic substitute assignment.

The frontend lives in a separate repository. This repository contains the API, the database schema and the solver.

## Features

- **Multi-school, session based**: every authenticated endpoint derives the school from the admin's session cookie; the
  client never supplies it. A record that belongs to another school is refused (403); an unknown one is 404.
- **School setup**: schools, admins (one-time setup token for the first admin), academic years, grades, streams, sections,
  subjects, teachers, teacher-subject and teacher-subject-grade eligibility, subject requirements, section-subject-teacher
  assignments, curriculum, and bulk creation endpoints.
- **Schedule configuration**: working days, periods per day and one break position per day (no clock times).
- **Feasibility analysis**: a read-only readiness report for an academic year (configuration, requirements, teacher
  eligibility and capacity). Sections and subjects without an explicit teacher assignment get a teacher allocated
  automatically, by the same allocator in the report and in generation.
- **Timetable generation**: builds a problem snapshot, runs the Python OR-Tools CP-SAT solver as a separate process, and
  stores the result as a draft timetable version with metrics. Generation runs are tracked and recoverable.
- **Timetable versions**: validate, edit (move/swap lessons), lock, clone and publish versions; drafts can be deleted;
  published versions are immutable history; a draft whose configuration changed since generation is reported as stale.
- **Substitutions**: teacher absences, cover requests, automatic and manual substitute assignment with a school-level policy
  for four consecutive periods, and a history of events.
- **API documentation**: Swagger UI at `/docs` and the OpenAPI document at `/docs/json`.

## Tech stack

| Area | Technology |
|---|---|
| Runtime / language | Node.js 24, TypeScript (strict, ES modules) |
| Web framework | Fastify 5 (`@fastify/cookie`, `@fastify/cors`, `@fastify/swagger`) |
| Database | PostgreSQL via Prisma 7 with the `pg` driver adapter |
| Validation | Zod 4 |
| Solver | Python 3.14 with OR-Tools CP-SAT (`solver/`) |

## Getting started

### Prerequisites

- Node.js 24 and npm (the project is developed on Node 24; `package.json` has no `engines` pin)
- A PostgreSQL database (a local instance or a hosted one such as Neon)
- Python 3.14.7 (pinned in `solver/.python-version`; only needed for timetable generation)

### Install and configure

```bash
npm install
cp .env.example .env     # then edit .env
```

`.env.example` documents every variable. The main ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (required) |
| `PORT`, `HOST` | Where the API listens (defaults `4000`, `0.0.0.0`) |
| `NODE_ENV`, `LOG_LEVEL` | Environment and log level (`LOG_LEVEL` defaults to `info`) |
| `COOKIE_SECRET` | Session cookie secret; required outside development/test (at least 32 random characters) |
| `FRONTEND_URL` | Allowed CORS origin (default `http://localhost:3000`) |
| `TRUST_PROXY` | Set when the API runs behind a reverse proxy, so rate limits use the real client address |
| `SETUP_TOKEN_TTL_HOURS` | Lifetime of a school's first-admin setup token (default 24) |

Timetable generation has further optional settings (`SOLVER_*`, `GENERATION_*`); see [DEVELOPMENT.md](DEVELOPMENT.md).
Never commit `.env`; it is git-ignored.

### Database

```bash
npm run prisma:generate     # generate the Prisma client
npm run prisma:migrate      # create/apply migrations in development (prisma migrate dev)
```

In production apply the committed migrations with `npx prisma migrate deploy`.

### Solver (for timetable generation)

```bash
cd solver
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

See [solver/README.md](solver/README.md) for the protocol and its tests.

### Run

```bash
npm run dev        # development server with reload, http://localhost:4000
npm run build      # compile to dist/
npm start          # run the compiled build
npm run typecheck  # type-check without emitting
```

Health check: `GET /health`. Swagger UI: `http://localhost:4000/docs`.

To issue a new setup token for a school whose token expired or that has no admin yet:
`npm run setup-token -- --school-id <uuid> --confirm-code <school code> [--ttl-hours <1-168>]`
(the token is the only thing printed to stdout; see `src/cli/issue-setup-token.ts`).

## Project structure

```
prisma/               schema.prisma and SQL migrations
solver/               Python CP-SAT solver (separate process) and its tests
src/
  app.ts, server.ts   Fastify app and entry point
  config/             database client, Swagger, security configuration
  middleware/         authentication and rate limiting
  modules/<name>/     routes, controller, service and Zod schemas per feature
  types/, utils/      shared API types, error handling, password and token helpers
  cli/                operator commands (setup token)
e2e/dashboard/        disposable local backend and database for browser testing
test-*.ts, test-*.sh  regression tests (see Testing)
test-fixtures/        shared test helpers and fake solvers
```

Each module follows the same layering: routes → controller (request handling) → service (business logic and Prisma
access), with Zod schemas for input validation. Several modules have their own `README.md` describing their endpoints and
rules, for example [substitution](src/modules/substitution/README.md) and
[schedule-config](src/modules/schedule-config/README.md).

API responses use the envelope `{ "success": boolean, "message": string, "data"?: ..., "errors"?: ... }`
(`GET /health` returns `{ "status": "ok", "timestamp": ... }`).

## Testing

There is no single `npm test` command; the tests are standalone scripts run with `tsx`.

```bash
# Pure logic tests: no database, no server
npx tsx test-timetable-generation-core.ts
npx tsx test-substitution-core.ts
NODE_ENV=production npx tsx test-security-hardening.ts

# Solver tests
cd solver && .venv/bin/python -m unittest discover -s tests -t .
```

The `test-*.sh` scripts call a running server with `curl` and `jq` (`BASE_URL` overrides the address).
API and database tests run the app against a real database and **refuse to run unless `DATABASE_URL` is a local
`*_test` database**. Create a disposable database for them; never point them at a development or production database.
`e2e/dashboard/e2e.sh` can create, migrate and seed such a database and start a backend on port 4010; see
[e2e/dashboard/README.md](e2e/dashboard/README.md).

## Further documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): layering and request flow
- [DEVELOPMENT.md](DEVELOPMENT.md): development guide and patterns
- [CHANGELOG.md](CHANGELOG.md): notable changes
- [solver/README.md](solver/README.md): solver contract and setup

## License

ISC
