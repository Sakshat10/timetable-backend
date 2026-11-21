// Setup tokens (Phase 2 security): pure tests, no database. The token itself, its hash, the TTL setting, the registration schemas, and the
// operator command's argument handling (usage errors exit before the command ever opens a database connection).
//
// Run with   NODE_ENV=production npx tsx test-setup-token-core.ts
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_SETUP_TOKEN_TTL_HOURS, MAX_SETUP_TOKEN_TTL_HOURS, resolveSetupTokenTtlHours } from './src/config/security.js';
import { createAdminSchema, registerAdminSchema } from './src/modules/admin/admin.schema.js';
import { generateSetupToken, hashSetupToken, SETUP_TOKEN_PATTERN, SETUP_TOKEN_PREFIX } from './src/modules/school/setup-token.js';

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const section = (title: string): void => console.log(`\n── ${title} ──`);
const throwsWith = (fn: () => unknown, re: RegExp): boolean => { try { fn(); return false; } catch (e) { return re.test((e as Error).message); } };

const SCHOOL = '11111111-1111-4111-8111-111111111111';
const VALID_TOKEN = `stk_${'A'.repeat(43)}`;

section('A. The token');
{
  const t = generateSetupToken();
  check('format: the stk_ prefix and 43 base64url characters (256 random bits)', t.startsWith(SETUP_TOKEN_PREFIX) && SETUP_TOKEN_PATTERN.test(t) && t.length === 47, t.length.toString());
  const many = new Set(Array.from({ length: 5000 }, () => generateSetupToken()));
  check('5,000 tokens are all different (no collisions, no pattern)', many.size === 5000);
  check('characters are spread over the whole alphabet (not a weak generator): at least 50 distinct characters over 200 tokens', new Set(Array.from({ length: 200 }, () => generateSetupToken().slice(4)).join('')).size >= 50);
  check('the pattern rejects wrong prefixes, lengths, characters and padding', ['', 'stk_', `stk_${'A'.repeat(42)}`, `stk_${'A'.repeat(44)}`, `tok_${'A'.repeat(43)}`, `stk_${'A'.repeat(42)}+`, `stk_${'A'.repeat(42)}=`, ` ${VALID_TOKEN}`, `${VALID_TOKEN}\n`, `stk_${'A'.repeat(42)} `].every((v) => !SETUP_TOKEN_PATTERN.test(v)));
  check('the pattern accepts a well-formed token', SETUP_TOKEN_PATTERN.test(VALID_TOKEN));
}

section('B. The hash');
{
  const t = generateSetupToken();
  check('SHA-256 in hex (64 characters), identical for the same token, different for different tokens', hashSetupToken(t) === createHash('sha256').update(t, 'utf8').digest('hex') && hashSetupToken(t).length === 64 && hashSetupToken(t) === hashSetupToken(t) && hashSetupToken(t) !== hashSetupToken(generateSetupToken()));
  check('the hash does not contain the token or any part of it', !hashSetupToken(t).includes(t.slice(4, 12)) && !hashSetupToken(t).includes('stk_'));
  check('one changed character gives a completely different hash', hashSetupToken(`stk_${'A'.repeat(43)}`) !== hashSetupToken(`stk_${'A'.repeat(42)}B`));
}

section('C. SETUP_TOKEN_TTL_HOURS');
{
  const ttl = (v: string | undefined) => resolveSetupTokenTtlHours(v === undefined ? {} : { SETUP_TOKEN_TTL_HOURS: v });
  check('unset or blank: the agreed 24 hours', ttl(undefined) === 24 && ttl('') === 24 && ttl('  ') === 24 && DEFAULT_SETUP_TOKEN_TTL_HOURS === 24);
  check('whole hours from 1 to 168 are accepted', ttl('1') === 1 && ttl('48') === 48 && ttl(' 168 ') === 168 && MAX_SETUP_TOKEN_TTL_HOURS === 168);
  check('0, above 168, negative, decimal, text, exponent and unit forms are refused (never a silent default)', ['0', '169', '100000', '-5', '2.5', 'abc', '1e2', '24h', '0x18'].every((v) => throwsWith(() => ttl(v), /SETUP_TOKEN_TTL_HOURS/)));
}

