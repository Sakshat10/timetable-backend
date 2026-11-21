#!/usr/bin/env bash
# =============================================================================
# Module 10 — Timetable feasibility API tests (self-contained)
# =============================================================================
# Usage:   ./test-timetable-feasibility-api.sh            (server must be running)
#          BASE_URL=http://localhost:4000 FAIL_FAST=0 ./test-timetable-feasibility-api.sh
#
# Bootstraps its own data through the public API, with no pre-existing credentials:
#   POST /api/schools -> POST /api/admin/register -> POST /api/admin/login
# Exactly ONE school is created per run (school creation is rate limited to 1 per 24h per IP;
# this script never retries or works around that limit). Every scenario builds its own academic
# year through the real API and asserts on GET /api/timetable-feasibility.
#
# NOT covered here and reported as NOT RUN: cross-school isolation (needs a second school),
# schedule rows with zero days/periods (the Module 9 API refuses to create them; covered by the
# pure analyzer tests) and corrupt legacy rows (covered by the service-level utility).
#
# NOTE: the API cannot delete schools/years, so every run leaves its test data in the database.
# All names carry a timestamp; see the project notes for the targeted cleanup used afterwards.
#
# Exit code: 0 = every executed test passed, 1 = a test failed, 2 = setup failed.
# =============================================================================

set -uo pipefail

BASE_URL="${BASE_URL:-http://localhost:4010}"
FAIL_FAST="${FAIL_FAST:-1}"
SNAPSHOT_ROUNDS="${SNAPSHOT_ROUNDS:-8}"

TS="$(date +%s)"
SCHOOL_NAME="Module10 Test School $TS"
SCHOOL_CODE="M10_$TS"
ADMIN_EMAIL="m10_${TS}@test.local"
ADMIN_PASSWORD="Module10Pass2026"

TMPDIR_M10="$(mktemp -d)"
JAR="$TMPDIR_M10/cookies.txt"
RESULTS="$TMPDIR_M10/results.txt"
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
  for g in schedule demand capacity assignments eligibility structure lifecycle shape auth determinism consistency isolation; do
    local p f n
    p=$(grep -c "^$g|PASS|" "$RESULTS" || true)
    f=$(grep -c "^$g|FAIL|" "$RESULTS" || true)
    n=$(grep -c "^$g|NOTRUN|" "$RESULTS" || true)
    tp=$((tp+p)); tf=$((tf+f))
    printf "  %-13s pass=%s fail=%s not-run=%s\n" "$g" "$p" "$f" "$n"
  done
  echo "  TOTAL executed: pass=$tp fail=$tf"
  grep '|NOTRUN|' "$RESULTS" | while IFS='|' read -r _ _ msg; do echo "  NOT RUN: $msg"; done
  grep '|INFO|' "$RESULTS" | while IFS='|' read -r _ _ msg; do echo "  INFO: $msg"; done
  if [ "$DONE_OK" = 1 ] && ! grep -q '|FAIL|' "$RESULTS"; then
    echo -e "${GREEN}ALL EXECUTED TESTS PASSED${NC}"; rm -rf "$TMPDIR_M10"; exit 0
  fi
  echo -e "${RED}RUN DID NOT COMPLETE CLEANLY or A TEST FAILED${NC}"
  rm -rf "$TMPDIR_M10"
  [ "$code" = 0 ] && exit 1
  exit "$code"
}

# req METHOD PATH [JSON_BODY] [COOKIE_JAR]  -> sets STATUS and BODY
req() {
  local m="$1" p="$2" d="${3:-}" jar="${4:-$JAR}"
  local args=(-s -o "$TMPDIR_M10/body" -w '%{http_code}' -X "$m" "$BASE_URL$p" -b "$jar" -c "$jar")
  [ -n "$d" ] && args+=(-H 'Content-Type: application/json' -d "$d")
  STATUS=$(curl "${args[@]}") || STATUS="000"
  BODY=$(cat "$TMPDIR_M10/body" 2>/dev/null || true)
}

record() { echo "$GROUP|$1|$2" >> "$RESULTS"; }

