import { type FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { type ApiErrorResponse } from '../types/api.js';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public errors?: Record<string, string[]>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * True when Prisma rejected a write because of a unique-constraint violation (P2002).
 * Services use this to turn a lost race into the same friendly 409 as their pre-check.
 */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export function handleError(error: unknown, reply: FastifyReply): void {
  // Handle Zod validation errors
  if (error instanceof ZodError) {
    const errors: Record<string, string[]> = {};
    error.issues.forEach((err) => {
      const path = err.path.join('.');
      if (!errors[path]) {
        errors[path] = [];
      }
      errors[path]!.push(err.message);
    });

    const response: ApiErrorResponse = {
      success: false,
      message: 'Validation failed',
      errors,
    };

    reply.status(400).send(response);
    return;
  }

  // Handle custom application errors
  if (error instanceof AppError) {
    const response: ApiErrorResponse = {
      success: false,
      message: error.message,
      ...(error.errors && { errors: error.errors }),
    };

    reply.status(error.statusCode).send(response);
    return;
  }

  // Handle Prisma unique constraint violations
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      const target = (error.meta?.target as string[]) || [];
      const field = target[0] || 'field';
      
      const response: ApiErrorResponse = {
        success: false,
        message: `${field} already exists`,
      };

      reply.status(409).send(response);
      return;
    }

    // A record this write points at (or that points at this one) was deleted or changed by someone else a moment ago: a lost race, not a server fault
    if (error.code === 'P2003') {
      const response: ApiErrorResponse = {
        success: false,
        message: 'A related record no longer exists or has just changed. Reload and try again; nothing was changed.',
      };

      reply.status(409).send(response);
      return;
    }

    if (error.code === 'P2025') {
      const response: ApiErrorResponse = {
        success: false,
        message: 'Resource not found',
      };

      reply.status(404).send(response);
      return;
    }
  }

  // Handle unexpected errors
  // Security: Only log error message, not full error object which may contain sensitive data
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // Server-side diagnosis only (the client always gets the generic message below). P2021/P2022 mean the code expects a table or column the
    // database does not have: the database is behind the code (a migration has not been applied to THIS database).
    const meta = error.meta ?? {};
    const parts = [`code=${error.code}`, meta.modelName ? `model=${String(meta.modelName)}` : '', meta.column ? `column=${String(meta.column)}` : '', meta.table ? `table=${String(meta.table)}` : ''].filter(Boolean);
    const hint = error.code === 'P2021' || error.code === 'P2022' ? ' - the database schema is behind the code: run `prisma migrate deploy` against this database' : '';
    console.error(`Unexpected database error: ${parts.join(' ')}${hint}`);
  }
  if (error instanceof Error) {
    console.error('Unexpected error:', error.message);
  } else {
    console.error('Unexpected error: Unknown error type');
  }

  const response: ApiErrorResponse = {
    success: false,
    message: 'An unexpected error occurred',
  };

  reply.status(500).send(response);
}