section('D. The request schemas');
{
  const body = { schoolId: SCHOOL, setupToken: VALID_TOKEN, name: ' Admin ', email: 'Admin@Example.COM', password: 'StrongPass123' };
  const ok = registerAdminSchema.safeParse(body);
  check('registration needs the school UUID, a well-formed setup token, name, email and a strong password; name is trimmed and email lower-cased', ok.success && ok.data.name === 'Admin' && ok.data.email === 'admin@example.com');
  check('registration WITHOUT a setupToken is refused (no way to register with the school UUID alone any more)', !registerAdminSchema.safeParse({ ...body, setupToken: undefined }).success && !registerAdminSchema.safeParse({ schoolId: SCHOOL, name: 'A', email: 'a@b.co', password: 'StrongPass123' }).success);
  check('a malformed token, a token of the wrong type, and an empty token are refused', ['x', '', `stk_${'A'.repeat(42)}`, 12345, null].every((v) => !registerAdminSchema.safeParse({ ...body, setupToken: v }).success));
  check('the existing field rules still apply (UUID, email, password strength)', !registerAdminSchema.safeParse({ ...body, schoolId: 'nope' }).success && !registerAdminSchema.safeParse({ ...body, email: 'x' }).success && !registerAdminSchema.safeParse({ ...body, password: 'weak' }).success && !registerAdminSchema.safeParse({ ...body, password: 'alllowercase1' }).success);
  const create = createAdminSchema.safeParse({ name: ' Second ', email: 'Second@Example.com', password: 'StrongPass123' });
  check('createAdmin takes only name, email, password (normalised)', create.success && create.data.name === 'Second' && create.data.email === 'second@example.com');
  check('createAdmin REFUSES a schoolId, a setupToken and any other unknown field (the school comes from the session)', ['schoolId', 'setupToken', 'role', 'isAdmin', 'id'].every((k) => !createAdminSchema.safeParse({ name: 'S', email: 's@b.co', password: 'StrongPass123', [k]: SCHOOL }).success));
  check('createAdmin keeps the password rules', !createAdminSchema.safeParse({ name: 'S', email: 's@b.co', password: 'weak' }).success && !createAdminSchema.safeParse({ name: 'S', email: 's@b.co', password: 'NoDigitsHere' }).success);
}

section('E. The operator command: usage errors (no database is opened)');
{
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/issue-setup-token.ts', ...args], { cwd: path.resolve('.'), encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgresql://nobody:nothing@127.0.0.1:1/none' }, timeout: 60_000 });
  const none = run([]);
  check('no arguments: exit 2, usage on stderr, NOTHING on stdout', none.status === 2 && /--school-id is required/.test(none.stderr) && /Usage:/.test(none.stderr) && none.stdout === '');
  const noConfirm = run(['--school-id', SCHOOL]);
  check('school id without the confirmation code: exit 2 (explicit confirmation is required)', noConfirm.status === 2 && /--confirm-code is required/.test(noConfirm.stderr) && noConfirm.stdout === '');
  check('a school id that is not a UUID: exit 2', run(['--school-id', 'not-a-uuid', '--confirm-code', 'X']).status === 2);
  check('an unknown flag, a missing value and a repeated flag: exit 2', run(['--school-id', SCHOOL, '--confirm-code', 'X', '--force', 'yes']).status === 2 && run(['--school-id', SCHOOL, '--confirm-code']).status === 2 && run(['--school-id', SCHOOL, '--school-id', SCHOOL, '--confirm-code', 'X']).status === 2);
  check('an invalid --ttl-hours: exit 2 (0, 169, text)', ['0', '169', 'abc'].every((v) => run(['--school-id', SCHOOL, '--confirm-code', 'X', '--ttl-hours', v]).status === 2));
  const unreachable = run(['--school-id', SCHOOL, '--confirm-code', 'X']);
  check('with an unreachable database: exit 1, a generic message, no token on stdout, and the connection details are NOT echoed', unreachable.status === 1 && unreachable.stdout === '' && /No token was issued/.test(unreachable.stderr) && !/127\.0\.0\.1|nobody|nothing|postgresql:/.test(unreachable.stderr + unreachable.stdout), unreachable.stderr.slice(0, 200));
}

console.log(`\nRESULT: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
