import fp from 'fastify-plugin';
import IORedis from 'ioredis';

export default fp(async (fastify) => {
  const connectionName = `agent-${fastify.config.COMPANY_ID}-${fastify.config.AGENT_ID}`;

  const options = {
    host: fastify.config.REDIS_HOST,
    port: fastify.config.REDIS_PORT,
    password: fastify.config.REDIS_PASSWORD,
    connectionName,
    maxRetriesPerRequest: 4,
    reconnectOnError: (err: any) => err.message.includes('READONLY'),
  };

  const redis = new IORedis(options);

  redis.on('connect', () => {
    fastify.log.info(`[${connectionName}] Redis connected`);
  });

  redis.on('error', (err) => {
    fastify.log.error(`[${connectionName}] Redis error: ${err.message}`);
    fastify.metrics.counters.redisErrorCounter.labels('client').inc();
  });

  fastify.decorate('redis', redis);

  fastify.addHook('onClose', (instance, done) => {
    redis
      .quit()
      .then(() => {
        fastify.log.info(`[${connectionName}] Redis connection closed.`);
        done();
      })
      .catch((err: any) => {
        fastify.log.error(`[${connectionName}] Redis close error: ${err.message}`);
        done();
      });
  });
});
