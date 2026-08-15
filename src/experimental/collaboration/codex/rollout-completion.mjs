import { promises as fs } from "node:fs";
import { StringDecoder } from "node:string_decoder";

function assistantText(payload) {
  if (payload?.type === "agent_message" && typeof payload.message === "string") {
    return payload.message.trim();
  }
  if (payload?.type !== "message" || payload.role !== "assistant") return "";
  if (!Array.isArray(payload.content)) return "";
  return payload.content
    .filter((item) => item?.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

export async function createRolloutCompletionWatcher(rolloutPath, {
  stableMs = 15_000,
  now = Date.now,
  chunkBytes = 64 * 1024,
} = {}) {
  const initial = await fs.stat(rolloutPath);
  let offset = initial.size;
  let remainder = "";
  let decoder = new StringDecoder("utf8");
  let lastAssistantText = "";
  let completion;

  const consumeLine = (line) => {
    if (!line) return;
    let record;
    try { record = JSON.parse(line); }
    catch { return; }

    const payload = record?.payload;
    const text = assistantText(payload);
    if (text) lastAssistantText = text;
    if (record?.type === "event_msg" && payload?.type === "task_complete" && lastAssistantText) {
      completion = {
        answer: lastAssistantText,
        seenAt: now(),
      };
    }
  };

  const readNewBytes = async () => {
    const stat = await fs.stat(rolloutPath);
    if (stat.size < offset) {
      // A replaced/truncated rollout cannot safely inherit terminal state from
      // the previous inode. Resume from the new end and wait for a new event.
      offset = stat.size;
      remainder = "";
      decoder = new StringDecoder("utf8");
      lastAssistantText = "";
      completion = undefined;
      return;
    }
    if (stat.size === offset) return;

    const handle = await fs.open(rolloutPath, "r");
    try {
      while (offset < stat.size) {
        const length = Math.min(chunkBytes, stat.size - offset);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        const lines = `${remainder}${decoder.write(buffer.subarray(0, bytesRead))}`.split("\n");
        remainder = lines.pop() ?? "";
        for (const line of lines) consumeLine(line);
      }
    } finally {
      await handle.close();
    }
  };

  return {
    async poll() {
      await readNewBytes();
      if (!completion || now() - completion.seenAt < stableMs) return undefined;
      return { ...completion };
    },
    get offset() { return offset; },
  };
}
