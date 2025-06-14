// src/consumers/registerConsumers.ts

import { FastifyInstance } from 'fastify';
import { createAgentConsumer } from './createAgentConsumer';
// import { createAgentDurableConsumer } from './createAgentDurableConsumer';
import { createMailcastConsumer } from './createMailcastConsumer';
import { createBroadcastConsumer } from './createBroadcastConsumer';

export const registerConsumers = async (fastify: FastifyInstance) => {
  await createAgentConsumer(fastify);
  await createMailcastConsumer(fastify);
  await createBroadcastConsumer(fastify);
  // await createAgentDurableConsumer(fastify);
};
