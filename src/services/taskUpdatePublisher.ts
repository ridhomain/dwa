// src/services/taskUpdatePublisher.ts - MINIMAL VERSION
import { FastifyInstance } from 'fastify';

export type TaskStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'ERROR';

export interface TaskUpdate {
  taskId: string;
  status: TaskStatus;
  errorReason?: string;
  result?: any;
}

export class TaskUpdatePublisher {
  constructor(private fastify: FastifyInstance) {}

  /**
   * Publish minimal task update to NATS
   */
  async publishTaskUpdate(update: TaskUpdate): Promise<void> {
    try {
      const subject = `v1.tasks.updates.${this.fastify.config.COMPANY_ID}`;

      // Minimal payload - only what's needed
      const payload = {
        taskId: update.taskId,
        status: update.status,
        ...(update.errorReason && { errorReason: update.errorReason }),
        ...(update.result && { result: update.result }),
      };

      await this.fastify.publishEvent(subject, payload);

      this.fastify.log.info(`[TaskUpdate] ${update.taskId} => ${update.status}`);
    } catch (err: any) {
      this.fastify.log.error({ err, taskId: update.taskId }, '[TaskUpdate] Publish failed');
      throw err;
    }
  }

  // Convenience methods remain the same but simpler
  async markTaskCompleted(taskId: string, result?: any): Promise<void> {
    await this.publishTaskUpdate({ taskId, status: 'COMPLETED', result });
  }

  async markTaskError(taskId: string, errorReason: string): Promise<void> {
    await this.publishTaskUpdate({ taskId, status: 'ERROR', errorReason });
  }

  async markTaskProcessing(taskId: string): Promise<void> {
    await this.publishTaskUpdate({ taskId, status: 'PROCESSING' });
  }
}
