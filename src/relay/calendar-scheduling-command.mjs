const CALENDAR_COMMAND_PATTERN = /^\/schedule(?:@[^\s]+)?(?:\s+([\s\S]*))?$/i;

export function parseCalendarSchedulingCommand(value) {
  const text = String(value || "").trim();
  const match = CALENDAR_COMMAND_PATTERN.exec(text);
  if (!match) return undefined;
  return Object.freeze({
    request: String(match[1] || "").trim(),
    raw: text,
  });
}

export function buildCalendarSchedulingPrompt(request) {
  const normalized = String(request || "").trim();
  if (!normalized) throw new TypeError("A natural-language calendar request is required");

  return [
    "请作为飞书日历助理处理下面的自然语言请求。",
    "",
    "执行协议：",
    "1. 必须完整读取并遵循可用的 `lark-calendar` Skill；涉及参会人时同时使用 `lark-contact` Skill。若本次 Session 未直接列出这些 Skill，先通过 `lark-cli skills read <skill>` 及其引用文件读取同版本说明；若命令不在 PATH，则使用 `$env:FEISHU_CODEX_BRIDGE_HOME\\lark-cli.ps1 skills read <skill>`。",
    "2. 所有个人日历读取和写入都使用飞书用户身份（`--as user`），不得改用 Bot 日历。",
    "3. 先判断这是新建还是修改已有日程；修改时必须先唯一定位原日程。时间换算必须查询当前系统时间和时区，并在 API 参数中使用带明确时区偏移的时间。",
    "4. 本条请求的第一次处理只能解析需求、查询联系人/忙闲/候选时间/会议室，并展示清晰的日程方案。即使用户原话包含“创建”“预定”或“直接安排”，也不得在这一步写入日历。",
    "5. 只有用户在后续消息中对展示的具体方案明确确认后，才能创建或更新日程；存在时间冲突、候选时间、重名联系人或会议室选择时，必须先让用户选择。",
    "6. 写入后必须以 lark-cli 返回 `ok == true` 为成功依据，并简洁回复最终标题、时间、时区、参会人和会议室。不要输出 App Secret、token、App ID、open ID、chat ID、Codex 任务标识或本机路径。",
    "7. 若缺少用户授权或应用权限，只说明所缺权限及安全授权步骤，不索取或输出任何密钥。",
    "",
    "用户的日历请求：",
    "<calendar_request>",
    normalized,
    "</calendar_request>",
  ].join("\n");
}
