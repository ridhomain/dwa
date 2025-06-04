// src/consumers/registerConsumers.ts

import { FastifyInstance } from 'fastify';
import { createAgentConsumer } from './createAgentConsumer';
import { createAgentDurableConsumer } from './createAgentDurableConsumer';

export const registerConsumers = async (fastify: FastifyInstance) => {
  await createAgentConsumer(fastify);
  await createAgentDurableConsumer(fastify);
};
