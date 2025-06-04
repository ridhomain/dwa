import { isJidStatusBroadcast, jidNormalizedUser } from 'baileys';
import { FastifyInstance } from 'fastify';
import { generateDaisiChatId, generateDaisiMsgId } from '../../utils';

// for debounce unread chat
const REDIS_TTL_MS = 2000;

export const handleMessagesUpdate = async (fastify: FastifyInstance, updates: any[]) => {
  for (const u of updates) {
    const { key, update } = u;
    const { remoteJid, id, fromMe } = key;
    const { status, message } = update;
    const jid = jidNormalizedUser(remoteJid);

    if (isJidStatusBroadcast(remoteJid) || jid === '') {
      return;
    }

    // Processed Updates:
    // 1. Status Updates
    // 2. Edited Message
    // 3. Deleted Message
    if (status || message) {
      if (status) {
        try {
          const subject = `v1.messages.update.${fastify.config.COMPANY_ID}`;

          const payload = {
            message_id: generateDaisiMsgId(fastify.config.AGENT_ID, id),
            company_id: fastify.config.COMPANY_ID,
            status: status.toString(),
          };

          await fastify.publishEvent(subject, payload);
        } catch (err: any) {
          fastify.log.error('[messages.update] error: %o', err.message);
        }

        if (status === 4 && !fromMe) {
          const debounceKey = `debounce:chat-unread:${fastify.config.AGENT_ID}:${jid}`;

          try {
            const result = await fastify.redis.set(debounceKey, '1', 'PX', REDIS_TTL_MS, 'NX');
            if (result === 'OK') {
              const chatId = generateDaisiChatId(fastify.config.AGENT_ID, jid);

              const chatPayload = {
                chat_id: chatId,
                company_id: fastify.config.COMPANY_ID,
                agent_id: fastify.config.AGENT_ID,
                // conversation_timestamp: 1, // to ensure that it wont get updated
                unread_count: 0,
              };
              await fastify.publishEvent(
                `v1.chats.update.${fastify.config.COMPANY_ID}`,
                chatPayload
              );
              fastify.log.info(
                `[chat.update] Synced unread_count=0 via Redis debounce for chat: ${jid}`
              );
            }
          } catch (err: any) {
            fastify.log.error('[chat.update redis debounce] error: %o', err.message);
          }
        }
      } else if (message?.editedMessage) {
        // Edited Message
        try {
          const subject = `v1.messages.update.${fastify.config.COMPANY_ID}`;

          const payload = {
            message_id: generateDaisiMsgId(fastify.config.AGENT_ID, id),
            company_id: fastify.config.COMPANY_ID,
            edited_message_obj: update?.message?.editedMessage,
          };

          await fastify.publishEvent(subject, payload);
        } catch (err: any) {
          fastify.log.error('[messages.update] error: %o', err.message);
        }
      } else if (message === null && update.key) {
        // Deleted Message
        try {
          const subject = `v1.messages.update.${fastify.config.COMPANY_ID}`;

          const payload = {
            message_id: generateDaisiMsgId(fastify.config.AGENT_ID, id),
            company_id: fastify.config.COMPANY_ID,
            is_deleted: true,
          };

          await fastify.publishEvent(subject, payload);
        } catch (err: any) {
          fastify.log.error('[messages.update] error: %o', err.message);
        }
      }
    }
  }
};
