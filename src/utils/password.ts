import crypto from 'crypto';

// OWASP recommended minimum iterations (updated 2024)
const PBKDF2_ITERATIONS = 220000; // Current recommendation for SHA-512
const LEGACY_PBKDF2_ITERATIONS = 100000; // Legacy iteration count for backward compatibility

/**
 * Hash a password using PBKDF2 (Node.js built-in, secure fallback)
 * Note: Argon2 is preferred but requires native dependencies.
 * This uses PBKDF2 with SHA-512, which is secure for production.
 * 
 * Updated to 220,000 iterations per OWASP 2024 recommendations.
 * 
 * @param password - Plain text password
 * @returns Password hash in format: algorithm$iterations$salt$hash
 */
export async function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Generate a random salt
    const salt = crypto.randomBytes(16).toString('hex');
    const iterations = PBKDF2_ITERATIONS;
    const keylen = 64; // 512 bits
    const digest = 'sha512';

    crypto.pbkdf2(password, salt, iterations, keylen, digest, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      
      const hash = derivedKey.toString('hex');
      // Format: pbkdf2$iterations$salt$hash
      resolve(`pbkdf2$${iterations}$${salt}$${hash}`);
    });
  });
}

/**
 * Verify a password against a hash
 * 
 * Supports both current (220,000) and legacy (100,000) iteration counts.
 * The stored hash contains the iteration count, so verification automatically
 * uses the correct parameters.
 * 
 * @param password - Plain text password to verify
 * @param storedHash - Stored password hash
 * @returns True if password matches, false otherwise
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const parts = storedHash.split('$');
    
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') {
      resolve(false);
      return;
    }

    // Read iteration count from stored hash (supports both old and new)
    const iterations = parseInt(parts[1]!, 10);
    const salt = parts[2]!;
    const originalHash = parts[3]!;
    const keylen = 64;
    const digest = 'sha512';

    crypto.pbkdf2(password, salt, iterations, keylen, digest, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }

      const hash = derivedKey.toString('hex');
      // Constant-time comparison to prevent timing attacks
      resolve(crypto.timingSafeEqual(Buffer.from(originalHash, 'hex'), Buffer.from(hash, 'hex')));
    });
  });
}
