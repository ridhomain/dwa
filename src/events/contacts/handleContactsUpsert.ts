import { FastifyInstance } from 'fastify';
import { generateDaisiChatId, getPhoneFromJid } from '../../utils';

export const handleContactsUpsert = async (fastify: FastifyInstance, contacts: any[]) => {
  for (const contact of contacts) {
    fastify.log.info('[contacts.upsert] contact: %o', contact);

    const { id, name } = contact;
    const phone_number = getPhoneFromJid(id);

    try {
      const subject = `v1.contacts.upsert.${fastify.config.COMPANY_ID}`;
      const payload = {
        chat_id: generateDaisiChatId(fastify.config.AGENT_ID, id),
        company_id: fastify.config.COMPANY_ID,
        agent_id: fastify.config.AGENT_ID,
        phone_number,
        push_name: name || phone_number,
      };

      await fastify.publishEvent(subject, payload);
    } catch (err: any) {
      fastify.log.error('[contacts.upsert] error: %o', err.message);
    }
  }
};
