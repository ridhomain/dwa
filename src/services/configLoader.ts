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
      // Use the existing dbApiService instead of direct undici import
      const response = await this.fastify.dbApiService.getConfig(key);

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
    } catch (error: any) {
      this.fastify.log.error(`Error loading config ${key}: ${error.message}`);
      return defaultValue;
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
