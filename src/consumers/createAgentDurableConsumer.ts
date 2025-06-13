import { FastifyInstance } from 'fastify';
import { StringCodec, AckPolicy, DeliverPolicy, ReplayPolicy } from 'nats';
import { getSock } from '../utils/sock';
import { sendMessage } from '../services/sendMessage';
import { applyVariables } from '../utils/index';
import { updateBroadcastProgress } from '../utils/broadcast';

const sc = StringCodec();

// ============= TYPE DEFINITIONS =============
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

interface MailcastPayload {
  companyId: string;
  agentId: string;
  taskId: string;
  phoneNumber: string;
  message: any;
  options?: any;
  variables?: any;
}

interface ProcessResult {
  success: boolean;
  errMessage?: string;
  sentMsg?: any;
}

// ============= MAIN CONSUMER SETUP =============
export async function createAgentDurableConsumer(fastify: FastifyInstance) {
  const streamName = 'agent_durable_stream';
  const consumerName = `agent-consumer-${fastify.config.AGENT_ID}`;

  // Filter subjects for this specific agent
  const broadcastSubject = `v1.broadcasts.${fastify.config.AGENT_ID}`;
  const mailcastSubject = `v1.mailcasts.${fastify.config.AGENT_ID}`;

  let isShuttingDown = false;

  // Note: Stream should be created by WhatsApp Service
  // Only create consumer here
  await ensureConsumerExists(fastify, streamName, consumerName, broadcastSubject, mailcastSubject);

  // Start consuming messages
  startConsumer();

  // Clean shutdown
  fastify.addHook('onClose', async () => {
    try {
      fastify.log.info('[AgentDurableConsumer] Initiating shutdown...');
      isShuttingDown = true;
      fastify.log.info('[AgentDurableConsumer] Shutdown initiated');
    } catch (err: any) {
      fastify.log.error(`[AgentDurableConsumer] Error in shutdown: ${err.message}`);
    }
  });

  // ============= CONSUMER LOOP =============
  async function startConsumer() {
    try {
      const consumer = await fastify.js.consumers.get(streamName, consumerName);
      const messages = await consumer.consume({ max_messages: 1000 });

      fastify.log.info('[AgentDurableConsumer] Started consuming messages');

      for await (const m of messages) {
        if (isShuttingDown) {
          fastify.log.info('[AgentDurableConsumer] Shutdown requested, stopping consumer');
          break;
        }

        try {
          const data = JSON.parse(sc.decode(m.data));
          const messageType = m.subject.includes('broadcasts') ? 'broadcast' : 'mailcast';

          // Route to appropriate handler
          if (messageType === 'broadcast') {
            await handleBroadcastMessage(fastify, m, data as BroadcastPayload);
          } else {
            await handleMailcastMessage(fastify, m, data as MailcastPayload);
          }
        } catch (err: any) {
          const messageType = m.subject.includes('broadcasts') ? 'broadcast' : 'mailcast';

          fastify.log.error(
            {
              err,
              messageType,
              subject: m.subject,
              deliveryCount: m.info.deliveryCount,
              messageData: m.data.toString(),
            },
            '[AgentDurableConsumer] Error processing message'
          );

          // Determine if this is a permanent error
          const isPermanentError =
            err instanceof SyntaxError ||
            err.message.includes('JSON') ||
            err.message.includes('Unexpected token');

          try {
            if (isPermanentError) {
              // JSON parse errors will never succeed
              await publishToDLQ(fastify, m, err, messageType);
              m.ack();
              fastify.log.error('[AgentDurableConsumer] Permanent error, moved to DLQ');
            } else if (messageType === 'broadcast') {
              // Broadcasts: Send to DLQ immediately on any error (no retries)
              await publishToDLQ(fastify, m, err, messageType);
              m.ack();
              fastify.log.error('[AgentDurableConsumer] Broadcast error, moved to DLQ');
            } else if (messageType === 'mailcast' && m.info.deliveryCount >= 3) {
              // Mailcast: After 3 retries, send to DLQ
              await publishToDLQ(fastify, m, err, messageType);
              m.ack();
              fastify.log.error(
                '[AgentDurableConsumer] Mailcast max retries reached, moved to DLQ'
              );
            } else {
              // Let it retry
              fastify.log.warn(
                `[AgentDurableConsumer] Temporary error, will retry ${messageType} (attempt ${m.info.deliveryCount + 1}/3)`
              );
              // Don't ack - will be redelivered
            }
          } catch (dlqErr: any) {
            // If DLQ publish fails, don't ack to prevent message loss
            fastify.log.error(
              { err: dlqErr },
              '[AgentDurableConsumer] Failed to publish to DLQ, message will retry'
            );
            // Don't ack - message will be redelivered
          }
        }
      }

      fastify.log.info('[AgentDurableConsumer] Message iterator ended');
    } catch (err: any) {
      fastify.log.error({ err }, '[AgentDurableConsumer] Consumer error');

      // Restart consumer if not shutting down
      if (!isShuttingDown) {
        fastify.log.info('[AgentDurableConsumer] Will restart consumer in 5 seconds...');
        setTimeout(() => {
          if (!isShuttingDown) {
            startConsumer().catch((err) => {
              fastify.log.error({ err }, '[AgentDurableConsumer] Failed to restart consumer');
            });
          }
        }, 5000);
      }
    }
  }
}

