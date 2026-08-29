import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { CodexSessionController } from "../../../src/codex/codex-session-controller.mjs";

const threadId = "019ff5b8-decb-7ca3-802c-f115f2f196de";
const repoCwd = path.join(os.tmpdir(), "bridge-controller-repo");
const attachmentPath = (name) => path.join(os.tmpdir(), "bridge-cache", name);
const target = { threadId, chatId: "oc_group", cwd: repoCwd };

function userItem(clientId, text, id = `user-${clientId}`) {
  return { id, type: "userMessage", clientId, content: [{ type: "text", text }] };
}

function userInputItem(clientId, input, id = `user-${clientId}`) {
  return { id, type: "userMessage", clientId, content: structuredClone(input) };
}

function fakeControllerServer({ activeTurn, goal = null, resumeConflictThreadIds = [] } = {}) {
  const server = {
    requests: [],
    clientResponses: [],
    sockets: [],
    nextTurn: 1,
    failNextSteer: false,
    acceptThenDisconnectNextSteer: false,
    acceptThenDisconnectNextStart: false,
    raceNextStartWithDesktop: false,
    settings: {
      cwd: repoCwd,
      model: "model-one",
      modelProvider: "openai",
      serviceTier: "default",
      effort: "medium",
      collaborationMode: {
        mode: "default",
        settings: { model: "model-one", reasoning_effort: "medium", developer_instructions: null },
      },
    },
    goal: goal ? structuredClone(goal) : null,
    resumeConflictThreadIds: new Set(resumeConflictThreadIds),
    turns: activeTurn ? [structuredClone(activeTurn)] : [],
    status: activeTurn ? { type: "active", activeFlags: [] } : { type: "idle" },
  };

  function threadSnapshot(includeTurns = true, requestedThreadId = threadId) {
    return {
      id: requestedThreadId,
      cwd: repoCwd,
      status: requestedThreadId === threadId ? structuredClone(server.status) : { type: "idle" },
      turns: includeTurns && requestedThreadId === threadId ? structuredClone(server.turns) : [],
    };
  }

  function respond(socket, id, result, error) {
    queueMicrotask(() => socket.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify(error ? { id, error } : { id, result }),
    })));
  }

  function notify(method, params, socket = server.sockets.at(-1)) {
    queueMicrotask(() => socket?.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ method, params }),
    })));
  }

  function active() {
    return server.turns.find((turn) => turn.status === "inProgress");
  }

  function handle(socket, request) {
    if (request.id !== undefined && !request.method) {
      server.clientResponses.push(structuredClone(request));
      return;
    }
    server.requests.push(structuredClone(request));
    if (request.method === "initialize") {
      respond(socket, request.id, { userAgent: "test" });
    } else if (request.method === "thread/resume") {
      if (server.resumeConflictThreadIds.has(request.params.threadId)) {
        respond(socket, request.id, undefined, {
          code: -32603,
          message: "thread already has an active writer",
        });
        return;
      }
      respond(socket, request.id, {
        thread: threadSnapshot(false, request.params.threadId),
        model: server.settings.model,
        modelProvider: "openai",
        serviceTier: server.settings.serviceTier,
        reasoningEffort: server.settings.effort,
      });
    } else if (request.method === "thread/read") {
      respond(socket, request.id, {
        thread: threadSnapshot(request.params.includeTurns, request.params.threadId),
      });
    } else if (request.method === "thread/goal/get") {
      respond(socket, request.id, { goal: structuredClone(server.goal) });
    } else if (request.method === "turn/start") {
      if (server.raceNextStartWithDesktop) {
        server.raceNextStartWithDesktop = false;
        server.turns.push({
          id: "turn-desktop-race",
          status: "inProgress",
          startedAt: Date.now() / 1000,
          completedAt: null,
          items: [userItem("desktop-client", "Desktop won the race")],
        });
        server.status = { type: "active", activeFlags: [] };
      }
      if (active()) {
        respond(socket, request.id, undefined, { code: -32602, message: "thread already has an active turn" });
        return;
      }
      const id = `turn-${server.nextTurn++}`;
      const turn = {
        id,
        status: "inProgress",
        startedAt: Date.now() / 1000,
        completedAt: null,
        items: [userInputItem(request.params.clientUserMessageId, request.params.input)],
      };
      server.turns.push(turn);
      server.status = { type: "active", activeFlags: [] };
      if (server.acceptThenDisconnectNextStart) {
        server.acceptThenDisconnectNextStart = false;
        queueMicrotask(() => {
          const event = new Event("close");
          Object.defineProperty(event, "code", { value: 1006 });
          socket.dispatchEvent(event);
        });
      } else {
        respond(socket, request.id, { turn: structuredClone(turn) });
        notify("turn/started", { threadId, turn: structuredClone(turn) }, socket);
      }
    } else if (request.method === "turn/steer") {
      const turn = active();
      if (server.failNextSteer) {
        server.failNextSteer = false;
        if (turn) {
          turn.status = "completed";
          turn.completedAt = Date.now() / 1000;
        }
        server.status = { type: "idle" };
        respond(socket, request.id, undefined, { code: -32602, message: "expected turn is no longer active" });
      } else if (!turn || request.params.expectedTurnId !== turn.id) {
        respond(socket, request.id, undefined, { code: -32602, message: "expected turn mismatch" });
      } else {
        const item = userInputItem(
          request.params.clientUserMessageId,
          request.params.input,
          `steer-${request.params.clientUserMessageId}`,
        );
        turn.items.push(item);
        if (server.acceptThenDisconnectNextSteer) {
          server.acceptThenDisconnectNextSteer = false;
          queueMicrotask(() => {
            const event = new Event("close");
            Object.defineProperty(event, "code", { value: 1006 });
            socket.dispatchEvent(event);
          });
        } else {
          respond(socket, request.id, { turnId: turn.id });
          notify("item/completed", { threadId, turnId: turn.id, completedAtMs: Date.now(), item }, socket);
        }
      }
    } else if (request.method === "turn/interrupt") {
      const turn = active();
      if (turn && turn.id === request.params.turnId) {
        turn.status = "interrupted";
        turn.completedAt = Date.now() / 1000;
        server.status = { type: "idle" };
      }
      respond(socket, request.id, {});
      if (turn) notify("turn/completed", { threadId, turn: structuredClone(turn) }, socket);
    } else if (request.method === "thread/settings/update") {
      const params = request.params;
      if ("model" in params) server.settings.model = params.model;
      if ("effort" in params) server.settings.effort = params.effort;
      if ("serviceTier" in params) server.settings.serviceTier = params.serviceTier;
      if ("collaborationMode" in params) server.settings.collaborationMode = structuredClone(params.collaborationMode);
      respond(socket, request.id, {});
      notify("thread/settings/updated", { threadId, threadSettings: structuredClone(server.settings) }, socket);
    } else if (request.method === "model/list") {
      respond(socket, request.id, {
        data: [
          {
            id: "one", model: "model-one", displayName: "One", hidden: false, isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }],
            defaultReasoningEffort: "medium", serviceTiers: [], additionalSpeedTiers: [], defaultServiceTier: null,
          },
          {
            id: "two", model: "model-two", displayName: "Two", hidden: false, isDefault: false,
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            defaultReasoningEffort: "high", serviceTiers: [{ id: "priority", name: "Fast" }], additionalSpeedTiers: ["fast"], defaultServiceTier: null,
          },
        ],
        nextCursor: null,
      });
    } else if (request.method === "collaborationMode/list") {
      respond(socket, request.id, { data: [
        { name: "Default", mode: "default", model: null, reasoning_effort: null },
        { name: "Plan", mode: "plan", model: null, reasoning_effort: null },
      ] });
    } else if (request.method === "thread/goal/set") {
      const now = Date.now() / 1000;
      server.goal = {
        threadId,
        objective: request.params.objective ?? server.goal?.objective ?? "goal",
        status: request.params.status ?? server.goal?.status ?? "paused",
        tokenBudget: Object.hasOwn(request.params, "tokenBudget") ? request.params.tokenBudget : (server.goal?.tokenBudget ?? null),
        tokensUsed: server.goal?.tokensUsed ?? 0,
        timeUsedSeconds: server.goal?.timeUsedSeconds ?? 0,
        createdAt: server.goal?.createdAt ?? now,
        updatedAt: now,
      };
      respond(socket, request.id, { goal: structuredClone(server.goal) });
      notify("thread/goal/updated", { threadId, turnId: active()?.id || null, goal: structuredClone(server.goal) }, socket);
    } else if (request.method === "thread/goal/clear") {
      server.goal = null;
      respond(socket, request.id, { cleared: true });
      notify("thread/goal/cleared", { threadId }, socket);
    } else {
      respond(socket, request.id, undefined, { code: -32601, message: `unsupported ${request.method}` });
    }
  }

  class FakeWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      this.closed = false;
      server.sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(text) { handle(this, JSON.parse(text)); }
    close() {
      if (this.closed) return;
      this.closed = true;
      const event = new Event("close");
      Object.defineProperty(event, "code", { value: 1000 });
      queueMicrotask(() => this.dispatchEvent(event));
    }
  }

  server.FakeWebSocket = FakeWebSocket;
  server.notify = notify;
  server.requestClient = (method, params, id = 900) => {
    const socket = server.sockets.at(-1);
    queueMicrotask(() => socket?.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({ id, method, params }),
    })));
  };
  server.completeActive = (answer, { goalStatus } = {}) => {
    const turn = active();
    if (!turn) throw new Error("no active turn");
    const item = { id: `answer-${turn.id}`, type: "agentMessage", phase: "final_answer", text: answer };
    turn.items.push(item);
    turn.status = "completed";
    turn.completedAt = Date.now() / 1000;
    server.status = { type: "idle" };
    if (server.goal && goalStatus) server.goal.status = goalStatus;
    notify("item/completed", { threadId, turnId: turn.id, completedAtMs: Date.now(), item });
    if (server.goal && goalStatus) notify("thread/goal/updated", { threadId, turnId: turn.id, goal: structuredClone(server.goal) });
    notify("turn/completed", { threadId, turn: structuredClone(turn) });
  };
  server.emitCommentary = (text, id = "commentary-progress") => {
    const turn = active();
    if (!turn) throw new Error("no active turn");
    const item = { id, type: "agentMessage", phase: "commentary", text };
    turn.items.push(item);
    notify("item/completed", { threadId, turnId: turn.id, completedAtMs: Date.now(), item });
  };
  server.disconnect = () => {
    const socket = server.sockets.at(-1);
    const event = new Event("close");
    Object.defineProperty(event, "code", { value: 1006 });
    socket.dispatchEvent(event);
  };
  return server;
}

