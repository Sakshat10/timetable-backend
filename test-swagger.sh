#!/bin/bash

# Test Swagger/OpenAPI Documentation
# This script verifies that the Swagger UI and OpenAPI spec are properly configured

API_URL="http://localhost:4000"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "======================================"
echo "Swagger/OpenAPI Documentation Tests"
echo "======================================"
echo ""

# Test 1: Swagger UI is accessible
echo "1. Testing Swagger UI accessibility..."
SWAGGER_UI=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/docs")
if [ "$SWAGGER_UI" -eq 200 ]; then
  echo -e "${GREEN}✓ PASS${NC} - Swagger UI is accessible at $API_URL/docs"
else
  echo -e "${RED}✗ FAIL${NC} - Swagger UI returned HTTP $SWAGGER_UI"
  exit 1
fi
echo ""

# Test 2: OpenAPI JSON spec is accessible
echo "2. Testing OpenAPI JSON spec..."
OPENAPI_JSON=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/docs/json")
if [ "$OPENAPI_JSON" -eq 200 ]; then
  echo -e "${GREEN}✓ PASS${NC} - OpenAPI JSON spec is accessible at $API_URL/docs/json"
else
  echo -e "${RED}✗ FAIL${NC} - OpenAPI JSON spec returned HTTP $OPENAPI_JSON"
  exit 1
fi
echo ""

# Test 3: Verify OpenAPI version
echo "3. Testing OpenAPI version..."
OPENAPI_VERSION=$(curl -s "$API_URL/docs/json" | python3 -c "import json, sys; print(json.load(sys.stdin).get('openapi', 'not found'))")
if [ "$OPENAPI_VERSION" = "3.0.3" ]; then
  echo -e "${GREEN}✓ PASS${NC} - OpenAPI version is $OPENAPI_VERSION"
else
  echo -e "${RED}✗ FAIL${NC} - Expected OpenAPI 3.0.3, got $OPENAPI_VERSION"
  exit 1
fi
echo ""

# Test 4: Verify all expected tags exist
echo "4. Testing tags..."
TAGS=$(curl -s "$API_URL/docs/json" | python3 -c "import json, sys; tags = json.load(sys.stdin).get('tags', []); print(','.join([t['name'] for t in tags]))")
EXPECTED_TAGS="Health,School,Admin,Academic Year,Grade"
if [ "$TAGS" = "$EXPECTED_TAGS" ]; then
  echo -e "${GREEN}✓ PASS${NC} - All expected tags found: $TAGS"
else
  echo -e "${RED}✗ FAIL${NC} - Expected tags: $EXPECTED_TAGS, got: $TAGS"
  exit 1
fi
echo ""

# Test 5: Verify all endpoints are documented
echo "5. Testing endpoint documentation..."
ENDPOINT_COUNT=$(curl -s "$API_URL/docs/json" | python3 -c "import json, sys; paths = json.load(sys.stdin)['paths']; print(sum([len(paths[p]) for p in paths]))")
EXPECTED_ENDPOINTS=15
if [ "$ENDPOINT_COUNT" -eq "$EXPECTED_ENDPOINTS" ]; then
  echo -e "${GREEN}✓ PASS${NC} - All $ENDPOINT_COUNT endpoints are documented"
else
  echo -e "${YELLOW}⚠ WARNING${NC} - Expected $EXPECTED_ENDPOINTS endpoints, found $ENDPOINT_COUNT"
fi
echo ""

# Test 6: Verify security scheme is defined
echo "6. Testing security scheme..."
SECURITY_SCHEME=$(curl -s "$API_URL/docs/json" | python3 -c "import json, sys; schemes = json.load(sys.stdin).get('components', {}).get('securitySchemes', {}); print('cookieAuth' if 'cookieAuth' in schemes else 'not found')")
if [ "$SECURITY_SCHEME" = "cookieAuth" ]; then
  echo -e "${GREEN}✓ PASS${NC} - Cookie authentication security scheme is defined"
else
  echo -e "${RED}✗ FAIL${NC} - Cookie authentication security scheme not found"
  exit 1
fi
echo ""

# Test 7: Verify protected endpoints have security
echo "7. Testing protected endpoints security..."
PROTECTED_ENDPOINT_SECURITY=$(curl -s "$API_URL/docs/json" | python3 -c "import json, sys; spec = json.load(sys.stdin); protected = [path for path in spec['paths'] for method in spec['paths'][path] if 'security' in spec['paths'][path][method]]; print(len(protected))")
if [ "$PROTECTED_ENDPOINT_SECURITY" -gt 0 ]; then
  echo -e "${GREEN}✓ PASS${NC} - $PROTECTED_ENDPOINT_SECURITY protected endpoints have security requirements"
else
  echo -e "${RED}✗ FAIL${NC} - No protected endpoints found with security requirements"
  exit 1
fi
echo ""

# Test 8: List all documented endpoints
echo "8. Listing all documented endpoints..."
curl -s "$API_URL/docs/json" | python3 -c "
import json, sys
spec = json.load(sys.stdin)
for path in sorted(spec['paths'].keys()):
    for method in spec['paths'][path]:
        tag = spec['paths'][path][method].get('tags', ['Untagged'])[0]
        summary = spec['paths'][path][method].get('summary', 'No summary')
        security = '🔒' if 'security' in spec['paths'][path][method] else '🔓'
        print(f\"  {security} {method.upper():6} {path:35} [{tag}] {summary}\")
"
echo ""

# Summary
echo "======================================"
echo -e "${GREEN}✓ ALL TESTS PASSED${NC}"
echo "======================================"
echo ""
echo "Swagger UI: $API_URL/docs"
echo "OpenAPI JSON: $API_URL/docs/json"
echo ""
