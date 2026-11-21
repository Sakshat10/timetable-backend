#!/bin/bash

echo "=== Testing Academic Year API ==="
echo ""

BASE_URL="${BASE_URL:-http://localhost:4000}"  # BASE_URL overrides the port (never run these against a server you did not start)
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
echo "SETUP: Create School and Admin"
echo "====================================="
echo ""

# Try to create school (may fail due to rate limiting)
SCHOOL_RESPONSE=$(curl -s -X POST $BASE_URL/api/schools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Academic Year Test School",
    "code": "AYTEST_'$(date +%s)'",
    "schoolType": "SECONDARY"
  }')

SCHOOL_SUCCESS=$(echo "$SCHOOL_RESPONSE" | jq -r '.success // false')

if [ "$SCHOOL_SUCCESS" = "true" ]; then
  SCHOOL_ID=$(echo "$SCHOOL_RESPONSE" | jq -r '.data.id')
  SETUP_TOKEN=$(echo "$SCHOOL_RESPONSE" | jq -r '.data.setupToken')   # one-time credential for the first admin (never printed)
  pass "School created: $SCHOOL_ID"
  
  # Create admin
  ADMIN_EMAIL="ayadmin_$(date +%s)@test.com"
  ADMIN_RESPONSE=$(curl -s -X POST $BASE_URL/api/admin/register \
    -H "Content-Type: application/json" \
    -d '{
      "schoolId": "'$SCHOOL_ID'",
      "setupToken": "'$SETUP_TOKEN'",
      "name": "AY Test Admin",
      "email": "'$ADMIN_EMAIL'",
      "password": "TestPassword123"
    }')
  
  unset SETUP_TOKEN
  ADMIN_SUCCESS=$(echo "$ADMIN_RESPONSE" | jq -r '.success // false')
  
  if [ "$ADMIN_SUCCESS" = "true" ]; then
    pass "Admin registered: $ADMIN_EMAIL"
    
    # Login
    sleep 1
    LOGIN_RESPONSE=$(curl -s -c "$COOKIES_FILE" -X POST $BASE_URL/api/admin/login \
      -H "Content-Type: application/json" \
      -d '{
        "schoolId": "'$SCHOOL_ID'",
        "email": "'$ADMIN_EMAIL'",
        "password": "TestPassword123"
      }')
    
    LOGIN_SUCCESS=$(echo "$LOGIN_RESPONSE" | jq -r '.success // false')
    
    if [ "$LOGIN_SUCCESS" = "true" ]; then
      pass "Admin logged in successfully"
    else
      fail "Admin login failed"
      echo "$LOGIN_RESPONSE" | jq '.'
      exit 1
    fi
  else
    fail "Admin registration failed"
    echo "$ADMIN_RESPONSE" | jq '.'
    exit 1
  fi
else
  warn "School creation rate-limited - using existing session"
  # User needs to provide existing credentials
  echo "Please run with existing school/admin or wait 24 hours for rate limit reset"
  exit 1
fi

echo ""
echo "====================================="
echo "TEST 1: Create Academic Year"
echo "====================================="
echo ""

echo "Test 1.1: Create valid academic year"
AY1_RESPONSE=$(curl -s -b "$COOKIES_FILE" -X POST $BASE_URL/api/academic-years \
  -H "Content-Type: application/json" \
  -d '{
    "name": "2026-27",
    "startDate": "2026-04-01",
    "endDate": "2027-03-31"
  }')
echo "$AY1_RESPONSE" | jq '.'

AY1_SUCCESS=$(echo "$AY1_RESPONSE" | jq -r '.success // false')
AY1_STATUS=$(echo "$AY1_RESPONSE" | jq -r '.data.status // ""')

if [ "$AY1_SUCCESS" = "true" ] && [ "$AY1_STATUS" = "DRAFT" ]; then
  pass "Academic year created with DRAFT status"
  AY1_ID=$(echo "$AY1_RESPONSE" | jq -r '.data.id')
else
  fail "Academic year creation failed"
fi
echo ""

echo "Test 1.2: Create academic year without authentication"
AY_NOAUTH=$(curl -s -X POST $BASE_URL/api/academic-years \
  -H "Content-Type: application/json" \
  -d '{
    "name": "2027-28",
    "startDate": "2027-04-01",
    "endDate": "2028-03-31"
  }')
echo "$AY_NOAUTH" | jq '.'

AY_NOAUTH_SUCCESS=$(echo "$AY_NOAUTH" | jq -r '.success // false')

if [ "$AY_NOAUTH_SUCCESS" = "false" ]; then
  pass "Unauthenticated request rejected"
