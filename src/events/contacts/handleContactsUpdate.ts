import { FastifyInstance } from 'fastify';

export const handleContactsUpdate = async (fastify: FastifyInstance, updates: any[]) => {
  for (const contact of updates) {
    fastify.log.info('[contacts.update] update: %o', contact);

    const { id, notify } = contact;
    const phone_number = id.replace(/@.*$/, '');

    try {
      const subject = `v1.contacts.update.${fastify.config.COMPANY_ID}`;
      const payload = {
        company_id: fastify.config.COMPANY_ID,
        agent_id: fastify.config.AGENT_ID,
        phone_number,
        push_name: notify || phone_number,
      };

      await fastify.publishEvent(subject, payload);
    } catch (err: any) {
      fastify.log.error('[contacts.update] error: %o', err.message);
    }
  }
};
