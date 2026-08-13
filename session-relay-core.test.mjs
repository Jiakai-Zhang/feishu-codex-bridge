import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMatchingNames,
  assertRelayMessage,
  assertSoloGroup,
  KeyedSerialQueue,
  planSessionNameSync,
  resolveCompletedTurnRoute,
} from "./session-relay-core.mjs";

const binding = {
  groupChatId: "oc_bound",
  threadId: "019ff5b8-decb-7ca3-802c-f115f2f196de",
  ownerOpenId: "ou_owner",
};

test("accepts an unmentioned owner text message in the exact bound group", () => {
  const content = assertRelayMessage({
    chatId: "oc_bound",
    chatType: "group",
    senderId: "ou_owner",
    senderIsBot: false,
    rawContentType: "text",
    mentionedBot: false,
    content: "  continue this task  ",
  }, binding);
  assert.equal(content, "  continue this task  ");
});

test("rejects another human, a bot, another group, and non-text content", () => {
  const message = {
    chatId: "oc_bound",
    chatType: "group",
    senderId: "ou_owner",
    senderIsBot: false,
    rawContentType: "text",
    content: "hello",
  };
  assert.throws(() => assertRelayMessage({ ...message, senderId: "ou_other" }, binding), /bound human owner/);
  assert.throws(() => assertRelayMessage({ ...message, senderIsBot: true }, binding), /bound human owner/);
  assert.throws(() => assertRelayMessage({ ...message, chatId: "oc_other" }, binding), /bound group/);
  assert.throws(() => assertRelayMessage({ ...message, rawContentType: "image" }, binding), /text messages only/);
});

test("requires exactly one owner and exactly the connected Bot", () => {
  const valid = {
    chatInfo: { chatType: "group", name: "Task", memberCount: 1 },
    members: [{ id: "ou_owner" }],
    bots: [{ id: "ou_bot", isBot: true }],
    binding,
    connectedBotOpenId: "ou_bot",
  };
  assert.equal(assertSoloGroup(valid), true);
  assert.throws(() => assertSoloGroup({ ...valid, members: [...valid.members, { id: "ou_other" }] }), /only human member/);
  assert.throws(() => assertSoloGroup({ ...valid, chatInfo: { ...valid.chatInfo, memberCount: 2 } }), /more than one human/);
  assert.throws(() => assertSoloGroup({ ...valid, bots: [...valid.bots, { id: "ou_other_bot" }] }), /only bot/);
  assert.throws(() => assertSoloGroup({ ...valid, bots: [{ id: "ou_wrong" }] }), /only bot/);
});

test("requires the Feishu group and Codex session names to match exactly", () => {
  assert.equal(assertMatchingNames("Task A", "Task A"), true);
  assert.throws(() => assertMatchingNames("Task A", "Task B"), /do not match/);
});

test("keeps Project-prefixed group names from renaming Codex tasks by default", () => {
  assert.deepEqual(
    planSessionNameSync("none", "auto_stigmator/荧光屏采集 (2)", "荧光屏采集 (2)"),
    { renameSessionTo: undefined },
  );
  assert.deepEqual(
    planSessionNameSync("group-to-session", "Legacy group", "Task"),
    { renameSessionTo: "Legacy group" },
  );
  assert.throws(
    () => planSessionNameSync("require-match", "Project/Task", "Task"),
    /do not match/,
  );
});

test("routes a mixed-client turn to its latest Feishu input", () => {
  const records = new Map([
    ["om_first", { chatId: "oc_bound", threadId: "omt_first" }],
    ["om_latest", { chatId: "oc_bound", threadId: "omt_latest" }],
  ]);
  const route = resolveCompletedTurnRoute({
    threadId: "codex-thread",
    chatId: "oc_fallback",
    promptEntries: [
      { clientId: "desktop-client", text: "initial" },
      { clientId: "om_first", text: "first Feishu steer" },
      { clientId: "cli-client", text: "Codex steer" },
      { clientId: "om_latest", text: "latest Feishu steer" },
      { clientId: "desktop-client", text: "last Codex steer" },
    ],
  }, { getInput: (messageId) => records.get(messageId) });

  assert.deepEqual(route, {
    kind: "reply",
    messageId: "om_latest",
    chatId: "oc_bound",
    threadId: "omt_latest",
    showPromptTimeline: true,
  });
});

test("keeps a Codex-only turn proactive and a single Feishu turn compact", () => {
  assert.deepEqual(resolveCompletedTurnRoute({
    threadId: "codex-thread",
    chatId: "oc_bound",
    promptEntries: [{ clientId: "desktop-client", text: "Desktop prompt" }],
  }), {
    kind: "send",
    chatId: "oc_bound",
    threadId: "codex-thread",
    showPromptTimeline: true,
  });
  assert.deepEqual(resolveCompletedTurnRoute({
    threadId: "codex-thread",
    chatId: "oc_bound",
    promptEntries: [{ clientId: "om_prompt", text: "Feishu prompt" }],
  }), {
    kind: "reply",
    messageId: "om_prompt",
    chatId: "oc_bound",
    threadId: undefined,
    showPromptTimeline: false,
  });
});

test("serializes work per session while allowing different sessions to proceed", async () => {
  const queue = new KeyedSerialQueue();
  const events = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = queue.enqueue("thread-a", async () => {
    events.push("a1-start");
    await gate;
    events.push("a1-end");
  });
  const second = queue.enqueue("thread-a", async () => events.push("a2"));
  const other = queue.enqueue("thread-b", async () => events.push("b1"));
  await other;
  assert.deepEqual(events, ["a1-start", "b1"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["a1-start", "b1", "a1-end", "a2"]);
});
