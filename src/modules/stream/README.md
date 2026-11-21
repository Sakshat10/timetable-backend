# Module 5a — Stream Management

Streams are **optional** subdivisions of a Grade. They represent academic tracks such as Science, Commerce, or Arts.

## Hierarchy

```
School → Academic Year → Grade → Stream → Section
```

A grade either has streams or does not. Mixing streamed and non-streamed sections within the same grade is forbidden (enforced in the Section module).

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/streams | ✓ | Create a stream |
| GET | /api/grades/:gradeId/streams | ✓ | List streams for a grade |
| GET | /api/streams/:id | ✓ | Get stream by ID |
| PATCH | /api/streams/:id | ✓ | Update name/code |

No DELETE endpoint — streams will be referenced by subject requirements and timetable entries.

---

## Business Rules

### Academic Year status
Streams can only be created or updated while the academic year is **DRAFT**.
Read operations (GET) are always allowed.

### Ownership
Every request verifies the chain:
`stream → grade → academicYear → school === admin.schoolId`

The client never sends a `schoolId`. It is always derived from the authenticated session.

### Code normalization
Stream codes are normalized to **UPPERCASE** before saving.

```
"sci" → "SCI"
"Com" → "COM"
```

This means `SCI`, `sci`, and `Sci` are treated as the same code and only the first is accepted.

The uniqueness is enforced at both the service level (for a clear error message) and at the database level via `@@unique([gradeId, code])`.

### Name uniqueness
Stream names are also unique per grade (case-insensitive check at the service level). The database unique constraint covers codes; names rely on the service check.

---

## Example: Create a stream

```http
POST /api/streams
Content-Type: application/json
Cookie: session_token=...

{
  "gradeId": "e9613cb2-a3fa-460c-8748-6e705a0fd123",
  "name": "Science",
  "code": "sci"
}
```

Response `201`:
```json
{
  "success": true,
  "message": "Stream created successfully",
  "data": {
    "id": "...",
    "gradeId": "e9613cb2-...",
    "name": "Science",
    "code": "SCI",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

Note: `code` is returned as `"SCI"` regardless of the input case.

---

## Error responses

| Status | Condition |
|--------|-----------|
| 400 | Validation failed (missing/invalid fields) |
| 400 | Academic year is ACTIVE or COMPLETED |
| 401 | No valid session cookie |
| 403 | Grade belongs to another school |
| 404 | Grade not found |
| 404 | Stream not found |
| 409 | Duplicate code within the grade |
| 409 | Duplicate name within the grade |

---

## Files

```
src/modules/stream/
├── stream.schema.ts      Zod input validation
├── stream.service.ts     Business logic + database operations
├── stream.controller.ts  HTTP request handling
├── stream.routes.ts      Fastify route definitions + Swagger schemas
└── README.md             This file
```
