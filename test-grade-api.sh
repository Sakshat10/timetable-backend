#!/bin/bash

echo "=== Testing Grade API ==="
echo ""

BASE_URL="http://localhost:4000"
COOKIES_FILE=$(mktemp)

# Cleanup function
cleanup() {
  rm -f "$COOKIES_FILE"
}
trap cleanup EXIT

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass() {
  echo -e "${GREEN}✓ PASS${NC}: $1"
}

fail() {
  echo -e "${RED}✗ FAIL${NC}: $1"
}

warn() {
  echo -e "${YELLOW}⚠ WARN${NC}: $1"
}

echo "====================================="
echo "SETUP: Using Existing School/Admin"
echo "====================================="
echo ""

# Use environment variables or defaults
SCHOOL_ID="${SCHOOL_ID:-f91e33e6-0ee3-4382-9f85-006ff58485c0}"
ADMIN_EMAIL="${ADMIN_EMAIL:-test@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-TestPassword123}"

echo "Attempting login with existing credentials..."
LOGIN_RESPONSE=$(curl -s -c "$COOKIES_FILE" -X POST $BASE_URL/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "schoolId": "'$SCHOOL_ID'",
    "email": "'$ADMIN_EMAIL'",
    "password": "'$ADMIN_PASSWORD'"
  }')

LOGIN_SUCCESS=$(echo "$LOGIN_RESPONSE" | jq -r '.success // false')

if [ "$LOGIN_SUCCESS" != "true" ]; then
  warn "Could not login with provided credentials"
  echo "Please set environment variables: SCHOOL_ID, ADMIN_EMAIL, ADMIN_PASSWORD"
  echo "Or run manual tests after authentication"
  exit 1
fi

pass "Admin logged in successfully"
echo ""

echo "====================================="
echo "SETUP: Create DRAFT Academic Year"
echo "====================================="
echo ""

AY_RESPONSE=$(curl -s -b "$COOKIES_FILE" -X POST $BASE_URL/api/academic-years \
  -H "Content-Type: application/json" \
  -d '{
    "name": "TEST-AY-'$(date +%s)'",
    "startDate": "2026-04-01",
    "endDate": "2027-03-31"
  }')

AY_SUCCESS=$(echo "$AY_RESPONSE" | jq -r '.success // false')
AY_ID=$(echo "$AY_RESPONSE" | jq -r '.data.id // ""')

if [ "$AY_SUCCESS" = "true" ] && [ -n "$AY_ID" ]; then
  pass "Academic year created: $AY_ID"
else
  fail "Could not create academic year"
  echo "$AY_RESPONSE" | jq '.'
  exit 1
fi
echo ""

echo "====================================="
echo "TEST 1: Create Grade"
echo "====================================="
echo ""

echo "Test 1.1: Create valid grade"
GRADE1=$(curl -s -b "$COOKIES_FILE" -X POST $BASE_URL/api/grades \
  -H "Content-Type: application/json" \
  -d '{
    "academicYearId": "'$AY_ID'",
    "name": "Grade 6",
    "displayOrder": 6
  }')
echo "$GRADE1" | jq '.'

GRADE1_SUCCESS=$(echo "$GRADE1" | jq -r '.success // false')
GRADE1_ID=$(echo "$GRADE1" | jq -r '.data.id // ""')

if [ "$GRADE1_SUCCESS" = "true" ] && [ -n "$GRADE1_ID" ]; then
  pass "Grade created"
else
  fail "Grade creation failed"
fi
echo ""

echo "Test 1.2: Create grade without authentication"
GRADE_NOAUTH=$(curl -s -X POST $BASE_URL/api/grades \
  -H "Content-Type: application/json" \
  -d '{
    "academicYearId": "'$AY_ID'",
    "name": "Grade 7",
    "displayOrder": 7
  }')
echo "$GRADE_NOAUTH" | jq '.'

