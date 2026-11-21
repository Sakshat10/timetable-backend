#!/usr/bin/env bash
# =============================================================================
# Module 8 — Section ↔ Subject ↔ Teacher assignment API tests (self-contained)
# =============================================================================
# Usage:   ./test-section-subject-teacher-api.sh            (server must be running)
#          BASE_URL=http://localhost:4000 FAIL_FAST=0 ./test-section-subject-teacher-api.sh
#
# Bootstraps its own data through the public API, with no pre-existing credentials:
#   POST /api/schools -> POST /api/admin/register -> POST /api/admin/login
# Exactly ONE school is created per run (school creation is rate limited to
# 1 per 24h per IP; this script never retries or works around that limit).
#
# Also contains the Module 6 dependency-guard tests (DELETE of a teacher-subject-grade
# eligibility returns 409 while an assignment depends on it), because that guard can
# only be exercised once assignments can be created.
#
# NOT covered here (needs a second school, blocked by the bootstrap limit) and reported
# as NOT RUN: cross-school isolation, the A/B component matrix, corrupt cross-school rows
# and the deterministic lock proofs. A temporary direct-service utility covers those once;
# it is not part of this suite.
#
# NOTE: the API cannot delete schools/years/teachers/subjects, so every run leaves its
# test data in the database. All names/codes carry a timestamp.
#
# Exit code: 0 = every executed test passed, 1 = a test failed, 2 = setup failed.
# =============================================================================

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:4000}"
FAIL_FAST="${FAIL_FAST:-1}"
ELIG_RACE_ROUNDS="${ELIG_RACE_ROUNDS:-8}"
DEACT_RACE_ROUNDS="${DEACT_RACE_ROUNDS:-6}"

TS="$(date +%s)"
SCHOOL_NAME="Module8 Test School $TS"
SCHOOL_CODE="M8_$TS"
ADMIN_EMAIL="m8_${TS}@test.local"
ADMIN_PASSWORD="Module8Pass2026"

TMPDIR_M8="$(mktemp -d)"
JAR="$TMPDIR_M8/cookies.txt"
RESULTS="$TMPDIR_M8/results.txt"
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
  for g in basic eligibility pairing duplicates multiple inactive lifecycle filters m6-guard concurrency isolation; do
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
    echo -e "${GREEN}ALL EXECUTED TESTS PASSED${NC}"; rm -rf "$TMPDIR_M8"; exit 0
  fi
  echo -e "${RED}RUN DID NOT COMPLETE CLEANLY or A TEST FAILED${NC}"
  rm -rf "$TMPDIR_M8"
  [ "$code" = 0 ] && exit 1
  exit "$code"
}

