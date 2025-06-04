import { FastifyInstance } from 'fastify';
import {
  StringCodec,
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  DiscardPolicy,
  ReplayPolicy,
} from 'nats';
import { getSock } from '../utils/sock';
import { sendMessage } from '../services/sendMessage';
import { applyVariables } from '../utils/index';
import { updateBroadcastProgress } from '../utils/broadcast';

const sc = StringCodec();

interface BroadcastPayload {
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
  taskId?: string;
  agentId: string;
  companyId: string;
  phoneNumber: string;
  message: any;
  options?: any;
  variables?: any;
}

export async function createAgentDurableConsumer(fastify: FastifyInstance) {
  const streamName = 'agent_durable_stream';
  const consumerName = `agent-consumer-${fastify.config.AGENT_ID}`;

  // Filter subjects for this specific agent
  const broadcastSubject = `v1.broadcasts.${fastify.config.AGENT_ID}`;
  const mailcastSubject = `v1.mailcasts.${fastify.config.AGENT_ID}`;

  // Store for cleanup
  let isShuttingDown = false;

  // Ensure stream exists with both subject patterns
  try {
    await fastify.jsm.streams.info(streamName);
    fastify.log.info(`[NATS] Stream "${streamName}" already exists`);
  } catch (err: any) {
    if (err.message.includes('stream not found')) {
      await fastify.jsm.streams.add({
        name: streamName,
        subjects: ['v1.broadcasts.*', 'v1.mailcasts.*'],
        retention: RetentionPolicy.Limits,
        max_age: 3 * 24 * 60 * 60 * 1_000_000_000, // 3 days
        max_bytes: 1024 * 1024 * 1024, // 1GB
        storage: StorageType.File,
        discard: DiscardPolicy.Old,
      });
      fastify.log.info(
        `[NATS] Stream "${streamName}" created with subjects: v1.broadcasts.*, v1.mailcasts.*`
      );
    } else {
      throw err;
    }
  }

  // Ensure consumer exists with filters for both subjects
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
        max_deliver: 5,
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

  // Function to process messages
  async function startConsumer() {
    try {
      // Get consumer
      const consumer = await fastify.js.consumers.get(streamName, consumerName);

      // Get messages iterator
      const messages = await consumer.consume({ max_messages: 1000 });

      fastify.log.info('[AgentDurableConsumer] Started consuming messages');

      for await (const m of messages) {
        // Check if we're shutting down
        if (isShuttingDown) {
          fastify.log.info('[AgentDurableConsumer] Shutdown requested, stopping consumer');
          break;
        }

        try {
          const data = JSON.parse(sc.decode(m.data));
          const messageType = m.subject.includes('broadcasts') ? 'broadcast' : 'mailcast';

          // Extract headers if present
          const headers = m.headers;
          const batchId = headers?.get('Batch-Id') || data.batchId;
          const agentId = headers?.get('Agent-Id') || data.agentId;
          // const companyId = headers?.get('Company') || data.companyId;

          // Check deduplication using Redis (keep Redis for dedup as it's faster)
          const dedupKey = `dedup:${fastify.config.AGENT_ID}:${batchId || 'mailcast'}:${data.phoneNumber}`;
          const alreadyProcessed = await fastify.redis.get(dedupKey);

          if (alreadyProcessed) {
            fastify.log.info(
              `[AgentDurableConsumer] Already processed ${data.phoneNumber} for ${messageType} ${batchId || ''}, skipping`
            );
            m.ack();
            continue;
          }

          fastify.log.info(`[AgentDurableConsumer] Processing ${messageType} message: %o`, {
            subject: m.subject,
            seq: m.seq,
            redeliveryCount: m.info.redeliveryCount,
            batchId,
            agentId,
            phoneNumber: data.phoneNumber,
          });

          // Validate agent ID matches (either from header or data)
          const targetAgentId = agentId || data.agentId;
          if (targetAgentId && targetAgentId !== fastify.config.AGENT_ID) {
            fastify.log.warn(
              `[AgentDurableConsumer] Message for different agent: ${targetAgentId} (expected: ${fastify.config.AGENT_ID})`
            );
            // Acknowledge to prevent redelivery
            m.ack();
            continue;
          }

          const sock = getSock();
          if (!sock) {
            fastify.log.error('[AgentDurableConsumer] Socket is not initialized');
            // Don't ack - let it be redelivered
            continue;
          }

          // Check broadcast status from NATS KV (instead of Redis)
          if (messageType === 'broadcast' && batchId) {
            const stateKey = `${fastify.config.AGENT_ID}_${batchId}`;
            const kvEntry = await fastify.broadcastStateKV.get(stateKey);

            if (kvEntry) {
              const state = JSON.parse(sc.decode(kvEntry.value));

              if (state.status === 'CANCELLED') {
                fastify.log.info(`[Broadcast] Skipping cancelled broadcast ${batchId}`);
                m.ack();
                continue;
              }

              if (state.status === 'PAUSED') {
                fastify.log.info(`[Broadcast] Broadcast ${batchId} is paused, will retry later`);
                // Don't ack - message will be redelivered after ack_wait (30s)
                continue;
              }
            } else {
              // No state found, might be old message or state expired
              fastify.log.warn(
                `[Broadcast] No state found for batch ${batchId}, processing anyway`
              );
            }
          }

          // Process message
          let success = false;
          let errMessage: string | undefined;
          let sentMsg: any;

          if (messageType === 'broadcast') {
            const result = await processBroadcastMessage(fastify, sock, data as BroadcastPayload);
            success = result.success;
            errMessage = result.errMessage;
            sentMsg = result.sentMsg;
          } else {
            const result = await processMailcastMessage(fastify, sock, data as MailcastPayload);
            success = result.success;
            errMessage = result.errMessage;
            sentMsg = result.sentMsg;
          }

          if (success) {
            // Mark as processed in Redis for deduplication
            const dedupResult = await fastify.redis.set(
              dedupKey,
              JSON.stringify({
                processedAt: new Date().toISOString(),
                messageId: sentMsg?.key?.id,
                seq: m.seq,
                messageType,
              }),
              'EX',
              604800, // 7 days TTL
              'NX' // Only set if not exists
            );

            if (dedupResult !== 'OK') {
              fastify.log.warn(
                `[AgentDurableConsumer] Concurrent processing detected for ${dedupKey}`
              );
            }

            // Acknowledge the message
            m.ack();

            fastify.log.info(`[AgentDurableConsumer] ${messageType} processed successfully`);

            // Update broadcast progress if it's a broadcast message
            if (messageType === 'broadcast' && batchId) {
              try {
                await updateBroadcastProgress(
                  fastify.broadcastStateKV,
                  batchId,
                  fastify.config.AGENT_ID,
                  {
                    status: 'COMPLETED',
                    phoneNumber: data.phoneNumber,
                  }
                );
              } catch (err) {
                fastify.log.error(
                  { err, batchId },
                  '[AgentDurableConsumer] Failed to update broadcast progress'
                );
                // Don't fail the message processing for progress update failure
              }
            }

            // Update task status if taskId is provided
            if (data.taskId && fastify.taskApiService) {
              try {
                await fastify.taskApiService.patchTask(data.taskId, {
                  status: 'COMPLETED',
                  finishedAt: new Date().toISOString(),
                  result: {
                    messageId: sentMsg?.key?.id,
                    sentAt: new Date().toISOString(),
                    type: messageType,
                  },
                });
                fastify.log.info(`[AgentDurableConsumer] Task ${data.taskId} marked as COMPLETED`);
              } catch (patchErr: any) {
                fastify.log.error(
                  {
                    err: patchErr,
                    taskId: data.taskId,
                  },
                  '[AgentDurableConsumer] Failed to update task status'
                );
              }
            }
          } else {
            const shouldRetry = m.info.redeliveryCount < 4;

            fastify.log.error(
              {
                type: messageType,
                error: errMessage,
                redeliveryCount: m.info.redeliveryCount,
                willRetry: shouldRetry,
              },
              '[AgentDurableConsumer] Failed to process message'
            );

            // Update broadcast progress for failures (only on final failure)
            if (messageType === 'broadcast' && batchId && !shouldRetry) {
              try {
                await updateBroadcastProgress(
                  fastify.broadcastStateKV,
                  batchId,
                  fastify.config.AGENT_ID,
                  {
                    status: 'ERROR',
                    phoneNumber: data.phoneNumber,
                  }
                );
              } catch (err) {
                fastify.log.error(
                  { err, batchId },
                  '[AgentDurableConsumer] Failed to update broadcast progress for error'
                );
              }
            }

            // Update task status if taskId is provided
            if (data.taskId && fastify.taskApiService) {
              try {
                await fastify.taskApiService.patchTask(data.taskId, {
                  status: shouldRetry ? 'PROCESSING' : 'ERROR',
                  finishedAt: shouldRetry ? undefined : new Date().toISOString(),
                  error: errMessage || 'Failed to process message',
                  retryCount: m.info.redeliveryCount,
                });
              } catch (patchErr: any) {
                fastify.log.error(
                  {
                    err: patchErr,
                    taskId: data.taskId,
                  },
                  '[AgentDurableConsumer] Failed to update task status to ERROR'
                );
              }
            }

            if (!shouldRetry) {
              // Max retries reached, acknowledge to prevent infinite loop
              // Also mark as failed in dedup to prevent future attempts
              await fastify.redis.set(
                dedupKey,
                JSON.stringify({
                  processedAt: new Date().toISOString(),
                  failed: true,
                  error: errMessage,
                  seq: m.seq,
                  messageType,
                  retries: m.info.redeliveryCount,
                }),
                'EX',
                604800 // 7 days TTL
              );

              m.ack();
              fastify.log.error(
                `[AgentDurableConsumer] Max retries reached for ${messageType} message`
              );
            }
            // Otherwise, don't ack - let NATS redeliver
          }
        } catch (err: any) {
          fastify.log.error(
            {
              err,
              messageData: m.data.toString(),
            },
            '[AgentDurableConsumer] Error processing message'
          );

          // For parse errors or unexpected errors, check retry count
          if (m.info.redeliveryCount >= 4) {
            m.ack(); // Prevent infinite retries
            fastify.log.error('[AgentDurableConsumer] Max retries reached, discarding message');
          }
        }
      }

      fastify.log.info('[AgentDurableConsumer] Message iterator ended');
    } catch (err: any) {
      fastify.log.error({ err }, '[AgentDurableConsumer] Consumer error');

      // If not shutting down and error occurred, try to restart
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

  // Start the consumer
  startConsumer().catch((err) => {
    fastify.log.error({ err }, '[AgentDurableConsumer] Failed to start consumer');
  });

  // Clean shutdown
  fastify.addHook('onClose', async () => {
    try {
      fastify.log.info('[AgentDurableConsumer] Initiating shutdown...');
      isShuttingDown = true;
      // The consumer will exit on next iteration
      fastify.log.info('[AgentDurableConsumer] Shutdown initiated');
    } catch (err: any) {
      fastify.log.error(`[AgentDurableConsumer] Error in shutdown: ${err.message}`);
    }
  });
}

// Process mailcast message (single recipient)
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

    if (result.success) {
      fastify.log.info(`[Mailcast] Message sent successfully to ${phoneNumber}`);
    }

    return result;
  } catch (err: any) {
    return {
      success: false,
      errMessage: err.message,
    };
  }
}

// Process broadcast message (single recipient from a broadcast batch)
async function processBroadcastMessage(
  fastify: FastifyInstance,
  sock: any,
  data: BroadcastPayload
): Promise<{ success: boolean; errMessage?: string; sentMsg?: any }> {
  try {
    const { phoneNumber, message, options, variables, contact, batchId } = data;

    if (!phoneNumber || !message) {
      throw new Error('Missing required fields: phoneNumber or message');
    }

    // For broadcast messages, we're processing a single recipient at a time
    const jid = phoneNumber.includes('@') ? phoneNumber : `${phoneNumber}@s.whatsapp.net`;

    // Apply template variables if present
    let processedMessage = message;
    if ((variables && Object.keys(variables).length > 0) || contact) {
      // Merge contact data with variables for personalization
      const allVariables = {
        ...contact,
        ...variables,
      };
      processedMessage = applyVariables(message, allVariables);
    }

    fastify.log.info(`[Broadcast] Sending to ${phoneNumber} (batch: ${batchId})`);

    const { quoted } = options ?? {};

    const result = await sendMessage(sock, processedMessage, jid, quoted);

    if (result.success) {
      fastify.log.info(`[Broadcast] Message sent successfully to ${phoneNumber}`);
    } else {
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
