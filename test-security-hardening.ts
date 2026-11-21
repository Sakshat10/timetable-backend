// Backend security hardening (P0 items 2 and 3 of the audit): the cookie secret, trusted-proxy handling and the rate limiter.
// NO DATABASE is touched: the app is built with an injected environment and only routes that never reach the database are called.
//
//   A  COOKIE_SECRET rules (production fails closed, development stays convenient, nothing is ever logged)
//   B  TRUST_PROXY parsing (default distrust, hop counts, address lists, "trust everyone" refused)
//   C  the client key of the rate limiter (IPv4, IPv4-mapped IPv6, IPv6 /64)
//   D  rate-limit behaviour: independent limiters, per-client counters, window reset
//   E  through the REAL buildApp(): startup failures, request.ip with spoofed and trusted forwarding headers, limits keyed on the real client
//
// Run with   NODE_ENV=production npx tsx test-security-hardening.ts
import 'dotenv/config';
import { type FastifyInstance } from 'fastify';
import { buildApp } from './src/app.js';
import { isRelaxedEnvironment, parseTrustProxy, resolveCookieSecret, toFastifyTrustProxy } from './src/config/security.js';
import { clientKey, createRateLimiter } from './src/middleware/rate-limit.middleware.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const throwsWith = (fn: () => unknown, re: RegExp): boolean => { try { fn(); return false; } catch (e) { return re.test((e as Error).message); } };
const rejectsWith = async (p: Promise<unknown>, re: RegExp): Promise<boolean> => { try { await p; return false; } catch (e) { return re.test((e as Error).message); } };

const STRONG = 'k7Qp2xVn9RtLw4ZcB8mFhJ6sYd3GuAe1XoNiTb5Cz0H='; // a test value: random-looking, 44 characters
const OLD_FALLBACK = 'change-this-secret-in-production';

/** Capture everything written to stdout and stderr while `work` runs (the app logs with pino to stdout). */
async function captured<T>(work: () => Promise<T>): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => { chunks.push(String(c)); return true; }) as typeof process.stderr.write;
  try { return { result: await work(), output: chunks.join('') }; } finally { process.stdout.write = out; process.stderr.write = err; }
}

