export type SendMsgData = { msgId: string };
export type MarkAsReadData = { msgId: string };
export type LogoutData = { timestamp: string };
export type SendMsgToGroupData = { msgId: string };
export type DownloadMediaData = {
  messageId: string;
  mediaUrl: string;
  mediaType: string;
  mimeType: string;
};

// export type ActionResponseMap = {
//   SEND_MSG: { success: true; data: SendMsgData } | { success: false; error: string };
//   SEND_MSG_TO_GROUP:
//     | { success: true; data: SendMsgToGroupData }
//     | { success: false; error: string };
//   MARK_AS_READ: { success: true; data: MarkAsReadData } | { success: false; error: string };
//   LOGOUT: { success: true; data: LogoutData } | { success: false; error: string };
//   DOWNLOAD_MEDIA: { success: true; data: DownloadMediaData } | { success: false; error: string };
//   START_BROADCAST: { success: true; data: BroadcastSignalData } | { success: false; error: string };
//   CANCEL_BROADCAST: { success: true; data: BroadcastSignalData } | { success: false; error: string };
// };

// export type ActionName = keyof ActionResponseMap;

// src/types/actions.ts (Updated with Broadcast Actions)

export type ActionName = 
  | 'SEND_MSG' 
  | 'SEND_MSG_TO_GROUP' 
  | 'MARK_AS_READ' 
  | 'LOGOUT' 
  | 'DOWNLOAD_MEDIA'
  | 'START_BROADCAST'
  | 'CANCEL_BROADCAST';

// Response types for each action
export interface ActionResponseMap {
  SEND_MSG: {
    success: true;
    data: { msgId: string };
  } | {
    success: false;
    error: string;
  };

  SEND_MSG_TO_GROUP: {
    success: true;
    data: { msgId: string };
  } | {
    success: false;
    error: string;
  };

  MARK_AS_READ: {
    success: true;
    data: { msgId: string };
  } | {
    success: false;
    error: string;
  };

  LOGOUT: {
    success: true;
    data: { timestamp: string };
  } | {
    success: false;
    error: string;
  };

  DOWNLOAD_MEDIA: {
    success: true;
    data: {
      messageId: string;
      mediaUrl: string;
      mediaType: string;
      mimeType?: string;
    };
  } | {
    success: false;
    error: string;
  };

  START_BROADCAST: {
    success: true;
    data: {
      batchId: string;
      status: 'STARTED';
      timestamp: string;
    };
  } | {
    success: false;
    error: string;
  };

  CANCEL_BROADCAST: {
    success: true;
    data: {
      batchId: string;
      status: 'CANCELLED';
      timestamp: string;
    };
  } | {
    success: false;
    error: string;
  };
};

// Payload types for each action
export interface ActionPayloadMap {
  SEND_MSG: {
    agentId: string;
    phoneNumber: string;
    message: any;
    options?: {
      quoted?: any;
    };
  };

  SEND_MSG_TO_GROUP: {
    agentId: string;
    groupJid: string;
    message: any;
    options?: {
      quoted?: any;
    };
  };

  MARK_AS_READ: {
    agentId: string;
    remoteJid: string;
    id: string;
  };

  LOGOUT: {
    agentId: string;
  };

  DOWNLOAD_MEDIA: {
    agentId: string;
    messageId: string;
    message: any;
  };

  START_BROADCAST: {
    batchId: string;
    companyId: string;
    agentId?: string;
    total?: number;
  };

  CANCEL_BROADCAST: {
    batchId: string;
    taskAgent?: 'DAISI' | 'META';
  };
}
