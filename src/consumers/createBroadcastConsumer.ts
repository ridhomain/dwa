// src/consumers/createBroadcastConsumer.ts
import { FastifyInstance } from 'fastify';
import { StringCodec, AckPolicy, DeliverPolicy, ReplayPolicy } from 'nats';
import { getSock } from '../utils/sock';
import { sendMessage } from '../services/sendMessage';
import { applyVariables } from '../utils/index';
import { updateBroadcastProgress, BroadcastState, autoPauseBroadcasts } from '../utils/broadcast';

const sc = StringCodec();

interface BroadcastPayload {
  companyId: string;
  agentId: string;
  taskId: string;
  batchId: string;
  phoneNumber: string;
  message: any;
  options?: any;
  variables?: any;
  label?: string;
  taskAgent?: 'DAISI' | 'META';
  contact?: {
    name?: string;
    phone: string;
    [key: string]: any;
  };
}

export async function createBroadcastConsumer(fastify: FastifyInstance) {
  const streamName = 'agent_durable_stream';
  const consumerName = `broadcast-consumer-${fastify.config.AGENT_ID}`;
  const broadcastSubject = `v1.broadcasts.${fastify.config.AGENT_ID}`;

  let isShuttingDown = false;
  let stateWatcher: any;

  // Ensure consumer exists
  await ensureBroadcastConsumer(fastify, streamName, consumerName, broadcastSubject);

  // Check socket status before starting
  const sock = getSock();
  if (!sock || sock.user === undefined) {
    fastify.log.warn('[BroadcastConsumer] Socket not ready, waiting for connection');

    const checkInterval = setInterval(() => {
      const currentSock = getSock();
      if (currentSock && currentSock.user) {
        clearInterval(checkInterval);
        fastify.log.info('[BroadcastConsumer] Socket connected, starting worker');
        startBroadcastWorker();
      }
    }, 10000);

    fastify.addHook('onClose', () => clearInterval(checkInterval));
  } else {
    fastify.log.info('[BroadcastConsumer] Socket ready, starting worker');
    startBroadcastWorker();
  }

  // Shutdown hook
  fastify.addHook('onClose', async () => {
    fastify.log.info('[BroadcastConsumer] Initiating shutdown...');
    isShuttingDown = true;

    if (stateWatcher) {
      await stateWatcher.destroy();
    }
  });

  async function startBroadcastWorker() {
    try {
      const consumer = await fastify.js.consumers.get(streamName, consumerName);

      // Local cache of broadcast states
      const broadcastStates = new Map<string, BroadcastState>();

      // Setup KV watcher for real-time state updates
      stateWatcher = await fastify.broadcastStateKV.watch({
        key: `${fastify.config.AGENT_ID}.*`, // Changed from _ to .
      });

      // Background process: Watch for state changes
      (async () => {
        try {
          for await (const entry of stateWatcher) {
            // fastify.log.info(`[KV Watcher] Broadcast KVE => %o`, entry.operation);
            // fastify.log.info(`[KV Watcher] Broadcast KVE => %o`, entry.key);

            if (isShuttingDown) break;

            const kValue = sc.decode(entry.value);
            const kOperation = entry.operation;

            if (kOperation === 'PUT') {
              fastify.log.info(`[KV Watcher] Broadcast KVE => %o`, sc.decode(entry.value));
              try {
                const state: BroadcastState = JSON.parse(kValue);
                broadcastStates.set(state.batchId, state);

                fastify.log.debug(
                  `[KV Watcher] Broadcast ${state.batchId} => ${state.status} (key: ${entry.key})`
                );
              } catch (parseErr) {
                fastify.log.error(
                  { err: parseErr, data: kValue },
                  '[KV Watcher] Failed to parse state'
                );
              }
            } else if (kOperation === 'DELETE') {
              const parts = entry.key.split('.');
              if (parts.length > 1) {
                const batchId = parts[1];
                broadcastStates.delete(batchId);
                fastify.log.debug(`[KV Watcher] Broadcast ${batchId} deleted`);
              }
            }
          }
        } catch (err: any) {
          if (!isShuttingDown) {
            fastify.log.error({ err }, '[KV Watcher] Error in state watcher');
          }
        }
      })();

      // Initial load of active broadcasts
      await loadActiveBroadcasts(broadcastStates);

      fastify.log.info(
        `[BroadcastConsumer] Started with ${broadcastStates.size} active broadcasts`
      );

      // Main processing loop
      while (!isShuttingDown) {
        try {
          // Check socket status
          const currentSock = getSock();
          fastify.log.info('sock => %s', currentSock);
          if (!currentSock || !currentSock.user) {
            fastify.log.warn('[BroadcastConsumer] Socket lost, auto-pausing broadcasts');

            const pausedCount = await autoPauseBroadcasts(
              fastify.broadcastStateKV,
              fastify.config.AGENT_ID,
              'AUTO_PAUSE_DISCONNECTION'
            );

            if (pausedCount > 0) {
              fastify.log.info(`[BroadcastConsumer] Auto-paused ${pausedCount} broadcasts`);
            }

            await sleep(10000);
            continue;
          }

          // Fetch messages
          const batch = await consumer.fetch();
          fastify.log.info('batch %o', batch);

          for await (const m of batch) {
            if (isShuttingDown) break;
            fastify.log.info('m %o', batch);

            try {
              const data: BroadcastPayload = JSON.parse(sc.decode(m.data));
              const state = broadcastStates.get(data.batchId);
              fastify.log.info(`[BroadcastConsumer] Broadcast state: %o`, state);

              if (!state) {
                // Not tracking this broadcast - could be deleted or not ours
                fastify.log.debug(
                  `[BroadcastConsumer] Unknown broadcast ${data.batchId}, acking message`
                );
                m.ack();
                continue;
              }

              // Process based on status
              switch (state.status) {
                case 'SCHEDULED':
                  // Not ready yet - leave in queue
                  fastify.log.debug(
                    `[BroadcastConsumer] Broadcast ${data.batchId} not ready (${state.status})`
                  );
                  continue;

                case 'PROCESSING':
                  // Good to go - process the message
                  await handleBroadcastMessage(fastify, m, data, state);
                  break;

                case 'PAUSED':
                  // Leave in queue for later
                  fastify.log.debug(`[BroadcastConsumer] Broadcast ${data.batchId} is paused`);
                  continue;

                case 'CANCELLED':
                case 'COMPLETED':
                case 'FAILED':
                  // Terminal states - remove from queue
                  fastify.log.info(
                    `[BroadcastConsumer] Removing message for ${state.status} broadcast ${data.batchId}`
                  );
                  m.ack();
                  continue;
              }
            } catch (err: any) {
              await handleBroadcastError(fastify, m, err);
            }
          }
        } catch (err: any) {
          if (!isShuttingDown) {
            fastify.log.error({ err }, '[BroadcastConsumer] Worker error');
            await sleep(5000);
          }
        }
      }

      fastify.log.info('[BroadcastConsumer] Worker stopped');
    } catch (err: any) {
      fastify.log.error({ err }, '[BroadcastConsumer] Failed to start worker');

      // Restart worker if not shutting down
      if (!isShuttingDown) {
        fastify.log.info('[BroadcastConsumer] Will restart worker in 10 seconds...');
        setTimeout(() => {
          if (!isShuttingDown) {
            startBroadcastWorker().catch((err) => {
              fastify.log.error({ err }, '[BroadcastConsumer] Failed to restart worker');
            });
          }
        }, 10000);
      }
    }
  }

  async function loadActiveBroadcasts(broadcastStates: Map<string, BroadcastState>): Promise<void> {
    broadcastStates.clear();

    const keys = await fastify.broadcastStateKV.keys();

    for await (const key of keys) {
      if (key.startsWith(`${fastify.config.AGENT_ID}.`)) {
        // Changed from _ to .
        const entry = await fastify.broadcastStateKV.get(key);
        if (entry?.value) {
          const state: BroadcastState = JSON.parse(sc.decode(entry.value));

          // Load all non-terminal broadcasts
          if (!['COMPLETED', 'CANCELLED', 'FAILED'].includes(state.status)) {
            broadcastStates.set(state.batchId, state);
          }
        }
      }
    }
  }
}

