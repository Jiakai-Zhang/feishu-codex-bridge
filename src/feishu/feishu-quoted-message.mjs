import { normalize } from "@larksuite/channel";
import { FeishuInboundAttachmentError } from "./feishu-inbound-attachment.mjs";

const QUOTABLE_MESSAGE_TYPES = new Set(["text", "post", "image", "file", "audio", "video", "media"]);

// The SDK's fetchMessage currently discards chat_id. Retain that boundary
// before using its normalizer, and never expand forwarded messages or ancestors.
export async function fetchFeishuQuotedMessage(message, channel) {
  if (!message?.replyToMessageId) return undefined;
  try {
    if (message.replyToMessageId === message.messageId) throw new Error("Message cannot quote itself");
    const response = await channel.rawClient.im.v1.message.get({
      path: { message_id: message.replyToMessageId },
    });
    const parent = response?.data?.items?.find((item) => item.message_id === message.replyToMessageId);
    if (response?.code || !parent || parent.deleted || !message.chatId || parent.chat_id !== message.chatId) {
      throw new Error("Quoted message is unavailable in this conversation");
    }
    const senderIsBot = parent.sender?.sender_type === "app" || parent.sender?.sender_type === "bot";
    if (!QUOTABLE_MESSAGE_TYPES.has(parent.msg_type)) {
      return Object.freeze({
        messageId: parent.message_id,
        chatId: parent.chat_id,
        senderId: parent.sender?.id,
        senderIsBot,
        rawContentType: parent.msg_type,
        content: "",
        resources: [],
      });
    }
    const result = await normalize({
      sender: {
        sender_id: { open_id: parent.sender?.id },
        sender_type: senderIsBot ? "bot" : "user",
      },
      message: {
        message_id: parent.message_id,
        chat_id: parent.chat_id,
        chat_type: message.chatType,
        message_type: parent.msg_type,
        content: parent.body?.content ?? "",
        mentions: parent.mentions,
      },
    }, { botIdentity: channel.botIdentity, stripBotMentions: false });
    if (!["text", "post"].includes(parent.msg_type) && !result.resources?.length) {
      throw new Error("Quoted attachment could not be decoded");
    }
    return result;
  } catch (cause) {
    // Never expose raw SDK errors (which may contain authorization headers).
    throw new FeishuInboundAttachmentError("quoted_message_unavailable", "The directly quoted message could not be read", { cause });
  }
}
