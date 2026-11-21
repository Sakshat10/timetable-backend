#!/bin/bash

echo "=== Testing Admin Authentication API ==="
echo ""

BASE_URL="${BASE_URL:-http://localhost:4000}"  # BASE_URL overrides the port (never run these against a server you did not start)
COOKIES_FILE=$(mktemp)

# Cleanup function
cleanup() {
  rm -f "$COOKIES_FILE"
}
trap cleanup EXIT

echo "Step 1: Create a school first (for testing)"
SCHOOL_RESPONSE=$(curl -s -X POST $BASE_URL/api/schools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Auth School",
    "code": "AUTH_'$(date +%s)'",
    "schoolType": "SECONDARY"
  }')
# The response carries the ONE-TIME setup token (the credential for the first admin). It is captured, never printed.
echo "$SCHOOL_RESPONSE" | jq '(.data.setupToken // empty) |= "<one-time setup token: returned by the API once, deliberately not printed>"'
SCHOOL_ID=$(echo "$SCHOOL_RESPONSE" | jq -r '.data.id')
SETUP_TOKEN=$(echo "$SCHOOL_RESPONSE" | jq -r '.data.setupToken')
echo "School ID: $SCHOOL_ID"
echo -e "\n"

echo "=== REGISTRATION TESTS ==="
echo ""

echo "Test 1: Register the first admin with valid data and the school's setup token"
REGISTER_RESPONSE=$(curl -s -X POST $BASE_URL/api/admin/register \
  -H "Content-Type: application/json" \
  -d '{
    "schoolId": "'$SCHOOL_ID'",
    "setupToken": "'$SETUP_TOKEN'",
    "name": "Admin User",
    "email": "admin@test.com",
    "password": "StrongPass123"
  }')
echo "$REGISTER_RESPONSE" | jq .
ADMIN_ID=$(echo "$REGISTER_RESPONSE" | jq -r '.data.id // empty')
echo "Admin ID: $ADMIN_ID"
echo -e "\n"

echo "Test 2: Register admin with weak password"
curl -s -X POST $BASE_URL/api/admin/register \
  -H "Content-Type: application/json" \
  -d '{
    "schoolId": "'$SCHOOL_ID'",
    "setupToken": "'$SETUP_TOKEN'",
    "name": "Admin User",
    "email": "weak@test.com",
    "password": "weak"
  }' | jq .
echo -e "\n"

echo "Test 3: Register admin with invalid email"
curl -s -X POST $BASE_URL/api/admin/register \
  -H "Content-Type: application/json" \
  -d '{
    "schoolId": "'$SCHOOL_ID'",
    "setupToken": "'$SETUP_TOKEN'",
    "name": "Admin User",
    "email": "invalid-email",
    "password": "StrongPass123"
  }' | jq .
echo -e "\n"

echo "Test 4: Register admin for nonexistent school (401, the same answer as a wrong token: nothing reveals whether a school exists)"
curl -s -X POST $BASE_URL/api/admin/register \
  -H "Content-Type: application/json" \
  -d '{
    "schoolId": "00000000-0000-0000-0000-000000000000",
    "setupToken": "stk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "name": "Admin User",
    "email": "test@test.com",
    "password": "StrongPass123"
  }' | jq .
echo -e "\n"

echo "Test 5: Register a duplicate admin by REPLAYING the consumed setup token (401: the token is single-use)"
curl -s -X POST $BASE_URL/api/admin/register \
  -H "Content-Type: application/json" \
  -d '{
    "schoolId": "'$SCHOOL_ID'",
    "setupToken": "'$SETUP_TOKEN'",
    "name": "Another Admin",
    "email": "admin@test.com",
    "password": "StrongPass123"
  }' | jq .
echo -e "\n"

unset SETUP_TOKEN
echo "=== LOGIN TESTS ==="
echo ""

