#!/usr/bin/env bash
# =============================================================================
# Module 5 — Stream + Section API tests (self-contained)
# =============================================================================
# Usage:   ./test-stream-section-api.sh            (server must be running)
#          BASE_URL=http://localhost:4000 FAIL_FAST=0 ./test-stream-section-api.sh
#
# Bootstraps its own data through the public API, with no pre-existing credentials:
#   POST /api/schools -> POST /api/admin/register -> POST /api/admin/login
# Exactly ONE school is created per run (school creation is rate limited to
# 1 per 24h per IP; this script never retries or works around that limit).
#
# NOTE: the API has no DELETE endpoints, so every run leaves its test data in
# the database. All names/codes carry a timestamp so runs never collide.
#
# Exit code: 0 = every executed test passed, 1 = a test failed, 2 = setup failed.
# =============================================================================

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000}"
FAIL_FAST="${FAIL_FAST:-1}"
RACE_ROUNDS="${RACE_ROUNDS:-12}"

TS="$(date +%s)"
SCHOOL_NAME="Module5 Test School $TS"
SCHOOL_CODE="M5_$TS"
ADMIN_EMAIL="m5_${TS}@test.local"
ADMIN_PASSWORD="Module5Pass2026"

TMPDIR_M5="$(mktemp -d)"
JAR="$TMPDIR_M5/cookies.txt"
RESULTS="$TMPDIR_M5/results.txt"
: > "$RESULTS"
trap 'summary' EXIT

command -v jq >/dev/null || { echo "jq is required"; exit 2; }

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

GROUP="setup"
STATUS=""; BODY=""
ID=""            # last id captured by mk()
DONE_OK=0

# ── helpers ──────────────────────────────────────────────────────────────────
group() { GROUP="$1"; echo -e "\n${CYAN}══ $1 ══${NC}"; }

summary() {
  local code=$?
  echo -e "\n${CYAN}══ SUMMARY ══${NC}"
  for g in stream section mixing concurrency uniqueness isolation; do
    local p f n
    p=$(grep -c "^$g|PASS|" "$RESULTS" || true)
    f=$(grep -c "^$g|FAIL|" "$RESULTS" || true)
    n=$(grep -c "^$g|NOTRUN|" "$RESULTS" || true)
    printf "  %-12s pass=%s fail=%s not-run=%s\n" "$g" "$p" "$f" "$n"
  done
  grep '^[a-z]*|NOTRUN|' "$RESULTS" | while IFS='|' read -r _ _ msg; do echo "  NOT RUN: $msg"; done
  if [ "$DONE_OK" = 1 ] && ! grep -q '|FAIL|' "$RESULTS"; then
    echo -e "${GREEN}ALL EXECUTED TESTS PASSED${NC}"; rm -rf "$TMPDIR_M5"; exit 0
  fi
  echo -e "${RED}RUN DID NOT COMPLETE CLEANLY or A TEST FAILED${NC}"
  rm -rf "$TMPDIR_M5"
  [ "$code" = 0 ] && exit 1
  exit "$code"
}

# req METHOD PATH [JSON_BODY] [COOKIE_JAR]  -> sets STATUS and BODY
req() {
  local m="$1" p="$2" d="${3:-}" jar="${4:-$JAR}"
  local args=(-s -o "$TMPDIR_M5/body" -w '%{http_code}' -X "$m" "$BASE_URL$p" -b "$jar" -c "$jar")
  [ -n "$d" ] && args+=(-H 'Content-Type: application/json' -d "$d")
  STATUS=$(curl "${args[@]}") || STATUS="000"
  BODY=$(cat "$TMPDIR_M5/body" 2>/dev/null || true)
}

record() { echo "$GROUP|$1|$2" >> "$RESULTS"; }

fail_now() {
  echo -e "  ${RED}✗ FAIL${NC}"; echo "    body: $BODY"
  record FAIL "$1"
  [ "$FAIL_FAST" = 1 ] && exit 1
}

# expect "name" STATUS   (uses last STATUS)
expect() {
  echo "TEST: $1"; echo "  HTTP $STATUS (expected $2)"
  if [ "$STATUS" = "$2" ]; then echo -e "  ${GREEN}✓ PASS${NC}"; record PASS "$1"; else fail_now "$1"; fi
}

