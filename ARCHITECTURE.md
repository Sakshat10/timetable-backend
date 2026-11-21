# System Architecture

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         Frontend                             │
│                   (Next.js - Separate Repo)                  │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP/REST
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      BACKEND API                             │
│                  (Node.js + Fastify)                         │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                   API Layer                           │  │
│  │  - CORS                                               │  │
│  │  - Cookie/Session                                     │  │
│  │  - Request Validation                                 │  │
│  │  - Error Handling                                     │  │
│  └──────────────────────────────────────────────────────┘  │
│                           │                                   │
│  ┌──────────────────────────────────────────────────────┐  │
│  │              Module Layer (Modular Monolith)         │  │
│  │                                                        │  │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐             │  │
│  │  │ School   │ │  Admin   │ │ Academic │             │  │
│  │  │ Module   │ │ Module   │ │   Year   │  ...        │  │
│  │  └────┬─────┘ └────┬─────┘ └────┬─────┘             │  │
│  │       │            │            │                     │  │
│  │  ┌────▼────────────▼────────────▼─────┐             │  │
│  │  │     Common Services & Utils         │             │  │
│  │  │  - Error Handler                    │             │  │
│  │  │  - Validation                       │             │  │
│  │  │  - Types                            │             │  │
│  │  └─────────────────┬───────────────────┘             │  │
│  └──────────────────────┼───────────────────────────────┘  │
│                         │                                   │
│  ┌──────────────────────▼───────────────────────────────┐  │
│  │              Database Layer (Prisma ORM)             │  │
│  │  - Schema Management                                  │  │
│  │  - Query Builder                                      │  │
│  │  - Type Safety                                        │  │
│  │  - Migration System                                   │  │
│  └──────────────────────┬───────────────────────────────┘  │
└─────────────────────────┼───────────────────────────────────┘
                          │ pg adapter
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   PostgreSQL Database                        │
│                     (Neon Serverless)                        │
└─────────────────────────────────────────────────────────────┘

                          │ (Future)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  Scheduler Service                           │
│                (Python + OR-Tools CP-SAT)                    │
│                   (Separate Process)                         │
└─────────────────────────────────────────────────────────────┘
```

---

## Request Flow

### Typical API Request Flow

```
1. Client Request
   │
   ▼
2. Fastify Router
   │
   ▼
3. Route Handler (routes file)
   │
   ▼
4. Controller Method
   │ - Parse request
   │ - Validate with Zod
   │
   ▼
5. Service Method
   │ - Business logic
   │ - Validation
   │
   ▼
6. Prisma Query
   │ - Type-safe query
   │ - Parameter binding
   │
   ▼
7. PostgreSQL
   │
   ▼
8. Prisma Result
   │ - Type-safe result
   │
   ▼
9. Service Return
   │ - Domain object
   │
   ▼
10. Controller Response
    │ - Format API response
    │ - Set status code
    │
    ▼
11. Client Response
    - JSON response
```

### Error Flow

```
1. Error Occurs (any layer)
   │
   ▼
2. Caught in Controller try/catch
   │
   ▼
3. handleError() utility
   │ - Identify error type
   │ - Format response
   │ - Set status code
   │
   ▼
4. Client Error Response
   - Consistent format
   - User-friendly message
   - Field-level errors (if validation)
```

---

## Module Architecture

### School Module (Example)

```
src/modules/school/
│
├── school.schema.ts
│   └── Zod validation schemas
│       - CreateSchoolInput
│       - GetSchoolParams
│       - Type exports
│
├── school.service.ts
│   └── Business logic
│       - createSchool()
│       - getSchoolById()
│       - Database operations
│       - Business rule enforcement
│
├── school.controller.ts
│   └── HTTP handlers
│       - createSchool()
│       - getSchool()
│       - Request parsing
│       - Response formatting
│
├── school.routes.ts
│   └── Route definitions
│       - POST /schools
│       - GET /schools/:id
│       - Route registration
│
└── README.md
    └── API documentation
