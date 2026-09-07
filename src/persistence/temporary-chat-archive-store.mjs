import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  parseCodexDesktopFilePrompt,
  parseFeishuAttachmentContexts,
  stripFeishuAttachmentContexts,
} from "../feishu/feishu-inbound-attachment.mjs";

function timestamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return new Date(number < 1_000_000_000_000 ? number * 1_000 : number).toISOString();
}

function resourceName(value, fallback) {
  const name = path.basename(String(value || "").replace(/[?#].*$/, ""));
  return name || fallback;
}

function archiveKey(threadId) {
  return createHash("sha256").update(threadId).digest("hex").slice(0, 16);
}

function userContent(item) {
  const parts = [];
  for (const part of item?.content || []) {
    if (part?.type === "text") {
      const rawText = String(part.text || "");
      const withoutLegacyContext = stripFeishuAttachmentContexts(rawText);
      const desktopFilePrompt = parseCodexDesktopFilePrompt(withoutLegacyContext);
      const text = String(desktopFilePrompt?.text ?? withoutLegacyContext).trim();
      if (text) parts.push(text);
      for (const attachment of parseFeishuAttachmentContexts(rawText)) {
        parts.push(`_[附件：${resourceName(attachment.name || attachment.localPath, "未命名附件")}]_`);
      }
      for (const file of desktopFilePrompt?.files || []) {
        parts.push(`_[附件：${resourceName(file.name || file.path, "未命名附件")}]_`);
      }
    } else if (part?.type === "localImage") {
      parts.push(`_[图片：${resourceName(part.path, "未命名图片")}]_`);
    } else if (part?.type === "image") {
      parts.push(`_[图片：${resourceName(part.url, "远程图片")}]_`);
    } else if (part?.type === "localAudio") {
      parts.push(`_[音频：${resourceName(part.path, "未命名音频")}]_`);
    } else if (part?.type === "audio") {
      parts.push(`_[音频：${resourceName(part.url, "远程音频")}]_`);
    } else if (part?.type === "mention") {
      parts.push(`_[附件：${resourceName(part.name || part.path, "未命名附件")}]_`);
    } else if (part?.type === "skill") {
      parts.push(`_[Skill：${String(part.name || "未命名")}]_`);
    } else if (part?.type) {
      parts.push(`_[${String(part.type)}]_`);
    }
  }
  return parts.join("\n\n").trim();
}

function publicEntries(turn) {
  const entries = [];
  for (const item of turn?.items || []) {
    if (item?.type === "userMessage") {
      const text = userContent(item);
      if (text) entries.push({ label: "用户", text });
      continue;
    }
    if (item?.type === "agentMessage") {
      const text = String(item.text || "").trim();
      if (!text) continue;
      entries.push({
        label: item.phase === "commentary" ? "Codex（过程）" : "Codex",
        text,
      });
      continue;
    }
    if (item?.type === "plan") {
      const text = String(item.text || "").trim();
      if (text) entries.push({ label: "Codex（计划）", text });
    }
  }
  return entries;
}

export function renderTemporaryChatArchive(record, thread) {
  const lines = [
    "# 临时 Codex 对话归档",
    "",
    `- 创建时间：${timestamp(record?.createdAt) || "未知"}`,
    `- 退出时间：${timestamp(record?.endedAt) || "未知"}`,
    "",
  ];
  let visibleTurns = 0;
  for (const [index, turn] of (thread?.turns || []).entries()) {
    const entries = publicEntries(turn);
    if (entries.length === 0) continue;
    visibleTurns += 1;
    lines.push(`## 第 ${index + 1} 轮`, "");
    for (const entry of entries) lines.push(`### ${entry.label}`, "", entry.text, "");
  }
  if (visibleTurns === 0) lines.push("（没有可归档的公开对话内容）", "");
  return `${lines.join("\n").trimEnd()}\n`;
}

export class TemporaryChatArchiveStore {
  constructor(directoryPath) {
    if (!directoryPath) throw new TypeError("Temporary Chat archive directory is required");
    this.directoryPath = path.resolve(directoryPath);
  }

  filePath(record) {
    const threadId = String(record?.threadId || "");
    if (!threadId) throw new TypeError("Temporary Chat archive requires threadId");
    const createdAt = timestamp(record?.createdAt) || new Date(0).toISOString();
    const datePrefix = createdAt.replace(/[:.]/g, "-");
    return path.join(this.directoryPath, `${datePrefix}_${archiveKey(threadId)}.md`);
  }

  async has(record) {
    try {
      await fs.access(this.filePath(record));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async archive(record, thread) {
    const threadId = String(record?.threadId || "");
    if (!threadId || String(thread?.id || "") !== threadId) {
      throw new TypeError("Temporary Chat archive thread does not match its record");
    }
    const destination = this.filePath(record);
    if (await this.has(record)) return destination;
    await fs.mkdir(this.directoryPath, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directoryPath, `.${path.basename(destination)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, renderTemporaryChatArchive(record, thread), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await fs.rename(temporary, destination);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      if (error?.code === "EEXIST" && await this.has(record)) return destination;
      throw error;
    }
    return destination;
  }
}
