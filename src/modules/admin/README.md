# Admin Authentication Module

## Overview

The Admin module provides secure authentication and authorization for school administrators. It implements password-based authentication with server-side session management.

## API Endpoints

### POST /api/admin/register

Register the **first** admin of a school. This needs the school's **one-time setup token**, which the API returned (once) when the school
was created (`POST /api/schools`) or which an operator issued with the recovery command (see "Setup tokens" below). The school UUID alone is
**not** enough.

**Request Body:**
```json
{
  "schoolId": "uuid",
  "setupToken": "stk_<43 characters>",
  "name": "Admin Name",
  "email": "admin@school.com",
  "password": "StrongPass123"
}
```

**Validations:**
- `schoolId`: Required, valid UUID
- `setupToken`: Required, the token's format (`stk_` + 43 URL-safe characters). A malformed value is a `400`
- `name`: Required, 1-200 characters
- `email`: Required, valid email format, unique per school
- `password`: Required, minimum 8 characters, must contain uppercase, lowercase, and number

**Responses:** `201` admin created. `400` validation error (the token is **not** used up). `401` `Invalid or expired setup token`: the **same**
answer for an unknown school, a wrong token, another school's token, an expired token and an already-used token, so it reveals nothing about
which schools exist. `409` the school already has an administrator (a token only authorizes the first one; the token is not consumed).
`429` rate limit.

**Rate Limit**: 3 requests per hour per client (checked before the token is looked at)

### POST /api/admins

An **authenticated** admin adds another admin to **their own school**. The school always comes from the session: the body has no `schoolId`,
and a `schoolId` (or any other unknown field) is rejected with `400`.

```json
{ "name": "Second Admin", "email": "second@school.com", "password": "StrongPass123" }
```

`201` created (no password hash in the response). `400` validation (same rules as registration, plus unknown fields). `401` not authenticated.
`409` an admin with this email already exists in the school. The new admin logs in with the school UUID, their email and their password.

---

### POST /api/admin/login

Authenticate admin and create session.

**Request Body:**
```json
{
  "schoolId": "uuid",
  "email": "admin@school.com",
  "password": "StrongPass123"
}
```

**Rate Limit**: 5 requests per 15 minutes per IP

