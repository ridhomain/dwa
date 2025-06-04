import os from 'os';
import { DisconnectReason, ConnectionState } from 'baileys';
import { FastifyInstance } from 'fastify';
import { Boom } from '@hapi/boom';
import Pack from '../../../package.json';
import { deleteKeysWithPattern } from '../../utils/redis';
import { reloadSocket } from '../../utils/sock';

export const handleConnectionUpdate = async (
  update: Partial<ConnectionState>,
  fastify: FastifyInstance
) => {
  const { connection, lastDisconnect, qr } = update;
  fastify.log.info('connection update: %s => %o', connection, update);

  // constants
  const COMPANY_ID = fastify.config.COMPANY_ID;
  const AGENT_ID = fastify.config.AGENT_ID;
  const API_DB = fastify.config.API_DB;
  const TAGS = fastify.config.TAGS;
  const subject = `v1.connection.update.${COMPANY_ID}`;

  const emitStatus = async (status: string, extraPayload = {}) => {
    const payload = {
      status,
      version: `${Pack.version} - ${TAGS}`,
      api_db: API_DB,
      host_name: os.hostname(),
      company_id: COMPANY_ID,
      agent_id: AGENT_ID,
      ...extraPayload,
    };

    await fastify.publishEvent(subject, payload);
  };

  if (
    connection === 'close' &&
    (lastDisconnect?.error as Boom)?.output?.statusCode === DisconnectReason.restartRequired
  ) {
    await emitStatus('CLOSE');
    // prometheus metrics

    reloadSocket(fastify);
  } else if (connection === 'open') {
    await emitStatus('READY');

    // prometheus metrics
  } else if (connection === 'connecting') {
    await emitStatus('CONNECTING');
    // prometheus metrics
  } else if (
    connection === 'close' &&
    (lastDisconnect?.error as Boom)?.output?.statusCode === DisconnectReason.loggedOut
  ) {
    await emitStatus('CLOSE');
    // prometheus metrics

    // REMOVE AUTH KEYS
    await deleteKeysWithPattern({ redis: fastify.redis, pattern: `${AGENT_ID}:creds` });
  } else if (connection === 'close') {
    await emitStatus('CLOSE');
    fastify.log.error('[connection.update] disconnect reason: %o', lastDisconnect?.error?.message);
    reloadSocket(fastify);
    // prometheus metrics
  }

  if (qr) {
    await emitStatus('QR', { qr_code: qr });
    // prometheus metrics
  }
};