function controller(server, options = {}) {
  return new CodexSessionController({
    appServerUrl: "ws://127.0.0.1:47321/rpc",
    targets: [target],
    sandboxMode: "workspace-write",
    WebSocketImpl: server.FakeWebSocket,
    reconnectDelayMs: 1,
    ...options,
  });
}

test("resolves a Session sandbox on resume and on every Bridge-started Turn", async () => {
  const server = fakeControllerServer();
  let sandboxMode = "read-only";
  const client = controller(server, {
    sandboxModeForThread: () => sandboxMode,
  });
  await client.start();

  const resume = server.requests.find(({ method }) => method === "thread/resume");
  assert.equal(resume.params.sandbox, "read-only");
  assert.equal((await client.getStatus(threadId, { refresh: false })).sandboxMode, "read-only");

  await client.submitPrompt({ threadId, text: "read-only turn", clientUserMessageId: "om_readonly" });
  const readOnlyStart = server.requests.find(({ method }) => method === "turn/start");
  assert.deepEqual(readOnlyStart.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  server.completeActive("done");
  await new Promise((resolve) => setImmediate(resolve));

  sandboxMode = "workspace-write";
  await client.submitPrompt({ threadId, text: "workspace turn", clientUserMessageId: "om_workspace" });
  const workspaceStart = server.requests.filter(({ method }) => method === "turn/start").at(-1);
  assert.deepEqual(workspaceStart.params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [repoCwd],
    networkAccess: false,
  });

  server.completeActive("done");
  await new Promise((resolve) => setImmediate(resolve));
  sandboxMode = "danger-full-access";
  await client.submitPrompt({ threadId, text: "full turn", clientUserMessageId: "om_full" });
  const fullStart = server.requests.filter(({ method }) => method === "turn/start").at(-1);
  assert.deepEqual(fullStart.params.sandboxPolicy, { type: "dangerFullAccess" });
  assert.equal((await client.getStatus(threadId, { refresh: false })).sandboxMode, "danger-full-access");
  await client.stop();
});

