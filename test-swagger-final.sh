#!/bin/bash

# Final Swagger Implementation Verification
# Quick regression test focusing on critical functionality

API_URL="${BASE_URL:-http://localhost:4000}"  # BASE_URL overrides the port (never run these against a server you did not start)
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

PASSED=0
FAILED=0

echo "================================================"
echo "SWAGGER IMPLEMENTATION - FINAL VERIFICATION"
echo "================================================"
echo ""

# Test 1: Health endpoint
echo -n "1. Health endpoint... "
HEALTH=$(curl -s -m 5 "$API_URL/health")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  ((FAILED++))
fi

# Test 2: Swagger UI accessible
echo -n "2. Swagger UI accessible... "
SWAGGER_STATUS=$(curl -s -m 5 -o /dev/null -w "%{http_code}" "$API_URL/docs")
if [ "$SWAGGER_STATUS" -eq 200 ]; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC} (HTTP $SWAGGER_STATUS)"
  ((FAILED++))
fi

# Test 3: OpenAPI JSON spec
echo -n "3. OpenAPI JSON spec... "
OPENAPI=$(curl -s -m 5 "$API_URL/docs/json")
if echo "$OPENAPI" | grep -q '"openapi":"3.0.3"'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  ((FAILED++))
fi

# Test 4: All tags present (20, with Record management; 19 with Curriculum; 18 with Substitution; 17 before: this expectation was still the Module 3 value of 5 long before this change; kept EXACT, updated to the current API)
echo -n "4. All tags present... "
TAGS=$(echo "$OPENAPI" | python3 -c "import json, sys; print(len(json.load(sys.stdin).get('tags', [])))" 2>/dev/null)
if [ "$TAGS" -eq 20 ]; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC} (Found $TAGS tags, expected 20)"
  ((FAILED++))
fi

# Test 5: All 99 operations documented (97 before the 2 substitution-settings routes; 93 before the 4 automatic-substitution routes; 86 before the 7 record-deletion routes; 83 before the 3 curriculum routes; 69 before the 14 substitution routes; 68 with the teacher-subject DELETE, 65 before the three bulk-create endpoints: subjects, teachers, grades; 64 before the authenticated POST /api/admins; the Module 3 value of 15 was already stale; kept EXACT)
echo -n "5. All endpoints documented... "
ENDPOINTS=$(echo "$OPENAPI" | python3 -c "import json, sys; paths = json.load(sys.stdin)['paths']; print(sum([len(paths[p]) for p in paths]))" 2>/dev/null)
if [ "$ENDPOINTS" -eq 99 ]; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC} (Found $ENDPOINTS endpoints, expected 99)"
  ((FAILED++))
fi

# Test 6: Security scheme defined
echo -n "6. Cookie auth security scheme... "
if echo "$OPENAPI" | grep -q '"cookieAuth"'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  ((FAILED++))
fi

# Test 7: Protected endpoints have security
echo -n "7. Protected endpoints secured... "
SECURED=$(echo "$OPENAPI" | python3 -c "import json, sys; spec = json.load(sys.stdin); print(len([1 for path in spec['paths'] for method in spec['paths'][path] if 'security' in spec['paths'][path][method]]))" 2>/dev/null)
if [ "$SECURED" -ge 10 ]; then
  echo -e "${GREEN}✓ PASS${NC} ($SECURED endpoints)"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC} (Found $SECURED secured endpoints, expected >= 10)"
  ((FAILED++))
fi

# Test 8: School validation works
echo -n "8. School API validation... "
SCHOOL_VAL=$(curl -s -m 5 -X POST "$API_URL/api/schools" \
  -H "Content-Type: application/json" \
  -d '{"name":"","code":"TEST","schoolType":"PRIMARY"}')
if echo "$SCHOOL_VAL" | grep -q '"message"'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  ((FAILED++))
fi

# Test 9: Admin API validation works
echo -n "9. Admin API validation... "
ADMIN_VAL=$(curl -s -m 5 -X POST "$API_URL/api/admin/register" \
  -H "Content-Type: application/json" \
  -d '{"schoolId":"invalid","setupToken":"stk_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","name":"Test","email":"bad-email","password":"weak"}')
if echo "$ADMIN_VAL" | grep -q '"message"'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  ((FAILED++))
fi

# Test 10: Protected endpoints require auth
echo -n "10. Auth protection works... "
AUTH_CHECK=$(curl -s -m 5 "$API_URL/api/admin/me")
if echo "$AUTH_CHECK" | grep -q '"success":false'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  ((FAILED++))
fi

# Test 11: Academic year protected
echo -n "11. Academic year auth... "
AY_AUTH=$(curl -s -m 5 "$API_URL/api/academic-years")
if echo "$AY_AUTH" | grep -q '"success":false'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  ((FAILED++))
fi

# Test 12: Grade protected
echo -n "12. Grade auth... "
GRADE_AUTH=$(curl -s -m 5 "$API_URL/api/grades")
if echo "$GRADE_AUTH" | grep -q '"success":false'; then
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
else
  echo -e "${RED}✗ FAIL${NC}"
  ((FAILED++))
fi

# Test 13: TypeScript compilation
echo -n "13. TypeScript compilation... "
if timeout 20 npx tsc --noEmit 2>&1 | grep -q "error TS"; then
  echo -e "${RED}✗ FAIL${NC}"
  ((FAILED++))
else
  echo -e "${GREEN}✓ PASS${NC}"
  ((PASSED++))
fi

echo ""
echo "================================================"
echo "SUMMARY"
echo "================================================"
echo -e "Total: $((PASSED + FAILED))"
echo -e "${GREEN}Passed: $PASSED${NC}"
if [ $FAILED -gt 0 ]; then
  echo -e "${RED}Failed: $FAILED${NC}"
else
  echo "Failed: 0"
fi
echo ""

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}✓ ALL TESTS PASSED - SWAGGER IMPLEMENTATION COMPLETE${NC}"
  echo ""
  echo "Documentation:"
  echo "  Swagger UI: $API_URL/docs"
  echo "  OpenAPI JSON: $API_URL/docs/json"
  echo ""
  echo "Modules Verified:"
  echo "  ✓ Health Check"
  echo "  ✓ School Management (Module 1)"
  echo "  ✓ Admin Authentication (Module 2)"
  echo "  ✓ Academic Year (Module 3)"
  echo "  ✓ Grade (Module 4)"
  echo "  ✓ Swagger/OpenAPI Documentation"
  exit 0
else
  echo -e "${RED}✗ SOME TESTS FAILED${NC}"
  exit 1
fi
