// src/services/onboardingService.ts
import { FastifyInstance, FastifyBaseLogger } from 'fastify';

export interface OnboardingConfig {
  id: string;
  title: string;
  active: boolean;
  pattern: string;
  tags: string;
  origin: string;
  assignedTo: string;
  reply?: any;
}

export interface CampaignPayload {
  is_campaign: boolean;
  tags: string;
  origin: string;
  assigned_to: string;
}

export interface OnboardingResult {
  campaign: CampaignPayload;
  reply: any;
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
        const campaign = { is_campaign: false, tags: '', origin: '', assigned_to: '' };
        return {
          campaign,
          reply: null,
        };
      }

      // Check each onboarding configuration
      for (const config of onboardingConfigs) {
        if (!config.active) {
          continue;
        }

        try {
          const regex = new RegExp(config.pattern, 'g');
          const matches = message.match(regex);

          if (matches) {
            this.logger.info(`Message matched onboarding pattern: ${config.pattern}`);

            const campaign = {
              is_campaign: true,
              tags: config.tags || '',
              origin: config.origin || 'onboarding',
              assigned_to: config.assignedTo || '',
            };
            return {
              campaign,
              reply: config.reply,
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
      const campaign = { is_campaign: false, tags: '', origin: '', assigned_to: '' };
      return {
        campaign,
        reply: null,
      };
    } catch (error) {
      this.logger.error('Error checking onboarding status:', error);
      const campaign = { is_campaign: false, tags: '', origin: '', assigned_to: '' };
      return {
        campaign,
        reply: null,
      };
    }
  }
}
