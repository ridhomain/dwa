import { FastifyInstance } from 'fastify';
import { isJidGroup, isJidStatusBroadcast } from 'baileys';
import { getConversationTimestamp, generateDaisiChatId, getPhoneFromJid } from '../../utils';

export const handleChatsUpsert = async (fastify: FastifyInstance, chats: any[]) => {
  for (const chat of chats) {
    fastify.log.info('[chats.upsert] chat: %o', chat);
    const {
      id,
      conversationTimestamp,
      unreadCount,
      broadcast,
      messages,
      name,
      lastMessageRecvTimestamp,
    } = chat;
    const m = messages?.[0]?.message;

    if (broadcast) continue;
    if (m?.broadcast) fastify.log.warn('[chats.upsert]: broadcast message => %o', m);
    if (isJidStatusBroadcast(id)) continue;

    try {
      const subject = `v1.chats.upsert.${fastify.config.COMPANY_ID}`;
      const chatId = generateDaisiChatId(fastify.config.AGENT_ID, id);
      const payload = {
        chat_id: chatId,
        jid: id,
        phone_number: getPhoneFromJid(id),
        company_id: fastify.config.COMPANY_ID,
        agent_id: fastify.config.AGENT_ID,
        unread_count: unreadCount || 0,
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

      await fastify.publishEvent(subject, payload);
    } catch (err: any) {
      fastify.log.error('[chats.upsert] error: %o', err.message);
    }
  }
};