if [ "$(echo "$GRADE_NOAUTH" | jq -r '.success // false')" = "false" ]; then
  pass "Unauthenticated request rejected"
else
  fail "Unauthenticated request should be rejected"
fi
echo ""

echo "Test 1.3: Create grade with duplicate name"
sleep 1
GRADE_DUP_NAME=$(curl -s -b "$COOKIES_FILE" -X POST $BASE_URL/api/grades \
  -H "Content-Type: application/json" \
  -d '{
    "academicYearId": "'$AY_ID'",
    "name": "Grade 6",
    "displayOrder": 7
  }')
echo "$GRADE_DUP_NAME" | jq '.'

if [ "$(echo "$GRADE_DUP_NAME" | jq -r '.success // false')" = "false" ]; then
  pass "Duplicate name rejected (409)"
else
  fail "Duplicate name should be rejected"
fi
echo ""

echo "Test 1.4: Create grade with duplicate display order"
sleep 1
GRADE_DUP_ORDER=$(curl -s -b "$COOKIES_FILE" -X POST $BASE_URL/api/grades \
  -H "Content-Type: application/json" \
  -d '{
    "academicYearId": "'$AY_ID'",
    "name": "Grade 7",
    "displayOrder": 6
  }')
echo "$GRADE_DUP_ORDER" | jq '.'

if [ "$(echo "$GRADE_DUP_ORDER" | jq -r '.success // false')" = "false" ]; then
  pass "Duplicate display order rejected (409)"
else
  fail "Duplicate display order should be rejected"
fi
echo ""

echo "Test 1.5: Create grade with missing name"
sleep 1
GRADE_NO_NAME=$(curl -s -b "$COOKIES_FILE" -X POST $BASE_URL/api/grades \
  -H "Content-Type: application/json" \
  -d '{
    "academicYearId": "'$AY_ID'",
    "displayOrder": 8
  }')
echo "$GRADE_NO_NAME" | jq '.'

if [ "$(echo "$GRADE_NO_NAME" | jq -r '.success // false')" = "false" ]; then
  pass "Missing name rejected"
else
  fail "Missing name should be rejected"
fi
echo ""

echo "Test 1.6: Create grade with invalid display order (0)"
sleep 1
GRADE_ZERO=$(curl -s -b "$COOKIES_FILE" -X POST $BASE_URL/api/grades \
  -H "Content-Type: application/json" \
  -d '{
    "academicYearId": "'$AY_ID'",
    "name": "Grade 0",
    "displayOrder": 0
  }')
echo "$GRADE_ZERO" | jq '.'

if [ "$(echo "$GRADE_ZERO" | jq -r '.success // false')" = "false" ]; then
  pass "Invalid display order (0) rejected"
else
  fail "Display order 0 should be rejected"
fi
echo ""

echo "Test 1.7: Create grade with negative display order"
sleep 1
GRADE_NEG=$(curl -s -b "$COOKIES_FILE" -X POST $BASE_URL/api/grades \
  -H "Content-Type: application/json" \
  -d '{
    "academicYearId": "'$AY_ID'",
    "name": "Grade -1",
    "displayOrder": -1
  }')
echo "$GRADE_NEG" | jq '.'

if [ "$(echo "$GRADE_NEG" | jq -r '.success // false')" = "false" ]; then
  pass "Negative display order rejected"
else
  fail "Negative display order should be rejected"
fi
echo ""

echo "====================================="
echo "TEST 2: List Grades"
echo "====================================="
echo ""

echo "Test 2.1: List all grades"
GRADES_LIST=$(curl -s -b "$COOKIES_FILE" $BASE_URL/api/grades)
echo "$GRADES_LIST" | jq '.'

if [ "$(echo "$GRADES_LIST" | jq -r '.success // false')" = "true" ]; then
  pass "Grades listed successfully"
else
  fail "Grades listing failed"
fi
echo ""

