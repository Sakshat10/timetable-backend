#!/bin/bash

# Quick Academic Year API test using existing school/admin
# Run after ensuring you have a valid session

BASE_URL="http://localhost:4000"

echo "=== Quick Academic Year API Test ==="
echo ""

echo "1. Health Check"
curl -s $BASE_URL/health | jq .
echo ""

echo "2. Test unauthenticated access (should fail)"
curl -s -X POST $BASE_URL/api/academic-years \
  -H "Content-Type: application/json" \
  -d '{"name": "2026-27", "startDate": "2026-04-01", "endDate": "2027-03-31"}' | jq .
echo ""

echo "Test completed. For full tests, provide existing school/admin credentials."