test("refreshes the persisted Session sandbox before activating a native Goal", async () => {
  const server = fakeControllerServer();
  let sandboxMode = "workspace-write";
  const client = controller(server, { sandboxModeForThread: () => sandboxMode });
  await client.start();
  const baseline = server.requests.length;

  sandboxMode = "danger-full-access";
  await client.startGoal(threadId, "run under the updated boundary");

  const requests = server.requests.slice(baseline);
  const resumeIndex = requests.findIndex(({ method }) => method === "thread/resume");
  const goalIndex = requests.findIndex(({ method }) => method === "thread/goal/set");
  assert.ok(resumeIndex >= 0);
  assert.ok(goalIndex > resumeIndex);
  assert.equal(requests[resumeIndex].params.sandbox, "danger-full-access");
  await client.stop();
});

test("adds a newly created temporary Chat without reconnecting existing Sessions", async () => {
  const server = fakeControllerServer();
  const client = controller(server);
  await client.start();
  const socketsBefore = server.sockets.length;
  const temporaryThreadId = "029ff5b8-decb-7ca3-802c-f115f2f196de";

  const status = await client.addTarget({
    threadId: temporaryThreadId,
    chatId: "private-conversation",
    cwd: repoCwd,
  });

  assert.equal(status.status.type, "idle");
  assert.equal(client.hasTarget(temporaryThreadId), true);
  assert.equal(server.sockets.length, socketsBefore);
  assert.equal(server.requests.some(({ method, params }) => (
    method === "thread/resume" && params.threadId === temporaryThreadId
  )), true);
  assert.equal(client.removeTarget(temporaryThreadId), true);
  assert.equal(client.hasTarget(temporaryThreadId), false);
  await client.stop();
});

