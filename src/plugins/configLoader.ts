// src/plugins/configLoader.ts
import fp from 'fastify-plugin';
import { ConfigLoaderService, LoadedConfigs } from '../services/configLoader';

export default fp(async (fastify) => {
  const debug = fastify.config.NODE_ENV === 'development';

  const configLoader = new ConfigLoaderService(fastify, debug);

  // Load configs during plugin registration
  await configLoader.loadConfigs();

  // Decorate fastify instance with config loader
  fastify.decorate('configLoader', configLoader);

  // Add convenient methods to access configs
  fastify.decorate('getConfig', (key: string) => {
    return configLoader.getConfig(key as keyof LoadedConfigs);
  });
  fastify.decorate('getConfigs', () => configLoader.getConfigs());
  fastify.decorate('reloadConfigs', () => configLoader.reloadConfigs());

  fastify.log.info('Config loader plugin registered successfully');
});
