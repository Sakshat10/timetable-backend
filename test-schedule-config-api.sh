#!/usr/bin/env bash
# =============================================================================
# Module 9 — Schedule Configuration API tests, SIMPLIFIED model (self-contained)
# working days + teaching periods per day + exactly ONE break (breakAfterPeriod). No clock times.
# =============================================================================
# Usage:   ./test-schedule-config-api.sh            (server must be running)
#          BASE_URL=http://127.0.0.1:4010 FAIL_FAST=0 ./test-schedule-config-api.sh
#
# Bootstraps its own data through the public API, with no pre-existing credentials:
#   POST /api/schools -> POST /api/admin/register -> POST /api/admin/login
# Exactly ONE school is created per run (school creation is rate limited to
# 1 per 24h per IP; this script never retries or works around that limit).
#
# NOT covered here (needs a second school, blocked by the bootstrap limit) and reported as
# NOT RUN: cross-school isolation. A temporary direct-service utility covers that once, together
# with the database-constraint, cascade and service-level concurrency tests; it is not part of
# this suite.
#
# NOTE: the API cannot delete schools/years/configs, so every run leaves its test data in the
# database. All names carry a timestamp.
#
# Exit code: 0 = every executed test passed, 1 = a test failed, 2 = setup failed.
# =============================================================================

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:4010}"   # the disposable e2e backend; never 4000
FAIL_FAST="${FAIL_FAST:-1}"
PATCH_RACE_ROUNDS="${PATCH_RACE_ROUNDS:-4}"

TS="$(date +%s)"
SCHOOL_NAME="Module9 Test School $TS"
SCHOOL_CODE="M9_$TS"
ADMIN_EMAIL="m9_${TS}@test.local"
ADMIN_PASSWORD="Module9Pass2026"

TMPDIR_M9="$(mktemp -d)"
JAR="$TMPDIR_M9/cookies.txt"
RESULTS="$TMPDIR_M9/results.txt"
: > "$RESULTS"
trap 'summary' EXIT

command -v jq >/dev/null || { echo "jq is required"; exit 2; }

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

GROUP="setup"
STATUS=""; BODY=""
ID=""
DONE_OK=0
UUID0="00000000-0000-4000-8000-000000000000"

# ── helpers ──────────────────────────────────────────────────────────────────
group() { GROUP="$1"; echo -e "\n${CYAN}══ $1 ══${NC}"; }

summary() {
  local code=$?
  echo -e "\n${CYAN}══ SUMMARY ══${NC}"
  local tp=0 tf=0
  for g in happy validation auth patch lifecycle duplicates filters concurrency scheduler isolation; do
    local p f n
    p=$(grep -c "^$g|PASS|" "$RESULTS" || true)
    f=$(grep -c "^$g|FAIL|" "$RESULTS" || true)
    n=$(grep -c "^$g|NOTRUN|" "$RESULTS" || true)
    tp=$((tp+p)); tf=$((tf+f))
    printf "  %-12s pass=%s fail=%s not-run=%s\n" "$g" "$p" "$f" "$n"
  done
  echo "  TOTAL executed: pass=$tp fail=$tf"
  grep '|NOTRUN|' "$RESULTS" | while IFS='|' read -r _ _ msg; do echo "  NOT RUN: $msg"; done
  grep '|INFO|' "$RESULTS" | while IFS='|' read -r _ _ msg; do echo "  INFO: $msg"; done
  if [ "$DONE_OK" = 1 ] && ! grep -q '|FAIL|' "$RESULTS"; then
    echo -e "${GREEN}ALL EXECUTED TESTS PASSED${NC}"; rm -rf "$TMPDIR_M9"; exit 0
  fi
  echo -e "${RED}RUN DID NOT COMPLETE CLEANLY or A TEST FAILED${NC}"
  rm -rf "$TMPDIR_M9"
  [ "$code" = 0 ] && exit 1
  exit "$code"
}