echo "Test 2.2: List grades filtered by academic year"
GRADES_FILTERED=$(curl -s -b "$COOKIES_FILE" "$BASE_URL/api/grades?academicYearId=$AY_ID")
echo "$GRADES_FILTERED" | jq '.'

if [ "$(echo "$GRADES_FILTERED" | jq -r '.success // false')" = "true" ]; then
  pass "Filtered grades listed successfully"
else
  fail "Filtered grades listing failed"
fi
echo ""

echo "Test 2.3: List grades without authentication"
GRADES_NOAUTH=$(curl -s $BASE_URL/api/grades)
echo "$GRADES_NOAUTH" | jq '.'

if [ "$(echo "$GRADES_NOAUTH" | jq -r '.success // false')" = "false" ]; then
  pass "Unauthenticated list rejected"
else
  fail "Unauthenticated list should be rejected"
fi
echo ""

echo "====================================="
echo "TEST 3: Get Grade by ID"
echo "====================================="
echo ""

if [ -n "$GRADE1_ID" ]; then
  echo "Test 3.1: Get valid grade"
  GRADE_GET=$(curl -s -b "$COOKIES_FILE" $BASE_URL/api/grades/$GRADE1_ID)
  echo "$GRADE_GET" | jq '.'
  
  if [ "$(echo "$GRADE_GET" | jq -r '.success // false')" = "true" ]; then
    pass "Grade retrieved by ID"
  else
    fail "Grade retrieval failed"
  fi
  echo ""
fi

echo "Test 3.2: Get grade without authentication"
if [ -n "$GRADE1_ID" ]; then
  GRADE_GET_NOAUTH=$(curl -s $BASE_URL/api/grades/$GRADE1_ID)
  echo "$GRADE_GET_NOAUTH" | jq '.'
  
  if [ "$(echo "$GRADE_GET_NOAUTH" | jq -r '.success // false')" = "false" ]; then
    pass "Unauthenticated get rejected"
  else
    fail "Unauthenticated get should be rejected"
  fi
  echo ""
fi

echo "Test 3.3: Get non-existent grade"
GRADE_404=$(curl -s -b "$COOKIES_FILE" $BASE_URL/api/grades/00000000-0000-0000-0000-000000000000)
echo "$GRADE_404" | jq '.'

if [ "$(echo "$GRADE_404" | jq -r '.success // false')" = "false" ]; then
  pass "Non-existent grade returns 404"
else
  fail "Non-existent grade should return error"
fi
echo ""

echo "====================================="
echo "TEST 4: Update Grade"
echo "====================================="
echo ""

if [ -n "$GRADE1_ID" ]; then
  echo "Test 4.1: Update grade name"
  GRADE_UPDATE_NAME=$(curl -s -b "$COOKIES_FILE" -X PATCH $BASE_URL/api/grades/$GRADE1_ID \
    -H "Content-Type: application/json" \
    -d '{
      "name": "Class VI"
    }')
  echo "$GRADE_UPDATE_NAME" | jq '.'
  
  if [ "$(echo "$GRADE_UPDATE_NAME" | jq -r '.success // false')" = "true" ]; then
    pass "Grade name updated"
  else
    fail "Grade name update failed"
  fi
  echo ""
  
  echo "Test 4.2: Update grade display order"
  sleep 1
  GRADE_UPDATE_ORDER=$(curl -s -b "$COOKIES_FILE" -X PATCH $BASE_URL/api/grades/$GRADE1_ID \
    -H "Content-Type: application/json" \
    -d '{
      "displayOrder": 10
    }')
  echo "$GRADE_UPDATE_ORDER" | jq '.'
  
  if [ "$(echo "$GRADE_UPDATE_ORDER" | jq -r '.success // false')" = "true" ]; then
    pass "Grade display order updated"
  else
    fail "Grade display order update failed"
  fi
  echo ""
  
  echo "Test 4.3: Update with empty body"
  sleep 1
  GRADE_UPDATE_EMPTY=$(curl -s -b "$COOKIES_FILE" -X PATCH $BASE_URL/api/grades/$GRADE1_ID \
    -H "Content-Type: application/json" \
    -d '{}')
  echo "$GRADE_UPDATE_EMPTY" | jq '.'
  
  if [ "$(echo "$GRADE_UPDATE_EMPTY" | jq -r '.success // false')" = "false" ]; then
    pass "Empty update rejected"
  else
    fail "Empty update should be rejected"
  fi
  echo ""
