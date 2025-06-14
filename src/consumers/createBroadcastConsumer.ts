import { FastifyInstance } from 'fastify';
import { StringCodec } from 'nats';
import { getSock } from '../utils/sock';
import { sendMessage } from '../services/sendMessage';
import { applyVariables } from '../utils/index';
import {
  BroadcastState,
  updateBroadcastProgress,
  transitionBroadcastStatus,
} from '../utils/broadcast';
import { TaskUpdatePublisher } from '../services/taskUpdatePublisher';

const sc = StringCodec();

interface BroadcastTask {
  _id: string;
  batchId: string;
  phoneNumber: string;
  message: any;
  variables?: Record<string, any>;
  contact?: Record<string, any>;
  status: string;
}

export async function createBroadcastConsumer(fastify: FastifyInstance) {
  let currentProcessor: BroadcastProcessor | null = null;
  let connectionMonitorInterval: NodeJS.Timeout;
  let isShuttingDown = false;

  const taskPublisher = new TaskUpdatePublisher(fastify);
  const broadcastKV = fastify.broadcastStateKV;

  fastify.log.info('[BroadcastConsumer] Initializing broadcast consumer');

  // Start connection monitor
  startConnectionMonitor();

  // Watch for broadcast state changes for this agent
  const stateWatcher = await broadcastKV.watch({
    key: `${fastify.config.AGENT_ID}.*`,
  });

  // Process state changes
  (async () => {
    try {
      for await (const entry of stateWatcher) {
        if (isShuttingDown) break;

        if (entry.operation === 'PUT' && entry.value) {
          const state: BroadcastState = JSON.parse(sc.decode(entry.value));

          fastify.log.info(
            { batchId: state.batchId, status: state.status },
            '[BroadcastConsumer] State change detected'
          );

          // Only process PROCESSING status
          if (state.status === 'PROCESSING') {
            // Check if we need to start a new processor
            if (!currentProcessor) {
              fastify.log.info(
                { batchId: state.batchId },
                '[BroadcastConsumer] Starting new processor'
              );
              currentProcessor = new BroadcastProcessor(state, fastify, taskPublisher);
              currentProcessor.start().catch((err) => {
                fastify.log.error({ err }, '[BroadcastConsumer] Processor error');
                currentProcessor = null;
              });
            } else if (currentProcessor.batchId !== state.batchId) {
              // Different batch - stop old, start new
              fastify.log.info(
                { oldBatchId: currentProcessor.batchId, newBatchId: state.batchId },
                '[BroadcastConsumer] Switching to new broadcast'
              );
              await currentProcessor.stop();
              currentProcessor = new BroadcastProcessor(state, fastify, taskPublisher);
              currentProcessor.start().catch((err) => {
                fastify.log.error({ err }, '[BroadcastConsumer] Processor error');
                currentProcessor = null;
              });
            }
            // If same batch and already processing, do nothing
          } else {
            // For any non-PROCESSING state, stop the processor if it exists
            if (currentProcessor) {
              fastify.log.info(
                { batchId: currentProcessor.batchId, newStatus: state.status },
                '[BroadcastConsumer] Stopping processor due to non-PROCESSING state'
              );
              await currentProcessor.stop();
              currentProcessor = null;
            }
          }
        }
      }
    } catch (err) {
      if (!isShuttingDown) {
        fastify.log.error({ err }, '[BroadcastConsumer] State watcher error');
      }
    }
  })();

  // Cleanup on shutdown
  fastify.addHook('onClose', async () => {
    isShuttingDown = true;

    if (connectionMonitorInterval) {
      clearInterval(connectionMonitorInterval);
    }

    if (currentProcessor) {
      await currentProcessor.stop();
    }

    if (stateWatcher) {
      stateWatcher.stop();
    }

    fastify.log.info('[BroadcastConsumer] Shutdown complete');
  });

  // Connection monitor
  function startConnectionMonitor() {
    let lastConnectionState = true;

    connectionMonitorInterval = setInterval(async () => {
      if (isShuttingDown) return;

      const sock = getSock();
      const isConnected = !!sock?.user;

      // Detect disconnection
      if (lastConnectionState && !isConnected) {
        fastify.log.warn('[BroadcastConsumer] Connection lost, checking for active broadcasts');

        // Auto-pause any active broadcast
        const keys = await broadcastKV.keys();

        for await (const key of keys) {
          if (key.startsWith(`${fastify.config.AGENT_ID}.`)) {
            const entry = await broadcastKV.get(key);
            if (entry?.value) {
              const state: BroadcastState = JSON.parse(sc.decode(entry.value));

              if (state.status === 'PROCESSING') {
                const result = await transitionBroadcastStatus(
                  broadcastKV,
                  fastify.config.AGENT_ID,
                  state.batchId,
                  'PAUSED',
                  {
                    pauseReason: 'AUTO_PAUSE_DISCONNECTION',
                  }
                );

                if (result.success) {
                  fastify.log.info(
                    { batchId: state.batchId },
                    '[BroadcastConsumer] Auto-paused broadcast due to disconnection'
                  );
                }
              }
            }
          }
        }
      }

      lastConnectionState = isConnected;
    }, 5000); // Check every 5 seconds
  }
}

