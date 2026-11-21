#!/usr/bin/env bash
# =============================================================================
# Module 6 — Subjects + Teacher configuration API tests (self-contained)
# =============================================================================
# Usage:   ./test-subject-teacher-api.sh            (server must be running)
#          BASE_URL=http://localhost:4000 FAIL_FAST=0 ./test-subject-teacher-api.sh
#
# Bootstraps its own data through the public API, with no pre-existing credentials:
#   POST /api/schools -> POST /api/admin/register -> POST /api/admin/login
# Exactly ONE school is created per run (school creation is rate limited to
# 1 per 24h per IP; this script never retries or works around that limit).
#
# Cross-school isolation CANNOT be tested through the API within that limit, so
# it is reported as NOT RUN here. It was verified once (25/25) with a temporary
# direct-service utility that seeded two schools through Prisma; that utility was
# deleted and is not part of this suite.
#
# NOTE: the API has no DELETE for schools/years/subjects/teachers, so every run
# leaves its test data in the database. All names/codes carry a timestamp.
#
# Exit code: 0 = every executed test passed, 1 = a test failed, 2 = setup failed.
# =============================================================================

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000}"
FAIL_FAST="${FAIL_FAST:-1}"

TS="$(date +%s)"
SCHOOL_NAME="Module6 Test School $TS"
SCHOOL_CODE="M6_$TS"
ADMIN_EMAIL="m6_${TS}@test.local"
ADMIN_PASSWORD="Module6Pass2026"

TMPDIR_M6="$(mktemp -d)"
JAR="$TMPDIR_M6/cookies.txt"
RESULTS="$TMPDIR_M6/results.txt"
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
  for g in subject teacher teacher-subject eligibility concurrency isolation; do
    local p f n
    p=$(grep -c "^$g|PASS|" "$RESULTS" || true)
    f=$(grep -c "^$g|FAIL|" "$RESULTS" || true)
    n=$(grep -c "^$g|NOTRUN|" "$RESULTS" || true)
    tp=$((tp+p)); tf=$((tf+f))
    printf "  %-16s pass=%s fail=%s not-run=%s\n" "$g" "$p" "$f" "$n"
  done
  echo "  TOTAL executed: pass=$tp fail=$tf"
  grep '|NOTRUN|' "$RESULTS" | while IFS='|' read -r _ _ msg; do echo "  NOT RUN: $msg"; done
  if [ "$DONE_OK" = 1 ] && ! grep -q '|FAIL|' "$RESULTS"; then
    echo -e "${GREEN}ALL EXECUTED TESTS PASSED${NC}"; rm -rf "$TMPDIR_M6"; exit 0
  fi
  echo -e "${RED}RUN DID NOT COMPLETE CLEANLY or A TEST FAILED${NC}"
  rm -rf "$TMPDIR_M6"
  [ "$code" = 0 ] && exit 1
  exit "$code"
}