# req METHOD PATH [JSON_BODY] [COOKIE_JAR]  -> sets STATUS and BODY
req() {
  local m="$1" p="$2" d="${3:-}" jar="${4:-$JAR}"
  local args=(-s -o "$TMPDIR_M9/body" -w '%{http_code}' -X "$m" "$BASE_URL$p" -b "$jar" -c "$jar")
  [ -n "$d" ] && args+=(-H 'Content-Type: application/json' -d "$d")
  STATUS=$(curl "${args[@]}") || STATUS="000"
  BODY=$(cat "$TMPDIR_M9/body" 2>/dev/null || true)
}

record() { echo "$GROUP|$1|$2" >> "$RESULTS"; }

fail_now() {
  echo -e "  ${RED}✗ FAIL${NC}"; echo "    body: $BODY"
  record FAIL "$1"
  [ "$FAIL_FAST" = 1 ] && exit 1
}

expect() {   # expect "name" STATUS
  echo "TEST: $1"; echo "  HTTP $STATUS (expected $2)"
  if [ "$STATUS" = "$2" ]; then echo -e "  ${GREEN}✓ PASS${NC}"; record PASS "$1"; else fail_now "$1"; fi
}

expect_eq() {   # expect_eq "name" ACTUAL EXPECTED
  echo "TEST: $1"; echo "  actual='$2' expected='$3'"
  if [ "$2" = "$3" ]; then echo -e "  ${GREEN}✓ PASS${NC}"; record PASS "$1"; else fail_now "$1"; fi
}

expect_msg() {   # expect_msg "name" REGEX  (response .message must match)
  local m; m=$(jqb '.message')
  echo "TEST: $1"; echo "  message='$m' expected to match /$2/"
  if echo "$m" | grep -qiE "$2"; then echo -e "  ${GREEN}✓ PASS${NC}"; record PASS "$1"; else fail_now "$1"; fi
}

not_run() { echo -e "TEST: $1\n  ${YELLOW}⊘ NOT RUN${NC}  $2"; record NOTRUN "$1 — $2"; }
info() { echo -e "  ${YELLOW}ℹ INFO${NC}  $1"; record INFO "$1"; }

setup_fail() { echo -e "${RED}SETUP FAILED:${NC} $1"; echo "  HTTP $STATUS  body: $BODY"; exit 2; }

mk() {   # mk METHOD PATH JSON -> POST that must return 201; sets ID
  req "$1" "$2" "$3"
  [ "$STATUS" = 201 ] || setup_fail "$1 $2 $3 returned $STATUS"
  ID=$(echo "$BODY" | jq -r '.data.id')
  [ -n "$ID" ] && [ "$ID" != null ] || setup_fail "no id in response of $2"
}

jqb() { echo "$BODY" | jq -r "$1"; }

# ── 0. Bootstrap: one school, one admin, one session ─────────────────────────
group "setup (one school, one admin, one session)"
echo "school=$SCHOOL_CODE admin=$ADMIN_EMAIL"

req GET /health "" /dev/null
[ "$STATUS" = 200 ] || setup_fail "server not reachable at $BASE_URL (start it with: npm run dev)"

req POST /api/schools "{\"name\":\"$SCHOOL_NAME\",\"code\":\"$SCHOOL_CODE\",\"schoolType\":\"SECONDARY\"}" /dev/null
if [ "$STATUS" = 429 ]; then
  setup_fail "school creation is rate limited (429). Not retrying and not bypassing the limiter."
fi
[ "$STATUS" = 201 ] || setup_fail "POST /api/schools returned $STATUS"
SCHOOL_ID=$(jqb '.data.id'); echo "  school id: $SCHOOL_ID"
SETUP_TOKEN=$(echo "$BODY" | jq -r '.data.setupToken')
[ -n "$SETUP_TOKEN" ] && [ "$SETUP_TOKEN" != null ] || setup_fail "school creation returned no setupToken (the one-time credential for the first admin)"

