import crypto from 'crypto';
import { toNumber, jidNormalizedUser } from 'baileys';

export const nanoid = (n = 10) => {
  return crypto.randomUUID().replace(/-/g, '').substring(0, n);
};

export const waitFor = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const getRndInteger = (min: number, max: number) => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

export const chunkArray = <T extends object>(array: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
};

export const getConversationTimestamp = (
  lastMessgeRecvTimestamp: any,
  conversationTimestamp: any
): number => {
  if (lastMessgeRecvTimestamp && typeof lastMessgeRecvTimestamp === 'number')
    return lastMessgeRecvTimestamp;
  if (conversationTimestamp && typeof conversationTimestamp === 'number')
    return conversationTimestamp;
  return toNumber(conversationTimestamp);
};

export const getPhoneFromJid = (jid: string): string => jidNormalizedUser(jid).split('@')[0];

export const generateDaisiChatId = (agentId: string, jid: string): string => {
  const phoneNumber = getPhoneFromJid(jid);
  return `${agentId}_${phoneNumber}`;
};

export const generateDaisiMsgId = (agentId: string, id: string | null | undefined): string => {
  if (id) return `${agentId}_${id}`;
  return `${agentId}_undefined`;
};

// Add this function to extract text from different message types
export const extractMessageText = (message: any): string | null => {
  if (!message) return null;

  // Direct text message
  if (message.conversation) {
    return message.conversation;
  }

  // Extended text message (with metadata like quotes, links, etc.)
  if (message.extendedTextMessage?.text) {
    return message.extendedTextMessage.text;
  }

  // Image message with caption
  if (message.imageMessage?.caption) {
    return message.imageMessage.caption;
  }

  // Video message with caption
  if (message.videoMessage?.caption) {
    return message.videoMessage.caption;
  }

  // Document message with caption
  if (message.documentMessage?.caption) {
    return message.documentMessage.caption;
  }

  // Document with caption message (different structure)
  if (message.documentWithCaptionMessage?.message?.documentMessage?.caption) {
    return message.documentWithCaptionMessage.message.documentMessage.caption;
  }

  // Template button reply message
  if (message.templateButtonReplyMessage?.selectedDisplayText) {
    return message.templateButtonReplyMessage.selectedDisplayText;
  }

  // List response message
  if (message.listResponseMessage?.title) {
    return message.listResponseMessage.title;
  }

  // Buttons response message
  if (message.buttonsResponseMessage?.selectedDisplayText) {
    return message.buttonsResponseMessage.selectedDisplayText;
  }

  // Edited message
  if (message.editedMessage?.message) {
    return extractMessageText(message.editedMessage.message);
  }

  // Protocol message (usually system messages)
  if (message.protocolMessage?.type) {
    return null; // These are system messages, not user text
  }

  return null;
};

// src/utils/template.utils.ts
/**
 * Message template utilities for variable substitution
 */

/**
 * Apply variables to a message template
 * Handles nested objects and arrays
 */
export function applyVariables(
  template: any,
  variables: Record<string, any>,
  contact?: Record<string, any>
): any {
  // Merge contact data with provided variables
  const allVariables = {
    ...contact,
    ...variables,
    // System variables
    date: new Date().toLocaleDateString('id-ID'),
    time: new Date().toLocaleTimeString('id-ID'),
    timestamp: new Date().toISOString(),
  };

  return deepApplyVariables(template, allVariables);
}

/**
 * Recursively apply variables to nested objects
 */
function deepApplyVariables(obj: any, variables: Record<string, any>): any {
  if (typeof obj === 'string') {
    return replaceVariables(obj, variables);
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => deepApplyVariables(item, variables));
  }
  
  if (obj && typeof obj === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = deepApplyVariables(value, variables);
    }
    return result;
  }
  
  return obj;
};

/**
 * Replace variables in a string
 * Supports {{variable}} and {{variable|default}} syntax
 */
function replaceVariables(text: string, variables: Record<string, any>): string {
  return text.replace(/\{\{(\w+)(?:\|([^}]+))?\}\}/g, (match, varName, defaultValue) => {
    const value = getNestedValue(variables, varName);
    
    if (value !== undefined && value !== null) {
      return String(value);
    }
    
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    
    // Return original if no value found
    return match;
  });
};

/**
 * Get nested object value using dot notation
 * e.g., "user.name" from { user: { name: "John" } }
 */
function getNestedValue(obj: Record<string, any>, path: string): any {
  const parts = path.split('.');
  let current = obj;
  
  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  
  return current;
};

/**
 * Extract variable names from a message template
 * Supports {{variableName}} syntax
 */
export function extractVariables(content: any): string[] {
  const variables = new Set<string>();
  const pattern = /\{\{(\w+)\}\}/g;
  
  // Check all text fields
  const textFields = [
    content.text,
    content.caption,
    content.fileName,
  ].filter(Boolean);
  
  for (const field of textFields) {
    const matches = field.matchAll(pattern);
    for (const match of matches) {
      variables.add(match[1]);
    }
  }
  
  return Array.from(variables);
}