fail_now() {
  echo -e "  ${RED}✗ FAIL${NC}"; echo "    body: $(echo "$BODY" | cut -c1-1500)"
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

# ── fixture builders ─────────────────────────────────────────────────────────
GRADE_ORDER=0
mk_grade() { GRADE_ORDER=$((GRADE_ORDER+1)); mk POST /api/grades "{\"academicYearId\":\"$1\",\"name\":\"$2\",\"displayOrder\":$GRADE_ORDER}"; }
YEAR_N=0
mk_year() { YEAR_N=$((YEAR_N+1)); mk POST /api/academic-years "{\"name\":\"Module 10 $1 $TS\",\"startDate\":\"$((2040+YEAR_N))-04-01\",\"endDate\":\"$((2040+YEAR_N))-12-31\"}"; }
mk_subject() { mk POST /api/subjects "{\"name\":\"$1\",\"code\":\"$2\"}"; }
mk_stream() { mk POST /api/streams "{\"gradeId\":\"$1\",\"name\":\"$2\",\"code\":\"$3\"}"; }
mk_section() { mk POST /api/sections "{\"gradeId\":\"$1\",\"name\":\"Sec $2\",\"code\":\"$2\"}"; }
mk_stream_section() { mk POST /api/sections "{\"gradeId\":\"$1\",\"streamId\":\"$2\",\"name\":\"Sec $3\",\"code\":\"$3\"}"; }
mk_req() {   # mk_req GRADE STREAM|- SUBJECT PERIODS
  local stream=""; [ "$2" != "-" ] && stream=",\"streamId\":\"$2\""
  mk POST /api/subject-requirements "{\"gradeId\":\"$1\"$stream,\"subjectId\":\"$3\",\"periodsPerWeek\":$4}"
}

gen_periods() {   # gen_periods COUNT START_MINUTE LENGTH GAP
  jq -nc --argjson n "$1" --argjson s "$2" --argjson l "$3" --argjson g "$4" '
    def pad: tostring | if length < 2 then "0" + . else . end;
    def t: ((. / 60 | floor) | pad) + ":" + ((. % 60) | pad);
    [range(0; $n) as $i | {periodNumber: ($i + 1), startTime: (($s + $i * ($l + $g)) | t), endTime: (($s + $i * ($l + $g) + $l) | t)}]'
}
DAYS5='["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY"]'
DAYS6='["MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"]'
# sched YEAR DAYS PPD [BREAK] -> schedule configuration (5 x 6 = 30 slots, or 6 x 8 = 48 slots): working days + periods per day + ONE break position (default: after period ppd/2)
sched() {
  local brk="${4:-$(( $3 / 2 ))}"
  req POST /api/schedule-configs "{\"academicYearId\":\"$1\",\"workingDays\":$2,\"periodsPerDay\":$3,\"breakAfterPeriod\":$brk}"
  [ "$STATUS" = 201 ] || setup_fail "could not create the schedule configuration"
  CFG_ID=$(jqb '.data.id')
}
sched30() { sched "$1" "$DAYS5" 6; }
sched48() { sched "$1" "$DAYS6" 8; }

TEACHER_N=0
# new_teacher NAME [SUBJECT GRADE...] -> sets T_ID (and TS_ID); with a subject, makes the teacher eligible for each grade
new_teacher() {
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
# also_teaches TEACHER SUBJECT GRADE... -> add a second subject link + eligibility to an existing teacher
also_teaches() {
  local t="$1" subject="$2"; shift 2
  mk POST "/api/teachers/$t/subjects" "{\"subjectId\":\"$subject\",\"type\":\"SECONDARY\"}"; local ts=$ID
  for g in "$@"; do
    req POST "/api/teacher-subjects/$ts/grades" "{\"gradeId\":\"$g\"}"
    [ "$STATUS" = 201 ] || setup_fail "could not make teacher eligible for grade $g"
  done
}
assign() {   # assign SECTION REQUIREMENT TEACHER -> must succeed
  req POST /api/section-subject-teachers "{\"sectionId\":\"$1\",\"subjectRequirementId\":\"$2\",\"teacherId\":\"$3\"}"
  [ "$STATUS" = 201 ] || setup_fail "could not assign teacher ($1/$2/$3)"
  ASG_ID=$(jqb '.data.id')
}

# feas YEAR -> GET the report (sets STATUS, BODY)
feas() { req GET "/api/timetable-feasibility?academicYearId=$1"; }
# helpers over the last report
codes_err()  { jqb '[.data.errors[].code] | unique | sort | join(",")'; }
codes_warn() { jqb '[.data.warnings[].code] | unique | sort | join(",")'; }
has_err()    { jqb '[.data.errors[]   | select(.code=="'"$1"'")] | length > 0'; }
has_warn()   { jqb '[.data.warnings[] | select(.code=="'"$1"'")] | length > 0'; }
sum_of()     { jqb ".data.summary.$1"; }

race_pair() {   # race_pair M1 P1 B1 M2 P2 B2 -> two different simultaneous requests; sets RA RB and leaves bodies in $TMPDIR_M10/pa.body, pb.body
  ( curl -s -o "$TMPDIR_M10/pa.body" -w '%{http_code}' -X "$1" "$BASE_URL$2" -b "$JAR" ${3:+-H "Content-Type: application/json" -d "$3"} > "$TMPDIR_M10/pa.code" ) &
  ( curl -s -o "$TMPDIR_M10/pb.body" -w '%{http_code}' -X "$4" "$BASE_URL$5" -b "$JAR" ${6:+-H "Content-Type: application/json" -d "$6"} > "$TMPDIR_M10/pb.code" ) &
  wait
  RA=$(cat "$TMPDIR_M10/pa.code"); RB=$(cat "$TMPDIR_M10/pb.code")
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

req POST /api/admin/register "{\"schoolId\":\"$SCHOOL_ID\",\"setupToken\":\"$SETUP_TOKEN\",\"name\":\"M10 Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" /dev/null
[ "$STATUS" = 201 ] || setup_fail "admin register returned $STATUS"
unset SETUP_TOKEN
req POST /api/admin/login "{\"schoolId\":\"$SCHOOL_ID\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"
[ "$STATUS" = 200 ] || setup_fail "admin login returned $STATUS"
req GET /api/admin/me
[ "$STATUS" = 200 ] || setup_fail "session cookie not accepted by /api/admin/me ($STATUS)"
echo "  session established"

mk_subject "Mathematics" MATH; MATH=$ID
mk_subject "Science" SCI; SCI=$ID
mk_subject "English" ENG; ENG=$ID
mk_subject "Physics" PHY; PHY=$ID
mk_subject "Accountancy" ACC; ACC=$ID
SUBJ=()
for n in 1 2 3 4 5 6 7; do mk_subject "Filler $n" "F$n"; SUBJ+=("$ID"); done

# ── SCHEDULE ─────────────────────────────────────────────────────────────────
group schedule

mk_year "NoSchedule"; Y=$ID
feas "$Y"
expect "GET /api/timetable-feasibility for an empty year with no schedule -> 200" 200
expect_eq "  status is NOT_READY" "$(jqb '.data.status')" NOT_READY
expect_eq "  SCHEDULE_CONFIG_MISSING and NO_SECTIONS are reported" "$(codes_err)" "NO_SECTIONS,SCHEDULE_CONFIG_MISSING"
expect_eq "  weekly slots are unknown (null) rather than invented" "$(jqb '.data.limits.weeklySlots')" null
expect_eq "  teacher capacity falls back to the 32-period workload limit" "$(jqb '.data.limits.effectiveTeacherCapacity')" 32
expect_eq "  every error carries a code, message, hint and entity" "$(jqb '[.data.errors[] | select((.message|length)>0 and (.hint|length)>0 and (.entity.label|length)>0)] | length')" 2

mk_year "ScheduleOnly"; Y=$ID; sched30 "$Y"
feas "$Y"
expect "empty year WITH a schedule -> 200" 200
expect_eq "  only NO_SECTIONS (the schedule exists)" "$(codes_err)" "NO_SECTIONS"
expect_eq "  weeklySlots = 5 days x 6 periods = 30" "$(jqb '.data.limits.weeklySlots')" 30
expect_eq "  summary reflects the schedule" "$(jqb '(.data.summary.workingDays|tostring) + "/" + (.data.summary.periodsPerDay|tostring)')" "5/6"

mk_year "NoRequirements"; Y=$ID; sched30 "$Y"; mk_grade "$Y" "Grade 8"; G=$ID; mk_section "$G" A; mk_section "$G" B
feas "$Y"
expect "sections but no subject requirements -> 200" 200
expect_eq "  NO_SUBJECT_REQUIREMENTS (nothing to schedule)" "$(codes_err)" "NO_SUBJECT_REQUIREMENTS"
expect_eq "  the two sections are warnings, not errors" "$(codes_warn)" "SECTION_HAS_NO_REQUIREMENTS"
expect_eq "  total demand is 0" "$(sum_of totalDemandPeriods)" 0
not_run "schedule with zero working days / zero periods" \
  "The Module 9 API refuses to create such a schedule (it needs at least one day and one period); covered by the pure analyzer tests (NO_WORKING_DAYS, NO_PERIODS, SCHEDULE_CONFIG_INVALID)."

# ── DEMAND EXPANSION ─────────────────────────────────────────────────────────
group demand

# Grade 8, Mathematics 5 periods/week, sections A, B, C
mk_year "Demand"; Y=$ID; sched30 "$Y"; mk_grade "$Y" "Grade 8"; G=$ID
mk_section "$G" A; SA=$ID; mk_section "$G" B; SB=$ID; mk_section "$G" C; SC=$ID
mk_req "$G" - "$MATH" 5; RM=$ID
feas "$Y"
expect "one requirement (5/week) with three matching sections, no assignments -> 200" 200
expect_eq "  total demand is 15 periods (5 x 3 sections), NOT 5" "$(sum_of totalDemandPeriods)" 15
expect_eq "  there is only 1 requirement" "$(sum_of requirements)" 1
expect_eq "  none assigned: 0 assigned, 15 unassigned" "$(jqb '(.data.summary.assignedPeriods|tostring) + "/" + (.data.summary.unassignedPeriods|tostring)')" "0/15"
expect_eq "  each section carries its own 5 periods" "$(jqb '[.data.breakdown.sections[] | select(.demandPeriods==5)] | length')" 3
expect_eq "  the subject group is 3 sections / 15 periods" "$(jqb '.data.breakdown.subjectGroups[0] | (.sectionCount|tostring) + "/" + (.demandPeriods|tostring)')" "3/15"
expect_eq "  ONE grouped TEACHER_AUTO_ASSIGNED warning naming 3 sections and 15 unassigned periods" "$(jqb '[.data.warnings[] | select(.code=="TEACHER_AUTO_ASSIGNED")] | (length|tostring) + "/" + (.[0].details.sections|length|tostring) + "/" + (.[0].details.unassignedPeriods|tostring)')" "1/3/15"
expect_eq "  no MISSING_TEACHER_ASSIGNMENT error (explicit teachers are optional)" "$(jqb '[.data.errors[] | select(.code=="MISSING_TEACHER_ASSIGNMENT")] | length')" 0
expect_eq "  status NOT_READY because NOBODY is eligible (NO_ELIGIBLE_TEACHER)" "$(jqb '(.data.status) + "/" + ([.data.errors[] | select(.code=="NO_ELIGIBLE_TEACHER")] | length | tostring)')" "NOT_READY/1"

new_teacher "Rahul" "$MATH" "$G"; T1=$T_ID
new_teacher "Amit" "$MATH" "$G"; T2=$T_ID
new_teacher "Priya" "$MATH" "$G"; T3=$T_ID
assign "$SA" "$RM" "$T1"; assign "$SB" "$RM" "$T2"
feas "$Y"
expect "A and B assigned, C not -> 200" 200
expect_eq "  totalDemand 15, assignedDemand 10, unassignedDemand 5" "$(jqb '(.data.summary.totalDemandPeriods|tostring) + "/" + (.data.summary.assignedPeriods|tostring) + "/" + (.data.summary.unassignedPeriods|tostring)')" "15/10/5"
expect_eq "  the auto-assigned warning names only section C (5 periods)" "$(jqb '[.data.warnings[] | select(.code=="TEACHER_AUTO_ASSIGNED")][0] | (.details.sections|length|tostring) + "/" + (.details.unassignedPeriods|tostring)')" "1/5"
expect_eq "  section C row: demand 5, assigned 0, unassigned 5" "$(jqb '.data.breakdown.sections[] | select(.label|test("Sec C")) | (.demandPeriods|tostring) + "/" + (.assignedPeriods|tostring) + "/" + (.unassignedPeriods|tostring)')" "5/0/5"
expect_eq "  status READY: an eligible teacher exists for section C, so no explicit assignment is needed" "$(jqb '(.data.status) + "/" + (.data.errors|length|tostring)')" "READY/0"

assign "$SC" "$RM" "$T3"
feas "$Y"
expect "all three sections assigned to three different teachers -> 200" 200
expect_eq "  READY with no errors" "$(jqb '(.data.status) + "/" + (.data.errors|length|tostring)')" "READY/0"
expect_eq "  totalDemand 15 = assigned 15, unassigned 0" "$(jqb '(.data.summary.totalDemandPeriods|tostring) + "/" + (.data.summary.assignedPeriods|tostring) + "/" + (.data.summary.unassignedPeriods|tostring)')" "15/15/0"
expect_eq "  multiple teachers across sections: three teachers with 5 periods each" "$(jqb '[.data.breakdown.teachers[] | select(.assignedPeriods==5 and .assignmentCount==1)] | length')" 3
expect_eq "  statusMeaning says READY does not guarantee a timetable" "$(jqb '.data.statusMeaning | contains("does NOT guarantee")')" true
expect_eq "  notChecked lists what is left to the solver" "$(jqb '.data.notChecked | length >= 5')" true
READY_YEAR=$Y; READY_GRADE=$G

# the same teacher on every section
mk_year "SameTeacher"; Y=$ID; sched30 "$Y"; mk_grade "$Y" "Grade 8"; G=$ID
mk_section "$G" A; SA=$ID; mk_section "$G" B; SB=$ID; mk_section "$G" C; SC=$ID
mk_req "$G" - "$MATH" 5; RM=$ID
new_teacher "Solo" "$MATH" "$G"; T1=$T_ID
assign "$SA" "$RM" "$T1"; assign "$SB" "$RM" "$T1"; assign "$SC" "$RM" "$T1"
feas "$Y"
expect "the same teacher assigned to all three sections -> 200" 200
expect_eq "  one teacher row: 3 assignments, 15 periods" "$(jqb '.data.breakdown.teachers | (length|tostring) + "/" + (.[0].assignmentCount|tostring) + "/" + (.[0].assignedPeriods|tostring)')" "1/3/15"
expect_eq "  a teacher teaching several sections is allowed (READY)" "$(jqb '.data.status')" READY
expect_eq "  remaining capacity is 30 - 15 = 15 (5 x 6 = 30 weekly slots)" "$(jqb '.data.breakdown.teachers[0].remainingCapacity')" 15

# streamed grade: a requirement applies only to sections of ITS stream
mk_year "Streamed"; Y=$ID; sched30 "$Y"; mk_grade "$Y" "Grade 11"; G=$ID
mk_stream "$G" "Science" SCI; ST_SCI=$ID; mk_stream "$G" "Commerce" COM; ST_COM=$ID
mk_stream_section "$G" "$ST_SCI" A; SS1=$ID; mk_stream_section "$G" "$ST_SCI" B; SS2=$ID; mk_stream_section "$G" "$ST_COM" A; SC1=$ID
mk_req "$G" "$ST_SCI" "$PHY" 6; RP=$ID; mk_req "$G" "$ST_COM" "$ACC" 6; RA=$ID
feas "$Y"
expect "streamed grade: Physics (Science) + Accountancy (Commerce) -> 200" 200
expect_eq "  total demand = 2 Science sections x 6 + 1 Commerce section x 6 = 18" "$(sum_of totalDemandPeriods)" 18
expect_eq "  Physics covers only the 2 Science sections (12 periods)" "$(jqb '.data.breakdown.subjectGroups[] | select(.subjectName=="Physics") | (.sectionCount|tostring) + "/" + (.demandPeriods|tostring)')" "2/12"
expect_eq "  Accountancy covers only the Commerce section (6 periods)" "$(jqb '.data.breakdown.subjectGroups[] | select(.subjectName=="Accountancy") | (.sectionCount|tostring) + "/" + (.demandPeriods|tostring)')" "1/6"
expect_eq "  every section has exactly one applicable requirement of 6 periods" "$(jqb '[.data.breakdown.sections[] | select(.requirementCount==1 and .demandPeriods==6)] | length')" 3
expect_eq "  two grouped auto-assignment warnings (one per requirement)" "$(jqb '[.data.warnings[] | select(.code=="TEACHER_AUTO_ASSIGNED")] | length')" 2
new_teacher "PhysicsT" "$PHY" "$G"; TP=$T_ID
new_teacher "AccountT" "$ACC" "$G"; TA=$T_ID
assign "$SS1" "$RP" "$TP"; assign "$SS2" "$RP" "$TP"; assign "$SC1" "$RA" "$TA"
feas "$Y"
expect "streamed grade fully assigned -> 200" 200
expect_eq "  READY, 18 of 18 periods assigned" "$(jqb '(.data.status) + "/" + (.data.summary.assignedPeriods|tostring) + "/" + (.data.summary.totalDemandPeriods|tostring)')" "READY/18/18"
expect_eq "  the Physics teacher carries 12 periods, the accountancy teacher 6" "$(jqb '[.data.breakdown.teachers[] | .assignedPeriods] | sort | join(",")')" "6,12"

# several requirements on one section add up
mk_year "SumOfSubjects"; Y=$ID; sched30 "$Y"; mk_grade "$Y" "Grade 8"; G=$ID; mk_section "$G" A
mk_req "$G" - "$MATH" 5 >/dev/null; mk_req "$G" - "$SCI" 4 >/dev/null; mk_req "$G" - "$ENG" 6 >/dev/null
feas "$Y"
expect "one section with three requirements -> 200" 200
expect_eq "  section demand is 5 + 4 + 6 = 15" "$(jqb '.data.breakdown.sections[0] | (.demandPeriods|tostring) + "/" + (.requirementCount|tostring)')" "15/3"

# ── CAPACITY ─────────────────────────────────────────────────────────────────
group capacity

cap_year() {   # cap_year LABEL P1 P2 ... -> one section in a 30-slot week with one requirement per period count
  local label="$1"; shift
  mk_year "$label"; CY=$ID; sched30 "$CY"; mk_grade "$CY" "Grade 8"; local g=$ID; mk_section "$g" A
  local i=0
  for p in "$@"; do mk_req "$g" - "${SUBJ[$i]}" "$p" >/dev/null; i=$((i+1)); done
}
cap_year "Cap29" 5 5 5 5 5 4; feas "$CY"
expect "section demand 29 in 30 slots -> 200" 200
expect_eq "  no capacity error and no full-capacity warning" "$(jqb '(([.data.errors[]|select(.code=="SECTION_CAPACITY_EXCEEDED")]|length) + ([.data.warnings[]|select(.code=="SECTION_AT_FULL_CAPACITY")]|length))')" 0
cap_year "Cap30" 5 5 5 5 5 5; feas "$CY"
expect "section demand exactly 30 in 30 slots -> 200" 200
expect_eq "  allowed: SECTION_AT_FULL_CAPACITY warning, no capacity error" "$(has_warn SECTION_AT_FULL_CAPACITY)/$(has_err SECTION_CAPACITY_EXCEEDED)" "true/false"
cap_year "Cap31" 5 5 5 5 5 5 1; feas "$CY"
expect "section demand 31 in 30 slots -> 200" 200
expect_eq "  SECTION_CAPACITY_EXCEEDED with excess 1" "$(jqb '[.data.errors[]|select(.code=="SECTION_CAPACITY_EXCEEDED")][0] | (.details.demandPeriods|tostring) + "/" + (.details.weeklySlots|tostring) + "/" + (.details.excess|tostring)')" "31/30/1"
expect_eq "  the error names the section, a hint and the contributing requirements" "$(jqb '[.data.errors[]|select(.code=="SECTION_CAPACITY_EXCEEDED")][0] | ((.hint|length) > 0) and ((.details.requirements|length) == 7)')" true

teacher_load_year() {   # teacher_load_year LABEL SCHED(30|48) SECTIONS PERIODS -> one teacher assigned to every section
  local label="$1" slots="$2" n="$3" p="$4"
  mk_year "$label"; TY=$ID; if [ "$slots" = 48 ]; then sched48 "$TY"; else sched30 "$TY"; fi
  mk_grade "$TY" "Grade 8"; local g=$ID; mk_req "$g" - "$MATH" "$p"; local r=$ID
  new_teacher "Loaded" "$MATH" "$g"; local t=$T_ID
  for i in $(seq 1 "$n"); do mk_section "$g" "S$i"; assign "$ID" "$r" "$t"; done
}
teacher_load_year "Load32" 48 4 8; feas "$TY"
expect "teacher load exactly 32 on a 48-slot week -> 200" 200
expect_eq "  allowed: TEACHER_AT_FULL_CAPACITY warning, no capacity error" "$(has_warn TEACHER_AT_FULL_CAPACITY)/$(has_err TEACHER_CAPACITY_EXCEEDED)" "true/false"
expect_eq "  the year is READY (all deterministic checks pass)" "$(jqb '.data.status')" READY
teacher_load_year "Load33" 48 3 11; feas "$TY"
expect "teacher load 33 on a 48-slot week -> 200" 200
expect_eq "  TEACHER_CAPACITY_EXCEEDED: limit 32, excess 1, source MAX_WORKLOAD" "$(jqb '[.data.errors[]|select(.code=="TEACHER_CAPACITY_EXCEEDED")][0] | (.details.assignedPeriods|tostring) + "/" + (.details.capacity|tostring) + "/" + (.details.excess|tostring) + "/" + .details.limitSource')" "33/32/1/MAX_WORKLOAD"
teacher_load_year "LoadSlots" 30 2 16; feas "$TY"
expect "teacher load 32 on a 30-slot week -> 200" 200
expect_eq "  TEACHER_CAPACITY_EXCEEDED because of the weekly slots (capacity 30, source WEEKLY_SLOTS)" "$(jqb '[.data.errors[]|select(.code=="TEACHER_CAPACITY_EXCEEDED")][0] | (.details.capacity|tostring) + "/" + .details.limitSource')" "30/WEEKLY_SLOTS"
expect_eq "  effective teacher capacity is min(32, 30) = 30" "$(jqb '.data.limits.effectiveTeacherCapacity')" 30

mk_year "BigRequirement"; Y=$ID; sched48 "$Y"; mk_grade "$Y" "Grade 8"; G=$ID; mk_section "$G" A; mk_req "$G" - "$MATH" 40 >/dev/null
feas "$Y"
expect "a 40-period requirement (Module 7 allows up to 40) on a 48-slot week -> 200" 200
expect_eq "  REQUIREMENT_EXCEEDS_TEACHER_CAPACITY: no teacher can do more than 32" "$(has_err REQUIREMENT_EXCEEDS_TEACHER_CAPACITY)" true

# ── ASSIGNED TEACHERS ────────────────────────────────────────────────────────
group assignments

mk_year "Inactive"; Y=$ID; sched30 "$Y"; mk_grade "$Y" "Grade 8"; G=$ID; mk_section "$G" A; SA=$ID; mk_req "$G" - "$MATH" 5; RM=$ID
new_teacher "Fading" "$MATH" "$G"; T1=$T_ID; assign "$SA" "$RM" "$T1"
feas "$Y"; expect "assignment to an active teacher -> 200" 200
expect_eq "  READY" "$(jqb '.data.status')" READY
req PATCH "/api/teachers/$T1" '{"isActive":false}'; [ "$STATUS" = 200 ] || setup_fail "could not deactivate"
feas "$Y"
expect "the assigned teacher is deactivated afterwards -> 200" 200
expect_eq "  INACTIVE_ASSIGNED_TEACHER (grouped per teacher), NOT_READY" "$(jqb '(.data.errors | map(.code) | join(",")) + "/" + .data.status')" "INACTIVE_ASSIGNED_TEACHER/NOT_READY"
expect_eq "  the assignment still counts as assigned demand (5 of 5)" "$(jqb '.data.summary.assignedPeriods')" 5
expect_eq "  the report points at the teacher and gives a hint" "$(jqb '.data.errors[0] | (.entity.type) + "/" + ((.hint|length) > 0 | tostring)')" "TEACHER/true"
req PATCH "/api/teachers/$T1" '{"isActive":true}'
feas "$Y"
expect_eq "  reactivating the teacher makes the year READY again" "$(jqb '.data.status')" READY

# ── ELIGIBLE-TEACHER CAPACITY ────────────────────────────────────────────────
group eligibility

mk_year "NoEligible"; Y=$ID; sched48 "$Y"; mk_grade "$Y" "Grade 8"; G=$ID
for c in A B C D; do mk_section "$G" "$c"; done; mk_req "$G" - "$MATH" 5 >/dev/null
feas "$Y"
expect "unassigned demand and nobody eligible -> 200" 200
expect_eq "  NO_ELIGIBLE_TEACHER for the subject group (20 periods, 4 sections)" "$(jqb '[.data.errors[]|select(.code=="NO_ELIGIBLE_TEACHER")][0] | (.details.unassignedPeriods|tostring) + "/" + (.details.sections|tostring)')" "20/4"
new_teacher "WrongGrade" "$MATH"   # linked to no grade
new_teacher "Inactive" "$MATH" "$G"; req PATCH "/api/teachers/$T_ID" '{"isActive":false}'
feas "$Y"
expect_eq "  a teacher with no grade eligibility and an inactive eligible teacher still leave the group uncovered" "$(has_err NO_ELIGIBLE_TEACHER)" true

mk_year "GroupShort"; Y=$ID; sched48 "$Y"; mk_grade "$Y" "Grade 8"; G=$ID
for c in A B C D; do mk_section "$G" "$c"; done; mk_req "$G" - "$MATH" 10 >/dev/null
new_teacher "OnlyOne" "$MATH" "$G"
feas "$Y"
expect "four sections x 10 periods unassigned, one eligible teacher (capacity 32) -> 200" 200
expect_eq "  ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT (GROUP): 40 needed, 32 available, shortfall 8" "$(jqb '[.data.errors[]|select(.code=="ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT")][0] | .details.kind + "/" + (.details.unassignedPeriods|tostring) + "/" + (.details.remainingCapacity|tostring) + "/" + (.details.shortfall|tostring)')" "GROUP/40/32/8"
expect_eq "  the subject-group breakdown shows 1 eligible teacher with 32 remaining" "$(jqb '.data.breakdown.subjectGroups[0] | (.eligibleTeacherCount|tostring) + "/" + (.eligibleRemainingCapacity|tostring)')" "1/32"

# the eligible teacher already carries 20 periods elsewhere: only 12 left for 15 needed
mk_year "ExistingLoad"; Y=$ID; sched48 "$Y"; mk_grade "$Y" "Grade 8"; G=$ID
for c in A B C; do mk_section "$G" "$c"; done; mk_req "$G" - "$MATH" 5 >/dev/null
mk_grade "$Y" "Grade 9"; G9=$ID; mk_section "$G9" A; SA9=$ID; mk_req "$G9" - "$SCI" 20; R9=$ID
new_teacher "Busy" "$MATH" "$G"; TB=$T_ID; also_teaches "$TB" "$SCI" "$G9"; assign "$SA9" "$R9" "$TB"
feas "$Y"
expect "teacher already loaded with 20 periods, 15 more unassigned -> 200" 200
expect_eq "  remaining capacity accounts for the existing load (32 - 20 = 12 < 15)" "$(jqb '[.data.errors[]|select(.code=="ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT")][0] | (.details.remainingCapacity|tostring) + "/" + (.details.unassignedPeriods|tostring)')" "12/15"

# pooled: two groups that each fit one teacher but not together
mk_year "Pooled"; Y=$ID; sched48 "$Y"; mk_grade "$Y" "Grade 8"; G=$ID
for c in A B C D; do mk_section "$G" "$c"; done; mk_req "$G" - "$MATH" 5 >/dev/null; mk_req "$G" - "$SCI" 5 >/dev/null
new_teacher "Shared" "$MATH" "$G"; TSH=$T_ID; also_teaches "$TSH" "$SCI" "$G"
feas "$Y"
expect "Math (20) and Science (20) both unassigned, one shared eligible teacher -> 200" 200
expect_eq "  each group fits individually (no GROUP error)" "$(jqb '[.data.errors[]|select(.code=="ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT" and .details.kind=="GROUP")]|length')" 0
expect_eq "  POOLED error: 40 needed, 32 available, shortfall 8" "$(jqb '[.data.errors[]|select(.code=="ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT" and .details.kind=="POOLED")][0] | (.details.unassignedPeriods|tostring) + "/" + (.details.remainingCapacity|tostring) + "/" + (.details.shortfall|tostring)')" "40/32/8"
expect_eq "  the bottleneck names both groups and the shared teacher" "$(jqb '[.data.errors[]|select(.details.kind=="POOLED")][0].details | (.groups|length|tostring) + "/" + (.teachers|length|tostring)')" "2/1"
expect_eq "  the explanation states it is a relaxation" "$(jqb '[.data.errors[]|select(.details.kind=="POOLED")][0].details.note | contains("relaxation")')" true
new_teacher "ScienceOnly" "$SCI" "$G"
feas "$Y"
expect "a second Science-eligible teacher is added -> 200" 200
expect_eq "  the competition is resolved: no eligible-capacity error" "$(jqb '[.data.errors[]|select(.code=="ELIGIBLE_TEACHER_CAPACITY_INSUFFICIENT" or .code=="NO_ELIGIBLE_TEACHER")]|length')" 0
expect_eq "  no error remains: the unassigned sections will be given an eligible teacher automatically" "$(codes_err)" ""

# ── STRUCTURE (mode drift, orphans, warnings) ────────────────────────────────
group structure

# requirement first, then a streamed section: Module 5/7 allow it, so mode drift is possible
mk_year "Drift"; Y=$ID; sched30 "$Y"; mk_grade "$Y" "Grade X"; GX=$ID; mk_req "$GX" - "$MATH" 4 >/dev/null
mk_stream "$GX" "XS" XS; XS=$ID; mk_stream_section "$GX" "$XS" XA >/dev/null
feas "$Y"
expect "non-stream requirement, then a streamed section is added (mode drift) -> 200" 200
expect_eq "  the streamed section has no applicable requirement (warning REQUIREMENTS_ARE_NOT_STREAM_SPECIFIC)" "$(jqb '[.data.warnings[]|select(.code=="SECTION_HAS_NO_REQUIREMENTS")][0].details.reason')" REQUIREMENTS_ARE_NOT_STREAM_SPECIFIC
expect_eq "  the requirement has no section (warning GRADE_SECTIONS_ARE_ALL_IN_STREAMS)" "$(jqb '[.data.warnings[]|select(.code=="REQUIREMENT_HAS_NO_SECTIONS")][0].details.reason')" GRADE_SECTIONS_ARE_ALL_IN_STREAMS
expect_eq "  no demand is invented for the mismatched pair" "$(sum_of totalDemandPeriods)" 0

mk_year "DriftReverse"; Y=$ID; sched30 "$Y"; mk_grade "$Y" "Grade Y"; GY=$ID; mk_stream "$GY" "YS" YS; YS=$ID; mk_req "$GY" "$YS" "$MATH" 4 >/dev/null
mk_section "$GY" YA >/dev/null
feas "$Y"
expect "stream requirement, then a NON-streamed section is added (mode drift) -> 200" 200
expect_eq "  SECTION_NOT_IN_STREAM warning" "$(jqb '[.data.warnings[]|select(.code=="SECTION_HAS_NO_REQUIREMENTS")][0].details.reason')" SECTION_NOT_IN_STREAM
expect_eq "  NO_SECTION_IN_THIS_STREAM warning" "$(jqb '[.data.warnings[]|select(.code=="REQUIREMENT_HAS_NO_SECTIONS")][0].details.reason')" NO_SECTION_IN_THIS_STREAM

mk_year "NoSectionsForReq"; Y=$ID; sched30 "$Y"; mk_grade "$Y" "Grade 8"; G=$ID; mk_section "$G" A >/dev/null; mk_req "$G" - "$MATH" 5 >/dev/null
mk_grade "$Y" "Grade 9"; G9=$ID; mk_req "$G9" - "$SCI" 5 >/dev/null
feas "$Y"
expect "a requirement for a grade that has no sections -> 200" 200
expect_eq "  REQUIREMENT_HAS_NO_SECTIONS (GRADE_HAS_NO_SECTIONS) is a warning, not an error" "$(jqb '[.data.warnings[]|select(.code=="REQUIREMENT_HAS_NO_SECTIONS")][0].details.reason')/$(has_err REQUIREMENT_HAS_NO_SECTIONS)" "GRADE_HAS_NO_SECTIONS/false"
expect_eq "  the orphan requirement adds no demand (only Grade 8's 5 periods)" "$(sum_of totalDemandPeriods)" 5

# warnings never block READY
mk_grade "$READY_YEAR" "Grade Z"; mk_section "$ID" "STRAY"   # a grade with no requirements: the section contributes no demand
feas "$READY_YEAR"
expect "READY year gets a stray section with no requirement -> 200" 200
expect_eq "  warnings never block: still READY, with a SECTION_HAS_NO_REQUIREMENTS warning" "$(jqb '.data.status')/$(has_warn SECTION_HAS_NO_REQUIREMENTS)" "READY/true"

# ── LIFECYCLE ────────────────────────────────────────────────────────────────
group lifecycle

feas "$READY_YEAR"
expect "DRAFT year" 200
expect_eq "  READY and no ACADEMIC_YEAR_NOT_DRAFT warning" "$(jqb '.data.status')/$(has_warn ACADEMIC_YEAR_NOT_DRAFT)" "READY/false"
req PATCH "/api/academic-years/$READY_YEAR" '{"status":"ACTIVE"}'; [ "$STATUS" = 200 ] || setup_fail "could not activate the year"
feas "$READY_YEAR"
expect "ACTIVE year is readable" 200
expect_eq "  analysed normally (READY) with an ACADEMIC_YEAR_NOT_DRAFT warning" "$(jqb '.data.status')/$(has_warn ACADEMIC_YEAR_NOT_DRAFT)/$(jqb '.data.academicYear.status')" "READY/true/ACTIVE"
req PATCH "/api/academic-years/$READY_YEAR" '{"status":"COMPLETED"}'; [ "$STATUS" = 200 ] || setup_fail "could not complete the year"
feas "$READY_YEAR"
expect "COMPLETED year is readable" 200
expect_eq "  analysed normally (READY) with an ACADEMIC_YEAR_NOT_DRAFT warning" "$(jqb '.data.status')/$(has_warn ACADEMIC_YEAR_NOT_DRAFT)/$(jqb '.data.academicYear.status')" "READY/true/COMPLETED"

# ── RESPONSE SHAPE ───────────────────────────────────────────────────────────
group shape

mk_year "Shape"; Y=$ID; sched30 "$Y"; mk_grade "$Y" "Grade 8"; G=$ID; mk_section "$G" A >/dev/null; mk_req "$G" - "$MATH" 5 >/dev/null
feas "$Y"
expect "report for a small incomplete year" 200
expect_eq "  envelope has success, message and data" "$(jqb '(.success|tostring) + "/" + (.message|length > 0|tostring) + "/" + (.data|type)')" "true/true/object"
expect_eq "  top-level report keys" "$(jqb '.data | keys | join(",")')" "academicYear,breakdown,errors,generatedAt,limits,notChecked,status,statusMeaning,summary,warnings"
expect_eq "  breakdown always has sections, teachers and subjectGroups" "$(jqb '.data.breakdown | keys | join(",")')" "sections,subjectGroups,teachers"
expect_eq "  summary keys" "$(jqb '.data.summary | keys | join(",")')" "assignedPeriods,assignments,errorCount,grades,periodsPerDay,requirements,sections,teachersWithAssignments,totalDemandPeriods,unassignedPeriods,warningCount,weeklySlots,workingDays"
expect_eq "  errorCount/warningCount match the lists" "$(jqb '((.data.summary.errorCount == (.data.errors|length)) and (.data.summary.warningCount == (.data.warnings|length)))')" true
expect_eq "  the academic year block carries id, name and status" "$(jqb '.data.academicYear | (keys | join(","))')" "id,name,status"
expect_eq "  issue details survive serialization (free-form keys are kept)" "$(jqb '[.data.warnings[]|select(.code=="TEACHER_AUTO_ASSIGNED")][0].details | has("unassignedPeriods") and has("sections")')" true
SECS=$(curl -s -o /dev/null -w '%{time_total}' -b "$JAR" "$BASE_URL/api/timetable-feasibility?academicYearId=$Y")
info "feasibility response time for a small year: ${SECS}s"

# ── AUTH / VALIDATION ────────────────────────────────────────────────────────
group auth

req GET "/api/timetable-feasibility?academicYearId=$READY_YEAR" "" /dev/null; expect "without a session -> 401" 401
req GET "/api/timetable-feasibility"; expect "missing academicYearId -> 400" 400
expect_eq "  field-level error under errors.academicYearId" "$(jqb '.errors.academicYearId|length > 0')" true
req GET "/api/timetable-feasibility?academicYearId=not-a-uuid"; expect "malformed academicYearId -> 400" 400
req GET "/api/timetable-feasibility?academicYearId=$UUID0"; expect "unknown academic year -> 404" 404
req GET "/api/timetable-feasibility?academicYearId=$READY_YEAR&schoolId=$UUID0"; expect "a client-supplied schoolId is ignored, never trusted -> 200" 200
req POST "/api/timetable-feasibility?academicYearId=$READY_YEAR"; expect "POST is not an endpoint (read-only GET) -> 404" 404
GROUP=isolation
not_run "cross-school isolation (foreign academic year -> 403; foreign data never counted)" \
  "Cannot create a second school through the API within the bootstrap rate limit; verified once with a temporary direct-service utility, not part of this suite."
GROUP=auth

# ── DETERMINISM ──────────────────────────────────────────────────────────────
group determinism

feas "$Y"; FIRST=$(echo "$BODY" | jq -cS '.data | del(.generatedAt)')
feas "$Y"; SECOND=$(echo "$BODY" | jq -cS '.data | del(.generatedAt)')
expect_eq "the same database state gives an identical report (ignoring generatedAt)" "$SECOND" "$FIRST"
feas "$READY_YEAR"; A1=$(echo "$BODY" | jq -cS '.data | del(.generatedAt)')
feas "$READY_YEAR"; A2=$(echo "$BODY" | jq -cS '.data | del(.generatedAt)')
expect_eq "  also for a READY year" "$A2" "$A1"
feas "$Y"
expect_eq "  generatedAt is present and parses as a date" "$(jqb '.data.generatedAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601 > 0')" true

# ── SNAPSHOT CONSISTENCY ─────────────────────────────────────────────────────
group consistency

echo "Reading the report while the schedule is rewritten between a 30-slot and a 48-slot grid ($SNAPSHOT_ROUNDS rounds)..."
mk_year "Snapshot"; SY=$ID; sched30 "$SY"; SCFG=$CFG_ID; mk_grade "$SY" "Grade 8"; SG=$ID; mk_section "$SG" A >/dev/null; mk_req "$SG" - "$MATH" 31 >/dev/null
GRID30="{\"workingDays\":$DAYS5,\"periodsPerDay\":6,\"breakAfterPeriod\":3}"
GRID48="{\"workingDays\":$DAYS6,\"periodsPerDay\":8,\"breakAfterPeriod\":4}"
BAD_INVALID=0; BAD_PAIR=0; BAD_STATUS=0; SEEN30=0; SEEN48=0
for i in $(seq 1 "$SNAPSHOT_ROUNDS"); do
  if [ $((i % 2)) = 1 ]; then NEXT="$GRID48"; else NEXT="$GRID30"; fi
  race_pair GET "/api/timetable-feasibility?academicYearId=$SY" "" PATCH "/api/schedule-configs/$SCFG" "$NEXT"
  [ "$RA" = 200 ] && [ "$RB" = 200 ] || BAD_STATUS=$((BAD_STATUS+1))
  W=$(jq -r '.data.limits.weeklySlots' "$TMPDIR_M10/pa.body")
  INV=$(jq -r '[.data.errors[]|select(.code=="SCHEDULE_CONFIG_INVALID")]|length' "$TMPDIR_M10/pa.body")
  CAPERR=$(jq -r '[.data.errors[]|select(.code=="SECTION_CAPACITY_EXCEEDED")]|length' "$TMPDIR_M10/pa.body")
  [ "$INV" = 0 ] || BAD_INVALID=$((BAD_INVALID+1))
  if [ "$W" = 30 ]; then SEEN30=$((SEEN30+1)); [ "$CAPERR" = 1 ] || BAD_PAIR=$((BAD_PAIR+1))
  elif [ "$W" = 48 ]; then SEEN48=$((SEEN48+1)); [ "$CAPERR" = 0 ] || BAD_PAIR=$((BAD_PAIR+1))
  else BAD_PAIR=$((BAD_PAIR+1)); fi
  echo "  round $i: report saw weeklySlots=$W (invalid-schedule errors=$INV, capacity errors=$CAPERR)"
done
STATUS="-"
expect_eq "every concurrent report and PATCH succeeded" "$BAD_STATUS" 0
expect_eq "no report ever mixed days from one schedule with periods from another (no SCHEDULE_CONFIG_INVALID)" "$BAD_INVALID" 0
expect_eq "every report is internally consistent (30 slots <=> capacity error, 48 slots <=> none)" "$BAD_PAIR" 0
info "snapshot race over $SNAPSHOT_ROUNDS rounds: reports saw the 30-slot grid $SEEN30 time(s) and the 48-slot grid $SEEN48 time(s)"

DONE_OK=1
