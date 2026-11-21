import { type PrismaClient } from '@prisma/client';
import { rotateSetupToken } from './setup-token.js';

// ---------------------------------------------------------------------------
// Operator recovery: issue (or rotate) the setup token of ONE school. This is used by the operator-run command only (src/cli/issue-setup-token.ts);
// there is deliberately no HTTP route for it.
//
// It refuses unless ALL of these hold:
//   * the school exists (identified by its UUID),
//   * the operator confirms it by typing the school's code (so a wrong UUID cannot silently rotate another school's token),
//   * the school has NO admin yet (a token only ever authorizes the first admin; a school that has admins adds more with POST /api/admins).
// Only that school's token row is written. Other schools, admins and sessions are never touched.
// ---------------------------------------------------------------------------

export type RecoveryResult =
  | { ok: true; token: string; expiresAt: Date; schoolName: string; schoolCode: string; replaced: 'NONE' | 'EXPIRED' | 'UNUSED' | 'CONSUMED' }
  | { ok: false; reason: 'SCHOOL_NOT_FOUND' | 'CONFIRMATION_MISMATCH' | 'SCHOOL_HAS_ADMIN' };

export async function issueSetupTokenForSchool(db: PrismaClient, input: { schoolId: string; confirmCode: string; ttlHours: number }): Promise<RecoveryResult> {
  return db.$transaction(async (tx) => {
    // serialises two operators running the command for the same school at once
    const schools = await tx.$queryRaw<Array<{ id: string; name: string; code: string }>>`SELECT "id", "name", "code" FROM "schools" WHERE "id" = ${input.schoolId} FOR UPDATE`;
    const school = schools[0];
    if (!school) return { ok: false as const, reason: 'SCHOOL_NOT_FOUND' as const };
    if (school.code !== input.confirmCode) return { ok: false as const, reason: 'CONFIRMATION_MISMATCH' as const };
    if ((await tx.admin.count({ where: { schoolId: school.id } })) > 0) return { ok: false as const, reason: 'SCHOOL_HAS_ADMIN' as const };

    const previous = await tx.schoolSetupToken.findUnique({ where: { schoolId: school.id }, select: { expiresAt: true, consumedAt: true } });
    const replaced = previous === null ? 'NONE' : previous.consumedAt !== null ? 'CONSUMED' : previous.expiresAt.getTime() <= Date.now() ? 'EXPIRED' : 'UNUSED';
    const issued = await rotateSetupToken(tx, school.id, input.ttlHours);
    return { ok: true as const, token: issued.token, expiresAt: issued.expiresAt, schoolName: school.name, schoolCode: school.code, replaced };
  });
}
