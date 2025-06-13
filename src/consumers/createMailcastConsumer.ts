// src/consumers/createMailcastConsumer.ts
import { FastifyInstance } from 'fastify';
import { StringCodec, AckPolicy, DeliverPolicy, ReplayPolicy } from 'nats';
import { getSock } from '../utils/sock';
import { sendMessage } from '../services/sendMessage';
import { applyVariables } from '../utils/index';

const sc = StringCodec();

interface MailcastPayload {
  companyId: string;
  agentId: string;
  taskId: string;
  phoneNumber: string;
  message: any;
  options?: any;
  variables?: any;
}

const MAX_MAILCAST_RETRIES = 3;

export async function createMailcastConsumer(fastify: FastifyInstance) {
  const streamName = 'agent_durable_stream';
  const consumerName = `mailcast-consumer-${fastify.config.AGENT_ID}`;
  const mailcastSubject = `v1.mailcasts.${fastify.config.AGENT_ID}`;

  let isShuttingDown = false;

  // Ensure consumer exists for mailcasts only
  await ensureMailcastConsumer(fastify, streamName, consumerName, mailcastSubject);

  // Start the streaming consumer (mailcasts don't need fetch pattern)
  startMailcastConsumer();

  // Shutdown hook
  fastify.addHook('onClose', async () => {
    fastify.log.info('[MailcastConsumer] Initiating shutdown...');
    isShuttingDown = true;
  });

  async function startMailcastConsumer() {
    try {
      const consumer = await fastify.js.consumers.get(streamName, consumerName);
      const messages = await consumer.consume({ max_messages: 1000 });

      fastify.log.info('[MailcastConsumer] Started consuming messages');

      for await (const m of messages) {
        if (isShuttingDown) {
          fastify.log.info('[MailcastConsumer] Shutdown requested, stopping consumer');
          break;
        }

        try {
          const data: MailcastPayload = JSON.parse(sc.decode(m.data));
          await handleMailcastMessage(fastify, m, data);
        } catch (err: any) {
          await handleMailcastError(fastify, m, err);
        }
      }

      fastify.log.info('[MailcastConsumer] Message iterator ended');
    } catch (err: any) {
      fastify.log.error({ err }, '[MailcastConsumer] Consumer error');

      // Restart consumer if not shutting down
      if (!isShuttingDown) {
        fastify.log.info('[MailcastConsumer] Will restart consumer in 5 seconds...');
        setTimeout(() => {
          if (!isShuttingDown) {
            startMailcastConsumer().catch((err) => {
              fastify.log.error({ err }, '[MailcastConsumer] Failed to restart consumer');
            });
          }
        }, 5000);
      }
    }
  }
}

