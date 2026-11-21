#!/usr/bin/env bash
# =============================================================================
# Disposable backend environment for real-browser dashboard integration testing.
#
#   e2e/dashboard/e2e.sh <command>
#
#   create            create the local database  timetable_dashboard_e2e_test  (+ identity marker)
#   migrate           apply the existing Prisma migrations to it
#   seed              load the deterministic dashboard dataset (through the real API / workflows)
#   all               create + migrate + seed
#   start             run the backend in the FOREGROUND on port 4010
#   start-bg          run the backend in the background (log: e2e/dashboard/.run/server.log)
#   stop              stop the backend that listens on 4010 (only if it is this repository's)
#   restart           stop + start-bg (also resets the in-memory login rate limit: 5 logins / 15 min)
#   exec <cmd...>     run any command (tests, tsx scripts) in the clean e2e environment (NODE_ENV=${E2E_NODE_ENV:-test}); DATABASE_URL is the disposable DB
#   session           log in once, write e2e/dashboard/.run/storage-state.json (Playwright storageState)
#   health            check GET /health on 4010 and the database identity
#   verify            call the dashboard's real API contracts on 4010 and record shapes
#   status            what exists right now
#   reset --yes       drop + recreate + migrate ONLY the disposable database (add --seed to reseed)
#   cleanup --yes     stop the backend, drop ONLY the disposable database, remove e2e/dashboard/.run
#
# Safety rules enforced here (and again in lib/guard.ts):
#   * DATABASE_URL is built in this script from fixed parts. .env is NEVER read and NEVER loaded
#     (child processes run under `env -i` with DOTENV_CONFIG_PATH pointing at a file that does not exist).
#   * The host must be loopback and the database name exactly timetable_dashboard_e2e_test.
#   * Before every migrate / seed / start / reset / cleanup the database identity is proven from the
#     server's own answers: current_database(), a loopback server address and the marker comment written by `create`.
#     A database that exists without the marker is never adopted, migrated, reset or dropped.
#   * The backend uses port 4010. Port 4000 is never started, probed, signalled or stopped.
#   * No credentials are printed (the local connection has no password; none is logged).
# =============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RUN_DIR="$HERE/.run"

DB_NAME="timetable_dashboard_e2e_test"
DB_MARKER="timetable-dashboard-e2e: disposable local database, safe to reset"
API_PORT=4010
PG_HOST="${E2E_PG_HOST:-localhost}"
PG_PORT="${E2E_PG_PORT:-5432}"
PG_USER="${E2E_PG_USER:-$(id -un)}"
# Not a secret: it only signs cookies of a throw-away local server. Fixed so sessions are reproducible.
COOKIE_SECRET="e2e-dashboard-local-signing-key-9f3a7c21b8d04e56"

die() { echo "e2e: $*" >&2; exit 1; }
say() { echo "e2e: $*"; }

