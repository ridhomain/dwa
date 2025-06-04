import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import { Registry, Gauge, Counter } from 'prom-client';

export default fp(async function metricsPlugin(fastify: FastifyInstance) {
  const register = new Registry();

  // Nats Metrics
  const natsConnectionGauge = new Gauge({
    name: 'nats_connection_status',
    help: 'Current NATS connection status (1 = event occurred)',
    labelNames: ['type'],
    registers: [register],
  });

  const natsErrorCounter = new Counter({
    name: 'nats_publish_errors_total',
    help: 'Total NATS publish failures by subject',
    labelNames: ['subject'],
    registers: [register],
  });

  // Redis Metrics
  const redisErrorCounter = new Counter({
    name: 'redis_errors_total',
    help: 'Total Redis errors grouped by command',
    labelNames: ['command'],
    registers: [register],
  });

  // Expose metrics endpoint
  fastify.get('/metrics', async (request, reply) => {
    reply.header('Content-Type', register.contentType);
    return register.metrics();
  });

  fastify.decorate('metrics', {
    counters: {
      natsErrorCounter,
      redisErrorCounter,
    },
    gauges: {
      natsConnectionGauge,
    },
    register,
  });
});
