import assert from "node:assert/strict";
import test from "node:test";
import { SessionAddFlow } from "../../../src/relay/session-add-flow.mjs";

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
  const projectCreations = [];
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
    createProject: async ({ name, project }) => {
      projectCreations.push({ name, project });
      return {
        id: "thread-new-project",
        title: name,
        cwd: project.rootPaths[0],
        kind: "project",
        projectId: project.id,
        projectName: project.name,
      };
    },
    now: () => 10_000,
  });
  return { flow, provisions, projectCreations };
}

test("walks through Project then existing session selection", async () => {
  const { flow, provisions } = fixture();
  const started = await flow.handle({ conversationId: "chat-a", text: "/add" });
  const project = await flow.handle({ conversationId: "chat-a", text: "2" });
  const selected = await flow.handle({ conversationId: "chat-a", text: "1" });

  assert.match(started.reply, /`1` \*\*独立\*\*/);
  assert.match(started.reply, /`2` Alpha/);
  assert.match(project.reply, /Project task/);
  assert.match(selected.reply, /HOST-Codex/);
  assert.equal(selected.restart, true);
  assert.deepEqual(provisions, [{ threadId: "thread-project", options: undefined }]);
});

test("creates and binds another task from a non-empty Project", async () => {
  const creations = [];
  const provisions = [];
  const flow = new SessionAddFlow({
    loadCatalog: async () => ({
      projects: [{
        id: "project-a",
        name: "Alpha",
        rootPaths: ["C:\\alpha"],
        sessions: [projectSession],
      }],
      independent: [],
    }),
    provision: async (threadId, options) => {
      provisions.push({ threadId, options });
      return {
        alreadyBound: false,
        groupName: "Alpha/Second task",
        feedGroupName: "HOST-Codex",
      };
    },
    createIndependent: async () => undefined,
    createProject: async ({ name, project, actorOpenId }) => {
      creations.push({ name, projectId: project.id, actorOpenId });
      return {
        id: "thread-second",
        title: name,
        cwd: project.rootPaths[0],
        kind: "project",
        projectId: project.id,
        projectName: project.name,
      };
    },
    now: () => 10_000,
  });

  await flow.handle({ conversationId: "chat-create-more", actorOpenId: "ou_member", text: "/add" });
  const menu = await flow.handle({ conversationId: "chat-create-more", actorOpenId: "ou_member", text: "2" });
  assert.match(menu.reply, /^`1` Project task（/m);
  assert.match(menu.reply, /^`2` \*\*新建任务\*\*$/m);

  const namePrompt = await flow.handle({
    conversationId: "chat-create-more",
    actorOpenId: "ou_member",
    text: "2",
  });
  const created = await flow.handle({
    conversationId: "chat-create-more",
    actorOpenId: "ou_member",
    text: "Second task",
  });

  assert.match(namePrompt.reply, /Project \*\*Alpha\*\*/);
  assert.deepEqual(creations, [{ name: "Second task", projectId: "project-a", actorOpenId: "ou_member" }]);
  assert.equal(provisions[0].threadId, "thread-second");
  assert.equal(provisions[0].options.ownerOpenId, "ou_member");
  assert.equal(provisions[0].options.session.kind, "project");
  assert.equal(created.restart, true);
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

test("rescans an empty Project and keeps the wizard on the refreshed task list", async () => {
  let loads = 0;
  const provisions = [];
  const flow = new SessionAddFlow({
    loadCatalog: async () => {
      loads += 1;
      return {
        projects: [{
          id: "project-a",
          name: "Alpha",
          rootPaths: ["C:\\alpha"],
          sessions: loads === 1 ? [] : [projectSession],
        }],
        independent: [],
      };
    },
    provision: async (threadId) => {
      provisions.push(threadId);
      return { alreadyBound: true };
    },
    createIndependent: async () => undefined,
    createProject: async () => undefined,
    now: () => 10_000,
  });

  await flow.handle({ conversationId: "chat-empty", text: "/add" });
  const empty = await flow.handle({ conversationId: "chat-empty", text: "2" });
  assert.match(empty.reply, /^`1` \*\*重新扫描\*\*$/m);
  assert.match(empty.reply, /^`2` \*\*返回 Project 列表\*\*$/m);
  assert.match(empty.reply, /^`3` \*\*新建任务\*\*$/m);

  const rescanned = await flow.handle({ conversationId: "chat-empty", text: "1" });
  assert.match(rescanned.reply, /重新扫描完成，发现 1 个可绑定任务/);
  assert.match(rescanned.reply, /Project task/);
  const selected = await flow.handle({ conversationId: "chat-empty", text: "1" });
  assert.equal(selected.restart, false);
  assert.deepEqual(provisions, ["thread-project"]);
});

test("returns from an empty Project to the Project list", async () => {
  const emptyCatalog = {
    projects: [{ id: "project-a", name: "Alpha", rootPaths: ["C:\\alpha"], sessions: [] }],
    independent: [],
  };
  const flow = new SessionAddFlow({
    loadCatalog: async () => emptyCatalog,
    provision: async () => undefined,
    createIndependent: async () => undefined,
    createProject: async () => undefined,
    now: () => 10_000,
  });

  await flow.handle({ conversationId: "chat-back", text: "/add" });
  await flow.handle({ conversationId: "chat-back", text: "2" });
  const returned = await flow.handle({ conversationId: "chat-back", text: "2" });

  assert.match(returned.reply, /^### 创建 Session 群$/m);
  assert.match(returned.reply, /^`2` Alpha$/m);
});

test("creates and binds a task from an empty Project without editing Project state", async () => {
  const projectCatalog = {
    projects: [{ id: "project-a", name: "Alpha", rootPaths: ["C:\\alpha"], sessions: [] }],
    independent: [],
  };
  const creations = [];
  const provisions = [];
  const flow = new SessionAddFlow({
    loadCatalog: async () => projectCatalog,
    provision: async (threadId, options) => {
      provisions.push({ threadId, options });
      return {
        alreadyBound: false,
        groupName: "Alpha/New Project task",
        feedGroupName: "HOST-Codex",
      };
    },
    createIndependent: async () => undefined,
    createProject: async ({ name, project }) => {
      creations.push({ name, projectId: project.id });
      return {
        id: "thread-created",
        title: name,
        cwd: project.rootPaths[0],
        kind: "project",
        projectId: project.id,
        projectName: project.name,
      };
    },
    now: () => 10_000,
  });

  await flow.handle({ conversationId: "chat-create", text: "/add" });
  await flow.handle({ conversationId: "chat-create", text: "2" });
  const namePrompt = await flow.handle({ conversationId: "chat-create", text: "3" });
  const created = await flow.handle({ conversationId: "chat-create", text: "New Project task" });

  assert.match(namePrompt.reply, /Project \*\*Alpha\*\*/);
  assert.deepEqual(creations, [{ name: "New Project task", projectId: "project-a" }]);
  assert.equal(provisions[0].threadId, "thread-created");
  assert.equal(provisions[0].options.session.kind, "project");
  assert.match(created.reply, /不会自动为外部创建的任务写入原生 Project 分组/);
  assert.equal(created.restart, true);
});

test("renders and accepts multi-digit choices without Feishu ordered-list markers", async () => {
  const sessions = Array.from({ length: 12 }, (_, index) => ({
    id: `thread-${index + 1}`,
    title: `Session ${index + 1}`,
    displayTitle: `Session ${index + 1}`,
    updatedAtMs: 2_000,
  }));
  const projects = Array.from({ length: 12 }, (_, index) => ({
    id: `project-${index + 1}`,
    name: `Project ${index + 1}`,
    sessions: index === 8 ? sessions : [],
  }));
  const provisions = [];
  const flow = new SessionAddFlow({
    loadCatalog: async () => ({ projects, independent: [] }),
    provision: async (threadId) => {
      provisions.push(threadId);
      return {
        alreadyBound: false,
        groupName: "Project 9/Session 10",
        feedGroupName: "HOST-Codex",
      };
    },
    createIndependent: async () => undefined,
    createProject: async () => undefined,
    now: () => 10_000,
  });

  const projectMenu = await flow.handle({ conversationId: "chat-many", text: "/add" });
  assert.match(projectMenu.reply, /^`10` Project 9$/m);
  assert.doesNotMatch(projectMenu.reply, /^10\. /m);

  const sessionMenu = await flow.handle({ conversationId: "chat-many", text: "10" });
  assert.match(sessionMenu.reply, /^### Project 9：选择 Codex 任务$/m);
  assert.match(sessionMenu.reply, /^`10` Session 10（/m);
  assert.doesNotMatch(sessionMenu.reply, /^10\. /m);

  await flow.handle({ conversationId: "chat-many", text: "10" });
  assert.deepEqual(provisions, ["thread-10"]);
});

test("creates a Project and its first task inside the requesting member's scope", async () => {
  const calls = [];
  const memberCatalog = {
    projects: [],
    independent: [],
    canCreateProject: true,
    independentCreateMode: "member-root",
  };
  const flow = new SessionAddFlow({
    loadCatalog: async (actorOpenId) => {
      calls.push(["load", actorOpenId]);
      return memberCatalog;
    },
    createWorkspaceProject: async ({ name, actorOpenId }) => {
      calls.push(["project", name, actorOpenId]);
      return {
        id: "bridge-project",
        name,
        rootPaths: ["C:\\members\\alice\\frontend"],
        ownerOpenId: actorOpenId,
      };
    },
    createProject: async ({ name, project, actorOpenId }) => {
      calls.push(["task", name, project.id, actorOpenId]);
      return { id: "thread-member", title: name, kind: "project", projectName: project.name };
    },
    createIndependent: async () => undefined,
    provision: async (threadId, options) => {
      calls.push(["provision", threadId, options.ownerOpenId]);
      return { alreadyBound: false, groupName: "frontend/First task" };
    },
    now: () => 10_000,
  });

  const menu = await flow.handle({ conversationId: "chat-member", actorOpenId: "ou_member", text: "/add" });
  assert.match(menu.reply, /^`2` \*\*新建 Project\*\*$/m);
  await flow.handle({ conversationId: "chat-member", actorOpenId: "ou_member", text: "2" });
  await flow.handle({ conversationId: "chat-member", actorOpenId: "ou_member", text: "frontend" });
  const created = await flow.handle({ conversationId: "chat-member", actorOpenId: "ou_member", text: "First task" });

  assert.equal(created.restart, true);
  assert.deepEqual(calls, [
    ["load", "ou_member"],
    ["project", "frontend", "ou_member"],
    ["task", "First task", "bridge-project", "ou_member"],
    ["provision", "thread-member", "ou_member"],
  ]);
});

test("creates a member independent task without accepting an arbitrary cwd", async () => {
  const calls = [];
  const flow = new SessionAddFlow({
    loadCatalog: async () => ({
      projects: [],
      independent: [],
      canCreateProject: true,
      independentCreateMode: "member-root",
    }),
    createIndependent: async (input) => {
      calls.push(input);
      return { id: "thread-member", title: input.name, kind: "independent" };
    },
    createProject: async () => undefined,
    createWorkspaceProject: async () => undefined,
    provision: async (_threadId, options) => ({
      alreadyBound: false,
      groupName: "独立/Member task",
      binding: { ownerOpenId: options.ownerOpenId },
    }),
    now: () => 10_000,
  });
  await flow.handle({ conversationId: "chat-member", actorOpenId: "ou_member", text: "/add" });
  await flow.handle({ conversationId: "chat-member", actorOpenId: "ou_member", text: "1" });
  await flow.handle({ conversationId: "chat-member", actorOpenId: "ou_member", text: "1" });
  const created = await flow.handle({ conversationId: "chat-member", actorOpenId: "ou_member", text: "Member task" });
  assert.equal(created.restart, true);
  assert.deepEqual(calls, [{ name: "Member task", actorOpenId: "ou_member" }]);
});