# ---- target validation -------------------------------------------------------------------------------------------
guard_target() {
  case "$PG_HOST" in localhost|127.0.0.1) ;; *) die "refusing database host '$PG_HOST': only localhost or 127.0.0.1 are allowed" ;; esac
  [[ "$PG_PORT" =~ ^[0-9]{2,5}$ ]] || die "invalid E2E_PG_PORT"
  [[ "$PG_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "invalid E2E_PG_USER"
  [ "$DB_NAME" = "timetable_dashboard_e2e_test" ] || die "internal error: database name changed"
  [ "$API_PORT" = "4010" ] || die "internal error: API port changed"
  [ "$API_PORT" != "4000" ] || die "port 4000 is never used"
  DATABASE_URL="postgresql://${PG_USER}@${PG_HOST}:${PG_PORT}/${DB_NAME}"
}

psql_base() { psql -X -q -v ON_ERROR_STOP=1 -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" "$@"; }
psql_admin() { psql_base -d postgres "$@"; }
psql_e2e() { psql_base -d "$DB_NAME" "$@"; }

server_reachable() { psql_admin -Atc "select 1" >/dev/null 2>&1 || die "cannot reach the local PostgreSQL at $PG_HOST:$PG_PORT as '$PG_USER'"; }
db_exists() { [ "$(psql_admin -Atc "select 1 from pg_database where datname = '$DB_NAME'")" = "1" ]; }

# Proves the database is THE disposable one. Aborts otherwise.
assert_identity() {   # assert_identity [--no-tz]  (--no-tz: only for drop/reset, which must work on a database that has the wrong zone)
  db_exists || die "database $DB_NAME does not exist (run: e2e.sh create)"
  local out db addr marker tz
  out="$(psql_e2e -Atc "select current_database() || '|' || coalesce(host(inet_server_addr()), 'socket') || '|' || coalesce(shobj_description((select oid from pg_database where datname = current_database()), 'pg_database'), '') || '|' || current_setting('TimeZone')")"
  IFS='|' read -r db addr marker tz <<<"$out"
  [ "$db" = "$DB_NAME" ] || die "identity check failed: connected database is not $DB_NAME"
  case "$addr" in 127.0.0.1|::1|socket) ;; *) die "identity check failed: the server is not on this machine" ;; esac
  [ "$marker" = "$DB_MARKER" ] || die "identity check failed: $DB_NAME has no disposable-database marker. Refusing to touch it."
  [ "${1:-}" = "--no-tz" ] || [ "$tz" = "UTC" ] || die "the database time zone is '$tz', not UTC (the app needs UTC). Run: e2e.sh reset --yes --seed"
  say "identity verified: database=$db host=$PG_HOST:$PG_PORT server=$addr marker=ok timezone=$tz"
}

# ---- processes ---------------------------------------------------------------------------------------------------
# Runs a command with a CLEAN environment: nothing from the caller's shell or .env can leak in.
node_run() {
  ( cd "$ROOT" && exec env -i \
      PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
      DATABASE_URL="$DATABASE_URL" \
      DOTENV_CONFIG_PATH="/nonexistent/e2e-dotenv-disabled" DOTENV_CONFIG_QUIET="true" \
      NODE_ENV="test" PORT="$API_PORT" HOST="127.0.0.1" \
      FRONTEND_URL="${E2E_FRONTEND_URL:-http://localhost:5173}" COOKIE_SECRET="$COOKIE_SECRET" \
      LOG_LEVEL="${E2E_LOG_LEVEL:-warn}" SOLVER_WORKERS="2" \
      E2E_BASE_URL="http://127.0.0.1:${API_PORT}" ${E2E_ANCHOR_DATE:+E2E_ANCHOR_DATE="$E2E_ANCHOR_DATE"} \
      "$@" )
}

# PIDs listening on 4010 (never looks at any other port).
listeners() { lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u || true; }
is_ours() {   # a listener whose working directory is this repository
  local pid="$1" cwd
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  [ "$cwd" = "$ROOT" ]
}
require_port_free() {
  local l; l="$(listeners)"
  [ -z "$l" ] || die "port $API_PORT is already in use (pid $(echo "$l" | tr '\n' ' ')). Run: e2e.sh stop"
}