test("isolates an active-writer resume conflict to one Session and retries it after release", async () => {
  const healthyThreadId = "039ff5b8-decb-7ca3-802c-f115f2f196de";
  const server = fakeControllerServer({ resumeConflictThreadIds: [threadId] });
  const logs = [];
  const client = controller(server, {
    targets: [target, { threadId: healthyThreadId, chatId: "oc_healthy", cwd: repoCwd }],
    log: (message) => logs.push(message),
  });

  await client.start();

  assert.equal(client.connected, true);
  assert.equal((await client.getStatus(healthyThreadId)).status.type, "idle");
  await assert.rejects(
    () => client.submitPrompt({ threadId, text: "blocked prompt", clientUserMessageId: "om_blocked" }),
    (error) => {
      assert.equal(error.code, "session_writer_conflict");
      assert.match(error.publicMessage, /Codex Desktop|CLI/);
      return true;
    },
  );
  assert.equal(client.connected, true);
  assert.equal(logs.some((message) => /active writer conflict/i.test(message)), true);

  server.resumeConflictThreadIds.delete(threadId);
  const result = await client.submitPrompt({
    threadId,
    text: "retry after release",
    clientUserMessageId: "om_retry",
  });

  assert.equal(result.kind, "started");
  assert.equal(
    server.requests.filter(({ method, params }) => method === "thread/resume" && params.threadId === threadId).length,
    3,
  );
  await client.stop();
});

test("starts an idle Feishu prompt, steers the next prompt into the same active turn, and emits one final", async () => {
  const server = fakeControllerServer();
  const completed = [];
  const client = controller(server, { onTurnCompleted: (record) => completed.push(record) });
  await client.start();
  assert.deepEqual(server.requests.slice(0, 2).map(({ method }) => method), ["initialize", "initialized"]);
  assert.deepEqual(server.requests[0].params.capabilities, {
    experimentalApi: true,
    requestAttestation: false,
  });

  const started = await client.submitPrompt({ threadId, text: "initial", clientUserMessageId: "om_initial" });
  const readsBeforeSteer = server.requests.filter(({ method }) => method === "thread/read").length;
  const steered = await client.submitPrompt({ threadId, text: "adjust it", clientUserMessageId: "om_adjust" });
  assert.deepEqual(started, { kind: "started", turnId: "turn-1", boundaryChanged: false });
  assert.deepEqual(steered, { kind: "steered", turnId: "turn-1", boundaryChanged: false });
  const steerRequest = server.requests.find(({ method }) => method === "turn/steer");
  assert.equal(steerRequest.params.expectedTurnId, "turn-1");
  assert.equal(server.requests.filter(({ method }) => method === "thread/read").length, readsBeforeSteer);
  assert.equal(server.requests.filter(({ method }) => method === "turn/start").length, 1);

  server.completeActive("final answer");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed.length, 1);
  assert.equal(completed[0].clientId, "om_initial");
  assert.deepEqual(completed[0].promptEntries.map(({ text, clientId }) => ({ text, clientId })), [
    { text: "initial", clientId: "om_initial" },
    { text: "adjust it", clientId: "om_adjust" },
  ]);
  assert.equal(completed[0].answer, "final answer");
  await client.stop();
});

