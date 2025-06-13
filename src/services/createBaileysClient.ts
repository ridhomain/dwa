import { FastifyInstance } from 'fastify';
import makeWASocket, {
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  WASocket,
  proto,
} from 'baileys';
import NodeCache from '@cacheable/node-cache';
import { createRedisAuthStore } from '../services/createRedisAuthStore';
import { registerEvents } from '../events';
import { setSock } from '../utils/sock';

const msgRetryCounterCache = new NodeCache({
  stdTTL: 600,
  checkperiod: 120,
  useClones: false,
});

export const createBaileysClient = async (fastify: FastifyInstance): Promise<WASocket> => {
  const { state, saveCreds } = await createRedisAuthStore(
    fastify.redis,
    `${fastify.config.AGENT_ID}`
  );

  const { version, isLatest } = await fetchLatestBaileysVersion();
  fastify.log.info(`using WA v${version.join('.')}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    version,
    logger: fastify.log.child({ scope: 'baileys' }),
    auth: {
      creds: state.creds, // optional
      /** caching makes the store faster to send/recv messages */
      keys: makeCacheableSignalKeyStore(state.keys, fastify.log),
    },
    msgRetryCounterCache,
    maxMsgRetryCount: 5,
    generateHighQualityLinkPreview: true,
    // ignore all broadcast messages -- to receive the same
    // comment the line below out
    // shouldIgnoreJid: jid => isJidBroadcast(jid),
    // implement to handle retries & poll updates
    getMessage: async (key: any) => {
      fastify.log.info('retrying msg. id => %o', key?.id);

      const msg = await fastify.redis.get(key?.id);

      fastify.log.info('msg obj retry => %o', msg);

      if (!msg) {
        fastify.log.warn('retry msg failed. no message store');
        return proto.Message.fromObject({});
      }

      return JSON.parse(msg);
    },
    browser: ['Daisi v5.0.0', 'Desktop', version.join('.')],
    syncFullHistory: true,
  });

  // Set Socket Object Globally
  setSock(sock);
  fastify.log.info('user info: %o', sock.user);

  // Register Events
  registerEvents(fastify, saveCreds);

  return sock;
};
