import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted recursively, arrays kept in order. Only plain JSON values are
 * supported (the solver contract contains nothing else). `undefined` object members are skipped, like JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('canonicalJson: non-finite number');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${members.join(',')}}`;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Stable fingerprint of any JSON value (key order does not matter, array order does). */
export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
