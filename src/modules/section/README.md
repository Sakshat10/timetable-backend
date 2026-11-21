# Module 5b — Section Management

Sections are the actual class groups that receive teaching. Each section belongs to a grade and optionally to a stream.

## Hierarchy

```
School → Academic Year → Grade → [Stream →] Section
```

A grade either has **all streamed** or **all non-streamed** sections. Mixing is forbidden.

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/sections | ✓ | Create a section |
| GET | /api/grades/:gradeId/sections | ✓ | List sections for a grade |
| GET | /api/sections/:id | ✓ | Get section by ID |
| PATCH | /api/sections/:id | ✓ | Update name/code |

No DELETE endpoint — sections will be referenced by timetable entries and teacher assignments.

---

## Business Rules

### Academic Year status
Sections can only be created or updated while the academic year is **DRAFT**.
Read operations (GET) are always allowed.

### Non-streamed section

```json
{
  "gradeId": "...",
  "name": "Section A",
  "code": "A"
}
```

`streamId` is **omitted**. The section is attached directly to the grade.

### Streamed section

```json
{
  "gradeId": "...",
  "streamId": "...",
  "name": "Section A",
  "code": "A"
}
```

Both `gradeId` and `streamId` are provided. The stream must belong to that grade.

### The mixing rule

A grade **must not** mix streamed and non-streamed sections.

| Existing state | New request | Result |
|---|---|---|
| No sections yet | No streamId | ✅ First non-streamed section |
| No sections yet | With streamId | ✅ First streamed section |
| Already has non-streamed sections | No streamId | ✅ Add another non-streamed |
| Already has non-streamed sections | With streamId | ❌ 400 — mixing rejected |
| Already has streamed sections | With streamId | ✅ Add another streamed |
| Already has streamed sections | No streamId | ❌ 400 — mixing rejected |

Error messages are explicit:

- `"Cannot create a streamed section because this grade already contains non-streamed sections"`
- `"Cannot create a non-streamed section because this grade already uses streams"`

### Stream ownership check

When `streamId` is provided, the service verifies:
1. The stream exists
2. `stream.gradeId === request.gradeId` — a stream from Grade 12 cannot be used for Grade 11
3. The stream's grade belongs to the admin's school

### Section code uniqueness

| Context | Scope |
|---|---|
| Non-streamed grade | Unique within (gradeId, streamId=NULL) |
| Streamed grade | Unique within (gradeId, streamId) |

This means Grade 11 / Science / "A" and Grade 11 / Commerce / "A" are both valid.

Service-level check produces a clear error message before hitting the database.

Database-level protection (two partial unique indexes) provides concurrency safety:

```sql
-- Non-streamed: UNIQUE(gradeId, code) WHERE streamId IS NULL
-- Streamed: UNIQUE(gradeId, streamId, code) WHERE streamId IS NOT NULL
```

### Update restrictions

A section's `gradeId` and `streamId` are **immutable after creation**. Restructuring sections between grades or streams requires a dedicated workflow (not part of this module).

---

## Response shape

All section responses include the nested stream object (null for non-streamed):

```json
{
  "success": true,
  "message": "Section created successfully",
  "data": {
    "id": "...",
    "gradeId": "...",
    "streamId": "...",
    "name": "Section A",
    "code": "A",
    "stream": {
      "id": "...",
      "name": "Science",
      "code": "SCI"
    },
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

For non-streamed sections, `streamId` is `null` and `stream` is `null`.

---

## Error responses

| Status | Condition |
|--------|-----------|
| 400 | Validation failed |
| 400 | Academic year is ACTIVE or COMPLETED |
| 400 | Stream does not belong to the specified grade |
| 400 | Mixing rule violated |
| 401 | No valid session cookie |
| 403 | Grade belongs to another school |
| 403 | Stream belongs to another school |
| 404 | Grade not found |
| 404 | Stream not found |
| 404 | Section not found |
| 409 | Duplicate section code within grade/stream context |

---

## Section uniqueness at the database level

### Why a standard composite unique index is wrong

```sql
-- Naive approach — WRONG
UNIQUE(gradeId, streamId, code)
-- PostgreSQL treats NULL ≠ NULL in standard unique indexes
-- so (G6, NULL, 'A') and (G6, NULL, 'A') would BOTH be permitted
```

### Why two partial indexes are correct

```sql
-- Non-streamed: only applies when streamId IS NULL
CREATE UNIQUE INDEX sections_gradeId_code_no_stream_key
  ON sections (gradeId, code)
  WHERE streamId IS NULL;

-- Streamed: only applies when streamId IS NOT NULL
CREATE UNIQUE INDEX sections_gradeId_streamId_code_key
  ON sections (gradeId, streamId, code)
  WHERE streamId IS NOT NULL;
```

This gives precisely the right semantics for both cases.

---

## Files

```
src/modules/section/
├── section.schema.ts      Zod input validation
├── section.service.ts     Business logic + database operations
├── section.controller.ts  HTTP request handling
├── section.routes.ts      Fastify route definitions + Swagger schemas
└── README.md              This file
```
