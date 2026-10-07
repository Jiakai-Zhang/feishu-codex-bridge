import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { shouldIgnoreSessionGroupMessage } from "../../../src/relay/session-relay-core.mjs";

const source = await readFile(new URL("../../../src/app/session-relay.mjs", import.meta.url), "utf8");
const failureStart = source.indexOf("function isSilentRosterNetworkFailure(");
const failureEnd = source.indexOf("async function queueDeliveryBundle(", failureStart);
assert.ok(failureStart >= 0 && failureEnd > failureStart);
const createFailureHandler = new Function(
  "channel", "persistCompleted", "log", "publicFailure", "publicBindingFailure", "safeError",
  `${source.slice(failureStart, failureEnd)}\nreturn replyFailure;`,
);
const rosterFailure = category => ({ code: "roster_unavailable", cause: { category } });

function fixture() {
  const replies = [];
  const completed = [];
  const logs = [];
  const handler = createFailureHandler(
    { reply: async (_msg, content) => replies.push(content) },
    async id => completed.push(id), message => logs.push(message),
    () => "normal failure", () => "binding failure", () => "redacted error",
  );
  return { handler, replies, completed, logs };
}

test("silences direct and wrapped roster network failures without sending a reply", async () => {
  for (const bindingSetup of [false, true]) {
    for (const error of [
      rosterFailure("network"),
      { code: "target_group_verification_failed", cause: rosterFailure("network") },
    ]) {
      const { handler, replies, completed, logs } = fixture();
      await handler({ messageId: "message-fixture" }, error, { bindingSetup });
      assert.deepEqual(replies, []);
      assert.deepEqual(completed, ["message-fixture"]);
      assert.match(logs[0], /not forwarded to Codex/);
      assert.doesNotMatch(logs[0], /message-fixture/);
    }
  }
});

test("retains actionable permission, membership and unclassified failure replies", async () => {
  for (const bindingSetup of [false, true]) {
    for (const error of [
      rosterFailure("permission"), rosterFailure("unknown"), { code: "roster_unavailable" },
      { code: "inactive_member" }, { code: "owner_missing" }, { code: "unexpected_bot" },
      { code: "target_group_verification_failed", cause: rosterFailure("permission") },
      { code: "codex_app_server_timeout", cause: { category: "network" } },
    ]) {
      const { handler, replies, completed } = fixture();
      await handler({ messageId: "message-fixture" }, error, { bindingSetup });
      assert.deepEqual(replies, [bindingSetup ? { markdown: "binding failure" } : { text: "normal failure" }]);
      assert.deepEqual(completed, ["message-fixture"]);
    }
  }
});

test("failed group verification still stops inbound handling before authorization or Codex input", async () => {
  const start = source.indexOf("async function processInboundMessage(");
  const end = source.indexOf("async function handleChannelMessage(", start);
  assert.ok(start >= 0 && end > start);
  const createInboundHandler = new Function(
    "resolveRelayBinding", "inspectBinding", "replyFailure", "assertRelayMessage", "processPreparedPrompt",
    "shouldIgnoreSessionGroupMessage",
    `${source.slice(start, end)}\nreturn processInboundMessage;`,
  );
  const { handler, replies, completed } = fixture();
  let authorized = false;
  let submitted = false;
  const inbound = createInboundHandler(
    () => ({ threadId: "thread-fixture", ownerOpenId: "owner-fixture" }),
    async () => { throw rosterFailure("network"); }, handler,
    () => { authorized = true; return "work"; }, async () => { submitted = true; },
    shouldIgnoreSessionGroupMessage,
  );
  await inbound({ rawContentType: "post", messageId: "message-fixture", chatId: "chat-fixture", content: "work" });
  assert.equal(authorized, false);
  assert.equal(submitted, false);
  assert.deepEqual(replies, []);
  assert.deepEqual(completed, ["message-fixture"]);
});

test("group stickers and unsupported content are ignored before roster lookup, even when mentioned or replied to", async () => {
  const start = source.indexOf("async function processInboundMessage(");
  const end = source.indexOf("async function handleChannelMessage(", start);
  const createInboundHandler = new Function(
    "shouldIgnoreSessionGroupMessage", "persistCompleted", "log", "safeError", "resolveRelayBinding", "replyFailure",
    `${source.slice(start, end)}\nreturn processInboundMessage;`,
  );
  for (const rawContentType of ["sticker", "merge_forward", "system", "unknown"]) {
    for (const persistFails of [false, true]) {
      const completed = [];
      const unexpected = [];
      const inbound = createInboundHandler(
        shouldIgnoreSessionGroupMessage,
        async id => { completed.push(id); if (persistFails) throw new Error("disk unavailable"); },
        () => {}, () => "redacted error",
        () => unexpected.push("binding lookup"), async () => unexpected.push("failure reply"),
      );
      await inbound({
        chatType: "group", rawContentType, messageId: "message-fixture", chatId: "chat-fixture",
        mentionedBot: true, threadId: "reply-fixture", content: "unsupported content",
        resources: [{ type: "file", fileKey: "resource-fixture" }],
      });
      assert.deepEqual(completed, ["message-fixture"]);
      assert.deepEqual(unexpected, []);
    }
  }
});

test("binding setup and bind command share the same silent network failure policy", () => {
  const start = source.indexOf("async function processBindingSetupMessage(");
  const end = source.indexOf("async function processTodoMessage(", start);
  assert.ok(start >= 0 && end > start);
  assert.equal(source.slice(start, end).match(/replyFailure\(msg, error, \{ bindingSetup: true \}\)/g)?.length, 2);
});
