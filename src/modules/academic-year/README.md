# Academic Year Module

## Responsibility

Manages academic years for schools in the timetable system. An academic year represents a school's yearly academic cycle (e.g., "2026-27") with defined start and end dates.

## Architecture

Follows the standard modular architecture:
- **Routes** → Define HTTP endpoints and authentication
- **Controller** → Handle HTTP requests/responses
- **Service** → Implement business logic
- **Schema** → Validate input using Zod

## Endpoints

All endpoints require authentication via session cookie.

### Create Academic Year
**POST** `/api/academic-years`

Create a new academic year for the authenticated admin's school.

**Request Body:**
```json
{
  "name": "2026-27",
  "startDate": "2026-04-01",
  "endDate": "2027-03-31"
}
```

**Success Response (201):**
```json
{
  "success": true,
  "message": "Academic year created successfully",
  "data": {
    "id": "uuid",
    "schoolId": "uuid",
    "name": "2026-27",
    "startDate": "2026-04-01T00:00:00.000Z",
    "endDate": "2027-03-31T00:00:00.000Z",
    "status": "DRAFT",
    "createdAt": "2026-09-28T...",
    "updatedAt": "2026-09-28T..."
  }
}
```

**Error Responses:**
- `401` - Authentication required
- `400` - Validation failed (invalid dates, equal dates, etc.)
- `409` - Academic year name already exists

---

### List Academic Years
**GET** `/api/academic-years`

Retrieve all academic years for the authenticated admin's school.

**Success Response (200):**
```json
{
  "success": true,
  "message": "Academic years retrieved successfully",
  "data": [
    {
      "id": "uuid",
      "schoolId": "uuid",
      "name": "2026-27",
      "startDate": "2026-04-01T00:00:00.000Z",
      "endDate": "2027-03-31T00:00:00.000Z",
      "status": "ACTIVE",
      "createdAt": "2026-09-28T...",
      "updatedAt": "2026-09-28T..."
    },
    {
      "id": "uuid",
      "schoolId": "uuid",
      "name": "2025-26",
      "startDate": "2025-04-01T00:00:00.000Z",
      "endDate": "2026-03-31T00:00:00.000Z",
      "status": "COMPLETED",
      "createdAt": "2025-09-01T...",
      "updatedAt": "2026-04-01T..."
    }
  ]
}
```

**Ordering:** Results ordered by `startDate` descending (newest first).

**Error Responses:**
- `401` - Authentication required

---

### Get Academic Year by ID
**GET** `/api/academic-years/:id`

Retrieve a specific academic year by ID.

**Path Parameters:**
- `id` - Academic year UUID

**Success Response (200):**
```json
{
  "success": true,
  "message": "Academic year retrieved successfully",
  "data": {
    "id": "uuid",
    "schoolId": "uuid",
    "name": "2026-27",
    "startDate": "2026-04-01T00:00:00.000Z",
    "endDate": "2027-03-31T00:00:00.000Z",
    "status": "DRAFT",
    "createdAt": "2026-09-28T...",
    "updatedAt": "2026-09-28T..."
  }
}
```

**Error Responses:**
- `401` - Authentication required
- `403` - Academic year belongs to another school
- `404` - Academic year not found
- `400` - Invalid UUID format

---

### Update Academic Year
**PATCH** `/api/academic-years/:id`

Update an existing academic year.

**Path Parameters:**
- `id` - Academic year UUID

**Request Body (all fields optional):**
```json
{
  "name": "2026-2027",
  "startDate": "2026-04-01",
  "endDate": "2027-03-31",
  "status": "ACTIVE"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "Academic year updated successfully",
  "data": {
    "id": "uuid",
    "schoolId": "uuid",
    "name": "2026-2027",
    "startDate": "2026-04-01T00:00:00.000Z",
    "endDate": "2027-03-31T00:00:00.000Z",
    "status": "ACTIVE",
    "createdAt": "2026-09-28T...",
    "updatedAt": "2026-09-28T..."
  }
}
```

**Error Responses:**
- `401` - Authentication required
- `403` - Academic year belongs to another school
- `404` - Academic year not found
- `400` - Invalid status transition or validation failed
- `409` - Updated name conflicts with existing academic year

---

## Validation Rules

### Name
- **Required** for creation
- **Optional** for update
- Max length: 50 characters
- Trimmed automatically
- Must be unique within school

### Start Date
- **Required** for creation
- **Optional** for update
- Must be valid ISO 8601 date string
- Must be before end date
- Cannot equal end date

### End Date
- **Required** for creation
- **Optional** for update
- Must be valid ISO 8601 date string
- Must be after start date
- Cannot equal start date

### Date Relationship
- When updating, if only one date is provided, it's validated against the existing other date
- Both dates cannot be equal

---

## Authentication & Authorization

### Authentication
All endpoints require a valid admin session cookie.

**How it works:**
1. Admin logs in via `/api/admin/login`
2. Session cookie is set automatically
3. Cookie is sent with each request
4. Auth middleware validates session

**Unauthenticated requests:**
```json
{
  "success": false,
  "message": "Authentication required"
}
```
Status: `401 Unauthorized`

### Authorization (School Isolation)

**Core Principle:** Admins can only access their own school's data.