**Success Response (200):**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "id": "uuid",
    "schoolId": "uuid",
    "name": "Admin Name",
    "email": "admin@school.com",
    "createdAt": "...",
    "updatedAt": "..."
  }
}
```

**Session Cookie:**
- Name: `session_token`
- HTTP-only: true
- Secure: true (production only)
- SameSite: strict (production) / lax (development)
- Duration: 7 days

**Error Responses:**
- 400: Validation error
- 401: Invalid email or password
- 429: Rate limit exceeded

---

### POST /api/admin/logout

Logout admin and invalidate session.

**Authentication**: None required (graceful logout even if session invalid)

**Success Response (200):**
```json
{
  "success": true,
  "message": "Logout successful",
  "data": null
}
```

---

### GET /api/admin/me

Get current authenticated admin information.

**Authentication**: Required

**Success Response (200):**
```json
{
  "success": true,
  "message": "Admin retrieved successfully",
  "data": {
    "id": "uuid",
    "schoolId": "uuid",
    "email": "admin@school.com",
    "name": "Admin Name"
  }
}
```

**Error Responses:**
- 401: Authentication required / Invalid or expired session

---

## Authentication Flow

### Registration Flow (first admin: school UUID + one-time setup token; further admins: POST /api/admins)
```
1. Admin submits registration form with school ID
2. System validates school exists
3. System checks email uniqueness within school
4. Password is hashed using PBKDF2-SHA512
5. Admin record created
6. Success response (admin must login separately)
```

### Login Flow
```
1. Admin submits credentials (schoolId + email + password)
2. System finds admin by schoolId + email
3. Password verified against hash
4. Cryptographically secure session token generated
5. Session token hashed and stored in database
6. Session cookie set in browser (HTTP-only, secure)
7. Success response with admin data
```

### Authentication Check Flow
```
1. Request received with session cookie
2. Middleware reads cookie value
3. Cookie value hashed
4. Session looked up by hashed token
5. Session expiration checked
6. Admin loaded from database
7. Admin attached to request object
8. Request continues to handler
```

### Authorization Flow
```
1. Authenticated request to access resource
2. Resource's schoolId compared to admin's schoolId
3. If match: access granted
4. If mismatch: 403 Forbidden
5. If no authentication: 401 Unauthorized
```

---

## Security Measures

### Password Security
- **Hashing Algorithm**: PBKDF2-SHA512
- **Iterations**: 100,000 (OWASP recommended)
- **Salt**: 16 bytes random per password
- **Key Length**: 64 bytes (512 bits)
- **Storage Format**: `pbkdf2$iterations$salt$hash`
- **Never logged or exposed in responses**

### Session Security
- **Token Generation**: crypto.randomBytes(32) - cryptographically secure
- **Token Storage**: SHA-256 hash in database
- **Token Transmission**: HTTP-only cookie only
- **Session Duration**: 7 days with automatic extension on use
- **Session Invalidation**: On logout, immediate database deletion

### Cookie Security
- **HTTP-only**: Yes - prevents JavaScript access
- **Secure**: Yes (production) - HTTPS only
- **SameSite**: Strict (production) / Lax (development)
- **Path**: / (application-wide)
- **Max-Age**: 7 days

### Rate Limiting
- **Login**: 5 attempts per 15 minutes per IP
- **Registration**: 3 attempts per hour per IP
- **Implementation**: In-memory (production should use Redis)

### Error Messages
- Generic messages for authentication failures
- "Invalid email or password" (doesn't reveal if account exists)
- No password strength hints in error messages
- No exposure of internal errors

---

## Database Schema

### Admin Table
```prisma
model Admin {
  id           String   @id @default(uuid())
  schoolId     String
  name         String
  email        String
  passwordHash String
  sessions     AdminSession[]
  
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  
  @@unique([schoolId, email])
}
```

### AdminSession Table
```prisma
model AdminSession {
  id           String   @id @default(uuid())
  adminId      String
  sessionToken String   @unique  // SHA-256 hash
  expiresAt    DateTime
  lastUsedAt   DateTime @default(now())
  
  admin Admin @relation(fields: [adminId], references: [id], onDelete: Cascade)
  
  createdAt DateTime @default(now())
  
  @@index([sessionToken])
  @@index([adminId])
}
```

---

## Bootstrap Strategy

### School creation and the setup token
- **POST /api/schools** stays public (rate-limited to 1 school per client per 24 hours).
- The school and its **setup token** are created in **one transaction**. The response contains `setupToken` and `setupTokenExpiresAt`
  **once**; only the token's SHA-256 hash is stored (table `school_setup_tokens`), so it cannot be shown again.
- The token is 256 random bits, valid for **this school only**, **single-use** and expires (default **24 hours**, `SETUP_TOKEN_TTL_HOURS`,
  1-168). It is claimed with one atomic UPDATE in the same transaction that creates the first admin: concurrent attempts with one token
  produce exactly one admin, and any failure rolls the claim back, so an error never burns a valid token.
- Login keeps using the school UUID, email and password.

### Typical Flow
```
1. Create school (public endpoint)            -> keep schoolId and setupToken
2. Register the first admin with the token    -> POST /api/admin/register
3. Login as that admin                         -> POST /api/admin/login
4. Add more admins (optional)                  -> POST /api/admins (authenticated)
5. Create academic years, grades, etc. (protected)
```

### Setup tokens: recovery (operator only)
There is **no public way to reissue a token**. An operator with access to the server and its environment runs:

```bash
npm run setup-token -- --school-id <school uuid> --confirm-code <the school's code> [--ttl-hours <1-168>]
# production build:  node dist/cli/issue-setup-token.js --school-id ... --confirm-code ...
```

Use it when **(a)** the token expired before the first admin registered, or **(b)** an existing school (created before setup tokens
existed, or whose admins were all removed) has no admin. A school that already has an admin is refused: that admin adds others with
`POST /api/admins`.

- `--confirm-code` must be the school's code (typed, case-sensitive) so a wrong UUID cannot rotate another school's token.
- Only that school's token row is written; a previous token (expired, unused or consumed) is replaced and stops working immediately.
- **The token is the only thing printed on stdout** (one line); everything else (school name, expiry, next steps, errors) goes to stderr.
  Send it straight to where it is needed, for example `npm run setup-token -- ... 2>/dev/null | pbcopy`, or redirect stdout to a
  file created with a restrictive umask. It is not stored in readable form and cannot be shown again: run the command again to rotate.
- The command never prints the database URL or other credentials, and does not echo database error text.
- Exit codes: `0` issued, `2` usage error, `3` refused (unknown school, wrong confirmation code, school already has an admin), `1` unexpected failure.

### Security notes
- Do not log, store or email the token in clear text. Treat it like a password until the first admin has registered.
- Recovering access for a school that **has** admins but lost every password is not covered (there is no password reset yet).

---

## Protected Endpoints

### Module 1 (School)
- **GET /api/schools/:id** - Now requires authentication
- Admin can only access their own school
- Returns 403 if attempting to access another school

### Future Modules
All future endpoints will require authentication by default.

---

## TypeScript Types

```typescript
interface AuthenticatedAdmin {
  id: string;
  schoolId: string;
  email: string;
  name: string;
}

