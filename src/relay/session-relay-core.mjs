export class SessionRelayError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "SessionRelayError";
    this.code = code;
  }
}

const RELAY_MESSAGE_TYPES = new Set(["text", "post", "image", "file", "audio", "video"]);

export function assertRelayMessage(msg, binding, { authorizedOpenIds = [binding?.ownerOpenId] } = {}) {
  if (!msg || msg.chatId !== binding.groupChatId) {
    throw new SessionRelayError("wrong_group", "Message is outside the bound group");
  }
  const expectedChatType = binding.temporary === true ? binding.chatType : "group";
  if (msg.chatType !== expectedChatType) {
    throw new SessionRelayError("not_group", "Session Relay accepts group messages only");
  }
  const authorized = new Set(authorizedOpenIds || []);
  if (msg.senderIsBot !== false || !authorized.has(msg.senderId)) {
    throw new SessionRelayError("untrusted_sender", "Message sender is not an authorized Session participant");
  }
  const resources = Array.isArray(msg.resources) ? msg.resources : [];
  if (!RELAY_MESSAGE_TYPES.has(String(msg.rawContentType || "")) || (msg.rawContentType !== "text" && resources.length === 0)) {
    throw new SessionRelayError("unsupported_message", "Session Relay accepts text, image, and file messages only");
  }
  const content = String(msg.content || "");
  if (!content.trim() && resources.length === 0) throw new SessionRelayError("empty_message", "Message has no usable content");
  return content;
}

export function assertSessionGroup({ chatInfo, members, bots, binding, connectedBotOpenId, activeOpenIds }) {
  if (chatInfo?.chatType !== "group") {
    throw new SessionRelayError("not_group", "The binding target is not an ordinary group");
  }
  if (!Array.isArray(members) || !members.some(({ id }) => id === binding.ownerOpenId)) {
    throw new SessionRelayError("owner_missing", "The Session owner must remain in the bound group");
  }
  if (!Array.isArray(bots) || bots.length !== 1 || bots[0]?.id !== connectedBotOpenId) {
    throw new SessionRelayError("unexpected_bot", "The group must contain exactly this Bridge Bot as its only bot");
  }
  const active = new Set(activeOpenIds || [binding.ownerOpenId]);
  if (!active.has(binding.ownerOpenId)) {
    throw new SessionRelayError("owner_inactive", "The Session owner is not an active Bridge user");
  }
  const unauthorizedMembers = members.filter(({ id }) => !active.has(id));
  if (unauthorizedMembers.length > 0) {
    throw new SessionRelayError(
      "unregistered_member",
      "Every human member of a Session group must be an active Bridge user",
    );
  }
  const participantOpenIds = members.map(({ id }) => id);
  return Object.freeze({
    participantOpenIds: Object.freeze(participantOpenIds),
    humanMemberCount: members.length,
  });
}

export function assertSoloGroup({ chatInfo, members, bots, binding, connectedBotOpenId }) {
  if (chatInfo?.chatType !== "group") {
    throw new SessionRelayError("not_group", "The binding target is not an ordinary group");
  }
  const reportedHumanCount = Number(chatInfo?.memberCount);
  if (Number.isFinite(reportedHumanCount) && reportedHumanCount !== 1) {
    throw new SessionRelayError("not_solo", "The group reports more than one human member");
  }
  if (!Array.isArray(members) || members.length !== 1 || members[0]?.id !== binding.ownerOpenId) {
    throw new SessionRelayError("not_solo", "The group must contain exactly the bound owner as its only human member");
  }
  if (!Array.isArray(bots) || bots.length !== 1 || bots[0]?.id !== connectedBotOpenId) {
    throw new SessionRelayError("not_solo", "The group must contain exactly this Bridge Bot as its only bot");
  }
  return true;
}

export function isSessionPromptAddressed(msg, { humanMemberCount = 1, replyToBot = false } = {}) {
  if (msg?.chatType !== "group" || Number(humanMemberCount) <= 1) return true;
  return Boolean(msg?.mentionedBot || replyToBot);
}

export function assertMatchingNames(groupName, sessionTitle) {
  const group = String(groupName || "").trim();
  const session = String(sessionTitle || "").trim();
  if (!group) throw new SessionRelayError("group_name_missing", "The bound group has no name");
  if (!session) throw new SessionRelayError("session_name_missing", "The bound Codex session has no name");
  if (group !== session) {
    throw new SessionRelayError("name_mismatch", "The Feishu group name and Codex session name do not match");
  }
  return true;
}

export function planSessionNameSync(mode, groupName, sessionTitle) {
  const policy = String(mode || "none").trim().toLowerCase();
  if (policy === "none") return Object.freeze({ renameSessionTo: undefined });
  if (policy === "require-match") {
    assertMatchingNames(groupName, sessionTitle);
    return Object.freeze({ renameSessionTo: undefined });
  }
  if (policy === "group-to-session") {
    const group = String(groupName || "").trim();
    const session = String(sessionTitle || "").trim();
    if (!group) throw new SessionRelayError("group_name_missing", "The bound group has no name");
    if (!session) throw new SessionRelayError("session_name_missing", "The bound Codex session has no name");
    return Object.freeze({ renameSessionTo: group === session ? undefined : group });
  }
  throw new TypeError("Unsupported Session Relay name sync policy");
}

function defaultFeishuMessageClientId(clientId) {
  return typeof clientId === "string" && /^om_[A-Za-z0-9_-]+$/.test(clientId);
}

export function resolveCompletedTurnRoute(record, {
  getInput = () => undefined,
  isFeishuClientId = defaultFeishuMessageClientId,
} = {}) {
  const promptEntries = Array.isArray(record?.promptEntries) ? record.promptEntries : [];
  let latestFeishuEntry;
  for (let index = promptEntries.length - 1; index >= 0; index -= 1) {
    if (isFeishuClientId(promptEntries[index]?.clientId)) {
      latestFeishuEntry = promptEntries[index];
      break;
    }
  }
  if (!latestFeishuEntry) {
    return Object.freeze({
      kind: "send",
      chatId: record?.chatId,
      threadId: record?.threadId,
      showPromptTimeline: promptEntries.length > 0,
    });
  }
  const messageId = String(latestFeishuEntry.clientId);
  const accepted = getInput(messageId);
  return Object.freeze({
    kind: "reply",
    messageId,
    chatId: accepted?.chatId || record?.chatId,
    threadId: accepted?.threadId,
    showPromptTimeline: promptEntries.length > 1,
  });
}

export class KeyedSerialQueue {
  constructor() {
    this.tails = new Map();
  }

  enqueue(key, work) {
    const previous = this.tails.get(key) || Promise.resolve();
    const running = previous.catch(() => {}).then(work);
    const tail = running.catch(() => {}).finally(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    this.tails.set(key, tail);
    return running;
  }
}