# expect_eq "name" ACTUAL EXPECTED
expect_eq() {
  echo "TEST: $1"; echo "  actual='$2' expected='$3'"
  if [ "$2" = "$3" ]; then echo -e "  ${GREEN}✓ PASS${NC}"; record PASS "$1"; else fail_now "$1"; fi
}

# expect_4xx "name"  (last STATUS must be 4xx)
expect_4xx() {
  echo "TEST: $1"; echo "  HTTP $STATUS (expected 4xx)"
  case "$STATUS" in 4??) echo -e "  ${GREEN}✓ PASS${NC}"; record PASS "$1";; *) fail_now "$1";; esac
}

not_run() { echo -e "TEST: $1\n  ${YELLOW}⊘ NOT RUN${NC}  $2"; record NOTRUN "$1 — $2"; }

# setup_fail "message": setup problems abort with exit 2 (nothing was tested)
setup_fail() { echo -e "${RED}SETUP FAILED:${NC} $1"; echo "  HTTP $STATUS  body: $BODY"; exit 2; }

# mk METHOD PATH JSON  -> POST that must return 201; sets ID
mk() {
  req "$1" "$2" "$3"
  [ "$STATUS" = 201 ] || setup_fail "$1 $2 $3 returned $STATUS"
  ID=$(echo "$BODY" | jq -r '.data.id')
  [ -n "$ID" ] && [ "$ID" != null ] || setup_fail "no id in response of $2"
}

GRADE_ORDER=0
# mk_grade YEAR_ID NAME -> sets ID (auto displayOrder)
mk_grade() { GRADE_ORDER=$((GRADE_ORDER+1)); mk POST /api/grades "{\"academicYearId\":\"$1\",\"name\":\"$2\",\"displayOrder\":$GRADE_ORDER}"; }

# sections_of GRADE_ID -> prints "streamed non_streamed" counts
section_counts() {
  req GET "/api/grades/$1/sections"
  echo "$BODY" | jq -r '[ ([.data[]|select(.streamId!=null)]|length), ([.data[]|select(.streamId==null)]|length) ] | "\(.[0]) \(.[1])"'
}

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
SCHOOL_ID=$(echo "$BODY" | jq -r '.data.id'); echo "  school id: $SCHOOL_ID"
SETUP_TOKEN=$(echo "$BODY" | jq -r '.data.setupToken')
[ -n "$SETUP_TOKEN" ] && [ "$SETUP_TOKEN" != null ] || setup_fail "school creation returned no setupToken (the one-time credential for the first admin)"

req POST /api/admin/register "{\"schoolId\":\"$SCHOOL_ID\",\"setupToken\":\"$SETUP_TOKEN\",\"name\":\"M5 Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" /dev/null
[ "$STATUS" = 201 ] || setup_fail "admin register returned $STATUS"
unset SETUP_TOKEN

req POST /api/admin/login "{\"schoolId\":\"$SCHOOL_ID\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"
[ "$STATUS" = 200 ] || setup_fail "admin login returned $STATUS"
req GET /api/admin/me
[ "$STATUS" = 200 ] || setup_fail "session cookie not accepted by /api/admin/me ($STATUS)"
echo "  session established"

# ── fixtures ─────────────────────────────────────────────────────────────────
mk POST /api/academic-years "{\"name\":\"Module 5 Test Year $TS\",\"startDate\":\"2030-04-01\",\"endDate\":\"2031-03-31\"}"; AY=$ID
mk_grade "$AY" "Grade 6";  G6=$ID     # non-streamed
mk_grade "$AY" "Grade 11"; G11=$ID    # streamed

# ── STREAM TESTS ─────────────────────────────────────────────────────────────
group stream
GROUP=stream

req POST /api/streams "{\"gradeId\":\"$G11\",\"name\":\"Science\",\"code\":\"SCI\"}"
expect "POST /api/streams (Science/SCI)" 201; SCI=$(echo "$BODY" | jq -r '.data.id')
req POST /api/streams "{\"gradeId\":\"$G11\",\"name\":\"Commerce\",\"code\":\"COM\"}"
expect "POST /api/streams (Commerce/COM)" 201; COM=$(echo "$BODY" | jq -r '.data.id')

req GET "/api/grades/$G11/streams"
expect "GET /api/grades/:gradeId/streams" 200
expect_eq "  lists both streams" "$(echo "$BODY" | jq -r '.data|length')" 2

req GET "/api/streams/$SCI"
expect "GET /api/streams/:id" 200
expect_eq "  returns SCI" "$(echo "$BODY" | jq -r '.data.code')" SCI