else
  fail "Unauthenticated request should be rejected"
fi
echo ""

echo "Test 1.3: Create academic year with duplicate name"
sleep 1
AY_DUP=$(curl -s -b "$COOKIES_FILE" -X POST $BASE_URL/api/academic-years \
  -H "Content-Type: application/json" \
  -d '{
    "name": "2026-27",
    "startDate": "2026-04-01",
    "endDate": "2027-03-31"
  }')
echo "$AY_DUP" | jq '.'

AY_DUP_SUCCESS=$(echo "$AY_DUP" | jq -r '.success // false')
AY_DUP_MSG=$(echo "$AY_DUP" | jq -r '.message // ""')

if [ "$AY_DUP_SUCCESS" = "false" ] && [[ "$AY_DUP_MSG" == *"already exists"* ]]; then
  pass "Duplicate name rejected (409)"
else
  fail "Duplicate name should be rejected"
fi
echo ""

echo "Test 1.4: Create academic year with invalid dates (end before start)"
sleep 1
AY_BADDATE=$(curl -s -b "$COOKIES_FILE" -X POST $BASE_URL/api/academic-years \
  -H "Content-Type: application/json" \
  -d '{
    "name": "2025-26",
    "startDate": "2026-04-01",
    "endDate": "2025-03-31"
  }')
echo "$AY_BADDATE" | jq '.'

AY_BADDATE_SUCCESS=$(echo "$AY_BADDATE" | jq -r '.success // false')

if [ "$AY_BADDATE_SUCCESS" = "false" ]; then
  pass "Invalid date range rejected"
else
  fail "Invalid date range should be rejected"
fi
echo ""

echo "Test 1.5: Create academic year with equal start and end dates"
sleep 1
AY_EQUALDATE=$(curl -s -b "$COOKIES_FILE" -X POST $BASE_URL/api/academic-years \
  -H "Content-Type: application/json" \
  -d '{
    "name": "2028-29",
    "startDate": "2028-04-01",
    "endDate": "2028-04-01"
  }')
echo "$AY_EQUALDATE" | jq '.'

AY_EQUALDATE_SUCCESS=$(echo "$AY_EQUALDATE" | jq -r '.success // false')

if [ "$AY_EQUALDATE_SUCCESS" = "false" ]; then
  pass "Equal start/end dates rejected"
else
  fail "Equal dates should be rejected"
fi
echo ""

echo "Test 1.6: Create academic year with missing fields"
sleep 1
AY_MISSING=$(curl -s -b "$COOKIES_FILE" -X POST $BASE_URL/api/academic-years \
  -H "Content-Type: application/json" \
  -d '{
    "name": "2029-30"
  }')
echo "$AY_MISSING" | jq '.'

AY_MISSING_SUCCESS=$(echo "$AY_MISSING" | jq -r '.success // false')

if [ "$AY_MISSING_SUCCESS" = "false" ]; then
  pass "Missing required fields rejected"
else
  fail "Missing fields should be rejected"
fi
echo ""

echo "====================================="
echo "TEST 2: List Academic Years"
echo "====================================="
echo ""

echo "Test 2.1: List academic years for authenticated admin"
AY_LIST=$(curl -s -b "$COOKIES_FILE" $BASE_URL/api/academic-years)
echo "$AY_LIST" | jq '.'

AY_LIST_SUCCESS=$(echo "$AY_LIST" | jq -r '.success // false')
AY_LIST_COUNT=$(echo "$AY_LIST" | jq -r '.data | length')

if [ "$AY_LIST_SUCCESS" = "true" ] && [ "$AY_LIST_COUNT" -gt 0 ]; then
  pass "Academic years listed ($AY_LIST_COUNT found)"
else
  fail "Academic years listing failed"
fi
echo ""

echo "Test 2.2: List academic years without authentication"
AY_LIST_NOAUTH=$(curl -s $BASE_URL/api/academic-years)
echo "$AY_LIST_NOAUTH" | jq '.'

AY_LIST_NOAUTH_SUCCESS=$(echo "$AY_LIST_NOAUTH" | jq -r '.success // false')

if [ "$AY_LIST_NOAUTH_SUCCESS" = "false" ]; then
  pass "Unauthenticated list request rejected"
else
  fail "Unauthenticated list should be rejected"
fi
echo ""

echo "====================================="
echo "TEST 3: Get Academic Year by ID"
echo "====================================="
echo ""