async function main(): Promise<void> {
  // ===================================================================================================================
  section('A. COOKIE_SECRET');
  {
    check('production: a strong random secret is accepted exactly as given', resolveCookieSecret({ NODE_ENV: 'production', COOKIE_SECRET: STRONG }).secret === STRONG);
    check('production: surrounding whitespace is trimmed', resolveCookieSecret({ NODE_ENV: 'production', COOKIE_SECRET: `  ${STRONG}\n` }).secret === STRONG);
    check('production: MISSING is a startup error', throwsWith(() => resolveCookieSecret({ NODE_ENV: 'production' }), /COOKIE_SECRET must be set/));
    check('production: empty or whitespace-only is a startup error', throwsWith(() => resolveCookieSecret({ NODE_ENV: 'production', COOKIE_SECRET: '' }), /must be set/) && throwsWith(() => resolveCookieSecret({ NODE_ENV: 'production', COOKIE_SECRET: '   ' }), /must be set/));
    check('production: THE OLD HARD-CODED FALLBACK is refused (it is public in the source)', throwsWith(() => resolveCookieSecret({ NODE_ENV: 'production', COOKIE_SECRET: OLD_FALLBACK }), /placeholder|example/));
    check('production: a secret shorter than 32 characters is refused', throwsWith(() => resolveCookieSecret({ NODE_ENV: 'production', COOKIE_SECRET: 'k7Qp2xVn9RtLw4ZcB8mFhJ6sYd3Gu' }), /too short/));
    check('production: placeholder-looking values are refused even when long enough', ['changeme-changeme-changeme-changeme', 'your-secret-your-secret-your-secret-123', 'this-is-an-example-value-0123456789abc', 'default-cookie-secret-0123456789abcdef'].every((v) => throwsWith(() => resolveCookieSecret({ NODE_ENV: 'production', COOKIE_SECRET: v }), /placeholder/)));
    check('production: a long but trivial value (few distinct characters) is refused', throwsWith(() => resolveCookieSecret({ NODE_ENV: 'production', COOKIE_SECRET: 'abababababababababababababababababababab' }), /not random enough/));
    check('an UNSET NODE_ENV is treated as production (fail closed): a missing secret is an error', throwsWith(() => resolveCookieSecret({}), /must be set/) && !isRelaxedEnvironment(undefined) && !isRelaxedEnvironment('staging') && !isRelaxedEnvironment('prod'));
    check('only development and test are relaxed', isRelaxedEnvironment('development') && isRelaxedEnvironment('test'));
    const dev = resolveCookieSecret({ NODE_ENV: 'development' });
    check('development without a secret: works, with a warning to log, and the warning does not contain the fallback value', dev.secret.length > 0 && !!dev.warning && !dev.warning.includes(dev.secret));
    check('development with a secret (even the placeholder from .env.example): accepted as is, no failure', resolveCookieSecret({ NODE_ENV: 'development', COOKIE_SECRET: OLD_FALLBACK }).secret === OLD_FALLBACK && resolveCookieSecret({ NODE_ENV: 'test', COOKIE_SECRET: 'x' }).secret === 'x');
    check('the development default is NOT what production would accept', throwsWith(() => resolveCookieSecret({ NODE_ENV: 'production', COOKIE_SECRET: dev.secret }), /placeholder|short|random/));
    const leak = (() => { for (const v of ['', 'short-secret-value', OLD_FALLBACK, 'abababababababababababababababababababab']) { try { resolveCookieSecret({ NODE_ENV: 'production', COOKIE_SECRET: v }); } catch (e) { if (v !== '' && (e as Error).message.includes(v)) return v; } } return ''; })();
    check('no error message ever contains the rejected value', leak === '');
  }

  // ===================================================================================================================
  section('B. TRUST_PROXY');
  {
    for (const v of [undefined, '', '  ', 'false', 'FALSE', '0', 'off', 'no']) {
      if (parseTrustProxy(v) !== false) check(`unset/off value ${JSON.stringify(v)} must mean "trust nobody"`, false);
    }
    check('unset, empty, false, 0, off and no all mean: trust NOBODY (the default)', [undefined, '', '  ', 'false', 'FALSE', '0', 'off', 'no'].every((v) => parseTrustProxy(v) === false));
    check('a hop count 1..10 is accepted as a number', parseTrustProxy('1') === 1 && parseTrustProxy('2') === 2 && parseTrustProxy(' 10 ') === 10);
    check('a hop count above 10 is refused', throwsWith(() => parseTrustProxy('11'), /between 1 and 10/) && throwsWith(() => parseTrustProxy('9999'), /between 1 and 10/));
    check('a list of proxy addresses and CIDR ranges is accepted', JSON.stringify(parseTrustProxy('10.0.0.1, 172.16.0.0/12,::1,fd00::/8')) === '["10.0.0.1","172.16.0.0/12","::1","fd00::/8"]');
    check('the proxy-addr keywords loopback, linklocal and uniquelocal are accepted', JSON.stringify(parseTrustProxy('loopback,uniquelocal')) === '["loopback","uniquelocal"]');
    check('"trust everyone" is REFUSED in every spelling (true, *, 0.0.0.0/0, ::/0, any /0)', ['true', 'TRUE', '*', '0.0.0.0/0', '::/0', '10.0.0.1,0.0.0.0/0', '10.0.0.0/0'].every((v) => throwsWith(() => parseTrustProxy(v), /every client|\/0/)));
    check('malformed entries are refused (names, bad CIDR, bad IP, empty element)', ['proxy.example.com', '10.0.0.1/33', '10.0.0.1/', '300.1.1.1', '10.0.0.1,,10.0.0.2', 'yes', '1.5', '-1'].every((v) => throwsWith(() => parseTrustProxy(v), /TRUST_PROXY/)));
    check('the Fastify mapping: false stays false, a list stays a list, a hop count becomes a trust function (nearest N hops)', toFastifyTrustProxy(false) === false && JSON.stringify(toFastifyTrustProxy(['10.0.0.1'])) === '["10.0.0.1"]' && (() => { const f = toFastifyTrustProxy(2) as (a: string, h: number) => boolean; return f('x', 0) && f('x', 1) && !f('x', 2); })());
  }

  // ===================================================================================================================
  section('C. The client key');
  {
    check('IPv4 is used as is', clientKey('203.0.113.7') === '203.0.113.7');
    check('an IPv4-mapped IPv6 address is the SAME client as the IPv4 address', clientKey('::ffff:203.0.113.7') === '203.0.113.7' && clientKey('::FFFF:203.0.113.7') === '203.0.113.7');
    check('an IPv6 client is limited as its whole /64 (addresses inside one /64 share a key)', clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd') === clientKey('2001:db8:1:2:1111:2222:3333:4444') && clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd') === '2001:db8:1:2::/64');
    check('different /64 networks stay different clients', clientKey('2001:db8:1:2::1') !== clientKey('2001:db8:1:3::1'));
    check('compressed and expanded spellings of one address agree', clientKey('2001:db8::1') === clientKey('2001:0db8:0000:0000:0000:0000:0000:0001') && clientKey('::1') === clientKey('0:0:0:0:0:0:0:1'));
    check('upper and lower case agree, and a zone id is ignored', clientKey('2001:DB8::1') === clientKey('2001:db8::1') && clientKey('fe80::1%en0') === clientKey('fe80::1'));
    check('IPv4 and IPv6 keys can never collide', !clientKey('203.0.113.7').includes(':') && clientKey('2001:db8::1').endsWith('/64'));
  }

  // ===================================================================================================================
  section('D. The limiter itself');
  {
    const call = async (limiter: ReturnType<typeof createRateLimiter>, ip: string): Promise<number> => {
      let status = 200;
      const reply = { status(code: number) { status = code; return this; }, send() { return this; } };
      await limiter({ ip } as never, reply as never);
      return status;
    };
    const tag = Date.now().toString(36);
    const a = createRateLimiter(`t-a-${tag}`, 3, 60_000);
    const results: number[] = [];
    for (let i = 0; i < 5; i++) results.push(await call(a, '198.51.100.1'));
    check('3 requests are allowed, the 4th and 5th get 429', results.join() === '200,200,200,429,429', results.join());
    check('another client has its own counter', (await call(a, '198.51.100.2')) === 200);
    check('IPv6 addresses of one /64 share one counter', (await Promise.all([1, 2, 3].map((n) => call(a, `2001:db8:77:1::${n}`)))).join() === '200,200,200' && (await call(a, '2001:db8:77:1::99')) === 429);
    // THE REGRESSION: the limiters used to share one counter per IP
    const school = createRateLimiter(`t-school-${tag}`, 1, 60_000);
    const login = createRateLimiter(`t-login-${tag}`, 5, 60_000);
    const first = await call(school, '198.51.100.50');
    const second = await call(school, '198.51.100.50');
    const logins: number[] = [];
    for (let i = 0; i < 5; i++) logins.push(await call(login, '198.51.100.50'));
    check('REGRESSION: a school creation (limit 1) that was used up does NOT consume the login allowance of the same client (5 logins still pass)', first === 200 && second === 429 && logins.join() === '200,200,200,200,200', `${first} ${second} ${logins.join()}`);
    check('...and the login limiter still stops the 6th login', (await call(login, '198.51.100.50')) === 429);
    const sameName = createRateLimiter(`t-a-${tag}`, 3, 60_000);
    check('limiters are separated by NAME: two limiters with different names never share', (await call(createRateLimiter(`t-other-${tag}`, 1, 60_000), '198.51.100.1')) === 200 && sameName !== a);
    const short = createRateLimiter(`t-short-${tag}`, 1, 80);
    const s1 = await call(short, '198.51.100.60');
    const s2 = await call(short, '198.51.100.60');
    await new Promise((r) => setTimeout(r, 120));
    check('the window expires: allowed, blocked, then allowed again after the window', s1 === 200 && s2 === 429 && (await call(short, '198.51.100.60')) === 200);
  }

  // ===================================================================================================================
  section('E. Through the real buildApp()');
  {
    const prodBase = { NODE_ENV: 'production', COOKIE_SECRET: STRONG, LOG_LEVEL: 'silent' };
    check('production, secret missing: buildApp REJECTS (the server cannot start)', await rejectsWith(buildApp({ env: { NODE_ENV: 'production', LOG_LEVEL: 'silent' } }), /COOKIE_SECRET must be set/));
    check('production, the old placeholder as secret: buildApp rejects', await rejectsWith(buildApp({ env: { ...prodBase, COOKIE_SECRET: OLD_FALLBACK } }), /placeholder/));
    check('production, a short secret: buildApp rejects', await rejectsWith(buildApp({ env: { ...prodBase, COOKIE_SECRET: 'short' } }), /too short/));
    check('an invalid TRUST_PROXY stops startup in production AND in development', await rejectsWith(buildApp({ env: { ...prodBase, TRUST_PROXY: 'true' } }), /TRUST_PROXY/) && await rejectsWith(buildApp({ env: { NODE_ENV: 'development', LOG_LEVEL: 'silent', TRUST_PROXY: '*' } }), /TRUST_PROXY/));

    const ok = await buildApp({ env: prodBase });
    check('production with a strong secret: the app builds and answers /health', (await ok.inject({ method: 'GET', url: '/health' })).statusCode === 200);
    await ok.close();

    const warned = await captured(async () => { const app = await buildApp({ env: { NODE_ENV: 'development', LOG_LEVEL: 'info' } }); await app.close(); return true; });
    check('development without a secret: the app builds, a warning is logged, and the warning says what to do', warned.result === true && /COOKIE_SECRET is not set/.test(warned.output));
    check('...and the development default itself is NOT printed', !warned.output.includes(resolveCookieSecret({ NODE_ENV: 'development' }).secret));

    const quiet = await captured(async () => {
      const app = await buildApp({ env: { NODE_ENV: 'production', COOKIE_SECRET: STRONG, LOG_LEVEL: 'info' } });
      await app.inject({ method: 'GET', url: '/health', headers: { cookie: `session_token=abc; other=${STRONG}` } });
      await app.inject({ method: 'GET', url: '/api/admin/me' });
      await app.close();
      return true;
    });
    check('a production secret never appears in the log output (startup, requests, errors)', quiet.result === true && quiet.output.length > 0 && !quiet.output.includes(STRONG), `${quiet.output.length} bytes of logs`);

    // request.ip: what the application believes the client's address is
    const ipOf = async (app: FastifyInstance, remoteAddress: string, headers: Record<string, string> = {}): Promise<string> => (await app.inject({ method: 'GET', url: '/__ip', remoteAddress, headers })).body;
    const withIpRoute = async (extra: Record<string, string>): Promise<FastifyInstance> => { const app = await buildApp({ env: { ...prodBase, ...extra } }); app.get('/__ip', async (request) => request.ip); return app; };

    const none = await withIpRoute({});
    check('DEFAULT (TRUST_PROXY unset): request.ip is the socket address; a spoofed X-Forwarded-For is IGNORED', (await ipOf(none, '203.0.113.9', { 'x-forwarded-for': '1.2.3.4' })) === '203.0.113.9' && (await ipOf(none, '203.0.113.9', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8', forwarded: 'for=9.9.9.9' })) === '203.0.113.9');
    await none.close();

    const listed = await withIpRoute({ TRUST_PROXY: '10.0.0.1' });
    check('a TRUSTED proxy (10.0.0.1): the client address from X-Forwarded-For is used', (await ipOf(listed, '10.0.0.1', { 'x-forwarded-for': '198.51.100.23' })) === '198.51.100.23');
    check('an UNTRUSTED peer sending X-Forwarded-For is ignored even though a proxy is configured', (await ipOf(listed, '203.0.113.9', { 'x-forwarded-for': '198.51.100.23' })) === '203.0.113.9');
    check('through the trusted proxy, a client-supplied fake entry to the LEFT is not believed (the proxy appended the real client on the right)', (await ipOf(listed, '10.0.0.1', { 'x-forwarded-for': '6.6.6.6, 198.51.100.23' })) === '198.51.100.23');
    await listed.close();

    const range = await withIpRoute({ TRUST_PROXY: '10.0.0.0/8' });
    check('a CIDR range of proxies: any peer inside it is trusted, a peer outside is not', (await ipOf(range, '10.9.8.7', { 'x-forwarded-for': '198.51.100.24' })) === '198.51.100.24' && (await ipOf(range, '11.9.8.7', { 'x-forwarded-for': '198.51.100.24' })) === '11.9.8.7');
    await range.close();

    const hops = await withIpRoute({ TRUST_PROXY: '1' });
    check('TRUST_PROXY=1 (one proxy in front): the client is the LAST entry the proxy appended; entries before it are attacker-controlled and ignored', (await ipOf(hops, '172.31.0.5', { 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 198.51.100.25' })) === '198.51.100.25');
    check('...a request with no forwarding header gets the socket address', (await ipOf(hops, '172.31.0.5')) === '172.31.0.5');
    await hops.close();

    const two = await withIpRoute({ TRUST_PROXY: '2' });
    check('TRUST_PROXY=2 (two proxies): the client is two hops from the right', (await ipOf(two, '172.31.0.5', { 'x-forwarded-for': '6.6.6.6, 198.51.100.26, 172.31.0.9' })) === '198.51.100.26');
    await two.close();

    // rate limits keyed on the real client, end to end through the real app
    const tag = Date.now().toString(36);
    const limitedRoute = async (extra: Record<string, string>, name: string): Promise<FastifyInstance> => {
      const app = await buildApp({ env: { ...prodBase, ...extra } });
      app.post('/__limited', { preHandler: createRateLimiter(name, 2, 60_000) }, async () => ({ ok: true }));
      return app;
    };
    const hit = async (app: FastifyInstance, remoteAddress: string, headers: Record<string, string> = {}): Promise<number> => (await app.inject({ method: 'POST', url: '/__limited', remoteAddress, headers })).statusCode;

    const direct = await limitedRoute({}, `e-direct-${tag}`);
    const spoof: number[] = [];
    for (let i = 0; i < 4; i++) spoof.push(await hit(direct, '203.0.113.30', { 'x-forwarded-for': `10.0.0.${i + 1}` }));
    check('SPOOFING DOES NOT HELP: a client changing X-Forwarded-For on every request is still limited as one client (200,200,429,429)', spoof.join() === '200,200,429,429', spoof.join());
    check('another real client behind no proxy has its own allowance', (await hit(direct, '203.0.113.31')) === 200);
    await direct.close();

    const behind = await limitedRoute({ TRUST_PROXY: '10.0.0.1' }, `e-proxy-${tag}`);
    const clientA: number[] = []; const clientB: number[] = [];
    for (let i = 0; i < 3; i++) clientA.push(await hit(behind, '10.0.0.1', { 'x-forwarded-for': '198.51.100.40' }));
    for (let i = 0; i < 2; i++) clientB.push(await hit(behind, '10.0.0.1', { 'x-forwarded-for': '198.51.100.41' }));
    check('BEHIND THE TRUSTED PROXY: two real clients get separate limits (A is blocked on its 3rd request, B, behind the same proxy address, is not)', clientA.join() === '200,200,429' && clientB.join() === '200,200', `${clientA.join()} | ${clientB.join()}`);
    const forged: number[] = [];
    for (let i = 0; i < 3; i++) forged.push(await hit(behind, '203.0.113.99', { 'x-forwarded-for': `198.51.100.${100 + i}` }));
    check('...and a stranger (not the proxy) cannot pick its own identity: forging X-Forwarded-For from an untrusted address is limited as the stranger itself', forged.join() === '200,200,429', forged.join());
    await behind.close();

    const noProxyConfigured = await limitedRoute({}, `e-noproxy-${tag}`);
    const sharedProxy: number[] = [];
    for (let i = 0; i < 3; i++) sharedProxy.push(await hit(noProxyConfigured, '10.0.0.1', { 'x-forwarded-for': `198.51.100.${60 + i}` }));
    check('WITHOUT TRUST_PROXY behind a proxy all users share the proxy address (the documented reason TRUST_PROXY must be set for a proxied deployment)', sharedProxy.join() === '200,200,429', sharedProxy.join());
    await noProxyConfigured.close();
  }
}

main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(() => {
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
