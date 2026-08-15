import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionBindingRegistry } from "../../../src/persistence/session-binding-registry.mjs";

const threadA = "019ff5b8-decb-7ca3-802c-f115f2f196de";
const threadB = "019ff5a0-559b-79d3-8bd3-2eb2d5f0c294";

function config() {
  return {
    mode: "session-relay",
    appId: "cli_example",
    threadId: threadA,
    workspace: "C:\\runtime",
    nodeExecutable: "node",
    codexExecutable: "codex",
    agent: { ownerOpenId: "ou_owner", botOpenId: "ou_bot" },
    sessionRelay: { appServerUrl: "ws://127.0.0.1:47321/rpc" },
    collaboration: { groupChatId: "oc_existing" },
  };
}

test("atomically migrates a legacy binding and appends a new binding", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "binding-registry-"));
  const configPath = path.join(dir, "bridge.config.json");
  await fs.writeFile(configPath, JSON.stringify(config()), "utf8");
  const registry = new SessionBindingRegistry({ configPath });

  await registry.add({ groupChatId: "oc_new", threadId: threadB, ownerOpenId: "ou_owner" });
  const written = JSON.parse(await fs.readFile(configPath, "utf8"));

  assert.deepEqual(written.sessionRelay.bindings, [
    { groupChatId: "oc_existing", threadId: threadA, ownerOpenId: "ou_owner" },
    { groupChatId: "oc_new", threadId: threadB, ownerOpenId: "ou_owner" },
  ]);
  assert.equal(written.appId, "cli_example");
});

test("refuses duplicate task and group bindings", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "binding-registry-"));
  const configPath = path.join(dir, "bridge.config.json");
  await fs.writeFile(configPath, JSON.stringify(config()), "utf8");
  const registry = new SessionBindingRegistry({ configPath });

  await assert.rejects(
    registry.add({ groupChatId: "oc_new", threadId: threadA }),
    (error) => error?.code === "session_already_bound" && error.binding.groupChatId === "oc_existing",
  );
  await assert.rejects(
    registry.add({ groupChatId: "oc_existing", threadId: threadB }),
    (error) => error?.code === "group_already_bound" && error.binding.threadId === threadA,
  );
});

test("removes only the exact group-to-session binding", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "binding-registry-"));
  const configPath = path.join(dir, "bridge.config.json");
  const value = config();
  value.sessionRelay = {
    appServerUrl: "ws://127.0.0.1:47321/rpc",
    bindings: [
      { groupChatId: "oc_existing", threadId: threadA, ownerOpenId: "ou_owner" },
      { groupChatId: "oc_other", threadId: threadB, ownerOpenId: "ou_owner" },
    ],
  };
  delete value.threadId;
  delete value.collaboration;
  await fs.writeFile(configPath, JSON.stringify(value), "utf8");
  const registry = new SessionBindingRegistry({ configPath });

  const removed = await registry.remove({ groupChatId: "oc_existing", threadId: threadA });
  const written = JSON.parse(await fs.readFile(configPath, "utf8"));

  assert.equal(removed.threadId, threadA);
  assert.deepEqual(written.sessionRelay.bindings, [
    { groupChatId: "oc_other", threadId: threadB, ownerOpenId: "ou_owner" },
  ]);
  await assert.rejects(
    registry.remove({ groupChatId: "oc_other", threadId: threadA }),
    (error) => error?.code === "binding_changed" && error.binding.threadId === threadB,
  );
});