wait_health() {
  local i
  for i in $(seq 1 60); do
    if curl -fsS -m 2 "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# ---- commands ----------------------------------------------------------------------------------------------------
cmd_create() {
  guard_target; server_reachable
  if db_exists; then
    say "database $DB_NAME already exists; verifying that it is the disposable one"
    assert_identity
    return 0
  fi
  psql_admin -c "CREATE DATABASE \"$DB_NAME\" ENCODING 'UTF8'" >/dev/null
  psql_admin -c "COMMENT ON DATABASE \"$DB_NAME\" IS '$DB_MARKER'" >/dev/null
  # The application stores UTC instants in timestamp columns and compares them with now(): the database MUST run in UTC (as Neon does).
  psql_admin -c "ALTER DATABASE \"$DB_NAME\" SET timezone TO 'UTC'" >/dev/null
  say "created database $DB_NAME on $PG_HOST:$PG_PORT"
  assert_identity
}

cmd_migrate() {
  guard_target; server_reachable; assert_identity
  node_run "$ROOT/node_modules/.bin/prisma" migrate deploy 2>&1 | grep -v -E "Update available|major update|major-version|npm i |^[│┌└ ]*$" || true
  node_run "$ROOT/node_modules/.bin/prisma" migrate status 2>&1 | grep -E "migrations found|up to date|not yet been applied|failed" || true
  local pending
  pending="$(psql_e2e -Atc "select count(*) from _prisma_migrations where finished_at is not null")"
  say "migrations applied in $DB_NAME: $pending"
}

cmd_seed() {
  guard_target; server_reachable; assert_identity
  mkdir -p "$RUN_DIR"
  node_run "$ROOT/node_modules/.bin/tsx" "$HERE/seed.ts"
}

cmd_start() {
  guard_target; server_reachable; assert_identity; require_port_free
  say "starting the backend on http://127.0.0.1:${API_PORT} (foreground, Ctrl+C to stop)"
  node_run node --import tsx "$ROOT/src/server.ts"
}

cmd_start_bg() {
  guard_target; server_reachable; assert_identity; require_port_free
  mkdir -p "$RUN_DIR"
  ( cd "$ROOT" && exec env -i \
      PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
      DATABASE_URL="$DATABASE_URL" DOTENV_CONFIG_PATH="/nonexistent/e2e-dotenv-disabled" DOTENV_CONFIG_QUIET="true" \
      NODE_ENV="test" PORT="$API_PORT" HOST="127.0.0.1" FRONTEND_URL="${E2E_FRONTEND_URL:-http://localhost:5173}" \
      COOKIE_SECRET="$COOKIE_SECRET" LOG_LEVEL="${E2E_LOG_LEVEL:-warn}" SOLVER_WORKERS="2" \
      nohup node --import tsx "$ROOT/src/server.ts" >"$RUN_DIR/server.log" 2>&1 & echo $! >"$RUN_DIR/server.pid" )
  if wait_health; then say "backend is up on http://127.0.0.1:${API_PORT} (pid $(cat "$RUN_DIR/server.pid"), log: e2e/dashboard/.run/server.log)"; else
    tail -20 "$RUN_DIR/server.log" >&2 || true; die "the backend did not become healthy within 60s"; fi
}

cmd_stop() {
  guard_target
  local l pid; l="$(listeners)"
  if [ -z "$l" ]; then say "nothing is listening on $API_PORT"; rm -f "$RUN_DIR/server.pid"; return 0; fi
  for pid in $l; do
    is_ours "$pid" || die "pid $pid listens on $API_PORT but is not this repository's backend. Not touching it."
  done
  for pid in $l; do kill -TERM "$pid"; done
  local i
  for i in $(seq 1 40); do [ -z "$(listeners)" ] && break; sleep 0.5; done
  [ -z "$(listeners)" ] || die "the backend did not stop within 20s (pid $l)"
  rm -f "$RUN_DIR/server.pid"
  say "backend on $API_PORT stopped"
}

cmd_exec() {
  [ $# -gt 0 ] || die "usage: e2e.sh exec <command...>"
  guard_target; server_reachable; assert_identity
  ( cd "$ROOT" && exec env -i \
      PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}" \
      DATABASE_URL="$DATABASE_URL" DOTENV_CONFIG_PATH="/nonexistent/e2e-dotenv-disabled" DOTENV_CONFIG_QUIET="true" \
      NODE_ENV="${E2E_NODE_ENV:-test}" PORT="$API_PORT" HOST="127.0.0.1" FRONTEND_URL="${E2E_FRONTEND_URL:-http://localhost:5173}" \
      COOKIE_SECRET="$COOKIE_SECRET" LOG_LEVEL="${E2E_LOG_LEVEL:-warn}" SOLVER_WORKERS="2" BASE_URL="http://127.0.0.1:${API_PORT}" \
      "$@" )
}

cmd_restart() { cmd_stop; cmd_start_bg; }

cmd_session() {
  guard_target; server_reachable; assert_identity
  [ -f "$RUN_DIR/seed-manifest.json" ] || die "no seed manifest: run e2e.sh seed first"
  node_run "$ROOT/node_modules/.bin/tsx" "$HERE/session.ts"
}

cmd_health() {
  guard_target; server_reachable; assert_identity
  local body; body="$(curl -fsS -m 5 "http://127.0.0.1:${API_PORT}/health")" || die "backend is not healthy on port $API_PORT"
  say "backend healthy on port $API_PORT: $body"
}

cmd_verify() {
  guard_target; server_reachable; assert_identity
  curl -fsS -m 5 "http://127.0.0.1:${API_PORT}/health" >/dev/null || die "start the backend first (e2e.sh start-bg)"
  [ -f "$RUN_DIR/seed-manifest.json" ] || die "no seed manifest: run e2e.sh seed first"
  node_run "$ROOT/node_modules/.bin/tsx" "$HERE/verify-api.ts"
}

cmd_status() {
  guard_target; server_reachable
  if db_exists; then say "database $DB_NAME: exists"; assert_identity; else say "database $DB_NAME: does not exist"; fi
  local l; l="$(listeners)"; if [ -n "$l" ]; then say "port $API_PORT: listening (pid $(echo "$l" | tr '\n' ' '))"; else say "port $API_PORT: free"; fi
  [ -f "$RUN_DIR/seed-manifest.json" ] && say "seed manifest: e2e/dashboard/.run/seed-manifest.json" || say "seed manifest: none"
}

terminate_and_drop() {
  assert_identity --no-tz
  psql_admin -Atc "select count(pg_terminate_backend(pid)) from pg_stat_activity where datname = '$DB_NAME' and pid <> pg_backend_pid()" >/dev/null
  psql_admin -c "DROP DATABASE \"$DB_NAME\"" >/dev/null
  say "dropped database $DB_NAME"
}

need_yes() { [ "${1:-}" = "--yes" ] || die "this command is destructive (only for $DB_NAME); repeat it with --yes"; }

cmd_reset() {
  need_yes "${1:-}"; guard_target; server_reachable; require_port_free
  if db_exists; then terminate_and_drop; fi
  rm -f "$RUN_DIR/seed-manifest.json"
  cmd_create; cmd_migrate
  if [ "${2:-}" = "--seed" ]; then cmd_seed; fi
}

cmd_cleanup() {
  need_yes "${1:-}"; guard_target; server_reachable
  [ -z "$(listeners)" ] || cmd_stop
  if db_exists; then terminate_and_drop; else say "database $DB_NAME does not exist"; fi
  rm -rf "$RUN_DIR"
  say "removed e2e/dashboard/.run"
}

main() {
  local cmd="${1:-}"; shift || true
  case "$cmd" in
    create) cmd_create ;;
    migrate) cmd_migrate ;;
    seed) cmd_seed ;;
    all) cmd_create; cmd_migrate; cmd_seed ;;
    start) cmd_start ;;
    start-bg) cmd_start_bg ;;
    stop) cmd_stop ;;
    restart) cmd_restart ;;
    exec) cmd_exec "$@" ;;
    session) cmd_session ;;
    health) cmd_health ;;
    verify) cmd_verify ;;
    status) cmd_status ;;
    reset) cmd_reset "$@" ;;
    cleanup) cmd_cleanup "$@" ;;
    *) sed -n '2,27p' "${BASH_SOURCE[0]}"; [ -z "$cmd" ] || exit 2 ;;
  esac
}
main "$@"
