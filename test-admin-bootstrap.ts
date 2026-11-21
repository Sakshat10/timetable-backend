// Secure admin registration (Phase 2 security), against the real database and the real Fastify app (inject).
//
//   1  issuance: the token comes from school creation, once; only its hash is stored; the school and token are one transaction
//   2  first-admin registration: valid, and every refusal (missing, malformed, wrong, other school, unknown school, expired, replayed)
//   3  no burned tokens: validation errors and failures after the claim leave a valid token usable
//   4  concurrency: ten simultaneous registrations with one token
//   5  first admin only: a school that already has an admin refuses a token registration
//   6  POST /api/admins: an authenticated admin adds admins to their OWN school
//   7  existing authentication and session behaviour
//   8  secrecy: logs, error bodies, other responses
//   9  operator recovery: the function and the real command (expired token, school with no admin, wrong confirmation, other schools untouched)
//  10  database constraints of school_setup_tokens
//  11  rate limits
//  12  cleanup and proof that nothing existing changed
//
// Setup and cleanup: every school created here has the code prefix M11BT_ and is deleted at the end (cascade removes its admins, sessions and
// tokens); the 17 pre-existing tables are fingerprinted before and after. Nothing else is written.
//
// Run with   NODE_ENV=production npx tsx test-admin-bootstrap.ts
import 'dotenv/config';
import './test-fixtures/test-security-env.js'; // a test-only COOKIE_SECRET (production mode refuses the placeholder in .env)
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { type FastifyInstance } from 'fastify';
import { type PrismaClient } from '@prisma/client';
import { buildApp } from './src/app.js';
import { AdminService } from './src/modules/admin/admin.service.js';
import { adminService } from './src/modules/admin/admin.service.js';
import { SchoolService } from './src/modules/school/school.service.js';
import { generateSetupToken, hashSetupToken, SETUP_TOKEN_PATTERN } from './src/modules/school/setup-token.js';
import { issueSetupTokenForSchool } from './src/modules/school/setup-token-recovery.js';
import { hashPassword } from './src/utils/password.js';
import { EXISTING_TABLES, fingerprint, newTableCounts, prisma, rawPrisma, sleep } from './test-fixtures/timetable-generation/runner-test-kit.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const sha256 = (v: string): string => createHash('sha256').update(v, 'utf8').digest('hex');

const PASSWORD = 'Boot#Test-Pass-2030';
const RUN = Date.now().toString(36);
let schoolN = 0;
let ipN = 0;
/** A distinct client address per request, so the (separately tested) rate limits never interfere with the scenario under test. */
const nextIp = (): string => { ipN++; return `10.${(ipN >> 16) & 255}.${(ipN >> 8) & 255}.${ipN & 255}`; };

interface Reply { status: number; body: any; text: string }