req PATCH "/api/streams/$COM" '{"name":"Commerce & Business"}'
expect "PATCH /api/streams/:id (rename)" 200
expect_eq "  name updated" "$(echo "$BODY" | jq -r '.data.name')" "Commerce & Business"

req POST /api/streams "{\"gradeId\":\"$G11\",\"name\":\"Another Science\",\"code\":\"SCI\"}"
expect "duplicate stream code -> 409" 409
req POST /api/streams "{\"gradeId\":\"$G11\",\"name\":\"science\",\"code\":\"SCI2\"}"
expect "duplicate stream name (case-insensitive) -> 409" 409
req POST /api/streams "{\"gradeId\":\"$G11\",\"name\":\"Another Science\",\"code\":\"sci\"}"
expect "duplicate code via lowercase 'sci' -> 409 (normalised)" 409

req POST /api/streams "{\"gradeId\":\"$G11\",\"name\":\"Arts\",\"code\":\"arts\"}"
expect "lowercase code accepted" 201
expect_eq "  code normalised to uppercase" "$(echo "$BODY" | jq -r '.data.code')" ARTS

req POST /api/streams '{"gradeId":"00000000-0000-4000-8000-000000000000","name":"X","code":"X"}'
expect "unknown grade id -> 404" 404
req POST /api/streams '{"gradeId":"not-a-uuid","name":"X","code":"X"}'
expect_4xx "malformed grade id -> 4xx"
req GET /api/streams/00000000-0000-4000-8000-000000000000
expect "unknown stream id -> 404" 404
req GET "/api/streams/$SCI" "" /dev/null
expect "stream read without session -> 401" 401

GROUP=isolation
not_run "school isolation (streams + sections accessed by another school's admin)" \
  "School isolation test could not be executed because creating another school is blocked by the existing bootstrap rate limit."
GROUP=stream

# ACTIVE / COMPLETED academic years: build structure in DRAFT, then lock it
lock_year_tests() {  # lock_year_tests LABEL TARGET_STATUS...
  local label="$1"; shift
  mk POST /api/academic-years "{\"name\":\"Module 5 $label Year $TS\",\"startDate\":\"203${#label}-04-01\",\"endDate\":\"203${#label}-12-31\"}"; local Y=$ID
  mk_grade "$Y" "Locked Grade"; local LG=$ID
  mk POST /api/streams "{\"gradeId\":\"$LG\",\"name\":\"S\",\"code\":\"S\"}"; local LS=$ID
  mk POST /api/sections "{\"gradeId\":\"$LG\",\"streamId\":\"$LS\",\"name\":\"Sec\",\"code\":\"A\"}"; local LSEC=$ID
  for st in "$@"; do
    req PATCH "/api/academic-years/$Y" "{\"status\":\"$st\"}"
    [ "$STATUS" = 200 ] || setup_fail "could not move year to $st"
  done
  LOCK_STREAM="$LS"; LOCK_GRADE="$LG"; LOCK_SECTION="$LSEC"
}

lock_year_tests ACTIVE ACTIVE
req POST /api/streams "{\"gradeId\":\"$LOCK_GRADE\",\"name\":\"New\",\"code\":\"N\"}"
expect "POST stream in ACTIVE year -> 400" 400
req PATCH "/api/streams/$LOCK_STREAM" '{"name":"Renamed"}'
expect "PATCH stream in ACTIVE year -> 400" 400
GROUP=section
req POST /api/sections "{\"gradeId\":\"$LOCK_GRADE\",\"streamId\":\"$LOCK_STREAM\",\"name\":\"New\",\"code\":\"B\"}"
expect "POST section in ACTIVE year -> 400" 400
req PATCH "/api/sections/$LOCK_SECTION" '{"name":"Renamed"}'
expect "PATCH section in ACTIVE year -> 400" 400

GROUP=stream
lock_year_tests COMPLETED ACTIVE COMPLETED
req POST /api/streams "{\"gradeId\":\"$LOCK_GRADE\",\"name\":\"New\",\"code\":\"N\"}"
expect "POST stream in COMPLETED year -> 400" 400
req PATCH "/api/streams/$LOCK_STREAM" '{"name":"Renamed"}'
expect "PATCH stream in COMPLETED year -> 400" 400
GROUP=section
req POST /api/sections "{\"gradeId\":\"$LOCK_GRADE\",\"streamId\":\"$LOCK_STREAM\",\"name\":\"New\",\"code\":\"B\"}"
expect "POST section in COMPLETED year -> 400" 400
req PATCH "/api/sections/$LOCK_SECTION" '{"name":"Renamed"}'
expect "PATCH section in COMPLETED year -> 400" 400

