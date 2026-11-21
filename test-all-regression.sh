#!/bin/bash

# Comprehensive Regression Test for All Modules
# Tests Modules 1-4 with Swagger documentation

API_URL="${BASE_URL:-http://localhost:4000}"  # BASE_URL overrides the port (never run these against a server you did not start)
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0
WARNINGS=0

echo "============================================"
echo "COMPREHENSIVE REGRESSION TEST - Modules 1-4"
echo "============================================"
echo ""

# ========================================
# Module 0: Health & Swagger
# ========================================
echo -e "${BLUE}[MODULE 0] Health Check & Swagger${NC}"
echo "----------------------------------------"

# Test 1: Health endpoint
echo -n "Test 1: Health endpoint... "
HEALTH=$(curl -s "$API_URL/health")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  echo "Response: $HEALTH"
  ((FAILED++))
fi

# Test 2: Swagger UI
echo -n "Test 2: Swagger UI accessible... "
SWAGGER_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/docs")
if [ "$SWAGGER_STATUS" -eq 200 ]; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC} (HTTP $SWAGGER_STATUS)"
  ((FAILED++))
fi

# Test 3: OpenAPI JSON
echo -n "Test 3: OpenAPI JSON spec... "
OPENAPI_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/docs/json")
if [ "$OPENAPI_STATUS" -eq 200 ]; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC} (HTTP $OPENAPI_STATUS)"
  ((FAILED++))
fi

echo ""

# ========================================
# Module 1: School (Limited due to rate limiting)
# ========================================
echo -e "${BLUE}[MODULE 1] School Management${NC}"
echo "----------------------------------------"

# Test 4: Create school with invalid data
echo -n "Test 4: School validation (empty name)... "
SCHOOL_INVALID=$(curl -s -X POST "$API_URL/api/schools" \
  -H "Content-Type: application/json" \
  -d '{"name":"","code":"TEST123","schoolType":"PRIMARY"}')
if echo "$SCHOOL_INVALID" | grep -q '"message"'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  echo "Response: $SCHOOL_INVALID"
  ((FAILED++))
fi

# Test 5: School validation - lowercase code
echo -n "Test 5: School validation (lowercase code)... "
SCHOOL_LOWERCASE=$(curl -s -X POST "$API_URL/api/schools" \
  -H "Content-Type: application/json" \
  -d '{"name":"Test","code":"test-123","schoolType":"PRIMARY"}')
if echo "$SCHOOL_LOWERCASE" | grep -q '"message"'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  echo "Response: $SCHOOL_LOWERCASE"
  ((FAILED++))
fi

# Note: We skip actual school creation test due to 24h rate limit
echo -e "${YELLOW}⚠ NOTE${NC}: School creation tests skipped (24h rate limit per IP)"
echo ""

# ========================================
# Module 2: Admin Authentication
# ========================================
echo -e "${BLUE}[MODULE 2] Admin Authentication${NC}"
echo "----------------------------------------"

# For Admin tests, we need an existing school
# Try to get an existing school from the database
EXISTING_SCHOOL=$(curl -s "$API_URL/docs/json" 2>/dev/null | head -1)
# We'll use a hardcoded UUID that we know exists from previous tests
# If this doesn't exist, tests will fail appropriately

# Test 6: Register admin with invalid email
echo -n "Test 6: Admin validation (invalid email)... "
ADMIN_INVALID=$(curl -s -X POST "$API_URL/api/admin/register" \
  -H "Content-Type: application/json" \
  -d '{"schoolId":"550e8400-e29b-41d4-a716-446655440000","setupToken":"stk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","name":"Test Admin","email":"not-an-email","password":"SecurePass123"}')
if echo "$ADMIN_INVALID" | grep -q '"message"'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  echo "Response: $ADMIN_INVALID"
  ((FAILED++))
fi

# Test 7: Register admin with weak password
echo -n "Test 7: Admin validation (weak password)... "
ADMIN_WEAK=$(curl -s -X POST "$API_URL/api/admin/register" \
  -H "Content-Type: application/json" \
  -d '{"schoolId":"550e8400-e29b-41d4-a716-446655440000","setupToken":"stk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","name":"Test Admin","email":"test@example.com","password":"weak"}')
if echo "$ADMIN_WEAK" | grep -q '"message"'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  echo "Response: $ADMIN_WEAK"
  ((FAILED++))
fi

# Test 7b: Registration needs the one-time setup token (a school UUID alone is no longer enough)
echo -n "Test 7b: Admin registration without a setup token is rejected... "
ADMIN_NOTOKEN=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/api/admin/register" \
  -H "Content-Type: application/json" \
  -d '{"schoolId":"550e8400-e29b-41d4-a716-446655440000","name":"Test Admin","email":"test@example.com","password":"SecurePass123"}')
if [ "$ADMIN_NOTOKEN" = "400" ]; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC} (HTTP $ADMIN_NOTOKEN, expected 400)"
  ((FAILED++))
fi

# Test 7c: A well-formed token for a school that does not exist is refused with 401 (no hint whether the school exists)
echo -n "Test 7c: Admin registration with an unknown school and a well-formed token is 401... "
ADMIN_UNKNOWN=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API_URL/api/admin/register" \
  -H "Content-Type: application/json" \
  -d '{"schoolId":"550e8400-e29b-41d4-a716-446655440000","setupToken":"stk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","name":"Test Admin","email":"test@example.com","password":"SecurePass123"}')