echo "Test 6: Login with valid credentials"
curl -s -X POST $BASE_URL/api/admin/login \
  -H "Content-Type: application/json" \
  -c "$COOKIES_FILE" \
  -d '{
    "schoolId": "'$SCHOOL_ID'",
    "email": "admin@test.com",
    "password": "StrongPass123"
  }' | jq .
echo -e "\n"

echo "Test 6b: An authenticated admin creates another admin in their own school (POST /api/admins)"
curl -s -X POST $BASE_URL/api/admins \
  -H "Content-Type: application/json" \
  -b "$COOKIES_FILE" \
  -d '{
    "name": "Second Admin",
    "email": "second@test.com",
    "password": "StrongPass123"
  }' | jq .
echo -e "\n"

echo "Test 6c: Create a duplicate admin through POST /api/admins (409)"
curl -s -X POST $BASE_URL/api/admins \
  -H "Content-Type: application/json" \
  -b "$COOKIES_FILE" \
  -d '{
    "name": "Another Admin",
    "email": "admin@test.com",
    "password": "StrongPass123"
  }' | jq .
echo -e "\n"

echo "Test 6d: POST /api/admins with a schoolId in the body is refused (400: the school always comes from the session)"
curl -s -X POST $BASE_URL/api/admins \
  -H "Content-Type: application/json" \
  -b "$COOKIES_FILE" \
  -d '{
    "schoolId": "00000000-0000-0000-0000-000000000000",
    "name": "Sneaky Admin",
    "email": "sneaky@test.com",
    "password": "StrongPass123"
  }' | jq .
echo -e "\n"

echo "Test 6e: POST /api/admins without a session (401)"
curl -s -X POST $BASE_URL/api/admins \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Anonymous Admin",
    "email": "anon@test.com",
    "password": "StrongPass123"
  }' | jq .
echo -e "\n"

echo "Test 7: Login with invalid password"
curl -s -X POST $BASE_URL/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "schoolId": "'$SCHOOL_ID'",
    "email": "admin@test.com",
    "password": "WrongPassword123"
  }' | jq .
echo -e "\n"

echo "Test 8: Login with nonexistent account"
curl -s -X POST $BASE_URL/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "schoolId": "'$SCHOOL_ID'",
    "email": "nonexistent@test.com",
    "password": "StrongPass123"
  }' | jq .
echo -e "\n"

echo "=== AUTHORIZATION TESTS ==="
echo ""

echo "Test 9: Access protected endpoint without session"
curl -s $BASE_URL/api/admin/me | jq .
echo -e "\n"

echo "Test 10: Access /admin/me with valid session"
curl -s $BASE_URL/api/admin/me \
  -b "$COOKIES_FILE" | jq .
echo -e "\n"

echo "Test 11: Access own school with valid session"
curl -s $BASE_URL/api/schools/$SCHOOL_ID \
  -b "$COOKIES_FILE" | jq .
echo -e "\n"

echo "Test 12: Attempt to access another school's data"
# Create another school
OTHER_SCHOOL=$(curl -s -X POST $BASE_URL/api/schools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Other School",
    "code": "OTHER_'$(date +%s)'",
    "schoolType": "PRIMARY"
  }')
OTHER_SCHOOL_ID=$(echo "$OTHER_SCHOOL" | jq -r '.data.id')
echo "Attempting to access school ID: $OTHER_SCHOOL_ID"
curl -s $BASE_URL/api/schools/$OTHER_SCHOOL_ID \
  -b "$COOKIES_FILE" | jq .
echo -e "\n"

echo "=== LOGOUT TESTS ==="
echo ""

echo "Test 13: Logout"
curl -s -X POST $BASE_URL/api/admin/logout \
  -b "$COOKIES_FILE" | jq .
echo -e "\n"

echo "Test 14: Access protected endpoint after logout"
curl -s $BASE_URL/api/admin/me \
  -b "$COOKIES_FILE" | jq .
echo -e "\n"

echo "=== All tests completed ==="