if [ -n "$AY1_ID" ]; then
  echo "Test 3.1: Get academic year by valid ID"
  AY_GET=$(curl -s -b "$COOKIES_FILE" $BASE_URL/api/academic-years/$AY1_ID)
  echo "$AY_GET" | jq '.'
  
  AY_GET_SUCCESS=$(echo "$AY_GET" | jq -r '.success // false')
  AY_GET_ID=$(echo "$AY_GET" | jq -r '.data.id // ""')
  
  if [ "$AY_GET_SUCCESS" = "true" ] && [ "$AY_GET_ID" = "$AY1_ID" ]; then
    pass "Academic year retrieved by ID"
  else
    fail "Academic year retrieval failed"
  fi
  echo ""
  
  echo "Test 3.2: Get academic year without authentication"
  AY_GET_NOAUTH=$(curl -s $BASE_URL/api/academic-years/$AY1_ID)
  echo "$AY_GET_NOAUTH" | jq '.'
  
  AY_GET_NOAUTH_SUCCESS=$(echo "$AY_GET_NOAUTH" | jq -r '.success // false')
  
  if [ "$AY_GET_NOAUTH_SUCCESS" = "false" ]; then
    pass "Unauthenticated get request rejected"
  else
    fail "Unauthenticated get should be rejected"
  fi
  echo ""
fi

echo "Test 3.3: Get academic year with invalid ID"
AY_GET_INVALID=$(curl -s -b "$COOKIES_FILE" $BASE_URL/api/academic-years/invalid-id)
echo "$AY_GET_INVALID" | jq '.'

AY_GET_INVALID_SUCCESS=$(echo "$AY_GET_INVALID" | jq -r '.success // false')

if [ "$AY_GET_INVALID_SUCCESS" = "false" ]; then
  pass "Invalid ID format rejected"
else
  fail "Invalid ID should be rejected"
fi
echo ""

echo "Test 3.4: Get non-existent academic year"
AY_GET_NOTFOUND=$(curl -s -b "$COOKIES_FILE" $BASE_URL/api/academic-years/00000000-0000-0000-0000-000000000000)
echo "$AY_GET_NOTFOUND" | jq '.'

AY_GET_NOTFOUND_SUCCESS=$(echo "$AY_GET_NOTFOUND" | jq -r '.success // false')

if [ "$AY_GET_NOTFOUND_SUCCESS" = "false" ]; then
  pass "Non-existent academic year returns 404"
else
  fail "Non-existent academic year should return error"
fi
echo ""

echo "====================================="
echo "TEST 4: Update Academic Year"
echo "====================================="
echo ""

