import fp from 'fastify-plugin';
import { TaskApiService } from '../services/api/taskApiService';
import { DbApiService } from '../services/api/dbApiService';

export default fp(async (fastify) => {
  fastify.decorate(
    'taskApiService',
    new TaskApiService(fastify.config.TASK_API_URL, fastify.config.TOKEN, fastify.log)
  );
  fastify.decorate('dbApiService', new DbApiService(fastify.config.DB_API_URL));
});