# ── SECTION TESTS ────────────────────────────────────────────────────────────
group section
GROUP=section

req POST /api/sections "{\"gradeId\":\"$G6\",\"name\":\"Section A\",\"code\":\"A\"}"
expect "Grade 6 / Section A" 201; SEC_6A=$(echo "$BODY" | jq -r '.data.id')
req POST /api/sections "{\"gradeId\":\"$G6\",\"name\":\"Section B\",\"code\":\"B\"}"
expect "Grade 6 / Section B" 201
req POST /api/sections "{\"gradeId\":\"$G6\",\"name\":\"Section A again\",\"code\":\"A\"}"
expect "Grade 6 / Section A again -> 409" 409

req POST /api/sections "{\"gradeId\":\"$G11\",\"streamId\":\"$SCI\",\"name\":\"Science A\",\"code\":\"A\"}"
expect "Grade 11 / Science / A" 201; SEC_SCI_A=$(echo "$BODY" | jq -r '.data.id')
req POST /api/sections "{\"gradeId\":\"$G11\",\"streamId\":\"$COM\",\"name\":\"Commerce A\",\"code\":\"A\"}"
expect "Grade 11 / Commerce / A (same code, different stream) MUST succeed" 201
GROUP=uniqueness
record PASS "same section code across different streams succeeds"
GROUP=section
req POST /api/sections "{\"gradeId\":\"$G11\",\"streamId\":\"$SCI\",\"name\":\"Science A again\",\"code\":\"A\"}"
expect "Grade 11 / Science / A again -> 409" 409

req GET "/api/grades/$G11/sections"
expect "GET /api/grades/:gradeId/sections" 200
expect_eq "  two sections in Grade 11" "$(echo "$BODY" | jq -r '.data|length')" 2
expect_eq "  each includes its stream" "$(echo "$BODY" | jq -r '[.data[]|select(.stream!=null)]|length')" 2

req GET "/api/sections/$SEC_SCI_A"
expect "GET /api/sections/:id" 200
expect_eq "  stream code in response" "$(echo "$BODY" | jq -r '.data.stream.code')" SCI

req PATCH "/api/sections/$SEC_SCI_A" '{"name":"Science Alpha"}'
expect "PATCH /api/sections/:id (name)" 200
expect_eq "  name updated" "$(echo "$BODY" | jq -r '.data.name')" "Science Alpha"
req PATCH "/api/sections/$SEC_6A" '{"code":"B"}'
expect "PATCH section code to an existing code -> 409" 409

req POST /api/sections "{\"gradeId\":\"$G6\",\"streamId\":\"$SCI\",\"name\":\"Wrong\",\"code\":\"Z\"}"
expect "stream from a different grade -> 400" 400
req POST /api/sections "{\"gradeId\":\"$G11\",\"streamId\":\"00000000-0000-4000-8000-000000000000\",\"name\":\"Wrong\",\"code\":\"Z\"}"
expect "unknown stream id -> 404" 404
req POST /api/sections "{\"gradeId\":\"00000000-0000-4000-8000-000000000000\",\"name\":\"Wrong\",\"code\":\"Z\"}"
expect "unknown grade id -> 404" 404
req GET "/api/sections/$SEC_SCI_A" "" /dev/null
expect "section read without session -> 401" 401

# ── MIXED MODE ───────────────────────────────────────────────────────────────
group mixing
GROUP=mixing

mk_grade "$AY" "Grade X"; GX=$ID
mk POST /api/streams "{\"gradeId\":\"$GX\",\"name\":\"Stream X\",\"code\":\"SX\"}"; SX=$ID
req POST /api/sections "{\"gradeId\":\"$GX\",\"name\":\"X-A\",\"code\":\"A\"}"
expect "Grade X: non-streamed / A" 201
req POST /api/sections "{\"gradeId\":\"$GX\",\"streamId\":\"$SX\",\"name\":\"X-B\",\"code\":\"B\"}"
expect "Grade X: streamed / B after non-streamed -> 400" 400