// Broadcast Processor Class
class BroadcastProcessor {
  private isRunning = false;
  public readonly batchId: string;

  constructor(
    private state: BroadcastState,
    private fastify: FastifyInstance,
    private taskPublisher: TaskUpdatePublisher
  ) {
    this.batchId = state.batchId;
  }

  async start() {
    this.isRunning = true;

    this.fastify.log.info(
      {
        batchId: this.batchId,
        total: this.state.total,
        completed: this.state.completed,
        failed: this.state.failed,
      },
      '[BroadcastProcessor] Starting broadcast processing'
    );

    // Small delay to ensure everything is ready
    await sleep(1000);

    while (this.isRunning) {
      try {
        // 1. Check connection
        const sock = getSock();
        if (!sock?.user) {
          this.fastify.log.warn('[BroadcastProcessor] No socket connection');
          await this.pauseBroadcast('AUTO_PAUSE_DISCONNECTION');
          break;
        }

        // 2. Get next pending task
        const task = await this.getNextPendingTask();

        if (!task) {
          this.fastify.log.info('[BroadcastProcessor] No more pending tasks');

          // Check the current state to see final counts
          const stateKey = `${this.fastify.config.AGENT_ID}.${this.batchId}`;
          const stateEntry = await this.fastify.broadcastStateKV.get(stateKey);

          if (stateEntry?.value) {
            const currentState: BroadcastState = JSON.parse(sc.decode(stateEntry.value));
            this.fastify.log.info(
              {
                batchId: this.batchId,
                total: currentState.total,
                processed: currentState.processed,
                completed: currentState.completed,
                failed: currentState.failed,
                status: currentState.status,
              },
              '[BroadcastProcessor] Final broadcast state'
            );
          }

          // All tasks processed - state will auto-update based on progress
          break;
        }

        this.fastify.log.info(
          {
            taskId: task._id,
            phoneNumber: task.phoneNumber,
            status: task.status,
          },
          '[BroadcastProcessor] Got task, starting to process'
        );

        // 3. Process the task
        const shouldContinue = await this.processTask(task);

        if (!shouldContinue) {
          break;
        }

        // 4. Apply delay (2-5 seconds)
        const delay = 2000 + Math.floor(Math.random() * 3000);
        this.fastify.log.debug(`[BroadcastProcessor] Waiting ${delay}ms before next message`);
        await sleep(delay);
      } catch (err: any) {
        this.fastify.log.error({ err }, '[BroadcastProcessor] Unexpected error in main loop');
        await this.pauseBroadcast('ERROR', err.message);
        break;
      }
    }

    this.isRunning = false;
    this.fastify.log.info('[BroadcastProcessor] Stopped processing');
  }

  async stop() {
    this.fastify.log.info('[BroadcastProcessor] Stopping processor');
    this.isRunning = false;
  }

  private async getNextPendingTask(): Promise<BroadcastTask | null> {
    try {
      this.fastify.log.debug(
        {
          batchId: this.batchId,
          taskApiUrl: this.fastify.config.TASK_API_URL,
        },
        '[BroadcastProcessor] Fetching next pending task'
      );

      const task = await this.fastify.taskApiService.getNextPendingTask(this.batchId);

      if (task) {
        this.fastify.log.debug(
          { taskId: task._id, status: task.status, phoneNumber: task.phoneNumber },
          '[BroadcastProcessor] Found task'
        );
      } else {
        this.fastify.log.debug(
          { batchId: this.batchId },
          '[BroadcastProcessor] No task returned from API'
        );
      }

      return task;
    } catch (err: any) {
      // If 404, no pending tasks
      if (err.statusCode === 404) {
        this.fastify.log.debug(
          { batchId: this.batchId },
          '[BroadcastProcessor] API returned 404 - no pending tasks'
        );
        return null;
      }
      this.fastify.log.error(
        { err, batchId: this.batchId },
        '[BroadcastProcessor] Failed to get next task'
      );
      throw err;
    }
  }

