import { type FastifyRequest, type FastifyReply } from 'fastify';
import { type ApiErrorResponse } from '../types/api.js';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// Simple in-memory rate limiter. PROCESS-LOCAL: with more than one application instance every instance keeps its own counters, so the
// effective limit is (limit x instances). A single instance, or a limit enforced at the proxy in front of several, is the supported setup;
// see the security notes in .env.example (TRUST_PROXY) before running several instances.
const rateLimitStore = new Map<string, RateLimitEntry>();

// Cleanup old entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetTime < now) {
      rateLimitStore.delete(key);
    }
  }
}, 10 * 60 * 1000);

/**
 * The part of the key that identifies the client. request.ip is the socket address unless TRUST_PROXY names the proxies that may set it
 * (see src/config/security.ts), so this is never taken from a header the client controls on its own.
 * An IPv4-mapped IPv6 address is the same client as the IPv4 address; an IPv6 client is limited as its whole /64, because one subscriber
 * routinely controls billions of addresses inside it and would otherwise get a fresh allowance for every one.
 */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  const zoneless = ip.split('%')[0]!.toLowerCase();
  const [head, tail = ''] = zoneless.split('::');
  const headGroups = head === '' ? [] : head!.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const groups = zoneless.includes('::') ? [...headGroups, ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'), ...tailGroups] : headGroups;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Rate limiting middleware factory
 * @param name - Names the limiter. The counters of different limiters are SEPARATE: a school creation never uses up a login allowance.
 * @param maxRequests - Maximum requests allowed in the time window
 * @param windowMs - Time window in milliseconds
 */
export function createRateLimiter(name: string, maxRequests: number, windowMs: number) {
  return async function rateLimitMiddleware(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // One counter per (limiter, client)
    const identifier = `${name}:${clientKey(request.ip)}`;
    const now = Date.now();

    let entry = rateLimitStore.get(identifier);

    // Reset if window has passed
    if (!entry || entry.resetTime < now) {
      entry = {
        count: 0,
        resetTime: now + windowMs,
      };
      rateLimitStore.set(identifier, entry);
    }

    // Increment count
    entry.count++;

    // Check if limit exceeded
    if (entry.count > maxRequests) {
      const response: ApiErrorResponse = {
        success: false,
        message: 'Too many requests. Please try again later.',
      };
      reply.status(429).send(response);
      return;
    }
  };
}

// Pre-configured rate limiters
export const authRateLimiter = createRateLimiter('auth', 5, 15 * 60 * 1000); // 5 requests per 15 minutes
export const registrationRateLimiter = createRateLimiter('registration', 3, 60 * 60 * 1000); // 3 requests per hour
export const schoolCreationRateLimiter = createRateLimiter('school-creation', 1, 24 * 60 * 60 * 1000); // 1 school per 24 hours
