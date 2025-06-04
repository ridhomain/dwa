import { AnyMessageContent, WASocket } from 'baileys';

export const sendMessage = async (
  sock: WASocket,
  msg: AnyMessageContent,
  jid: string,
  quoted: any
) => {
  let sentMsg;

  try {
    if (quoted) {
      sentMsg = await sock.sendMessage(jid, msg, { quoted });
    } else {
      sentMsg = await sock.sendMessage(jid, msg);
    }

    if (!sentMsg) {
      return { success: false, errMessage: `sent msg error jid: ${jid}`, sentMsg };
    }

    return { success: true, sentMsg };
  } catch (err: any) {
    return { success: false, errMessage: err.message, sentMsg };
  }
};