  private async processTask(task: BroadcastTask): Promise<boolean> {
    const { _id: taskId, phoneNumber, message, variables, contact } = task;

    this.fastify.log.info({ taskId, phoneNumber }, '[BroadcastProcessor] Processing task');

    try {
      // Get socket
      const sock = getSock();
      if (!sock) {
        throw new Error('Socket not available');
      }

      // Prepare JID
      const jid = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;

      // Apply variables if any
      let processedMessage = message;
      if (variables || contact) {
        processedMessage = applyVariables(message, {
          ...contact,
          ...variables,
        });
      }

      // Send message
      const result = await sendMessage(sock, processedMessage, jid, null);

      if (result.success && result.sentMsg) {
        // Success
        const messageId = result.sentMsg.key.id;

        // Update broadcast progress
        await updateBroadcastProgress(
          this.fastify.broadcastStateKV,
          this.batchId,
          this.fastify.config.AGENT_ID,
          { status: 'COMPLETED', phoneNumber }
        );

        // Publish task update via NATS
        await this.taskPublisher.markTaskCompleted(taskId, {
          messageId,
          sentAt: new Date().toISOString(),
          type: 'broadcast',
        });

        this.fastify.log.info(
          { taskId, messageId },
          '[BroadcastProcessor] Task completed successfully'
        );
      } else {
        // Failed - but we continue with next task
        const error = result.errMessage || 'Failed to send message';

        // Update broadcast progress as ERROR
        await updateBroadcastProgress(
          this.fastify.broadcastStateKV,
          this.batchId,
          this.fastify.config.AGENT_ID,
          { status: 'ERROR', phoneNumber }
        );

        // Mark task as ERROR
        await this.taskPublisher.markTaskError(taskId, error);

        this.fastify.log.error(
          { taskId, error },
          '[BroadcastProcessor] Task failed, continuing with next'
        );

        // Check failure rate
        const stateKey = `${this.fastify.config.AGENT_ID}.${this.batchId}`;
        const stateEntry = await this.fastify.broadcastStateKV.get(stateKey);

        if (stateEntry?.value) {
          const currentState: BroadcastState = JSON.parse(sc.decode(stateEntry.value));
          const failureRate =
            currentState.processed > 0 ? currentState.failed / currentState.processed : 0;

          // If failure rate > 50%, pause the broadcast
          if (failureRate > 0.5 && currentState.processed >= 5) {
            this.fastify.log.warn(
              { failureRate, failed: currentState.failed, processed: currentState.processed },
              '[BroadcastProcessor] High failure rate detected, pausing broadcast'
            );
            await this.pauseBroadcast(
              'ERROR',
              `High failure rate: ${(failureRate * 100).toFixed(1)}%`
            );
            return false; // Stop processing
          }
        }
      }

      return true; // Continue with next task
    } catch (err: any) {
      this.fastify.log.error(
        { err, taskId },
        '[BroadcastProcessor] Unexpected error processing task'
      );

      // Mark as ERROR and continue
      await this.taskPublisher.markTaskError(taskId, err.message);

      // Update progress
      await updateBroadcastProgress(
        this.fastify.broadcastStateKV,
        this.batchId,
        this.fastify.config.AGENT_ID,
        { status: 'ERROR', phoneNumber }
      );

      // Continue with next task (don't pause entire broadcast for one error)
      return true;
    }
  }

  private async pauseBroadcast(reason: string, error?: string) {
    this.fastify.log.info(
      { batchId: this.batchId, reason, error },
      '[BroadcastProcessor] Pausing broadcast'
    );

    try {
      await transitionBroadcastStatus(
        this.fastify.broadcastStateKV,
        this.fastify.config.AGENT_ID,
        this.batchId,
        'PAUSED',
        {
          pauseReason: reason as any,
          lastError: error,
          pausedAt: new Date().toISOString(),
        }
      );
    } catch (err: any) {
      this.fastify.log.error({ err }, '[BroadcastProcessor] Failed to pause broadcast');
    }
  }
}

// Helper function
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