test("routes app-server dynamic tool calls through the Desktop tool handler", async () => {
  const server = fakeControllerServer();
  const calls = [];
  const client = controller(server, {
    dynamicToolRequestHandler: async (method, params) => {
      calls.push({ method, params });
      return { contentItems: [{ type: "inputText", text: "active" }], success: true };
    },
  });
  await client.start();
  const resume = server.requests.find(({ method }) => method === "thread/resume");
  assert.equal(resume.params.config["mcp_servers.codex_app.command"], process.execPath);
  assert.match(
    resume.params.config["mcp_servers.codex_app.args"][0],
    /codex-app-tools-mcp-proxy\.mjs$/,
  );
  assert.deepEqual(resume.params.config["mcp_servers.codex_app.env"], {
    FEISHU_CODEX_THREAD_ID: threadId,
  });
  assert.equal(resume.params.config["mcp_servers.codex_app.enabled"], true);
  assert.deepEqual(resume.params.config["mcp_servers.codex_app.enabled_tools"], ["automation_update"]);

  const params = {
    threadId,
    turnId: "turn-tool",
    callId: "call-tool",
    namespace: "codex_app",
    tool: "automation_update",
    arguments: { mode: "view" },
  };
  server.requestClient("item/tool/call", params);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [{ method: "item/tool/call", params }]);
  assert.deepEqual(server.clientResponses.at(-1), {
    id: 900,
    result: { contentItems: [{ type: "inputText", text: "active" }], success: true },
  });
  await client.stop();
});

