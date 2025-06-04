import { FastifyInstance } from 'fastify';
import { WASocket, jidNormalizedUser } from 'baileys';
import { createBaileysClient } from '../services/createBaileysClient';
import { getPhoneFromJid, waitFor } from '.';

let sock: WASocket | null = null;
let isReloading = false;

export const setSock = (s: WASocket) => {
  sock = s;
};

export const getSock = (): WASocket => {
  if (!sock) throw new Error('Socket not initialized');
  return sock;
};

export const reloadSocket = async (fastify: FastifyInstance) => {
  if (isReloading) return;
  isReloading = true;

  try {
    // End Socket (Check about ws.close etc later);
    sock?.end(new Error('manual restart'));
    await waitFor(1000);

    await createBaileysClient(fastify);
    fastify.log.info('Socket reloaded');
  } catch (err) {
    fastify.log.error('Failed to reload socket:', err);
  } finally {
    isReloading = false;
  }
};

export const getUser = () => {
  if (!sock || !sock.user) return;

  if (typeof sock.user === 'object') {
    return {
      phone: getPhoneFromJid(sock.user.id),
      id: sock.user.id,
      normalizedId: jidNormalizedUser(sock.user.id),
      name: sock.user.name,
    };
  }

  return null;
};
