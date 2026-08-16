import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildCalendarSchedulingPrompt,
  parseCalendarSchedulingCommand,
} from "../../../src/relay/calendar-scheduling-command.mjs";

test("parses a natural-language scheduling command and optional bot mention", () => {
  assert.deepEqual(parseCalendarSchedulingCommand("/schedule 明天下午三点开会"), {
    request: "明天下午三点开会",
    raw: "/schedule 明天下午三点开会",
  });
  assert.deepEqual(parseCalendarSchedulingCommand("/schedule@relay_bot  下周找一小时和张三评审"), {
    request: "下周找一小时和张三评审",
    raw: "/schedule@relay_bot  下周找一小时和张三评审",
  });
  assert.deepEqual(parseCalendarSchedulingCommand("/schedule"), {
    request: "",
    raw: "/schedule",
  });
  assert.equal(parseCalendarSchedulingCommand("请 /schedule 一个会议"), undefined);
  assert.equal(parseCalendarSchedulingCommand("/scheduled 明天开会"), undefined);
});

test("builds a privacy-safe confirmation-first calendar prompt", () => {
  const prompt = buildCalendarSchedulingPrompt("明天下午三点和张三开会");
  assert.match(prompt, /`lark-calendar` Skill/);
  assert.match(prompt, /`lark-contact` Skill/);
  assert.match(prompt, /FEISHU_CODEX_BRIDGE_HOME/);
  assert.match(prompt, /`--as user`/);
  assert.match(prompt, /第一次处理只能解析需求/);
  assert.match(prompt, /明确确认后/);
  assert.match(prompt, /明天下午三点和张三开会/);
  assert.match(prompt, /不要输出 App Secret、token、App ID、open ID、chat ID/);
  assert.throws(() => buildCalendarSchedulingPrompt("  "), /required/);
});

test("stable relay recognizes /schedule before requiring a binding", async () => {
  const source = await readFile(new URL("../../../src/app/session-relay.mjs", import.meta.url), "utf8");
  const inbound = source.slice(source.indexOf("async function processInboundMessage"));
  assert.ok(inbound.indexOf("parseCalendarSchedulingCommand") < inbound.indexOf("if (!binding)"));
  assert.match(source, /buildCalendarSchedulingPrompt\(command\.request\)/);
});
