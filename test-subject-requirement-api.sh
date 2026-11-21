#!/usr/bin/env bash
# =============================================================================
# Module 7 — Subject Requirements API tests (self-contained)
# =============================================================================
# Usage:   ./test-subject-requirement-api.sh            (server must be running)
#          BASE_URL=http://localhost:4000 FAIL_FAST=0 ./test-subject-requirement-api.sh
#
# Bootstraps its own data through the public API, with no pre-existing credentials:
#   POST /api/schools -> POST /api/admin/register -> POST /api/admin/login
# Exactly ONE school is created per run (school creation is rate limited to
# 1 per 24h per IP; this script never retries or works around that limit).
#
# NOT covered here (cannot be done through the API within that limit / before the
# assignment module exists), and reported as NOT RUN:
#   - cross-school isolation (needs a second school)
#   - the delete guard against SectionSubjectTeacher rows (no API creates them)
# Both are exercised once by a temporary direct-service utility, not by this suite.
#
# NOTE: the API cannot delete schools/years/subjects, so every run leaves its test
# data in the database. All names/codes carry a timestamp.
#
# Exit code: 0 = every executed test passed, 1 = a test failed, 2 = setup failed.
# =============================================================================

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000}"
FAIL_FAST="${FAIL_FAST:-1}"
MODE_RACE_ROUNDS="${MODE_RACE_ROUNDS:-8}"

TS="$(date +%s)"
SCHOOL_NAME="Module7 Test School $TS"
SCHOOL_CODE="M7_$TS"
ADMIN_EMAIL="m7_${TS}@test.local"
ADMIN_PASSWORD="Module7Pass2026"

TMPDIR_M7="$(mktemp -d)"
JAR="$TMPDIR_M7/cookies.txt"
RESULTS="$TMPDIR_M7/results.txt"
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
  for g in requirement periods mode duplicates lifecycle concurrency isolation delete-guard; do
    local p f n
    p=$(grep -c "^$g|PASS|" "$RESULTS" || true)
    f=$(grep -c "^$g|FAIL|" "$RESULTS" || true)
    n=$(grep -c "^$g|NOTRUN|" "$RESULTS" || true)
    tp=$((tp+p)); tf=$((tf+f))
    printf "  %-14s pass=%s fail=%s not-run=%s\n" "$g" "$p" "$f" "$n"
  done
  echo "  TOTAL executed: pass=$tp fail=$tf"
  grep '|NOTRUN|' "$RESULTS" | while IFS='|' read -r _ _ msg; do echo "  NOT RUN: $msg"; done
  grep '|INFO|' "$RESULTS" | while IFS='|' read -r _ _ msg; do echo "  INFO: $msg"; done
  if [ "$DONE_OK" = 1 ] && ! grep -q '|FAIL|' "$RESULTS"; then
    echo -e "${GREEN}ALL EXECUTED TESTS PASSED${NC}"; rm -rf "$TMPDIR_M7"; exit 0
  fi
  echo -e "${RED}RUN DID NOT COMPLETE CLEANLY or A TEST FAILED${NC}"
  rm -rf "$TMPDIR_M7"
  [ "$code" = 0 ] && exit 1
  exit "$code"
}