mk_grade "$AY" "Grade Y"; GY=$ID
mk POST /api/streams "{\"gradeId\":\"$GY\",\"name\":\"Stream Y\",\"code\":\"SY\"}"; SY=$ID
req POST /api/sections "{\"gradeId\":\"$GY\",\"streamId\":\"$SY\",\"name\":\"Y-A\",\"code\":\"A\"}"
expect "Grade Y: streamed / A" 201
req POST /api/sections "{\"gradeId\":\"$GY\",\"name\":\"Y-B\",\"code\":\"B\"}"
expect "Grade Y: non-streamed / B after streamed -> 400" 400

# ── DATABASE UNIQUENESS UNDER CONCURRENCY ────────────────────────────────────
group uniqueness
GROUP=uniqueness

# race_post JSON_A JSON_B -> sets RA RB (status codes of two simultaneous POST /api/sections)
race_post() {
  curl -s -o "$TMPDIR_M5/ra.body" -w '%{http_code}' -X POST "$BASE_URL/api/sections" -b "$JAR" \
    -H 'Content-Type: application/json' -d "$1" > "$TMPDIR_M5/ra.code" &
  curl -s -o "$TMPDIR_M5/rb.body" -w '%{http_code}' -X POST "$BASE_URL/api/sections" -b "$JAR" \
    -H 'Content-Type: application/json' -d "$2" > "$TMPDIR_M5/rb.code" &
  wait
  RA=$(cat "$TMPDIR_M5/ra.code"); RB=$(cat "$TMPDIR_M5/rb.code")
}

# non-streamed duplicate code, simultaneously
mk_grade "$AY" "Race NS dup"; GR=$ID
race_post "{\"gradeId\":\"$GR\",\"name\":\"one\",\"code\":\"A\"}" "{\"gradeId\":\"$GR\",\"name\":\"two\",\"code\":\"A\"}"
echo "TEST: concurrent duplicate non-streamed code -> exactly one 201, one 409"
echo "  statuses: $RA $RB"
read -r _ NS_ROWS <<<"$(section_counts "$GR")"
STATUS="$(printf '%s\n' "$RA" "$RB" | sort | tr '\n' ' ' | sed 's/ $//')"
expect_eq "concurrent duplicate non-streamed code" "$STATUS" "201 409"
expect_eq "  exactly one row persisted" "$NS_ROWS" 1

# streamed duplicate code, simultaneously
mk_grade "$AY" "Race S dup"; GR=$ID
mk POST /api/streams "{\"gradeId\":\"$GR\",\"name\":\"RS\",\"code\":\"RS\"}"; RS=$ID
race_post "{\"gradeId\":\"$GR\",\"streamId\":\"$RS\",\"name\":\"one\",\"code\":\"A\"}" "{\"gradeId\":\"$GR\",\"streamId\":\"$RS\",\"name\":\"two\",\"code\":\"A\"}"
echo "  statuses: $RA $RB"
STATUS="$(printf '%s\n' "$RA" "$RB" | sort | tr '\n' ' ' | sed 's/ $//')"
read -r S_ROWS _ <<<"$(section_counts "$GR")"
expect_eq "concurrent duplicate streamed code" "$STATUS" "201 409"
expect_eq "  exactly one row persisted" "$S_ROWS" 1

# ── MIXING CONCURRENCY ───────────────────────────────────────────────────────
group concurrency
GROUP=concurrency

VIOLATIONS=0
echo "Racing a streamed vs a non-streamed section on $RACE_ROUNDS fresh grades..."
for i in $(seq 1 "$RACE_ROUNDS"); do
  mk_grade "$AY" "Race mix $i"; GR=$ID
  mk POST /api/streams "{\"gradeId\":\"$GR\",\"name\":\"RM\",\"code\":\"RM\"}"; RM=$ID
  race_post "{\"gradeId\":\"$GR\",\"streamId\":\"$RM\",\"name\":\"streamed\",\"code\":\"A\"}" "{\"gradeId\":\"$GR\",\"name\":\"plain\",\"code\":\"B\"}"
  read -r S N <<<"$(section_counts "$GR")"
  verdict="ok"; if [ "$S" -gt 0 ] && [ "$N" -gt 0 ]; then verdict="MIXED"; VIOLATIONS=$((VIOLATIONS+1)); fi
  echo "  round $i: streamed=$RA non-streamed=$RB -> rows streamed=$S non-streamed=$N [$verdict]"
done
STATUS="-"
expect_eq "no grade ended with both streamed and non-streamed sections ($RACE_ROUNDS rounds)" "$VIOLATIONS" 0

DONE_OK=1
