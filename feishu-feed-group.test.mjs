import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentFeedGroupName,
  FeishuFeedGroupManager,
  runLarkCliJson,
} from "./feishu-feed-group.mjs";

const ok = (data) => ({ ok: true, identity: "user", data });

test("builds the agent Feed group name from hostname and agent name", () => {
  assert.equal(
    buildAgentFeedGroupName({ hostname: "DESKTOP-V4BD0R3", agentName: "Codex" }),
    "DESKTOP-V4BD0R3-Codex",
  );
});

test("reuses an existing normal Feed group and adds unique chats", async () => {
  const calls = [];
  const manager = new FeishuFeedGroupManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli.mjs",
    hostname: "HOST",
    agentName: "Codex",
    runCommand: async (_node, _entry, args) => {
      calls.push(args);
      if (args.includes("+feed-group-list")) {
        return ok({ groups: [{ group_id: "ofg_existing", type: "normal", name: "HOST-Codex" }] });
      }
      return ok({ failed_items: [] });
    },
  });

  const first = await manager.ensureChats(["oc_alpha", "oc_alpha", "oc_beta"]);
  const second = await manager.ensureChat("oc_alpha");

  assert.deepEqual(first, {
    groupId: "ofg_existing",
    groupName: "HOST-Codex",
    added: 2,
  });
  assert.equal(second.added, 0);
  assert.equal(calls.length, 2);
  const request = JSON.parse(calls[1][calls[1].indexOf("--data") + 1]);
  assert.deepEqual(request.items, [
    { feed_id: "oc_alpha", feed_type: "chat" },
    { feed_id: "oc_beta", feed_type: "chat" },
  ]);
});

test("creates one normal Feed group before adding a chat", async () => {
  const calls = [];
  const manager = new FeishuFeedGroupManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli.mjs",
    hostname: "HOST",
    agentName: "Codex",
    runCommand: async (_node, _entry, args) => {
      calls.push(args);
      if (args.includes("+feed-group-list")) return ok({ groups: [] });
      if (args.includes("create")) return ok({ group_id: "ofg_created" });
      return ok({ failed_items: [] });
    },
  });

  const result = await manager.ensureChat("oc_alpha");

  assert.equal(result.groupId, "ofg_created");
  assert.equal(result.added, 1);
  const create = JSON.parse(calls[1][calls[1].indexOf("--data") + 1]);
  assert.deepEqual(create, {
    feed_group_creator: { type: "normal", name: "HOST-Codex" },
  });
});

test("does not guess when the requested Feed group name is ambiguous", async () => {
  const manager = new FeishuFeedGroupManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli.mjs",
    hostname: "HOST",
    runCommand: async () => ok({ groups: [
      { group_id: "ofg_a", type: "normal", name: "HOST-Codex" },
      { group_id: "ofg_b", type: "normal", name: "HOST-Codex" },
    ] }),
  });

  await assert.rejects(
    manager.ensureChat("oc_alpha"),
    (error) => error?.code === "feed_group_name_ambiguous",
  );
});

test("surfaces per-chat Feed group failures without marking them ensured", async () => {
  let addAttempts = 0;
  const manager = new FeishuFeedGroupManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli.mjs",
    hostname: "HOST",
    runCommand: async (_node, _entry, args) => {
      if (args.includes("+feed-group-list")) {
        return ok({ groups: [{ group_id: "ofg_existing", type: "normal", name: "HOST-Codex" }] });
      }
      addAttempts += 1;
      return ok({ failed_items: [{ item: { feed_id: "oc_alpha" }, error_code: 240001 }] });
    },
  });

  await assert.rejects(
    manager.ensureChat("oc_alpha"),
    (error) => error?.code === "feed_group_partial_failure" && error.failedItems[0].feedId === "oc_alpha",
  );
  await assert.rejects(manager.ensureChat("oc_alpha"), /could not add every bound chat/);
  assert.equal(addAttempts, 2);
});

test("maps a CLI missing-scope envelope to a safe authorization error", async () => {
  const execFile = (_executable, _args, options, callback) => {
    assert.equal(options.env.LARKSUITE_CLI_NO_UPDATE_NOTIFIER, "1");
    const error = Object.assign(new Error("exit 3"), { code: 3 });
    callback(error, "", JSON.stringify({
      ok: false,
      identity: "user",
      error: {
        subtype: "missing_scope",
        missing_scopes: ["im:feed_group_v1:read"],
        verification_url: "https://example.invalid/sensitive-device-flow",
      },
    }));
  };

  await assert.rejects(
    runLarkCliJson("node", "lark-cli.mjs", ["im"], { execFile }),
    (error) => error?.code === "feed_group_auth_required"
      && error.missingScopes[0] === "im:feed_group_v1:read"
      && !error.message.includes("example.invalid"),
  );
});

test("removes a chat from the Feed group and suppresses background re-add until restart", async () => {
  const calls = [];
  const manager = new FeishuFeedGroupManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli.mjs",
    hostname: "HOST",
    runCommand: async (_node, _entry, args) => {
      calls.push(args);
      if (args.includes("+feed-group-list")) {
        return ok({ groups: [{ group_id: "ofg_existing", type: "normal", name: "HOST-Codex" }] });
      }
      return ok({ failed_items: [] });
    },
  });

  await manager.ensureChat("oc_alpha");
  const removed = await manager.removeChat("oc_alpha");
  const suppressed = await manager.ensureChat("oc_alpha");

  assert.equal(removed.removed, 1);
  assert.equal(suppressed.added, 0);
  assert.equal(calls.filter((args) => args.includes("batch_remove_item")).length, 1);
  const removal = calls.find((args) => args.includes("batch_remove_item"));
  assert.deepEqual(JSON.parse(removal[removal.indexOf("--params") + 1]), {
    feed_group_id: "ofg_existing",
  });
  assert.deepEqual(JSON.parse(removal[removal.indexOf("--data") + 1]), {
    items: [{ feed_id: "oc_alpha", feed_type: "chat" }],
  });

  await manager.restoreChat("oc_alpha");
  assert.equal(calls.filter((args) => args.includes("batch_add_item")).length, 2);
});

test("keeps a chat eligible for retry when Feed label removal fails", async () => {
  let removeAttempts = 0;
  const manager = new FeishuFeedGroupManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli.mjs",
    hostname: "HOST",
    runCommand: async (_node, _entry, args) => {
      if (args.includes("+feed-group-list")) {
        return ok({ groups: [{ group_id: "ofg_existing", type: "normal", name: "HOST-Codex" }] });
      }
      if (args.includes("batch_remove_item")) {
        removeAttempts += 1;
        return ok({ failed_items: [{ item: { feed_id: "oc_alpha" }, error_code: 240001 }] });
      }
      return ok({ failed_items: [] });
    },
  });

  await manager.ensureChat("oc_alpha");
  await assert.rejects(manager.removeChat("oc_alpha"), /could not remove/);
  await assert.rejects(manager.removeChat("oc_alpha"), /could not remove/);
  assert.equal(removeAttempts, 2);
});