```

### Module Interaction Pattern

```
┌─────────────────────────────────────────────────┐
│              school.routes.ts                   │
│  - Defines endpoints                            │
│  - Maps URLs to controller methods              │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│           school.controller.ts                  │
│  - Receives FastifyRequest                      │
│  - Validates with school.schema.ts              │
│  - Calls school.service.ts                      │
│  - Returns FastifyReply                         │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│            school.service.ts                    │
│  - Business logic                               │
│  - Database operations via Prisma               │
│  - Domain rule enforcement                      │
│  - Returns domain objects                       │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│          config/database.ts                     │
│  - Prisma Client instance                       │
│  - Connection pooling                           │
│  - Query execution                              │
└─────────────────────────────────────────────────┘
```

---

## Data Flow

### Create School Flow

```
Client
  │
  │ POST /api/schools
  │ { name, code, schoolType }
  │
  ▼
Fastify Router
  │
  ▼
school.routes.ts
  │ app.post('/schools', ...)
  │
  ▼
school.controller.ts
  │ createSchool(request, reply)
  │
  ├─▶ school.schema.ts
  │   │ createSchoolSchema.parse()
  │   └─▶ Validated data
  │
  ▼
school.service.ts
  │ createSchool(data)
  │
  ├─▶ Check if code exists
  │   │ prisma.school.findUnique()
  │   └─▶ Conflict? Throw AppError
  │
  ├─▶ Create school
  │   │ prisma.school.create()
  │   └─▶ New school object
  │
  ▼
Controller formats response
  │ { success: true, data: school }
  │
  ▼
Client receives 201 with data
```

---

## Technology Stack Details

### Backend Layer

```
┌─────────────────────────────────────┐
│          Application                │
│  - Node.js 24.x                     │
│  - TypeScript 6.x                   │
│  - ES Modules                       │
└─────────────────┬───────────────────┘
                  │
┌─────────────────▼───────────────────┐
│         Web Framework               │
│  - Fastify 5.x                      │
│  - @fastify/cors                    │
│  - @fastify/cookie                  │
└─────────────────┬───────────────────┘
                  │
┌─────────────────▼───────────────────┐
│        Validation Layer             │
│  - Zod 4.x                          │
│  - Type-safe schemas                │
└─────────────────┬───────────────────┘
                  │
┌─────────────────▼───────────────────┐
│         ORM Layer                   │
│  - Prisma 7.x                       │
│  - @prisma/adapter-pg               │
│  - pg (connection pool)             │
└─────────────────┬───────────────────┘
                  │
┌─────────────────▼───────────────────┐
│          Database                   │
│  - PostgreSQL 14+                   │
│  - Neon Serverless                  │
└─────────────────────────────────────┘
```

---

## Separation of Concerns

### Layer Responsibilities

| Layer | Responsibility | Does NOT Handle |
|-------|---------------|-----------------|
| **Routes** | Define endpoints, map to controllers | Business logic, validation, database |
| **Controllers** | Parse requests, call services, format responses | Business rules, direct database access |
| **Services** | Business logic, data operations | HTTP concerns, response formatting |
| **Schemas** | Input/output validation | Business rules, data persistence |
| **Database** | Data persistence, queries | Business logic, HTTP concerns |

### File Responsibilities

```
server.ts
  - Start server
  - Database connection
  - Graceful shutdown
  
app.ts
  - Configure Fastify
  - Register plugins
  - Register routes
  - Define middleware
  
*.routes.ts
  - Map HTTP methods to paths
  - Register route handlers
  - NO business logic
  
*.controller.ts
  - Parse/validate requests
  - Call service methods
  - Format responses
  - Handle errors
  
*.service.ts
  - Business logic
  - Database operations
  - Domain rules
  - Throw AppError on issues
  
*.schema.ts
  - Zod validation schemas
  - Type definitions
  - Input/output contracts
  
utils/errors.ts
  - AppError class
  - handleError function
  - Error type identification
  - Consistent error responses
```

---

## Database Schema Architecture

### Entity Relationships

```
School (1) ──┬──▶ (N) Admin
             │
             ├──▶ (N) AcademicYear
             │       │
             │       └──▶ (N) Grade
             │               │
             │               ├──▶ (N) Stream
             │               │       │
             │               │       └──▶ (N) Section
             │               │
             │               └──▶ (N) Section (no stream)
             │
             ├──▶ (N) Teacher
             │       │
             │       └──▶ (N) TeacherSubject
             │               │
             │               └──▶ (N) TeacherSubjectGrade
             │
             └──▶ (N) Subject
                     │
                     └──▶ (N) SubjectRequirement
                             │
                             └──▶ (N) SectionSubjectTeacher
