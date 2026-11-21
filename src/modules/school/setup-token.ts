import { createHash, randomBytes } from 'node:crypto';
import { type Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// School setup tokens: the single-use credential that authorizes the FIRST admin of a school.
//
//   * 256 random bits from the operating system's CSPRNG, shown to the caller exactly once, in the response that issues it.
//   * Only the SHA-256 hash is stored. A token has full entropy, so a plain fast hash is the right tool (no salt or slow KDF is needed),
//     and a database leak does not reveal usable tokens.
//   * Lookup is by hash, so the comparison never depends on the secret's characters.
//   * The raw token is never logged and never put in an error. The prefix `stk_` only lets secret scanners recognise it.
//
// Claiming a token (src/modules/admin/admin.service.ts) is one atomic UPDATE that the first admin's creation shares a transaction with.
// ---------------------------------------------------------------------------

export const SETUP_TOKEN_PREFIX = 'stk_';
/** 32 random bytes in base64url are 43 characters. */
export const SETUP_TOKEN_PATTERN = /^stk_[A-Za-z0-9_-]{43}$/;

export function generateSetupToken(): string {
  return `${SETUP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashSetupToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface IssuedSetupToken {
  /** The raw token. The only place it ever exists outside the caller's hands. */
  token: string;
  expiresAt: Date;
}

/**
 * Create the school's token row inside the caller's transaction (school creation). Fails on the unique school constraint if one exists:
 * a school gets its token when it is created, and a later token can only come from the operator-run recovery (rotateSetupToken).
 */
export async function createSetupToken(tx: Prisma.TransactionClient, schoolId: string, ttlHours: number): Promise<IssuedSetupToken> {
  const token = generateSetupToken();
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  await tx.schoolSetupToken.create({ data: { schoolId, tokenHash: hashSetupToken(token), expiresAt } });
  return { token, expiresAt };
}

/**
 * Issue a NEW token for a school, replacing any earlier one (expired, consumed or still valid). Only that school's row is written. The caller
 * (the recovery command) has already established that the school exists and has no admin.
 */
export async function rotateSetupToken(tx: Prisma.TransactionClient, schoolId: string, ttlHours: number): Promise<IssuedSetupToken> {
  const token = generateSetupToken();
  const tokenHash = hashSetupToken(token);
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  await tx.$executeRaw`
    INSERT INTO "school_setup_tokens" ("id", "schoolId", "tokenHash", "expiresAt", "createdAt")
    VALUES (gen_random_uuid()::text, ${schoolId}, ${tokenHash}, ${expiresAt}, now())
    ON CONFLICT ("schoolId") DO UPDATE
    SET "tokenHash" = EXCLUDED."tokenHash", "expiresAt" = EXCLUDED."expiresAt", "createdAt" = EXCLUDED."createdAt", "consumedAt" = NULL, "consumedByAdminId" = NULL`;
  return { token, expiresAt };
}