fi

echo "Test 4.4: Update without authentication"
if [ -n "$GRADE1_ID" ]; then
  GRADE_UPDATE_NOAUTH=$(curl -s -X PATCH $BASE_URL/api/grades/$GRADE1_ID \
    -H "Content-Type: application/json" \
    -d '{"name": "Unauthorized"}')
  echo "$GRADE_UPDATE_NOAUTH" | jq '.'
  
  if [ "$(echo "$GRADE_UPDATE_NOAUTH" | jq -r '.success // false')" = "false" ]; then
    pass "Unauthenticated update rejected"
  else
    fail "Unauthenticated update should be rejected"
  fi
  echo ""
fi

echo "====================================="
echo "TEST 5: Academic Year Status Restrictions"
echo "====================================="
echo ""

echo "Test 5.1: Activate academic year"
AY_ACTIVATE=$(curl -s -b "$COOKIES_FILE" -X PATCH $BASE_URL/api/academic-years/$AY_ID \
  -H "Content-Type: application/json" \
  -d '{"status": "ACTIVE"}')
echo "$AY_ACTIVATE" | jq '.'

if [ "$(echo "$AY_ACTIVATE" | jq -r '.data.status // ""')" = "ACTIVE" ]; then
  pass "Academic year activated"
else
  fail "Academic year activation failed"
fi
echo ""

echo "Test 5.2: Try to create grade under ACTIVE academic year"
sleep 1
GRADE_ACTIVE=$(curl -s -b "$COOKIES_FILE" -X POST $BASE_URL/api/grades \
  -H "Content-Type: application/json" \
  -d '{
    "academicYearId": "'$AY_ID'",
    "name": "Grade 8",
    "displayOrder": 8
  }')
echo "$GRADE_ACTIVE" | jq '.'

GRADE_ACTIVE_MSG=$(echo "$GRADE_ACTIVE" | jq -r '.message // ""')
if [[ "$GRADE_ACTIVE_MSG" == *"DRAFT"* ]]; then
  pass "Grade creation blocked for ACTIVE academic year"
else
  fail "Grade creation should be blocked for ACTIVE academic year"
fi
echo ""

echo "Test 5.3: Try to update grade under ACTIVE academic year"
if [ -n "$GRADE1_ID" ]; then
  sleep 1
  GRADE_UPDATE_ACTIVE=$(curl -s -b "$COOKIES_FILE" -X PATCH $BASE_URL/api/grades/$GRADE1_ID \
    -H "Content-Type: application/json" \
    -d '{"name": "Should Fail"}')
  echo "$GRADE_UPDATE_ACTIVE" | jq '.'
  
  GRADE_UPDATE_ACTIVE_MSG=$(echo "$GRADE_UPDATE_ACTIVE" | jq -r '.message // ""')
  if [[ "$GRADE_UPDATE_ACTIVE_MSG" == *"DRAFT"* ]]; then
    pass "Grade update blocked for ACTIVE academic year"
  else
    fail "Grade update should be blocked for ACTIVE academic year"
  fi
  echo ""
fi

echo "====================================="
echo "TEST SUMMARY"
echo "====================================="
echo ""
echo "Grade API tests completed!"
echo ""
echo "Note: School isolation tests require multiple schools,"
echo "which cannot be created due to rate limiting."
