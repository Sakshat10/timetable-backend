import { randomBytes } from 'node:crypto';

// Tests run with NODE_ENV=production (it keeps Prisma's query log quiet). Production now refuses a missing or placeholder COOKIE_SECRET, so a
// test process uses its OWN random secret: never the developer's real value, never printed, gone when the process ends.
// Import this AFTER 'dotenv/config' so that it replaces whatever the .env file provided.
process.env.COOKIE_SECRET = randomBytes(36).toString('base64');