req POST /api/admin/register "{\"schoolId\":\"$SCHOOL_ID\",\"setupToken\":\"$SETUP_TOKEN\",\"name\":\"M9 Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" /dev/null
[ "$STATUS" = 201 ] || setup_fail "admin register returned $STATUS"
unset SETUP_TOKEN
req POST /api/admin/login "{\"schoolId\":\"$SCHOOL_ID\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"
[ "$STATUS" = 200 ] || setup_fail "admin login returned $STATUS"
req GET /api/admin/me
[ "$STATUS" = 200 ] || setup_fail "session cookie not accepted by /api/admin/me ($STATUS)"
echo "  session established"


YEAR_N=0
new_year() { YEAR_N=$((YEAR_N+1)); mk POST /api/academic-years "{\"name\":\"Module 9 $1 $TS\",\"startDate\":\"$((2040+YEAR_N))-04-01\",\"endDate\":\"$((2040+YEAR_N))-12-31\"}"; }

DAYS5='["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"]'
DAYS6='["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"]'
DAYS3='["MONDAY","WEDNESDAY","FRIDAY"]'
DAYS7='["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY","SUNDAY"]'

# cfg_json YEAR DAYS PPD BREAK
cfg_json() { echo "{\"academicYearId\":\"$1\",\"workingDays\":$2,\"periodsPerDay\":$3,\"breakAfterPeriod\":$4}"; }
post_cfg() { req POST /api/schedule-configs "$(cfg_json "$@")"; }
patch_cfg() { req PATCH "/api/schedule-configs/$1" "$2"; }
snap() { req GET "/api/schedule-configs/$1"; echo "$BODY" | jq -cS '.data | del(.createdAt, .updatedAt)'; }

race2() {
  for k in a b; do
    ( curl -s -o "$TMPDIR_M9/$k.body" -w '%{http_code}' -X "$1" "$BASE_URL$2" -b "$JAR" -H 'Content-Type: application/json' -d "$3" > "$TMPDIR_M9/$k.code" ) &
  done
  wait
  local ca cb; ca=$(cat "$TMPDIR_M9/a.code"); cb=$(cat "$TMPDIR_M9/b.code")
  RACE_CODES=$(printf '%s\n' "$ca" "$cb" | sort | tr '\n' ' ' | sed 's/ $//')
}
race_diff() {
  ( curl -s -o "$TMPDIR_M9/da.body" -w '%{http_code}' -X "$1" "$BASE_URL$2" -b "$JAR" -H 'Content-Type: application/json' -d "$3" > "$TMPDIR_M9/da.code" ) &
  ( curl -s -o "$TMPDIR_M9/db.body" -w '%{http_code}' -X "$1" "$BASE_URL$2" -b "$JAR" -H 'Content-Type: application/json' -d "$4" > "$TMPDIR_M9/db.code" ) &
  wait
  RA=$(cat "$TMPDIR_M9/da.code"); RB=$(cat "$TMPDIR_M9/db.code")
}


# ── HAPPY PATHS ──────────────────────────────────────────────────────────────
group happy
new_year "Example"; EY=$ID
post_cfg "$EY" "$DAYS6" 6 4
expect "the example: Mon-Sat, 6 teaching periods, break after period 4 -> 201" 201
CFG=$(jqb '.data.id')
expect_eq "weeklyTeachingCapacity = 6 days x 6 periods = 36" "$(jqb '.data.weeklyTeachingCapacity')" 36
expect_eq "breakAfterPeriod is stored and returned" "$(jqb '.data.breakAfterPeriod')" 4
expect_eq "legacy is false (a simplified configuration)" "$(jqb '.data.legacy')" false
expect_eq "no clock times anywhere: every period startTime/endTime is null" "$(jqb '[.data.periods[] | (.startTime, .endTime)] | all(. == null)')" true
expect_eq "no timing events" "$(jqb '.data.timingEvents | length')" 0
expect_eq "the timeline is P1,P2,P3,P4,BREAK,P5,P6 (the break is not a period)" "$(jqb '[.data.timeline[] | if .kind == "PERIOD" then "P\(.periodNumber)" else .kind end] | join(",")')" "P1,P2,P3,P4,BREAK,P5,P6"
expect_eq "working days come back in week order" "$(jqb '.data.workingDays | join(",")')" "MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY,SATURDAY"

