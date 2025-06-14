// src/types/actions.ts

export type ActionName =
  | 'SEND_MSG'
  | 'SEND_MSG_TO_GROUP'
  | 'MARK_AS_READ'
  | 'LOGOUT'
  | 'DOWNLOAD_MEDIA'
  | 'START_BROADCAST'
  | 'PAUSE_BROADCAST'
  | 'RESUME_BROADCAST'
  | 'CANCEL_BROADCAST';

// Response types for each action
export interface ActionResponseMap {
  SEND_MSG:
    | {
        success: true;
        data: { msgId: string };
      }
    | {
        success: false;
        error: string;
      };

  SEND_MSG_TO_GROUP:
    | {
        success: true;
        data: { msgId: string };
      }
    | {
        success: false;
        error: string;
      };

  MARK_AS_READ:
    | {
        success: true;
        data: { msgId: string };
      }
    | {
        success: false;
        error: string;
      };

  LOGOUT:
    | {
        success: true;
        data: { timestamp: string };
      }
    | {
        success: false;
        error: string;
      };

  DOWNLOAD_MEDIA:
    | {
        success: true;
        data: {
          messageId: string;
          mediaUrl: string;
          mediaType: string;
          mimeType?: string;
        };
      }
    | {
        success: false;
        error: string;
      };

  START_BROADCAST:
    | {
        success: true;
        data: {
          batchId: string;
          status: 'STARTED';
          timestamp: string;
        };
      }
    | {
        success: false;
        error: string;
      };

  PAUSE_BROADCAST:
    | {
        success: true;
        data: {
          batchId: string;
          status: 'PAUSED';
          timestamp: string;
        };
      }
    | {
        success: false;
        error: string;
      };

  RESUME_BROADCAST:
    | {
        success: true;
        data: {
          batchId: string;
          status: 'RESUMED';
          timestamp: string;
        };
      }
    | {
        success: false;
        error: string;
      };

  CANCEL_BROADCAST:
    | {
        success: true;
        data: {
          batchId: string;
          status: 'CANCELLED';
          timestamp: string;
        };
      }
    | {
        success: false;
        error: string;
      };
}

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

  PAUSE_BROADCAST: {
    batchId: string;
  };

  RESUME_BROADCAST: {
    batchId: string;
  };

  CANCEL_BROADCAST: {
    batchId: string;
    taskAgent?: 'DAISI' | 'META';
  };
}
