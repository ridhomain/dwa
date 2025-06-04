// src/services/mediaDownloadService.ts
import { FastifyInstance, FastifyBaseLogger } from 'fastify';
import { downloadContentFromMessage } from 'baileys';
import { request } from 'undici';

export interface MediaDownloadResult {
  success: boolean;
  url?: string;
  error?: string;
}

export class MediaDownloadService {
  private logger: FastifyBaseLogger;
  private fastify: FastifyInstance;

  constructor(fastify: FastifyInstance) {
    this.fastify = fastify;
    this.logger = fastify.log;
  }

  async downloadMedia(
    media: any,
    type: any,
    messageId: string,
    mimeType: string
  ): Promise<MediaDownloadResult> {
    try {
      this.logger.info(`[MediaDownload] Starting download for ${messageId}, type: ${type}`);

      // Set file size limit (10MB)
      const maxFileSize = 10 * 1024 * 1024; // 10MB

      // Download content as stream
      const stream = await downloadContentFromMessage(media, type);

      // Convert stream to buffer with size limit
      const chunks: Buffer[] = [];
      let totalSize = 0;

      for await (const chunk of stream) {
        totalSize += chunk.length;

        // Check if file size exceeds limit
        if (totalSize > maxFileSize) {
          this.logger.warn(
            `[MediaDownload] File size ${totalSize} exceeds limit ${maxFileSize} for ${messageId}`
          );
          return { success: false, error: `File size exceeds 10MB limit` };
        }

        chunks.push(chunk);
      }

      const buffer = Buffer.concat(chunks);

      this.logger.info(`[MediaDownload] Downloaded ${buffer.length} bytes for ${messageId}`);

      // Upload to storage
      const uploadResult = await this.uploadMedia({
        buffer,
        key: messageId,
        mimeType,
      });

      if (uploadResult.success) {
        this.logger.info(`[MediaDownload] Successfully uploaded ${messageId}: ${uploadResult.url}`);
        return { success: true, url: uploadResult.url };
      } else {
        this.logger.error(`[MediaDownload] Upload failed for ${messageId}: ${uploadResult.error}`);
        return { success: false, error: uploadResult.error };
      }
    } catch (error: any) {
      this.logger.error(`[MediaDownload] Download failed for ${messageId}: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  private async uploadMedia(payload: {
    buffer: Buffer;
    key: string;
    mimeType: string;
  }): Promise<{ success: boolean; url?: string; error?: string }> {
    try {
      const formData = new FormData();

      const blob = new Blob([payload.buffer], { type: payload.mimeType });
      formData.append('file', blob, payload.key);
      formData.append('key', payload.key);
      formData.append('folder', 'timkado1');
      formData.append('skipExt', 'true');

      const response = await request(`${this.fastify.config.DB_API_URL}/api/v1/s3`, {
        method: 'POST',
        headers: {
          token: `${this.fastify.config.TOKEN}`,
        },
        body: formData,
      });

      if (response.statusCode >= 200 && response.statusCode < 300) {
        const data = (await response.body.json()) as any;
        return { success: true, url: data.data?.url };
      }

      const errorText = await response.body.text();
      return { success: false, error: `Upload failed: ${response.statusCode} - ${errorText}` };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  // Helper to extract media from message
  extractMediaFromMessage(message: any): { media: any; type: string; mimeType: string } | null {
    const mediaTypes = [
      { key: 'imageMessage', type: 'image' },
      // { key: 'videoMessage', type: 'video' },
      // { key: 'audioMessage', type: 'audio' },
      { key: 'documentMessage', type: 'document' },
      // { key: 'stickerMessage', type: 'sticker' },
    ];

    for (const { key, type } of mediaTypes) {
      if (message[key]) {
        return {
          media: message[key],
          type,
          mimeType: message[key].mimetype || 'application/octet-stream',
        };
      }
    }

    // Handle document with caption
    if (message.documentWithCaptionMessage?.message?.documentMessage) {
      const docMsg = message.documentWithCaptionMessage.message.documentMessage;
      return {
        media: docMsg,
        type: 'document',
        mimeType: docMsg.mimetype || 'application/octet-stream',
      };
    }

    return null;
  }
}