test("sends Feishu images as localImage and ordinary files in the Codex Desktop wrapper", async () => {
  const server = fakeControllerServer();
  const completed = [];
  const client = controller(server, { onTurnCompleted: (record) => completed.push(record) });
  await client.start();

  await client.submitPrompt({
    threadId,
    text: "检查这些材料",
    attachments: [
      { kind: "image", localPath: attachmentPath("image.png"), name: "image.png", size: 10 },
      { kind: "file", localPath: attachmentPath("report.pdf"), name: "report.pdf", size: 20 },
    ],
    clientUserMessageId: "om_attachments",
  });

  const request = server.requests.find(({ method }) => method === "turn/start");
  assert.deepEqual(request.params.input.map(({ type }) => type), ["text", "localImage"]);
  assert.equal(request.params.input[1].path, attachmentPath("image.png"));
  assert.match(request.params.input[0].text, /# Files mentioned by the user:/);
  assert.equal(request.params.input[0].text.includes(`## report.pdf: ${attachmentPath("report.pdf")}`), true);
  assert.match(request.params.input[0].text, /## My request for Codex:\n检查这些材料$/);
  assert.equal(request.params.input[0].text.includes("feishu_bridge_local_attachments"), false);
  assert.equal(request.params.input.some(({ type }) => type === "mention"), false);

  server.completeActive("已检查");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed.length, 1);
  assert.equal(completed[0].promptEntries[0].text, "检查这些材料\n📎 附件：report.pdf");
  assert.equal(completed[0].promptEntries[0].text.includes("bridge-cache"), false);
  assert.deepEqual(completed[0].promptEntries[0].resources.map(({ type }) => type), ["image", "attachment"]);
  await client.stop();
});

test("uses the stable Desktop file wrapper without a mention retry", async () => {
  const server = fakeControllerServer();
  const client = controller(server);
  await client.start();

  await client.submitPrompt({
    threadId,
    text: "first attachment",
    attachments: [{ kind: "file", localPath: attachmentPath("first.xlsx"), name: "first.xlsx" }],
    clientUserMessageId: "om_fallback_first",
  });
  const firstStarts = server.requests.filter(({ method }) => method === "turn/start");
  assert.equal(firstStarts.length, 1);
  assert.deepEqual(firstStarts[0].params.input.map(({ type }) => type), ["text"]);
  assert.equal(firstStarts[0].params.input[0].text.includes(`## first.xlsx: ${attachmentPath("first.xlsx")}`), true);
  assert.equal(firstStarts[0].params.input[0].text.includes("feishu_bridge_local_attachments"), false);

  server.completeActive("first done");
  await new Promise((resolve) => setImmediate(resolve));
  const startsBeforeSecond = server.requests.filter(({ method }) => method === "turn/start").length;
  await client.submitPrompt({
    threadId,
    text: "second attachment",
    attachments: [{ kind: "file", localPath: attachmentPath("second.pdf"), name: "second.pdf" }],
    clientUserMessageId: "om_fallback_second",
  });
  const secondStarts = server.requests.filter(({ method }) => method === "turn/start").slice(startsBeforeSecond);
  assert.equal(secondStarts.length, 1);
  assert.deepEqual(secondStarts[0].params.input.map(({ type }) => type), ["text"]);
  assert.equal(secondStarts[0].params.input[0].text.includes(`## second.pdf: ${attachmentPath("second.pdf")}`), true);
  await client.stop();
});

test("keeps ordinary files attached when a Feishu prompt steers an active Turn", async () => {
  const server = fakeControllerServer({
    activeTurn: {
      id: "turn-active-file",
      status: "inProgress",
      startedAt: Date.now() / 1000,
      completedAt: null,
      items: [userItem("desktop-client", "current work")],
    },
  });
  const client = controller(server);
  await client.start();

  const result = await client.submitPrompt({
    threadId,
    text: "adjust using this workbook",
    attachments: [{ kind: "file", localPath: attachmentPath("adjust.xlsx"), name: "adjust.xlsx" }],
    clientUserMessageId: "om_file_steer",
  });

  assert.equal(result.kind, "steered");
  const steer = server.requests.find(({ method }) => method === "turn/steer");
  assert.deepEqual(steer.params.input.map(({ type }) => type), ["text"]);
  assert.equal(steer.params.input[0].text.includes(`## adjust.xlsx: ${attachmentPath("adjust.xlsx")}`), true);
  assert.equal(steer.params.input.some(({ type }) => type === "mention"), false);
  await client.stop();
});

test("keeps ordinary files attached when a queued Prompt starts its own Turn", async () => {
  const server = fakeControllerServer();
  const client = controller(server);
  await client.start();

  const result = await client.startQueuedPrompt({
    threadId,
    text: "read queued workbook",
    attachments: [{ kind: "file", localPath: attachmentPath("queued.xlsx"), name: "queued.xlsx" }],
    clientUserMessageId: "om_file_queue",
  });

  assert.equal(result.kind, "started");
  const start = server.requests.find(({ method }) => method === "turn/start");
  assert.deepEqual(start.params.input.map(({ type }) => type), ["text"]);
  assert.equal(start.params.input[0].text.includes(`## queued.xlsx: ${attachmentPath("queued.xlsx")}`), true);
  assert.match(start.params.input[0].text, /## My request for Codex:\nread queued workbook$/);
  await client.stop();
});

test("accepts an image-only Feishu prompt", async () => {
  const server = fakeControllerServer();
  const client = controller(server);
  await client.start();
  await client.submitPrompt({
    threadId,
    attachments: [{ kind: "image", localPath: attachmentPath("only.png"), name: "only.png" }],
    clientUserMessageId: "om_image_only",
  });
  const request = server.requests.find(({ method }) => method === "turn/start");
  assert.deepEqual(request.params.input, [{ type: "localImage", path: attachmentPath("only.png") }]);
  await client.stop();
});

test("forwards only the collector's public commentary callback", async () => {
  const server = fakeControllerServer();
  const progress = [];
  const client = controller(server, { onTurnProgress: (record) => progress.push(record) });
  await client.start();
  await client.submitPrompt({ threadId, text: "initial", clientUserMessageId: "om_progress" });
  server.emitCommentary("checking the workspace");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(progress.length, 1);
  assert.equal(progress[0].threadId, threadId);
  assert.equal(progress[0].turnId, "turn-1");
  assert.equal(progress[0].text, "checking the workspace");
  await client.stop();
});

test("falls back to a new turn only after steer loses the completion race and a fresh read reports idle", async () => {
  const server = fakeControllerServer({
    activeTurn: {
      id: "turn-old",
      status: "inProgress",
      startedAt: Date.now() / 1000,
      completedAt: null,
      items: [userItem("desktop", "old prompt")],
    },
  });
  server.failNextSteer = true;
  const client = controller(server);
  await client.start();
  const result = await client.submitPrompt({ threadId, text: "race prompt", clientUserMessageId: "om_race" });
  assert.deepEqual(result, { kind: "started", turnId: "turn-1", boundaryChanged: true });
  const relevant = server.requests.filter(({ method }) => ["thread/read", "turn/steer", "turn/start"].includes(method));
  const steerIndex = relevant.findIndex(({ method }) => method === "turn/steer");
  assert.equal(relevant[steerIndex + 1].method, "thread/read");
  assert.equal(relevant[steerIndex + 2].method, "turn/start");
  await client.stop();
});

test("queues behind an active Turn without steering and starts only after the Session is idle", async () => {
  const server = fakeControllerServer({
    activeTurn: {
      id: "turn-active",
      status: "inProgress",
      startedAt: Date.now() / 1000,
      completedAt: null,
      items: [userItem("desktop-client", "current work")],
    },
  });
  const client = controller(server);
  await client.start();

  const waiting = await client.startQueuedPrompt({
    threadId,
    text: "next work",
    clientUserMessageId: "om_queued",
  });
  assert.equal(waiting.kind, "waiting");
  assert.equal(waiting.reason, "turn_active");
  assert.equal(server.requests.some(({ method }) => method === "turn/steer"), false);
  assert.equal(server.requests.some(({ method }) => method === "turn/start"), false);

  server.completeActive("done");
  await new Promise((resolve) => setImmediate(resolve));
  const started = await client.startQueuedPrompt({
    threadId,
    text: "next work",
    clientUserMessageId: "om_queued",
  });
  assert.deepEqual(started, { kind: "started", turnId: "turn-1", turnStatus: "inProgress" });
  const queuedTurn = server.turns.find(({ id }) => id === "turn-1");
  assert.equal(queuedTurn.items[0].clientId, "om_queued");
  await client.stop();
});

test("keeps a queued prompt waiting while a native Goal is active", async () => {
  const server = fakeControllerServer({
    goal: {
      threadId,
      objective: "finish goal",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
    },
  });
  const client = controller(server);
  await client.start();
  const result = await client.startQueuedPrompt({
    threadId,
    text: "wait for goal",
    clientUserMessageId: "om_goal_queue",
  });
  assert.deepEqual(result, { kind: "waiting", reason: "goal_active" });
  assert.equal(server.requests.some(({ method }) => method === "turn/start"), false);
  await client.stop();
});

test("keeps a queued prompt pending when Desktop wins the idle-to-start race", async () => {
  const server = fakeControllerServer();
  server.raceNextStartWithDesktop = true;
  const client = controller(server);
  await client.start();
  const result = await client.startQueuedPrompt({
    threadId,
    text: "must be its own turn",
    clientUserMessageId: "om_race_queue",
  });
  assert.equal(result.kind, "waiting");
  assert.equal(result.reason, "turn_active");
  assert.equal(result.turnId, "turn-desktop-race");
  assert.equal(server.requests.some(({ method }) => method === "turn/steer"), false);
  assert.equal(server.turns.some((turn) => turn.items.some(({ clientId }) => clientId === "om_race_queue")), false);
  await client.stop();
});

test("reconciles a queued Turn accepted just before disconnect without starting it twice", async () => {
  const server = fakeControllerServer();
  server.acceptThenDisconnectNextStart = true;
  const client = controller(server);
  await client.start();
  const result = await client.startQueuedPrompt({
    threadId,
    text: "survive reconnect",
    clientUserMessageId: "om_queue_disconnect",
  });
  assert.deepEqual(result, {
    kind: "accepted",
    turnId: "turn-1",
    turnStatus: "inProgress",
    inputIndex: 0,
    recoveredAfterReconnect: true,
  });
  assert.equal(server.requests.filter(({ method }) => method === "turn/start").length, 1);
  assert.equal(server.turns.filter((turn) => turn.items.some(({ clientId }) => clientId === "om_queue_disconnect")).length, 1);
  await client.stop();
});

test("stop pauses an active native Goal before interrupting the exact active turn", async () => {
  const server = fakeControllerServer({
    activeTurn: {
      id: "turn-goal",
      status: "inProgress",
      startedAt: Date.now() / 1000,
      completedAt: null,
      items: [],
    },
    goal: {
      threadId,
      objective: "finish everything",
      status: "active",
      tokenBudget: 10000,
      tokensUsed: 100,
      timeUsedSeconds: 5,
      createdAt: 1,
      updatedAt: 2,
    },
  });
  const client = controller(server);
  await client.start();
  const baseline = server.requests.length;
  const result = await client.interrupt(threadId, { pauseGoal: true });
  assert.deepEqual(result, { interrupted: true, turnId: "turn-goal", goalPaused: true });
  assert.equal(server.goal.status, "paused");
  assert.deepEqual(server.requests.slice(baseline).map(({ method }) => method), [
    "thread/goal/get",
    "thread/goal/set",
    "thread/read",
    "turn/interrupt",
  ]);
  assert.equal(server.requests.at(-1).params.turnId, "turn-goal");
  await client.stop();
});

test("validates model, effort, speed dynamically and keeps native Plan separate from Goal", async () => {
  const server = fakeControllerServer();
  const client = controller(server);
  await client.start();
  const effortOnly = await client.updateModel(threadId, { effort: "high" });
  assert.equal(effortOnly.model, "model-one");
  assert.equal(effortOnly.effort, "high");
  assert.equal(effortOnly.serviceTier, null);
  const updated = await client.updateModel(threadId, { model: "2", effort: "high", serviceTier: "fast" });
  assert.deepEqual(updated, {
    model: "model-two",
    effort: "high",
    serviceTier: "priority",
    supportedEfforts: ["high"],
    supportedServiceTiers: ["priority", "fast"],
  });
  await assert.rejects(
    () => client.updateModel(threadId, { effort: "low" }),
    (error) => error.code === "reasoning_effort_unsupported",
  );

  const plan = await client.setPlan(threadId, true);
  assert.equal(plan.mode, "plan");
  const goal = await client.startGoal(threadId, "ship the controller");
  assert.equal(goal.status, "active");
  assert.equal(server.settings.collaborationMode.mode, "default");
  assert.equal(server.goal.objective, "ship the controller");
  await assert.rejects(
    () => client.setPlan(threadId, true),
    (error) => error.code === "goal_active",
  );
  await client.stop();
});

test("reconnects and catches up a Desktop turn completed during the disconnect window", async () => {
  const server = fakeControllerServer();
  let resolveCompleted;
  const completion = new Promise((resolve) => { resolveCompleted = resolve; });
  const client = controller(server, { onTurnCompleted: resolveCompleted });
  await client.start();
  server.disconnect();
  server.turns.push({
    id: "turn-offline",
    status: "completed",
    startedAt: (Date.now() + 500) / 1000,
    completedAt: (Date.now() + 1000) / 1000,
    items: [
      userItem("desktop-client", "offline Desktop prompt"),
      { id: "offline-answer", type: "agentMessage", phase: "final_answer", text: "offline answer" },
    ],
  });
  server.status = { type: "idle" };
  const record = await Promise.race([
    completion,
    new Promise((_, reject) => setTimeout(() => reject(new Error("reconnect timed out")), 1000)),
  ]);
  assert.equal(record.turnId, "turn-offline");
  assert.equal(record.prompt, "offline Desktop prompt");
  assert.equal(record.answer, "offline answer");
  assert.ok(server.sockets.length >= 2);
  await client.stop();
});

test("runs the complete native Goal lifecycle without inventing a model turn", async () => {
  const server = fakeControllerServer({
    goal: {
      threadId,
      objective: "old goal",
      status: "paused",
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 2,
      createdAt: 1,
      updatedAt: 2,
    },
  });
  const client = controller(server);
  await client.start();
  assert.equal((await client.resumeGoal(threadId)).status, "active");
  assert.equal((await client.setGoalBudget(threadId, 50_000)).tokenBudget, 50_000);
  assert.equal((await client.pauseGoal(threadId)).status, "paused");
  const replacement = await client.replaceGoal(threadId, "new goal");
  assert.equal(replacement.objective, "new goal");
  assert.equal(replacement.status, "active");
  assert.deepEqual(await client.clearGoal(threadId), { cleared: true });
  assert.equal(await client.getGoal(threadId, { refresh: true }), null);
  assert.equal(server.requests.some(({ method }) => method === "turn/start"), false);
  await client.stop();
});

test("reconciles a steer accepted just before disconnect without submitting the prompt twice", async () => {
  const server = fakeControllerServer({
    activeTurn: {
      id: "turn-desktop-active",
      status: "inProgress",
      startedAt: Date.now() / 1000,
      completedAt: null,
      items: [userItem("desktop-client", "Desktop prompt")],
    },
  });
  const client = controller(server);
  await client.start();
  server.acceptThenDisconnectNextSteer = true;
  const result = await client.submitPrompt({
    threadId,
    text: "Feishu adjustment during disconnect",
    clientUserMessageId: "om_disconnect_steer",
  });
  assert.deepEqual(result, {
    kind: "steered",
    turnId: "turn-desktop-active",
    boundaryChanged: false,
    recoveredAfterReconnect: true,
  });
  const turn = server.turns.find(({ id }) => id === "turn-desktop-active");
  assert.equal(turn.items.filter(({ clientId }) => clientId === "om_disconnect_steer").length, 1);
  assert.equal(server.requests.filter(({ method }) => method === "turn/steer").length, 1);
  assert.ok(server.sockets.length >= 2);
  await client.stop();
});
