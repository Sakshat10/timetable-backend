import { type Grade } from '@prisma/client';
import prisma from '../../config/database.js';
import { type CreateGradeInput, type UpdateGradeInput } from './grade.schema.js';
import { AppError } from '../../utils/errors.js';

export class GradeService {
  /**
   * Create a new grade for an academic year
   * @param schoolId - School ID from authenticated admin
   * @param data - Grade data
   */
  async createGrade(schoolId: string, data: CreateGradeInput): Promise<Grade> {
    // Verify academic year exists and belongs to the admin's school
    const academicYear = await prisma.academicYear.findUnique({
      where: { id: data.academicYearId },
    });

    if (!academicYear) {
      throw new AppError(404, 'Academic year not found');
    }

    // Authorization: Check if academic year belongs to admin's school
    if (academicYear.schoolId !== schoolId) {
      throw new AppError(403, 'You do not have access to this academic year');
    }

    // Check academic year status - only allow modifications in DRAFT
    if (academicYear.status !== 'DRAFT') {
      throw new AppError(
        400,
        'Grades can only be modified while the academic year is in DRAFT status'
      );
    }

    // Check for duplicate name within the same academic year
    const existingGradeByName = await prisma.grade.findUnique({
      where: {
        academicYearId_name: {
          academicYearId: data.academicYearId,
          name: data.name,
        },
      },
    });

    if (existingGradeByName) {
      throw new AppError(409, `Grade "${data.name}" already exists in this academic year`);
    }

    // Check for duplicate display order within the same academic year
    const existingGradeByOrder = await prisma.grade.findUnique({
      where: {
        academicYearId_displayOrder: {
          academicYearId: data.academicYearId,
          displayOrder: data.displayOrder,
        },
      },
    });

    if (existingGradeByOrder) {
      throw new AppError(409, `Display order ${data.displayOrder} is already used in this academic year`);
    }

    // Create grade
    const grade = await prisma.grade.create({
      data: {
        academicYearId: data.academicYearId,
        name: data.name,
        displayOrder: data.displayOrder,
      },
    });

    return grade;
  }

  /**
   * Get all grades for authenticated admin's school
   * Optionally filter by academic year
   * @param schoolId - School ID from authenticated admin
   * @param academicYearId - Optional academic year filter
   */
  async getGrades(schoolId: string, academicYearId?: string): Promise<Grade[]> {
    // Build where clause
    const where: any = {
      academicYear: {
        schoolId,
      },
    };

    // If filtering by academic year, verify it belongs to admin's school first
    if (academicYearId) {
      const academicYear = await prisma.academicYear.findUnique({
        where: { id: academicYearId },
      });

      if (!academicYear) {
        throw new AppError(404, 'Academic year not found');
      }

      if (academicYear.schoolId !== schoolId) {
        throw new AppError(403, 'You do not have access to this academic year');
      }

      where.academicYearId = academicYearId;
    }

    const grades = await prisma.grade.findMany({
      where,
      orderBy: { displayOrder: 'asc' },
    });

    return grades;
  }

  /**
   * Get grade by ID with authorization check
   * @param id - Grade ID
   * @param requestingSchoolId - School ID from authenticated admin
   */
  async getGradeById(id: string, requestingSchoolId: string): Promise<Grade> {
    const grade = await prisma.grade.findUnique({
      where: { id },
      include: {
        academicYear: true,
      },
    });

    if (!grade) {
      throw new AppError(404, 'Grade not found');
    }

    // Authorization: Check if grade's academic year belongs to admin's school
    if (grade.academicYear.schoolId !== requestingSchoolId) {
      throw new AppError(403, 'You do not have access to this grade');
    }

    // Return grade without nested academicYear to avoid exposing unnecessary data
    const { academicYear, ...gradeData } = grade;
    return gradeData as Grade;
  }

  /**
   * Update grade with authorization and validation
   * @param id - Grade ID
   * @param requestingSchoolId - School ID from authenticated admin
   * @param data - Update data
   */
  async updateGrade(
    id: string,
    requestingSchoolId: string,
    data: UpdateGradeInput
  ): Promise<Grade> {
    // Fetch grade with academic year for authorization and status check
    const grade = await prisma.grade.findUnique({
      where: { id },
      include: {
        academicYear: true,
      },
    });

    if (!grade) {
      throw new AppError(404, 'Grade not found');
    }

    // Authorization: Check if grade's academic year belongs to admin's school
    if (grade.academicYear.schoolId !== requestingSchoolId) {
      throw new AppError(403, 'You do not have access to this grade');
    }

    // Check academic year status - only allow modifications in DRAFT
    if (grade.academicYear.status !== 'DRAFT') {
      throw new AppError(
        400,
        'Grades can only be modified while the academic year is in DRAFT status'
      );
    }

    // Prepare update data
    const updateData: {
      name?: string;
      displayOrder?: number;
    } = {};

    // Handle name update
    if (data.name !== undefined && data.name !== grade.name) {
      // Check for duplicate name
      const existingGrade = await prisma.grade.findUnique({
        where: {
          academicYearId_name: {
            academicYearId: grade.academicYearId,
            name: data.name,
          },
        },
      });

      if (existingGrade && existingGrade.id !== id) {
        throw new AppError(409, `Grade "${data.name}" already exists in this academic year`);
      }

      updateData.name = data.name;
    }

    // Handle display order update
    if (data.displayOrder !== undefined && data.displayOrder !== grade.displayOrder) {
      // Check for duplicate display order
      const existingGrade = await prisma.grade.findUnique({
        where: {
          academicYearId_displayOrder: {
            academicYearId: grade.academicYearId,
            displayOrder: data.displayOrder,
          },
        },
      });

      if (existingGrade && existingGrade.id !== id) {
        throw new AppError(409, `Display order ${data.displayOrder} is already used in this academic year`);
      }

      updateData.displayOrder = data.displayOrder;
    }

    // Update grade
    const updatedGrade = await prisma.grade.update({
      where: { id },
      data: updateData,
    });

    return updatedGrade;
  }
}

export const gradeService = new GradeService();
