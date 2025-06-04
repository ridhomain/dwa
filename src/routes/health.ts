import { FastifyInstance } from 'fastify';
import { getSock } from '../utils/sock';

export default async function routes(fastify: FastifyInstance) {
  fastify.get('/healthz', async () => {
    const sock = getSock();
    return {
      status: 'ok',
      sock,
    };
  });
}
