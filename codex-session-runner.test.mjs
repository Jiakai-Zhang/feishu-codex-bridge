import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  CodexSessionBusyError,
  isActiveWriterError,
  runCodexSessionTurn,
} from "./codex-session-runner.mjs";

function fakeAppServer({
  resumeFailures = 0,
  resumeStatus = "idle",
  readStatuses = [],
  turnStatus = "completed",
  finalPhase = "final_answer",
} = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const requests = [];
  let inputBuffer = "";
  let resumeCount = 0;

  const write = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    inputBuffer += chunk;
    for (;;) {
      const newline = inputBuffer.indexOf("\n");
      if (newline < 0) break;
      const request = JSON.parse(inputBuffer.slice(0, newline));
      inputBuffer = inputBuffer.slice(newline + 1);
      requests.push(request);
      if (request.method === "initialize") {
        write({ id: request.id, result: { userAgent: "test" } });
      } else if (request.method === "thread/resume") {
        resumeCount += 1;
        if (resumeCount <= resumeFailures) {
          write({ id: request.id, error: { message: "thread thread-id already has an active writer" } });
        } else {
          write({ id: request.id, result: { thread: { id: "thread-id", status: { type: resumeStatus } } } });
        }
      } else if (request.method === "thread/read") {
        write({ id: request.id, result: { thread: { id: "thread-id", status: { type: readStatuses.shift() || "idle" } } } });
      } else if (request.method === "turn/start") {
        write({ id: request.id, result: { turn: { id: "turn-1", status: "inProgress", items: [] } } });
        queueMicrotask(() => {
          write({
            method: "item/completed",
            params: {
              threadId: "thread-id",
              turnId: "turn-1",
              completedAtMs: Date.now(),
              item: { id: "commentary-1", type: "agentMessage", phase: "commentary", text: "hidden progress" },
            },
          });
          write({
            method: "item/completed",
            params: {
              threadId: "thread-id",
              turnId: "turn-1",
              completedAtMs: Date.now(),
              item: { id: "answer-1", type: "agentMessage", phase: finalPhase, text: "final answer only" },
            },
          });
          write({
            method: "turn/completed",
            params: {
              threadId: "thread-id",
              turn: {
                id: "turn-1",
                status: turnStatus,
                items: [],
                ...(turnStatus === "failed" ? { error: { message: "model failed" } } : {}),
              },
            },
          });
        });
      } else if (request.method === "thread/unsubscribe") {
        write({ id: request.id, result: { status: "unsubscribed" } });
      }
    }
  });
  return { child, requests };
}

function fakeWebSocketAppServer() {
  const stdio = fakeAppServer();
  const requests = [];
  class FakeWebSocket extends EventTarget {
    constructor(url) {
      super();
      this.url = url;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(data) {
      const request = JSON.parse(data);
      requests.push(request);
      stdio.child.stdin.write(`${JSON.stringify(request)}\n`);
    }
    close() {}
  }
  let buffer = "";
  stdio.child.stdout.setEncoding("utf8");
  stdio.child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      queueMicrotask(() => socket.dispatchEvent(new MessageEvent("message", { data: line })));
    }
  });
  const socket = new FakeWebSocket("ws://127.0.0.1:47321/rpc");
  return {
    FakeWebSocket: class {
      constructor() { return socket; }
    },
    requests,
  };
}

