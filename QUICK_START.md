# Quick Start Guide

## Start Development

```bash
npm run dev
```

Server runs at: **http://localhost:4000**

## Test School API

```bash
# Create a school
curl -X POST http://localhost:4000/api/schools \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test School",
    "code": "TEST_'$(date +%s)'",
    "schoolType": "SECONDARY"
  }'

# Get a school (replace {id} with actual school ID)
curl http://localhost:4000/api/schools/{id}

# Run full test suite
./test-school-api.sh
```

## Project Structure

```
src/
├── modules/school/          ← School CRUD operations
├── config/database.ts       ← Prisma client
├── utils/errors.ts          ← Error handling
├── types/api.ts             ← API types
├── app.ts                   ← Fastify setup
└── server.ts                ← Entry point
```

## API Response Format

**Success:**
```json
{
  "success": true,
  "message": "...",
  "data": { }
}
```

**Error:**
```json
{
  "success": false,
  "message": "...",
  "errors": { }
}
```

## Status Codes

- `200` - OK
- `201` - Created
- `400` - Validation error
- `404` - Not found
- `409` - Conflict (duplicate)
- `500` - Server error

## Key Files

- **README.md** - Full project documentation
- **DEVELOPMENT.md** - Development roadmap and patterns
- **src/modules/school/README.md** - School API documentation
- **.env** - Environment configuration
- **prisma/schema.prisma** - Database schema

## Useful Commands

```bash
npm run dev              # Start development server
npm run build            # Build for production
npx tsc --noEmit        # Validate TypeScript
npm run prisma:generate  # Generate Prisma client
npm run prisma:studio    # Open database GUI
```

## Next Steps

1. Review **DEVELOPMENT.md** for full module roadmap
2. Implement MODULE 2 - ADMIN (authentication)
3. Follow the same pattern for each new module

## Need Help?

- Check **DEVELOPMENT.md** for detailed patterns
- Review **src/modules/school/** for reference implementation
- Test with curl or Postman
- Check Fastify logs for errors