async function handleBroadcastMessage(
  fastify: FastifyInstance,
  m: any,
  data: BroadcastPayload,
  state: BroadcastState
): Promise<void> {
  const { batchId, taskId, phoneNumber } = data;

  fastify.log.info('[Broadcast] Processing message', {
    seq: m.seq,
    deliveryCount: m.info.deliveryCount,
    taskId,
    batchId,
    phoneNumber,
    status: state.status,
  });

  // Check deduplication
  const dedupKey = `dedup:${fastify.config.AGENT_ID}:${taskId}:${phoneNumber}`;
  const alreadyProcessed = await fastify.redis.get(dedupKey);

  if (alreadyProcessed) {
    fastify.log.info(`[Broadcast] Already processed ${phoneNumber}, skipping`);
    m.ack();
    return;
  }

  // Apply rate limiting if configured
  if (state.rateLimit?.messagesPerSecond) {
    const delayMs = Math.floor(1000 / state.rateLimit.messagesPerSecond);
    await sleep(delayMs);
  } else {
    // Default delay for broadcasts (3-5 seconds)
    const delayMs = Math.floor(Math.random() * 2000) + 3000;
    await sleep(delayMs);
  }

  // Process message
  const result = await processBroadcastMessage(fastify, data);

  if (result.success) {
    // Mark as processed
    await markAsProcessed(fastify, dedupKey, {
      messageId: result.sentMsg?.key?.id,
      seq: m.seq,
      messageType: 'broadcast',
    });

    // Update broadcast progress
    await updateBroadcastProgress(fastify.broadcastStateKV, batchId, fastify.config.AGENT_ID, {
      status: 'COMPLETED',
      phoneNumber,
    });

    // Update task status
    if (taskId && fastify.taskApiService) {
      await updateTaskStatus(fastify, taskId, 'COMPLETED');
    }

    m.ack();
    fastify.log.info(`[Broadcast] Message sent successfully to ${phoneNumber}`);
  } else {
    // Send to DLQ on failure
    try {
      await publishToDLQ(
        fastify,
        m,
        new Error(result.errMessage || 'Failed to send broadcast'),
        'broadcast',
        data
      );

      await updateBroadcastProgress(fastify.broadcastStateKV, batchId, fastify.config.AGENT_ID, {
        status: 'ERROR',
        phoneNumber,
      });

      if (taskId && fastify.taskApiService) {
        await updateTaskStatus(
          fastify,
          taskId,
          'ERROR',
          result.errMessage || 'Failed to send broadcast'
        );
      }

      m.ack();
    } catch (dlqErr: any) {
      fastify.log.error({ err: dlqErr }, '[Broadcast] Failed to publish to DLQ');
      // Don't ack - message stays in queue
    }
  }
}

