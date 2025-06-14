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

  async getNextPendingTask(batchId: string): Promise<any> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      this.logger.info(`[TaskApi] Fetching next pending task for batch: ${batchId}`);

      const res = await request(`${this.baseUrl}/api/v1/tasks/next-pending/${batchId}`, {
        method: 'GET',
        headers,
      });

      this.logger.info(`[TaskApi] Response status: ${res.statusCode}`);

      if (res.statusCode === 404) {
        this.logger.info(`[TaskApi] No pending tasks found for batch: ${batchId}`);
        return null;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        const body = await res.body.text();
        this.logger.error(`[TaskApi] Error response: ${body}`);
        const error = new Error(`Failed to get next task: ${res.statusCode} - ${body}`);
        (error as any).statusCode = res.statusCode;
        throw error;
      }

      const responseText = await res.body.text();
      let data: any;

      try {
        data = JSON.parse(responseText);
      } catch (parseErr) {
        this.logger.error(`[TaskApi] Failed to parse response: ${parseErr}`);
        throw new Error('Invalid JSON response from API');
      }

      this.logger.info(`[TaskApi] Full response:`, JSON.stringify(data, null, 2));

      // Handle sendSuccess response structure: { success: true, data: { task: ... } }
      let task = null;

      if (data.success && data.data?.task) {
        task = data.data.task;
      } else if (data.task) {
        task = data.task;
      } else if (data.data) {
        task = data.data;
      }

      if (task && task._id) {
        this.logger.info(`[TaskApi] Found task: ${task._id}, status: ${task.status || 'unknown'}`);
        return task;
      } else {
        this.logger.info(`[TaskApi] No task found in response`);
        return null;
      }
    } catch (err: any) {
      this.logger.error(`[TaskApi] Error getting next pending task: ${err.message}`);
      throw err;
    }
  }
}
