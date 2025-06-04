import {
  isJidStatusBroadcast,
  WAMessage,
  MessageUpsertType,
  jidNormalizedUser,
  // isJidGroup,
} from 'baileys';
import { FastifyInstance } from 'fastify';
// import { ALLOWED_MSG_TYPES } from '../../constants';
import { getUser } from '../../utils/sock';
import {
  generateDaisiChatId,
  generateDaisiMsgId,
  getPhoneFromJid,
  extractMessageText,
} from '../../utils';
// import { getSock } from '../../utils/sock';
import { MessageUpsertPayload } from '../../types/messages';
// import { sendMessage } from '../../services/sendMessage';

export const handleMessagesUpsert = async (
  fastify: FastifyInstance,
  eventPayload: { messages: WAMessage[]; type: MessageUpsertType; requestId?: string }
) => {
  const subject = `v1.messages.upsert.${fastify.config.COMPANY_ID}`;
  const { messages, type } = eventPayload;
  fastify.log.info('[messages.upsert] message upsert type: %o', type);

  // Initialize media download service
  const mediaService = fastify.mediaService;
  // const onboardingService = fastify.onboardingService;

  for (const m of messages) {
    // fastify.log.info('[messages.upsert] message: %o', m);
    const { key, messageTimestamp, broadcast, message, status } = m;
    const { remoteJid, fromMe, id } = key;

    if (!remoteJid || isJidStatusBroadcast(remoteJid) || broadcast || !message) continue;

    // setup
    const jid = jidNormalizedUser(remoteJid);
    const user = getUser();

    // check current user
    if (!user) return;
    const phone = user.phone;
    const from = fromMe ? phone : getPhoneFromJid(jid);
    const to = fromMe ? getPhoneFromJid(jid) : phone;

    // handle failed to decrypt
    if (!message) {
      fastify.log.warn('[message.upsert] no message content. failed to decrypt');

      // publish to nats
      try {
        const chatId = generateDaisiChatId(fastify.config.AGENT_ID, jid);
        const payload = {
          message_id: generateDaisiMsgId(fastify.config.AGENT_ID, id),
          jid,
          chat_id: chatId,
          key,
          message_obj: {},
          message_type: 'notification',
          message_text: 'Waiting For Message.',
          message_url: '',
          company_id: fastify.config.COMPANY_ID,
          agent_id: fastify.config.AGENT_ID,
          to_phone: to,
          from_phone: from,
          flow: fromMe ? 'OUT' : 'IN',
          message_timestamp: Number(messageTimestamp),
          status: status ? status.toString() : '0',
          created_at: new Date().toISOString(),
        };

        await fastify.publishEvent(subject, payload);
      } catch (err: any) {
        fastify.log.error('[messages.upsert] error: %o', err.message);
      }

      continue;
    }

    // get message type
    const typeKeys = Object.keys(message).filter((k) => k !== 'messageContextInfo');
    const msgType = typeKeys[0] || 'unknown';
    const messageText = extractMessageText(message);

    fastify.log.info('[messages.upsert] message type: %o', msgType);

    // filter message
    // if (!ALLOWED_MSG_TYPES.includes(msgType)) continue;

    // bypass message protocol
    if (msgType === 'protocolMessage') continue;

    let mediaUrl: string | null = '';
    // Check cache first (for both inbound and outbound)
    try {
      const cacheKey = `media:url:${id}`;
      const cachedUrl = await fastify.redis.get(cacheKey);

      if (cachedUrl) {
        mediaUrl = cachedUrl;
        fastify.log.info(`[messages.upsert] Found cached media URL: ${mediaUrl}`);
      } else {
        // No cache found, try to download media
        const mediaInfo = mediaService.extractMediaFromMessage(message);

        if (mediaInfo) {
          fastify.log.info(`[messages.upsert] Found media in message: ${mediaInfo.type}`);

          try {
            const downloadResult = await mediaService.downloadMedia(
              mediaInfo.media,
              mediaInfo.type,
              id,
              mediaInfo.mimeType
            );

            if (downloadResult.success) {
              mediaUrl = downloadResult.url || null;

              // Cache the downloaded URL
              if (mediaUrl) {
                await fastify.redis.setex(cacheKey, 3600, mediaUrl);
                fastify.log.info(`[messages.upsert] Media downloaded and cached: ${mediaUrl}`);
              }
            } else {
              fastify.log.warn(`[messages.upsert] Media download failed: ${downloadResult.error}`);
            }
          } catch (err: any) {
            fastify.log.error(`[messages.upsert] Media download error: ${err.message}`);
          }
        }
      }
    } catch (err: any) {
      fastify.log.error(`[messages.upsert] Cache/download error: ${err.message}`);
    }

    // Onboarding Process
    // Initialize onboarding metadata
    // let onboardingMetadata:
    //   | {
    //       tags?: string;
    //       origin?: string;
    //       assigned_to?: string;
    //     }
    //   | undefined;

    // // Check onboarding only for incoming messages, non-group, and notify/append type
    // if (!fromMe && !isJidGroup(jid) && messageText && (type === 'notify' || type === 'append')) {
    //   fastify.log.info('[messages.upsert] Checking onboarding for message: %s', messageText);

    //   const onboardingResult = await onboardingService.checkOnboarding(messageText);

    //   if (onboardingResult.isOnboarding && onboardingResult.metadata) {
    //     fastify.log.info('[messages.upsert] Message is an onboarding message');

    //     onboardingMetadata = onboardingResult.metadata;

    //     // Send auto-reply if configured
    //     if (onboardingResult.metadata.reply) {
    //       try {
    //         const sock = getSock();
    //         const autoReplyMessage = {
    //           text: onboardingResult.metadata.reply,
    //         };

    //         const result = await sendMessage(sock, autoReplyMessage, remoteJid, null);

    //         if (result.success) {
    //           fastify.log.info('[messages.upsert] Auto-reply sent successfully');
    //         } else {
    //           fastify.log.error(
    //             '[messages.upsert] Failed to send auto-reply: %s',
    //             result.errMessage
    //           );
    //         }
    //       } catch (err: any) {
    //         fastify.log.error('[messages.upsert] Error sending auto-reply: %o', err.message);
    //       }
    //     }
    //   } else {
    //     // For non-onboarding messages, we'll let WEP determine if it's a first message
    //     // and apply default metadata
    //     fastify.log.info('[messages.upsert] Message is not an onboarding message');
    //   }
    // }

    // publish to nats
    try {
      const payload: MessageUpsertPayload = {
        message_id: generateDaisiMsgId(fastify.config.AGENT_ID, id),
        chat_id: generateDaisiChatId(fastify.config.AGENT_ID, jid),
        jid,
        key,
        message_obj: message,
        message_type: msgType,
        message_text: messageText,
        message_url: mediaUrl,
        company_id: fastify.config.COMPANY_ID,
        agent_id: fastify.config.AGENT_ID,
        to_phone: to,
        from_phone: from,
        flow: fromMe ? 'OUT' : 'IN',
        message_timestamp: Number(messageTimestamp),
        status: status ? status.toString() : '0',
        created_at: new Date().toISOString(),
        // onboarding_metadata: onboardingMetadata || null,
      };

      await fastify.publishEvent(subject, payload);
    } catch (err: any) {
      fastify.log.error('[messages.upsert] error: %o', err.message);
    }
  }
};
