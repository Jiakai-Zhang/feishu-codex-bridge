import assert from "node:assert/strict";
import test from "node:test";
import { FeishuSessionChatManager } from "../../../src/feishu/feishu-session-chat.mjs";

test("creates a private solo group as the Bridge Bot with the human owner", async () => {
  let args;
  const manager = new FeishuSessionChatManager({
    nodeExecutable: "node",
    larkCliEntry: "lark-cli.mjs",
    ownerOpenId: "ou_owner",
    runCommand: async (_node, _entry, received) => {
      args = received;
      return { ok: true, data: { chat_id: "oc_created", name: "Project/Task" } };
    },
  });

  const result = await manager.createSoloGroup({ name: "Project/Task" });

  assert.deepEqual(result, { chatId: "oc_created", name: "Project/Task" });
  assert.deepEqual(args.slice(0, 2), ["im", "+chat-create"]);
  assert.equal(args[args.indexOf("--users") + 1], "ou_owner");
  assert.equal(args[args.indexOf("--owner") + 1], "ou_owner");
  assert.equal(args[args.indexOf("--as") + 1], "bot");
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
