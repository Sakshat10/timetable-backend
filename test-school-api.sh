#!/bin/bash

echo "=== Testing School API Endpoints ==="
echo ""

BASE_URL="http://localhost:4000"

echo "1. Health Check"
curl -s $BASE_URL/health | jq .
echo -e "\n"

echo "2. Create School - Valid"
RESPONSE=$(curl -s -X POST $BASE_URL/api/schools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Public School",
    "code": "TPS_'$(date +%s)'",
    "schoolType": "SECONDARY"
  }')
echo $RESPONSE | jq .
SCHOOL_ID=$(echo $RESPONSE | jq -r '.data.id')
echo -e "\n"

echo "3. Get School by ID - Valid"
curl -s $BASE_URL/api/schools/$SCHOOL_ID | jq .
echo -e "\n"

echo "4. Get School by ID - Not Found"
curl -s $BASE_URL/api/schools/00000000-0000-0000-0000-000000000000 | jq .
echo -e "\n"

echo "5. Get School by ID - Invalid UUID"
curl -s $BASE_URL/api/schools/invalid-uuid | jq .
echo -e "\n"

echo "6. Create School - Empty Name"
curl -s -X POST $BASE_URL/api/schools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "",
    "code": "TEST456",
    "schoolType": "PRIMARY"
  }' | jq .
echo -e "\n"

echo "7. Create School - Invalid Code (lowercase)"
curl -s -X POST $BASE_URL/api/schools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test School",
    "code": "test-123",
    "schoolType": "PRIMARY"
  }' | jq .
echo -e "\n"

echo "8. Create School - Invalid School Type"
curl -s -X POST $BASE_URL/api/schools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Another School",
    "code": "SCHOOL_999",
    "schoolType": "INVALID"
  }' | jq .
echo -e "\n"

echo "9. Create School - Duplicate Code"
curl -s -X POST $BASE_URL/api/schools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Duplicate School",
    "code": "ABC001",
    "schoolType": "CUSTOM"
  }' | jq .
echo -e "\n"

echo "=== All tests completed ==="