async function handleBroadcastError(fastify: FastifyInstance, m: any, error: any): Promise<void> {
  fastify.log.error(
    {
      err: error,
      messageData: m.data.toString(),
      deliveryCount: m.info.deliveryCount,
    },
    '[BroadcastConsumer] Error processing message'
  );

  // All errors go to DLQ for broadcasts (no retries)
  try {
    await publishToDLQ(fastify, m, error, 'broadcast');
    m.ack();
    fastify.log.error('[BroadcastConsumer] Error moved to DLQ');
  } catch (dlqErr) {
    fastify.log.error({ err: dlqErr }, '[BroadcastConsumer] Failed to publish to DLQ');
    // Don't ack - keep in queue
  }
}

// Helper functions
async function ensureBroadcastConsumer(
  fastify: FastifyInstance,
  streamName: string,
  consumerName: string,
  subject: string
): Promise<void> {
  try {
    await fastify.jsm.consumers.info(streamName, consumerName);
    fastify.log.info(`[NATS] Broadcast consumer "${consumerName}" already exists`);
  } catch (err: any) {
    if (err.message.includes('consumer not found')) {
      await fastify.jsm.consumers.add(streamName, {
        durable_name: consumerName,
        filter_subject: subject,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_deliver: 1, // No redelivery for broadcasts
        ack_wait: 60 * 1_000_000_000, // 60 seconds
        replay_policy: ReplayPolicy.Instant,
      });
      fastify.log.info(`[NATS] Broadcast consumer "${consumerName}" created`);
    } else {
      throw err;
    }
  }
}

