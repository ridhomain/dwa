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
        headers['token'] = `${this.token}`;
      }

      // GraphQL query to get config
      const query = `
        query getConfig($key: String!) {
          configs(filter: { key: $key }) {
            key
            value
          }
        }
      `;

      const variables = { key };

      const response = await request(`${this.baseUrl}/graphql`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      });

      if (response.statusCode >= 200 && response.statusCode < 300) {
        const data = (await response.body.json()) as any;
        return data.data?.configs || [];
      }

      throw new Error(`Config API returned ${response.statusCode}`);
    } catch (error) {
      throw new Error(`Failed to get config ${key}: ${error}`);
    }
  }

  /**
   * Get multiple configurations by keys
   */
  async getConfigs(keys: string[]): Promise<ConfigResponse[]> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.token) {
        headers['token'] = `${this.token}`;
      }

      // GraphQL query to get multiple configs
      const query = `
        query getConfigs($keys: [String!]!) {
          configs(filter: { key: { in: $keys } }) {
            key
            value
          }
        }
      `;

      const variables = { keys };

      const response = await request(`${this.baseUrl}/graphql`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables }),
      });

      if (response.statusCode >= 200 && response.statusCode < 300) {
        const data = (await response.body.json()) as any;
        return data.data?.configs || [];
      }

      throw new Error(`Config API returned ${response.statusCode}`);
    } catch (error) {
      throw new Error(`Failed to get configs: ${error}`);
    }
  }
}
