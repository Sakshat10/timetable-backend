import { type FastifyReply, type FastifyRequest } from 'fastify';
import { handleError } from '../../utils/errors.js';
import { curriculumService } from './curriculum.service.js';
import { copyCurriculumSchema, gradeParamSchema, overviewQuerySchema, replaceCurriculumSchema } from './curriculum.schema.js';

type Req = FastifyRequest<{ Body: unknown; Params: { gradeId?: string }; Querystring: unknown }>;

function schoolId(request: FastifyRequest): string {
  if (!request.admin) throw new Error('Authentication required');
  return request.admin.schoolId;
}

async function run(reply: FastifyReply, message: (data: any) => string, work: () => Promise<unknown>): Promise<void> {
  try {
    const data = await work();
    reply.status(200).send({ success: true, message: message(data), data });
  } catch (error) {
    handleError(error, reply);
  }
}

export class CurriculumController {
  getOverview = (request: Req, reply: FastifyReply) => run(reply, () => 'Curriculum retrieved successfully', () => curriculumService.getOverview(schoolId(request), overviewQuerySchema.parse(request.query).academicYearId));
  replace = (request: Req, reply: FastifyReply) =>
    run(reply, (d) => (d.applied ? 'Curriculum saved successfully' : 'Dry run: nothing was changed'), () => curriculumService.replaceCurriculum(schoolId(request), gradeParamSchema.parse(request.params).gradeId, replaceCurriculumSchema.parse(request.body)));
  copy = (request: Req, reply: FastifyReply) =>
    run(reply, (d) => (d.applied ? 'Curriculum copied successfully' : 'Dry run: nothing was changed'), () => curriculumService.copyCurriculum(schoolId(request), copyCurriculumSchema.parse(request.body)));
}

export const curriculumController = new CurriculumController();
