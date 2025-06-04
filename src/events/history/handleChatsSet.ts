import { isJidStatusBroadcast, isJidGroup } from 'baileys';
import { FastifyInstance } from 'fastify';
import {
  chunkArray,
  getConversationTimestamp,
  generateDaisiChatId,
  getPhoneFromJid,
} from '../../utils';

const BATCH_SIZE = 100;

export const handleChatsSet = async (fastify: FastifyInstance, chats: any[]) => {
  const batchItems = [];
  const subject = `v1.history.chats.${fastify.config.COMPANY_ID}`;

  // filter chats
  const filteredChats = chats.filter(
    (ch) => !ch.messageStubType && ch.conversationTimestamp && !isJidStatusBroadcast(ch.id)
  );

  for await (const chat of filteredChats) {
    fastify.log.info('[chats.set] chat: %o', chat);
    const {
      id,
      conversationTimestamp,
      unreadCount,
      broadcast,
      notSpam,
      messages,
      name,
      lastMessageRecvTimestamp,
    } = chat;
    const m = messages?.[0]?.message;

    // skip broadcast
    if (broadcast) continue;

    // push to batchItems
    const chatId = generateDaisiChatId(fastify.config.AGENT_ID, id);
    const payload = {
      chat_id: chatId,
      jid: id,
      phone_number: getPhoneFromJid(id),
      company_id: fastify.config.COMPANY_ID,
      agent_id: fastify.config.AGENT_ID,
      unread_count: unreadCount,
      not_spam: notSpam,
      is_group: isJidGroup(id),
      conversation_timestamp: getConversationTimestamp(
        lastMessageRecvTimestamp,
        conversationTimestamp
      ),
      last_message: m?.message || null,
      group_name: null,
      push_name: name || m?.verifiedBizName || m?.pushName || id.split('@')[0],
    };

    if (isJidGroup(id)) {
      payload.group_name = name || id.split('@')[0];
    }

    batchItems.push(payload);
  }

  try {
    if (batchItems.length > 0) {
      const chunks = chunkArray(batchItems, BATCH_SIZE);

      for (const [index, chunk] of chunks.entries()) {
        await fastify.publishEvent(subject, { chats: chunk });
        fastify.log.info('[chats.set] => published batch: %o. length: %s', index, chunk.length);
      }
    } else {
      fastify.log.warn('[chats.set] => No valid payload to publish');
    }
  } catch (err: any) {
    fastify.log.error('[chats.set] error: %o', err.message);
  }
};
