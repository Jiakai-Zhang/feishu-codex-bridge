import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseTemporaryChatCommand } from "../../../src/relay/temporary-chat-command.mjs";

test("parses temporary Chat lifecycle commands without treating the first prompt as a title", () => {
  assert.deepEqual(parseTemporaryChatCommand("/chat"), {
    action: "start",
    prompt: "",
    raw: "/chat",
  });
  assert.deepEqual(parseTemporaryChatCommand("/chat 帮我分析这个问题"), {
    action: "start",
    prompt: "帮我分析这个问题",
    raw: "/chat 帮我分析这个问题",
  });
  assert.deepEqual(parseTemporaryChatCommand("/endchat@relay_bot"), {
    action: "end",
    prompt: "",
    raw: "/endchat@relay_bot",
  });
  assert.equal(parseTemporaryChatCommand("please /chat"), undefined);
});

test("wires temporary Chat before the unbound private-message fallback", async () => {
  const source = await readFile(new URL("../../../src/app/session-relay.mjs", import.meta.url), "utf8");
  const inbound = source.slice(
    source.indexOf("async function processInboundMessage"),
    source.indexOf('channel.on("message"'),
  );
  assert.ok(inbound.indexOf("parseTemporaryChatCommand") < inbound.indexOf("if (!binding)"));
  assert.match(source, /TemporaryChatStore\.open/);
  assert.match(source, /ensureSessionControllerTarget/);
  assert.match(source, /temporaryChats\.list\(\)/);
});
