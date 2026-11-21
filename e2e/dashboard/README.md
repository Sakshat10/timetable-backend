# Dashboard e2e backend (disposable)

A local-only backend + database for real-browser dashboard testing. Never touches Neon, `.env`, the developer database or port 4000.

| Item | Value |
|---|---|
| Database | `timetable_dashboard_e2e_test` on local PostgreSQL (loopback only), time zone forced to UTC |
| Backend | `http://127.0.0.1:4010` (`NODE_ENV=test`, clean environment, `.env` never loaded) |
| Admin | `admin@e2e.local` / `E2eAdmin#2026-Dashboard`; the school id is in `.run/seed-manifest.json` (`login.schoolId`) |

## Commands (`e2e/dashboard/e2e.sh <command>`)

```
all               create + migrate + seed
create | migrate | seed
start | start-bg | stop | restart | health
verify            real HTTP checks of the dashboard contracts; regenerates API_CONTRACTS.md
session           log in once, write .run/storage-state.json (Playwright storageState)
status
reset --yes [--seed]   drop + recreate + migrate ONLY the disposable database
cleanup --yes          stop backend, drop ONLY the disposable database, remove .run
```

Every database-touching command first proves, from the server's own answers, that the target is `timetable_dashboard_e2e_test`, on loopback, with the marker comment written by `create`. A database without the marker is never adopted, reset or dropped.

## Frontend

Run the frontend (not modified) against it: `VITE_API_PROXY_TARGET=http://127.0.0.1:4010 npm run dev`.

## Things to know

- Login is limited to 5 requests per 15 minutes per IP (in memory). Use `session` for a reusable cookie; `restart` resets the limiter.
- "Today" in the seed is the reference working day `dates.wd["0"]` (today on Mon-Fri, otherwise the next Monday). Re-seed to move the data: `reset --yes --seed`.
- The seed uses the real generation pipeline and OR-Tools solver (seed + `reproducible`), the real publish endpoint and real substitution workflows. The only direct SQL is back-dating timestamps of the three historical absences.
- The 15 subjects are my assumption: no canonical list exists in either repository.
