import fp from 'fastify-plugin';
import { MediaDownloadService } from '../services/mediaDownloadService';

export default fp(async (fastify) => {
  // Decorate fastify with media service for easy access
  fastify.decorate('mediaService', new MediaDownloadService(fastify));

  fastify.log.info('Media download service registered');
});
