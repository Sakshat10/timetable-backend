#!/bin/bash

echo "=== Testing MODULE 2 Security Fixes ==="
echo ""

BASE_URL="${BASE_URL:-http://localhost:4000}"  # BASE_URL overrides the port (never run these against a server you did not start)
COOKIES_FILE=$(mktemp)

# Cleanup function
cleanup() {
  rm -f "$COOKIES_FILE"
}
trap cleanup EXIT

echo "======================================"
echo "TEST 1: School Creation Rate Limiting"
echo "======================================"
echo ""

echo "Test 1a: First school creation (should succeed)"
SCHOOL1=$(curl -s -X POST $BASE_URL/api/schools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Rate Limit Test School 1",
    "code": "RATE_'$(date +%s)'",
    "schoolType": "SECONDARY"
  }')
echo "$SCHOOL1" | jq '(.data.setupToken // empty) |= "<one-time setup token: returned by the API once, deliberately not printed>"'
SCHOOL1_STATUS=$(echo "$SCHOOL1" | jq -r '.success // false')
echo "Expected: true, Got: $SCHOOL1_STATUS"
echo ""

echo "Test 1b: Second school creation (should be rate limited - 429)"
sleep 1
SCHOOL2=$(curl -s -X POST $BASE_URL/api/schools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Rate Limit Test School 2",
    "code": "RATE2_'$(date +%s)'",
    "schoolType": "PRIMARY"
  }')
echo "$SCHOOL2" | jq .
SCHOOL2_MSG=$(echo "$SCHOOL2" | jq -r '.message')
echo "Expected message containing 'Too many requests', Got: $SCHOOL2_MSG"
echo ""

echo "Test 1c: Third school creation (should still be rate limited - 429)"
sleep 1
SCHOOL3=$(curl -s -X POST $BASE_URL/api/schools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Rate Limit Test School 3",
    "code": "RATE3_'$(date +%s)'",
    "schoolType": "CUSTOM"
  }')
echo "$SCHOOL3" | jq .
SCHOOL3_MSG=$(echo "$SCHOOL3" | jq -r '.message')
echo "Expected message containing 'Too many requests', Got: $SCHOOL3_MSG"
echo ""

echo "======================================"
echo "TEST 2: Password Hashing (220k iterations)"
echo "======================================"
echo ""

# Extract school ID for admin registration
SCHOOL_ID=$(echo "$SCHOOL1" | jq -r '.data.id // empty')
SETUP_TOKEN=$(echo "$SCHOOL1" | jq -r '.data.setupToken // empty')   # one-time credential for the first admin (never printed)

if [ -n "$SCHOOL_ID" ]; then
  echo "Test 2a: Register admin with new password (220k iterations)"
  ADMIN_REG=$(curl -s -X POST $BASE_URL/api/admin/register \
    -H "Content-Type: application/json" \
    -d '{
      "schoolId": "'$SCHOOL_ID'",
      "setupToken": "'$SETUP_TOKEN'",
      "name": "Test Admin New",
      "email": "admin.new@test.com",
      "password": "NewPassword123"
    }')
  unset SETUP_TOKEN
  echo "$ADMIN_REG" | jq .
  ADMIN_REG_SUCCESS=$(echo "$ADMIN_REG" | jq -r '.success // false')
  echo "Expected: true, Got: $ADMIN_REG_SUCCESS"
  echo ""

  echo "Test 2b: Login with new password (verify 220k iteration hash works)"
  sleep 1
  LOGIN_NEW=$(curl -s -c "$COOKIES_FILE" -X POST $BASE_URL/api/admin/login \
    -H "Content-Type: application/json" \
    -d '{
      "schoolId": "'$SCHOOL_ID'",
      "email": "admin.new@test.com",
      "password": "NewPassword123"
    }')
  echo "$LOGIN_NEW" | jq .
  LOGIN_NEW_SUCCESS=$(echo "$LOGIN_NEW" | jq -r '.success // false')
  echo "Expected: true, Got: $LOGIN_NEW_SUCCESS"
  echo ""

  echo "Test 2c: Verify old 100k iteration hashes still work"
  echo "Note: Testing by attempting login with existing admin"
  # This assumes there's an existing admin from earlier tests
  # If admin exists with 100k hash, it should still authenticate
  echo "Skipped - requires existing 100k hash in database"
  echo ""
else
  echo "Skipping password tests - no school ID available"
  echo ""
fi

echo "======================================"
echo "TEST 3: Error Logging Sanitization"
echo "======================================"
echo ""

echo "Test 3a: Trigger validation error (password should not appear in logs)"
ERROR_TEST=$(curl -s -X POST $BASE_URL/api/admin/register \
  -H "Content-Type: application/json" \
  -d '{
    "schoolId": "invalid-uuid",
    "setupToken": "stk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "name": "Test",
    "email": "test@test.com",
    "password": "SecretPassword123"
  }')
echo "$ERROR_TEST" | jq .
echo "Check server logs to verify 'SecretPassword123' is NOT logged"
echo ""

echo "Test 3b: Trigger login error (password should not appear in logs)"
sleep 1
ERROR_LOGIN=$(curl -s -X POST $BASE_URL/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "schoolId": "00000000-0000-0000-0000-000000000000",
    "email": "nonexistent@test.com",
    "password": "MySecretPassword456"
  }')
echo "$ERROR_LOGIN" | jq .
echo "Check server logs to verify 'MySecretPassword456' is NOT logged"
echo ""

echo "======================================"
echo "TEST 4: Verify Existing Tests Still Work"
echo "======================================"
echo ""

echo "Test 4a: Health check"
curl -s $BASE_URL/health | jq .
echo ""

if [ -n "$SCHOOL_ID" ]; then
  echo "Test 4b: Access protected endpoint with auth"
  curl -s -b "$COOKIES_FILE" $BASE_URL/api/admin/me | jq .
  echo ""

  echo "Test 4c: Access protected endpoint without auth (should fail)"
  curl -s $BASE_URL/api/schools/$SCHOOL_ID | jq .
  echo ""
fi

echo "======================================"
echo "All security fix tests completed"
echo "======================================"
echo ""
echo "MANUAL VERIFICATION REQUIRED:"
echo "1. Check server logs to confirm passwords are NOT visible"
echo "2. Verify rate limiting resets after 24 hours"
echo "3. Confirm 220k iteration hashes are being created for new passwords"
