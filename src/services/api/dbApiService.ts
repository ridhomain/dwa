// src/services/api/dbApiService.ts
import { request } from 'undici';

export interface ConfigResponse {
  key: string;
  value: any;
}

export class DbApiService {
  constructor(
    private baseUrl: string,
    private token?: string
  ) {}

  /**
   * Get configuration by key
   */
  async getConfig(key: string): Promise<ConfigResponse[]> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.token) {
        headers['token'] = this.token;
      }

      // Use the exact GraphQL query structure that works
      const payloadGQL = {
        query: `query config($key: String) { 
          config(key: $key) {  
            key
            value
          }
        }`,
        variables: {
          key,
        },
      };

      const response = await request(`${this.baseUrl}/graphql`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payloadGQL),
      });

      if (response.statusCode >= 200 && response.statusCode < 300) {
        const data = (await response.body.json()) as any;

        if (data.errors) {
          throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
        }

        // Handle the single config response format
        if (data.data?.config) {
          return [data.data.config];
        }

        return [];
      }

      throw new Error(`Config API returned ${response.statusCode}`);
    } catch (error: any) {
      throw new Error(`Failed to get config ${key}: ${error.message}`);
    }
  }

  /**
   * Get multiple configurations by keys
   */
  async getConfigs(keys: string[]): Promise<ConfigResponse[]> {
    try {
      // Since the API uses singular 'config', we need to make multiple requests
      const results = await Promise.allSettled(keys.map((key) => this.getConfig(key)));

      const configs: ConfigResponse[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          configs.push(...result.value);
        }
      }

      return configs;
    } catch (error: any) {
      throw new Error(`Failed to get configs: ${error.message}`);
    }
  }
}
