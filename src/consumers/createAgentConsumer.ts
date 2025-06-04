import { FastifyInstance } from 'fastify';
import { StringCodec } from 'nats';
import { processActions } from '../events/processActions';

const sc = StringCodec();

export async function createAgentConsumer(fastify: FastifyInstance) {
  const subject = `v1.agents.${fastify.config.AGENT_ID}`;

  const sub = fastify.nats.subscribe(subject, {
    queue: `agent-queue-${fastify.config.AGENT_ID}`,
  });
  fastify.log.info(
    `[NATS] Subscribed to ${subject} [queue: agent-queue-${fastify.config.AGENT_ID}]`
  );

  (async () => {
    for await (const m of sub) {
      try {
        const { action, payload } = JSON.parse(sc.decode(m.data));
        fastify.log.info(`[AgentConsumer] Processing action: ${action}`);

        const result = await processActions(fastify, action, payload);

        if (m.reply) {
          m.respond(sc.encode(JSON.stringify(result)));
        }
      } catch (err: any) {
        fastify.log.error(err, '[AgentConsumer] Failed to process message');

        if (m.reply) {
          m.respond(
            sc.encode(
              JSON.stringify({
                success: false,
                error: err.message || 'Unknown failure',
              })
            )
          );
        }
      }
    }
  })();

  fastify.addHook('onClose', async () => {
    fastify.log.info(`[NATS] Draining subscription for ${subject}`);
    await sub.drain();
  });
}