async function handleMailcastMessage(
  fastify: FastifyInstance,
  m: any,
  data: MailcastPayload
): Promise<void> {
  const { agentId, taskId, phoneNumber } = data;

  fastify.log.info('[Mailcast] Processing message', {
    seq: m.seq,
    deliveryCount: m.info.deliveryCount,
    taskId,
    phoneNumber,
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
  const dedupKey = `dedup:${fastify.config.AGENT_ID}:mailcast:${taskId}:${phoneNumber}`;
  const alreadyProcessed = await fastify.redis.get(dedupKey);

  if (alreadyProcessed) {
    fastify.log.info(`[Mailcast] Already processed ${phoneNumber} for task ${taskId}, skipping`);
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

  if (result.success) {
    // Mark as processed
    await markAsProcessed(fastify, dedupKey, {
      messageId: result.sentMsg?.key?.id,
      seq: m.seq,
      messageType: 'mailcast',
      taskId,
    });

    // Update task status
    if (taskId && fastify.taskApiService) {
      await updateTaskStatus(fastify, taskId, 'COMPLETED', undefined, {
        messageId: result.sentMsg?.key?.id,
        sentAt: new Date().toISOString(),
        type: 'mailcast',
      });
    }

    m.ack();
    fastify.log.info('[Mailcast] Message sent successfully');
  } else {
    // Check retry count
    const shouldRetry = m.info.deliveryCount < MAX_MAILCAST_RETRIES;

    fastify.log.error(
      {
        error: result.errMessage,
        deliveryCount: m.info.deliveryCount,
        willRetry: shouldRetry,
        maxRetries: MAX_MAILCAST_RETRIES,
      },
      '[Mailcast] Failed to process message'
    );

    if (!shouldRetry) {
      // Max retries reached, send to DLQ
      try {
        await publishToDLQ(
          fastify,
          m,
          new Error(result.errMessage || 'Failed to process mailcast after max retries'),
          'mailcast',
          data
        );

        await markAsFailed(fastify, dedupKey, {
          error: result.errMessage,
          seq: m.seq,
          messageType: 'mailcast',
          retries: m.info.deliveryCount,
          taskId,
        });

        if (taskId && fastify.taskApiService) {
          await updateTaskStatus(
            fastify,
            taskId,
            'ERROR',
            result.errMessage || 'Failed to process mailcast after 3 retries'
          );
        }

        m.ack();
        fastify.log.error(`[Mailcast] Max retries reached, moved to DLQ`);
      } catch (dlqErr: any) {
        fastify.log.error({ err: dlqErr }, '[Mailcast] Failed to publish to DLQ');
        // Don't ack - message will be redelivered
      }
    } else {
      // Still have retries left
      if (taskId && fastify.taskApiService) {
        await updateTaskStatus(fastify, taskId, 'PROCESSING', undefined, {
          retryCount: m.info.deliveryCount,
        });
      }

      // Don't ack - let NATS redeliver
      fastify.log.info(
        `[Mailcast] Will retry (attempt ${m.info.deliveryCount + 1}/${MAX_MAILCAST_RETRIES})`
      );
    }
  }
}

async function handleMailcastError(fastify: FastifyInstance, m: any, error: any): Promise<void> {
  fastify.log.error(
    {
      err: error,
      messageData: m.data.toString(),
      deliveryCount: m.info.deliveryCount,
    },
    '[MailcastConsumer] Error processing message'
  );

  // Permanent errors go straight to DLQ
  const isPermanentError =
    error instanceof SyntaxError ||
    error.message.includes('JSON') ||
    error.message.includes('Unexpected token');

  if (isPermanentError) {
    try {
      await publishToDLQ(fastify, m, error, 'mailcast');
      m.ack();
      fastify.log.error('[MailcastConsumer] Permanent error, moved to DLQ');
    } catch (dlqErr) {
      fastify.log.error({ err: dlqErr }, '[MailcastConsumer] Failed to publish to DLQ');
      // Don't ack - keep in queue
    }
  } else if (m.info.deliveryCount >= MAX_MAILCAST_RETRIES) {
    // Max retries for other errors
    try {
      await publishToDLQ(fastify, m, error, 'mailcast');
      m.ack();
      fastify.log.error('[MailcastConsumer] Max retries reached, moved to DLQ');
    } catch (dlqErr) {
      fastify.log.error({ err: dlqErr }, '[MailcastConsumer] Failed to publish to DLQ');
      // Don't ack - keep in queue
    }
  } else {
    // Let it retry
    fastify.log.warn(
      `[MailcastConsumer] Temporary error, will retry (attempt ${m.info.deliveryCount + 1}/${MAX_MAILCAST_RETRIES})`
    );
    // Don't ack - will be redelivered
  }
}

// Helper functions
async function ensureMailcastConsumer(
  fastify: FastifyInstance,
  streamName: string,
  consumerName: string,
  subject: string
): Promise<void> {
  try {
    await fastify.jsm.consumers.info(streamName, consumerName);
    fastify.log.info(`[NATS] Mailcast consumer "${consumerName}" already exists`);
  } catch (err: any) {
    if (err.message.includes('consumer not found')) {
      await fastify.jsm.consumers.add(streamName, {
        durable_name: consumerName,
        filter_subject: subject,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_deliver: 5, // Allow retries for mailcast
        ack_wait: 30 * 1_000_000_000, // 30 seconds
        replay_policy: ReplayPolicy.Instant,
      });
      fastify.log.info(`[NATS] Mailcast consumer "${consumerName}" created`);
    } else {
      throw err;
    }
  }
}

async function processMailcastMessage(
  fastify: FastifyInstance,
  sock: any,
  data: MailcastPayload
): Promise<{ success: boolean; errMessage?: string; sentMsg?: any }> {
  try {
    const { phoneNumber, message, options, variables } = data;

    if (!phoneNumber || !message) {
      throw new Error('Missing required fields: phoneNumber or message');
    }

    const jid = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;

    // Apply variables if present
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

// Shared utility functions
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
  error?: string,
  result?: any
): Promise<void> {
  try {
    const updateData: any = {
      status,
    };

    // Only add finishedAt for terminal states (COMPLETED or ERROR)
    if (status === 'COMPLETED' || status === 'ERROR') {
      updateData.finishedAt = new Date().toISOString();
    }

    if (status === 'ERROR' && error) {
      updateData.error = error;
    }

    if (status === 'COMPLETED' && result) {
      updateData.result = result;
    }

    if (status === 'PROCESSING' && result?.retryCount) {
      updateData.retryCount = result.retryCount;
    }

    await fastify.taskApiService.patchTask(taskId, updateData);
    fastify.log.info(`[MailcastConsumer] Task ${taskId} marked as ${status}`);
  } catch (err: any) {
    fastify.log.error({ err, taskId }, `[MailcastConsumer] Failed to update task status`);
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
    failedAt: new Date().toISOString(),
    deliveryCount: m.info.deliveryCount,
    seq: m.seq,
    streamSeq: m.info.streamSequence,
  };

  const dlqSubject = `v1.dlqtasks.mailcasts.${fastify.config.AGENT_ID}`;
  await fastify.publishEvent(dlqSubject, dlqMessage);

  fastify.log.info(`[DLQ] Message published to ${dlqSubject}`, {
    taskId: decodedData?.taskId,
    phoneNumber: decodedData?.phoneNumber,
    error: error.message,
  });
}