// Fastify request augmentation
declare module 'fastify' {
  interface FastifyRequest {
    admin?: AuthenticatedAdmin;
  }
}
```

---

## Middleware

### authMiddleware
**Location**: `src/middleware/auth.middleware.ts`

**Usage:**
```typescript
app.get('/protected', {
  preHandler: authMiddleware,
  handler: myHandler,
});
```

**Behavior:**
- Reads session cookie
- Validates session
- Loads admin
- Attaches to request.admin
- Returns 401 if invalid

### rateLimitMiddleware
**Location**: `src/middleware/rate-limit.middleware.ts`

**Pre-configured:**
- `authRateLimiter`: 5 requests per 15 minutes
- `registrationRateLimiter`: 3 requests per hour

**Usage:**
```typescript
app.post('/login', {
  preHandler: authRateLimiter,
  handler: loginHandler,
});
```

---

## Testing

Run test script:
```bash
./test-admin-api.sh
```

Test coverage:
- Register with valid data ✓
- Register with weak password ✓
- Register with invalid email ✓
- Register for nonexistent school ✓
- Register duplicate admin ✓
- Login with valid credentials ✓
- Login with invalid password ✓
- Login with nonexistent account ✓
- Access /admin/me without session ✓
- Access /admin/me with session ✓
- Access own school ✓
- Attempt to access another school ✓
- Logout ✓
- Access after logout ✓

---

## Known Limitations

### Password Algorithm
- Uses PBKDF2 instead of Argon2
- PBKDF2 is secure but Argon2 is preferred
- Argon2 requires native dependencies
- Can be upgraded later without breaking changes

### Rate Limiting
- In-memory storage (resets on server restart)
- Not shared across multiple server instances
- Production should use Redis

### Session Storage
- Database-backed (good for single server)
- Production scaling may benefit from Redis

### No Password Reset
- Not implemented in MODULE 2
- Planned for future module

### No Email Verification
- Admins can register without email confirmation
- Planned for future enhancement

### No 2FA
- Single-factor authentication only
- Planned for future enhancement

---

## Security Best Practices

✅ **Implemented:**
- Password hashing (PBKDF2)
- Secure session tokens
- HTTP-only cookies
- Rate limiting
- Generic error messages
- Session expiration
- Authorization checks
- No password logging

⏳ **Future Enhancements:**
- Argon2 password hashing
- Redis-backed sessions
- Redis-backed rate limiting
- Password reset flow
- Email verification
- 2FA support
- Account lockout after failed attempts
- Security audit logging

---

## Environment Variables

```bash
NODE_ENV=production          # Affects cookie security
COOKIE_SECRET=<random-secret>  # Required outside development/test: 32+ random characters (openssl rand -base64 48)
TRUST_PROXY=false            # Trusted proxies for request.ip and the rate limits (see .env.example)
```

- **`COOKIE_SECRET`**: in production (any `NODE_ENV` other than `development` or `test`, including unset) the server refuses to start
  when it is missing, shorter than 32 characters, or a placeholder/example value. In development it may stay empty (a development-only
  default is used and a warning is logged). The value is never logged.
- **`TRUST_PROXY`**: default `false` (X-Forwarded-For is ignored). Behind a reverse proxy set a hop count (`1`..`10`) or the proxy
  addresses/CIDR ranges; "trust everyone" (`true`, `*`, any `/0`) is refused at startup.
- **Rate limits** (`auth` 5 per 15 min, `registration` 3 per hour, `school-creation` 1 per 24 h) have **separate counters per limiter and
  per client** (IPv6 clients are limited as their /64). Counters are **in memory of one process**: run one instance, or also enforce the
  limits at the proxy.

---

## Files

- `admin.schema.ts` - Zod validation schemas
- `admin.service.ts` - Business logic and database operations
- `admin.controller.ts` - HTTP request handlers
- `admin.routes.ts` - Route definitions
- `README.md` - This file

---

## Related Files

- `src/middleware/auth.middleware.ts` - Authentication middleware
- `src/middleware/rate-limit.middleware.ts` - Rate limiting
- `src/utils/password.ts` - Password hashing utilities
- `src/utils/crypto.ts` - Session token generation
- `src/types/auth.ts` - TypeScript type definitions