if [ -n "$AY1_ID" ]; then
  echo "Test 4.1: Update academic year name"
  AY_UPDATE_NAME=$(curl -s -b "$COOKIES_FILE" -X PATCH $BASE_URL/api/academic-years/$AY1_ID \
    -H "Content-Type: application/json" \
    -d '{
      "name": "2026-2027"
    }')
  echo "$AY_UPDATE_NAME" | jq '.'
  
  AY_UPDATE_NAME_SUCCESS=$(echo "$AY_UPDATE_NAME" | jq -r '.success // false')
  AY_UPDATE_NAME_VAL=$(echo "$AY_UPDATE_NAME" | jq -r '.data.name // ""')
  
  if [ "$AY_UPDATE_NAME_SUCCESS" = "true" ] && [ "$AY_UPDATE_NAME_VAL" = "2026-2027" ]; then
    pass "Academic year name updated"
  else
    fail "Academic year name update failed"
  fi
  echo ""
  
  echo "Test 4.2: Update academic year dates"
  sleep 1
  AY_UPDATE_DATES=$(curl -s -b "$COOKIES_FILE" -X PATCH $BASE_URL/api/academic-years/$AY1_ID \
    -H "Content-Type: application/json" \
    -d '{
      "startDate": "2026-04-15",
      "endDate": "2027-04-15"
    }')
  echo "$AY_UPDATE_DATES" | jq '.'
  
  AY_UPDATE_DATES_SUCCESS=$(echo "$AY_UPDATE_DATES" | jq -r '.success // false')
  
  if [ "$AY_UPDATE_DATES_SUCCESS" = "true" ]; then
    pass "Academic year dates updated"
  else
    fail "Academic year dates update failed"
  fi
  echo ""
  
  echo "Test 4.3: Update status DRAFT → ACTIVE"
  sleep 1
  AY_UPDATE_STATUS=$(curl -s -b "$COOKIES_FILE" -X PATCH $BASE_URL/api/academic-years/$AY1_ID \
    -H "Content-Type: application/json" \
    -d '{
      "status": "ACTIVE"
    }')
  echo "$AY_UPDATE_STATUS" | jq '.'
  
  AY_UPDATE_STATUS_SUCCESS=$(echo "$AY_UPDATE_STATUS" | jq -r '.success // false')
  AY_UPDATE_STATUS_VAL=$(echo "$AY_UPDATE_STATUS" | jq -r '.data.status // ""')
  
  if [ "$AY_UPDATE_STATUS_SUCCESS" = "true" ] && [ "$AY_UPDATE_STATUS_VAL" = "ACTIVE" ]; then
    pass "Status transitioned DRAFT → ACTIVE"
  else
    fail "Status transition DRAFT → ACTIVE failed"
  fi
  echo ""
  
  echo "Test 4.4: Update status ACTIVE → COMPLETED"
  sleep 1
  AY_UPDATE_COMPLETE=$(curl -s -b "$COOKIES_FILE" -X PATCH $BASE_URL/api/academic-years/$AY1_ID \
    -H "Content-Type: application/json" \
    -d '{
      "status": "COMPLETED"
    }')
  echo "$AY_UPDATE_COMPLETE" | jq '.'
  
  AY_UPDATE_COMPLETE_SUCCESS=$(echo "$AY_UPDATE_COMPLETE" | jq -r '.success // false')
  AY_UPDATE_COMPLETE_VAL=$(echo "$AY_UPDATE_COMPLETE" | jq -r '.data.status // ""')
  
  if [ "$AY_UPDATE_COMPLETE_SUCCESS" = "true" ] && [ "$AY_UPDATE_COMPLETE_VAL" = "COMPLETED" ]; then
    pass "Status transitioned ACTIVE → COMPLETED"
  else
    fail "Status transition ACTIVE → COMPLETED failed"
  fi
  echo ""
  
  echo "Test 4.5: Try invalid status transition COMPLETED → DRAFT"
  sleep 1
  AY_UPDATE_INVALID=$(curl -s -b "$COOKIES_FILE" -X PATCH $BASE_URL/api/academic-years/$AY1_ID \
    -H "Content-Type: application/json" \
    -d '{
      "status": "DRAFT"
    }')
  echo "$AY_UPDATE_INVALID" | jq '.'
  
  AY_UPDATE_INVALID_SUCCESS=$(echo "$AY_UPDATE_INVALID" | jq -r '.success // false')
  AY_UPDATE_INVALID_MSG=$(echo "$AY_UPDATE_INVALID" | jq -r '.message // ""')
  
  if [ "$AY_UPDATE_INVALID_SUCCESS" = "false" ] && [[ "$AY_UPDATE_INVALID_MSG" == *"Invalid status transition"* ]]; then
    pass "Invalid status transition COMPLETED → DRAFT rejected"
  else
    fail "Invalid status transition should be rejected"
  fi
  echo ""
  
  echo "Test 4.6: Update with invalid date range"
  sleep 1
  AY_UPDATE_BADDATE=$(curl -s -b "$COOKIES_FILE" -X PATCH $BASE_URL/api/academic-years/$AY1_ID \
    -H "Content-Type: application/json" \
    -d '{
      "startDate": "2027-05-01",
      "endDate": "2026-04-01"
    }')
  echo "$AY_UPDATE_BADDATE" | jq '.'
  
  AY_UPDATE_BADDATE_SUCCESS=$(echo "$AY_UPDATE_BADDATE" | jq -r '.success // false')
  
  if [ "$AY_UPDATE_BADDATE_SUCCESS" = "false" ]; then
    pass "Invalid date range update rejected"
  else
    fail "Invalid date range update should be rejected"
  fi
  echo ""
fi

echo "Test 4.7: Update without authentication"
if [ -n "$AY1_ID" ]; then
  AY_UPDATE_NOAUTH=$(curl -s -X PATCH $BASE_URL/api/academic-years/$AY1_ID \
    -H "Content-Type: application/json" \
    -d '{
      "name": "Unauthorized"
    }')
  echo "$AY_UPDATE_NOAUTH" | jq '.'
  
  AY_UPDATE_NOAUTH_SUCCESS=$(echo "$AY_UPDATE_NOAUTH" | jq -r '.success // false')
  
  if [ "$AY_UPDATE_NOAUTH_SUCCESS" = "false" ]; then
    pass "Unauthenticated update rejected"
  else
    fail "Unauthenticated update should be rejected"
  fi
  echo ""
fi

echo "====================================="
echo "TEST SUMMARY"
echo "====================================="
echo ""
echo "All academic year API tests completed!"
echo ""
echo "Manual verification recommended for:"
echo "- Cross-school authorization (requires multiple schools)"
echo "- Module 1 regression tests"
echo "- Module 2 regression tests"
