import { isIP } from 'node:net';

// ---------------------------------------------------------------------------
// Startup security configuration: the cookie secret and the trusted-proxy setting. PURE (they take the environment as an argument),
// so they are testable without starting a server. A bad value is a startup ERROR, never a silent fallback in production.
//
// Error messages never contain the value that was rejected.
// ---------------------------------------------------------------------------

/** Environments where convenient defaults are allowed. Anything else (including an unset NODE_ENV) is treated as production: fail closed. */
const RELAXED_ENVIRONMENTS = new Set(['development', 'test']);
export const isRelaxedEnvironment = (nodeEnv: string | undefined): boolean => RELAXED_ENVIRONMENTS.has((nodeEnv ?? '').trim());

export const MIN_COOKIE_SECRET_LENGTH = 32;
const MIN_COOKIE_SECRET_DISTINCT_CHARS = 10;
/** The value the application used to fall back to, and other obvious placeholders. */
const PLACEHOLDER_SECRET = /change[-_ ]?(this|me)|replace[-_ ]?me|your[-_ ]?(secret|key)|placeholder|example|default|insecure|development[-_ ]?only|not[-_ ]?for[-_ ]?production|^(secret|password|cookie[-_ ]?secret)$/i;
/** Used only outside production, when COOKIE_SECRET is not set. Public in the source on purpose: it protects nothing. */
const DEVELOPMENT_ONLY_SECRET = 'development-only-cookie-secret-not-for-production-use';

export interface CookieSecret {
  secret: string;
  /** A development-only notice for the caller to log. Never contains the secret. */
  warning?: string;
}

export function resolveCookieSecret(env: Record<string, string | undefined>): CookieSecret {
  const raw = env.COOKIE_SECRET?.trim() ?? '';
  const relaxed = isRelaxedEnvironment(env.NODE_ENV);

  if (relaxed) {
    if (raw === '') return { secret: DEVELOPMENT_ONLY_SECRET, warning: 'COOKIE_SECRET is not set: using the development-only default. Set a random value of at least 32 characters before any real deployment.' };
    return { secret: raw };
  }

  if (raw === '') throw new Error(`COOKIE_SECRET must be set to a random value of at least ${MIN_COOKIE_SECRET_LENGTH} characters (NODE_ENV is not development or test)`);
  if (raw.length < MIN_COOKIE_SECRET_LENGTH) throw new Error(`COOKIE_SECRET is too short: it must be at least ${MIN_COOKIE_SECRET_LENGTH} characters`);
  if (PLACEHOLDER_SECRET.test(raw)) throw new Error('COOKIE_SECRET looks like a placeholder or example value: generate a random one (for example with: openssl rand -base64 48)');
  if (new Set(raw).size < MIN_COOKIE_SECRET_DISTINCT_CHARS) throw new Error('COOKIE_SECRET is not random enough (too few distinct characters): generate one with: openssl rand -base64 48');
  return { secret: raw };
}

// ---------------------------------------------------------------------------
// TRUST_PROXY: which proxies may tell us the client's address (X-Forwarded-For).
//
//   unset, empty, false, 0, off, no   -> false: trust NOBODY. request.ip is the socket address and forwarding headers are ignored.
//   a whole number 1..10              -> trust that many proxy hops in front of the app (the client is the entry that many hops from the right)
//   comma-separated IPs / CIDRs / the proxy-addr keywords loopback, linklocal, uniquelocal
//                                     -> trust forwarding headers ONLY from those addresses
//
// "Trust everything" (true, *, 0.0.0.0/0, ::/0) is refused: it lets any client choose its own address and defeats every IP-based limit.
// ---------------------------------------------------------------------------
export type TrustProxySetting = false | number | string[];

const OFF_VALUES = new Set(['', 'false', '0', 'off', 'no']);
const KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);
const MAX_HOPS = 10;

function isCidr(value: string): boolean {
  const [address, prefix, ...rest] = value.split('/');
  if (address === undefined || prefix === undefined || rest.length > 0 || !/^\d{1,3}$/.test(prefix)) return false;
  const version = isIP(address);
  if (version === 0) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const text = (raw ?? '').trim();
  if (OFF_VALUES.has(text.toLowerCase())) return false;

  if (/^\d+$/.test(text)) {
    const hops = Number(text);
    if (hops < 1 || hops > MAX_HOPS) throw new Error(`TRUST_PROXY as a hop count must be between 1 and ${MAX_HOPS}`);
    return hops;
  }

  const entries = text.split(',').map((e) => e.trim());
  const allowed: string[] = [];
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    if (lower === 'true' || entry === '*') throw new Error('TRUST_PROXY must not trust every client (true or *): list the proxy addresses or give a hop count');
    if (/\/0+$/.test(entry)) throw new Error('TRUST_PROXY must not contain a /0 range (that trusts every address)');
    if (KEYWORDS.has(lower)) allowed.push(lower);
    else if (isIP(entry) !== 0 || isCidr(entry)) allowed.push(entry);
    else throw new Error('TRUST_PROXY must be false, a hop count (1-10), or a comma-separated list of proxy IP addresses, CIDR ranges, loopback, linklocal or uniquelocal');
  }
  if (allowed.length === 0) throw new Error('TRUST_PROXY is empty');
  return allowed;
}

/** The value handed to Fastify. A hop count becomes an explicit function: trust the nearest N proxies (hop 0 is the socket peer, the client is the entry N hops from the right). */
export function toFastifyTrustProxy(setting: TrustProxySetting): boolean | string[] | ((address: string, hop: number) => boolean) {
  return typeof setting === 'number' ? (_address: string, hop: number): boolean => hop < setting : setting;
}

// ---------------------------------------------------------------------------
// SETUP_TOKEN_TTL_HOURS: how long a school's setup token (the credential for the first admin) stays valid. Whole hours, 1..168 (one week).
// Unset or empty: 24. Anything else that is not a whole number in range is a startup error.
// ---------------------------------------------------------------------------
export const DEFAULT_SETUP_TOKEN_TTL_HOURS = 24;
export const MAX_SETUP_TOKEN_TTL_HOURS = 168;

export function resolveSetupTokenTtlHours(env: Record<string, string | undefined>): number {
  const raw = env.SETUP_TOKEN_TTL_HOURS?.trim() ?? '';
  if (raw === '') return DEFAULT_SETUP_TOKEN_TTL_HOURS;
  if (!/^\d+$/.test(raw)) throw new Error('SETUP_TOKEN_TTL_HOURS must be a whole number of hours');
  const hours = Number(raw);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > MAX_SETUP_TOKEN_TTL_HOURS) throw new Error(`SETUP_TOKEN_TTL_HOURS must be between 1 and ${MAX_SETUP_TOKEN_TTL_HOURS}`);
  return hours;
}