**Implementation:**
- `schoolId` is **never** accepted from request body/params
- `schoolId` is **always** derived from authenticated admin's session
- Cross-school access attempts return `403 Forbidden`

**Example:**
- Admin from School A cannot read/modify School B's academic years
- Even if admin knows School B's academic year ID, access is denied

**Authorization Error:**
```json
{
  "success": false,
  "message": "You do not have access to this academic year"
}
```
Status: `403 Forbidden`

---

## Status Lifecycle

### Status Values
- `DRAFT` - Initial state, planning phase
- `ACTIVE` - Currently active academic year
- `COMPLETED` - Past academic year, no longer active

### Allowed Transitions
```
DRAFT → ACTIVE → COMPLETED
```

### Status Transition Rules

| From | To | Allowed | Notes |
|------|-----|---------|-------|
| DRAFT | ACTIVE | ✅ Yes | Academic year begins |
| DRAFT | COMPLETED | ❌ No | Must go through ACTIVE |
| ACTIVE | COMPLETED | ✅ Yes | Academic year ends |
| ACTIVE | DRAFT | ❌ No | Cannot revert active year |
| COMPLETED | ACTIVE | ❌ No | Cannot reactivate |
| COMPLETED | DRAFT | ❌ No | Cannot revert completed year |

### Invalid Transition Example

**Request:**
```json
PATCH /api/academic-years/:id
{
  "status": "DRAFT"
}
```

**Current Status:** `COMPLETED`

**Response (400):**
```json
{
  "success": false,
  "message": "Invalid status transition: cannot change from COMPLETED to DRAFT"
}
```

### Initial Status
New academic years are **always** created with status `DRAFT`.

Clients cannot create academic years directly as `ACTIVE` or `COMPLETED`.

---

## Design Decisions

### 1. School ID Derivation
**Decision:** `schoolId` is derived from authenticated admin, not request body.

**Rationale:**
- Prevents authorization bypass attacks
- Eliminates need for separate schoolId validation
- Simplifies client implementation
- Follows principle of least privilege

### 2. Status Lifecycle Enforcement
**Decision:** Strictly enforce DRAFT → ACTIVE → COMPLETED lifecycle.

**Rationale:**
- Prevents invalid data states
- Clear business logic
- Easier to reason about
- Prevents accidental data corruption

**Known Limitation:**
Currently no database-level enforcement of "one ACTIVE year per school". This is validated in application logic but could have race conditions under high concurrency.

**Future Enhancement:**
Consider adding a unique partial index if this becomes a concern:
```sql
CREATE UNIQUE INDEX idx_active_academic_year 
ON academic_years(school_id) 
WHERE status = 'ACTIVE';
```

### 3. Date Storage
**Decision:** Store dates as PostgreSQL `TIMESTAMP` via Prisma `DateTime`.

**Rationale:**
- Native database date handling
- Timezone-aware (stored in UTC)
- Consistent with existing schema
- No additional dependencies needed

**Client Responsibility:**
Clients should send dates in ISO 8601 format (e.g., `"2026-04-01"`).

### 4. Duplicate Name Prevention
**Decision:** Use unique constraint `@@unique([schoolId, name])` at database level.

**Rationale:**
- Data integrity guaranteed by database
- Prevents race conditions
- Explicit conflict error handling
- Already exists in schema (no migration needed)

### 5. No Soft Deletes
**Decision:** No delete endpoint in Module 3.

**Rationale:**
- Academic years have dependent data (grades, schedules, etc.)
- Deletion policy needs careful consideration
- Cascade behavior defined by Prisma schema
- Can be added in future module if needed

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
    "startDate": ["Invalid start date format"],
    "endDate": ["End date must be after start date"]
  }
}
```

### Common Status Codes
- `200` - Success (GET, PATCH)
- `201` - Created (POST)
- `400` - Bad request (validation, invalid transitions)
- `401` - Unauthorized (no session)
- `403` - Forbidden (wrong school)
- `404` - Not found
- `409` - Conflict (duplicate name)
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
- No client-controlled schoolId
- Cross-school access attempts logged and rejected

### Data Exposure
- No sensitive data in responses (no passwords, sessions, etc.)
- Only own school's data accessible
- Error messages don't leak existence of other schools' data

---

## Testing

See `test-academic-year-api.sh` for comprehensive API tests.

**Test Coverage:**
- ✅ Create academic year
- ✅ List academic years
- ✅ Get academic year by ID
- ✅ Update academic year
- ✅ Authentication required
- ✅ Authorization enforced
- ✅ Validation rules
- ✅ Status transitions
- ✅ Duplicate prevention
- ✅ Date validation

---

## Future Enhancements

Potential improvements for later modules:

1. **Unique Active Year Constraint**
   - Database-level enforcement of one ACTIVE year per school
   - Prevents race conditions

2. **Soft Delete Support**
   - Add `deletedAt` timestamp
   - Implement restore functionality

3. **Academic Year Templates**
   - Copy configuration from previous year
   - Batch creation for multiple schools

4. **Date Range Validation**
   - Prevent overlapping academic years
   - Warn about gaps between years

5. **Audit Trail**
   - Track who made status transitions
   - Log important changes

6. **Query Filtering**
   - Filter by status: `?status=ACTIVE`
   - Filter by date range
   - Pagination for large lists
