import 'dotenv/config';
import { resolveSetupTokenTtlHours } from '../config/security.js';

// ---------------------------------------------------------------------------
// OPERATOR COMMAND: issue or rotate the setup token of one school.
//
//   npm run setup-token -- --school-id <school uuid> --confirm-code <school code> [--ttl-hours <1-168>]
//   (production build:   node dist/cli/issue-setup-token.js --school-id ... --confirm-code ...)
//
// Use it when (a) a school's token expired before its first admin registered, or (b) an existing school has no admin.
// A school that already has an admin is refused: that admin adds others with POST /api/admins.
//
// OUTPUT: the raw token is the ONLY thing written to stdout (one line), so it can be sent straight to the intended place:
//     npm run setup-token -- ... 2>/dev/null | pbcopy          # or: > /secure/path/token.txt with a restrictive umask
// Everything else (school name, expiry, next steps, errors) goes to stderr. The token is stored only as a SHA-256 hash, never printed twice,
// and not recoverable: run the command again to rotate it. Nothing printed ever contains the database URL or other credentials, and database
// error text is not echoed (it can name the server).
//
// Exit codes: 0 issued, 2 usage error, 3 refused (unknown school, wrong confirmation code, school already has an admin), 1 unexpected failure.
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USAGE = 'Usage: npm run setup-token -- --school-id <school uuid> --confirm-code <school code> [--ttl-hours <1-168>]';

function parseArgs(argv: string[]): { schoolId: string; confirmCode: string; ttlHours?: string } | string {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !['--school-id', '--confirm-code', '--ttl-hours'].includes(flag)) return `Unknown or misplaced argument${flag ? ` "${flag.slice(0, 40)}"` : ''}`;
    if (value === undefined || value.startsWith('--')) return `${flag} needs a value`;
    if (values.has(flag)) return `${flag} was given twice`;
    values.set(flag, value);
  }
  const schoolId = values.get('--school-id');
  const confirmCode = values.get('--confirm-code');
  if (!schoolId) return '--school-id is required';
  if (!UUID.test(schoolId)) return '--school-id must be a school UUID';
  if (!confirmCode) return '--confirm-code is required (type the school code to confirm which school this is)';
  const ttlHours = values.get('--ttl-hours');
  return { schoolId, confirmCode, ...(ttlHours !== undefined ? { ttlHours } : {}) };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args === 'string') {
    console.error(`${args}\n${USAGE}`);
    return 2;
  }

  let ttlHours: number;
  try {
    ttlHours = resolveSetupTokenTtlHours({ SETUP_TOKEN_TTL_HOURS: args.ttlHours ?? process.env.SETUP_TOKEN_TTL_HOURS });
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }

  // imported only now: a usage error must not need a database
  const { default: prisma } = await import('../config/database.js');
  const { issueSetupTokenForSchool } = await import('../modules/school/setup-token-recovery.js');
  try {
    const result = await issueSetupTokenForSchool(prisma, { schoolId: args.schoolId, confirmCode: args.confirmCode, ttlHours });
    if (!result.ok) {
      const why = {
        SCHOOL_NOT_FOUND: 'No school has that id.',
        CONFIRMATION_MISMATCH: 'The confirmation code does not match that school. Nothing was changed.',
        SCHOOL_HAS_ADMIN: 'That school already has an administrator, so a setup token is not needed (and would not be accepted). An existing admin adds others with POST /api/admins. Nothing was changed.',
      }[result.reason];
      console.error(`Refused: ${why}`);
      return 3;
    }
    console.error(
      `Issued a setup token for "${result.schoolName}" (${result.schoolCode}). Previous token: ${result.replaced === 'NONE' ? 'none' : result.replaced.toLowerCase()}${result.replaced === 'UNUSED' ? ' (now invalid)' : ''}.\n` +
        `Valid until ${result.expiresAt.toISOString()}. It is single-use and works only for this school.\n` +
        'The token is printed on stdout below, once. It is not stored in readable form and cannot be shown again.\n' +
        `The first admin registers with POST /api/admin/register using schoolId and this token.`
    );
    process.stdout.write(`${result.token}\n`);
    return 0;
  } catch (error) {
    // never echo database error text: it can contain the server address
    const e = error as { name?: string; code?: string };
    console.error(`Unexpected failure (${e.name ?? 'Error'}${e.code ? `, ${e.code}` : ''}). No token was issued. Check the database connection and try again.`);
    return 1;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

main().then((code) => process.exit(code), () => process.exit(1));
