const OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;
const NORMALIZED_CONTACT_CARD = /^<contact_card id="([^"]*)"\/>$/;

export class FeishuUserCardError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "FeishuUserCardError";
    this.code = code;
  }
}

function openId(value) {
  const candidate = String(value || "").trim();
  return OPEN_ID.test(candidate) ? candidate : undefined;
}

function normalizedCardId(message) {
  if (message?.rawContentType !== "share_user") return undefined;
  return NORMALIZED_CONTACT_CARD.exec(String(message.content || "").trim())?.[1];
}

function rawCardId(item) {
  if (item?.msg_type !== "share_user") return undefined;
  try {
    const content = JSON.parse(String(item?.body?.content || ""));
    return String(content?.user_id || "").trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function resolveFeishuUserCardOpenId(message, { client } = {}) {
  if (message?.rawContentType !== "share_user") {
    throw new FeishuUserCardError("not_user_card", "The message is not a Feishu user card");
  }
  const direct = openId(normalizedCardId(message));
  if (direct) return direct;

  const messageId = String(message?.messageId || "").trim();
  const getMessage = client?.im?.v1?.message?.get;
  if (!messageId || typeof getMessage !== "function") {
    throw new FeishuUserCardError("user_card_identity_unavailable", "The user card identity cannot be resolved");
  }

  let response;
  try {
    response = await getMessage({
      path: { message_id: messageId },
      params: { user_id_type: "open_id" },
    });
  } catch (cause) {
    throw new FeishuUserCardError(
      "user_card_identity_unavailable",
      "The user card message could not be fetched",
      { cause },
    );
  }
  if (Number(response?.code || 0) !== 0) {
    throw new FeishuUserCardError("user_card_identity_unavailable", "The user card message lookup failed");
  }
  const items = Array.isArray(response?.data?.items) ? response.data.items : [];
  const item = items.find((candidate) => candidate?.message_id === messageId) || items[0];
  const resolved = openId(rawCardId(item));
  if (!resolved) {
    throw new FeishuUserCardError("user_card_identity_unavailable", "The user card did not contain an open_id");
  }
  return resolved;
}

export function publicFeishuUserCardFailure(error) {
  if (error?.code === "not_user_card") return "请重新发送一张飞书用户名片。";
  return "无法从这张名片确认当前应用中的成员身份；请重新发送名片，或改用 `/members add <目录名> @成员`。";
}
