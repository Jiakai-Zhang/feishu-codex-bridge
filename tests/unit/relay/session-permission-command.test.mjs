import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveSessionSandboxMode,
  formatSessionPermission,
  parseSessionPermissionAction,
  SessionPermissionFlow,
} from "../../../src/relay/session-permission-command.mjs";

const permissionCommand = (args) => ({ name: "permissions", args });

function harness({ now = 1_000, sandboxMode = "inherit" } = {}) {
  let clock = now;
  let status = { status: { type: "idle" }, goal: null };
  let settings = { inputMode: "queue", publicProgress: true, finalMention: true, sandboxMode };
  const context = {
    controller: { getStatus: async () => structuredClone(status) },
    settingsStore: {
      get: () => ({ ...settings }),
      update: async (_threadId, patch) => {
        settings = { ...settings, ...patch };
        return { ...settings };
      },
    },
    threadId: "thread-a",
    senderOpenId: "owner-a",
    conversationId: "conversation-a",
    defaultSandboxMode: "workspace-write",
    isSessionOwner: true,
    humanMemberCount: 1,
  };
  return {
    context,
    flow: new SessionPermissionFlow({ now: () => clock }),
    get settings() { return { ...settings }; },
    setStatus(next) { status = next; },
    advance(ms) { clock += ms; },
  };
}

test("parses permission modes and renders the effective inherited boundary", () => {
  assert.deepEqual(parseSessionPermissionAction(""), { action: "status" });
  assert.deepEqual(parseSessionPermissionAction("workspace"), { action: "set", mode: "workspace-write" });
  assert.deepEqual(parseSessionPermissionAction("full"), { action: "set", mode: "danger-full-access" });
  assert.equal(effectiveSessionSandboxMode("inherit", "read-only"), "read-only");
  assert.match(formatSessionPermission({ sandboxMode: "inherit" }, "workspace-write"), /工作区写入/);
  assert.throws(() => parseSessionPermissionAction("root"), /用法/);
});

test("changes an idle owner Session immediately for non-full modes", async () => {
  const testHarness = harness();
  const result = await testHarness.flow.execute(
    permissionCommand("read-only"),
    testHarness.context,
  );
  assert.equal(testHarness.settings.sandboxMode, "read-only");
  assert.match(result, /Session 权限已更新/);
  assert.match(result, /只读/);

  await assert.rejects(
    () => testHarness.flow.execute(permissionCommand("workspace-write"), {
      ...testHarness.context,
      isSessionOwner: false,
    }),
    (error) => error.code === "permission_owner_required",
  );
  assert.equal(testHarness.settings.sandboxMode, "read-only");
});

test("requires a conversation-bound second confirmation before full access", async () => {
  const testHarness = harness();
  const warning = await testHarness.flow.execute(
    permissionCommand("danger-full-access"),
    { ...testHarness.context, humanMemberCount: 3 },
  );
  assert.match(warning, /确认完全访问/);
  assert.match(warning, /3 名人类成员/);
  assert.equal(testHarness.settings.sandboxMode, "inherit");

  await assert.rejects(
    () => testHarness.flow.execute(permissionCommand("confirm"), {
      ...testHarness.context,
      conversationId: "another-conversation",
    }),
    (error) => error.code === "permission_confirmation_missing",
  );

  const confirmed = await testHarness.flow.execute(permissionCommand("confirm"), testHarness.context);
  assert.equal(testHarness.settings.sandboxMode, "danger-full-access");
  assert.match(confirmed, /完全访问/);
  assert.match(confirmed, /无需审批/);
});

test("expires full-access confirmation and rejects changes while the Session is busy", async () => {
  const testHarness = harness();
  await testHarness.flow.execute(permissionCommand("full"), testHarness.context);
  testHarness.advance(5 * 60 * 1000 + 1);
  await assert.rejects(
    () => testHarness.flow.execute(permissionCommand("confirm"), testHarness.context),
    (error) => error.code === "permission_confirmation_missing",
  );

  testHarness.setStatus({ status: { type: "active" }, goal: null });
  await assert.rejects(
    () => testHarness.flow.execute(permissionCommand("read-only"), testHarness.context),
    (error) => error.code === "permission_change_busy",
  );
  assert.equal(testHarness.settings.sandboxMode, "inherit");
});

test("restores the in-memory boundary when permission persistence fails", async () => {
  let settings = { sandboxMode: "inherit" };
  let failNextWrite = true;
  const context = {
    controller: { getStatus: async () => ({ status: { type: "idle" }, goal: null }) },
    settingsStore: {
      get: () => ({ ...settings }),
      update: async (_threadId, patch) => {
        settings = { ...settings, ...patch };
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("disk unavailable");
        }
        return { ...settings };
      },
    },
    threadId: "thread-a",
    senderOpenId: "owner-a",
    conversationId: "conversation-a",
    defaultSandboxMode: "workspace-write",
    isSessionOwner: true,
  };
  const flow = new SessionPermissionFlow();
  await assert.rejects(() => flow.execute(permissionCommand("read-only"), context), /disk unavailable/);
  assert.equal(settings.sandboxMode, "inherit");
});
