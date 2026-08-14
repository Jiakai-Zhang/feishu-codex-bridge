import assert from "node:assert/strict";
import test from "node:test";
import { SessionAddFlow } from "./session-add-flow.mjs";

const projectSession = {
  id: "thread-project",
  title: "Project task",
  displayTitle: "Project task",
  updatedAtMs: 1_000,
};
const independentSession = {
  id: "thread-independent",
  title: "Independent task",
  displayTitle: "Independent task",
  updatedAtMs: 2_000,
};
const catalog = {
  projects: [{ id: "project-a", name: "Alpha", sessions: [projectSession] }],
  independent: [independentSession],
};

function fixture() {
  const provisions = [];
  const flow = new SessionAddFlow({
    loadCatalog: async () => catalog,
    provision: async (threadId, options) => {
      provisions.push({ threadId, options });
      return {
        alreadyBound: false,
        groupName: "Alpha/Project task",
        feedGroupName: "HOST-Codex",
      };
    },
    createIndependent: async ({ name, cwd }) => ({
      id: "thread-new",
      title: name,
      cwd,
      kind: "independent",
    }),
    now: () => 10_000,
  });
  return { flow, provisions };
}

test("walks through Project then existing session selection", async () => {
  const { flow, provisions } = fixture();
  const started = await flow.handle({ conversationId: "chat-a", text: "/add" });
  const project = await flow.handle({ conversationId: "chat-a", text: "2" });
  const selected = await flow.handle({ conversationId: "chat-a", text: "1" });

  assert.match(started.reply, /1\. \*\*独立\*\*/);
  assert.match(started.reply, /2\. Alpha/);
  assert.match(project.reply, /Project task/);
  assert.match(selected.reply, /HOST-Codex/);
  assert.equal(selected.restart, true);
  assert.deepEqual(provisions, [{ threadId: "thread-project", options: undefined }]);
});

test("creates an independent task only after collecting name and absolute cwd", async () => {
  const { flow, provisions } = fixture();
  await flow.handle({ conversationId: "chat-a", text: "/add" });
  await flow.handle({ conversationId: "chat-a", text: "1" });
  await flow.handle({ conversationId: "chat-a", text: "1" });
  await flow.handle({ conversationId: "chat-a", text: "New task" });
  const selected = await flow.handle({ conversationId: "chat-a", text: "C:\\work" });

  assert.equal(selected.restart, true);
  assert.equal(provisions[0].threadId, "thread-new");
  assert.equal(provisions[0].options.session.kind, "independent");
  assert.equal(provisions[0].options.session.cwd, "C:\\work");
});

test("keeps unknown messages outside an add flow available to Session Relay", async () => {
  const { flow } = fixture();
  assert.deepEqual(await flow.handle({ conversationId: "chat-a", text: "hello" }), { handled: false });
  await flow.handle({ conversationId: "chat-a", text: "/add" });
  assert.equal((await flow.handle({ conversationId: "chat-a", text: "/cancel" })).handled, true);
  assert.equal(flow.has("chat-a"), false);
});
