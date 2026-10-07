import assert from "node:assert/strict";
import test from "node:test";
import { FeishuSessionChatManager } from "../../../src/feishu/feishu-session-chat.mjs";

test("creates a private solo group as the Bridge Bot with the human owner", async () => {
  let args;
  let uploaded;
  const manager = new FeishuSessionChatManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli.mjs",
    ownerOpenId: "ou_owner",
    runCommand: async (_node, _entry, received) => {
      args = received;
      return { ok: true, data: { chat_id: "oc_created", name: "Project/Task" } };
    },
    uploadAvatar: async (record) => {
      uploaded = record;
      return "img_avatar";
    },
  });

  const result = await manager.createSoloGroup({ name: "Project/Task" });

  assert.deepEqual(result, { chatId: "oc_created", name: "Project/Task" });
  assert.deepEqual(args.slice(0, 3), ["im", "chats", "create"]);
  const params = JSON.parse(args[args.indexOf("--params") + 1]);
  const data = JSON.parse(args[args.indexOf("--data") + 1]);
  assert.deepEqual(params, { user_id_type: "open_id", set_bot_manager: true });
  assert.deepEqual(data.user_id_list, ["ou_owner"]);
  assert.equal(data.owner_id, "ou_owner");
  assert.equal(data.avatar, "img_avatar");
  assert.equal(uploaded.name, "Project/Task");
  assert.equal(uploaded.image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(args[args.indexOf("--as") + 1], "bot");
});

test("can create the canonical Session group for a registered member owner", async () => {
  let args;
  const manager = new FeishuSessionChatManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli.mjs",
    ownerOpenId: "ou_owner",
    runCommand: async (_node, _entry, received) => {
      args = received;
      return { data: { chat_id: "oc_member", name: "Member/Task" } };
    },
  });
  const result = await manager.createSessionGroup({ name: "Member/Task", ownerOpenId: "ou_member" });
  assert.equal(result.chatId, "oc_member");
  const data = JSON.parse(args[args.indexOf("--data") + 1]);
  assert.deepEqual(data.user_id_list, ["ou_member"]);
  assert.equal(data.owner_id, "ou_member");
});

test("falls back to the default Feishu avatar when generated avatar upload fails", async () => {
  let args;
  const warnings = [];
  const manager = new FeishuSessionChatManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli.mjs",
    ownerOpenId: "ou_owner",
    uploadAvatar: async () => { throw new Error("upload unavailable"); },
    onWarning: (error) => warnings.push(error),
    runCommand: async (_node, _entry, received) => {
      args = received;
      return { data: { chat_id: "oc_created", name: "Project/Task" } };
    },
  });

  await manager.createSoloGroup({ name: "Project/Task" });

  const data = JSON.parse(args[args.indexOf("--data") + 1]);
  assert.equal("avatar" in data, false);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "chat_avatar_failed");
});

test("maps missing Bot create scope without exposing the upstream payload", async () => {
  const manager = new FeishuSessionChatManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli.mjs",
    ownerOpenId: "ou_owner",
    runCommand: async () => {
      const error = new Error("console_url=https://example.invalid/secret");
      error.missingScopes = ["im:chat:create"];
      throw error;
    },
  });

  await assert.rejects(
    manager.createSoloGroup({ name: "Project/Task" }),
    (error) => error?.code === "chat_create_auth_required"
      && error.missingScopes[0] === "im:chat:create"
      && !error.message.includes("example.invalid"),
  );
});
