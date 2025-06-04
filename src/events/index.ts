import { FastifyInstance } from 'fastify';
import { getSock } from '../utils/sock';

// Events
import { handleConnectionUpdate } from './connection/handleConnectionUpdate';
// import { handleContactsUpdate } from './contacts/handleContactsUpdate';
import { handleContactsUpsert } from './contacts/handleContactsUpsert';
import { handleChatsUpsert } from './chats/handleChatsUpsert';
import { handleChatsUpdate } from './chats/handleChatsUpdate';
import { handleMessagesUpdate } from './messages/handleMessagesUpdate';
import { handleMessagesUpsert } from './messages/handleMessagesUpsert';
import { handleChatsSet } from './history/handleChatsSet';
import { handleContactsSet } from './history/handleContactsSet';
import { handleMessagesSet } from './history/handleMessagesSet';

export const registerEvents = (fastify: FastifyInstance, saveCreds: any) => {
  const sock = getSock();

  sock.ev.process(async (events) => {
    if (events['connection.update']) {
      await handleConnectionUpdate(events['connection.update'], fastify);
    }

    // History Events
    if (events['messaging-history.set']) {
      const { chats, contacts, messages, isLatest, progress, syncType } =
        events['messaging-history.set'];

      fastify.log.info('[messaging-history.set] isLatest: %o', isLatest);
      fastify.log.info('[messaging-history.set] progress: %o', progress);
      fastify.log.info('[messaging-history.set] syncType: %o', syncType);

      await handleChatsSet(fastify, chats);
      await handleContactsSet(fastify, contacts);
      await handleMessagesSet(fastify, messages);
    }

    // Contacts Events
    if (events['contacts.upsert']) {
      const contacts = events['contacts.upsert'];
      await handleContactsUpsert(fastify, contacts);
    }

    // if (events['contacts.update']) {
    //   const updates = events['contacts.update'];
    //   await handleContactsUpdate(fastify, updates);
    // }

    // Chats Events
    if (events['chats.upsert']) {
      const chats = events['chats.upsert'];
      await handleChatsUpsert(fastify, chats);
    }

    if (events['chats.update']) {
      const updates = events['chats.update'];
      await handleChatsUpdate(fastify, updates);
    }

    // Messages Events
    if (events['messages.upsert']) {
      const eventPayload = events['messages.upsert'];
      await handleMessagesUpsert(fastify, eventPayload);
    }

    if (events['messages.update']) {
      const updates = events['messages.update'];
      await handleMessagesUpdate(fastify, updates);
    }

    // Creds
    if (events['creds.update']) {
      await saveCreds();
    }
  });
};
