import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { normalizeSessionRelayConfig } from "../../../src/relay/session-relay-config.mjs";

const threadA = "019ff5b8-decb-7ca3-802c-f115f2f196de";
const threadB = "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294";

function base(overrides = {}) {
  return {
    mode: "session-relay",
    appId: "cli_example",
    workspace: "./runtime",
    nodeExecutable: "node",
    codexExecutable: "codex",
    agent: { ownerOpenId: "ou_owner", botOpenId: "ou_bot" },
    sessionRelay: {
      appServerUrl: "ws://127.0.0.1:47321/rpc",
      bindings: [{ groupChatId: "oc_group_a", threadId: threadA }],
    },
    ...overrides,
  };
}

test("defaults Session Relay naming to binding-only without renaming Codex tasks", () => {
  const config = normalizeSessionRelayConfig(base(), { configDir: "C:/bridge" });
  assert.equal(config.mode, "session-relay");
  assert.equal(config.sessionRelay.nameSync, "none");
  assert.equal(config.sessionRelay.appServerUrl, "ws://127.0.0.1:47321/rpc");
  assert.equal(config.sessionRelay.displayTimeZone, "Asia/Shanghai");
  assert.equal(config.sessionRelay.promptPreviewChars, 4_000);
  assert.deepEqual(config.sessionRelay.inboundAttachments, {
    enabled: true,
    maxItems: 10,
    maxFileBytes: 30 * 1024 * 1024,
    maxTotalBytes: 60 * 1024 * 1024,
    retentionMs: 7 * 24 * 60 * 60 * 1000,
    maxCacheBytes: 1024 * 1024 * 1024,
  });
  assert.deepEqual(config.sessionRelay.feedGroup, { enabled: false, agentName: "Codex" });
  assert.deepEqual(config.sessionRelay.bindings[0], {
    groupChatId: "oc_group_a",
    threadId: threadA,
    ownerOpenId: "ou_owner",
  });
});

test("normalizes configurable inbound attachment limits", () => {
  const config = normalizeSessionRelayConfig(base({
    sessionRelay: {
      appServerUrl: "ws://127.0.0.1:47321/rpc",
      inboundAttachments: {
        enabled: false,
        maxItems: 4,
        maxFileBytes: 5_000_000,
        maxTotalBytes: 8_000_000,
        retentionHours: 24,
        maxCacheBytes: 20_000_000,
      },
      bindings: [{ groupChatId: "oc_group_a", threadId: threadA }],
    },
  }), { configDir: "C:/bridge" });

  assert.deepEqual(config.sessionRelay.inboundAttachments, {
    enabled: false,
    maxItems: 4,
    maxFileBytes: 5_000_000,
    maxTotalBytes: 8_000_000,
    retentionMs: 24 * 60 * 60 * 1000,
    maxCacheBytes: 20_000_000,
  });
});

test("allows the connected Channel identity to supply the optional Bot open_id", () => {
  const raw = base();
  delete raw.agent.botOpenId;
  const config = normalizeSessionRelayConfig(raw, { configDir: "C:/bridge" });
  assert.equal(config.agent.botOpenId, undefined);
});

test("keeps legacy name synchronization available only when explicitly requested", () => {
  const config = normalizeSessionRelayConfig(base({
    sessionRelay: {
      nameSync: "group-to-session",
      appServerUrl: "ws://127.0.0.1:47321/rpc",
      bindings: [{ groupChatId: "oc_group_a", threadId: threadA }],
    },
  }), { configDir: "C:/bridge" });
  assert.equal(config.sessionRelay.nameSync, "group-to-session");
});

test("normalizes opt-in Feed group configuration and the Feishu CLI entry", () => {
  const config = normalizeSessionRelayConfig(base({
    larkCliEntry: "./tools/lark-cli.mjs",
    sessionRelay: {
      appServerUrl: "ws://127.0.0.1:47321/rpc",
      feedGroup: { enabled: true, agentName: "Codex" },
      bindings: [{ groupChatId: "oc_group_a", threadId: threadA }],
    },
  }), { configDir: "C:/bridge" });

  assert.equal(config.larkCliEntry, path.resolve("C:/bridge", "./tools/lark-cli.mjs"));
  assert.deepEqual(config.sessionRelay.feedGroup, { enabled: true, agentName: "Codex" });
});

