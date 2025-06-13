import { FastifyInstance } from 'fastify';
import { getSock } from '../utils/sock';
import { sendMessage } from '../services/sendMessage';
import { ActionName, ActionResponseMap } from '../types/actions';
// import { StringCodec } from 'nats';
import { REDIS_TTL_MS } from '../constants';
import { generateDaisiChatId } from '../utils';

// const sc = StringCodec();

function extractMediaUrlFromMessage(message: any): string | null {
  if (!message) return null;

  // Check different media message types for URL
  if (message.image && typeof message.image === 'string' && message.image.startsWith('http')) {
    return message.image;
  }

  if (message.video && typeof message.video === 'string' && message.video.startsWith('http')) {
    return message.video;
  }

  if (message.audio && typeof message.audio === 'string' && message.audio.startsWith('http')) {
    return message.audio;
  }

  if (
    message.document &&
    typeof message.document === 'string' &&
    message.document.startsWith('http')
  ) {
    return message.document;
  }

  // For other message structures
  if (message.url && typeof message.url === 'string' && message.url.startsWith('http')) {
    return message.url;
  }

  return null;
}

export const processActions = async <T extends ActionName>(
  fastify: FastifyInstance,
  action: T,
  payload: Record<string, any>
): Promise<ActionResponseMap[T]> => {
  const sock = getSock();
  if (!sock) {
    return { success: false, error: 'Socket not initialized' } as ActionResponseMap[T];
  }

  try {
    if (action === 'SEND_MSG') {
      const { agentId, phoneNumber, message, options } = payload;

      if (agentId !== fastify.config.AGENT_ID) {
        return { success: false, error: 'Agent ID mismatch' } as ActionResponseMap[T];
      }

      const { quoted } = options ?? {};
      const jid = `${phoneNumber}@s.whatsapp.net`;

      fastify.log.info(`[Daisi] Sending message to ${phoneNumber}, message: %o`, message);

      const { success, sentMsg, errMessage } = await sendMessage(sock, message, jid, quoted);

      if (!success || !sentMsg?.key?.id) {
        return {
          success: false,
          error: errMessage || 'Failed to send message',
        } as ActionResponseMap[T];
      }

      await fastify.redis.set(sentMsg.key.id, JSON.stringify(message), 'EX', 10);

      // Cache media URL if message contains media with URL
      const mediaUrl = extractMediaUrlFromMessage(message);
      if (mediaUrl) {
        const cacheKey = `media:url:${fastify.config.AGENT_ID}_${sentMsg.key.id}`;
        await fastify.redis.setex(cacheKey, 3600, mediaUrl); // Cache for 1 hour
        fastify.log.info(`[SEND_MSG] Cached media URL for ${sentMsg.key.id}: ${mediaUrl}`);
      }

      return {
        success: true,
        data: { msgId: sentMsg.key.id },
      } as ActionResponseMap[T];
    }

    if (action === 'SEND_MSG_TO_GROUP') {
      const { agentId, groupJid, message, options } = payload;

      if (agentId !== fastify.config.AGENT_ID) {
        return { success: false, error: 'Agent ID mismatch' } as ActionResponseMap[T];
      }

      const { quoted } = options ?? {};
      const { success, sentMsg, errMessage } = await sendMessage(sock, message, groupJid, quoted);

      if (!success || !sentMsg?.key?.id) {
        return {
          success: false,
          error: errMessage || 'Failed to send message to group',
        } as ActionResponseMap[T];
      }

      await fastify.redis.set(sentMsg.key.id, JSON.stringify(message), 'EX', 10);

      const mediaUrl = extractMediaUrlFromMessage(message);
      if (mediaUrl) {
        const cacheKey = `media:url:${sentMsg.key.id}`;
        await fastify.redis.setex(cacheKey, 3600, mediaUrl);
        fastify.log.info(`[SEND_MSG_TO_GROUP] Cached media URL for ${sentMsg.key.id}: ${mediaUrl}`);
      }

      return {
        success: true,
        data: { msgId: sentMsg.key.id },
      } as ActionResponseMap[T];
    }

    if (action === 'MARK_AS_READ') {
      const { agentId, remoteJid, id } = payload;
      if (agentId !== fastify.config.AGENT_ID) {
        return { success: false, error: 'Agent ID mismatch' } as ActionResponseMap[T];
      }

      await sock.readMessages([{ remoteJid, id }]);

      // debounce set unread to 0
      const debounceKey = `debounce:chat-unread:${fastify.config.AGENT_ID}:${remoteJid}`;

      try {
        const result = await fastify.redis.set(debounceKey, '1', 'PX', REDIS_TTL_MS, 'NX');
        if (result === 'OK') {
          const chatId = generateDaisiChatId(fastify.config.AGENT_ID, remoteJid);

          const chatPayload = {
            chat_id: chatId,
            company_id: fastify.config.COMPANY_ID,
            agent_id: fastify.config.AGENT_ID,
            unread_count: 0,
          };

          await fastify.publishEvent(`v1.chats.update.${fastify.config.COMPANY_ID}`, chatPayload);

          fastify.log.info(
            `[MARK_AS_READ] Synced unread_count=0 via Redis debounce for chat: ${remoteJid}`
          );
        }
      } catch (err: any) {
        fastify.log.error('[MARK_AS_READ] chat update debounce error: %o', err.message);
      }
      return {
        success: true,
        data: { msgId: id },
      } as ActionResponseMap[T];
    }

    if (action === 'LOGOUT') {
      const { agentId } = payload;

      if (agentId !== fastify.config.AGENT_ID) {
        return { success: false, error: 'Agent ID mismatch' } as ActionResponseMap[T];
      }

      await sock.logout();
      return {
        success: true,
        data: { timestamp: new Date().toISOString() },
      } as ActionResponseMap[T];
    }

    if (action === 'DOWNLOAD_MEDIA') {
      const { agentId, messageId, message } = payload;

      if (agentId !== fastify.config.AGENT_ID) {
        return { success: false, error: 'Agent ID mismatch' } as ActionResponseMap[T];
      }

      if (!messageId || !message) {
        return {
          success: false,
          error: 'messageId and message are required',
        } as ActionResponseMap[T];
      }

      const mediaService = fastify.mediaService;
      const mediaInfo = mediaService.extractMediaFromMessage(message);

      if (!mediaInfo) {
        return {
          success: false,
          error: 'No downloadable media found in message',
        } as ActionResponseMap[T];
      }

      fastify.log.info(`[DOWNLOAD_MEDIA] Downloading ${mediaInfo.type} for message ${messageId}`);

      const downloadResult = await mediaService.downloadMedia(
        mediaInfo.media,
        mediaInfo.type,
        messageId,
        mediaInfo.mimeType
      );

      if (downloadResult.success) {
        return {
          success: true,
          data: {
            messageId,
            mediaUrl: downloadResult.url,
            mediaType: mediaInfo.type,
            mimeType: mediaInfo.mimeType,
          },
        } as ActionResponseMap[T];
      } else {
        return {
          success: false,
          error: downloadResult.error || 'Media download failed',
        } as ActionResponseMap[T];
      }
    }

    return { success: false, error: 'Unknown action' } as ActionResponseMap[T];
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Unhandled error',
    } as ActionResponseMap[T];
  }
};
