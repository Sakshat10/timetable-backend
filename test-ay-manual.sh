#!/bin/bash

# Manual Academic Year API test
# Usage: Provide SCHOOL_ID, ADMIN_EMAIL, ADMIN_PASSWORD as environment variables

BASE_URL="http://localhost:4000"
COOKIES_FILE=$(mktemp)

cleanup() {
  rm -f "$COOKIES_FILE"
}
trap cleanup EXIT

# Use existing school from previous tests
SCHOOL_ID="${SCHOOL_ID:-f91e33e6-0ee3-4382-9f85-006ff58485c0}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@test.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-StrongPassword123}"

echo "=== Academic Year API Manual Test ==="
echo "School ID: $SCHOOL_ID"
echo "Admin Email: $ADMIN_EMAIL"
echo ""

echo "Step 1: Login"
LOGIN=$(curl -s -c "$COOKIES_FILE" -X POST $BASE_URL/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{
    "schoolId": "'$SCHOOL_ID'",
    "email": "'$ADMIN_EMAIL'",
    "password": "'$ADMIN_PASSWORD'"
  }')
echo "$LOGIN" | jq .

LOGIN_SUCCESS=$(echo "$LOGIN" | jq -r '.success // false')

if [ "$LOGIN_SUCCESS" != "true" ]; then
  echo "Login failed. Please check credentials."
  exit 1
fi

echo ""
echo "Step 2: Create Academic Year"
AY_CREATE=$(curl -s -b "$COOKIES_FILE" -X POST $BASE_URL/api/academic-years \
  -H "Content-Type: application/json" \
  -d '{
    "name": "2026-27-TEST",
    "startDate": "2026-04-01",
    "endDate": "2027-03-31"
  }')
echo "$AY_CREATE" | jq .

AY_ID=$(echo "$AY_CREATE" | jq -r '.data.id // ""')

echo ""
echo "Step 3: List Academic Years"
curl -s -b "$COOKIES_FILE" $BASE_URL/api/academic-years | jq .

if [ -n "$AY_ID" ]; then
  echo ""
  echo "Step 4: Get Academic Year by ID"
  curl -s -b "$COOKIES_FILE" $BASE_URL/api/academic-years/$AY_ID | jq .
  
  echo ""
  echo "Step 5: Update Academic Year"
  curl -s -b "$COOKIES_FILE" -X PATCH $BASE_URL/api/academic-years/$AY_ID \
    -H "Content-Type: application/json" \
    -d '{"name": "2026-2027-UPDATED"}' | jq .
  
  echo ""
  echo "Step 6: Update Status to ACTIVE"
  curl -s -b "$COOKIES_FILE" -X PATCH $BASE_URL/api/academic-years/$AY_ID \
    -H "Content-Type: application/json" \
    -d '{"status": "ACTIVE"}' | jq .
fi

echo ""
echo "Test completed!"