```

### Access Control Pattern

```
Every resource is scoped to a School
    │
    ├──▶ Admin belongs to School
    │     └──▶ Can only access their School's resources
    │
    ├──▶ AcademicYear belongs to School
    │     └──▶ Grade belongs to AcademicYear
    │           └──▶ Section belongs to Grade
    │
    └──▶ Subject belongs to School
          └──▶ SubjectRequirement references Subject
```

---

## Security Architecture

### Current Implementation

```
┌─────────────────────────────────────┐
│         Client Request              │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│           CORS Check                │
│  - Origin validation                │
│  - Credentials handling             │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│      Input Validation (Zod)         │
│  - Type checking                    │
│  - Format validation                │
│  - Required fields                  │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│     Database Query (Prisma)         │
│  - Parameterized queries            │
│  - Type-safe operations             │
│  - Automatic SQL injection          │
│    prevention                        │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│       Response Sanitization         │
│  - No stack traces                  │
│  - No internal errors               │
│  - Consistent format                │
└─────────────────────────────────────┘
```

### Authentication Layer (implemented in Module 2)

```
Client Request
  │
  ▼
┌─────────────────────────────────────┐
│      Authentication Check           │
│  - Verify session cookie            │
│  - Load admin from session          │
│  - Reject if not authenticated      │
└─────────────────┬───────────────────┘
                  │
                  ▼
┌─────────────────────────────────────┐
│      Authorization Check            │
│  - Verify resource ownership        │
│  - Check admin's school ID          │
│  - Reject if not authorized         │
└─────────────────┬───────────────────┘
                  │
                  ▼
            Route Handler
```

---

## Development Workflow

### Adding a New Module

```
1. Create folder
   src/modules/{module-name}/

2. Create schema
   {module}.schema.ts
   - Zod validation
   - TypeScript types

3. Create service
   {module}.service.ts
   - Business logic
   - Database operations

4. Create controller
   {module}.controller.ts
   - Request handlers
   - Error handling

5. Create routes
   {module}.routes.ts
   - Endpoint definitions

6. Register routes
   src/app.ts
   - Import and register

7. Test
   - Create test script
   - Manual testing
   - Validate all cases

8. Document
   - Create README.md
   - Update main docs
```

---

## Deployment Architecture (Future)

```
┌─────────────────────────────────────┐
│        Load Balancer                │
└─────────────────┬───────────────────┘
                  │
        ┌─────────┴─────────┐
        │                   │
        ▼                   ▼
┌──────────────┐    ┌──────────────┐
│   Backend    │    │   Backend    │
│  Instance 1  │    │  Instance 2  │
└──────┬───────┘    └──────┬───────┘
       │                   │
       └─────────┬─────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│      PostgreSQL (Neon)              │
│  - Connection pooling               │
│  - Automatic scaling                │
└─────────────────────────────────────┘
```

---

## Performance Considerations

### Database Access

- ✅ Connection pooling via pg
- ✅ Prepared statements via Prisma
- ✅ Indexed fields in schema
- ⏳ Query optimization (when needed)
- ⏳ Caching layer (when needed)

### API Performance

- ✅ Fast framework (Fastify)
- ✅ Efficient JSON serialization
- ⏳ Response compression (future)
- ✅ Rate limiting (in-memory, per IP, on login/registration/school creation)
- ⏳ CDN for static assets (future)

---

## Scalability Strategy

### Horizontal Scaling
- Stateless API servers
- Session in database/Redis
- Load balancer distributes traffic

### Database Scaling
- Neon handles connection pooling
- Read replicas (if needed)
- Query optimization
- Proper indexing

### Caching Strategy (Future)
- Redis for session storage
- Cache frequently accessed data
- Invalidation strategy

---

**Last Updated**: September 28, 2026  
**Architecture Version**: 1.0  
**Status**: Modular Monolith - Production Ready for MVP
