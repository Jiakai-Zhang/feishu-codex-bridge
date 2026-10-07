import assert from "node:assert/strict";
import test from "node:test";
import { materializeSessionDraft } from "../../../src/relay/session-draft-bootstrap.mjs";
const session = { id: "empty-draft", title: "New task", cwd: "/example/workspace", kind: "independent", privateExtra: "preserve" };
test("materializes only a positively verified unused draft and retains catalog scope", async () => {
  const calls = [];
  const result = await materializeSessionDraft({ session, sandboxMode: "danger-full-access",
    sessionStore: { getUnmaterializedDraft: async () => session },
    createTarget: async (params) => { calls.push(params); return { id: "durable-task", historyMode: "legacy", path: "/example/rollout" }; },
  });
  assert.deepEqual(calls, [{ cwd: session.cwd, name: session.title, sandboxMode: "danger-full-access" }]);
  assert.equal(result.id, "durable-task"); assert.equal(result.kind, session.kind); assert.equal(result.privateExtra, "preserve");
  assert.equal(session.id, "empty-draft");
});
test("does not replace a task without positive draft evidence", async () => {
  const result = await materializeSessionDraft({ session,
    sessionStore: { getUnmaterializedDraft: async () => undefined }, createTarget: () => assert.fail("must not create"),
  });
  assert.equal(result, session);
});
test("rejects changed workspaces or an incompatible native replacement", async () => {
  await assert.rejects(materializeSessionDraft({ session,
    sessionStore: { getUnmaterializedDraft: async () => ({ ...session, cwd: "/other" }) }, createTarget: () => assert.fail("must not create"),
  }), /workspace changed/);
  for (const result of [{}, { id: session.id }, { id: "replacement", historyMode: "paginated" }]) {
    await assert.rejects(materializeSessionDraft({ session,
      sessionStore: { getUnmaterializedDraft: async () => session }, createTarget: async () => result,
    }), /compatible new task/);
  }
});