# req METHOD PATH [JSON_BODY] [COOKIE_JAR]  -> sets STATUS and BODY
req() {
  local m="$1" p="$2" d="${3:-}" jar="${4:-$JAR}"
  local args=(-s -o "$TMPDIR_M6/body" -w '%{http_code}' -X "$m" "$BASE_URL$p" -b "$jar" -c "$jar")
  [ -n "$d" ] && args+=(-H 'Content-Type: application/json' -d "$d")
  STATUS=$(curl "${args[@]}") || STATUS="000"
  BODY=$(cat "$TMPDIR_M6/body" 2>/dev/null || true)
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

setup_fail() { echo -e "${RED}SETUP FAILED:${NC} $1"; echo "  HTTP $STATUS  body: $BODY"; exit 2; }

# mk METHOD PATH JSON -> POST that must return 201; sets ID
mk() {
  req "$1" "$2" "$3"
  [ "$STATUS" = 201 ] || setup_fail "$1 $2 $3 returned $STATUS"
  ID=$(echo "$BODY" | jq -r '.data.id')
  [ -n "$ID" ] && [ "$ID" != null ] || setup_fail "no id in response of $2"
}

jqb() { echo "$BODY" | jq -r "$1"; }

GRADE_ORDER=0
mk_grade() { GRADE_ORDER=$((GRADE_ORDER+1)); mk POST /api/grades "{\"academicYearId\":\"$1\",\"name\":\"$2\",\"displayOrder\":$GRADE_ORDER}"; }

YEAR_N=0
mk_year() {  # mk_year LABEL -> sets ID (DRAFT year with a unique date range)
  YEAR_N=$((YEAR_N+1))
  mk POST /api/academic-years "{\"name\":\"Module 6 $1 $TS\",\"startDate\":\"$((2040+YEAR_N))-04-01\",\"endDate\":\"$((2040+YEAR_N))-12-31\"}"
}

# race2 METHOD PATH JSON -> two identical simultaneous requests; sets RACE_CODES ("201 409") and LOSER_MSG
race2() {
  for k in a b; do
    ( curl -s -o "$TMPDIR_M6/$k.body" -w '%{http_code}' -X "$1" "$BASE_URL$2" -b "$JAR" \
        -H 'Content-Type: application/json' -d "$3" > "$TMPDIR_M6/$k.code" ) &
  done
  wait
  local ca cb; ca=$(cat "$TMPDIR_M6/a.code"); cb=$(cat "$TMPDIR_M6/b.code")
  RACE_CODES=$(printf '%s\n' "$ca" "$cb" | sort | tr '\n' ' ' | sed 's/ $//')
  if [ "$ca" = 409 ]; then LOSER_MSG=$(jq -r '.message' "$TMPDIR_M6/a.body"); else LOSER_MSG=$(jq -r '.message' "$TMPDIR_M6/b.body"); fi
  echo "  race statuses: $ca $cb   loser message: $LOSER_MSG"
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
SCHOOL_ID=$(jqb '.data.id'); echo "  school id: $SCHOOL_ID"
SETUP_TOKEN=$(echo "$BODY" | jq -r '.data.setupToken')
[ -n "$SETUP_TOKEN" ] && [ "$SETUP_TOKEN" != null ] || setup_fail "school creation returned no setupToken (the one-time credential for the first admin)"

req POST /api/admin/register "{\"schoolId\":\"$SCHOOL_ID\",\"setupToken\":\"$SETUP_TOKEN\",\"name\":\"M6 Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" /dev/null
[ "$STATUS" = 201 ] || setup_fail "admin register returned $STATUS"
unset SETUP_TOKEN
req POST /api/admin/login "{\"schoolId\":\"$SCHOOL_ID\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"
[ "$STATUS" = 200 ] || setup_fail "admin login returned $STATUS"
req GET /api/admin/me
[ "$STATUS" = 200 ] || setup_fail "session cookie not accepted by /api/admin/me ($STATUS)"
echo "  session established"

# ── fixtures: a DRAFT year with two grades ───────────────────────────────────
mk_year "Draft"; AY=$ID
mk_grade "$AY" "Grade 6"; G6=$ID
mk_grade "$AY" "Grade 7"; G7=$ID

# ── SUBJECT TESTS ────────────────────────────────────────────────────────────
group subject

req POST /api/subjects '{"name":"  Mathematics  ","code":"math"}'
expect "POST /api/subjects (lowercase code, padded name)" 201
MATH=$(jqb '.data.id')
expect_eq "  code normalised to uppercase" "$(jqb '.data.code')" MATH
expect_eq "  name trimmed" "$(jqb '.data.name')" "Mathematics"
expect_eq "  schoolId comes from the session" "$(jqb '.data.schoolId')" "$SCHOOL_ID"

req POST /api/subjects '{"name":"English","code":"ENG"}'
expect "POST /api/subjects (ENG)" 201; ENG=$(jqb '.data.id')
req POST /api/subjects '{"name":"Science","code":"Sci_1"}'
expect "POST /api/subjects (mixed-case code with underscore/digit)" 201; SCI=$(jqb '.data.id')
expect_eq "  code normalised" "$(jqb '.data.code')" SCI_1

req POST /api/subjects '{"name":"Maths again","code":"Math"}'
expect "duplicate code (case-insensitive) -> 409" 409
req POST /api/subjects '{"name":"Mathematics","code":"MATH-B"}'
expect "same display name, different code -> 201 (names are not unique)" 201

req GET /api/subjects
expect "GET /api/subjects" 200
expect_eq "  lists 4 subjects of this school" "$(jqb '.data|length')" 4

req GET "/api/subjects/$MATH"
expect "GET /api/subjects/:id" 200
expect_eq "  returns MATH" "$(jqb '.data.code')" MATH

req PATCH "/api/subjects/$ENG" '{"name":"English Language"}'
expect "PATCH /api/subjects/:id (name)" 200
expect_eq "  name updated" "$(jqb '.data.name')" "English Language"
req PATCH "/api/subjects/$ENG" '{"code":"engl"}'
expect "PATCH /api/subjects/:id (code, lowercase)" 200
expect_eq "  code normalised" "$(jqb '.data.code')" ENGL
req PATCH "/api/subjects/$ENG" '{"code":"math"}'
expect "PATCH code to an existing code -> 409" 409
req PATCH "/api/subjects/$ENG" '{"code":"engl"}'
expect "PATCH code to its own current code -> 200 (no self-conflict)" 200
req PATCH "/api/subjects/$ENG" '{}'
expect_4xx "PATCH with no fields -> 4xx"

req POST /api/subjects '{"name":"Bad","code":"bad code!"}'
expect "invalid code characters -> 400" 400
req POST /api/subjects '{"name":"Bad","code":"-X"}'
expect "code starting with hyphen -> 400" 400
req POST /api/subjects '{"name":"Bad","code":"ABCDEFGHIJKLMNOPQRSTU"}'
expect "code longer than 20 -> 400" 400
req POST /api/subjects '{"name":"   ","code":"OKCODE"}'
expect "whitespace-only name -> 400" 400
req POST /api/subjects '{"code":"NONAME"}'
expect "missing name -> 400" 400

req GET /api/subjects/not-a-uuid
expect "invalid UUID -> 400" 400
req GET "/api/subjects/$UUID0"
expect "unknown id -> 404" 404
req PATCH "/api/subjects/$UUID0" '{"name":"x"}'
expect "PATCH unknown id -> 404" 404
req GET /api/subjects "" /dev/null
expect "list without session -> 401" 401
req POST /api/subjects '{"name":"X","code":"X"}' /dev/null
expect "create without session -> 401" 401

# ── TEACHER TESTS ────────────────────────────────────────────────────────────
group teacher

req POST /api/teachers '{"name":"  Asha Rao  ","employeeCode":"t-001"}'
expect "POST /api/teachers (with employeeCode, lowercase)" 201; TA=$(jqb '.data.id')
expect_eq "  employeeCode normalised to uppercase" "$(jqb '.data.employeeCode')" T-001
expect_eq "  name trimmed" "$(jqb '.data.name')" "Asha Rao"
expect_eq "  isActive defaults to true" "$(jqb '.data.isActive')" true
expect_eq "  schoolId comes from the session" "$(jqb '.data.schoolId')" "$SCHOOL_ID"

req POST /api/teachers '{"name":"Bala Iyer"}'
expect "POST /api/teachers (no employeeCode)" 201; TB=$(jqb '.data.id')
expect_eq "  employeeCode is null" "$(jqb '.data.employeeCode')" null
req POST /api/teachers '{"name":"Chitra Nair"}'
expect "second teacher without employeeCode (multiple NULLs allowed)" 201; TC=$(jqb '.data.id')
req POST /api/teachers '{"name":"Dev Menon","employeeCode":"   "}'
expect "whitespace-only employeeCode -> stored as null" 201; TD=$(jqb '.data.id')
expect_eq "  employeeCode is null" "$(jqb '.data.employeeCode')" null

req POST /api/teachers '{"name":"Dup","employeeCode":" T-001 "}'
expect "duplicate employeeCode (case/whitespace-insensitive) -> 409" 409
req POST /api/teachers '{"name":"Asha Rao","employeeCode":"T-777"}'
expect "same name, different code -> 201" 201

req GET /api/teachers
expect "GET /api/teachers" 200
expect_eq "  lists 5 teachers" "$(jqb '.data|length')" 5
req GET "/api/teachers/$TA"
expect "GET /api/teachers/:id" 200
expect_eq "  returns T-001" "$(jqb '.data.employeeCode')" T-001

req PATCH "/api/teachers/$TA" '{"name":"Asha R. Rao"}'
expect "PATCH name" 200
expect_eq "  name updated" "$(jqb '.data.name')" "Asha R. Rao"
req PATCH "/api/teachers/$TA" '{"employeeCode":"t-002"}'
expect "PATCH employeeCode" 200
expect_eq "  employeeCode updated + normalised" "$(jqb '.data.employeeCode')" T-002
req PATCH "/api/teachers/$TB" '{"employeeCode":"T-002"}'
expect "PATCH employeeCode to another teacher's code -> 409" 409
req PATCH "/api/teachers/$TA" '{"employeeCode":"T-002"}'
expect "PATCH employeeCode to its own current code -> 200" 200
req PATCH "/api/teachers/$TA" '{"employeeCode":null}'
expect "PATCH employeeCode null (clear)" 200
expect_eq "  employeeCode cleared" "$(jqb '.data.employeeCode')" null
req PATCH "/api/teachers/$TA" '{"employeeCode":"T-001"}'
expect "PATCH employeeCode restored" 200
req PATCH "/api/teachers/$TA" '{}'
expect_4xx "PATCH with no fields -> 4xx"

req PATCH "/api/teachers/$TC" '{"isActive":false}'
expect "PATCH isActive=false (deactivate)" 200
expect_eq "  isActive is false" "$(jqb '.data.isActive')" false
req GET "/api/teachers?isActive=false"
expect "GET ?isActive=false" 200
expect_eq "  exactly the deactivated teacher" "$(jqb '[.data[]|select(.id=="'"$TC"'")]|length')/$(jqb '.data|length')" "1/1"
req GET "/api/teachers?isActive=true"
expect "GET ?isActive=true" 200
expect_eq "  excludes the deactivated teacher" "$(jqb '[.data[]|select(.id=="'"$TC"'")]|length')" 0
req GET "/api/teachers?isActive=maybe"
expect_4xx "GET ?isActive=maybe -> 4xx"
req PATCH "/api/teachers/$TC" '{"isActive":true}'
expect "PATCH isActive=true (reactivate)" 200
expect_eq "  isActive is true" "$(jqb '.data.isActive')" true

req POST /api/teachers '{"name":"Inactive From Start","isActive":false}'
expect "create with isActive=false" 201
expect_eq "  isActive is false" "$(jqb '.data.isActive')" false

req POST /api/teachers '{"name":""}'
expect "empty name -> 400" 400
req POST /api/teachers '{"name":"X","employeeCode":"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNO"}'
expect "employeeCode longer than 50 -> 400" 400
req GET /api/teachers/not-a-uuid
expect "invalid UUID -> 400" 400
req GET "/api/teachers/$UUID0"
expect "unknown id -> 404" 404
req GET /api/teachers "" /dev/null
expect "list without session -> 401" 401

# ── TEACHER SUBJECT TESTS ────────────────────────────────────────────────────
group teacher-subject

req POST "/api/teachers/$TA/subjects" "{\"subjectId\":\"$MATH\",\"type\":\"PRIMARY\"}"
expect "POST /api/teachers/:id/subjects (valid)" 201
TS_A_MATH=$(jqb '.data.id')
expect_eq "  type PRIMARY" "$(jqb '.data.type')" PRIMARY
expect_eq "  subject summary included" "$(jqb '.data.subject.code')" MATH

req POST "/api/teachers/$TA/subjects" "{\"subjectId\":\"$MATH\",\"type\":\"SECONDARY\"}"
expect "duplicate teacher-subject -> 409" 409
req POST "/api/teachers/$TA/subjects" "{\"subjectId\":\"$SCI\",\"type\":\"SECONDARY\"}"
expect "same teacher, second subject" 201; TS_A_SCI=$(jqb '.data.id')
req POST "/api/teachers/$TB/subjects" "{\"subjectId\":\"$MATH\",\"type\":\"PRIMARY\"}"
expect "second teacher, same subject (many-to-many)" 201; TS_B_MATH=$(jqb '.data.id')

req POST "/api/teachers/$TA/subjects" "{\"subjectId\":\"$ENG\",\"type\":\"TERTIARY\"}"
expect "invalid type -> 400" 400
req POST "/api/teachers/$TA/subjects" '{"type":"PRIMARY"}'
expect "missing subjectId -> 400" 400
req POST "/api/teachers/$TA/subjects" '{"subjectId":"nope","type":"PRIMARY"}'
expect "malformed subjectId -> 400" 400
req POST "/api/teachers/$UUID0/subjects" "{\"subjectId\":\"$MATH\",\"type\":\"PRIMARY\"}"
expect "unknown teacher -> 404" 404
req POST "/api/teachers/$TA/subjects" "{\"subjectId\":\"$UUID0\",\"type\":\"PRIMARY\"}"
expect "unknown subject -> 404" 404
req POST "/api/teachers/not-a-uuid/subjects" "{\"subjectId\":\"$MATH\",\"type\":\"PRIMARY\"}"
expect "malformed teacher id -> 400" 400
req POST "/api/teachers/$TA/subjects" "{\"subjectId\":\"$MATH\",\"type\":\"PRIMARY\"}" /dev/null
expect "without session -> 401" 401

req GET "/api/teachers/$TA/subjects"
expect "GET /api/teachers/:id/subjects" 200
expect_eq "  two subjects" "$(jqb '.data|length')" 2
expect_eq "  ordered by subject name" "$(jqb '.data[0].subject.code')" MATH
req GET "/api/teachers/$UUID0/subjects"
expect "GET subjects of unknown teacher -> 404" 404

req PATCH "/api/teacher-subjects/$TS_A_MATH" '{"type":"SECONDARY"}'
expect "PATCH /api/teacher-subjects/:id (type)" 200
expect_eq "  type updated" "$(jqb '.data.type')" SECONDARY
req PATCH "/api/teacher-subjects/$TS_A_MATH" '{"type":"BOGUS"}'
expect "PATCH invalid type -> 400" 400
req PATCH "/api/teacher-subjects/$UUID0" '{"type":"PRIMARY"}'
expect "PATCH unknown relationship -> 404" 404
req PATCH "/api/teacher-subjects/$TS_A_MATH" '{"type":"PRIMARY"}'
expect "PATCH type back to PRIMARY" 200

# Inactive teacher (D3): no NEW relationships, existing ones untouched, reads still work
req POST "/api/teachers/$TD/subjects" "{\"subjectId\":\"$ENG\",\"type\":\"PRIMARY\"}"
expect "relationship for active teacher TD before deactivation" 201; TS_D_ENG=$(jqb '.data.id')
req PATCH "/api/teachers/$TD" '{"isActive":false}'
expect "deactivate teacher TD" 200
req POST "/api/teachers/$TD/subjects" "{\"subjectId\":\"$MATH\",\"type\":\"PRIMARY\"}"
expect "new relationship for INACTIVE teacher -> 400" 400
echo "  message: $(jqb '.message')"
req GET "/api/teachers/$TD/subjects"
expect "GET subjects of inactive teacher still allowed" 200
expect_eq "  existing relationship remains intact" "$(jqb '.data|length')" 1
req PATCH "/api/teachers/$TD" '{"isActive":true}'
expect "reactivate teacher TD" 200
req GET "/api/teachers/$TD/subjects"
expect_eq "  relationship still intact after reactivation" "$(jqb '.data|length')" 1
req POST "/api/teachers/$TD/subjects" "{\"subjectId\":\"$MATH\",\"type\":\"PRIMARY\"}"
expect "new relationship allowed again after reactivation" 201

GROUP=isolation
not_run "cross-school teacher/subject relationship (403/404)" \
  "Cannot create a second school through the API within the bootstrap rate limit; not covered by this script."
GROUP=teacher-subject

# ── GRADE ELIGIBILITY TESTS ──────────────────────────────────────────────────
group eligibility

req POST "/api/teacher-subjects/$TS_A_MATH/grades" "{\"gradeId\":\"$G6\"}"
expect "POST /api/teacher-subjects/:id/grades (valid)" 201
expect_eq "  grade summary included" "$(jqb '.data.grade.name')" "Grade 6"
req POST "/api/teacher-subjects/$TS_A_MATH/grades" "{\"gradeId\":\"$G7\"}"
expect "second grade for the same teacher-subject" 201
req POST "/api/teacher-subjects/$TS_A_MATH/grades" "{\"gradeId\":\"$G6\"}"
expect "duplicate eligibility -> 409" 409
req POST "/api/teacher-subjects/$TS_B_MATH/grades" "{\"gradeId\":\"$G6\"}"
expect "different teacher-subject, same grade -> 201" 201

req POST "/api/teacher-subjects/$TS_A_MATH/grades" "{\"gradeId\":\"$UUID0\"}"
expect "unknown grade -> 404" 404
req POST "/api/teacher-subjects/$TS_A_MATH/grades" '{"gradeId":"nope"}'
expect "malformed grade id -> 400" 400
req POST "/api/teacher-subjects/$TS_A_MATH/grades" '{}'
expect "missing gradeId -> 400" 400
req POST "/api/teacher-subjects/$UUID0/grades" "{\"gradeId\":\"$G6\"}"
expect "unknown teacherSubject (teacher not associated with subject) -> 404" 404
req POST "/api/teacher-subjects/not-a-uuid/grades" "{\"gradeId\":\"$G6\"}"
expect "malformed teacherSubject id -> 400" 400
req POST "/api/teacher-subjects/$TS_A_MATH/grades" "{\"gradeId\":\"$G6\"}" /dev/null
expect "without session -> 401" 401

req GET "/api/teacher-subjects/$TS_A_MATH/grades"
expect "GET /api/teacher-subjects/:id/grades" 200
expect_eq "  two grades, ordered by display order" "$(jqb '[.data[].grade.name]|join(",")')" "Grade 6,Grade 7"
req GET "/api/teacher-subjects/$UUID0/grades"
expect "GET grades of unknown teacherSubject -> 404" 404

# DELETE flow (D2)
req DELETE "/api/teacher-subjects/$TS_A_MATH/grades/$G7"
expect "DELETE grade eligibility" 200
req GET "/api/teacher-subjects/$TS_A_MATH/grades"
expect_eq "  GET confirms it is gone" "$(jqb '[.data[].grade.name]|join(",")')" "Grade 6"
req DELETE "/api/teacher-subjects/$TS_A_MATH/grades/$G7"
expect "DELETE again -> 404" 404
req DELETE "/api/teacher-subjects/$TS_A_MATH/grades/$UUID0"
expect "DELETE unknown grade -> 404" 404
req DELETE "/api/teacher-subjects/$UUID0/grades/$G6"
expect "DELETE unknown teacherSubject -> 404" 404
req DELETE "/api/teacher-subjects/$TS_A_MATH/grades/not-a-uuid"
expect "DELETE malformed grade id -> 400" 400
req DELETE "/api/teacher-subjects/$TS_A_MATH/grades/$G6" "" /dev/null
expect "DELETE without session -> 401" 401
# only the relationship row was removed
req GET "/api/teachers/$TA"
expect "  teacher still exists" 200
req GET "/api/subjects/$MATH"
expect "  subject still exists" 200
req GET "/api/teachers/$TA/subjects"
expect_eq "  teacher-subject relationships still exist" "$(jqb '.data|length')" 2
req GET "/api/grades/$G7"
expect "  grade still exists" 200
req POST "/api/teacher-subjects/$TS_A_MATH/grades" "{\"gradeId\":\"$G7\"}"
expect "  eligibility can be re-created after delete" 201

# ACTIVE / COMPLETED years: build in DRAFT, then lock (D1)
lock_year() {  # lock_year LABEL STATUS...  -> sets LOCK_GA (has eligibility), LOCK_GB (none)
  local label="$1"; shift
  mk_year "$label"; local Y=$ID
  mk_grade "$Y" "$label A"; LOCK_GA=$ID
  mk_grade "$Y" "$label B"; LOCK_GB=$ID
  mk POST "/api/teacher-subjects/$TS_A_SCI/grades" "{\"gradeId\":\"$LOCK_GA\"}"
  for st in "$@"; do
    req PATCH "/api/academic-years/$Y" "{\"status\":\"$st\"}"
    [ "$STATUS" = 200 ] || setup_fail "could not move year to $st"
  done
}

for label_status in "Active:ACTIVE" "Completed:ACTIVE COMPLETED"; do
  label="${label_status%%:*}"; chain="${label_status#*:}"
  # shellcheck disable=SC2086
  lock_year "$label" $chain
  req POST "/api/teacher-subjects/$TS_A_SCI/grades" "{\"gradeId\":\"$LOCK_GB\"}"
  expect "POST eligibility in $label year -> 400" 400
  echo "  message: $(jqb '.message')"
  req DELETE "/api/teacher-subjects/$TS_A_SCI/grades/$LOCK_GA"
  expect "DELETE eligibility in $label year -> 400" 400
  req GET "/api/teacher-subjects/$TS_A_SCI/grades"
  expect "GET eligibility with a $label-year grade is allowed" 200
  expect_eq "  the $label-year eligibility is still present (delete was rejected)" \
    "$(jqb '[.data[]|select(.gradeId=="'"$LOCK_GA"'")]|length')" 1
done

# ── DATABASE UNIQUENESS UNDER CONCURRENCY ────────────────────────────────────
group concurrency

echo "Racing two identical simultaneous requests for each unique constraint..."

race2 POST /api/subjects '{"name":"Race Subject","code":"RACE1"}'
expect_eq "concurrent duplicate subject code -> exactly one 201 and one 409" "$RACE_CODES" "201 409"
expect_eq "  loser gets the friendly duplicate-code message" "$LOSER_MSG" 'Subject with code "RACE1" already exists in this school'
req GET /api/subjects
expect_eq "  exactly one RACE1 row persisted" "$(jqb '[.data[]|select(.code=="RACE1")]|length')" 1

race2 POST /api/teachers '{"name":"Race Teacher","employeeCode":"RACE-T1"}'
expect_eq "concurrent duplicate employeeCode -> exactly one 201 and one 409" "$RACE_CODES" "201 409"
expect_eq "  loser gets the friendly duplicate-code message" "$LOSER_MSG" 'Teacher with employee code "RACE-T1" already exists in this school'
req GET /api/teachers
expect_eq "  exactly one RACE-T1 row persisted" "$(jqb '[.data[]|select(.employeeCode=="RACE-T1")]|length')" 1

mk POST /api/teachers '{"name":"Race Teacher Two"}'; TR=$ID
race2 POST "/api/teachers/$TR/subjects" "{\"subjectId\":\"$ENG\",\"type\":\"PRIMARY\"}"
expect_eq "concurrent duplicate teacher-subject -> exactly one 201 and one 409" "$RACE_CODES" "201 409"
expect_eq "  loser gets the friendly duplicate message" "$LOSER_MSG" "This subject is already assigned to this teacher"
req GET "/api/teachers/$TR/subjects"
expect_eq "  exactly one relationship persisted" "$(jqb '.data|length')" 1
TS_R=$(jqb '.data[0].id')

race2 POST "/api/teacher-subjects/$TS_R/grades" "{\"gradeId\":\"$G6\"}"
expect_eq "concurrent duplicate grade eligibility -> exactly one 201 and one 409" "$RACE_CODES" "201 409"
expect_eq "  loser gets the friendly duplicate message" "$LOSER_MSG" "This teacher subject is already eligible for this grade"
req GET "/api/teacher-subjects/$TS_R/grades"
expect_eq "  exactly one eligibility row persisted" "$(jqb '.data|length')" 1

DONE_OK=1
