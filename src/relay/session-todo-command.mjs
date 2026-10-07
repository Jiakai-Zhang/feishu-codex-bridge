const WEEKDAYS = Object.freeze({
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
});

export class SessionTodoCommandError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionTodoCommandError";
    this.code = code;
    this.publicMessage = message;
  }
}

function usage(message = "用法：`/todo [今天|明天|后天|周五|下周一|YYYY-MM-DD] <待办事项>`") {
  throw new SessionTodoCommandError("todo_usage", message);
}

function zonedDate(nowMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function addDays(value, days) {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function compareDate(left, right) {
  return Date.UTC(left.year, left.month - 1, left.day) - Date.UTC(right.year, right.month - 1, right.day);
}

function validDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function isoDate(value) {
  return [value.year, value.month, value.day]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
}

function cleanSummary(value) {
  const summary = String(value || "")
    .trim()
    .replace(/^(?:需要|提醒我|记得|要|需)\s*/, "")
    .trim();
  if (!summary) usage("请在 `/todo` 后写明待办事项，例如：`/todo 明天要给老师写报告`。");
  return summary;
}

export function parseTodoInvocation(value) {
  const text = String(value || "").trim();
  const match = /^\/todo(?:@[^\s]+)?(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return undefined;
  return String(match[1] || "").trim();
}

export function todoIdempotencyKey(messageId) {
  const compact = String(messageId || "").replace(/[^a-zA-Z0-9]/g, "");
  if (!compact) throw new TypeError("messageId is required");
  return `feishu-todo-${compact.slice(-32)}`;
}

export function parseTodoRequest(value, {
  nowMs = Date.now(),
  timeZone = "Asia/Shanghai",
} = {}) {
  const text = String(value || "").trim();
  if (!text) usage("请在 `/todo` 后写明待办事项，例如：`/todo 明天要给老师写报告`。");
  const today = zonedDate(nowMs, timeZone);
  let due;
  let remainder = text;

  const relative = /^(今天|明天|后天)\s*([\s\S]*)$/.exec(text);
  if (relative) {
    due = addDays(today, { 今天: 0, 明天: 1, 后天: 2 }[relative[1]]);
    remainder = relative[2];
  } else {
    const absolute = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:日)?\s*([\s\S]*)$/.exec(text);
    if (absolute) {
      due = { year: Number(absolute[1]), month: Number(absolute[2]), day: Number(absolute[3]) };
      if (!validDate(due.year, due.month, due.day)) usage("截止日期无效，请使用真实日期，例如 `2026-10-01`。");
      remainder = absolute[4];
    } else {
      const monthDay = /^(\d{1,2})月(\d{1,2})日?\s*([\s\S]*)$/.exec(text);
      if (monthDay) {
        due = { year: today.year, month: Number(monthDay[1]), day: Number(monthDay[2]) };
        if (!validDate(due.year, due.month, due.day)) usage("截止日期无效，请使用真实日期，例如 `10月1日`。");
        if (compareDate(due, today) < 0) due = { ...due, year: due.year + 1 };
        remainder = monthDay[3];
      } else {
        const weekday = /^(本周|这周|下周|周|星期)([一二三四五六日天])\s*([\s\S]*)$/.exec(text);
        if (weekday) {
          const todayWeekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay() || 7;
          const targetWeekday = WEEKDAYS[weekday[2]];
          let offset;
          if (weekday[1] === "下周") offset = 7 - todayWeekday + targetWeekday;
          else if (weekday[1] === "本周" || weekday[1] === "这周") offset = targetWeekday - todayWeekday;
          else {
            offset = (targetWeekday - todayWeekday + 7) % 7;
            if (offset === 0) offset = 7;
          }
          due = addDays(today, offset);
          remainder = weekday[3];
        }
      }
    }
  }

  return Object.freeze({
    summary: cleanSummary(remainder),
    due: due ? isoDate(due) : undefined,
  });
}

export function formatTodoSuccess({ summary, due, url }) {
  const lines = [
    "### 已创建飞书待办",
    "",
    `- 事项：${String(summary || "").trim()}`,
    `- 截止：${due ? `${due}（全天）` : "未设置"}`,
  ];
  if (url) lines.push("", `[在飞书任务中打开](${url})`);
  return lines.join("\n");
}

export function publicTodoFailure(error) {
  if (error?.publicMessage) return error.publicMessage;
  switch (error?.code) {
    case "task_auth_required":
      return "当前飞书用户尚未授权 `task:task:write`。请完成飞书任务权限增量授权后重试。";
    case "task_cli_unavailable":
      return "本机飞书 CLI 当前不可用，暂时无法创建待办。";
    default:
      return "飞书待办创建失败，请稍后重试。";
  }
}
