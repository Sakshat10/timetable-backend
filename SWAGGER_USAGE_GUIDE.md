# Swagger UI Usage Guide

## Accessing Swagger Documentation

### Development Server
```
http://localhost:4000/docs
```

### OpenAPI JSON Spec
```
http://localhost:4000/docs/json
```

## Swagger UI Features

### 1. Endpoint Organization

Endpoints are organized by tags for easy navigation:

```
📁 Health
  └─ GET /health - Health check endpoint

📁 School
  └─ POST /api/schools - Create a new school
  └─ GET /api/schools/{id} - Get school by ID 🔒

📁 Admin
  └─ POST /api/admin/register - Register a new admin
  └─ POST /api/admin/login - Admin login
  └─ POST /api/admin/logout - Admin logout
  └─ GET /api/admin/me - Get current admin 🔒

📁 Academic Year
  └─ POST /api/academic-years - Create academic year 🔒
  └─ GET /api/academic-years - List academic years 🔒
  └─ GET /api/academic-years/{id} - Get academic year by ID 🔒
  └─ PATCH /api/academic-years/{id} - Update academic year 🔒

📁 Grade
  └─ POST /api/grades - Create grade 🔒
  └─ GET /api/grades - List grades 🔒
  └─ GET /api/grades/{id} - Get grade by ID 🔒
  └─ PATCH /api/grades/{id} - Update grade 🔒
```

🔒 = Requires authentication

### 2. Testing Endpoints with "Try it out"

#### Step 1: Test a Public Endpoint

**Example: Create a School**

1. Expand `POST /api/schools`
2. Click "Try it out"
3. Fill in the request body:
```json
{
  "name": "Springfield High School",
  "code": "SPRING_HIGH_001",
  "schoolType": "SECONDARY"
}
```
4. Click "Execute"
5. View response:
   - Status code: 201
   - Response body with created school data

#### Step 2: Register an Admin

1. Get the school ID from previous response
2. Expand `POST /api/admin/register`
3. Click "Try it out"
4. Fill in the request body:
```json
{
  "schoolId": "your-school-id-here",
  "name": "John Doe",
  "email": "john@example.com",
  "password": "SecurePass123"
}
```
5. Click "Execute"
6. Admin created successfully

#### Step 3: Login

1. Expand `POST /api/admin/login`
2. Click "Try it out"
3. Fill in credentials:
```json
{
  "schoolId": "your-school-id-here",
  "email": "john@example.com",
  "password": "SecurePass123"
}
```
4. Click "Execute"
5. **Important**: The response will set a `session_token` cookie automatically
6. Your browser now has authentication for protected endpoints

#### Step 4: Test Protected Endpoints

**Example: Create Academic Year**

