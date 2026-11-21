import { z } from 'zod';
import { SETUP_TOKEN_PATTERN } from '../school/setup-token.js';

// Password validation: minimum 8 characters, at least one uppercase, one lowercase, one number
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(100, 'Password must not exceed 100 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

const nameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(200, 'Name must not exceed 200 characters')
  .trim();

const emailSchema = z
  .string()
  .email('Invalid email format')
  .toLowerCase()
  .trim();

/**
 * First-admin bootstrap: the school's UUID plus the one-time setup token issued when the school was created (or by the operator-run recovery
 * command). The token's FORMAT is checked here (a malformed value is a 400); whether it is valid for this school is decided, without saying
 * why it is not, by the service (401).
 */
export const registerAdminSchema = z.object({
  schoolId: z.string().uuid('Invalid school ID format'),
  setupToken: z.string({ error: 'setupToken is required' }).regex(SETUP_TOKEN_PATTERN, 'Invalid setup token format'),
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
});

/**
 * POST /api/admins (authenticated): another admin for the CALLER'S school. The school comes from the session, never from the request, so the
 * object is strict: a schoolId (or anything else unknown) in the body is a 400, not something that is ignored or trusted.
 */
export const createAdminSchema = z.strictObject({
  name: nameSchema,
  email: emailSchema,
  password: passwordSchema,
});

export const loginAdminSchema = z.object({
  schoolId: z.string().uuid('Invalid school ID format'),
  email: z
    .string()
    .email('Invalid email format')
    .toLowerCase()
    .trim(),
  password: z.string().min(1, 'Password is required'),
});

export type RegisterAdminInput = z.infer<typeof registerAdminSchema>;
export type CreateAdminInput = z.infer<typeof createAdminSchema>;
export type LoginAdminInput = z.infer<typeof loginAdminSchema>;
