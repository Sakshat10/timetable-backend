import { type FastifyRequest } from 'fastify';

export interface AuthenticatedAdmin {
  id: string;
  schoolId: string;
  email: string;
  name: string;
}

// Augment Fastify request type to include admin
declare module 'fastify' {
  interface FastifyRequest {
    admin?: AuthenticatedAdmin;
  }
}
