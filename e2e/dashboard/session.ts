// Logs in ONCE against the disposable backend (port 4010) and writes a Playwright storageState file, so browser tests reuse the session cookie
// instead of logging in again (POST /api/admin/login is limited to 5 requests per 15 minutes per IP).
//   e2e/dashboard/e2e.sh session      ->  e2e/dashboard/.run/storage-state.json
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDisposableUrl, assertTestPort } from './lib/guard.js';

assertDisposableUrl(process.env.DATABASE_URL);
const BASE = (process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4010').replace(/\/$/, '');
const u = new URL(BASE);
if (!['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('E2E GUARD: the API under test must be on this machine.');
assertTestPort(Number(u.port));

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, '.run', 'seed-manifest.json'), 'utf8'));
const res = await fetch(`${BASE}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manifest.login.request.body) });
if (res.status === 429) throw new Error('Login is rate limited (5 per 15 minutes). Run: e2e.sh restart');
if (res.status !== 200) throw new Error(`Login failed with HTTP ${res.status}`);
const header = res.headers.get('set-cookie') ?? '';
const [pair] = header.split(';');
const [name, ...rest] = (pair ?? '').split('=');
const maxAge = Number(/Max-Age=(\d+)/i.exec(header)?.[1] ?? 604800);
if (!name || rest.length === 0) throw new Error('Login returned no session cookie');
const state = {
  cookies: [{ name, value: rest.join('='), domain: 'localhost', path: '/', expires: Math.floor(Date.now() / 1000) + maxAge, httpOnly: true, secure: false, sameSite: 'Lax' }],
  origins: [],
};
writeFileSync(join(here, '.run', 'storage-state.json'), JSON.stringify(state, null, 2), { mode: 0o600 });
console.log('session: wrote e2e/dashboard/.run/storage-state.json (cookie for domain "localhost", valid 7 days; cookies ignore the port, so it works on :5173 and :4010)');
process.exit(0);