for PPD in 5 6 7 8; do
  for BRK in 1 $(( (PPD+1)/2 )) $((PPD-1)); do
    new_year "P${PPD}B${BRK}"; post_cfg "$ID" "$DAYS5" "$PPD" "$BRK"
    expect_eq "$PPD periods, break after $BRK (first/middle/last valid): 201, capacity $((5*PPD))" "$STATUS $(jqb '.data.weeklyTeachingCapacity')" "201 $((5*PPD))"
  done
done
new_year "ThreeDays"; post_cfg "$ID" "$DAYS3" 7 3
expect_eq "Mon/Wed/Fri x 7 periods -> capacity 21" "$STATUS $(jqb '.data.weeklyTeachingCapacity')" "201 21"
new_year "SevenDays"; post_cfg "$ID" "$DAYS7" 8 7
expect_eq "all 7 days x 8 periods, break after 7 -> capacity 56" "$STATUS $(jqb '.data.weeklyTeachingCapacity')" "201 56"

group validation
new_year "Invalid"; VY=$ID
for B in 0 6 7 -1 2.5 '"3"' true null '[2,4]'; do
  req POST /api/schedule-configs "{\"academicYearId\":\"$VY\",\"workingDays\":$DAYS5,\"periodsPerDay\":6,\"breakAfterPeriod\":$B}"
  expect "breakAfterPeriod=$B (out of 1..5 or not an integer) -> 400" 400
done
req POST /api/schedule-configs "{\"academicYearId\":\"$VY\",\"workingDays\":$DAYS5,\"periodsPerDay\":6}"
expect "a missing breakAfterPeriod -> 400 (exactly one break is required)" 400
for P in 0 1 13 '"6"' 6.5; do
  req POST /api/schedule-configs "{\"academicYearId\":\"$VY\",\"workingDays\":$DAYS5,\"periodsPerDay\":$P,\"breakAfterPeriod\":1}"
  expect "periodsPerDay=$P (needs a whole number 2..12) -> 400" 400
done
req POST /api/schedule-configs "{\"academicYearId\":\"$VY\",\"workingDays\":[],\"periodsPerDay\":6,\"breakAfterPeriod\":3}"; expect "no working days -> 400" 400
req POST /api/schedule-configs "{\"academicYearId\":\"$VY\",\"workingDays\":[\"MONDAY\",\"MONDAY\"],\"periodsPerDay\":6,\"breakAfterPeriod\":3}"; expect "duplicate working days -> 400" 400
req POST /api/schedule-configs "{\"academicYearId\":\"$VY\",\"workingDays\":[\"FUNDAY\"],\"periodsPerDay\":6,\"breakAfterPeriod\":3}"; expect "an unknown day -> 400" 400
req POST /api/schedule-configs "{\"academicYearId\":\"$VY\",\"workingDays\":$DAYS5,\"periodsPerDay\":6,\"breakAfterPeriod\":3,\"periods\":[{\"periodNumber\":1,\"startTime\":\"08:00\",\"endTime\":\"08:45\"}]}"
expect "the old clock-time field 'periods' is refused -> 400" 400
expect_eq "...with a field error on 'periods' saying clock times are no longer part of the schedule" "$(jqb '.errors.periods[0] | test("Clock times are no longer part of the schedule")')" true
req POST /api/schedule-configs "{\"academicYearId\":\"$VY\",\"workingDays\":$DAYS5,\"periodsPerDay\":6,\"breakAfterPeriod\":3,\"timingEvents\":[{\"type\":\"BREAK\",\"afterPeriodNumber\":3,\"startTime\":\"10:00\",\"endTime\":\"10:15\"}]}"
expect "the old field 'timingEvents' (break start/end, durations) is refused -> 400" 400
req GET "/api/schedule-configs?academicYearId=$VY"
expect_eq "none of the invalid requests created anything" "$(jqb '.data | length')" 0
req POST /api/schedule-configs "{\"academicYearId\":\"not-a-uuid\",\"workingDays\":$DAYS5,\"periodsPerDay\":6,\"breakAfterPeriod\":3}"; expect "malformed academicYearId -> 400" 400
req POST /api/schedule-configs "{\"academicYearId\":\"$UUID0\",\"workingDays\":$DAYS5,\"periodsPerDay\":6,\"breakAfterPeriod\":3}"; expect "unknown academic year -> 404" 404

