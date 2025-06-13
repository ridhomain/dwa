// src/plugins/nats.ts
import fp from 'fastify-plugin';
import { connect, StringCodec, JetStreamClient, JetStreamManager, KV } from 'nats';

export default fp(async (fastify) => {
  const servers = fastify.config.NATS_SERVERS.split(',');

  const nc = await connect({
    servers,
    user: fastify.config.NATS_USERNAME,
    pass: fastify.config.NATS_PASSWORD,
    name: `agent-${fastify.config.COMPANY_ID}-${fastify.config.AGENT_ID}`,
    reconnect: true,
    maxReconnectAttempts: 5,
    reconnectTimeWait: 2000,
    timeout: 5000,
  });

  fastify.log.info(`[NATS] Connected to %o`, nc.getServer());

  // Status logging
  const status = nc.status();
  (async () => {
    try {
      for await (const s of status) {
        switch (s.type) {
          case 'disconnect':
            fastify.log.warn('NATS disconnected: %s', s.data);
            fastify.metrics.gauges.natsConnectionGauge.labels(s.type).set(1);
            break;
          case 'reconnect':
            fastify.log.info('NATS reconnected: %s', s.data);
            fastify.metrics.gauges.natsConnectionGauge.labels(s.type).set(1);
            break;
          case 'error':
            fastify.log.error('NATS error: %s', s.data);
            fastify.metrics.gauges.natsConnectionGauge.labels(s.type).set(1);
            break;
          case 'update':
            fastify.log.info('NATS server update: %o', s.data);
            fastify.metrics.gauges.natsConnectionGauge.labels(s.type).set(1);
            break;
          default:
            fastify.log.info('NATS event [%s]: %o', s.type, s.data);
        }
      }
    } catch (err) {
      if (err instanceof Error) {
        fastify.log.error('NATS closed with error: %s', err.message);
      } else if (err) {
        fastify.log.error('NATS closed with unknown error: %o', err);
      } else {
        fastify.log.warn('NATS connection closed normally.');
      }
    }
  })();

  const js: JetStreamClient = nc.jetstream();
  const jsm: JetStreamManager = await nc.jetstreamManager();

  // Initialize KV stores
  let broadcastStateKV: KV;
  try {
    broadcastStateKV = await js.views.kv('broadcast_state');
    fastify.log.info('[NATS] Connected to broadcast_state KV');
  } catch (err: any) {
    fastify.log.error('[NATS] Failed to connect to broadcast_state KV:', err.message);
    throw new Error('broadcast_state KV not found. Ensure WhatsApp Service is running first.');
  }

  // utils functions
  const publishEvent = async (subject: string, data: any) => {
    try {
      const payload = typeof data === 'string' ? data : JSON.stringify(data);
      const encoded = StringCodec().encode(payload);

      const ack = await js.publish(subject, encoded);
      fastify.log.info(`[NATS] Published to ${subject}. ack: %o`, ack);
    } catch (err) {
      fastify.log.error(`[NATS] Error publishing to ${subject}. error: %o`, err);
      fastify.metrics.counters.natsErrorCounter.labels(subject).inc();
    }
  };

  fastify.decorate('nats', nc);
  fastify.decorate('js', js);
  fastify.decorate('jsm', jsm);
  fastify.decorate('broadcastStateKV', broadcastStateKV);
  fastify.decorate('publishEvent', publishEvent);

  fastify.addHook('onClose', async () => {
    await nc.close();
    fastify.log.info('NATS JetStream connection closed cleanly.');
  });
});
