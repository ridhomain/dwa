// src/plugins/onboarding.ts
import fp from 'fastify-plugin';
import { OnboardingService } from '../services/onboardingService';

export default fp(async (fastify) => {
  // Create and register the onboarding service
  const onboardingService = new OnboardingService(fastify);

  fastify.decorate('onboardingService', onboardingService);

  fastify.log.info('Onboarding service registered');
});
