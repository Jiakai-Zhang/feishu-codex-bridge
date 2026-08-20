import assert from "node:assert/strict";
import test from "node:test";
import { SessionBindingProvisioner } from "../../../src/relay/session-binding-provisioner.mjs";

const session = {
  id: "thread-a",
  title: "Fix login",
  kind: "project",
  projectId: "project-a",
  projectName: "Alpha",
  cwd: "C:\\alpha",
};

function fixture({ bindings = [] } = {}) {
  const calls = [];
  const registry = {
    list: async () => bindings,
    add: async (binding) => { calls.push(["persist", binding]); return binding; },
  };
  const provisioner = new SessionBindingProvisioner({
    catalog: { load: async () => ({ sessionsById: new Map([[session.id, session]]) }) },
    registry,
    chatManager: {
      createSessionGroup: async ({ name, ownerOpenId }) => {
        calls.push(["create", name, ownerOpenId]);
        return { chatId: "oc_created", name };
      },
    },
    feedGroupManager: {
      groupName: "HOST-Codex",
      findOrCreateGroup: async () => { calls.push(["label-ready"]); return "ofg_agent"; },
      ensureChat: async (chatId) => { calls.push(["label", chatId]); },
    },
    ownerOpenId: "ou_owner",
    verifyGroup: async ({ binding }) => { calls.push(["verify", binding.groupChatId]); },
    settingsStore: {
      initialize: async (threadId) => {
        calls.push(["settings", threadId]);
        return { created: true, settings: { inputMode: "queue", publicProgress: true, finalMention: true } };
      },
      remove: async (threadId) => { calls.push(["settings-remove", threadId]); },
    },
    sendWelcome: async ({ chatId, settings }) => { calls.push(["welcome", chatId, settings]); },
    onWarning: (error) => calls.push(["warning", error.message]),
  });
  return { provisioner, calls };
}

test("creates, verifies, labels, persists, and welcomes a session group in order", async () => {
  const { provisioner, calls } = fixture();

  const result = await provisioner.provision("thread-a");

  assert.equal(result.groupName, "Alpha/Fix login");
  assert.equal(result.feedGroupName, "HOST-Codex");
  assert.deepEqual(calls.map(([name]) => name), [
    "label-ready", "create", "verify", "label", "settings", "persist", "welcome",
  ]);
  assert.equal(calls.find(([name]) => name === "create")[2], "ou_owner");
  assert.deepEqual(calls.at(-1)[2], { inputMode: "queue", publicProgress: true, finalMention: true });
});

test("is idempotent when a task is already bound", async () => {
  const binding = { threadId: "thread-a", groupChatId: "oc_existing", ownerOpenId: "ou_owner" };
  const { provisioner, calls } = fixture({ bindings: [binding] });

  const result = await provisioner.provision("thread-a");

  assert.equal(result.alreadyBound, true);
  assert.equal(result.binding.groupChatId, "oc_existing");
  assert.deepEqual(calls, []);
});

test("does not persist a group whose Feed label could not be applied", async () => {
  const { provisioner, calls } = fixture();
  provisioner.feedGroupManager.ensureChat = async () => { throw new Error("tag failed"); };

  await assert.rejects(
    provisioner.provision("thread-a"),
    (error) => error?.code === "created_group_tag_failed",
  );
  assert.equal(calls.some(([name]) => name === "persist"), false);
});

test("creates a member-owned group and treats the owner's personal Feed label as best effort", async () => {
  const { provisioner, calls } = fixture();
  provisioner.feedGroupManager.ensureChat = async () => { throw new Error("not visible to owner OAuth"); };

  const result = await provisioner.provision("thread-a", {
    session,
    ownerOpenId: "ou_member",
  });

  assert.equal(result.binding.ownerOpenId, "ou_member");
  assert.equal(result.feedGroupName, undefined);
  assert.equal(calls.find(([name]) => name === "create")[2], "ou_member");
  assert.equal(calls.some(([name]) => name === "persist"), true);
  assert.equal(calls.some(([name]) => name === "warning"), true);
});

test("does not let a second user claim an already-owned task", async () => {
  const binding = { threadId: "thread-a", groupChatId: "oc_existing", ownerOpenId: "ou_owner" };
  const { provisioner, calls } = fixture({ bindings: [binding] });
  await assert.rejects(
    provisioner.provision("thread-a", { session, ownerOpenId: "ou_member" }),
    (error) => error?.code === "session_owned_by_another",
  );
  assert.deepEqual(calls, []);
});

test("does not persist a binding when its inherited defaults cannot be saved", async () => {
  const { provisioner, calls } = fixture();
  provisioner.settingsStore.initialize = async () => { throw new Error("disk unavailable"); };

  await assert.rejects(
    provisioner.provision("thread-a"),
    (error) => error?.code === "settings_persist_failed",
  );
  assert.equal(calls.some(([name]) => name === "persist"), false);
  assert.equal(calls.some(([name]) => name === "welcome"), false);
});

test("removes a newly seeded settings snapshot when binding persistence fails", async () => {
  const { provisioner, calls } = fixture();
  provisioner.registry.add = async () => { throw new Error("config write failed"); };

  await assert.rejects(
    provisioner.provision("thread-a"),
    (error) => error?.code === "binding_persist_failed",
  );
  assert.equal(calls.some(([name]) => name === "settings-remove"), true);
});
