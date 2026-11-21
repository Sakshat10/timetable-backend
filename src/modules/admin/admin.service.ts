import { type Admin, type PrismaClient } from '@prisma/client';
import prisma from '../../config/database.js';
import { type RegisterAdminInput, type LoginAdminInput, type CreateAdminInput } from './admin.schema.js';
import { hashSetupToken } from '../school/setup-token.js';
import { AppError } from '../../utils/errors.js';
import { hashPassword, verifyPassword } from '../../utils/password.js';
import { generateSessionToken, hashSessionToken } from '../../utils/crypto.js';

const SESSION_DURATION_DAYS = 7;
const SESSION_COOKIE_NAME = 'session_token';

/** The same answer for every reason a setup token is refused (unknown school, wrong token, expired, already used): nothing is revealed about which. */
const invalidSetupToken = (): AppError => new AppError(401, 'Invalid or expired setup token');

export class AdminService {
  constructor(private readonly db: PrismaClient = prisma) {}

  /**
   * First-admin bootstrap. The caller proves the right to create the school's FIRST admin with the one-time setup token.
   *
   * Everything that can fail on its own (input validation, password hashing) happens BEFORE the token is touched. Then, in ONE transaction:
   *   1. CLAIM the token with a single atomic UPDATE bound to this school (consumedAt IS NULL AND expiresAt > now()). Concurrent attempts with the
   *      same token queue on that row: exactly one wins, the others find it consumed and get 401. Nothing else decides, so there is no
   *      check-then-act window.
   *   2. The school must have no admin yet (a token only ever authorizes the first one).
   *   3. Create the admin and record who consumed the token.
   * Any failure rolls the whole transaction back, INCLUDING the claim, so a valid token is never burned by an error of ours.
   */
  async registerAdmin(data: RegisterAdminInput): Promise<Omit<Admin, 'passwordHash'>> {
    const passwordHash = await hashPassword(data.password);
    const tokenHash = hashSetupToken(data.setupToken);

    return this.db.$transaction(
      async (tx) => {
        const claimed = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "school_setup_tokens" SET "consumedAt" = now()
          WHERE "schoolId" = ${data.schoolId} AND "tokenHash" = ${tokenHash} AND "consumedAt" IS NULL AND "expiresAt" > now()
          RETURNING "id"`;
        if (claimed.length !== 1) throw invalidSetupToken();

        if ((await tx.admin.count({ where: { schoolId: data.schoolId } })) > 0) {
          throw new AppError(409, 'This school already has an administrator. Ask an existing administrator to add you');
        }

        const admin = await tx.admin.create({
          data: { schoolId: data.schoolId, name: data.name, email: data.email, passwordHash },
        });
        await tx.schoolSetupToken.update({ where: { id: claimed[0]!.id }, data: { consumedByAdminId: admin.id } });

        const { passwordHash: _, ...adminWithoutPassword } = admin;
        return adminWithoutPassword;
      },
      { maxWait: 10_000, timeout: 20_000 }
    );
  }

  /**
   * An authenticated admin adds another admin to THEIR OWN school. The school is the session's (the caller passes it from request.admin);
   * there is no way to name another one. Same validation and password hashing as registration.
   */
  async createAdminForSchool(schoolId: string, data: CreateAdminInput): Promise<Omit<Admin, 'passwordHash'>> {
    const existing = await this.db.admin.findUnique({ where: { schoolId_email: { schoolId, email: data.email } } });
    if (existing) throw new AppError(409, 'An admin with this email already exists for this school');

    const passwordHash = await hashPassword(data.password);
    const admin = await this.db.admin.create({ data: { schoolId, name: data.name, email: data.email, passwordHash } });

    const { passwordHash: _, ...adminWithoutPassword } = admin;
    return adminWithoutPassword;
  }

  /**
   * Login admin and create session
   */
  async loginAdmin(data: LoginAdminInput): Promise<{ admin: Omit<Admin, 'passwordHash'>; sessionToken: string }> {
    // Find admin by schoolId + email
    const admin = await this.db.admin.findUnique({
      where: {
        schoolId_email: {
          schoolId: data.schoolId,
          email: data.email,
        },
      },
      include: {
        school: true,
      },
    });

    // Generic error message for security
    if (!admin) {
      throw new AppError(401, 'Invalid email or password');
    }

    // Verify password
    const isValidPassword = await verifyPassword(data.password, admin.passwordHash);

    if (!isValidPassword) {
      throw new AppError(401, 'Invalid email or password');
    }

    // Generate session token
    const sessionToken = generateSessionToken();
    const hashedToken = hashSessionToken(sessionToken);

    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + SESSION_DURATION_DAYS);

    // Create session
    await this.db.adminSession.create({
      data: {
        adminId: admin.id,
        sessionToken: hashedToken,
        expiresAt,
      },
    });

    // Return admin without passwordHash and the session token
    const { passwordHash: _, ...adminWithoutPassword } = admin;
    return {
      admin: adminWithoutPassword,
      sessionToken,
    };
  }

  /**
   * Validate session and return admin
   */
  async validateSession(sessionToken: string): Promise<Omit<Admin, 'passwordHash'> | null> {
    const hashedToken = hashSessionToken(sessionToken);

    const session = await this.db.adminSession.findUnique({
      where: { sessionToken: hashedToken },
      include: {
        admin: {
          include: {
            school: true,
          },
        },
      },
    });

    if (!session) {
      return null;
    }

    // Check if session is expired
    if (session.expiresAt < new Date()) {
      // Delete expired session
      await this.db.adminSession.delete({
        where: { id: session.id },
      });
      return null;
    }

    // Update last used timestamp
    await this.db.adminSession.update({
      where: { id: session.id },
      data: { lastUsedAt: new Date() },
    });

    // Return admin without passwordHash
    const { passwordHash: _, ...adminWithoutPassword } = session.admin;
    return adminWithoutPassword;
  }

  /**
   * Logout admin by deleting session
   */
  async logoutAdmin(sessionToken: string): Promise<void> {
    const hashedToken = hashSessionToken(sessionToken);

    await this.db.adminSession.deleteMany({
      where: { sessionToken: hashedToken },
    });
  }

  /**
   * Get session cookie name
   */
  getSessionCookieName(): string {
    return SESSION_COOKIE_NAME;
  }

  /**
   * Get session duration in milliseconds
   */
  getSessionDuration(): number {
    return SESSION_DURATION_DAYS * 24 * 60 * 60 * 1000;
  }
}

export const adminService = new AdminService();