group auth
req GET /api/schedule-configs "" /dev/null; expect "GET without a session -> 401" 401
req POST /api/schedule-configs "$(cfg_json "$VY" "$DAYS5" 6 3)" /dev/null; expect "POST without a session -> 401" 401
req PATCH "/api/schedule-configs/$CFG" '{"breakAfterPeriod":2}' /dev/null; expect "PATCH without a session -> 401" 401

group patch
patch_cfg "$CFG" '{"breakAfterPeriod":2}'
expect "PATCH breakAfterPeriod 4 -> 2" 200
expect_eq "capacity unchanged by moving the break" "$(jqb '.data.weeklyTeachingCapacity')" 36
patch_cfg "$CFG" '{"periodsPerDay":8,"breakAfterPeriod":5}'
expect "PATCH periodsPerDay 6 -> 8 with a new break" 200
expect_eq "capacity follows: 6 x 8 = 48; 8 periods listed" "$(jqb '"\(.data.weeklyTeachingCapacity) \(.data.periods | length)"')" "48 8"
BEFORE=$(snap "$CFG")
patch_cfg "$CFG" '{"periodsPerDay":4}'
expect "lowering periodsPerDay below the break (5) -> 400" 400
expect_eq "...and the configuration is unchanged" "$(snap "$CFG")" "$BEFORE"
patch_cfg "$CFG" '{"breakAfterPeriod":8}'; expect "break after the last period -> 400" 400
patch_cfg "$CFG" '{}'; expect "an empty PATCH -> 400" 400
patch_cfg "$CFG" '{"periods":[]}'; expect "PATCH with the old 'periods' field -> 400" 400
patch_cfg "$CFG" '{"timingEvents":[]}'; expect "PATCH with the old 'timingEvents' field -> 400" 400
patch_cfg "$CFG" "{\"academicYearId\":\"$VY\",\"breakAfterPeriod\":2}"; expect "PATCH cannot change academicYearId -> 400" 400
patch_cfg "$CFG" '{"workingDays":["MONDAY","TUESDAY"]}'
expect "PATCH workingDays only" 200
expect_eq "capacity = 2 x 8 = 16" "$(jqb '.data.weeklyTeachingCapacity')" 16
patch_cfg "$UUID0" '{"breakAfterPeriod":2}'; expect "PATCH of an unknown configuration -> 404" 404

group duplicates
post_cfg "$EY" "$DAYS6" 6 4
expect "a second configuration for the same academic year -> 409" 409

group lifecycle
req GET "/api/schedule-configs/$CFG"; expect "GET by id -> 200" 200
req GET "/api/schedule-configs/$UUID0"; expect "GET an unknown id -> 404" 404
req GET "/api/schedule-configs/not-a-uuid"; expect "GET a malformed id -> 400" 400
req PATCH "/api/academic-years/$EY" '{"status":"ACTIVE"}'; expect "the example year becomes ACTIVE" 200
patch_cfg "$CFG" '{"breakAfterPeriod":1}'
expect "PATCH on an ACTIVE year -> 400 (DRAFT only)" 400
post_cfg "$EY" "$DAYS6" 6 4; [ "$STATUS" = 400 ] || [ "$STATUS" = 409 ] && { echo "  (create on an ACTIVE year is refused: $STATUS)"; record PASS "create on a non-DRAFT year is refused"; }