# req METHOD PATH [JSON_BODY] [COOKIE_JAR]  -> sets STATUS and BODY
req() {
  local m="$1" p="$2" d="${3:-}" jar="${4:-$JAR}"
  local args=(-s -o "$TMPDIR_M8/body" -w '%{http_code}' -X "$m" "$BASE_URL$p" -b "$jar" -c "$jar")
  [ -n "$d" ] && args+=(-H 'Content-Type: application/json' -d "$d")
  STATUS=$(curl "${args[@]}") || STATUS="000"
  BODY=$(cat "$TMPDIR_M8/body" 2>/dev/null || true)
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

GRADE_ORDER=0
mk_grade() { GRADE_ORDER=$((GRADE_ORDER+1)); mk POST /api/grades "{\"academicYearId\":\"$1\",\"name\":\"$2\",\"displayOrder\":$GRADE_ORDER}"; }
YEAR_N=0
mk_year() { YEAR_N=$((YEAR_N+1)); mk POST /api/academic-years "{\"name\":\"Module 8 $1 $TS\",\"startDate\":\"$((2040+YEAR_N))-04-01\",\"endDate\":\"$((2040+YEAR_N))-12-31\"}"; }
mk_subject() { mk POST /api/subjects "{\"name\":\"$1\",\"code\":\"$2\"}"; }
mk_stream() { mk POST /api/streams "{\"gradeId\":\"$1\",\"name\":\"$2\",\"code\":\"$3\"}"; }
mk_section() { mk POST /api/sections "{\"gradeId\":\"$1\",\"name\":\"Sec $2\",\"code\":\"$2\"}"; }
mk_stream_section() { mk POST /api/sections "{\"gradeId\":\"$1\",\"streamId\":\"$2\",\"name\":\"Sec $3\",\"code\":\"$3\"}"; }
mk_req() {   # mk_req GRADE STREAM|- SUBJECT PERIODS
  local stream=""; [ "$2" != "-" ] && stream=",\"streamId\":\"$2\""
  mk POST /api/subject-requirements "{\"gradeId\":\"$1\"$stream,\"subjectId\":\"$3\",\"periodsPerWeek\":$4}"
}
TEACHER_N=0
# setup_teacher NAME [SUBJECT GRADE...]  -> sets T_ID; with a subject also TS_ID and eligibility for each grade
setup_teacher() {
  local name="$1"; shift
  TEACHER_N=$((TEACHER_N+1))
  mk POST /api/teachers "{\"name\":\"$name $TEACHER_N\"}"; T_ID=$ID; TS_ID=""
  if [ $# -ge 1 ]; then
    local subject="$1"; shift
    mk POST "/api/teachers/$T_ID/subjects" "{\"subjectId\":\"$subject\",\"type\":\"PRIMARY\"}"; TS_ID=$ID
    for g in "$@"; do
      req POST "/api/teacher-subjects/$TS_ID/grades" "{\"gradeId\":\"$g\"}"
      [ "$STATUS" = 201 ] || setup_fail "could not make teacher eligible for grade $g"
    done
  fi
}
assign() { req POST /api/section-subject-teachers "{\"sectionId\":\"$1\",\"subjectRequirementId\":\"$2\",\"teacherId\":\"$3\"}"; }
patch_teacher() { req PATCH "/api/section-subject-teachers/$1" "{\"teacherId\":\"$2\"}"; }

# race2 METHOD PATH JSON -> two identical simultaneous requests; sets RACE_CODES ("201 409"), LOSER_MSG
race2() {
  for k in a b; do
    ( curl -s -o "$TMPDIR_M8/$k.body" -w '%{http_code}' -X "$1" "$BASE_URL$2" -b "$JAR" \
        -H 'Content-Type: application/json' -d "$3" > "$TMPDIR_M8/$k.code" ) &
  done
  wait
  local ca cb; ca=$(cat "$TMPDIR_M8/a.code"); cb=$(cat "$TMPDIR_M8/b.code")
  RACE_CODES=$(printf '%s\n' "$ca" "$cb" | sort | tr '\n' ' ' | sed 's/ $//')
  if [ "$ca" = 409 ]; then LOSER_MSG=$(jq -r '.message' "$TMPDIR_M8/a.body"); else LOSER_MSG=$(jq -r '.message' "$TMPDIR_M8/b.body"); fi
  echo "  race statuses: $ca $cb   loser message: $LOSER_MSG"
}

# race_pair M1 P1 B1 M2 P2 B2 -> two DIFFERENT simultaneous requests; sets RA RB
race_pair() {
  ( curl -s -o "$TMPDIR_M8/pa.body" -w '%{http_code}' -X "$1" "$BASE_URL$2" -b "$JAR" ${3:+-H "Content-Type: application/json" -d "$3"} > "$TMPDIR_M8/pa.code" ) &
  ( curl -s -o "$TMPDIR_M8/pb.body" -w '%{http_code}' -X "$4" "$BASE_URL$5" -b "$JAR" ${6:+-H "Content-Type: application/json" -d "$6"} > "$TMPDIR_M8/pb.code" ) &
  wait
  RA=$(cat "$TMPDIR_M8/pa.code"); RB=$(cat "$TMPDIR_M8/pb.code")
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

req POST /api/admin/register "{\"schoolId\":\"$SCHOOL_ID\",\"setupToken\":\"$SETUP_TOKEN\",\"name\":\"M8 Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" /dev/null
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
mk_subject "Physics" "PHY"; PHY=$ID

mk_year "Main"; AY=$ID
mk_grade "$AY" "Grade 6";  G6=$ID
mk_section "$G6" A; S6A=$ID; mk_section "$G6" B; S6B=$ID; mk_section "$G6" C; S6C=$ID; mk_section "$G6" D; S6D=$ID
mk_grade "$AY" "Grade 7";  G7=$ID;  mk_section "$G7" A; S7A=$ID
mk_grade "$AY" "Grade 11"; G11=$ID; mk_stream "$G11" "Science" "SCI"; ST_SCI=$ID; mk_stream "$G11" "Commerce" "COM"; ST_COM=$ID
mk_stream_section "$G11" "$ST_SCI" SA; S11SCI=$ID; mk_stream_section "$G11" "$ST_COM" CA; S11COM=$ID

# Grade X: a non-stream requirement exists, then a streamed section is added (Module 5 allows it)
mk_grade "$AY" "Grade X"; GX=$ID; mk_req "$GX" - "$MATH" 4; RXM=$ID
mk_stream "$GX" "XStream" "XS"; XS=$ID; mk_stream_section "$GX" "$XS" XA; SX_STREAMED=$ID
# Grade Y: a stream requirement exists, then a non-stream section is added (Module 5 allows it)
mk_grade "$AY" "Grade Y"; GY=$ID; mk_stream "$GY" "YStream" "YS"; YS=$ID; mk_req "$GY" "$YS" "$MATH" 4; RYM=$ID
mk_section "$GY" YA; SY_PLAIN=$ID

mk_req "$G6" - "$MATH" 6; R6M=$ID
mk_req "$G6" - "$ENG" 5;  R6E=$ID
mk_req "$G7" - "$MATH" 6; R7M=$ID
mk_req "$G11" "$ST_SCI" "$PHY" 6; RSCI=$ID
mk_req "$G11" "$ST_COM" "$PHY" 6; RCOM=$ID

setup_teacher "Rahul" "$MATH" "$G6" "$G7" "$GX" "$GY"; RAHUL=$T_ID; TS_RAHUL=$TS_ID
setup_teacher "Amit" "$MATH" "$G6" "$G7";               AMIT=$T_ID;  TS_AMIT=$TS_ID
setup_teacher "GradeOnly" "$MATH" "$G7";                GRADEONLY=$T_ID
setup_teacher "NoGrades" "$MATH";                       NOGRADES=$T_ID
setup_teacher "WrongSubject" "$ENG" "$G6" "$G7";        WRONGSUBJ=$T_ID
setup_teacher "NoSubject";                              NOSUBJ=$T_ID
setup_teacher "EnglishTeacher" "$ENG" "$G6";            TENG=$T_ID
setup_teacher "PhysicsTeacher" "$PHY" "$G11";           TPHY=$T_ID
setup_teacher "Flaky" "$MATH" "$G6";                    FLAKY=$T_ID
setup_teacher "Flaky2" "$MATH" "$G6";                   FLAKY2=$T_ID
setup_teacher "Inactive" "$MATH" "$G6";                 INACTIVE=$T_ID
req PATCH "/api/teachers/$INACTIVE" '{"isActive":false}'
[ "$STATUS" = 200 ] || setup_fail "could not deactivate teacher"

# ── BASIC ────────────────────────────────────────────────────────────────────
group basic

assign "$S6A" "$R6M" "$RAHUL"
expect "POST /api/section-subject-teachers (valid)" 201
A1=$(jqb '.data.id')
expect_eq "  section summary" "$(jqb '.data.section.code')" A
expect_eq "  grade summary" "$(jqb '.data.grade.name')" "Grade 6"
expect_eq "  stream is null for a non-streamed section" "$(jqb '.data.stream')" null
expect_eq "  subject summary" "$(jqb '.data.subject.code')" MATH
expect_eq "  requirement periodsPerWeek is read through the relation" "$(jqb '.data.subjectRequirement.periodsPerWeek')" 6
expect_eq "  teacher summary" "$(jqb '.data.teacher.name')" "Rahul 1"
expect_eq "  teacher.isActive" "$(jqb '.data.teacher.isActive')" true

req GET /api/section-subject-teachers
expect "GET /api/section-subject-teachers" 200
expect_eq "  contains the assignment" "$(jqb '[.data[]|select(.id=="'"$A1"'")]|length')" 1
req GET "/api/section-subject-teachers/$A1"
expect "GET /api/section-subject-teachers/:id" 200
expect_eq "  returns the right row" "$(jqb '.data.id')" "$A1"

patch_teacher "$A1" "$AMIT"
expect "PATCH teacher to another eligible teacher" 200
expect_eq "  teacher changed" "$(jqb '.data.teacher.id')" "$AMIT"
patch_teacher "$A1" "$RAHUL"
expect "PATCH teacher back" 200
patch_teacher "$A1" "$RAHUL"
expect "PATCH with the SAME (still valid) teacher re-validates and succeeds" 200
req PATCH "/api/section-subject-teachers/$A1" "{\"teacherId\":\"$AMIT\",\"sectionId\":\"$S6B\"}"
expect "PATCH with sectionId -> 400 (immutable)" 400
expect_eq "  field-level error under errors.sectionId" "$(jqb '.errors.sectionId|length > 0')" true
req PATCH "/api/section-subject-teachers/$A1" "{\"teacherId\":\"$AMIT\",\"subjectRequirementId\":\"$R6E\"}"
expect "PATCH with subjectRequirementId -> 400 (immutable)" 400
req GET "/api/section-subject-teachers/$A1"
expect_eq "  assignment unchanged by the rejected PATCHes" "$(jqb '.data.teacher.id + "/" + .data.section.id + "/" + .data.subjectRequirement.id')" "$RAHUL/$S6A/$R6M"
req PATCH "/api/section-subject-teachers/$A1" '{}'
expect "PATCH empty body -> 400" 400
expect_eq "  field-level error under errors.teacherId" "$(jqb '.errors.teacherId|length > 0')" true

req DELETE "/api/section-subject-teachers/$A1"
expect "DELETE assignment" 200
expect_eq "  data is null" "$(jqb '.data')" null
req GET "/api/section-subject-teachers/$A1"
expect "  GET after delete -> 404" 404
req DELETE "/api/section-subject-teachers/$A1"
expect "DELETE again -> 404" 404
req GET "/api/sections/$S6A";                       expect "  section still exists" 200
req GET "/api/subjects/$MATH";                      expect "  subject still exists" 200
req GET "/api/teachers/$RAHUL";                     expect "  teacher still exists" 200
req GET "/api/subject-requirements/$R6M";           expect "  requirement still exists" 200
req GET "/api/teacher-subjects/$TS_RAHUL/grades"
expect_eq "  teacher eligibility still exists" "$(jqb '[.data[]|select(.gradeId=="'"$G6"'")]|length')" 1
assign "$S6A" "$R6M" "$RAHUL"
expect "re-create after delete" 201; A1=$(jqb '.data.id')

req GET /api/section-subject-teachers/not-a-uuid;   expect "GET invalid UUID -> 400" 400
patch_teacher not-a-uuid "$AMIT";                    expect "PATCH invalid UUID -> 400" 400
req DELETE /api/section-subject-teachers/not-a-uuid; expect "DELETE invalid UUID -> 400" 400
req GET "/api/section-subject-teachers/$UUID0";     expect "GET unknown id -> 404" 404
patch_teacher "$UUID0" "$AMIT";                      expect "PATCH unknown id -> 404" 404
req DELETE "/api/section-subject-teachers/$UUID0";  expect "DELETE unknown id -> 404" 404

req POST /api/section-subject-teachers '{}'
expect "POST empty body -> 400" 400
req POST /api/section-subject-teachers "{\"subjectRequirementId\":\"$R6M\",\"teacherId\":\"$RAHUL\"}"
expect "POST missing sectionId -> 400" 400
expect_eq "  field-level error under errors.sectionId" "$(jqb '.errors.sectionId|length > 0')" true
req POST /api/section-subject-teachers "{\"sectionId\":\"$S6B\",\"teacherId\":\"$RAHUL\"}"
expect "POST missing subjectRequirementId -> 400" 400
req POST /api/section-subject-teachers "{\"sectionId\":\"$S6B\",\"subjectRequirementId\":\"$R6M\"}"
expect "POST missing teacherId -> 400" 400
req POST /api/section-subject-teachers "{\"sectionId\":\"nope\",\"subjectRequirementId\":\"$R6M\",\"teacherId\":\"$RAHUL\"}"
expect "POST malformed sectionId -> 400" 400
req POST /api/section-subject-teachers "{\"sectionId\":\"$S6B\",\"subjectRequirementId\":\"nope\",\"teacherId\":\"$RAHUL\"}"
expect "POST malformed subjectRequirementId -> 400" 400
req POST /api/section-subject-teachers "{\"sectionId\":\"$S6B\",\"subjectRequirementId\":\"$R6M\",\"teacherId\":\"nope\"}"
expect "POST malformed teacherId -> 400" 400

req GET /api/section-subject-teachers "" /dev/null;                  expect "list without session -> 401" 401
req GET "/api/section-subject-teachers/$A1" "" /dev/null;            expect "get without session -> 401" 401
req POST /api/section-subject-teachers "{\"sectionId\":\"$S6B\",\"subjectRequirementId\":\"$R6M\",\"teacherId\":\"$RAHUL\"}" /dev/null
expect "create without session -> 401" 401
req PATCH "/api/section-subject-teachers/$A1" "{\"teacherId\":\"$AMIT\"}" /dev/null
expect "patch without session -> 401" 401
req DELETE "/api/section-subject-teachers/$A1" "" /dev/null;         expect "delete without session -> 401" 401

# ── TEACHER ELIGIBILITY ──────────────────────────────────────────────────────
group eligibility

assign "$S6D" "$R6M" "$WRONGSUBJ"
expect "teacher teaches ENGLISH only, requirement is MATH (subject mismatch) -> 400" 400
expect_msg "  message says the teacher is not assigned to the subject" "not assigned to teach"
assign "$S6D" "$R6M" "$NOSUBJ"
expect "teacher without any TeacherSubject -> 400" 400
expect_msg "  message says the teacher is not assigned to the subject" "not assigned to teach"
assign "$S6D" "$R6M" "$NOGRADES"
expect "teacher has the subject but no TeacherSubjectGrade -> 400" 400
expect_msg "  message says the teacher is not eligible for the grade" "not eligible"
assign "$S6D" "$R6M" "$GRADEONLY"
expect "teacher eligible for a DIFFERENT grade only (G7, section is G6) -> 400" 400
expect_msg "  message says the teacher is not eligible for the grade" "not eligible"
assign "$S6D" "$R6M" "$INACTIVE"
expect "inactive teacher -> 400" 400
expect_msg "  message says the teacher is inactive" "inactive"
assign "$S6D" "$R6M" "$UUID0"
expect "unknown teacher -> 404" 404
assign "$S7A" "$R7M" "$GRADEONLY"
expect "same teacher IS eligible for G7 -> 201 (eligibility is per grade)" 201; ASG_GRADEONLY=$(jqb '.data.id')
req DELETE "/api/section-subject-teachers/$ASG_GRADEONLY"; expect "  (cleanup of that assignment)" 200
assign "$S6A" "$R6E" "$TENG"
expect "English teacher eligible for G6 on the ENGLISH requirement -> 201" 201
req GET "/api/section-subject-teachers?sectionId=$S6D"
expect_eq "  none of the rejected attempts left an assignment" "$(jqb '.data|length')" 0
not_run "foreign teacher (another school's teacher)" \
  "Needs a second school; verified once with a temporary direct-service utility, not part of this suite."
GROUP=isolation
not_run "cross-school isolation (foreign section / requirement / teacher / assignment, full A/B matrix, corrupt rows)" \
  "Cannot create a second school through the API within the bootstrap rate limit; verified once with a temporary direct-service utility, not part of this suite."
GROUP=eligibility

# ── SECTION / REQUIREMENT PAIRING ────────────────────────────────────────────
group pairing

assign "$S11SCI" "$RSCI" "$TPHY"
expect "streamed grade: SCI section + SCI requirement (matching grade and stream) -> 201" 201
expect_eq "  stream summary returned" "$(jqb '.data.stream.code')" SCI
assign "$S11COM" "$RCOM" "$TPHY"
expect "COM section + COM requirement -> 201 (same teacher, other stream)" 201
assign "$S11COM" "$RSCI" "$TPHY"
expect "stream A requirement -> stream B section -> 400" 400
expect_msg "  message mentions the stream" "stream"
assign "$S7A" "$R6M" "$RAHUL"
expect "grade mismatch (Grade 6 requirement -> Grade 7 section) -> 400" 400
expect_msg "  message mentions the grade" "grade"
assign "$SX_STREAMED" "$RXM" "$RAHUL"
expect "non-stream requirement -> streamed section (same grade) -> 400" 400
expect_msg "  message mentions the stream" "stream"
assign "$SY_PLAIN" "$RYM" "$RAHUL"
expect "stream requirement -> non-stream section (same grade) -> 400" 400
expect_msg "  message mentions the stream" "stream"
assign "$UUID0" "$R6M" "$RAHUL"
expect "unknown section -> 404" 404
assign "$S6B" "$UUID0" "$RAHUL"
expect "unknown requirement -> 404" 404

# ── DUPLICATES ───────────────────────────────────────────────────────────────
group duplicates

assign "$S6A" "$R6M" "$RAHUL"
expect "duplicate assignment (same teacher) -> 409" 409
expect_eq "  friendly message" "$(jqb '.message')" "This section already has a teacher assigned for this subject requirement"
assign "$S6A" "$R6M" "$AMIT"
expect "same section + requirement with a DIFFERENT teacher -> 409 (one teacher per section+subject)" 409

# ── MULTIPLE SECTIONS ────────────────────────────────────────────────────────
group multiple

req POST /api/section-subject-teachers "{\"sectionId\":\"$S6B\",\"subjectRequirementId\":\"$R6M\",\"teacherId\":\"$RAHUL\",\"schoolId\":\"$UUID0\"}"
expect "same teacher + same subject, DIFFERENT section (6B) -> 201 (client schoolId ignored)" 201; A_6B=$(jqb '.data.id')
assign "$S7A" "$R7M" "$RAHUL"
expect "same teacher, same subject, different GRADE (7A) -> 201" 201; A_7A=$(jqb '.data.id')
req GET "/api/section-subject-teachers?teacherId=$RAHUL"
expect_eq "  the teacher now has 3 assignments across sections" "$(jqb '.data|length')" 3
assign "$S6B" "$R6E" "$TENG"
expect "same section, a DIFFERENT subject, another teacher -> 201" 201

# ── INACTIVE AFTER ASSIGNMENT ────────────────────────────────────────────────
group inactive

assign "$S6C" "$R6M" "$FLAKY"
expect "assign an active teacher" 201; A_FLAKY=$(jqb '.data.id')
req PATCH "/api/teachers/$FLAKY" '{"isActive":false}'
expect "deactivate the teacher" 200
req GET "/api/section-subject-teachers/$A_FLAKY"
expect "assignment remains after deactivation (GET)" 200
expect_eq "  GET shows teacher.isActive = false" "$(jqb '.data.teacher.isActive')" false
req GET "/api/section-subject-teachers?teacherId=$FLAKY"
expect_eq "  still listed (list shows isActive = false)" "$(jqb '[.data[]|select(.teacher.isActive==false)]|length')" 1
patch_teacher "$A_FLAKY" "$FLAKY"
expect "PATCH with the SAME inactive teacher -> 400 (PATCH always re-validates)" 400
expect_msg "  message says the teacher is inactive" "inactive"
req GET "/api/section-subject-teachers/$A_FLAKY"
expect_eq "  assignment still holds the inactive teacher (not auto-reassigned)" "$(jqb '.data.teacher.id')" "$FLAKY"
patch_teacher "$A_FLAKY" "$INACTIVE"
expect "PATCH to ANOTHER inactive teacher -> 400" 400
patch_teacher "$A_FLAKY" "$AMIT"
expect "PATCH replacing with an active eligible teacher -> 200" 200
expect_eq "  replacement is active" "$(jqb '.data.teacher.isActive')" true
req DELETE "/api/section-subject-teachers/$A_FLAKY"; expect "(cleanup) delete" 200

assign "$S6D" "$R6M" "$FLAKY2"
expect "assign a second active teacher" 201; A_FLAKY2=$(jqb '.data.id')
req PATCH "/api/teachers/$FLAKY2" '{"isActive":false}'
expect "deactivate the second teacher" 200
req DELETE "/api/section-subject-teachers/$A_FLAKY2"
expect "DELETE an assignment whose teacher is inactive (DRAFT) -> 200" 200
req GET "/api/teachers/$FLAKY2"
expect "  the inactive teacher itself is untouched" 200
req PATCH "/api/teachers/$FLAKY" '{"isActive":true}'
expect "reactivate the first teacher" 200
assign "$S6C" "$R6M" "$FLAKY"
expect "a reactivated teacher can be assigned again" 201; req DELETE "/api/section-subject-teachers/$(jqb '.data.id')"

# ── ACADEMIC-YEAR LIFECYCLE ──────────────────────────────────────────────────
group lifecycle

lock_year() {   # lock_year LABEL STATUS...  -> sets LK_SECTION LK_REQ_E LK_T1 LK_T2 LK_ASG
  local label="$1"; shift
  mk_year "$label"; local Y=$ID
  mk_grade "$Y" "$label Grade"; local LG=$ID
  mk_section "$LG" A; LK_SECTION=$ID
  mk_req "$LG" - "$MATH" 5; local RM=$ID
  mk_req "$LG" - "$ENG" 5; LK_REQ_E=$ID
  setup_teacher "Lock" "$MATH" "$LG"; LK_T1=$T_ID
  req POST "/api/teachers/$LK_T1/subjects" "{\"subjectId\":\"$ENG\",\"type\":\"SECONDARY\"}"
  [ "$STATUS" = 201 ] || setup_fail "could not add ENG to lock teacher"
  req POST "/api/teacher-subjects/$(jqb '.data.id')/grades" "{\"gradeId\":\"$LG\"}"
  [ "$STATUS" = 201 ] || setup_fail "could not make lock teacher eligible for ENG"
  setup_teacher "LockOther" "$MATH" "$LG"; LK_T2=$T_ID
  assign "$LK_SECTION" "$RM" "$LK_T1"
  [ "$STATUS" = 201 ] || setup_fail "could not create the lifecycle assignment"
  LK_ASG=$(jqb '.data.id'); LK_YEAR=$Y; LK_GRADE=$LG
  for st in "$@"; do
    req PATCH "/api/academic-years/$Y" "{\"status\":\"$st\"}"
    [ "$STATUS" = 200 ] || setup_fail "could not move year to $st"
  done
}

mk_year "DraftLife"; DY=$ID; mk_grade "$DY" "Draft Grade"; DG=$ID; mk_section "$DG" A; DS=$ID; mk_req "$DG" - "$MATH" 5; DR=$ID
setup_teacher "DraftT1" "$MATH" "$DG"; DT1=$T_ID
setup_teacher "DraftT2" "$MATH" "$DG"; DT2=$T_ID
assign "$DS" "$DR" "$DT1"; expect "DRAFT: create" 201; DA=$(jqb '.data.id')
patch_teacher "$DA" "$DT2"; expect "DRAFT: update" 200
req DELETE "/api/section-subject-teachers/$DA"; expect "DRAFT: delete" 200

for label_status in "Active:ACTIVE" "Completed:ACTIVE COMPLETED"; do
  label="${label_status%%:*}"; chain="${label_status#*:}"
  # shellcheck disable=SC2086
  lock_year "$label" $chain
  assign "$LK_SECTION" "$LK_REQ_E" "$LK_T1"
  expect "POST in $label year -> 400" 400
  expect_msg "  message says DRAFT only" "DRAFT"
  patch_teacher "$LK_ASG" "$LK_T2"
  expect "PATCH in $label year -> 400" 400
  req DELETE "/api/section-subject-teachers/$LK_ASG"
  expect "DELETE in $label year -> 400" 400
  req GET "/api/section-subject-teachers/$LK_ASG"
  expect "GET by id in $label year is allowed" 200
  expect_eq "  unchanged by the rejected PATCH and DELETE" "$(jqb '.data.teacher.id')" "$LK_T1"
  req GET "/api/section-subject-teachers?academicYearId=$LK_YEAR"
  expect "list ?academicYearId in $label year is allowed" 200
  expect_eq "  row still present" "$(jqb '.data|length')" 1
  req GET "/api/section-subject-teachers?sectionId=$LK_SECTION"
  expect "list ?sectionId in $label year is allowed" 200
done

# ── FILTERS ──────────────────────────────────────────────────────────────────
group filters

mk_year "Next"; AY2=$ID; mk_grade "$AY2" "Grade 6 next"; GN=$ID; mk_section "$GN" A; SN=$ID; mk_req "$GN" - "$MATH" 6; RN=$ID
req POST "/api/teacher-subjects/$TS_RAHUL/grades" "{\"gradeId\":\"$GN\"}"
[ "$STATUS" = 201 ] || setup_fail "could not make Rahul eligible for the next year's grade"
assign "$SN" "$RN" "$RAHUL"; [ "$STATUS" = 201 ] || setup_fail "could not create the next-year assignment"

req GET "/api/section-subject-teachers?academicYearId=$AY2"
expect "list ?academicYearId (other year)" 200
expect_eq "  only that year's assignment" "$(jqb '.data|length')" 1
req GET "/api/section-subject-teachers?academicYearId=$AY"
expect "list ?academicYearId (main year)" 200
expect_eq "  contains nothing from the other year" "$(jqb '[.data[]|select(.grade.academicYearId!="'"$AY"'")]|length')" 0
req GET "/api/section-subject-teachers?gradeId=$G6"
expect "list ?gradeId" 200
expect_eq "  every row is in Grade 6" "$(jqb '[.data[]|select(.grade.id!="'"$G6"'")]|length')" 0
req GET "/api/section-subject-teachers?sectionId=$S6A"
expect "list ?sectionId (everything for a section)" 200
expect_eq "  only that section's rows (MATH + ENG)" "$(jqb '[.data[].section.id]|unique|join(",")')/$(jqb '.data|length')" "$S6A/2"
req GET "/api/section-subject-teachers?subjectId=$MATH"
expect "list ?subjectId (everything for a subject)" 200
expect_eq "  every row is MATH" "$(jqb '[.data[]|select(.subject.code!="MATH")]|length')" 0
req GET "/api/section-subject-teachers?teacherId=$RAHUL"
expect "list ?teacherId (everything for a teacher)" 200
expect_eq "  every row is Rahul's" "$(jqb '[.data[]|select(.teacher.id!="'"$RAHUL"'")]|length')" 0
expect_eq "  across both years: 4 rows" "$(jqb '.data|length')" 4
req GET "/api/section-subject-teachers?gradeId=$G6&teacherId=$RAHUL"
expect "list ?gradeId + ?teacherId combined" 200
expect_eq "  Rahul's Grade 6 rows (6A, 6B)" "$(jqb '.data|length')" 2
req GET "/api/section-subject-teachers?sectionId=$S6A&subjectId=$ENG"
expect "list ?sectionId + ?subjectId combined" 200
expect_eq "  exactly the English row" "$(jqb '.data|length')" 1
req GET "/api/section-subject-teachers?academicYearId=$AY&gradeId=$G7&sectionId=$S7A&subjectId=$MATH&teacherId=$RAHUL"
expect "list with all five filters" 200
expect_eq "  exactly one row" "$(jqb '.data|length')" 1
req GET "/api/section-subject-teachers?gradeId=$G7&sectionId=$S6A"
expect "list with filters that do not intersect (G7 + a G6 section)" 200
expect_eq "  empty result" "$(jqb '.data|length')" 0
req GET /api/section-subject-teachers
expect_eq "  unfiltered list: newest academic year first" "$(jqb '.data[0].grade.academicYearId')" "$AY2"
req GET "/api/section-subject-teachers?academicYearId=$AY"
expect_eq "  ordered by grade display order" \
  "$(jqb '[.data[].grade.name] | reduce .[] as $x ([]; if .[-1]==$x then . else .+[$x] end) | join(",")')" \
  "Grade 6,Grade 7,Grade 11"
req GET "/api/section-subject-teachers?academicYearId=$UUID0"; expect "unknown academicYearId -> 404" 404
req GET "/api/section-subject-teachers?gradeId=$UUID0";        expect "unknown gradeId -> 404" 404
req GET "/api/section-subject-teachers?sectionId=$UUID0";      expect "unknown sectionId -> 404" 404
req GET "/api/section-subject-teachers?subjectId=$UUID0";      expect "unknown subjectId -> 404" 404
req GET "/api/section-subject-teachers?teacherId=$UUID0";      expect "unknown teacherId -> 404" 404
req GET "/api/section-subject-teachers?teacherId=nope";        expect "malformed teacherId -> 400" 400
req GET "/api/section-subject-teachers?gradeId=nope";          expect "malformed gradeId -> 400" 400

# ── MODULE 6 DEPENDENCY GUARD ────────────────────────────────────────────────
group m6-guard

req DELETE "/api/teacher-subjects/$TS_RAHUL/grades/$G6"
expect "DELETE grade eligibility while Rahul's Grade 6 assignments depend on it -> 409" 409
echo "  message: $(jqb '.message')"
req GET "/api/teacher-subjects/$TS_RAHUL/grades"
expect_eq "  the eligibility was NOT deleted" "$(jqb '[.data[]|select(.gradeId=="'"$G6"'")]|length')" 1
req GET "/api/section-subject-teachers/$A1"
expect "  the assignment was preserved" 200
req DELETE "/api/teacher-subjects/$TS_RAHUL/grades/$G7"
expect "same guard for Rahul's Grade 7 assignment -> 409" 409
req DELETE "/api/teacher-subjects/$TS_AMIT/grades/$G7"
expect "guard is specific: Amit's Grade 7 eligibility has no dependents (only Rahul teaches 7A) -> 200" 200
req POST "/api/teacher-subjects/$TS_AMIT/grades" "{\"gradeId\":\"$G7\"}"
expect "  (restore Amit's Grade 7 eligibility)" 201

req DELETE "/api/section-subject-teachers/$A1";    expect "remove Rahul's 6A assignment" 200
req DELETE "/api/teacher-subjects/$TS_RAHUL/grades/$G6"
expect "one dependent assignment (6B) still remains -> 409" 409
req DELETE "/api/section-subject-teachers/$A_6B";  expect "remove Rahul's 6B assignment" 200
req DELETE "/api/teacher-subjects/$TS_RAHUL/grades/$G6"
expect "no dependents left -> DELETE eligibility succeeds" 200
req GET "/api/teacher-subjects/$TS_RAHUL/grades"
expect_eq "  eligibility is gone, other grades untouched" "$(jqb '[.data[]|select(.gradeId=="'"$G6"'")]|length')" 0
assign "$S6A" "$R6M" "$RAHUL"
expect "a new assignment for the de-eligible teacher is rejected -> 400" 400
expect_msg "  message says the teacher is not eligible for the grade" "not eligible"

# ── CONCURRENCY ──────────────────────────────────────────────────────────────
group concurrency

echo "Racing two identical simultaneous creates..."
mk_section "$G6" E; SE=$ID
race2 POST /api/section-subject-teachers "{\"sectionId\":\"$SE\",\"subjectRequirementId\":\"$R6M\",\"teacherId\":\"$AMIT\"}"
expect_eq "concurrent duplicate assignment -> exactly one 201 and one 409" "$RACE_CODES" "201 409"
expect_eq "  loser gets the friendly duplicate message" "$LOSER_MSG" "This section already has a teacher assigned for this subject requirement"
req GET "/api/section-subject-teachers?sectionId=$SE"
expect_eq "  exactly one row stored" "$(jqb '.data|length')" 1

echo "Racing assignment creation against eligibility deletion ($ELIG_RACE_ROUNDS rounds)..."
VIOL=0; BAD_OUTCOME=0; N_ASSIGNED=0; N_ELIG_REMOVED=0
for i in $(seq 1 "$ELIG_RACE_ROUNDS"); do
  setup_teacher "EligRace" "$MATH" "$G6"; ET=$T_ID; ETS=$TS_ID
  mk_section "$G6" "ER$i"; ES=$ID
  race_pair POST /api/section-subject-teachers "{\"sectionId\":\"$ES\",\"subjectRequirementId\":\"$R6M\",\"teacherId\":\"$ET\"}" \
            DELETE "/api/teacher-subjects/$ETS/grades/$G6"
  req GET "/api/section-subject-teachers?teacherId=$ET"; HAS_ASG=$(jqb '.data|length')
  req GET "/api/teacher-subjects/$ETS/grades"; HAS_ELIG=$(jqb '.data|length')
  verdict=ok
  if [ "$RA" = 201 ] && [ "$RB" = 409 ]; then N_ASSIGNED=$((N_ASSIGNED+1))
  elif [ "$RA" = 400 ] && [ "$RB" = 200 ]; then N_ELIG_REMOVED=$((N_ELIG_REMOVED+1))
  else verdict="UNEXPECTED"; BAD_OUTCOME=$((BAD_OUTCOME+1)); fi
  if [ "$HAS_ASG" -gt 0 ] && [ "$HAS_ELIG" = 0 ]; then verdict="INVARIANT-VIOLATED"; VIOL=$((VIOL+1)); fi
  echo "  round $i: create=$RA delete-eligibility=$RB -> assignment rows=$HAS_ASG eligibility rows=$HAS_ELIG [$verdict]"
done
STATUS="-"
expect_eq "no assignment ever exists without its eligibility ($ELIG_RACE_ROUNDS rounds)" "$VIOL" 0
expect_eq "every round ended as (201 + 409) or (400 + 200), never (201 + 200) or an error" "$BAD_OUTCOME" 0
info "eligibility race over $ELIG_RACE_ROUNDS rounds: assignment won (delete refused 409)=$N_ASSIGNED, delete won (create refused 400)=$N_ELIG_REMOVED"

echo "Racing assignment creation against teacher deactivation ($DEACT_RACE_ROUNDS rounds)..."
BAD_OUTCOME=0; N_CREATED=0; N_REFUSED=0; BAD_STATE=0
for i in $(seq 1 "$DEACT_RACE_ROUNDS"); do
  setup_teacher "DeactRace" "$MATH" "$G6"; DT=$T_ID
  mk_section "$G6" "DR$i"; DSX=$ID
  race_pair POST /api/section-subject-teachers "{\"sectionId\":\"$DSX\",\"subjectRequirementId\":\"$R6M\",\"teacherId\":\"$DT\"}" \
            PATCH "/api/teachers/$DT" '{"isActive":false}'
  req GET "/api/section-subject-teachers?teacherId=$DT"; HAS_ASG=$(jqb '.data|length')
  verdict=ok
  if [ "$RA" = 201 ] && [ "$RB" = 200 ]; then N_CREATED=$((N_CREATED+1)); [ "$HAS_ASG" = 1 ] || { verdict="STATE"; BAD_STATE=$((BAD_STATE+1)); }
  elif [ "$RA" = 400 ] && [ "$RB" = 200 ]; then N_REFUSED=$((N_REFUSED+1)); [ "$HAS_ASG" = 0 ] || { verdict="STATE"; BAD_STATE=$((BAD_STATE+1)); }
  else verdict="UNEXPECTED"; BAD_OUTCOME=$((BAD_OUTCOME+1)); fi
  echo "  round $i: create=$RA deactivate=$RB -> assignment rows=$HAS_ASG [$verdict]"
done
STATUS="-"
expect_eq "every round ended as (201 + 200) or (400 + 200), never an error ($DEACT_RACE_ROUNDS rounds)" "$BAD_OUTCOME" 0
expect_eq "the stored state always matches the create response" "$BAD_STATE" 0
info "deactivation race over $DEACT_RACE_ROUNDS rounds: created before deactivation=$N_CREATED, refused after deactivation=$N_REFUSED (the lock ordering itself is proven deterministically by the service-level utility)"

DONE_OK=1
