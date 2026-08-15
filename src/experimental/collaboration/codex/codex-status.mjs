import { promises as fs } from "node:fs";

const DEFAULT_TAIL_BYTES = 2 * 1024 * 1024;

function finiteNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : undefined;
}

function payloadOf(event) {
  return event && typeof event.payload === "object" ? event.payload : undefined;
}

export async function readLatestRolloutSnapshot(rolloutPath, {
  maxTailBytes = DEFAULT_TAIL_BYTES,
} = {}) {
  const handle = await fs.open(rolloutPath, "r");
  try {
    const stat = await handle.stat();
    const size = stat.size;
    const length = Math.min(size, Math.max(4096, maxTailBytes));
    const offset = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    let usable = buffer.subarray(0, bytesRead);

    // The first bytes can be the tail of a UTF-8 JSONL record. Discard that
    // partial record rather than attempting to decode or parse it.
    if (offset > 0) {
      const newline = usable.indexOf(0x0a);
      usable = newline >= 0 ? usable.subarray(newline + 1) : Buffer.alloc(0);
    }

    let tokenCount;
    let lifecycle;
    for (const line of usable.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); }
      catch { continue; }
      const payload = payloadOf(event);
      if (!payload) continue;
      if (payload.type === "token_count" && payload.info) {
        tokenCount = {
          timestamp: event.timestamp,
          info: payload.info,
          rateLimits: payload.rate_limits,
        };
      }
      if (["task_started", "task_complete", "turn_aborted"].includes(payload.type)) {
        lifecycle = { type: payload.type, timestamp: event.timestamp };
      }
    }

    return { size, tokenCount, lifecycle };
  } finally {
    await handle.close();
  }
}

export function capacityView(snapshot) {
  const info = snapshot?.tokenCount?.info;
  const lastUsage = info?.last_token_usage;
  const contextWindow = finiteNumber(info?.model_context_window);
  const contextUsed = finiteNumber(lastUsage?.total_tokens);
  const contextRemaining = contextWindow !== undefined && contextUsed !== undefined
    ? Math.max(0, contextWindow - contextUsed)
    : undefined;
  const contextRemainingPercent = contextWindow > 0 && contextRemaining !== undefined
    ? (contextRemaining / contextWindow) * 100
    : undefined;

  const primary = snapshot?.tokenCount?.rateLimits?.primary;
  const accountUsedPercent = finiteNumber(primary?.used_percent);
  const accountRemainingPercent = accountUsedPercent !== undefined
    ? Math.max(0, 100 - accountUsedPercent)
    : undefined;

  return {
    measuredAt: snapshot?.tokenCount?.timestamp,
    contextWindow,
    contextUsed,
    contextRemaining,
    contextRemainingPercent,
    cumulativeTokens: finiteNumber(info?.total_token_usage?.total_tokens),
    accountUsedPercent,
    accountRemainingPercent,
    accountWindowMinutes: finiteNumber(primary?.window_minutes),
    accountResetsAt: finiteNumber(primary?.resets_at),
    planType: snapshot?.tokenCount?.rateLimits?.plan_type,
    rateLimitReachedType: snapshot?.tokenCount?.rateLimits?.rate_limit_reached_type,
  };
}

export function formatInteger(value) {
  return Number.isFinite(value) ? new Intl.NumberFormat("zh-CN").format(Math.round(value)) : "不可用";
}

export function formatPercent(value) {
  if (!Number.isFinite(value)) return "不可用";
  const digits = Math.abs(value - Math.round(value)) < 0.05 ? 0 : 1;
  return `${value.toFixed(digits)}%`;
}

export function formatTimestamp(value, { timeZone = "Asia/Taipei" } = {}) {
  if (value === undefined || value === null || value === "") return "不可用";
  const date = typeof value === "number"
    ? new Date(value > 10_000_000_000 ? value : value * 1000)
    : new Date(value);
  if (!Number.isFinite(date.getTime())) return "不可用";
  return date.toLocaleString("zh-CN", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatWindow(minutes) {
  if (!Number.isFinite(minutes)) return "不可用";
  if (minutes % 10080 === 0) return `${minutes / 10080} 周`;
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

export function buildModelMarkdown(thread) {
  if (!thread) return "当前绑定的 Codex 任务不存在。";
  return [
    "## 当前 Codex 模型",
    "",
    `- 模型：\`${thread.model || "不可用"}\``,
    `- 推理强度：\`${thread.reasoning_effort || "不可用"}\``,
    `- 提供方：\`${thread.model_provider || "不可用"}\``,
    `- Codex CLI：\`${thread.cli_version || "不可用"}\``,
    `- 当前任务：\`${thread.id}\``,
    "",
    "> 以上内容直接读取本机 Codex 状态数据库，没有调用语言模型。",
  ].join("\n");
}

export function buildCapacityMarkdown(snapshot) {
  const view = capacityView(snapshot);
  if (!snapshot?.tokenCount) {
    return [
      "## 剩余容量",
      "",
      "当前任务还没有可用的 token 计数记录。",
      "",
      "> 查询只读取本机 Codex rollout，没有调用语言模型。",
    ].join("\n");
  }
  const contextLine = view.contextRemaining === undefined
    ? "- 当前上下文剩余：不可用"
    : `- 当前上下文剩余：**${formatInteger(view.contextRemaining)} tokens（${formatPercent(view.contextRemainingPercent)}）**`;
  const contextUsageLine = view.contextUsed === undefined || view.contextWindow === undefined
    ? "- 最近一次上下文用量：不可用"
    : `- 最近一次上下文用量：${formatInteger(view.contextUsed)} / ${formatInteger(view.contextWindow)} tokens`;
  const accountLine = view.accountRemainingPercent === undefined
    ? "- 账户周期剩余：不可用"
    : `- 账户周期剩余：**${formatPercent(view.accountRemainingPercent)}**（已使用 ${formatPercent(view.accountUsedPercent)}）`;
  const resetLine = view.accountResetsAt === undefined
    ? "- 周期重置：不可用"
    : `- 周期窗口：${formatWindow(view.accountWindowMinutes)}；重置时间：${formatTimestamp(view.accountResetsAt)}`;
  return [
    "## 剩余容量",
    "",
    contextLine,
    contextUsageLine,
    accountLine,
    resetLine,
    `- 套餐：\`${view.planType || "不可用"}\``,
    `- 数据时间：${formatTimestamp(view.measuredAt)}`,
    "",
    "> 上下文剩余是最近一次 token 计数的近似值；新消息、工具输出和自动压缩会继续改变它。查询本身不调用语言模型。",
  ].join("\n");
}
