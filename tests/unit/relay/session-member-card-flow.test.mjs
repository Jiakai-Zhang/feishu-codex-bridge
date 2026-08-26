import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SessionMemberCardFlow } from "../../../src/relay/session-member-card-flow.mjs";

test("collects one safe directory name after the owner sends a user card", () => {
  const flow = new SessionMemberCardFlow({ now: () => 1_000 });
  const started = flow.begin({
    conversationId: "chat:owner",
    actorOpenId: "ou_owner",
    target: { openId: "ou_member" },
  });
  const completed = flow.handle({
    conversationId: "chat:owner",
    actorOpenId: "ou_owner",
    text: "alice",
  });

  assert.match(started.reply, /一级目录名/);
  assert.equal(completed.action, "add");
  assert.equal(completed.directoryName, "alice");
  assert.deepEqual(completed.target, { openId: "ou_member", name: undefined });
  assert.equal(flow.has("chat:owner"), true);
  flow.cancel("chat:owner");
  assert.equal(flow.has("chat:owner"), false);
});

test("keeps the card selection while rejecting an unsafe directory name", () => {
  const flow = new SessionMemberCardFlow();
  flow.begin({
    conversationId: "chat:owner",
    actorOpenId: "ou_owner",
    target: { openId: "ou_member" },
  });

  const result = flow.handle({
    conversationId: "chat:owner",
    actorOpenId: "ou_owner",
    text: "two words",
  });

  assert.equal(result.handled, true);
  assert.equal(result.action, undefined);
  assert.match(result.reply, /目录名无效/);
  assert.equal(flow.has("chat:owner"), true);
});

test("supports cancellation and releases slash commands to the normal router", () => {
  const flow = new SessionMemberCardFlow();
  flow.begin({
    conversationId: "chat:cancel",
    actorOpenId: "ou_owner",
    target: { openId: "ou_member" },
  });
  const cancelled = flow.handle({
    conversationId: "chat:cancel",
    actorOpenId: "ou_owner",
    text: "/cancel",
  });
  assert.equal(cancelled.handled, true);
  assert.equal(flow.has("chat:cancel"), false);

  flow.begin({
    conversationId: "chat:command",
    actorOpenId: "ou_owner",
    target: { openId: "ou_member" },
  });
  const command = flow.handle({
    conversationId: "chat:command",
    actorOpenId: "ou_owner",
    text: "/members",
  });
  assert.deepEqual(command, { handled: false });
  assert.equal(flow.has("chat:command"), false);
});

test("expires an abandoned card flow", () => {
  let now = 1_000;
  const flow = new SessionMemberCardFlow({ now: () => now, ttlMs: 100 });
  flow.begin({
    conversationId: "chat:owner",
    actorOpenId: "ou_owner",
    target: { openId: "ou_member" },
  });
  now = 1_101;
  assert.equal(flow.has("chat:owner"), false);
  assert.deepEqual(flow.handle({
    conversationId: "chat:owner",
    actorOpenId: "ou_owner",
    text: "alice",
  }), { handled: false });
});

test("wires user cards and their pending directory reply before normal Session routing", async () => {
  const source = await readFile(new URL("../../../src/app/session-relay.mjs", import.meta.url), "utf8");
  const inbound = source.slice(
    source.indexOf("async function processInboundMessage"),
    source.indexOf('channel.on("message"'),
  );

  assert.ok(inbound.indexOf('msg.rawContentType === "share_user"') < inbound.indexOf("if (!binding)"));
  assert.ok(inbound.indexOf("processPendingMemberCardText") < inbound.indexOf("parseMembersCommand"));
  assert.match(source, /resolveFeishuUserCardOpenId\(msg, \{ client: channel\.rawClient \}\)/);
});