// ============= BROADCAST HANDLER =============
async function handleBroadcastMessage(
  fastify: FastifyInstance,
  m: any,
  data: BroadcastPayload
): Promise<void> {
  const headers = m.headers;
  const batchId = headers?.get('Batch-Id') || data.batchId;
  const agentId = headers?.get('Agent-Id') || data.agentId;

  fastify.log.info('[Broadcast] Processing message', {
    subject: m.subject,
    seq: m.seq,
    deliveryCount: m.info.deliveryCount,
    taskId: data.taskId,
    batchId,
    phoneNumber: data.phoneNumber,
  });

  // Validate agent ID
  if (agentId && agentId !== fastify.config.AGENT_ID) {
    fastify.log.warn(
      `[Broadcast] Message for different agent: ${agentId} (expected: ${fastify.config.AGENT_ID})`
    );
    m.ack();
    return;
  }

  // Check deduplication
  const dedupKey = `dedup:${fastify.config.AGENT_ID}:${data.taskId}:${data.phoneNumber}`;
  const alreadyProcessed = await fastify.redis.get(dedupKey);

  if (alreadyProcessed) {
    fastify.log.info(`[Broadcast] Already processed ${data.phoneNumber}, skipping`);
    m.ack();
    return;
  }

  // Check broadcast state (PAUSED/CANCELLED)
  const shouldContinue = await checkBroadcastState(fastify, batchId);
  if (shouldContinue === 'skip') {
    m.ack();
    return;
  } else if (shouldContinue === 'retry') {
    // Don't ack - will be redelivered
    return;
  }

  // Check socket
  const sock = getSock();
  if (!sock) {
    fastify.log.error('[Broadcast] Socket is not initialized');
    return; // Don't ack - let it be redelivered
  }

  // Process broadcast message
  const result = await processBroadcastMessage(fastify, sock, data);

  // Handle result
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
      phoneNumber: data.phoneNumber,
    });

    // Update task status
    if (data.taskId && fastify.taskApiService) {
      await updateTaskStatus(fastify, data.taskId, 'COMPLETED');
    }

    m.ack();
    fastify.log.info('[Broadcast] Message processed successfully');
  } else {
    // BROADCAST FAILURE - Send to DLQ
    fastify.log.error(
      {
        type: 'broadcast',
        error: result.errMessage,
        phoneNumber: data.phoneNumber,
        batchId,
      },
      '[Broadcast] Failed to send message, moving to DLQ'
    );

    try {
      // Send to DLQ with full context
      await publishToDLQ(
        fastify,
        m,
        new Error(result.errMessage || 'Failed to send broadcast message'),
        'broadcast',
        data
      );

      // Update broadcast progress as error
      await updateBroadcastProgress(fastify.broadcastStateKV, batchId, fastify.config.AGENT_ID, {
        status: 'ERROR',
        phoneNumber: data.phoneNumber,
      });

      // Update task status as error
      if (data.taskId && fastify.taskApiService) {
        await updateTaskStatus(
          fastify,
          data.taskId,
          'ERROR',
          result.errMessage || 'Failed to send broadcast message'
        );
      }

      // Ack only after successfully publishing to DLQ
      m.ack();
      fastify.log.info('[Broadcast] Message moved to DLQ and acknowledged');
    } catch (dlqErr: any) {
      // If DLQ publish fails, don't ack
      fastify.log.error(
        { err: dlqErr },
        '[Broadcast] Failed to publish to DLQ, message will remain unacked for reprocessing'
      );
      // Don't ack - message remains available for reprocessing
    }
  }
}