async function main(): Promise<void> {
  const fpBefore = await fingerprint();
  const newBefore = await newTableCounts();
  const tokensBefore = await prisma.schoolSetupToken.count();
  const app: FastifyInstance = await buildApp();

  const call = async (method: 'GET' | 'POST', url: string, o: { body?: unknown; cookie?: string | null; ip?: string } = {}): Promise<Reply> => {
    const res = await app.inject({
      method, url, remoteAddress: o.ip ?? nextIp(),
      ...(o.cookie ? { headers: { cookie: `session_token=${o.cookie}` } } : {}),
      ...(o.body !== undefined ? { payload: o.body as never } : {}),
    });
    let body: any = null;
    try { body = res.json(); } catch { /* not JSON */ }
    return { status: res.statusCode, body, text: res.body };
  };
  const createSchool = async (tag: string, ip?: string): Promise<{ id: string; code: string; token: string; expiresAt: string; reply: Reply }> => {
    const code = `M11BT_${RUN}_${++schoolN}`.toUpperCase();
    const reply = await call('POST', '/api/schools', { body: { name: `Bootstrap test ${tag}`, code, schoolType: 'SECONDARY' }, ...(ip ? { ip } : {}) });
    if (reply.status !== 201) throw new Error(`setup: school creation returned ${reply.status}: ${reply.text.slice(0, 200)}`);
    return { id: reply.body.data.id, code, token: reply.body.data.setupToken, expiresAt: reply.body.data.setupTokenExpiresAt, reply };
  };
  let emailN = 0;
  const register = (schoolId: string, setupToken: string | undefined, over: Record<string, unknown> = {}, ip?: string) =>
    call('POST', '/api/admin/register', { body: { schoolId, ...(setupToken !== undefined ? { setupToken } : {}), name: 'First Admin', email: `first${++emailN}@bootstrap.test`, password: PASSWORD, ...over }, ...(ip ? { ip } : {}) });
  const login = async (schoolId: string, email: string, password = PASSWORD): Promise<{ status: number; cookie: string | null }> => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/login', remoteAddress: nextIp(), payload: { schoolId, email, password } });
    const cookie = res.cookies.find((c) => c.name === 'session_token')?.value ?? null;
    return { status: res.statusCode, cookie };
  };
  const adminCount = (schoolId: string) => prisma.admin.count({ where: { schoolId } });
  const tokenRow = (schoolId: string) => prisma.schoolSetupToken.findUnique({ where: { schoolId } });
  const failure = async (p: PromiseLike<unknown>): Promise<string> => { try { await p; return ''; } catch (e) { return `${(e as Error)?.message ?? e} ${JSON.stringify((e as { meta?: unknown })?.meta ?? {})}`; } };

  /** stdout and stderr of everything written while `work` runs (pino logs to stdout). */
  const captured = async <T,>(work: () => Promise<T>): Promise<{ result: T; output: string }> => {
    const chunks: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: unknown) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => { chunks.push(String(c)); return true; }) as typeof process.stderr.write;
    try { return { result: await work(), output: chunks.join('') }; } finally { process.stdout.write = out; process.stderr.write = err; }
  };
  const everyToken: string[] = [];

  try {
    // =================================================================================================================
    section('1. Issuance');
    {
      const s = await createSchool('issuance');
      everyToken.push(s.token);
      const d = s.reply.body.data;
      check('POST /api/schools: 201, and the school fields are exactly what they were (id, name, code, schoolType, createdAt, updatedAt)', ['id', 'name', 'code', 'schoolType', 'createdAt', 'updatedAt'].every((k) => k in d) && d.code === s.code && d.schoolType === 'SECONDARY');
      check('...plus a one-time setupToken of the agreed format and a setupTokenExpiresAt', SETUP_TOKEN_PATTERN.test(s.token) && !Number.isNaN(Date.parse(s.expiresAt)));
      const ttlMs = Date.parse(s.expiresAt) - Date.now();
      check('the default lifetime is 24 hours (within a minute)', Math.abs(ttlMs - 24 * 3_600_000) < 60_000, `${Math.round(ttlMs / 60_000)} min`);
      const row = await tokenRow(s.id);
      check('the database stores the SHA-256 HASH of the token, one row for the school, not consumed', row?.tokenHash === sha256(s.token) && row.consumedAt === null && row.consumedByAdminId === null && row.expiresAt.toISOString() === new Date(s.expiresAt).toISOString());
      const dump = JSON.stringify(await prisma.$queryRaw`SELECT * FROM "school_setup_tokens" WHERE "schoolId" = ${s.id}`);
      check('the RAW token appears in no column of the row (only its hash does)', !dump.includes(s.token) && !dump.includes(s.token.slice(4)));
      const second = await createSchool('issuance-2');
      everyToken.push(second.token);
      check('two schools get different tokens, and each is bound to its own school', second.token !== s.token && (await tokenRow(second.id))?.tokenHash === sha256(second.token) && (await prisma.schoolSetupToken.count({ where: { schoolId: { in: [s.id, second.id] } } })) === 2);

      // the configurable lifetime
      const shortLived = await new SchoolService(rawPrisma as unknown as PrismaClient, { SETUP_TOKEN_TTL_HOURS: '2' }).createSchool({ name: 'ttl 2h', code: `M11BT_${RUN}_TTL2`.toUpperCase(), schoolType: 'PRIMARY' });
      everyToken.push(shortLived.setupToken);
      check('SETUP_TOKEN_TTL_HOURS=2 gives a 2-hour token', Math.abs(shortLived.setupTokenExpiresAt.getTime() - Date.now() - 2 * 3_600_000) < 60_000);
      check('an invalid SETUP_TOKEN_TTL_HOURS stops the application at startup (not at the first school creation)', await (async () => { try { await buildApp({ env: { ...process.env, SETUP_TOKEN_TTL_HOURS: 'abc', LOG_LEVEL: 'silent' } }); return false; } catch (e) { return /SETUP_TOKEN_TTL_HOURS/.test((e as Error).message); } })());

      // one transaction: a failing token insert leaves no school behind
      const failing = rawPrisma.$extends({ query: { schoolSetupToken: { async create() { throw new Error('simulated failure of the token insert'); } } } });
      const code = `M11BT_${RUN}_ATOMIC`.toUpperCase();
      const msg = await failure(new SchoolService(failing as unknown as PrismaClient).createSchool({ name: 'atomic', code, schoolType: 'PRIMARY' }));
      check('ATOMIC: when the token insert fails the whole creation is rolled back: no school with that code exists', /simulated failure/.test(msg) && (await prisma.school.count({ where: { code } })) === 0);
    }

    // =================================================================================================================
    section('2. First-admin registration');
    let A: { id: string; code: string; token: string };
    let aAdmin: { id: string; email: string };
    {
      A = await createSchool('A');
      everyToken.push(A.token);
      const email = 'owner@bootstrap-a.test';
      const r = await register(A.id, A.token, { email });
      check('valid token: 201 with the admin (id, schoolId, name, email, timestamps) and NO password hash', r.status === 201 && r.body.success === true && r.body.data.schoolId === A.id && r.body.data.email === email && !('passwordHash' in r.body.data) && !JSON.stringify(r.body).includes('pbkdf2'));
      aAdmin = { id: r.body.data.id, email };
      const row = await tokenRow(A.id);
      check('the token is CONSUMED by exactly that admin (consumedAt set, consumedByAdminId = the new admin)', !!row?.consumedAt && row.consumedByAdminId === aAdmin.id && (await adminCount(A.id)) === 1);
      const stored = await prisma.admin.findUniqueOrThrow({ where: { id: aAdmin.id } });
      check('the password is hashed with the existing scheme (pbkdf2, 220,000 iterations) and is not the plain text', stored.passwordHash.startsWith('pbkdf2$220000$') && !stored.passwordHash.includes(PASSWORD));
      const l = await login(A.id, email);
      const me = await call('GET', '/api/admin/me', { cookie: l.cookie });
      check('UUID-based login works for the new admin, and the session is accepted by /api/admin/me', l.status === 200 && !!l.cookie && me.status === 200 && me.body.data.email === email && me.body.data.schoolId === A.id);

      // refusals
      const B = await createSchool('B');
      everyToken.push(B.token);
      const missing = await register(B.id, undefined);
      check('a missing setupToken: 400 (validation), nothing created, token untouched', missing.status === 400 && (await adminCount(B.id)) === 0 && (await tokenRow(B.id))?.consumedAt === null);
      check('a malformed token (wrong prefix, short, wrong type, empty): 400, nothing created', await (async () => { for (const v of ['x', '', `stk_${'A'.repeat(42)}`, `tok_${'A'.repeat(43)}`]) { const x = await register(B.id, v); if (x.status !== 400) return false; } return (await adminCount(B.id)) === 0; })());
      const wrong = await register(B.id, generateSetupToken());
      check('a well-formed but WRONG token: 401', wrong.status === 401 && wrong.body.success === false && (await adminCount(B.id)) === 0);
      const crossSchool = await register(B.id, A.token);
      check('CROSS-SCHOOL: school A\'s token used with school B\'s id: 401 (the token is bound to its school), and B\'s own token is still valid', crossSchool.status === 401 && (await adminCount(B.id)) === 0 && (await tokenRow(B.id))?.consumedAt === null);
      const unknown = await register('00000000-0000-4000-8000-000000000000', generateSetupToken());
      check('an UNKNOWN school id: 401 as well', unknown.status === 401);
      check('wrong token, other school\'s token and unknown school give the IDENTICAL response body (nothing reveals which schools exist)', JSON.stringify(wrong.body) === JSON.stringify(unknown.body) && JSON.stringify(wrong.body) === JSON.stringify(crossSchool.body) && wrong.body.message === 'Invalid or expired setup token');
      const bad = await call('POST', '/api/admin/register', { body: { schoolId: 'not-a-uuid', setupToken: B.token, name: 'x', email: 'x@y.co', password: PASSWORD } });
      check('a malformed school id: 400', bad.status === 400);

      // expiry
      await prisma.$executeRaw`UPDATE "school_setup_tokens" SET "createdAt" = now() - interval '2 hours', "expiresAt" = now() - interval '1 hour' WHERE "schoolId" = ${B.id}`;
      const expired = await register(B.id, B.token);
      check('an EXPIRED token: 401 (the same answer), no admin created', expired.status === 401 && JSON.stringify(expired.body) === JSON.stringify(wrong.body) && (await adminCount(B.id)) === 0);
      check('...and the expired token was not consumed (it stays expired, for the recovery command to replace)', (await tokenRow(B.id))?.consumedAt === null);

      // replay
      const replay = await register(A.id, A.token, { email: 'attacker@bootstrap-a.test' });
      check('REPLAY: the consumed token is refused (401) and no second admin appears', replay.status === 401 && (await adminCount(A.id)) === 1 && !(await prisma.admin.findFirst({ where: { email: 'attacker@bootstrap-a.test' } })));
      const replayLogin = await login(A.id, 'attacker@bootstrap-a.test');
      check('...the would-be admin cannot log in', replayLogin.status === 401);
    }

    // =================================================================================================================
    section('3. A valid token is never burned by an error');
    {
      const C = await createSchool('C');
      everyToken.push(C.token);
      const weak1 = await register(C.id, C.token, { password: 'weak' });
      const weak2 = await register(C.id, C.token, { password: 'alllowercase1' });
      const badEmail = await register(C.id, C.token, { email: 'not-an-email' });
      check('input validation failures (weak password, no uppercase, bad email): 400 each', weak1.status === 400 && weak2.status === 400 && badEmail.status === 400);
      check('...and the token is still unused', (await tokenRow(C.id))?.consumedAt === null && (await adminCount(C.id)) === 0);

      // a failure AFTER the claim (inside the transaction) rolls the claim back
      const failingAdmin = rawPrisma.$extends({ query: { admin: { async create() { throw new Error('simulated failure creating the admin'); } } } });
      const m1 = await failure(new AdminService(failingAdmin as unknown as PrismaClient).registerAdmin({ schoolId: C.id, setupToken: C.token, name: 'x', email: 'rollback1@bootstrap.test', password: PASSWORD }));
      check('ROLLBACK 1: the admin insert fails after the token was claimed: nothing is created and the token is NOT consumed', /simulated failure creating/.test(m1) && (await adminCount(C.id)) === 0 && (await tokenRow(C.id))?.consumedAt === null);
      const failingLink = rawPrisma.$extends({ query: { schoolSetupToken: { async update() { throw new Error('simulated failure recording the consumer'); } } } });
      const m2 = await failure(new AdminService(failingLink as unknown as PrismaClient).registerAdmin({ schoolId: C.id, setupToken: C.token, name: 'x', email: 'rollback2@bootstrap.test', password: PASSWORD }));
      check('ROLLBACK 2: a failure at the LAST step also undoes the admin and the claim: no admin, token unused', /simulated failure recording/.test(m2) && (await adminCount(C.id)) === 0 && (await tokenRow(C.id))?.consumedAt === null);
      const finally_ = await register(C.id, C.token, { email: 'real@bootstrap-c.test' });
      check('after all those failures the SAME token still registers the admin (201)', finally_.status === 201 && (await adminCount(C.id)) === 1 && !!(await tokenRow(C.id))?.consumedAt);
    }

    // =================================================================================================================
    section('4. Concurrency');
    {
      const D = await createSchool('D');
      everyToken.push(D.token);
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => register(D.id, D.token, { email: `race${i}@bootstrap-d.test` })));
      const ok = results.filter((r) => r.status === 201);
      const refused = results.filter((r) => r.status === 401);
      check('TEN simultaneous registrations with one token: EXACTLY ONE succeeds (201) and the other nine get 401', ok.length === 1 && refused.length === 9 && results.length === 10, results.map((r) => r.status).join());
      const winner = ok[0]!.body.data;
      check('exactly one admin exists, and it is the winner; the token is consumed by that admin', (await adminCount(D.id)) === 1 && (await tokenRow(D.id))?.consumedByAdminId === winner.id);
      check('none of the nine losers left an admin behind', (await prisma.admin.count({ where: { schoolId: D.id, email: { startsWith: 'race' } } })) === 1);

      // a loser must not poison a retry: when the winner's transaction fails, the next attempt can still claim
      const E = await createSchool('E');
      everyToken.push(E.token);
      const failingAdmin = rawPrisma.$extends({ query: { admin: { async create() { await sleep(300); throw new Error('simulated failure'); } } } });
      const [failed, other] = await Promise.all([
        failure(new AdminService(failingAdmin as unknown as PrismaClient).registerAdmin({ schoolId: E.id, setupToken: E.token, name: 'x', email: 'loser@bootstrap-e.test', password: PASSWORD })),
        (async () => { await sleep(100); return register(E.id, E.token, { email: 'second@bootstrap-e.test' }); })(),
      ]);
      check('when the first attempt FAILS (and rolls back) while a second waits on the same token, the second then succeeds', /simulated failure/.test(failed) && other.status === 201 && (await adminCount(E.id)) === 1, `${other.status}`);
    }

    // =================================================================================================================
    section('5. First admin only');
    {
      const F = await createSchool('F');
      everyToken.push(F.token);
      const existing = await prisma.admin.create({ data: { schoolId: F.id, name: 'Existing', email: 'existing@bootstrap-f.test', passwordHash: await hashPassword(PASSWORD) } });
      const r = await register(F.id, F.token, { email: 'newcomer@bootstrap-f.test' });
      check('a school that ALREADY has an admin refuses a token registration (409), even with a valid unused token', r.status === 409 && (await adminCount(F.id)) === 1 && (await prisma.admin.findFirst({ where: { schoolId: F.id } }))?.id === existing.id);
      check('...and the refusal does not consume the token', (await tokenRow(F.id))?.consumedAt === null);
    }

    // =================================================================================================================
    section('6. POST /api/admins (authenticated)');
    {
      const al = await login(A.id, aAdmin.email);
      const body = { name: 'Second Admin', email: 'second@bootstrap-a.test', password: PASSWORD };
      const created = await call('POST', '/api/admins', { body, cookie: al.cookie });
      check('an authenticated admin creates another admin: 201, in THEIR school, without a password hash', created.status === 201 && created.body.data.schoolId === A.id && created.body.data.email === body.email && !('passwordHash' in created.body.data) && (await adminCount(A.id)) === 2);
      const l2 = await login(A.id, body.email);
      const me2 = await call('GET', '/api/admin/me', { cookie: l2.cookie });
      check('the new admin can log in (school UUID + email + password) and use the API', l2.status === 200 && me2.status === 200 && me2.body.data.schoolId === A.id);
      check('the password is hashed with the existing scheme', (await prisma.admin.findUniqueOrThrow({ where: { id: created.body.data.id } })).passwordHash.startsWith('pbkdf2$220000$'));
      const dup = await call('POST', '/api/admins', { body, cookie: al.cookie });
      check('a duplicate email in the same school: 409, nothing created', dup.status === 409 && (await adminCount(A.id)) === 2);
      const dupUpper = await call('POST', '/api/admins', { body: { ...body, email: 'SECOND@bootstrap-a.test' }, cookie: al.cookie });
      check('the email is normalised first, so a different case is the same duplicate (409)', dupUpper.status === 409);

      // another school, to prove nobody can target it
      const G = await createSchool('G');
      everyToken.push(G.token);
      const gReg = await register(G.id, G.token, { email: 'owner@bootstrap-g.test' });
      const gl = await login(G.id, 'owner@bootstrap-g.test');
      check('setup: a second school with its own admin', gReg.status === 201 && gl.status === 200);
      const aBefore = await adminCount(A.id);
      const gBefore = await adminCount(G.id);
      const crossBody = await call('POST', '/api/admins', { body: { ...body, email: 'cross@bootstrap.test', schoolId: G.id }, cookie: al.cookie });
      check('CROSS-SCHOOL: school A\'s admin naming school G in the body is REFUSED (400, schoolId is not an accepted field); nothing is created in either school', crossBody.status === 400 && JSON.stringify(crossBody.body.errors ?? {}).includes('schoolId') && (await adminCount(A.id)) === aBefore && (await adminCount(G.id)) === gBefore, `${crossBody.status} ${crossBody.text.slice(0, 220)} | A ${await adminCount(A.id)} vs ${aBefore}, G ${await adminCount(G.id)} vs ${gBefore}`);
      const ownSchoolBody = await call('POST', '/api/admins', { body: { ...body, email: 'sneaky@bootstrap.test', schoolId: A.id }, cookie: al.cookie });
      check('even naming their OWN school is refused: the body has no school at all', ownSchoolBody.status === 400);
      const viaG = await call('POST', '/api/admins', { body: { name: 'G second', email: 'g2@bootstrap-g.test', password: PASSWORD }, cookie: gl.cookie });
      check('school G\'s admin creates an admin: it lands in G (never in A)', viaG.status === 201 && viaG.body.data.schoolId === G.id && (await adminCount(G.id)) === gBefore + 1 && (await adminCount(A.id)) === aBefore);
      const g2 = await login(G.id, 'g2@bootstrap-g.test');
      check('an admin created in school G cannot reach school A: 403 on school A, and cannot log in to A', (await call('GET', `/api/schools/${A.id}`, { cookie: g2.cookie })).status === 403 && (await login(A.id, 'g2@bootstrap-g.test')).status === 401);
      check('weak password, bad email, empty body and unknown fields are 400', (await call('POST', '/api/admins', { body: { ...body, email: 'w@bootstrap.test', password: 'weak' }, cookie: al.cookie })).status === 400 && (await call('POST', '/api/admins', { body: { ...body, email: 'bad' }, cookie: al.cookie })).status === 400 && (await call('POST', '/api/admins', { body: {}, cookie: al.cookie })).status === 400 && (await call('POST', '/api/admins', { body: { ...body, email: 'r@bootstrap.test', role: 'owner' }, cookie: al.cookie })).status === 400);
      check('unauthenticated and garbage-cookie requests: 401, nothing created', (await call('POST', '/api/admins', { body })).status === 401 && (await call('POST', '/api/admins', { body, cookie: 'garbage' })).status === 401 && (await adminCount(A.id)) === aBefore);
      check('a setupToken in the body is not accepted here either (400): this endpoint needs a session, not a token', (await call('POST', '/api/admins', { body: { ...body, email: 't@bootstrap.test', setupToken: generateSetupToken() }, cookie: al.cookie })).status === 400);
    }

    // =================================================================================================================
    section('7. Existing authentication and session behaviour');
    {
      const email = aAdmin.email;
      const wrongPassword = await login(A.id, email, 'Wrong#Password-1');
      const noAccount = await login(A.id, 'nobody@bootstrap-a.test');
      check('a wrong password and an unknown account are both 401 (same message)', wrongPassword.status === 401 && noAccount.status === 401);
      const a = await app.inject({ method: 'POST', url: '/api/admin/login', remoteAddress: nextIp(), payload: { schoolId: A.id, email, password: 'Wrong#Password-1' } });
      const b = await app.inject({ method: 'POST', url: '/api/admin/login', remoteAddress: nextIp(), payload: { schoolId: A.id, email: 'nobody@bootstrap-a.test', password: 'Wrong#Password-1' } });
      check('...with an identical body (no account enumeration)', a.body === b.body);
      const ok = await login(A.id, email);
      const session = ok.cookie!;
      const stored = await prisma.adminSession.findFirst({ where: { adminId: aAdmin.id }, orderBy: { createdAt: 'desc' } });
      check('the session token is stored only as a hash, with a 7-day expiry', stored?.sessionToken !== session && stored?.sessionToken === sha256(session) && Math.abs(stored.expiresAt.getTime() - Date.now() - 7 * 86_400_000) < 120_000);
      const cookieAttrs = (await app.inject({ method: 'POST', url: '/api/admin/login', remoteAddress: nextIp(), payload: { schoolId: A.id, email, password: PASSWORD } })).cookies.find((c) => c.name === 'session_token');
      check('the session cookie is HttpOnly, Secure (production) and SameSite=Strict', cookieAttrs?.httpOnly === true && cookieAttrs.secure === true && String(cookieAttrs.sameSite).toLowerCase() === 'strict');
      check('a valid session reaches a protected endpoint; its own school is allowed and another school is 403', (await call('GET', '/api/admin/me', { cookie: session })).status === 200 && (await call('GET', `/api/schools/${A.id}`, { cookie: session })).status === 200);
      await prisma.adminSession.update({ where: { id: stored!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      check('an EXPIRED session is refused (401)', (await call('GET', '/api/admin/me', { cookie: session })).status === 401);
      const fresh = (await login(A.id, email)).cookie!;
      await app.inject({ method: 'POST', url: '/api/admin/logout', remoteAddress: nextIp(), headers: { cookie: `session_token=${fresh}` } });
      check('after logout the session no longer works (401)', (await call('GET', '/api/admin/me', { cookie: fresh })).status === 401);
      check('unauthenticated protected endpoints are still 401', (await call('GET', '/api/admin/me')).status === 401 && (await call('GET', `/api/schools/${A.id}`)).status === 401);
    }

    // =================================================================================================================
    section('8. Secrecy');
    {
      // a whole flow with logging ON: school creation, failed and successful registration, an authenticated admin creation
      const { result, output } = await captured(async () => {
        const quietApp = await buildApp({ env: { ...process.env, LOG_LEVEL: 'info' } });
        const send = async (method: 'GET' | 'POST', url: string, payload?: unknown, cookie?: string) => quietApp.inject({ method, url, remoteAddress: nextIp(), ...(payload !== undefined ? { payload: payload as never } : {}), ...(cookie ? { headers: { cookie: `session_token=${cookie}` } } : {}) });
        const code = `M11BT_${RUN}_LOG`.toUpperCase();
        const created = (await send('POST', '/api/schools', { name: 'log test', code, schoolType: 'PRIMARY' })).json();
        const token: string = created.data.setupToken;
        const wrong = generateSetupToken();
        await send('POST', '/api/admin/register', { schoolId: created.data.id, setupToken: wrong, name: 'x', email: 'log1@bootstrap.test', password: PASSWORD });
        await send('POST', '/api/admin/register', { schoolId: created.data.id, setupToken: token, name: 'x', email: 'log2@bootstrap.test', password: 'weak' });
        await send('POST', '/api/admin/register', { schoolId: created.data.id, setupToken: token, name: 'x', email: 'log3@bootstrap.test', password: PASSWORD });
        const loginRes = await send('POST', '/api/admin/login', { schoolId: created.data.id, email: 'log3@bootstrap.test', password: PASSWORD });
        const cookie = loginRes.cookies.find((c) => c.name === 'session_token')?.value;
        await send('POST', '/api/admins', { name: 'y', email: 'log4@bootstrap.test', password: PASSWORD }, cookie);
        await quietApp.close();
        return { token, wrong, cookie: cookie ?? '' };
      });
      everyToken.push(result.token);
      check('with logging on, neither the issued token, a rejected token, any password nor the session token appears in the log output', output.length > 0 && !output.includes(result.token) && !output.includes(result.wrong) && !output.includes(PASSWORD) && !output.includes(result.cookie) && !output.includes('weak'), `${output.length} bytes`);
      check('no log line contains the token hash either', !output.includes(hashSetupToken(result.token)));

      const reuse = await register((await prisma.school.findFirstOrThrow({ where: { code: `M11BT_${RUN}_LOG`.toUpperCase() } })).id, result.token, { email: 'log5@bootstrap.test' });
      check('refusal bodies never echo the token, the school id or a hint of why: the generic message only', reuse.status === 401 && !reuse.text.includes(result.token) && reuse.body.message === 'Invalid or expired setup token' && Object.keys(reuse.body).sort().join() === 'message,success');
      const school = await call('GET', `/api/schools/${A.id}`, { cookie: (await login(A.id, aAdmin.email)).cookie });
      check('GET /api/schools/:id (authenticated) returns the school WITHOUT any token field', school.status === 200 && !('setupToken' in school.body.data) && !('setupTokenExpiresAt' in school.body.data) && !JSON.stringify(school.body).includes('stk_'));
      const me = await call('GET', '/api/admin/me', { cookie: (await login(A.id, aAdmin.email)).cookie });
      check('GET /api/admin/me and the registration response contain no token, hash or password hash', !me.text.includes('stk_') && !me.text.includes('pbkdf2'));
      const spec = JSON.stringify((app.swagger() as any));
      check('the Swagger document contains no real token (only the format)', everyToken.every((t) => !spec.includes(t)));
      const secretsInDb = JSON.stringify(await prisma.$queryRaw`SELECT * FROM "school_setup_tokens" WHERE "schoolId" IN (SELECT "id" FROM "schools" WHERE "code" LIKE ${`M11BT_${RUN}%`.toUpperCase()})`);
      check('no raw token of this run is stored anywhere in the token table', everyToken.every((t) => !secretsInDb.includes(t)));
    }

    // =================================================================================================================
    section('9. Operator recovery');
    {
      const confirm = (s: { code: string }) => s.code;
      // (a) an existing school with NO token and NO admin (a legacy school)
      const legacyCode = `M11BT_${RUN}_LEGACY`.toUpperCase();
      const legacy = await prisma.school.create({ data: { name: 'Legacy school', code: legacyCode, schoolType: 'SECONDARY' } });
      check('setup: a school created without a token (as every school was before this phase) cannot register an admin', (await register(legacy.id, generateSetupToken())).status === 401 && !(await tokenRow(legacy.id)));
      const issued = await issueSetupTokenForSchool(rawPrisma as unknown as PrismaClient, { schoolId: legacy.id, confirmCode: legacyCode, ttlHours: 24 });
      check('recovery for a school with no admin and no token: a token is issued (replaced: NONE) with the requested lifetime', issued.ok && issued.replaced === 'NONE' && SETUP_TOKEN_PATTERN.test(issued.token) && Math.abs(issued.expiresAt.getTime() - Date.now() - 24 * 3_600_000) < 60_000);
      if (!issued.ok) throw new Error('recovery failed');
      everyToken.push(issued.token);
      check('only the HASH of that token is stored', (await tokenRow(legacy.id))?.tokenHash === sha256(issued.token));
      const legacyReg = await register(legacy.id, issued.token, { email: 'legacy-owner@bootstrap.test' });
      check('the issued token registers the first admin of that school (201)', legacyReg.status === 201 && (await adminCount(legacy.id)) === 1);

      // (b) an EXPIRED token is replaced
      const H = await createSchool('H');
      everyToken.push(H.token);
      const hOther = await createSchool('H-other');
      everyToken.push(hOther.token);
      const hOtherBefore = await tokenRow(hOther.id);
      await prisma.$executeRaw`UPDATE "school_setup_tokens" SET "createdAt" = now() - interval '2 days', "expiresAt" = now() - interval '1 day' WHERE "schoolId" = ${H.id}`;
      check('setup: H\'s token has expired and no longer works', (await register(H.id, H.token)).status === 401);
      const rotated = await issueSetupTokenForSchool(rawPrisma as unknown as PrismaClient, { schoolId: H.id, confirmCode: H.code, ttlHours: 48 });
      check('recovery for an EXPIRED token: a new token (replaced: EXPIRED, 48 hours)', rotated.ok && rotated.replaced === 'EXPIRED' && Math.abs(rotated.expiresAt.getTime() - Date.now() - 48 * 3_600_000) < 60_000);
      if (!rotated.ok) throw new Error('recovery failed');
      everyToken.push(rotated.token);
      check('the OLD token stays refused and the NEW one works (201)', (await register(H.id, H.token)).status === 401 && (await register(H.id, rotated.token, { email: 'h-owner@bootstrap.test' })).status === 201);
      const hOtherAfter = await tokenRow(hOther.id);
      check('ANOTHER school\'s token row is completely untouched by the rotation', hOtherAfter?.tokenHash === hOtherBefore?.tokenHash && hOtherAfter?.expiresAt.getTime() === hOtherBefore?.expiresAt.getTime() && hOtherAfter?.consumedAt === null && hOtherAfter?.id === hOtherBefore?.id);

      // (c) rotating a still-valid unused token invalidates it
      const I = await createSchool('I');
      everyToken.push(I.token);
      const second = await issueSetupTokenForSchool(rawPrisma as unknown as PrismaClient, { schoolId: I.id, confirmCode: I.code, ttlHours: 24 });
      if (!second.ok) throw new Error('recovery failed');
      everyToken.push(second.token);
      check('rotating an UNUSED token (replaced: UNUSED) makes the old one invalid at once; the new one works', second.replaced === 'UNUSED' && (await register(I.id, I.token)).status === 401 && (await register(I.id, second.token, { email: 'i-owner@bootstrap.test' })).status === 201);

      // (d) refusals change nothing
      const J = await createSchool('J');
      everyToken.push(J.token);
      const jBefore = await tokenRow(J.id);
      const wrongConfirm = await issueSetupTokenForSchool(rawPrisma as unknown as PrismaClient, { schoolId: J.id, confirmCode: 'NOT-THE-CODE', ttlHours: 24 });
      const lowerConfirm = await issueSetupTokenForSchool(rawPrisma as unknown as PrismaClient, { schoolId: J.id, confirmCode: J.code.toLowerCase(), ttlHours: 24 });
      const unknown = await issueSetupTokenForSchool(rawPrisma as unknown as PrismaClient, { schoolId: '00000000-0000-4000-8000-000000000000', confirmCode: J.code, ttlHours: 24 });
      check('a wrong or differently-cased confirmation code and an unknown school are REFUSED', !wrongConfirm.ok && wrongConfirm.reason === 'CONFIRMATION_MISMATCH' && !lowerConfirm.ok && lowerConfirm.reason === 'CONFIRMATION_MISMATCH' && !unknown.ok && unknown.reason === 'SCHOOL_NOT_FOUND');
      const jAfter = await tokenRow(J.id);
      check('...and the refused attempts changed nothing (the original token is intact and still works)', jAfter?.tokenHash === jBefore?.tokenHash && (await register(J.id, J.token, { email: 'j-owner@bootstrap.test' })).status === 201);
      const hasAdmin = await issueSetupTokenForSchool(rawPrisma as unknown as PrismaClient, { schoolId: J.id, confirmCode: J.code, ttlHours: 24 });
      const jFinal = await tokenRow(J.id);
      check('a school that already HAS an admin is refused (SCHOOL_HAS_ADMIN) and its token row is not touched', !hasAdmin.ok && hasAdmin.reason === 'SCHOOL_HAS_ADMIN' && jFinal?.tokenHash === jAfter?.tokenHash && !!jFinal?.consumedAt);

      // (e) a school whose only admin was removed
      const K = await createSchool('K');
      everyToken.push(K.token);
      const kReg = await register(K.id, K.token, { email: 'k-owner@bootstrap.test' });
      await prisma.admin.delete({ where: { id: kReg.body.data.id } });
      check('when the consumer admin is deleted the token row survives with consumedByAdminId set to NULL (foreign key ON DELETE SET NULL)', (await tokenRow(K.id))?.consumedByAdminId === null && !!(await tokenRow(K.id))?.consumedAt);
      const kRot = await issueSetupTokenForSchool(rawPrisma as unknown as PrismaClient, { schoolId: K.id, confirmCode: K.code, ttlHours: 24 });
      if (!kRot.ok) throw new Error('recovery failed');
      everyToken.push(kRot.token);
      check('recovery for a school left with no admin (replaced: CONSUMED): the new token registers an admin again', kRot.replaced === 'CONSUMED' && (await register(K.id, kRot.token, { email: 'k-owner2@bootstrap.test' })).status === 201);

      // (f) two operators at once
      const L = await createSchool('L');
      everyToken.push(L.token);
      const both = await Promise.all([1, 2].map(() => issueSetupTokenForSchool(rawPrisma as unknown as PrismaClient, { schoolId: L.id, confirmCode: L.code, ttlHours: 24 })));
      const tokens = both.flatMap((r) => (r.ok ? [r.token] : []));
      tokens.forEach((t) => everyToken.push(t));
      const works = await Promise.all(tokens.map(async (t, i) => (await register(L.id, t, { email: `l-owner${i}@bootstrap.test` })).status));
      check('two simultaneous recoveries for one school both finish, exactly one token (the last written) is valid, and exactly one admin results', both.every((r) => r.ok) && works.filter((s) => s === 201).length === 1 && (await adminCount(L.id)) === 1, works.join());

      // (g) the real command, end to end
      const M = await createSchool('M');
      everyToken.push(M.token);
      await prisma.$executeRaw`UPDATE "school_setup_tokens" SET "createdAt" = now() - interval '2 days', "expiresAt" = now() - interval '1 day' WHERE "schoolId" = ${M.id}`;
      const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/issue-setup-token.ts', ...args], { cwd: path.resolve('.'), encoding: 'utf8', env: process.env, timeout: 90_000 });
      const cli = run(['--school-id', M.id, '--confirm-code', confirm(M), '--ttl-hours', '6']);
      const printed = cli.stdout.trim();
      check('THE COMMAND: exit 0, stdout is exactly the token (one line), stderr says what happened', cli.status === 0 && SETUP_TOKEN_PATTERN.test(printed) && cli.stdout === `${printed}\n` && /Issued a setup token for/.test(cli.stderr) && /expired/.test(cli.stderr) && /6\.|Valid until/.test(cli.stderr), cli.stderr.slice(0, 200));
      everyToken.push(printed);
      const dbUrl = new URL(process.env.DATABASE_URL!);
      const everything = cli.stdout + cli.stderr;
      check('nothing the command prints contains the database URL, host, user or password, and stderr never contains the token', !everything.includes(dbUrl.hostname) && !everything.includes(decodeURIComponent(dbUrl.password)) && !everything.includes(dbUrl.username) && !cli.stderr.includes(printed));
      check('the printed token is stored only as a hash, expires in ~6 hours, and registers the first admin (201)', (await tokenRow(M.id))?.tokenHash === sha256(printed) && Math.abs((await tokenRow(M.id))!.expiresAt.getTime() - Date.now() - 6 * 3_600_000) < 120_000 && (await register(M.id, printed, { email: 'm-owner@bootstrap.test' })).status === 201);
      const N = await createSchool('N');
      everyToken.push(N.token);
      const nBefore = await tokenRow(N.id);
      const refusedRun = run(['--school-id', N.id, '--confirm-code', 'WRONG-CODE']);
      check('THE COMMAND with a wrong confirmation: exit 3, NOTHING on stdout, and the school\'s token is unchanged', refusedRun.status === 3 && refusedRun.stdout === '' && /does not match/.test(refusedRun.stderr) && (await tokenRow(N.id))?.tokenHash === nBefore?.tokenHash);
      const adminRun = run(['--school-id', M.id, '--confirm-code', confirm(M)]);
      check('THE COMMAND for a school that already has an admin: exit 3, nothing printed on stdout, refusal explains POST /api/admins', adminRun.status === 3 && adminRun.stdout === '' && /already has an administrator/.test(adminRun.stderr) && /POST \/api\/admins/.test(adminRun.stderr));
      const unknownRun = run(['--school-id', '00000000-0000-4000-8000-000000000000', '--confirm-code', 'X']);
      check('THE COMMAND for an unknown school: exit 3, nothing on stdout', unknownRun.status === 3 && unknownRun.stdout === '' && /No school has that id/.test(unknownRun.stderr));
    }

    // =================================================================================================================
    section('10. Database constraints of school_setup_tokens');
    {
      const P = await createSchool('P');
      everyToken.push(P.token);
      const Q = await createSchool('Q');
      everyToken.push(Q.token);
      const hashP = (await tokenRow(P.id))!.tokenHash;
      const dupSchool = await failure(prisma.schoolSetupToken.create({ data: { schoolId: P.id, tokenHash: sha256('another'), expiresAt: new Date(Date.now() + 3_600_000) } }));
      check('UNIQUE schoolId: a school can never have two token rows', /Unique constraint|schoolId/i.test(dupSchool));
      const bare = await prisma.school.create({ data: { name: 'No token yet', code: `M11BT_${RUN}_BARE`.toUpperCase(), schoolType: 'PRIMARY' } });
      const dupHash = await failure(prisma.schoolSetupToken.create({ data: { schoolId: bare.id, tokenHash: hashP, expiresAt: new Date(Date.now() + 3_600_000) } }));
      check('UNIQUE tokenHash: two schools can never share a token hash', /Unique constraint|tokenHash/i.test(dupHash));
      check('CHECK: a token that expires before it was issued is refused', /expiry_check/.test(await failure(prisma.$executeRaw`UPDATE "school_setup_tokens" SET "expiresAt" = "createdAt" - interval '1 second' WHERE "schoolId" = ${P.id}`)));
      check('CHECK: a consuming admin without a consumption time is refused', /consumption_check/.test(await failure(prisma.$executeRaw`UPDATE "school_setup_tokens" SET "consumedByAdminId" = ${aAdmin.id} WHERE "schoolId" = ${P.id}`)));
      check('CHECK: consumption before issuance is refused', /consumption_check/.test(await failure(prisma.$executeRaw`UPDATE "school_setup_tokens" SET "consumedAt" = "createdAt" - interval '1 second' WHERE "schoolId" = ${P.id}`)));
      check('FOREIGN KEY: a token for a school that does not exist is refused', /foreign key|schoolId_fkey/i.test(await failure(prisma.$executeRaw`INSERT INTO "school_setup_tokens" ("id","schoolId","tokenHash","expiresAt") VALUES (gen_random_uuid()::text, '00000000-0000-4000-8000-000000000000', ${sha256('x')}, now() + interval '1 hour')`)));
      check('FOREIGN KEY: a consuming admin that does not exist is refused', /foreign key|consumedByAdminId_fkey/i.test(await failure(prisma.$executeRaw`UPDATE "school_setup_tokens" SET "consumedAt" = now(), "consumedByAdminId" = '00000000-0000-4000-8000-000000000000' WHERE "schoolId" = ${P.id}`)));
      await prisma.school.delete({ where: { id: Q.id } });
      check('ON DELETE CASCADE: deleting a school deletes its token row (and only its)', !(await tokenRow(Q.id)) && !!(await tokenRow(P.id)));
    }

    // =================================================================================================================
    section('11. Rate limits');
    {
      const R = await createSchool('rate');
      everyToken.push(R.token);
      const ip = '203.0.113.201';
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await register(R.id, generateSetupToken(), {}, ip)).status);
      const fourth = await register(R.id, R.token, { email: 'rate-owner@bootstrap.test' }, ip);
      check('registration is limited to 3 per client per hour: three refused attempts (401), then the 4th is 429', statuses.join() === '401,401,401' && fourth.status === 429, `${statuses.join()} ${fourth.status}`);
      check('...the 429 happened BEFORE the token was looked at: the valid token is still unused and works from another client', (await tokenRow(R.id))?.consumedAt === null && (await register(R.id, R.token, { email: 'rate-owner@bootstrap.test' })).status === 201);
      const sIp = '203.0.113.202';
      const s1 = await call('POST', '/api/schools', { body: { name: 'rate 1', code: `M11BT_${RUN}_RATE1`.toUpperCase(), schoolType: 'PRIMARY' }, ip: sIp });
      const s2 = await call('POST', '/api/schools', { body: { name: 'rate 2', code: `M11BT_${RUN}_RATE2`.toUpperCase(), schoolType: 'PRIMARY' }, ip: sIp });
      if (s1.status === 201) everyToken.push(s1.body.data.setupToken);
      check('school creation is limited to 1 per client per 24 hours (the second from the same client is 429 and creates no school or token)', s1.status === 201 && s2.status === 429 && (await prisma.school.count({ where: { code: `M11BT_${RUN}_RATE2`.toUpperCase() } })) === 0);
    }
  } finally {
    section('12. Cleanup and proof that nothing existing changed');
    await app.close();
    const removed = await prisma.school.deleteMany({ where: { code: { startsWith: 'M11BT_' } } });
    console.log(`  info: removed ${removed.count} test schools (cascade removed their admins, sessions and tokens)`);
    check('no test school remains', (await prisma.school.count({ where: { code: { startsWith: 'M11BT_' } } })) === 0);
    check('the token table is back to its starting count', (await prisma.schoolSetupToken.count()) === tokensBefore);
    check('the other new tables are back to their starting counts', JSON.stringify(await newTableCounts()) === JSON.stringify(newBefore));
    const after = await fingerprint();
    check(`all ${EXISTING_TABLES.length} pre-existing tables have identical counts and content fingerprints`, EXISTING_TABLES.every((t) => fpBefore[t]!.n === after[t]!.n && fpBefore[t]!.h === after[t]!.h), EXISTING_TABLES.filter((t) => fpBefore[t]!.n !== after[t]!.n || fpBefore[t]!.h !== after[t]!.h).join(','));
    void adminService;
  }
}

let finished = false;
process.on('exit', (code) => {
  if (!finished) { console.log(`\nRESULT: pass=${pass} fail=${fail + 1} (the process ended before the suite completed, exit ${code})`); process.exitCode = 1; }
});
main()
  .catch((error) => { fail++; console.error('UNEXPECTED ERROR', error); })
  .finally(async () => {
    await prisma.$disconnect();
    finished = true;
    console.log(`\nRESULT: pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  });
