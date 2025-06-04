import { FastifyInstance } from 'fastify';
import { generateDaisiChatId, getConversationTimestamp } from '../../utils';
import { isJidStatusBroadcast } from 'baileys';

export const handleChatsUpdate = async (fastify: FastifyInstance, updates: any[]) => {
  for (const chat of updates) {
    fastify.log.info('[chats.update] update: %o', chat);

    const {
      id,
      messages,
      conversationTimestamp,
      unreadCount,
      lastMessageRecvTimestamp,
      broadcast,
    } = chat;
    const m = messages?.[0]?.message;

    if (broadcast) continue;
    if (m?.broadcast) fastify.log.warn('[chats.update]: broadcast message => %o', m);
    if (isJidStatusBroadcast(id)) continue;

    try {
      const subject = `v1.chats.update.${fastify.config.COMPANY_ID}`;
      const chatId = generateDaisiChatId(fastify.config.AGENT_ID, id);
      const payload = {
        chat_id: chatId,
        company_id: fastify.config.COMPANY_ID,
        agent_id: fastify.config.AGENT_ID,
        last_message: m?.message || null,
        conversation_timestamp: getConversationTimestamp(
          lastMessageRecvTimestamp,
          conversationTimestamp
        ),
        push_name: m?.pushName || m?.verifiedBizName || id.split('@')[0],
        unread_count: unreadCount || 0,
      };

      await fastify.publishEvent(subject, payload);
    } catch (err: any) {
      fastify.log.error('[chats.update] error: %o', err.message);
    }
  }
};