# req METHOD PATH [JSON_BODY] [COOKIE_JAR]  -> sets STATUS and BODY
req() {
  local m="$1" p="$2" d="${3:-}" jar="${4:-$JAR}"
  local args=(-s -o "$TMPDIR_M7/body" -w '%{http_code}' -X "$m" "$BASE_URL$p" -b "$jar" -c "$jar")
  [ -n "$d" ] && args+=(-H 'Content-Type: application/json' -d "$d")
  STATUS=$(curl "${args[@]}") || STATUS="000"
  BODY=$(cat "$TMPDIR_M7/body" 2>/dev/null || true)
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

GRADE_ORDER=0
mk_grade() { GRADE_ORDER=$((GRADE_ORDER+1)); mk POST /api/grades "{\"academicYearId\":\"$1\",\"name\":\"$2\",\"displayOrder\":$GRADE_ORDER}"; }

YEAR_N=0
mk_year() {   # mk_year LABEL -> DRAFT year, later years start later
  YEAR_N=$((YEAR_N+1))
  mk POST /api/academic-years "{\"name\":\"Module 7 $1 $TS\",\"startDate\":\"$((2040+YEAR_N))-04-01\",\"endDate\":\"$((2040+YEAR_N))-12-31\"}"
}

mk_subject() { mk POST /api/subjects "{\"name\":\"$1\",\"code\":\"$2\"}"; }
mk_stream() { mk POST /api/streams "{\"gradeId\":\"$1\",\"name\":\"$2\",\"code\":\"$3\"}"; }
mk_section() { mk POST /api/sections "{\"gradeId\":\"$1\",\"name\":\"Sec $2\",\"code\":\"$2\"}"; }
mk_stream_section() { mk POST /api/sections "{\"gradeId\":\"$1\",\"streamId\":\"$2\",\"name\":\"Sec $3\",\"code\":\"$3\"}"; }

# post_req GRADE [STREAM|-] SUBJECT RAW_PERIODS  -> POST with a raw JSON value for periodsPerWeek
post_req() {
  local stream=""
  [ "$2" != "-" ] && stream=",\"streamId\":\"$2\""
  req POST /api/subject-requirements "{\"gradeId\":\"$1\"$stream,\"subjectId\":\"$3\",\"periodsPerWeek\":$4}"
}

# race2 METHOD PATH JSON -> two identical simultaneous requests; sets RACE_CODES ("201 409"), LOSER_MSG
race2() {
  for k in a b; do
    ( curl -s -o "$TMPDIR_M7/$k.body" -w '%{http_code}' -X "$1" "$BASE_URL$2" -b "$JAR" \
        -H 'Content-Type: application/json' -d "$3" > "$TMPDIR_M7/$k.code" ) &
  done
  wait
  local ca cb; ca=$(cat "$TMPDIR_M7/a.code"); cb=$(cat "$TMPDIR_M7/b.code")
  RACE_CODES=$(printf '%s\n' "$ca" "$cb" | sort | tr '\n' ' ' | sed 's/ $//')
  if [ "$ca" = 409 ]; then LOSER_MSG=$(jq -r '.message' "$TMPDIR_M7/a.body"); else LOSER_MSG=$(jq -r '.message' "$TMPDIR_M7/b.body"); fi
  echo "  race statuses: $ca $cb   loser message: $LOSER_MSG"
}

# race_pair M1 P1 B1 M2 P2 B2 -> two DIFFERENT simultaneous requests; sets RA RB
race_pair() {
  ( curl -s -o "$TMPDIR_M7/pa.body" -w '%{http_code}' -X "$1" "$BASE_URL$2" -b "$JAR" -H 'Content-Type: application/json' -d "$3" > "$TMPDIR_M7/pa.code" ) &
  ( curl -s -o "$TMPDIR_M7/pb.body" -w '%{http_code}' -X "$4" "$BASE_URL$5" -b "$JAR" -H 'Content-Type: application/json' -d "$6" > "$TMPDIR_M7/pb.code" ) &
  wait
  RA=$(cat "$TMPDIR_M7/pa.code"); RB=$(cat "$TMPDIR_M7/pb.code")
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

req POST /api/admin/register "{\"schoolId\":\"$SCHOOL_ID\",\"setupToken\":\"$SETUP_TOKEN\",\"name\":\"M7 Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" /dev/null
[ "$STATUS" = 201 ] || setup_fail "admin register returned $STATUS"
unset SETUP_TOKEN
req POST /api/admin/login "{\"schoolId\":\"$SCHOOL_ID\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"
[ "$STATUS" = 200 ] || setup_fail "admin login returned $STATUS"
req GET /api/admin/me
[ "$STATUS" = 200 ] || setup_fail "session cookie not accepted by /api/admin/me ($STATUS)"
echo "  session established"

# ── fixtures ─────────────────────────────────────────────────────────────────
mk_subject "Mathematics" "MATH"; MATH=$ID
mk_subject "English" "ENG"; ENG=$ID
mk_subject "Science" "SCI"; SCI=$ID
mk_subject "Hindi" "HIN"; HIN=$ID

mk_year "Main"; AY=$ID
mk_grade "$AY" "Grade 6";  G6=$ID;  mk_section "$G6" A                       # non-streamed by sections
mk_grade "$AY" "Grade 7";  G7=$ID                                            # no sections, no streams
mk_grade "$AY" "Grade 8";  G8=$ID;  mk_stream "$G8" "Stray" "STRAY"; STRAY=$ID; mk_section "$G8" A   # stray stream + unstreamed section
mk_grade "$AY" "Grade 11"; G11=$ID; mk_stream "$G11" "Science" "SCI"; S11_SCI=$ID; mk_stream "$G11" "Commerce" "COM"; S11_COM=$ID
mk_stream_section "$G11" "$S11_SCI" A; mk_stream_section "$G11" "$S11_COM" A   # streamed by sections
mk_grade "$AY" "Grade 12"; G12=$ID; mk_stream "$G12" "Science" "SCI"; S12_SCI=$ID; mk_stream "$G12" "Commerce" "COM"; S12_COM=$ID  # streams, no sections

mk_year "Next"; AY2=$ID
mk_grade "$AY2" "Grade 6"; G6_NEXT=$ID

# ── BASIC REQUIREMENT TESTS ──────────────────────────────────────────────────
group requirement

post_req "$G7" - "$MATH" 6
expect "POST /api/subject-requirements (non-streamed)" 201
R1=$(jqb '.data.id')
expect_eq "  periodsPerWeek stored" "$(jqb '.data.periodsPerWeek')" 6
expect_eq "  streamId is null" "$(jqb '.data.streamId')" null
expect_eq "  subject summary included" "$(jqb '.data.subject.code')" MATH
expect_eq "  grade summary included" "$(jqb '.data.grade.name')" "Grade 7"
expect_eq "  stream summary is null" "$(jqb '.data.stream')" null

req GET /api/subject-requirements
expect "GET /api/subject-requirements (no filters)" 200
expect_eq "  contains the requirement" "$(jqb '[.data[]|select(.id=="'"$R1"'")]|length')" 1

req GET "/api/subject-requirements/$R1"
expect "GET /api/subject-requirements/:id" 200
expect_eq "  returns the right row" "$(jqb '.data.id')" "$R1"

req PATCH "/api/subject-requirements/$R1" '{"periodsPerWeek":8}'
expect "PATCH periodsPerWeek" 200
expect_eq "  value updated" "$(jqb '.data.periodsPerWeek')" 8
req PATCH "/api/subject-requirements/$R1" '{"periodsPerWeek":6,"gradeId":"'"$G6"'","subjectId":"'"$ENG"'"}'
expect "PATCH ignores immutable fields (gradeId/subjectId)" 200
expect_eq "  gradeId unchanged" "$(jqb '.data.gradeId')" "$G7"
expect_eq "  subjectId unchanged" "$(jqb '.data.subjectId')" "$MATH"

req DELETE "/api/subject-requirements/$R1"
expect "DELETE /api/subject-requirements/:id" 200
expect_eq "  data is null" "$(jqb '.data')" null
req GET "/api/subject-requirements/$R1"
expect "  GET after delete -> 404" 404
req DELETE "/api/subject-requirements/$R1"
expect "DELETE again -> 404" 404
req GET /api/subjects
expect_eq "  the subject itself was not deleted" "$(jqb '[.data[]|select(.id=="'"$MATH"'")]|length')" 1
req GET "/api/grades/$G7"
expect "  the grade itself was not deleted" 200

post_req "$G7" - "$MATH" 6
expect "re-create after delete" 201
R1=$(jqb '.data.id')

req GET /api/subject-requirements/not-a-uuid
expect "GET invalid UUID -> 400" 400
req PATCH /api/subject-requirements/not-a-uuid '{"periodsPerWeek":5}'
expect "PATCH invalid UUID -> 400" 400
req DELETE /api/subject-requirements/not-a-uuid
expect "DELETE invalid UUID -> 400" 400
req GET "/api/subject-requirements/$UUID0"
expect "GET unknown id -> 404" 404
req PATCH "/api/subject-requirements/$UUID0" '{"periodsPerWeek":5}'
expect "PATCH unknown id -> 404" 404
req DELETE "/api/subject-requirements/$UUID0"
expect "DELETE unknown id -> 404" 404

req POST /api/subject-requirements '{}'
expect "POST empty body -> 400" 400
req POST /api/subject-requirements "{\"subjectId\":\"$ENG\",\"periodsPerWeek\":5}"
expect "POST missing gradeId -> 400" 400
req POST /api/subject-requirements "{\"gradeId\":\"$G7\",\"periodsPerWeek\":5}"
expect "POST missing subjectId -> 400" 400
req POST /api/subject-requirements "{\"gradeId\":\"$G7\",\"subjectId\":\"$ENG\"}"
expect "POST missing periodsPerWeek -> 400" 400
expect_eq "  field-level error under errors.periodsPerWeek" "$(jqb '.errors.periodsPerWeek|length > 0')" true
req POST /api/subject-requirements "{\"gradeId\":\"nope\",\"subjectId\":\"$ENG\",\"periodsPerWeek\":5}"
expect "POST malformed gradeId -> 400" 400
req POST /api/subject-requirements "{\"gradeId\":\"$G7\",\"subjectId\":\"nope\",\"periodsPerWeek\":5}"
expect "POST malformed subjectId -> 400" 400
req POST /api/subject-requirements "{\"gradeId\":\"$G7\",\"streamId\":\"nope\",\"subjectId\":\"$ENG\",\"periodsPerWeek\":5}"
expect "POST malformed streamId -> 400" 400
req PATCH "/api/subject-requirements/$R1" '{}'
expect "PATCH empty body -> 400" 400

req POST /api/subject-requirements "{\"gradeId\":\"$G7\",\"subjectId\":\"$ENG\",\"periodsPerWeek\":5,\"schoolId\":\"$UUID0\"}"
expect "client-supplied schoolId is ignored (not trusted)" 201
expect_eq "  row still belongs to the session's grade" "$(jqb '.data.gradeId')" "$G7"

req GET /api/subject-requirements "" /dev/null
expect "list without session -> 401" 401
req GET "/api/subject-requirements/$R1" "" /dev/null
expect "get without session -> 401" 401
req POST /api/subject-requirements "{\"gradeId\":\"$G7\",\"subjectId\":\"$SCI\",\"periodsPerWeek\":5}" /dev/null
expect "create without session -> 401" 401
req PATCH "/api/subject-requirements/$R1" '{"periodsPerWeek":5}' /dev/null
expect "patch without session -> 401" 401
req DELETE "/api/subject-requirements/$R1" "" /dev/null
expect "delete without session -> 401" 401

# ── periodsPerWeek VALIDATION (strict integer 1..40) ─────────────────────────
group periods

post_req "$G7" - "$HIN" 1
expect "periodsPerWeek 1 -> 201" 201
post_req "$G7" - "$SCI" 40
expect "periodsPerWeek 40 -> 201" 201

req GET "/api/subject-requirements?gradeId=$G7"; BEFORE=$(jqb '.data|length')
declare -a BAD_VALUES=('0' '-1' '1.5' '41' '"5"' '" 5 "' 'true' 'false' '[5]' 'null' '"abc"' '""' '{}' '999999999999')
for v in "${BAD_VALUES[@]}"; do
  post_req "$G7" - "$MATH" "$v"
  expect "POST periodsPerWeek=$v -> 400" 400
done
req POST /api/subject-requirements "{\"gradeId\":\"$G7\",\"subjectId\":\"$MATH\",\"periodsPerWeek\":1.5}"
expect_eq "  decimal rejection has a field-level error" "$(jqb '.errors.periodsPerWeek|length > 0')" true
req GET "/api/subject-requirements?gradeId=$G7"
expect_eq "  none of the rejected values created a row" "$(jqb '.data|length')" "$BEFORE"

req GET "/api/subject-requirements?gradeId=$G7"; R_P=$(jqb '[.data[]|select(.subjectId=="'"$HIN"'")][0].id')
for v in '0' '-1' '1.5' '41' '"5"' '" 5 "' 'true' 'false' '[5]' 'null'; do
  req PATCH "/api/subject-requirements/$R_P" "{\"periodsPerWeek\":$v}"
  expect "PATCH periodsPerWeek=$v -> 400" 400
done
req GET "/api/subject-requirements/$R_P"
expect_eq "  stored value untouched by rejected PATCHes" "$(jqb '.data.periodsPerWeek')" 1
req PATCH "/api/subject-requirements/$R_P" '{"periodsPerWeek":40}'
expect "PATCH periodsPerWeek=40 -> 200" 200
req PATCH "/api/subject-requirements/$R_P" '{"periodsPerWeek":1}'
expect "PATCH periodsPerWeek=1 -> 200" 200

# ── GRADE / STREAM MODE ──────────────────────────────────────────────────────
group mode

post_req "$G6" - "$MATH" 6
expect "non-streamed grade (by sections), no stream -> 201" 201
post_req "$G6" "$S11_SCI" "$ENG" 5
expect "stream from ANOTHER grade on a non-streamed grade -> 400" 400
post_req "$G8" "$STRAY" "$MATH" 5
expect "stream supplied for unstreamed-section grade (stray stream) -> 400" 400
post_req "$G8" - "$MATH" 5
expect "stray-stream grade with unstreamed sections accepts a non-streamed requirement" 201

post_req "$G11" "$S11_SCI" "$MATH" 6
expect "streamed grade (by sections), stream SCI -> 201" 201
post_req "$G11" "$S11_COM" "$MATH" 6
expect "same subject, different stream (COM) -> 201" 201
post_req "$G11" - "$ENG" 5
expect "streamed grade, stream omitted -> 400" 400
echo "  message: $(jqb '.message')"
post_req "$G11" "$S12_SCI" "$ENG" 5
expect "stream belonging to another grade -> 400" 400
post_req "$G11" "$UUID0" "$ENG" 5
expect "unknown stream -> 404" 404

post_req "$G12" "$S12_SCI" "$MATH" 6
expect "streamed grade (by streams, no sections), stream given -> 201" 201
post_req "$G12" - "$ENG" 5
expect "streamed grade (by streams), stream omitted -> 400" 400

post_req "$G7" "$S11_SCI" "$ENG" 5
expect "grade with no streams, foreign stream supplied -> 400" 400
req POST /api/subject-requirements "{\"gradeId\":\"$G12\",\"streamId\":null,\"subjectId\":\"$ENG\",\"periodsPerWeek\":5}"
expect "streamId null is treated as omitted (streamed grade -> 400)" 400

post_req "$G7" - "$UUID0" 5
expect "nonexistent subject -> 404" 404
post_req "$UUID0" - "$MATH" 5
expect "nonexistent grade -> 404" 404

post_req "$G6_NEXT" - "$MATH" 6
expect "same subject, grade of ANOTHER academic year -> 201" 201

# ── DUPLICATES ───────────────────────────────────────────────────────────────
group duplicates

post_req "$G6" - "$MATH" 3
expect "duplicate non-streamed requirement -> 409" 409
echo "  message: $(jqb '.message')"
expect_eq "  friendly message" "$(jqb '.message')" "A requirement for this subject already exists for this grade"
post_req "$G11" "$S11_SCI" "$MATH" 3
expect "duplicate streamed requirement -> 409" 409
expect_eq "  friendly message" "$(jqb '.message')" "A requirement for this subject already exists for this stream"
post_req "$G6" - "$ENG" 5
expect "same grade, different subject -> 201" 201
post_req "$G7" - "$ENG" 5
expect "(G7, ENG) was created earlier in the suite -> 409" 409

req GET "/api/subject-requirements?gradeId=$G11"
expect "list ?gradeId" 200
expect_eq "  two streamed requirements for Grade 11" "$(jqb '.data|length')" 2
req GET "/api/subject-requirements?streamId=$S11_COM"
expect "list ?streamId" 200
expect_eq "  one requirement for the COM stream" "$(jqb '.data|length')" 1
req GET "/api/subject-requirements?academicYearId=$AY2"
expect "list ?academicYearId" 200
expect_eq "  only the other year's requirement" "$(jqb '.data|length')" 1
expect_eq "  it belongs to the other year" "$(jqb '.data[0].grade.academicYearId')" "$AY2"
req GET "/api/subject-requirements?academicYearId=$AY&gradeId=$G11&streamId=$S11_SCI"
expect "list with all three filters combined" 200
expect_eq "  exactly the SCI requirement" "$(jqb '.data|length')" 1
req GET /api/subject-requirements
expect_eq "  unfiltered list: newest academic year first" "$(jqb '.data[0].grade.academicYearId')" "$AY2"
req GET "/api/subject-requirements?academicYearId=$AY"
expect_eq "  ordered by grade display order" \
  "$(jqb '[.data[].grade.name] | reduce .[] as $x ([]; if .[-1]==$x then . else .+[$x] end) | join(",")')" \
  "Grade 6,Grade 7,Grade 8,Grade 11,Grade 12"
req GET "/api/subject-requirements?gradeId=$UUID0"
expect "list unknown gradeId -> 404" 404
req GET "/api/subject-requirements?streamId=$UUID0"
expect "list unknown streamId -> 404" 404
req GET "/api/subject-requirements?academicYearId=$UUID0"
expect "list unknown academicYearId -> 404" 404
req GET "/api/subject-requirements?gradeId=nope"
expect "list malformed gradeId -> 400" 400

# ── ACADEMIC-YEAR LIFECYCLE ──────────────────────────────────────────────────
group lifecycle

lock_year() {   # lock_year LABEL STATUS...  -> sets LOCK_YEAR LOCK_GRADE LOCK_REQ
  local label="$1"; shift
  mk_year "$label"; LOCK_YEAR=$ID
  mk_grade "$LOCK_YEAR" "$label Grade"; LOCK_GRADE=$ID
  mk POST /api/subject-requirements "{\"gradeId\":\"$LOCK_GRADE\",\"subjectId\":\"$MATH\",\"periodsPerWeek\":5}"; LOCK_REQ=$ID
  for st in "$@"; do
    req PATCH "/api/academic-years/$LOCK_YEAR" "{\"status\":\"$st\"}"
    [ "$STATUS" = 200 ] || setup_fail "could not move year to $st"
  done
}

for label_status in "Active:ACTIVE" "Completed:ACTIVE COMPLETED"; do
  label="${label_status%%:*}"; chain="${label_status#*:}"
  # shellcheck disable=SC2086
  lock_year "$label" $chain
  post_req "$LOCK_GRADE" - "$ENG" 5
  expect "POST in $label year -> 400" 400
  echo "  message: $(jqb '.message')"
  req PATCH "/api/subject-requirements/$LOCK_REQ" '{"periodsPerWeek":9}'
  expect "PATCH in $label year -> 400" 400
  req DELETE "/api/subject-requirements/$LOCK_REQ"
  expect "DELETE in $label year -> 400" 400
  req GET "/api/subject-requirements/$LOCK_REQ"
  expect "GET by id in $label year is allowed" 200
  expect_eq "  value unchanged by the rejected PATCH" "$(jqb '.data.periodsPerWeek')" 5
  req GET "/api/subject-requirements?gradeId=$LOCK_GRADE"
  expect "list ?gradeId in $label year is allowed" 200
  expect_eq "  row still present (DELETE was rejected)" "$(jqb '.data|length')" 1
  req GET "/api/subject-requirements?academicYearId=$LOCK_YEAR"
  expect "list ?academicYearId in $label year is allowed" 200
done

# DRAFT: create, update and delete all work (covered in 'requirement'); re-assert on a fresh year
mk_year "Draft"; DY=$ID; mk_grade "$DY" "Draft Grade"; DG=$ID
post_req "$DG" - "$MATH" 4
expect "DRAFT: create" 201; DR=$(jqb '.data.id')
req PATCH "/api/subject-requirements/$DR" '{"periodsPerWeek":7}'
expect "DRAFT: update" 200
req DELETE "/api/subject-requirements/$DR"
expect "DRAFT: delete" 200

# ── CONCURRENCY ──────────────────────────────────────────────────────────────
group concurrency

echo "Racing two identical simultaneous creates for each uniqueness rule..."

mk_grade "$AY" "Race plain"; GR=$ID
race2 POST /api/subject-requirements "{\"gradeId\":\"$GR\",\"subjectId\":\"$MATH\",\"periodsPerWeek\":5}"
expect_eq "concurrent duplicate NON-streamed requirement -> exactly one 201, one 409" "$RACE_CODES" "201 409"
expect_eq "  loser gets the friendly message" "$LOSER_MSG" "A requirement for this subject already exists for this grade"
req GET "/api/subject-requirements?gradeId=$GR"
expect_eq "  exactly one row stored" "$(jqb '.data|length')" 1

mk_grade "$AY" "Race streamed"; GR=$ID; mk_stream "$GR" "RS" "RS"; RS=$ID
race2 POST /api/subject-requirements "{\"gradeId\":\"$GR\",\"streamId\":\"$RS\",\"subjectId\":\"$MATH\",\"periodsPerWeek\":5}"
expect_eq "concurrent duplicate STREAMED requirement -> exactly one 201, one 409" "$RACE_CODES" "201 409"
expect_eq "  loser gets the friendly message" "$LOSER_MSG" "A requirement for this subject already exists for this stream"
req GET "/api/subject-requirements?gradeId=$GR"
expect_eq "  exactly one row stored" "$(jqb '.data|length')" 1

# Requirement vs section creation on the same grade (grade has a stray stream, no sections).
# (a) a NON-streamed requirement vs a NON-streamed section: whichever wins, the end state
#     must be consistent (no streamed requirement, no streamed section).
echo "Racing a non-streamed requirement against a non-streamed section ($MODE_RACE_ROUNDS rounds)..."
BAD_ROUNDS=0
for i in $(seq 1 "$MODE_RACE_ROUNDS"); do
  mk_grade "$AY" "Race mode A$i"; GR=$ID; mk_stream "$GR" "Stray" "ST"
  race_pair POST /api/subject-requirements "{\"gradeId\":\"$GR\",\"subjectId\":\"$MATH\",\"periodsPerWeek\":5}" \
            POST /api/sections "{\"gradeId\":\"$GR\",\"name\":\"N\",\"code\":\"N\"}"
  req GET "/api/subject-requirements?gradeId=$GR"; STREAMED_REQS=$(jqb '[.data[]|select(.streamId!=null)]|length')
  req GET "/api/grades/$GR/sections"; STREAMED_SECS=$(jqb '[.data[]|select(.streamId!=null)]|length')
  verdict=ok; if [ "$STREAMED_REQS" != 0 ] || [ "$STREAMED_SECS" != 0 ]; then verdict=INCONSISTENT; BAD_ROUNDS=$((BAD_ROUNDS+1)); fi
  echo "  round $i: requirement=$RA section=$RB -> streamed reqs=$STREAMED_REQS streamed sections=$STREAMED_SECS [$verdict]"
done
STATUS="-"
expect_eq "non-streamed requirement vs non-streamed section: always consistent ($MODE_RACE_ROUNDS rounds)" "$BAD_ROUNDS" 0

# (b) a STREAMED requirement vs a NON-streamed section. Module 5 section creation does not
#     consult requirements, so if the requirement commits first the section is still allowed.
#     This is a documented limitation, reported as INFO and not counted as pass/fail.
echo "Probing a streamed requirement against a non-streamed section ($MODE_RACE_ROUNDS rounds)..."
BOTH=0; REQ_REJECTED=0; OTHER=0
for i in $(seq 1 "$MODE_RACE_ROUNDS"); do
  mk_grade "$AY" "Race mode B$i"; GR=$ID; mk_stream "$GR" "Stray" "ST"; SB=$ID
  race_pair POST /api/subject-requirements "{\"gradeId\":\"$GR\",\"streamId\":\"$SB\",\"subjectId\":\"$MATH\",\"periodsPerWeek\":5}" \
            POST /api/sections "{\"gradeId\":\"$GR\",\"name\":\"N\",\"code\":\"N\"}"
  if [ "$RA" = 201 ] && [ "$RB" = 201 ]; then BOTH=$((BOTH+1)); elif [ "$RA" = 400 ] && [ "$RB" = 201 ]; then REQ_REJECTED=$((REQ_REJECTED+1)); else OTHER=$((OTHER+1)); fi
done
STATUS="-"
info "streamed-requirement vs non-streamed-section race over $MODE_RACE_ROUNDS rounds: requirement rejected after the section won=$REQ_REJECTED, both committed=$BOTH (known Module 5 limitation: section creation does not consult requirements), other=$OTHER"

GROUP=isolation
not_run "cross-school isolation (foreign grade / stream / subject / requirement)" \
  "Cannot create a second school through the API within the bootstrap rate limit; verified once with a temporary direct-service utility, not part of this suite."
GROUP=delete-guard
not_run "delete blocked (409) when SectionSubjectTeacher rows exist" \
  "No API creates SectionSubjectTeacher rows yet; verified once with a temporary direct-service utility that seeded one through Prisma, not part of this suite."

DONE_OK=1
