import Fastify from 'fastify';

// Plugins
import envPlugin from './config';
import redisPlugin from './plugins/redis';
import natsPlugin from './plugins/nats';
import baileysPlugin from './plugins/baileys';
import metricsPlugin from './plugins/metrics';
import apiServicePlugin from './plugins/apiService';
import configLoaderPlugin from './plugins/configLoader';
import mediaDownloadPlugin from './plugins/mediaDownload';
import onboardingPlugin from './plugins/onboarding';

import healthRoutes from './routes/health';

async function start() {
  const fastify = Fastify({
    logger: {
      level: 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    },
  });

  // Register plugins and routes
  await fastify.register(envPlugin);
  await fastify.register(apiServicePlugin);
  await fastify.register(metricsPlugin);
  await fastify.register(redisPlugin);
  await fastify.register(natsPlugin);
  await fastify.register(configLoaderPlugin);
  await fastify.register(mediaDownloadPlugin);
  await fastify.register(onboardingPlugin);

  fastify.after(async () => {
    await fastify.register(baileysPlugin);
  });
  await fastify.register(healthRoutes);

  // Graceful shutdown handlers
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];

  for (const signal of signals) {
    process.on(signal, async () => {
      fastify.log.info({ signal }, 'Shutting down gracefully...');
      try {
        await fastify.close();
        fastify.log.info('Cleanup done.');
        process.exit(0);
      } catch (err) {
        fastify.log.error(err, 'Error during shutdown');
        process.exit(1);
      }
    });
  }

  // Start the server
  try {
    await fastify.listen({
      port: Number(fastify.config.PORT || 3000),
      host: '0.0.0.0',
    });
    fastify.log.info(`Server listening on port ${fastify.config.PORT || 3000}`);
  } catch (err) {
    fastify.log.error(err, 'Startup failed');
    process.exit(1);
  }
}

start();
