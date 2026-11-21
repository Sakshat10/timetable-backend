import { type PrismaClient, type School } from '@prisma/client';
import prisma from '../../config/database.js';
import { resolveSetupTokenTtlHours } from '../../config/security.js';
import { type CreateSchoolInput } from './school.schema.js';
import { AppError } from '../../utils/errors.js';
import { createSetupToken } from './setup-token.js';

/** The school plus the credential for its first admin. `setupToken` exists only in the response that creates the school. */
export interface CreatedSchool extends School {
  setupToken: string;
  setupTokenExpiresAt: Date;
}

export class SchoolService {
  constructor(private readonly db: PrismaClient = prisma, private readonly env: Record<string, string | undefined> = process.env) {}

  /**
   * Create a school AND its setup token in ONE transaction: a school never exists without the credential for its first admin, and a failed
   * token insert leaves no school behind. The raw token is returned here and nowhere else; only its hash is stored.
   */
  async createSchool(data: CreateSchoolInput): Promise<CreatedSchool> {
    const ttlHours = resolveSetupTokenTtlHours(this.env);

    // Check if school code already exists
    const existingSchool = await this.db.school.findUnique({
      where: { code: data.code },
    });

    if (existingSchool) {
      throw new AppError(409, 'School code already exists');
    }

    return this.db.$transaction(async (tx) => {
      const school = await tx.school.create({
        data: {
          name: data.name,
          code: data.code,
          schoolType: data.schoolType,
        },
      });
      const issued = await createSetupToken(tx, school.id, ttlHours);
      return { ...school, setupToken: issued.token, setupTokenExpiresAt: issued.expiresAt };
    });
  }

  async getSchoolById(id: string, requestingAdminSchoolId?: string): Promise<School> {
    const school = await this.db.school.findUnique({
      where: { id },
    });

    if (!school) {
      throw new AppError(404, 'School not found');
    }

    // Authorization: Check if admin belongs to this school
    if (requestingAdminSchoolId && school.id !== requestingAdminSchoolId) {
      throw new AppError(403, 'You do not have access to this school');
    }

    return school;
  }
}

export const schoolService = new SchoolService();
