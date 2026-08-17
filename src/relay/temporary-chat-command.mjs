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
