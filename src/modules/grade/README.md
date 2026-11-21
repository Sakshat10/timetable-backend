# Grade Module

## Responsibility

Manages grades within academic years. A grade represents a year level (e.g., "Grade 6", "Nursery", "Grade 11") and belongs to exactly one academic year. Grades can optionally have streams and sections (implemented in future modules).

## Hierarchy

```
School
  └── Academic Year
      └── Grade
          └── optional Stream (future)
              └── Section (future)
```

## Architecture

Follows the standard modular architecture:
- **Routes** → Define HTTP endpoints and authentication
- **Controller** → Handle HTTP requests/responses
- **Service** → Implement business logic
- **Schema** → Validate input using Zod

## Endpoints

All endpoints require authentication via session cookie.

### Create Grade
**POST** `/api/grades`

Create a new grade for an academic year.

**Authentication:** Required (session cookie)

**Request Body:**
```json
{
  "academicYearId": "uuid",
  "name": "Grade 6",
  "displayOrder": 6
}
```

**Success Response (201):**
```json
{
  "success": true,
  "message": "Grade created successfully",
  "data": {
    "id": "uuid",
    "academicYearId": "uuid",
    "name": "Grade 6",
    "displayOrder": 6,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

**Error Responses:**
- `401` - Authentication required
- `400` - Validation failed or Academic Year not in DRAFT status
- `403` - Academic Year belongs to another school
- `404` - Academic Year not found
- `409` - Duplicate name or display order

---

### List Grades
**GET** `/api/grades`

Retrieve all grades for the authenticated admin's school.

**Authentication:** Required (session cookie)

**Query Parameters (optional):**
- `academicYearId` - Filter by specific academic year

**Success Response (200):**
```json
{
  "success": true,
  "message": "Grades retrieved successfully",
  "data": [
    {
      "id": "uuid",
      "academicYearId": "uuid",
      "name": "Grade 6",
      "displayOrder": 6,
      "createdAt": "...",
      "updatedAt": "..."
    },
    {
      "id": "uuid",
      "academicYearId": "uuid",
      "name": "Grade 7",
      "displayOrder": 7,
      "createdAt": "...",
      "updatedAt": "..."
    }
  ]
}
```

**Ordering:** Results ordered by `displayOrder` ascending.

**Error Responses:**
- `401` - Authentication required
- `403` - Academic Year filter belongs to another school (if filtered)
- `404` - Academic Year not found (if filtered)

---

### Get Grade by ID
**GET** `/api/grades/:id`

Retrieve a specific grade by ID.

**Authentication:** Required (session cookie)

**Path Parameters:**
- `id` - Grade UUID

**Success Response (200):**
```json
{
  "success": true,
  "message": "Grade retrieved successfully",
  "data": {
    "id": "uuid",
    "academicYearId": "uuid",
    "name": "Grade 6",
    "displayOrder": 6,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

**Error Responses:**
- `401` - Authentication required
- `403` - Grade belongs to another school
- `404` - Grade not found
- `400` - Invalid UUID format

---

### Update Grade
**PATCH** `/api/grades/:id`

Update an existing grade's name or display order.

**Authentication:** Required (session cookie)

**Path Parameters:**
- `id` - Grade UUID

**Request Body (at least one field required):**
```json
{
  "name": "Grade VI",
  "displayOrder": 6
}
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "Grade updated successfully",
  "data": {
    "id": "uuid",
    "academicYearId": "uuid",
    "name": "Grade VI",
    "displayOrder": 6,
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

**Error Responses:**
- `401` - Authentication required
- `400` - Validation failed, empty update, or Academic Year not in DRAFT status
- `403` - Grade belongs to another school
- `404` - Grade not found
- `409` - Duplicate name or display order

**Important:** Cannot change `academicYearId`. Grades cannot be moved between academic years.

---

## Validation Rules

### Name
- **Required** for creation
- **Optional** for update (at least one field required)
- Max length: 100 characters
- Automatically trimmed
- Cannot be empty after trimming
- Must be unique within academic year

**Examples:**
- ✅ "Grade 6"
- ✅ "Nursery"
- ✅ "LKG"
- ✅ "Grade 11"
- ❌ "" (empty)
- ❌ "   " (whitespace only)

### Display Order
- **Required** for creation
- **Optional** for update (at least one field required)
- Must be a positive integer
- Must be unique within academic year
- NOT automatically inferred from grade name

**Examples:**
- ✅ 1, 2, 3, 6, 10, 11
- ❌ 0 (not positive)
- ❌ -1 (negative)
- ❌ 3.5 (not integer)

**Note:** "Grade 10" does NOT automatically have displayOrder 10. Admin explicitly provides display order.

### Academic Year ID
- **Required** for creation
- Must be valid UUID format
- Must exist in database
- Must belong to authenticated admin's school
- Cannot be changed after creation

---

## Authentication & Authorization

### Authentication
All endpoints require a valid admin session cookie.

**Unauthenticated requests:**
```json
{
  "success": false,
  "message": "Authentication required"
}
```
Status: `401 Unauthorized`

### Authorization (School Isolation)

**Core Principle:** Admins can only access grades belonging to their school's academic years.

**Implementation:**
1. Admin authenticates → Session contains `schoolId`
2. Request includes `academicYearId` (for creation) or `gradeId` (for get/update)
3. System verifies: `academicYear.schoolId === admin.schoolId`
4. If match: proceed
5. If no match: return 403 Forbidden

**Example Security Flow:**
```
Admin from School A attempts to create grade for School B's academic year
→ System fetches academic year
→ Checks: academicYear.schoolId (School B) !== admin.schoolId (School A)
→ Returns 403 Forbidden
```

**Authorization Error:**
```json
{
  "success": false,
  "message": "You do not have access to this academic year"
}
```
Status: `403 Forbidden`

---

## Academic Year Status Restrictions

Grades can only be created or modified while the academic year is in **DRAFT** status.

### Status Lifecycle
```
DRAFT → ACTIVE → COMPLETED
```

### Operations by Status

| Operation | DRAFT | ACTIVE | COMPLETED |
|-----------|-------|--------|-----------|
| Create Grade | ✅ Allowed | ❌ Blocked | ❌ Blocked |
| Update Grade | ✅ Allowed | ❌ Blocked | ❌ Blocked |
| List Grades | ✅ Allowed | ✅ Allowed | ✅ Allowed |
| Get Grade | ✅ Allowed | ✅ Allowed | ✅ Allowed |

### Rationale
Once an academic year is **ACTIVE**, its structure (grades, sections, etc.) is locked to:
- Protect timetable data integrity
- Prevent disruption to ongoing academic operations
- Maintain historical data consistency

**Error When Blocked:**
```json
{
  "success": false,
  "message": "Grades can only be modified while the academic year is in DRAFT status"
}
```
Status: `400 Bad Request`

---

## Design Decisions

### 1. Academic Year Status Enforcement
**Decision:** Block grade creation/updates when academic year is not DRAFT.

**Rationale:**
- Protects timetable and scheduling data
- Prevents mid-year structural changes
- Maintains historical data integrity
- Clear point of no return for structure modifications

---

### 2. No Grade Deletion
**Decision:** DELETE endpoint not implemented.

**Rationale:**
- Grades will have dependent data (streams, sections, subjects, teachers, timetables)
- Deletion could cascade and destroy large data trees
- Deletion policy needs careful consideration
- Can be added in future module with proper safeguards

---

### 3. Display Order Not Inferred
**Decision:** Admin explicitly provides display order; not inferred from name.

**Rationale:**
- Grade names are flexible (not just "Grade 1", "Grade 2")
- Schools may have non-standard naming (Nursery, LKG, UKG)
- Grade names may not be numeric
- Explicit ordering gives full control

**Example:**
```
Nursery → displayOrder: 1
LKG → displayOrder: 2
UKG → displayOrder: 3
Grade 1 → displayOrder: 4
```

---

### 4. Grades Cannot Move Between Academic Years
**Decision:** `academicYearId` cannot be changed after creation.

**Rationale:**
- Prevents breaking dependent relationships
- Grade is tightly coupled to academic year lifecycle
- Moving would require complex data migration
- Clear data ownership model

---

### 5. Optional Academic Year Filtering
**Decision:** List endpoint supports `?academicYearId=...` query parameter.

**Rationale:**
- Useful for frontend to show grades for specific year
- Still enforces school isolation (verifies ownership)
- Keeps default behavior simple (all school's grades)

---

## Future Compatibility

### Streams and Sections (Future Modules)
This implementation is designed for future expansion:

**Current:**
```
Grade
  ├── name
  ├── displayOrder
  └── academicYearId
```

**Future:**
```
Grade
  ├── name
  ├── displayOrder
  ├── academicYearId
  ├── streams[] (optional)
  └── sections[]
```

**No Assumptions Made:**
- ❌ Every grade must have streams
- ❌ Every grade must have sections
- ❌ Grades are always 1-12
- ❌ Grade names must be numeric
- ❌ Section count stored on Grade
- ❌ Stream information stored on Grade

**Prisma Model Already Supports:**
```prisma
model Grade {
  // ...
  streams   Stream[]   // One-to-many (optional)
  sections  Section[]  // One-to-many
  // ...
}
```

---

## Error Handling

Follows project-wide error handling conventions via `src/utils/errors.ts`.

### Error Response Format
```json
{
  "success": false,
  "message": "Human-readable error message"
}
```

### Validation Errors
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": {
    "name": ["Grade name is required"],
    "displayOrder": ["Display order must be a positive number"]
  }
}
```

### Common Status Codes
- `200` - Success (GET, PATCH)
- `201` - Created (POST)
- `400` - Bad request (validation, status restriction)
- `401` - Unauthorized (no session)
- `403` - Forbidden (wrong school)
- `404` - Not found (grade or academic year)
- `409` - Conflict (duplicate name/order)
- `500` - Internal server error

---

## Security Considerations

### Input Validation
- All inputs validated via Zod schemas
- SQL injection prevented by Prisma parameterization
- No raw SQL queries used

### Authentication
- Session-based authentication (HTTP-only cookies)
- Session tokens hashed in database
- No bearer tokens or API keys

### Authorization
- School-scoped access enforced server-side
- Academic year ownership verified before grade operations
- Cross-school access attempts logged and rejected

### Data Exposure
- No sensitive data in responses
- Only own school's data accessible
- Error messages don't leak existence of other schools' data

---

## Testing

See `test-grade-api.sh` for comprehensive API tests.

**Test Coverage:**
- ✅ Create grade
- ✅ List grades
- ✅ List grades filtered by academic year
- ✅ Get grade by ID
- ✅ Update grade
- ✅ Authentication required
- ✅ Authorization enforced
- ✅ Validation rules
- ✅ Academic year status restrictions
- ✅ Duplicate prevention
- ✅ School isolation

---

## Examples

### Typical School Structure

**Academic Year: 2026-27**

**Primary Grades (no streams):**
```json
[
  {"name": "Nursery", "displayOrder": 1},
  {"name": "LKG", "displayOrder": 2},
  {"name": "UKG", "displayOrder": 3},
  {"name": "Grade 1", "displayOrder": 4},
  {"name": "Grade 2", "displayOrder": 5}
]
```

**Secondary Grades (may have streams in future):**
```json
[
  {"name": "Grade 9", "displayOrder": 9},
  {"name": "Grade 10", "displayOrder": 10},
  {"name": "Grade 11", "displayOrder": 11},
  {"name": "Grade 12", "displayOrder": 12}
]
```

**Future: Grade 11 with Streams**
```
Grade 11
  ├── Science Stream
  │   ├── Section A
  │   └── Section B
  ├── Commerce Stream
  │   └── Section A
  └── Arts Stream
      └── Section A
```

---

## Limitations

### 1. No Pagination
**Status:** Not implemented

**Current Behavior:**
- Returns all grades for school (or filtered academic year)
- Ordered by displayOrder ASC

**Risk:** Low (schools typically have <50 grades per academic year)

**Future Enhancement:** Add `?page=1&limit=20` query parameters

---

### 2. No Bulk Operations
**Status:** Not implemented

**Current Behavior:**
- Must create grades one at a time

**Future Enhancement:** 
```json
POST /api/grades/bulk
{
  "academicYearId": "uuid",
  "grades": [
    {"name": "Grade 1", "displayOrder": 1},
    {"name": "Grade 2", "displayOrder": 2}
  ]
}
```

---

### 3. No Grade Templates
**Status:** Not implemented

**Future Enhancement:** Copy grades from previous academic year

---

### 4. No Reordering Endpoint
**Status:** Not implemented

**Current Behavior:**
- Must update display orders one at a time

**Future Enhancement:**
```json
PATCH /api/grades/reorder
{
  "grades": [
    {"id": "uuid1", "displayOrder": 1},
    {"id": "uuid2", "displayOrder": 2}
  ]
}
```

---

## API Usage Examples

### Create Multiple Grades

**Step 1: Ensure Academic Year is DRAFT**
```bash
GET /api/academic-years/:id
# Verify status === "DRAFT"
```

**Step 2: Create Grades**
```bash
# Nursery
POST /api/grades
{
  "academicYearId": "...",
  "name": "Nursery",
  "displayOrder": 1
}

# LKG
POST /api/grades
{
  "academicYearId": "...",
  "name": "LKG",
  "displayOrder": 2
}

# Grade 1
POST /api/grades
{
  "academicYearId": "...",
  "name": "Grade 1",
  "displayOrder": 3
}
```

### List Grades for Specific Academic Year
```bash
GET /api/grades?academicYearId=uuid
```

### Rename a Grade
```bash
PATCH /api/grades/:id
{
  "name": "Class VI"
}
```

### Reorder a Grade
```bash
PATCH /api/grades/:id
{
  "displayOrder": 5
}
```

---

## Conclusion

The Grade module provides foundational grade-level management within academic years, with proper authentication, authorization, validation, and academic year status enforcement. It's designed for future expansion with streams and sections while maintaining data integrity and security.
