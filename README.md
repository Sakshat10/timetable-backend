# School Timetable Management System - Backend

A production-grade backend API for managing school timetables, built with Node.js, TypeScript, Fastify, and Prisma.

## Tech Stack

- **Runtime**: Node.js 24.x
- **Language**: TypeScript 6.x
- **Framework**: Fastify 5.x
- **ORM**: Prisma 7.x
- **Database**: PostgreSQL (Neon)
- **Validation**: Zod 4.x

## Project Structure

```
timetable-backend/
├── prisma/
│   ├── migrations/           # Database migrations
│   └── schema.prisma        # Prisma schema
├── src/
│   ├── config/
│   │   └── database.ts      # Prisma client setup
│   ├── modules/
│   │   └── school/          # School module
│   │       ├── school.schema.ts
│   │       ├── school.service.ts
│   │       ├── school.controller.ts
│   │       ├── school.routes.ts
│   │       └── README.md
│   ├── types/
│   │   └── api.ts           # Common API types
│   ├── utils/
│   │   └── errors.ts        # Error handling
│   ├── app.ts               # Fastify app setup
│   └── server.ts            # Server entry point
├── .env                     # Environment variables
├── package.json
├── tsconfig.json
├── prisma.config.ts         # Prisma configuration
└── test-school-api.sh       # API test script

```

## Architecture

This is a **modular monolith** following clean architecture principles:

- **Routes**: Define HTTP endpoints
- **Controllers**: Handle requests, validate input, return responses
- **Services**: Business logic and database operations
- **Schemas**: Zod validation schemas

## Getting Started

### Prerequisites

- Node.js 24.x
- PostgreSQL database (Neon recommended)

### Installation

1. Install dependencies:
```bash
npm install
```

2. Configure environment variables in `.env`:
```bash
DATABASE_URL=postgresql://user:password@host/database?sslmode=require
PORT=4000
HOST=0.0.0.0
NODE_ENV=development
```

3. Generate Prisma client:
```bash
npm run prisma:generate
```

4. Run migrations (if needed):
```bash
npm run prisma:migrate
```

### Development

Start the development server with auto-reload:
```bash
npm run dev
```

The server will start at `http://localhost:4000`

### Build

Compile TypeScript to JavaScript:
```bash
npm run build
```

### Production

Run the compiled application:
```bash
npm start
```

## Available Scripts

- `npm run dev` - Start development server with auto-reload
- `npm run build` - Compile TypeScript
- `npm start` - Run production build
- `npm run prisma:generate` - Generate Prisma client
- `npm run prisma:migrate` - Run database migrations
- `npm run prisma:studio` - Open Prisma Studio

## API Endpoints

### Health Check

```
GET /health
```

Returns server status.

### Schools

```
POST /api/schools       - Create a new school
GET  /api/schools/:id   - Get school by ID
```

See [School Module Documentation](./src/modules/school/README.md) for detailed API specifications.

## Database

The application uses Prisma 7.x with PostgreSQL. Key models:

- School
- Admin
- AcademicYear
- Grade
- Stream
- Section
- Subject
- Teacher
- TeacherSubject
- SubjectRequirement
- SectionSubjectTeacher
- ScheduleConfig

### Prisma Configuration

Prisma 7.x requires a driver adapter for PostgreSQL. The configuration is split between:

- `prisma/schema.prisma` - Data model definitions
- `prisma.config.ts` - Connection and migration settings
- `src/config/database.ts` - Runtime client with pg adapter

## Error Handling

All API responses follow a consistent format:

**Success:**
```json
{
  "success": true,
  "message": "Operation successful",
  "data": { /* response data */ }
}
```

**Error:**
```json
{
  "success": false,
  "message": "Error description",
  "errors": { /* optional field-level errors */ }
}
```

HTTP status codes:
- `200` - Success
- `201` - Created
- `400` - Validation error
- `401` - Unauthenticated
- `403` - Unauthorized
- `404` - Resource not found
- `409` - Conflict (e.g., duplicate code)
- `500` - Server error

## Security

- All inputs validated with Zod
- Database queries parameterized via Prisma
- Passwords hashed (when implemented)
- HTTP-only cookies for sessions (when implemented)
- CORS configured
- No sensitive data exposed in errors

## Testing

Run the test script:
```bash
./test-school-api.sh
```

Requires `jq` for JSON formatting.

## Next Steps

Upcoming modules:
- Academic Year management
- Grade and Stream configuration
- Section management
- Subject management
- Teacher management
- Teacher-Subject assignments
- Schedule configuration
- Timetable generation

## License

ISC
