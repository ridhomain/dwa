// src/services/onboardingService.ts
import { FastifyInstance, FastifyBaseLogger } from 'fastify';

export interface OnboardingConfig {
  id: string;
  active: boolean;
  pattern: string;
  tags: string;
  origin: string;
  assignedTo: string;
  reply?: string;
}

export interface OnboardingResult {
  isOnboarding: boolean;
  metadata?: {
    tags: string;
    origin: string;
    assignedTo: string;
    reply?: string;
  };
}

export class OnboardingService {
  private logger: FastifyBaseLogger;
  private fastify: FastifyInstance;

  constructor(fastify: FastifyInstance) {
    this.fastify = fastify;
    this.logger = fastify.log;
  }

  /**
   * Check if a message matches any onboarding pattern
   */
  async checkOnboarding(message: string): Promise<OnboardingResult> {
    try {
      // Get onboarding configs from the config loader
      const onboardingConfigs = this.fastify.getConfig('ONBOARDINGS') as OnboardingConfig[];

      if (!onboardingConfigs || onboardingConfigs.length === 0) {
        return { isOnboarding: false };
      }

      // Check each onboarding configuration
      for (const config of onboardingConfigs) {
        if (!config.active) {
          this.logger.debug(`Onboarding config ${config.id} is not active`);
          continue;
        }

        try {
          const regex = new RegExp(config.pattern, 'gi');
          const matches = message.match(regex);

          if (matches) {
            this.logger.info(`Message matched onboarding pattern: ${config.pattern}`);

            return {
              isOnboarding: true,
              metadata: {
                tags: config.tags || '',
                origin: config.origin || 'onboarding',
                assignedTo: config.assignedTo || '',
                reply: config.reply,
              },
            };
          }
        } catch (regexError) {
          this.logger.error(
            `Invalid regex pattern in onboarding config: ${config.pattern}`,
            regexError
          );
        }
      }

      // No matching pattern found
      return { isOnboarding: false };
    } catch (error) {
      this.logger.error('Error checking onboarding status:', error);
      return { isOnboarding: false };
    }
  }
}
