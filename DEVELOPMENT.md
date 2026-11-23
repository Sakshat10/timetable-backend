# Development guide

How to set up, run, test and change this backend. For how it is built see [ARCHITECTURE.md](ARCHITECTURE.md); for a project
overview see [README.md](README.md).

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node.js and npm | 24 (no `engines` pin in `package.json`) | everything |
| PostgreSQL | a local server, or a hosted database such as Neon | everything |
| Python | 3.14.7 (`solver/.python-version`) | timetable generation and the solver tests |
| `curl`, `jq` | any | the `test-*.sh` scripts |

## Local setup

```bash
npm install
cp .env.example .env        # edit DATABASE_URL at least
npm run prisma:generate
npm run prisma:migrate      # applies migrations to the database in DATABASE_URL (see "Database")
npm run dev
```

The API listens on `http://localhost:4000`. Check `GET /health`; Swagger UI is at `/docs` (OpenAPI JSON at `/docs/json`).

`npm install` runs a `postinstall` step (`prisma skills sync`) that may create local tool folders (`.agents/`, `.cursor/`, ...).
They are git-ignored and failures are ignored.

To run timetable generation locally, install the solver too:

```bash
cd solver
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt   # ortools==9.15.6755
```

## Environment variables

`.env` is loaded by `dotenv` and is git-ignored. Never commit it. `.env.example` is the reference for the first group.

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `PORT`, `HOST` | `4000`, `0.0.0.0` | listen address |
| `NODE_ENV` | | `development`, `test` or `production`; production tightens cookies and security checks |
| `LOG_LEVEL` | `info` | Fastify/pino log level |
| `COOKIE_SECRET` | dev default with a warning | at least 32 random characters; the server refuses to start without it outside development/test |
| `FRONTEND_URL` | `http://localhost:3000` | allowed CORS origin |
| `TRUST_PROXY` | `false` | proxy hops or addresses to trust for the client address (set it behind a reverse proxy) |
| `SETUP_TOKEN_TTL_HOURS` | `24` | lifetime of a school's first-admin setup token, 1-168 |

Timetable generation (all optional; invalid values stop the server at start-up):

| Variable | Default | Meaning |
|---|---|---|
| `GENERATION_RUNNER_ENABLED` | `true` | `false` makes an API-only instance that queues runs but does not solve them |
| `SOLVER_PYTHON`, `SOLVER_ENTRYPOINT` | `solver/.venv/bin/python`, `solver/main.py` | interpreter and entry point of the solver |
| `SOLVER_WORKERS` | `4` | solver threads per solve (never above the CPU count) |
| `SOLVER_MAX_CONCURRENT_RUNS` | `min(2, cpus / workers)` | concurrent solves |
| `SOLVER_QUEUE_MAX` | `10` | queued runs allowed |
| `SOLVER_TIME_LIMIT_LE10`, `_LE50`, `_LE100`, `_GT100`, `_MAX` | `10`, `60`, `120`, `180`, `300` | time budget in seconds by number of sections, and the ceiling |
| `SOLVER_KILL_GRACE_SECONDS` | `20` | grace before a stuck solver is killed |
| `MAX_DRAFTS_PER_YEAR` | `20` | draft versions allowed per academic year |
| `GENERATION_QUEUE_TTL_MINUTES`, `GENERATION_LEASE_SECONDS`, `GENERATION_HEARTBEAT_SECONDS`, `GENERATION_HEARTBEAT_MAX_FAILURES`, `GENERATION_TICK_SECONDS`, `GENERATION_MAX_ATTEMPTS`, `GENERATION_SHUTDOWN_GRACE_SECONDS`, `GENERATION_PERSIST_MAX_RETRIES`, `GENERATION_PERSIST_LOCK_TIMEOUT_SECONDS` | `30`, `90`, `20`, `3`, `15`, `2`, `30`, `2`, `10` | runner queue and lease tuning (`timetable-generation.runner-config.ts`) |

## Database and Prisma

The schema is `prisma/schema.prisma`; migrations are SQL files in `prisma/migrations/`; `prisma.config.ts` reads `DATABASE_URL`.

| Task | Command |
|---|---|
| Generate the client after any schema change or fresh install | `npm run prisma:generate` |
| Create and apply a migration in development | `npm run prisma:migrate` (`prisma migrate dev`) |
| Apply committed migrations (production, CI, any shared database) | `npx prisma migrate deploy` |
| See which migrations are applied | `npx prisma migrate status` |
| Browse data | `npm run prisma:studio` |

Rules of thumb:

- Treat `prisma migrate dev` as a development-database command. Use `migrate deploy` for shared or production databases.
- Some constraints (partial unique indexes, CHECK constraints) exist only in the migration SQL, not in `schema.prisma`. Review
  generated SQL before committing a migration and keep such statements when editing.
- Deploy the migration before the code that reads the new column. Prisma selects every column of a model, so code that is ahead
  of its database fails with a column-does-not-exist error (`P2022`), which the API reports as a generic `500`.
- Never point the test scripts at a development or production database (see "Testing").

## Running, type-checking and building

```bash
npm run dev          # tsx watch src/server.ts: restarts on changes
npm run typecheck    # tsc --noEmit
npm run build        # tsc, output in dist/ (git-ignored)
npm start            # node dist/server.js
```

