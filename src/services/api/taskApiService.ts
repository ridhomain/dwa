import { FastifyBaseLogger } from 'fastify';
import { request } from 'undici';

export class TaskApiService {
  constructor(
    private baseUrl: string,
    private token: string,
    private logger: FastifyBaseLogger
  ) {}
  async patchTask(taskId: string, update: any): Promise<void> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Add auth token if available
      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      const res = await request(`${this.baseUrl}/api/v1/tasks/${taskId}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify(update),
      });

      if (res.statusCode < 200 || res.statusCode >= 300) {
        const body = await res.body.text();
        this.logger.error(`[TaskApi] Failed to patch task ${taskId}: ${res.statusCode} — ${body}`);
      }
    } catch (err: any) {
      this.logger.error(`[TaskApi] Error patching task ${taskId}: ${err.message}`);
    }
  }
}
