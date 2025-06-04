// src/events/processActions.ts (Updated with Broadcast Support)
import { FastifyInstance } from 'fastify';
import { getSock } from '../utils/sock';
import { sendMessage } from '../services/sendMessage';
import { ActionName, ActionResponseMap } from '../types/actions';

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

    // NEW: Handle broadcast control signals
    if (action === 'START_BROADCAST') {
      const { batchId, companyId } = payload;
      
      fastify.log.info(`[BROADCAST] Received START signal for batch ${batchId}`);
      
      // Store broadcast state in local memory or Redis
      const broadcastKey = `broadcast:active:${fastify.config.AGENT_ID}:${batchId}`;
      await fastify.redis.setex(broadcastKey, 86400, JSON.stringify({
        status: 'ACTIVE',
        startedAt: new Date().toISOString(),
        companyId,
      }));
      
      return {
        success: true,
        data: { 
          batchId,
          status: 'STARTED',
          timestamp: new Date().toISOString() 
        },
      } as ActionResponseMap[T];
    }

    if (action === 'CANCEL_BROADCAST') {
      const { batchId, taskAgent } = payload;
      
      fastify.log.info(`[BROADCAST] Received CANCEL signal for batch ${batchId}`);
      
      // Mark broadcast as cancelled
      const broadcastKey = `broadcast:active:${fastify.config.AGENT_ID}:${batchId}`;
      await fastify.redis.setex(broadcastKey, 86400, JSON.stringify({
        status: 'CANCELLED',
        cancelledAt: new Date().toISOString(),
      }));
      
      return {
        success: true,
        data: { 
          batchId,
          status: 'CANCELLED',
          timestamp: new Date().toISOString() 
        },
      } as ActionResponseMap[T];
    }

    return { success: false, error: 'Unknown action' } as ActionResponseMap[T];
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Unhandled error',
    } as ActionResponseMap[T];
  }
};