1. Expand `POST /api/academic-years`
2. Click "Try it out"
3. Fill in the request body:
```json
{
  "name": "2026-27",
  "startDate": "2026-04-01",
  "endDate": "2027-03-31"
}
```
4. Click "Execute"
5. Academic year created (works because you're authenticated)

### 3. Understanding Request Schemas

Each endpoint shows:

#### Request Body Schema
```
name*        string (1-200 chars)
             Academic year name

startDate*   string (date format)
             Start date (ISO 8601)

endDate*     string (date format)
             End date (ISO 8601, must be after start date)
```

**Legend:**
- `*` = Required field
- Type constraints shown in parentheses
- Validation rules in description

#### Response Schemas

**Success Response (201):**
```json
{
  "success": true,
  "message": "Academic year created successfully",
  "data": {
    "id": "uuid",
    "schoolId": "uuid",
    "name": "string",
    "startDate": "2026-04-01T00:00:00.000Z",
    "endDate": "2027-03-31T00:00:00.000Z",
    "status": "DRAFT",
    "createdAt": "2026-09-28T10:00:00.000Z",
    "updatedAt": "2026-09-28T10:00:00.000Z"
  }
}
```

**Error Response (400):**
```json
{
  "success": false,
  "message": "Validation error message"
}
```

### 4. Authentication in Swagger UI

#### Method 1: Login via Swagger (Recommended)
1. Use `POST /api/admin/login` endpoint
2. Browser automatically stores session cookie
3. All subsequent requests include authentication

#### Method 2: Manual Cookie (For Testing)
1. Click the 🔓 icon at the top right
2. Enter your session token manually
3. Click "Authorize"
4. All protected endpoints now accessible

### 5. Common Workflows

#### Workflow 1: Setup School and Admin
```
1. POST /api/schools          → Create school
2. POST /api/admin/register   → Register admin
3. POST /api/admin/login      → Login
4. GET /api/admin/me          → Verify authentication
```

#### Workflow 2: Setup Academic Year and Grades
```
1. POST /api/admin/login           → Login
2. POST /api/academic-years        → Create academic year
3. GET /api/academic-years         → List academic years
4. POST /api/grades                → Create Grade 6
5. POST /api/grades                → Create Grade 7
6. GET /api/grades                 → List all grades
7. PATCH /api/academic-years/:id   → Change status to ACTIVE
```

#### Workflow 3: Query Existing Data
```
1. POST /api/admin/login              → Login
2. GET /api/academic-years            → List academic years
3. GET /api/grades?academicYearId=... → Filter grades by academic year
4. GET /api/grades/:id                → Get specific grade details
```

### 6. Error Testing

Swagger UI is great for testing validation:

#### Test Invalid Email
```json
POST /api/admin/register
{
  "email": "not-an-email",
  ...
}
→ 400: body/email must match format "email"
```

#### Test Missing Required Field
```json
POST /api/schools
{
  "name": "Test School"
  // Missing: code, schoolType
}
→ 400: body must have required property 'code'
```

#### Test Access Without Auth
```
GET /api/admin/me (without cookie)
→ 401: Authentication required
```

#### Test Access to Other School's Data
```
GET /api/schools/:other-school-id
→ 403: You do not have access to this school
```

### 7. Rate Limiting

Some endpoints have rate limits shown in descriptions:

- `POST /api/schools`: 1 per IP per 24 hours
- `POST /api/admin/register`: 3 per hour
- `POST /api/admin/login`: 5 per 15 minutes

If you hit the rate limit:
```json
{
  "success": false,
  "message": "Too many requests. Please try again later."
}
→ 429 Too Many Requests
```

### 8. Tips for Frontend Developers

#### Generate API Client Code
Swagger UI can generate client code:
1. Click "Download" → "json"
2. Use code generators like:
   - `openapi-generator-cli`
   - `swagger-codegen`
   - `orval` (for TypeScript)

#### Type-Safe API Calls (TypeScript)
```typescript
// Example using generated types
interface CreateAcademicYearRequest {
  name: string;
  startDate: string; // ISO date
  endDate: string;   // ISO date
}

interface AcademicYearResponse {
  success: boolean;
  message: string;
  data: {
    id: string;
    schoolId: string;
    name: string;
    startDate: string;
    endDate: string;
    status: 'DRAFT' | 'ACTIVE' | 'COMPLETED';
    createdAt: string;
    updatedAt: string;
  };
}
```

#### Cookie Handling in Frontend
```javascript
// Axios automatically handles cookies
axios.post('/api/admin/login', {
  schoolId,
  email,
  password
}, {
  withCredentials: true // Important!
});

// Subsequent requests include cookie automatically
axios.get('/api/admin/me', {
  withCredentials: true
});
```

### 9. Documentation Export

#### Export OpenAPI Spec
```bash
# Download JSON
curl http://localhost:4000/docs/json > openapi.json

# Download YAML (if needed)
curl http://localhost:4000/docs/json | \
  yq eval -P - > openapi.yaml
```

#### Use in Postman
1. Open Postman
2. Import → Link
3. Enter: `http://localhost:4000/docs/json`
4. Postman creates a complete collection

#### Use in Insomnia
1. Open Insomnia
2. Import → From URL
3. Enter: `http://localhost:4000/docs/json`
4. All endpoints imported with schemas

### 10. Troubleshooting

#### Issue: "401 Unauthorized" on Protected Endpoint
**Solution**: 
1. Login via `POST /api/admin/login`
2. Ensure browser stores cookie
3. Try the protected endpoint again

#### Issue: "403 Forbidden" 
**Solution**: 
- You're trying to access another school's data
- Make sure you're using resources from your own school

#### Issue: "429 Too Many Requests"
**Solution**: 
- Wait for rate limit to reset
- Check endpoint description for rate limit details

#### Issue: Swagger UI not loading
**Solution**:
```bash
# Check if server is running
curl http://localhost:4000/health

# Restart server
npm run dev
```

#### Issue: Changes not reflected
**Solution**:
1. Hard refresh browser (Cmd+Shift+R or Ctrl+Shift+R)
2. Clear browser cache
3. Check OpenAPI JSON directly: `/docs/json`

### 11. Advanced Features

#### Expand/Collapse All
- Click section headers to expand/collapse groups
- Use browser's default expand/collapse functionality

#### Deep Linking
- Each endpoint has a unique anchor
- Share specific endpoint: `http://localhost:4000/docs#/Admin/post_api_admin_login`

#### Persist Authorization
- Enable "persistAuthorization" in UI config
- Authentication survives page refresh

#### Model Schemas
- Click "Schemas" at bottom
- View all data models
- See enum values and constraints

## Best Practices

1. **Always login first** before testing protected endpoints
2. **Check rate limits** in endpoint descriptions
3. **Read validation rules** in schema descriptions
4. **Use "Try it out"** for quick testing
5. **Export spec** for integration with other tools
6. **Clear cookies** if switching between different schools/admins

## Summary

Swagger UI at `http://localhost:4000/docs` provides:
- ✅ Interactive API testing
- ✅ Complete request/response documentation
- ✅ Validation rule visibility
- ✅ Authentication flow testing
- ✅ Error response examples
- ✅ Code generation support
- ✅ Export to other tools
- ✅ Deep linking and sharing

Perfect for development, testing, and frontend integration!
