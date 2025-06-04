import { FastifyInstance } from 'fastify';
import { isJidUser } from 'baileys';

import { chunkArray } from '../../utils';

const BATCH_SIZE = 100;

export const handleContactsSet = async (fastify: FastifyInstance, contacts: any[]) => {
  const batchItems = [];
  const subject = `v1.history.contacts.${fastify.config.COMPANY_ID}`;

  // filter contacts only
  const userOnlyContacts = contacts.filter((c) => isJidUser(c.id));

  for (const contact of userOnlyContacts) {
    // fastify.log.info('[contacts.set] contact: %o', contact);

    const { id, notify, verifiedName } = contact;
    const phone_number = id.replace(/@.*$/, '');

    const payload = {
      company_id: fastify.config.COMPANY_ID,
      agent_id: fastify.config.AGENT_ID,
      phone_number,
      push_name: notify || verifiedName || phone_number,
    };

    batchItems.push(payload);
  }

  try {
    if (batchItems.length > 0) {
      const chunks = chunkArray(batchItems, BATCH_SIZE);

      for (const [index, chunk] of chunks.entries()) {
        await fastify.publishEvent(subject, { contacts: chunk });
        fastify.log.info('[contacts.set] => published batch: %o. length: %s', index, chunk.length);
      }
    } else {
      fastify.log.warn('[contacts.set] => No valid payload to publish');
    }
  } catch (err: any) {
    fastify.log.error('[contacts.set] error: %o', err.message);
  }
};
