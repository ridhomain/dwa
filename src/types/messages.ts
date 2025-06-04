// src/types/messages.ts

export interface OnboardingMetadata {
  tags?: string;
  origin?: string;
  assigned_to?: string;
}

export interface MessageUpsertPayload {
  message_id: string;
  chat_id: string;
  jid: string;
  key: any;
  message_obj: any;
  message_type: string;
  message_text: string | null;
  message_url: string | null;
  company_id: string;
  agent_id: string;
  to_phone: string;
  from_phone: string;
  flow: 'IN' | 'OUT';
  message_timestamp: number;
  status: string;
  created_at: string;
  push_name?: string | null;
  onboarding_metadata?: OnboardingMetadata | null;
}

// export interface ChatUpsertPayload {
//   chat_id: string;
//   jid: string;
//   phone_number: string;
//   company_id: string;
//   agent_id: string;
//   unread_count: number;
//   is_group: boolean;
//   conversation_timestamp: number;
//   last_message: any;
//   group_name?: string | null;
//   push_name?: string;
// }

// export interface ContactUpsertPayload {
//   company_id: string;
//   agent_id: string;
//   phone_number: string;
//   push_name: string;
// }

// export interface ConnectionUpdatePayload {
//   status: string;
//   version: string;
//   api_db?: string;
//   host_name: string;
//   company_id: string;
//   agent_id: string;
//   qr_code?: string;
// }
