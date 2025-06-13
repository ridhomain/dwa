import { isJidStatusBroadcast, jidNormalizedUser } from 'baileys';
import { FastifyInstance } from 'fastify';

import { getUser } from '../../utils/sock';
import {
  chunkArray,
  generateDaisiChatId,
  generateDaisiMsgId,
  extractMessageText,
  getConversationTimestamp,
} from '../../utils';

const BATCH_SIZE = 100;
const MAX_RETRIES = 1;
const RETRY_DELAY = 1000;

export const handleMessagesSet = async (
  fastify: FastifyInstance,
  eventPayload: any[],
  progress: number | undefined | null,
  isLatest: boolean | undefined = false
) => {
  // Get history sync configuration
  const historySyncConfig = fastify.getConfig('HISTORY_SYNC');

  const { fullSync, partialSyncDays = 30 } = historySyncConfig;

  fastify.log.info(
    `Processing messages with sync mode: ${fullSync ? 'FULL' : `PARTIAL (${partialSyncDays} days)`}. Progress: ${progress}, IsLatest: ${isLatest}`
  );

  const batchItems = [];
  const subject = `v1.history.messages.${fastify.config.COMPANY_ID}`;

  // Check if this is the first batch of the sync session
  const isFirstBatch = await checkAndMarkFirstBatch(fastify);

  // Calculate cutoff timestamp for partial sync
  let cutoffTimestamp = 0;
  if (!fullSync) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - partialSyncDays);
    cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);

    fastify.log.info(
      `Partial sync cutoff: ${cutoffDate.toISOString()} (timestamp: ${cutoffTimestamp})`
    );
  }

  const totalMessages = eventPayload.length;
  let filteredMessages = 0;
  let processedMessages = 0;

  for (const m of eventPayload) {
    const { key, messageTimestamp, broadcast, message, status } = m;
    const { remoteJid, fromMe, id } = key;

    // Check for basic filtering conditions (but keep messages without content for processing)
    if (!remoteJid || isJidStatusBroadcast(remoteJid) || broadcast) {
      filteredMessages++;
      continue;
    }

    // Filter messages based on sync configuration
    const msgTimestamp = getConversationTimestamp(null, messageTimestamp);
    if (!fullSync && msgTimestamp < cutoffTimestamp) {
      filteredMessages++;
      fastify.log.debug(
        `Skipping old message: ${id} (timestamp: ${msgTimestamp}, cutoff: ${cutoffTimestamp})`
      );
      continue;
    }

    // setup
    const jid = jidNormalizedUser(remoteJid);
    const user = getUser();

    // check current user
    if (!user) {
      filteredMessages++;
      continue;
    }

    const phone = user.phone;
    const from = fromMe ? phone : jid.replace(/@.*$/, '');
    const to = fromMe ? jid.replace(/@.*$/, '') : phone;

    // Handle messages without content - only process if it's a REVOKE (deleted message)
    if (!message) {
      // Only process deleted messages (REVOKE), skip all other messages without content
      if (
        m.messageStubType &&
        (m.messageStubType === 'REVOKE' ||
          m.messageStubType.toString().toLowerCase().includes('revoke'))
      ) {
        const payload = {
          message_id: generateDaisiMsgId(fastify.config.AGENT_ID, id),
          chat_id: generateDaisiChatId(fastify.config.AGENT_ID, jid),
          jid,
          key,
          message_obj: {},
          message_type: 'messageDeleted',
          message_text: 'This message was deleted',
          company_id: fastify.config.COMPANY_ID,
          agent_id: fastify.config.AGENT_ID,
          to_phone: to,
          from_phone: from,
          flow: fromMe ? 'OUT' : 'IN',
          message_timestamp: msgTimestamp,
          status: status ? status.toString() : '0',
          created_at: new Date().toISOString(),
          message_stub_type: m.messageStubType,
          is_deleted: true,
        };

        batchItems.push(payload);
        processedMessages++;
      } else {
        // Skip all other messages without content
        filteredMessages++;
      }
      continue;
    }

    // get message type
    const typeKeys = Object.keys(message).filter((k) => k !== 'messageContextInfo');
    const msgType = typeKeys[0] || 'unknown';
    const messageText = extractMessageText(message);
    fastify.log.debug('[messages.set] message type: %o', msgType);

    // Handle edited messages - check for message.protocolMessage.editedMessage
    if (message.protocolMessage) {
      if (message?.protocolMessage?.editedMessage) {
        const editedMessage = message.protocolMessage?.editedMessage;
        const editedText = extractMessageText(editedMessage?.message || editedMessage);
        const payload = {
          message_id: generateDaisiMsgId(fastify.config.AGENT_ID, id),
          chat_id: generateDaisiChatId(fastify.config.AGENT_ID, jid),
          jid,
          key,
          message_obj: message,
          message_type: Object.keys(message.protocolMessage?.editedMessage).filter(
            (k) => k !== 'messageContextInfo'
          ),
          message_text: editedText,
          company_id: fastify.config.COMPANY_ID,
          agent_id: fastify.config.AGENT_ID,
          to_phone: to,
          from_phone: from,
          flow: fromMe ? 'OUT' : 'IN',
          message_timestamp: msgTimestamp,
          status: status ? status.toString() : '0',
          created_at: new Date().toISOString(),
          edited_message_obj: editedMessage?.message || editedMessage,
        };

        batchItems.push(payload);
        processedMessages++;
      } else {
        filteredMessages++;
      }
      continue;
    }

    // Handle all other message types (normal messages)
    const payload = {
      message_id: generateDaisiMsgId(fastify.config.AGENT_ID, id),
      chat_id: generateDaisiChatId(fastify.config.AGENT_ID, jid),
      jid,
      key,
      message_obj: message,
      message_type: msgType,
      message_text: messageText,
      company_id: fastify.config.COMPANY_ID,
      agent_id: fastify.config.AGENT_ID,
      to_phone: to,
      from_phone: from,
      flow: fromMe ? 'OUT' : 'IN',
      message_timestamp: msgTimestamp,
      status: status ? status.toString() : '0',
      created_at: new Date().toISOString(),
    };

    batchItems.push(payload);
    processedMessages++;
  }

  fastify.log.info(
    `Message processing summary: Total=${totalMessages}, Processed=${processedMessages}, Filtered=${filteredMessages}`
  );

  try {
    if (batchItems.length > 0) {
      const chunks = chunkArray(batchItems, BATCH_SIZE);

      fastify.log.info(
        `Publishing ${chunks.length} batches with ${batchItems.length} total messages`
      );

      for (const [index, chunk] of chunks.entries()) {
        let retries = 0;
        let success = false;

        while (!success && retries < MAX_RETRIES) {
          try {
            // Build the payload
            const publishPayload: any = { messages: chunk };

            // Add sync start signal to the first chunk of the first batch
            if (isFirstBatch && index === 0) {
              publishPayload.is_last_batch = true;
              publishPayload.agent_id = fastify.config.AGENT_ID;
              fastify.log.info('[messages.set] => Adding sync start signal to first batch');
            }

            await fastify.publishEvent(subject, publishPayload);
            success = true;
            fastify.log.info(
              '[messages.set] => published batch: %o/%o. length: %s%s',
              index + 1,
              chunks.length,
              chunk.length,
              isFirstBatch && index === 0 ? ' (with sync start signal)' : ''
            );
          } catch (error) {
            retries++;
            if (retries < MAX_RETRIES) {
              fastify.log.warn(
                `[messages.set] Retry ${retries}/${MAX_RETRIES} for batch ${index + 1}: ${error}`
              );
              await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
            } else {
              fastify.log.error(
                `[messages.set] Failed to publish batch ${index + 1} after ${MAX_RETRIES} retries: ${error}`
              );
              throw error;
            }
          }
        }
      }

      fastify.log.info(
        `Successfully published all ${chunks.length} message batches (${fullSync ? 'full sync' : 'partial sync'})`
      );
    } else {
      fastify.log.warn('[messages.set] => No valid messages to publish after filtering');
    }
  } catch (err: any) {
    fastify.log.error('[messages.set] error: %o', err.message);
  }
};

/**
 * Check if this is the first batch and mark it
 * Returns true if this is the first batch, false otherwise
 */
async function checkAndMarkFirstBatch(fastify: FastifyInstance): Promise<boolean> {
  const syncStartKey = `sync:started:${fastify.config.AGENT_ID}`;
  const syncTTL = 300; // 5 mins TTL

  try {
    // Try to set the key with NX (only if not exists)
    const result = await fastify.redis.set(
      syncStartKey,
      JSON.stringify({
        started_at: new Date().toISOString(),
        agent_id: fastify.config.AGENT_ID,
        company_id: fastify.config.COMPANY_ID,
      }),
      'EX',
      syncTTL,
      'NX'
    );

    // If we successfully set the key, this is the first batch
    const isFirst = result === 'OK';

    if (isFirst) {
      fastify.log.info('[Sync] This is the first batch of the sync session');
    }

    return isFirst;
  } catch (err: any) {
    fastify.log.error('[Sync] Error checking first batch: %o', err.message);
    return false;
  }
}