// ============= MAILCAST HANDLER =============
async function handleMailcastMessage(
  fastify: FastifyInstance,
  m: any,
  data: MailcastPayload
): Promise<void> {
  const agentId = data.agentId;
  const MAX_MAILCAST_RETRIES = 3;

  fastify.log.info('[Mailcast] Processing message', {
    subject: m.subject,
    seq: m.seq,
    deliveryCount: m.info.deliveryCount,
    taskId: data.taskId,
    phoneNumber: data.phoneNumber,
  });

  // Validate agent ID
  if (agentId && agentId !== fastify.config.AGENT_ID) {
    fastify.log.warn(
      `[Mailcast] Message for different agent: ${agentId} (expected: ${fastify.config.AGENT_ID})`
    );
    m.ack();
    return;
  }

  // Check deduplication
  const dedupKey = `dedup:${fastify.config.AGENT_ID}:${data.taskId || 'mailcast'}:${data.phoneNumber}`;
  const alreadyProcessed = await fastify.redis.get(dedupKey);

  if (alreadyProcessed) {
    fastify.log.info(`[Mailcast] Already processed ${data.phoneNumber}, skipping`);
    m.ack();
    return;
  }

  // Check socket
  const sock = getSock();
  if (!sock) {
    fastify.log.error('[Mailcast] Socket is not initialized');
    return; // Don't ack - let it be redelivered
  }

  // Process mailcast message
  const result = await processMailcastMessage(fastify, sock, data);

  // Handle result
  if (result.success) {
    // Mark as processed
    await markAsProcessed(fastify, dedupKey, {
      messageId: result.sentMsg?.key?.id,
      seq: m.seq,
      messageType: 'mailcast',
    });

    // Update task status if applicable
    if (data.taskId && fastify.taskApiService) {
      await updateTaskStatus(fastify, data.taskId, 'COMPLETED');
    }

    m.ack();
    fastify.log.info('[Mailcast] Message processed successfully');
  } else {
    // MAILCAST FAILURE - RETRY UP TO 3 TIMES
    const shouldRetry = m.info.deliveryCount < MAX_MAILCAST_RETRIES;

    fastify.log.error(
      {
        type: 'mailcast',
        error: result.errMessage,
        deliveryCount: m.info.deliveryCount,
        willRetry: shouldRetry,
        maxRetries: MAX_MAILCAST_RETRIES,
      },
      '[Mailcast] Failed to process message'
    );

    if (!shouldRetry) {
      try {
        // Send to DLQ
        await publishToDLQ(
          fastify,
          m,
          new Error(result.errMessage || 'Failed to process mailcast after max retries'),
          'mailcast',
          data
        );

        // Mark as failed in dedup cache
        await markAsFailed(fastify, dedupKey, {
          error: result.errMessage,
          seq: m.seq,
          messageType: 'mailcast',
          retries: m.info.deliveryCount,
        });

        // Update task status as error
        if (data.taskId && fastify.taskApiService) {
          await updateTaskStatus(
            fastify,
            data.taskId,
            'ERROR',
            result.errMessage || 'Failed to process mailcast message after 3 retries'
          );
        }

        // Ack only after DLQ publish succeeds
        m.ack();
        fastify.log.error(`[Mailcast] Max retries (${MAX_MAILCAST_RETRIES}) reached, moved to DLQ`);
      } catch (dlqErr: any) {
        // If DLQ publish fails, don't ack
        fastify.log.error(
          { err: dlqErr },
          '[Mailcast] Failed to publish to DLQ after max retries, message will retry again'
        );
        // Don't ack - message will be redelivered
      }
    } else {
      // Still have retries left, update task status to processing
      if (data.taskId && fastify.taskApiService) {
        await updateTaskStatus(fastify, data.taskId, 'PROCESSING');
      }

      // Don't ack - let NATS redeliver
      fastify.log.info(
        `[Mailcast] Will retry (attempt ${m.info.deliveryCount + 1}/${MAX_MAILCAST_RETRIES})`
      );
    }
  }
}