test("requires a CLI entry and strict boolean when Feed group sync is enabled", () => {
  assert.throws(() => normalizeSessionRelayConfig(base({
    sessionRelay: {
      appServerUrl: "ws://127.0.0.1:47321/rpc",
      feedGroup: { enabled: true },
      bindings: [{ groupChatId: "oc_group_a", threadId: threadA }],
    },
  })), /larkCliEntry is required/);
  assert.throws(() => normalizeSessionRelayConfig(base({
    sessionRelay: {
      appServerUrl: "ws://127.0.0.1:47321/rpc",
      feedGroup: { enabled: "yes" },
      bindings: [{ groupChatId: "oc_group_a", threadId: threadA }],
    },
  })), /must be a boolean/);
});

test("migrates the legacy threadId and collaboration group into one binding", () => {
  const config = normalizeSessionRelayConfig({
    ...base(),
    threadId: threadA,
    collaboration: { groupChatId: "oc_legacy" },
    sessionRelay: { appServerUrl: "ws://127.0.0.1:47321/rpc" },
  });
  assert.deepEqual(config.sessionRelay.bindings, [{
    groupChatId: "oc_legacy",
    threadId: threadA,
    ownerOpenId: "ou_owner",
  }]);
});

test("allows zero initial bindings so the owner can bootstrap through a Bot DM", () => {
  const config = normalizeSessionRelayConfig({
    ...base(),
    sessionRelay: { appServerUrl: "ws://127.0.0.1:47321/rpc", bindings: [] },
  });
  assert.deepEqual(config.sessionRelay.bindings, []);
});

test("rejects duplicate groups, duplicate sessions, and unsafe configuration", () => {
  assert.throws(() => normalizeSessionRelayConfig(base({
    sessionRelay: { bindings: [
      { groupChatId: "oc_same", threadId: threadA },
      { groupChatId: "oc_same", threadId: threadB },
    ] },
  })), /groupChatIds must be unique/);
  assert.throws(() => normalizeSessionRelayConfig(base({
    sessionRelay: { bindings: [
      { groupChatId: "oc_a", threadId: threadA },
      { groupChatId: "oc_b", threadId: threadA },
    ] },
  })), /threadIds must be unique/);
  assert.throws(() => normalizeSessionRelayConfig(base({ mode: "project-agent" })), /mode=session-relay/);
  assert.throws(() => normalizeSessionRelayConfig(base({ sandboxMode: "host-root" })), /sandboxMode/);
  assert.throws(() => normalizeSessionRelayConfig(base({
    sessionRelay: { bindings: [{ groupChatId: "oc_a", threadId: threadA }] },
  })), /appServerUrl is required/);
  assert.throws(() => normalizeSessionRelayConfig(base({
    sessionRelay: {
      appServerUrl: "ws://192.0.2.1:47321/rpc",
      bindings: [{ groupChatId: "oc_a", threadId: threadA }],
    },
  })), /loopback/);
  const memberBinding = normalizeSessionRelayConfig(base({
    sessionRelay: {
      appServerUrl: "ws://127.0.0.1:47321/rpc",
      bindings: [{ groupChatId: "oc_a", threadId: threadA, ownerOpenId: "ou_other" }],
    },
  }));
  assert.equal(memberBinding.sessionRelay.bindings[0].ownerOpenId, "ou_other");
  assert.throws(() => normalizeSessionRelayConfig(base({
    sessionRelay: {
      appServerUrl: "ws://127.0.0.1:47321/rpc",
      displayTimeZone: "Mars/Olympus",
      bindings: [{ groupChatId: "oc_a", threadId: threadA }],
    },
  })), /IANA time zone/);
  assert.throws(() => normalizeSessionRelayConfig(base({
    sessionRelay: {
      appServerUrl: "ws://127.0.0.1:47321/rpc",
      inboundAttachments: { enabled: "yes" },
      bindings: [{ groupChatId: "oc_a", threadId: threadA }],
    },
  })), /inboundAttachments.enabled must be a boolean/);
});
