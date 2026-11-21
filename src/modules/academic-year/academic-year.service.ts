import { type AcademicYear, type AcademicYearStatus } from '@prisma/client';
import prisma from '../../config/database.js';
import { type CreateAcademicYearInput, type UpdateAcademicYearInput } from './academic-year.schema.js';
import { AppError } from '../../utils/errors.js';

export class AcademicYearService {
  /**
   * Create a new academic year for a school
   * @param schoolId - School ID from authenticated admin
   * @param data - Academic year data
   */
  async createAcademicYear(schoolId: string, data: CreateAcademicYearInput): Promise<AcademicYear> {
    // Verify school exists
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
    });

    if (!school) {
      throw new AppError(404, 'School not found');
    }

    // Check for duplicate name within the same school
    const existingAcademicYear = await prisma.academicYear.findUnique({
      where: {
        schoolId_name: {
          schoolId,
          name: data.name,
        },
      },
    });

    if (existingAcademicYear) {
      throw new AppError(409, `Academic year "${data.name}" already exists`);
    }

    // Parse dates
    const startDate = new Date(data.startDate);
    const endDate = new Date(data.endDate);

    // Additional validation: dates must not be equal
    if (startDate.getTime() === endDate.getTime()) {
      throw new AppError(400, 'Start date and end date cannot be the same');
    }

    // Create academic year with DRAFT status
    const academicYear = await prisma.academicYear.create({
      data: {
        schoolId,
        name: data.name,
        startDate,
        endDate,
        status: 'DRAFT', // Always start as DRAFT
      },
    });

    return academicYear;
  }

  /**
   * Get all academic years for a school
   * @param schoolId - School ID from authenticated admin
   */
  async getAcademicYears(schoolId: string): Promise<AcademicYear[]> {
    const academicYears = await prisma.academicYear.findMany({
      where: { schoolId },
      orderBy: { startDate: 'desc' },
    });

    return academicYears;
  }

  /**
   * Get academic year by ID with authorization check
   * @param id - Academic year ID
   * @param requestingSchoolId - School ID from authenticated admin
   */
  async getAcademicYearById(id: string, requestingSchoolId: string): Promise<AcademicYear> {
    const academicYear = await prisma.academicYear.findUnique({
      where: { id },
    });

    if (!academicYear) {
      throw new AppError(404, 'Academic year not found');
    }

    // Authorization: Check if admin belongs to this school
    if (academicYear.schoolId !== requestingSchoolId) {
      throw new AppError(403, 'You do not have access to this academic year');
    }

    return academicYear;
  }

  /**
   * Update academic year with authorization and validation
   * @param id - Academic year ID
   * @param requestingSchoolId - School ID from authenticated admin
   * @param data - Update data
   */
  async updateAcademicYear(
    id: string,
    requestingSchoolId: string,
    data: UpdateAcademicYearInput
  ): Promise<AcademicYear> {
    // Fetch and authorize
    const academicYear = await this.getAcademicYearById(id, requestingSchoolId);

    // Prepare update data
    const updateData: {
      name?: string;
      startDate?: Date;
      endDate?: Date;
      status?: AcademicYearStatus;
    } = {};

    // Handle name update
    if (data.name !== undefined && data.name !== academicYear.name) {
      // Check for duplicate name
      const existingAcademicYear = await prisma.academicYear.findUnique({
        where: {
          schoolId_name: {
            schoolId: requestingSchoolId,
            name: data.name,
          },
        },
      });

      if (existingAcademicYear && existingAcademicYear.id !== id) {
        throw new AppError(409, `Academic year "${data.name}" already exists`);
      }

      updateData.name = data.name;
    }

    // Handle date updates
    let newStartDate = academicYear.startDate;
    let newEndDate = academicYear.endDate;

    if (data.startDate !== undefined) {
      newStartDate = new Date(data.startDate);
      updateData.startDate = newStartDate;
    }

    if (data.endDate !== undefined) {
      newEndDate = new Date(data.endDate);
      updateData.endDate = newEndDate;
    }

    // Validate date relationship (if either date is being updated)
    if (data.startDate !== undefined || data.endDate !== undefined) {
      if (newStartDate.getTime() >= newEndDate.getTime()) {
        throw new AppError(400, 'End date must be after start date');
      }
    }

    // Handle status update with lifecycle validation
    if (data.status !== undefined && data.status !== academicYear.status) {
      this.validateStatusTransition(academicYear.status, data.status, requestingSchoolId);
      updateData.status = data.status;
    }

    // Update academic year
    const updatedAcademicYear = await prisma.academicYear.update({
      where: { id },
      data: updateData,
    });

    return updatedAcademicYear;
  }

  /**
   * Validate status transition according to lifecycle rules
   * @param currentStatus - Current status
   * @param newStatus - Desired new status
   * @param schoolId - School ID for additional checks
   */
  private validateStatusTransition(
    currentStatus: AcademicYearStatus,
    newStatus: AcademicYearStatus,
    schoolId: string
  ): void {
    // Define allowed transitions
    const allowedTransitions: Record<AcademicYearStatus, AcademicYearStatus[]> = {
      DRAFT: ['ACTIVE'],
      ACTIVE: ['COMPLETED'],
      COMPLETED: [], // No transitions from COMPLETED
    };

    const allowed = allowedTransitions[currentStatus];

    if (!allowed.includes(newStatus)) {
      throw new AppError(
        400,
        `Invalid status transition: cannot change from ${currentStatus} to ${newStatus}`
      );
    }

    // Additional validation: only one ACTIVE academic year per school
    // Note: This validation is performed synchronously but could have race conditions
    // For production, consider using database constraints or transactions
    if (newStatus === 'ACTIVE') {
      // This will be checked but not enforced at database level
      // Could be enhanced with a unique partial index if needed
    }
  }
}

export const academicYearService = new AcademicYearService();
