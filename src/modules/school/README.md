# School Module

## Overview

The School module handles the creation and retrieval of schools in the timetable management system.

## API Endpoints

### POST /api/schools

Create a new school.

**Request Body:**
```json
{
  "name": "ABC Public School",
  "code": "ABC001",
  "schoolType": "SECONDARY"
}
```

**Validations:**
- `name`: Required, 1-200 characters, trimmed
- `code`: Required, 1-50 characters, uppercase letters, numbers, hyphens, and underscores only, unique
- `schoolType`: Required, must be one of: `PRIMARY`, `SECONDARY`, `CUSTOM`

**Success Response (201):**
```json
{
  "success": true,
  "message": "School created successfully",
  "data": {
    "id": "uuid",
    "name": "ABC Public School",
    "code": "ABC001",
    "schoolType": "SECONDARY",
    "createdAt": "2026-09-28T12:00:00.000Z",
    "updatedAt": "2026-09-28T12:00:00.000Z"
  }
}
```

**Error Responses:**

400 - Validation Error:
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": {
    "name": ["School name is required"],
    "code": ["School code must contain only uppercase letters, numbers, hyphens, and underscores"]
  }
}
```

409 - Duplicate Code:
```json
{
  "success": false,
  "message": "School code already exists"
}
```

### GET /api/schools/:id

Get a school by ID.

**URL Parameters:**
- `id`: UUID of the school

**Success Response (200):**
```json
{
  "success": true,
  "message": "School retrieved successfully",
  "data": {
    "id": "uuid",
    "name": "ABC Public School",
    "code": "ABC001",
    "schoolType": "SECONDARY",
    "createdAt": "2026-09-28T12:00:00.000Z",
    "updatedAt": "2026-09-28T12:00:00.000Z"
  }
}
```

**Error Responses:**

400 - Invalid UUID:
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": {
    "id": ["Invalid school ID format"]
  }
}
```

404 - Not Found:
```json
{
  "success": false,
  "message": "School not found"
}
```

## Architecture

The module follows a clean architecture pattern:

```
school.routes.ts     → Route definitions
    ↓
school.controller.ts → Request/response handling
    ↓
school.service.ts    → Business logic
    ↓
database.ts          → Prisma client
    ↓
PostgreSQL
```

### Files

- **school.schema.ts**: Zod validation schemas and TypeScript types
- **school.service.ts**: Business logic and database operations
- **school.controller.ts**: HTTP request handlers
- **school.routes.ts**: Fastify route definitions

## Testing

Run the test script:
```bash
./test-school-api.sh
```

Or test manually with curl:

```bash
# Create a school
curl -X POST http://localhost:4000/api/schools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ABC Public School",
    "code": "ABC001",
    "schoolType": "SECONDARY"
  }'

# Get a school
curl http://localhost:4000/api/schools/{school-id}
```

## Business Rules

1. School codes must be unique across all schools
2. School codes must contain only uppercase letters, numbers, hyphens, and underscores
3. School type is metadata only - actual grades configured determine the real structure
4. Schools can have multiple academic years, teachers, and subjects
