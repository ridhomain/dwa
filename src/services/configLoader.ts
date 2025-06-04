// src/services/configLoader.ts
import { FastifyInstance } from 'fastify';

export interface ConfigValue {
  key: string;
  value: any;
  defaultValue: any;
}

export interface LoadedConfigs {
  ONBOARDINGS: any;
  HISTORY_SYNC: any;
}

// Default configurations
const DEFAULT_CONFIGS = {
  ONBOARDINGS: [],
  HISTORY_SYNC: {
    isFullSync: true,
    partialSyncDays: 30,
  },
};

export class ConfigLoaderService {
  private configs: LoadedConfigs;
  private debug: boolean;

  constructor(
    private fastify: FastifyInstance,
    debug = false
  ) {
    this.configs = { ...DEFAULT_CONFIGS };
    this.debug = debug;
  }

  /**
   * Load individual config from DB API
   */
  private async loadConfig(key: string, defaultValue: any): Promise<any> {
    try {
      // Use your existing dbApiService to query configs
      const response = await this.queryConfigs(key);

      if (response && response.length > 0) {
        const configValue = response[0].value;
        if (this.debug) {
          this.fastify.log.info(`Config loaded: ${key} => %o`, configValue);
        }
        return configValue;
      }

      if (this.debug) {
        this.fastify.log.warn(`Config not found for ${key}, using default: %o`, defaultValue);
      }
      return defaultValue;
    } catch (error) {
      this.fastify.log.error(`Error loading config ${key}: ${error}`);
      return defaultValue;
    }
  }

  /**
   * Query configs from DB API - implement based on your API structure
   */
  private async queryConfigs(key: string): Promise<any[]> {
    // This is a placeholder - you'll need to implement this based on your DB API structure
    // Example implementation:

    try {
      // If your DB API has a GraphQL endpoint like the original
      const query = `
        query getConfig($key: String!) {
          configs(filter: { key: $key }) {
            key
            value
          }
        }
      `;

      const variables = { key };

      // Use undici request directly since dbApiService doesn't have methods yet
      const { request } = await import('undici');

      const response = await request(`${this.fastify.config.DB_API_URL}/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          token: `${this.fastify.config.TOKEN}`,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (response.statusCode >= 200 && response.statusCode < 300) {
        const data = (await response.body.json()) as any;
        return data.data?.configs || [];
      }

      this.fastify.log.warn(`Config API returned ${response.statusCode} for key: ${key}`);
      return [];
    } catch (error) {
      this.fastify.log.error(`Failed to query config for ${key}:`, error);
      return [];
    }
  }

  /**
   * Load all required configurations
   */
  async loadConfigs(): Promise<LoadedConfigs> {
    if (this.debug) {
      this.fastify.log.info('Loading container configurations...');
    }
    const baseKey = `${this.fastify.config.COMPANY_ID}:${this.fastify.config.AGENT_ID}`;

    // Load configs in parallel
    const [onboardings, historySync] = await Promise.all([
      this.loadConfig(`${baseKey}-ONBOARDINGS`, DEFAULT_CONFIGS.ONBOARDINGS),
      this.loadConfig(`${baseKey}-HISTORY_SYNC`, DEFAULT_CONFIGS.HISTORY_SYNC),
    ]);

    this.configs = {
      ONBOARDINGS: onboardings,
      HISTORY_SYNC: historySync,
    };

    if (this.debug) {
      this.fastify.log.info('Loaded configs: %o', this.configs);
    }

    return this.configs;
  }

  /**
   * Get current configs
   */
  getConfigs(): LoadedConfigs {
    return this.configs;
  }

  /**
   * Get specific config
   */
  getConfig<K extends keyof LoadedConfigs>(key: K): LoadedConfigs[K] {
    return this.configs[key];
  }

  /**
   * Reload configs (useful for runtime updates)
   */
  async reloadConfigs(): Promise<LoadedConfigs> {
    this.fastify.log.info('Reloading configurations...');
    return this.loadConfigs();
  }
}