// ============= BROADCAST SPECIFIC FUNCTIONS =============
async function checkBroadcastState(
  fastify: FastifyInstance,
  batchId: string
): Promise<'continue' | 'skip' | 'retry'> {
  if (!batchId) return 'continue';

  const stateKey = `${fastify.config.AGENT_ID}_${batchId}`;
  const kvEntry = await fastify.broadcastStateKV.get(stateKey);

  if (!kvEntry) {
    fastify.log.warn(`[Broadcast] No state found for batch ${batchId}, processing anyway`);
    return 'continue';
  }

  const state = JSON.parse(sc.decode(kvEntry.value));

  if (state.status === 'CANCELLED') {
    fastify.log.info(`[Broadcast] Skipping cancelled broadcast ${batchId}`);
    return 'skip';
  }

  if (state.status === 'PAUSED') {
    fastify.log.info(`[Broadcast] Broadcast ${batchId} is paused, will retry later`);
    return 'retry';
  }

  return 'continue';
}

async function processBroadcastMessage(
  fastify: FastifyInstance,
  sock: any,
  data: BroadcastPayload
): Promise<ProcessResult> {
  try {
    const { phoneNumber, message, options, variables, contact, batchId } = data;

    if (!phoneNumber || !message) {
      throw new Error('Missing required fields: phoneNumber or message');
    }

    // Add randomized delay for broadcasts (3-5 seconds)
    const delayMs = Math.floor(Math.random() * 2000) + 3000; // 3-5 seconds
    fastify.log.info(`[Broadcast] Waiting ${delayMs}ms before sending to ${phoneNumber}`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    const jid = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;

    // Apply template variables for personalization
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

// ============= MAILCAST SPECIFIC FUNCTIONS =============
async function processMailcastMessage(
  fastify: FastifyInstance,
  sock: any,
  data: MailcastPayload
): Promise<ProcessResult> {
  try {
    const { phoneNumber, message, options, variables } = data;

    if (!phoneNumber || !message) {
      throw new Error('Missing required fields: phoneNumber or message');
    }

    const jid = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;

    // Apply variables if present (no contact personalization for mailcast)
    let processedMessage = message;
    if (variables && Object.keys(variables).length > 0) {
      processedMessage = applyVariables(message, variables);
    }

    fastify.log.info(`[Mailcast] Sending message to ${phoneNumber}`);

    const { quoted } = options ?? {};
    const result = await sendMessage(sock, processedMessage, jid, quoted);

    if (!result.success) {
      fastify.log.error(`[Mailcast] Failed to send to ${phoneNumber}: ${result.errMessage}`);
    }

    return result;
  } catch (err: any) {
    return {
      success: false,
      errMessage: err.message,
    };
  }
}

// ============= DLQ FUNCTIONS =============
interface DLQMessage {
  originalSubject: string;
  originalData: string;
  messageType: 'broadcast' | 'mailcast';
  error: string;
  errorStack?: string;
  agentId: string;
  companyId: string;
  taskId?: string;
  phoneNumber?: string;
  batchId?: string;
  failedAt: string;
  deliveryCount: number;
  seq: number;
  streamSeq: number;
}

async function publishToDLQ(
  fastify: FastifyInstance,
  m: any,
  error: any,
  messageType: 'broadcast' | 'mailcast',
  decodedData?: any
): Promise<void> {
  try {
    // Try to extract key fields from the message
    let taskId: string | undefined;
    let phoneNumber: string | undefined;
    let batchId: string | undefined;

    if (decodedData) {
      taskId = decodedData.taskId;
      phoneNumber = decodedData.phoneNumber;
      batchId = decodedData.batchId;
    } else {
      // Try to parse even if main processing failed
      try {
        const parsed = JSON.parse(sc.decode(m.data));
        taskId = parsed.taskId;
        phoneNumber = parsed.phoneNumber;
        batchId = parsed.batchId;
      } catch (err: any) {
        fastify.log.error(err.message);
      }
    }

    const dlqMessage: DLQMessage = {
      originalSubject: m.subject,
      originalData: sc.decode(m.data), // Store as string for readability
      messageType,
      error: error.message || 'Unknown error',
      errorStack: error.stack,
      agentId: fastify.config.AGENT_ID,
      companyId: fastify.config.COMPANY_ID,
      taskId,
      phoneNumber,
      batchId,
      failedAt: new Date().toISOString(),
      deliveryCount: m.info.deliveryCount,
      seq: m.seq,
      streamSeq: m.info.streamSequence,
    };

    // Publish to agent-specific DLQ subject
    const dlqSubject = `v1.dlqagent.${fastify.config.AGENT_ID}`;

    await fastify.publishEvent(dlqSubject, dlqMessage);

    fastify.log.info(`[DLQ] Message published to ${dlqSubject}`, {
      taskId,
      phoneNumber,
      messageType,
      originalSubject: m.subject,
      error: error.message,
    });
  } catch (dlqErr: any) {
    fastify.log.error(
      {
        err: dlqErr,
        originalError: error.message,
      },
      '[DLQ] Failed to publish message to DLQ'
    );
    // Throw to prevent acking if DLQ publish fails
    throw new Error(`DLQ publish failed: ${dlqErr.message}`);
  }
}

// ============= SHARED UTILITY FUNCTIONS =============
async function ensureConsumerExists(
  fastify: FastifyInstance,
  streamName: string,
  consumerName: string,
  broadcastSubject: string,
  mailcastSubject: string
): Promise<void> {
  try {
    await fastify.jsm.consumers.info(streamName, consumerName);
    fastify.log.info(`[NATS] Consumer "${consumerName}" already exists`);
  } catch (err: any) {
    if (err.message.includes('consumer not found')) {
      await fastify.jsm.consumers.add(streamName, {
        durable_name: consumerName,
        filter_subjects: [broadcastSubject, mailcastSubject],
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_deliver: 5, // This applies to mailcast retries
        ack_wait: 30 * 1_000_000_000, // 30 seconds
        replay_policy: ReplayPolicy.Instant,
      });
      fastify.log.info(
        `[NATS] Consumer "${consumerName}" created with filters: ${broadcastSubject}, ${mailcastSubject}`
      );
    } else {
      throw err;
    }
  }
}

async function markAsProcessed(
  fastify: FastifyInstance,
  dedupKey: string,
  data: any
): Promise<void> {
  const dedupResult = await fastify.redis.set(
    dedupKey,
    JSON.stringify({
      processedAt: new Date().toISOString(),
      ...data,
    }),
    'EX',
    604800, // 7 days TTL
    'NX' // Only set if not exists
  );

  if (dedupResult !== 'OK') {
    fastify.log.warn(`[AgentDurableConsumer] Concurrent processing detected for ${dedupKey}`);
  }
}

async function markAsFailed(fastify: FastifyInstance, dedupKey: string, data: any): Promise<void> {
  await fastify.redis.set(
    dedupKey,
    JSON.stringify({
      processedAt: new Date().toISOString(),
      failed: true,
      ...data,
    }),
    'EX',
    604800 // 7 days TTL
  );
}

async function updateTaskStatus(
  fastify: FastifyInstance,
  taskId: string,
  status: 'COMPLETED' | 'PROCESSING' | 'ERROR',
  error?: string
): Promise<void> {
  try {
    const updateData: any = {
      status,
      finishedAt: new Date(),
    };

    // Add error reason if status is ERROR
    if (status === 'ERROR' && error) {
      updateData.errorReason = error;
    }

    await fastify.taskApiService.patchTask(taskId, updateData);
    fastify.log.info(`[AgentDurableConsumer] Task ${taskId} marked as ${status}`);
  } catch (err: any) {
    fastify.log.error(
      { err, taskId },
      `[AgentDurableConsumer] Failed to update task status to ${status}`
    );
  }
}
