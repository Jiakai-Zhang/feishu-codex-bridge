import assert from "node:assert/strict";
import test from "node:test";
import { CodexSessionController } from "./codex-session-controller.mjs";

const threadId = "019ff5b8-decb-7ca3-802c-f115f2f196de";
const target = { threadId, chatId: "oc_group", cwd: "C:/repo" };

function userItem(clientId, text, id = `user-${clientId}`) {
  return { id, type: "userMessage", clientId, content: [{ type: "text", text }] };
}

function fakeControllerServer({ activeTurn, goal = null } = {}) {
  const server = {
    requests: [],
    sockets: [],
    nextTurn: 1,
    failNextSteer: false,
    acceptThenDisconnectNextSteer: false,
    acceptThenDisconnectNextStart: false,
    raceNextStartWithDesktop: false,
    settings: {
      cwd: "C:/repo",
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
    turns: activeTurn ? [structuredClone(activeTurn)] : [],
    status: activeTurn ? { type: "active", activeFlags: [] } : { type: "idle" },
  };

  function threadSnapshot(includeTurns = true) {
    return {
      id: threadId,
      cwd: "C:/repo",
      status: structuredClone(server.status),
      turns: includeTurns ? structuredClone(server.turns) : [],
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
    server.requests.push(structuredClone(request));
    if (request.method === "initialize") {
      respond(socket, request.id, { userAgent: "test" });
    } else if (request.method === "thread/resume") {
      respond(socket, request.id, {
        thread: threadSnapshot(false),
        model: server.settings.model,
        modelProvider: "openai",
        serviceTier: server.settings.serviceTier,
        reasoningEffort: server.settings.effort,
      });
    } else if (request.method === "thread/read") {
      respond(socket, request.id, { thread: threadSnapshot(request.params.includeTurns) });
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
        items: [userItem(request.params.clientUserMessageId, request.params.input[0].text)],
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
        const item = userItem(
          request.params.clientUserMessageId,
          request.params.input[0].text,
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

test("starts an idle Feishu prompt, steers the next prompt into the same active turn, and emits one final", async () => {
  const server = fakeControllerServer();
  const completed = [];
  const client = controller(server, { onTurnCompleted: (record) => completed.push(record) });
  await client.start();
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
