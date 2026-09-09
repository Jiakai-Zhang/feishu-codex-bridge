export function parseTemporaryChatCommand(value) {
  const text = String(value || "").trim();
  const match = /^\/(chat|endchat)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return undefined;
  const name = match[1].toLowerCase();
  const prompt = String(match[2] || "").trim();
  return Object.freeze({
    action: name === "chat" ? "start" : "end",
    prompt,
    raw: text,
  });
}

export function parseDirectSchedulePrompt(value) {
  const text = String(value || "").trim();
  const match = /^\/schedule(?:@[^\s]+)?(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return undefined;
  const args = String(match[1] || "").trim();
  return `/schedule${args ? ` ${args}` : ""}`;
}

export function resolveDirectPrivateSchedule({ value, chatType, hasBinding, isOwner }) {
  if (chatType !== "p2p" || hasBinding) return undefined;
  const prompt = parseDirectSchedulePrompt(value);
  if (prompt === undefined) return undefined;
  return Object.freeze({
    allowed: isOwner === true,
    command: Object.freeze({ action: "start", prompt }),
  });
}
