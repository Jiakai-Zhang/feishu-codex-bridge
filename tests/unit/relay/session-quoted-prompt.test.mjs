import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isSessionPromptAddressed, shouldIgnoreSessionGroupMessage } from "../../../src/relay/session-relay-core.mjs";

const source = await readFile(new URL("../../../src/app/session-relay.mjs", import.meta.url), "utf8");
const start = source.indexOf("async function processInboundMessage(");
const end = source.indexOf("async function handleChannelMessage(", start);
assert.ok(start >= 0 && end > start);

function fixture({ quoteFails = false, botQuote = false } = {}) {
  const calls = [];
  const quotedMessage = {
    messageId: "om_quote_test", chatId: "oc_test", senderId: botQuote ? "ou_bot_test" : "ou_member_test",
    senderIsBot: botQuote, resources: [{ type: "image", fileKey: "img_test" }],
  };
  const binding = { threadId: "thread_test", ownerOpenId: "ou_owner_test" };
  const env = {
    shouldIgnoreSessionGroupMessage,
    resolveRelayBinding: () => binding,
    inspectBinding: async () => ({ humanMemberCount: 2, participantOpenIds: ["ou_owner_test"] }),
    assertRelayMessage: msg => msg.content,
    config: { maxInputChars: 1000, sessionRelay: { inboundAttachments: { enabled: true } } },
    fetchFeishuQuotedMessage: async () => {
      calls.push("fetch");
      if (quoteFails) throw Object.assign(new Error("not available"), { code: "quoted_message_unavailable" });
      return quotedMessage;
    },
    channel: {},
    connectedBotOpenId: "ou_bot_test",
    isSessionPromptAddressed,
    sanitizePassiveGroupMessage: () => undefined,
    log: () => {},
    pruneInboundAttachmentCache: async ids => calls.push({ prune: ids }),
    inboundAttachmentStore: {},
    prepareFeishuPrompt: async (_msg, _channel, _store, options) => {
      calls.push({ prepare: options });
      return { text: "question with quoted image", attachments: [] };
    },
    processPreparedPrompt: async (_msg, _binding, prompt) => calls.push({ submit: prompt }),
    replyFailure: async (_msg, error) => calls.push({ failure: error.code }),
    persistCompleted: async () => {},
  };
  const inbound = new Function(...Object.keys(env), `${source.slice(start, end)}\nreturn processInboundMessage;`)(...Object.values(env));
  return { inbound, calls, quotedMessage };
}

const message = {
  messageId: "om_request_test", chatId: "oc_test", chatType: "group", rawContentType: "post",
  replyToMessageId: "om_quote_test", content: "look at this", resources: [],
};

test("a mentioned quote reaches prompt preparation once and protects both cache sources", async () => {
  const { inbound, calls, quotedMessage } = fixture();
  await inbound({ ...message, mentionedBot: true });
  assert.deepEqual(calls.filter(call => call === "fetch"), ["fetch"]);
  assert.deepEqual(calls.find(call => call.prune)?.prune, [message.messageId, quotedMessage.messageId]);
  assert.equal(calls.find(call => call.prepare)?.prepare.quotedMessage, quotedMessage);
  assert.equal(calls.some(call => call.submit), true);
  assert.equal(calls.some(call => call.failure), false);
});

test("quoting another member without addressing the bot never downloads or submits their image", async () => {
  const { inbound, calls } = fixture();
  await inbound({ ...message, mentionedBot: false });
  assert.deepEqual(calls, ["fetch"]);
});

test("replying to the bot still wakes the session without a mention", async () => {
  const { inbound, calls } = fixture({ botQuote: true });
  await inbound({ ...message, mentionedBot: false });
  assert.equal(calls.some(call => call.submit), true);
});

test("unreadable quotes fail closed before attachment preparation or Codex submission", async () => {
  const { inbound, calls } = fixture({ quoteFails: true });
  await inbound({ ...message, mentionedBot: true });
  assert.deepEqual(calls, ["fetch", { failure: "quoted_message_unavailable" }]);
});
