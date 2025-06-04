import fp from 'fastify-plugin';
import env from '@fastify/env';
import { envSchema } from './env.schema';

export default fp(async (fastify) => {
  await fastify.register(env, {
    schema: envSchema,
    dotenv: true,
  });
});