async function processBroadcastMessage(
  fastify: FastifyInstance,
  data: BroadcastPayload
): Promise<{ success: boolean; errMessage?: string; sentMsg?: any }> {
  try {
    const { phoneNumber, message, options, variables, contact, batchId } = data;

    if (!phoneNumber || !message) {
      throw new Error('Missing required fields: phoneNumber or message');
    }

    const sock = getSock();
    if (!sock) {
      throw new Error('Socket is not initialized');
    }

    const jid = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;

    // Apply template variables
    let processedMessage = message;
    if ((variables && Object.keys(variables).length > 0) || contact) {
      const allVariables = {
        ...contact,
        ...variables,
      };
      processedMessage = applyVariables(message, allVariables);
    }

    fastify.log.info(`[Broadcast] Sending to ${phoneNumber} (batch: ${batchId})`);

    const { quoted } = options ?? {};
    const result = await sendMessage(sock, processedMessage, jid, quoted);

    if (!result.success) {
      fastify.log.error(`[Broadcast] Failed to send to ${phoneNumber}: ${result.errMessage}`);
    }

    return result;
  } catch (err: any) {
    return {
      success: false,
      errMessage: err.message,
    };
  }
}

async function markAsProcessed(
  fastify: FastifyInstance,
  dedupKey: string,
  data: any
): Promise<void> {
  await fastify.redis.set(
    dedupKey,
    JSON.stringify({
      processedAt: new Date().toISOString(),
      ...data,
    }),
    'EX',
    604800, // 7 days TTL
    'NX'
  );
}

async function updateTaskStatus(
  fastify: FastifyInstance,
  taskId: string,
  status: 'COMPLETED' | 'ERROR',
  error?: string
): Promise<void> {
  try {
    const updateData: any = {
      status,
      finishedAt: new Date(),
    };

    if (status === 'ERROR' && error) {
      updateData.errorReason = error;
    }

    await fastify.taskApiService.patchTask(taskId, updateData);
    fastify.log.info(`[BroadcastConsumer] Task ${taskId} marked as ${status}`);
  } catch (err: any) {
    fastify.log.error({ err, taskId }, `[BroadcastConsumer] Failed to update task status`);
  }
}

async function publishToDLQ(
  fastify: FastifyInstance,
  m: any,
  error: any,
  messageType: string,
  decodedData?: any
): Promise<void> {
  const dlqMessage = {
    originalSubject: m.subject,
    originalData: sc.decode(m.data),
    messageType,
    error: error.message || 'Unknown error',
    errorStack: error.stack,
    agentId: fastify.config.AGENT_ID,
    companyId: fastify.config.COMPANY_ID,
    taskId: decodedData?.taskId,
    phoneNumber: decodedData?.phoneNumber,
    batchId: decodedData?.batchId,
    failedAt: new Date().toISOString(),
    deliveryCount: m.info.deliveryCount,
    seq: m.seq,
    streamSeq: m.info.streamSequence,
  };

  const dlqSubject = `v1.dlqagent.broadcasts.${fastify.config.AGENT_ID}`;
  await fastify.publishEvent(dlqSubject, dlqMessage);

  fastify.log.info(`[DLQ] Message published to ${dlqSubject}`, {
    taskId: decodedData?.taskId,
    phoneNumber: decodedData?.phoneNumber,
    error: error.message,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
