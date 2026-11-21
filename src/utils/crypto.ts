import crypto from 'crypto';

/**
 * Generate a cryptographically secure random session token
 * @returns A 32-byte hex string (64 characters)
 */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash a session token for storage
 * @param token - The session token to hash
 * @returns SHA-256 hash of the token
 */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