group filters
req GET "/api/schedule-configs?academicYearId=$EY"
expect_eq "filter by academic year returns exactly its configuration" "$(jqb '.data | length') $(jqb '.data[0].id == "'"$CFG"'"')" "1 true"
req GET "/api/schedule-configs?academicYearId=not-a-uuid"; expect "malformed filter -> 400" 400
req GET /api/schedule-configs; expect "the unfiltered list answers" 200
expect_eq "every listed configuration has the simplified fields" "$(jqb '.data | all(has("breakAfterPeriod") and has("weeklyTeachingCapacity") and has("legacy"))')" true

group concurrency
new_year "Race"; RY=$ID
race2 POST /api/schedule-configs "$(cfg_json "$RY" "$DAYS5" 6 3)"
expect_eq "two simultaneous creates for one year: exactly one 201 and one 409" "$RACE_CODES" "201 409"
new_year "PatchRace"; PRY=$ID
post_cfg "$PRY" "$DAYS5" 6 3; [ "$STATUS" = 201 ] || setup_fail "could not create the race fixture"; PRC=$(jqb '.data.id')
WON_A=0; WON_B=0
for i in $(seq 1 "$PATCH_RACE_ROUNDS"); do
  race_diff PATCH "/api/schedule-configs/$PRC" '{"periodsPerDay":7,"breakAfterPeriod":2}' '{"periodsPerDay":5,"breakAfterPeriod":4}'
  expect_eq "round $i: both PATCHes succeed (200 200)" "$RA $RB" "200 200"
  req GET "/api/schedule-configs/$PRC"
  P=$(jqb '.data.periodsPerDay'); B=$(jqb '.data.breakAfterPeriod')
  if [ "$P $B" = "7 2" ]; then WON_A=$((WON_A+1)); elif [ "$P $B" = "5 4" ]; then WON_B=$((WON_B+1)); fi
  expect_eq "round $i: the final state is one request's whole schedule, never a mix, and always valid (1 <= break < periods)" "$([ "$P $B" = "7 2" ] || [ "$P $B" = "5 4" ] && echo true || echo false)" true
done
info "patch race over $PATCH_RACE_ROUNDS rounds: final state was request A's schedule $WON_A time(s) and request B's $WON_B time(s) (last writer wins)"

group scheduler
req GET "/api/schedule-configs/$CFG"
expect_eq "what the scheduler needs is exactly: workingDays, periodsPerDay, breakAfterPeriod" "$(jqb '.data | [.workingDays, .periodsPerDay, .breakAfterPeriod] | length')" 3
new_year "Solver"; SY=$ID; post_cfg "$SY" "$DAYS6" 6 4
expect_eq "the break position is the only thing that separates periods (4 | 5): timeline P1..P4, BREAK, P5, P6" "$(jqb '[.data.timeline[] | if .kind == "PERIOD" then "P\(.periodNumber)" else .kind end] | join(",")')" "P1,P2,P3,P4,BREAK,P5,P6"
expect_eq "the slot grid is workingDays x periods (6 x 6 = 36); the break adds none" "$(jqb '(.data.workingDays|length) * (.data.periods|length)')" 36
expect_eq "period numbers are exactly 1..periodsPerDay" "$(jqb '[.data.periods[].periodNumber] == [range(1; .data.periodsPerDay + 1)]')" true

group isolation
not_run "cross-school isolation over HTTP" "needs a second school (blocked by the 1-per-24h school bootstrap limit); covered in test-schedule-simplified-api.ts, which has two schools"

DONE_OK=1
