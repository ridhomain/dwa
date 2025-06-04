// src/events/history/handleMessagesSet.ts
import { isJidStatusBroadcast, jidNormalizedUser } from 'baileys';
import { FastifyInstance } from 'fastify';

// import { ALLOWED_MSG_TYPES } from '../../constants';
import { getUser } from '../../utils/sock';
import {
  chunkArray,
  generateDaisiChatId,
  generateDaisiMsgId,
  extractMessageText,
} from '../../utils';

const BATCH_SIZE = 100;
const MAX_RETRIES = 1;
const RETRY_DELAY = 1000;

export const handleMessagesSet = async (fastify: FastifyInstance, eventPayload: any[]) => {
  // Get history sync configuration
  const historySyncConfig = fastify.getConfig('HISTORY_SYNC');

  const { fullSync, partialSyncDays = 30 } = historySyncConfig;

  fastify.log.info(
    `Processing messages with sync mode: ${fullSync ? 'FULL' : `PARTIAL (${partialSyncDays} days)`}`
  );

  const batchItems = [];
  const subject = `v1.history.messages.${fastify.config.COMPANY_ID}`;

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
    // fastify.log.info('[messages.set] message: %o', m);
    const { key, messageTimestamp, broadcast, message, status } = m;
    const { remoteJid, fromMe, id } = key;

    if (!remoteJid || isJidStatusBroadcast(remoteJid) || broadcast || !message) {
      filteredMessages++;
      continue;
    }

    // Filter messages based on sync configuration
    const msgTimestamp = Number(messageTimestamp);
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

    // get message type
    const typeKeys = Object.keys(message).filter((k) => k !== 'messageContextInfo');
    const msgType = typeKeys[0] || 'unknown';
    const messageText = extractMessageText(message);
    fastify.log.debug('[messages.set] message type: %o', msgType);

    // filter message
    // if (!ALLOWED_MSG_TYPES.includes(msgType)) continue;

    // bypass message protocol
    if (msgType === 'protocolMessage') {
      filteredMessages++;
      continue;
    }

    // transform message
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
            await fastify.publishEvent(subject, { messages: chunk });
            success = true;
            fastify.log.info(
              '[messages.set] => published batch: %o/%o. length: %s',
              index + 1,
              chunks.length,
              chunk.length
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
              throw error; // Re-throw to handle at higher level if needed
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

    // Optionally, you could implement a fallback or notification here
    // For example, publishing an error event or setting a flag for retry later
  }
};