test("resumes the statically bound task and returns only its final answer", async () => {
  const server = fakeAppServer();
  const answer = await runCodexSessionTurn({
    codexExecutable: "codex",
    session: { id: "thread-id", cwd: "C:/repo" },
    prompt: "line one\nline two",
    sandboxMode: "workspace-write",
    clientUserMessageId: "message-id",
    spawnProcess: () => server.child,
  });

  assert.equal(answer, "final answer only");
  assert.deepEqual(server.requests.map(({ method }) => method), [
    "initialize",
    "thread/resume",
    "turn/start",
    "thread/unsubscribe",
  ]);
  assert.deepEqual(server.requests[1].params, {
    threadId: "thread-id",
    cwd: "C:/repo",
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  assert.deepEqual(server.requests[2].params.input, [
    { type: "text", text: "line one\nline two", text_elements: [] },
  ]);
  assert.equal(server.requests[2].params.clientUserMessageId, "message-id");
});

test("waits for an active Desktop writer and retries the ownership handoff", async () => {
  const server = fakeAppServer({ resumeFailures: 1 });
  const delays = [];
  const logs = [];
  const answer = await runCodexSessionTurn({
    codexExecutable: "codex",
    session: { id: "thread-id", cwd: "C:/repo" },
    prompt: "test",
    sandboxMode: "read-only",
    writerRetryMs: 25,
    spawnProcess: () => server.child,
    sleepImpl: async (ms) => { delays.push(ms); },
    log: (message) => logs.push(message),
  });

  assert.equal(answer, "final answer only");
  assert.deepEqual(delays, [25]);
  assert.equal(server.requests.filter(({ method }) => method === "thread/resume").length, 2);
  assert.equal(logs.some((message) => message.includes("ownership handoff")), true);
});

test("waits for an active turn on a shared writer before starting the Feishu turn", async () => {
  const server = fakeAppServer({ resumeStatus: "active", readStatuses: ["active", "idle"] });
  const delays = [];
  const answer = await runCodexSessionTurn({
    codexExecutable: "codex",
    session: { id: "thread-id", cwd: "C:/repo" },
    prompt: "queued prompt",
    sandboxMode: "workspace-write",
    spawnProcess: () => server.child,
    sleepImpl: async (ms) => { delays.push(ms); },
  });
  assert.equal(answer, "final answer only");
  assert.equal(server.requests.filter(({ method }) => method === "thread/read").length, 2);
  assert.equal(server.requests.findIndex(({ method }) => method === "turn/start") >
    server.requests.findLastIndex(({ method }) => method === "thread/read"), true);
  assert.equal(delays.length, 2);
});

test("uses the configured shared WebSocket App Server instead of spawning another writer", async () => {
  const server = fakeWebSocketAppServer();
  const answer = await runCodexSessionTurn({
    codexExecutable: "codex",
    session: { id: "thread-id", cwd: "C:/repo" },
    prompt: "test",
    sandboxMode: "workspace-write",
    appServerUrl: "ws://127.0.0.1:47321/rpc",
    WebSocketImpl: server.FakeWebSocket,
    spawnProcess: () => { throw new Error("must not spawn"); },
  });
  assert.equal(answer, "final answer only");
  assert.deepEqual(server.requests.map(({ method }) => method), [
    "initialize",
    "thread/resume",
    "turn/start",
    "thread/unsubscribe",
  ]);
});

test("uses an unphased agent message only as the compatibility fallback", async () => {
  const server = fakeAppServer({ finalPhase: null });
  const answer = await runCodexSessionTurn({
    codexExecutable: "codex",
    session: { id: "thread-id", cwd: "C:/repo" },
    prompt: "test",
    sandboxMode: "workspace-write",
    spawnProcess: () => server.child,
  });
  assert.equal(answer, "final answer only");
});

test("surfaces a failed Codex turn and still releases the task", async () => {
  const server = fakeAppServer({ turnStatus: "failed" });
  await assert.rejects(() => runCodexSessionTurn({
    codexExecutable: "codex",
    session: { id: "thread-id", cwd: "C:/repo" },
    prompt: "test",
    sandboxMode: "workspace-write",
    spawnProcess: () => server.child,
  }), /model failed/);
  assert.equal(server.requests.at(-1).method, "thread/unsubscribe");
});

test("classifies active-writer errors without hiding unrelated failures", () => {
  assert.equal(isActiveWriterError(new Error("thread x already has an active writer")), true);
  assert.equal(isActiveWriterError(new Error("authentication failed")), false);
  assert.equal(new CodexSessionBusyError().code, "session_busy");
});