if [ "$ADMIN_UNKNOWN" = "401" ]; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC} (HTTP $ADMIN_UNKNOWN, expected 401)"
  ((FAILED++))
fi

# Test 8: Login without authentication
echo -n "Test 8: Login validation (non-existent user)... "
LOGIN_INVALID=$(curl -s -X POST "$API_URL/api/admin/login" \
  -H "Content-Type: application/json" \
  -d '{"schoolId":"550e8400-e29b-41d4-a716-446655440000","email":"nonexistent@example.com","password":"SecurePass123"}')
if echo "$LOGIN_INVALID" | grep -q '"success":false'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  echo "Response: $LOGIN_INVALID"
  ((FAILED++))
fi

# Test 9: GET /admin/me without authentication
echo -n "Test 9: Protected endpoint without auth... "
ME_UNAUTH=$(curl -s "$API_URL/api/admin/me")
if echo "$ME_UNAUTH" | grep -q '"success":false'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  echo "Response: $ME_UNAUTH"
  ((FAILED++))
fi

echo ""

# ========================================
# Module 3: Academic Year
# ========================================
echo -e "${BLUE}[MODULE 3] Academic Year Management${NC}"
echo "----------------------------------------"

# Test 10: Create academic year without auth
echo -n "Test 10: Academic year requires auth... "
AY_UNAUTH=$(curl -s -X POST "$API_URL/api/academic-years" \
  -H "Content-Type: application/json" \
  -d '{"name":"2026-27","startDate":"2026-04-01","endDate":"2027-03-31"}')
if echo "$AY_UNAUTH" | grep -q '"success":false'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  echo "Response: $AY_UNAUTH"
  ((FAILED++))
fi

# Test 11: Get academic years without auth
echo -n "Test 11: List academic years requires auth... "
AY_LIST_UNAUTH=$(curl -s "$API_URL/api/academic-years")
if echo "$AY_LIST_UNAUTH" | grep -q '"success":false'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  echo "Response: $AY_LIST_UNAUTH"
  ((FAILED++))
fi

# Test 12: Get academic year by ID without auth
echo -n "Test 12: Get academic year by ID requires auth... "
AY_GET_UNAUTH=$(curl -s "$API_URL/api/academic-years/550e8400-e29b-41d4-a716-446655440000")
if echo "$AY_GET_UNAUTH" | grep -q '"success":false'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  echo "Response: $AY_GET_UNAUTH"
  ((FAILED++))
fi

echo ""

# ========================================
# Module 4: Grade
# ========================================
echo -e "${BLUE}[MODULE 4] Grade Management${NC}"
echo "----------------------------------------"

# Test 13: Create grade without auth
echo -n "Test 13: Grade creation requires auth... "
GRADE_UNAUTH=$(curl -s -X POST "$API_URL/api/grades" \
  -H "Content-Type: application/json" \
  -d '{"academicYearId":"550e8400-e29b-41d4-a716-446655440000","name":"Grade 6","displayOrder":1}')
if echo "$GRADE_UNAUTH" | grep -q '"success":false'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  echo "Response: $GRADE_UNAUTH"
  ((FAILED++))
fi

# Test 14: List grades without auth
echo -n "Test 14: List grades requires auth... "
GRADE_LIST_UNAUTH=$(curl -s "$API_URL/api/grades")
if echo "$GRADE_LIST_UNAUTH" | grep -q '"success":false'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  echo "Response: $GRADE_LIST_UNAUTH"
  ((FAILED++))
fi

# Test 15: Get grade by ID without auth
echo -n "Test 15: Get grade by ID requires auth... "
GRADE_GET_UNAUTH=$(curl -s "$API_URL/api/grades/550e8400-e29b-41d4-a716-446655440000")
if echo "$GRADE_GET_UNAUTH" | grep -q '"success":false'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  echo "Response: $GRADE_GET_UNAUTH"
  ((FAILED++))
fi

echo ""

# ========================================
# TypeScript & Build Verification
# ========================================
echo -e "${BLUE}[BUILD] TypeScript & Compilation${NC}"
echo "----------------------------------------"

# Test 16: TypeScript compilation
echo -n "Test 16: TypeScript compilation... "
if npx tsc --noEmit 2>&1 | grep -q "error TS"; then
  echo -e "${RED}✗ FAIL${NC}"
  echo "TypeScript errors found"
  ((FAILED++))
else
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
fi

echo ""

# ========================================
# Summary
# ========================================
echo "============================================"
echo "TEST SUMMARY"
echo "============================================"
echo -e "Total Tests: $((PASSED + FAILED + WARNINGS))"
echo -e "${GREEN}Passed: $PASSED${NC}"
if [ $FAILED -gt 0 ]; then
  echo -e "${RED}Failed: $FAILED${NC}"
else
  echo -e "Failed: $FAILED"
fi
if [ $WARNINGS -gt 0 ]; then
  echo -e "${YELLOW}Warnings: $WARNINGS${NC}"
fi
echo ""

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}✓ ALL TESTS PASSED${NC}"
  echo ""
  echo "Swagger UI: $API_URL/docs"
  echo "OpenAPI Spec: $API_URL/docs/json"
  exit 0
else
  echo -e "${RED}✗ SOME TESTS FAILED${NC}"
  exit 1
fi