Operator command for a school whose setup token expired or that has no admin yet:

```bash
npm run setup-token -- --school-id <uuid> --confirm-code <school code> [--ttl-hours <1-168>]
# production build: node dist/cli/issue-setup-token.js --school-id ... --confirm-code ...
```

## Testing

There is no `npm test`. Tests are standalone scripts in the repository root (`test-*.ts`, `test-*.sh`) plus the solver's own
suite. Each file's first lines say what it covers and how to run it.

### Pure tests (no database, no server)

```bash
npx tsx test-timetable-generation-core.ts
npx tsx test-substitution-core.ts
npx tsx test-curriculum-core.ts
NODE_ENV=production npx tsx test-security-hardening.ts
```

Other `test-*-core.ts` files are pure in the same way.

### API and database tests

These call `buildApp()` with `app.inject()` and write to a real database. They **refuse to run unless `DATABASE_URL` is a
local `*_test` database**. Use the disposable end-to-end database below (never Neon, a development database or production):

```bash
e2e/dashboard/e2e.sh create && e2e/dashboard/e2e.sh migrate          # one-time (or: all, which also seeds)
e2e/dashboard/e2e.sh exec npx tsx test-schedule-simplified-api.ts    # run any test in the clean e2e environment
```

`exec` runs the command with a clean environment, `DATABASE_URL` set to the disposable database and `.env` never loaded.

The `test-*.sh` scripts call a running server with `curl`/`jq`; `BASE_URL` overrides the address. Start a server first (for
example `e2e/dashboard/e2e.sh start-bg`, then `BASE_URL=http://127.0.0.1:4010 ./test-school-api.sh`). Scripts that create data
should only be pointed at a disposable backend.

### Disposable end-to-end database

`e2e/dashboard/e2e.sh` manages a local PostgreSQL database named `timetable_dashboard_e2e_test` and a backend on port 4010 for
real-browser testing of the frontend. It never touches `.env`, Neon or port 4000.

```bash
e2e/dashboard/e2e.sh all          # create + migrate + seed
e2e/dashboard/e2e.sh start-bg     # backend on http://127.0.0.1:4010
e2e/dashboard/e2e.sh verify       # real HTTP checks; regenerates e2e/dashboard/API_CONTRACTS.md
e2e/dashboard/e2e.sh reset --yes --seed   # drop, recreate, migrate and reseed ONLY the disposable database
e2e/dashboard/e2e.sh cleanup --yes        # stop the backend and drop the disposable database
```

`API_CONTRACTS.md` is generated by `e2e/dashboard/verify-api.ts`; do not edit it by hand. Details, safety checks and the seeded
data are in [e2e/dashboard/README.md](e2e/dashboard/README.md).

### Solver tests

```bash
cd solver
.venv/bin/python -m unittest discover -s tests -t .
```

The suite includes solving tests with time limits and takes several minutes. See [solver/README.md](solver/README.md).

## Adding or changing a module

1. Create `src/modules/<name>/` with `<name>.schema.ts` (Zod), `<name>.service.ts`, `<name>.controller.ts` and `<name>.routes.ts`,
   following an existing module of similar size.
2. Register the routes in `src/app.ts` with the `/api` prefix.
3. In the service, take the school from `request.admin.schoolId`, check that referenced records belong to it, and throw
   `AppError` for expected failures. Put rules that need no database in a `*.core.ts` file so they can be tested without one.
4. If the schema changes: edit `prisma/schema.prisma`, run `npm run prisma:migrate`, review the SQL and commit the migration.
5. Add a test script in the repository root and, when the module has non-obvious rules, a `README.md` in its folder.
6. Run `npm run typecheck` and the relevant tests.

## Common problems

| Symptom | Cause and fix |
|---|---|
| `500 "An unexpected error occurred"` on an endpoint, server log mentions `P2022` or a missing column | The database is behind the code. Run `npx prisma migrate status`, then `migrate deploy` on that database. |
| TypeScript errors about missing Prisma models or fields | The client is stale. Run `npm run prisma:generate`. |
| Server exits at start-up with a `COOKIE_SECRET` or `TRUST_PROXY` message | Outside development/test a strong `COOKIE_SECRET` is required; check `.env`. |
| `EADDRINUSE` | Another process uses the port. Change `PORT` or stop it. Do not stop a server you did not start. |
| Login returns `429` | The in-memory limiter allows 5 logins per 15 minutes per address. Restart the server (or `e2e.sh restart`). |
| Generation fails with `SOLVER_UNAVAILABLE` | The Python virtual environment is missing. Set it up as described above or set `SOLVER_PYTHON`. |
| Generation is queued but never runs | `GENERATION_RUNNER_ENABLED=false`, or no runner process is alive. |
| Requests hang or time out after the machine sleeps | Connections are dropped. The pool fails a stalled connect after 20 s; retry. |
| A test script says it refuses to run | `DATABASE_URL` is not a local `*_test` database. Use `e2e.sh exec`. |
| `e2e.sh` refuses to continue | Its safety checks failed (wrong database name, no marker, non-loopback host, time zone). Read the message; do not bypass it. |
