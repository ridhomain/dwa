import fp from 'fastify-plugin';
import { createBaileysClient } from '../services/createBaileysClient';
import { getSock } from '../utils/sock';
import { registerConsumers } from '../consumers';

export default fp(async (fastify) => {
  await createBaileysClient(fastify);
  await registerConsumers(fastify);

  fastify.addHook('onClose', async () => {
    try {
      const sock = getSock();
      sock.end(new Error('onclose lifecyle'));
      fastify.log.info('Baileys socket closed cleanly.');
    } catch (err) {
      fastify.log.error('Error closing Baileys socket:', err);
    }
  });
});
