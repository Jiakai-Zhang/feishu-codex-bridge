import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setCodexThreadName, startCodexProjectThread } from "../../../src/codex/codex-app-server.mjs";

function fakeAppServer({ failAt } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const requests = [];
  let buffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const request = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      requests.push(request);
      if (request.id === failAt) child.stdout.write(`${JSON.stringify({ id: request.id, error: { message: "failed" } })}\n`);
      else if (request.id === 1) child.stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "test" } })}\n`);
      else if (request.id === 2) child.stdout.write(`${JSON.stringify({ id: 2, result: { thread: { id: "thread-1" } } })}\n`);
      else if (request.id === 3) child.stdout.write(`${JSON.stringify({ id: 3, result: {} })}\n`);
    }
  });
  return { child, requests };
}

function fakeWebSocketServer() {
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
      if (request.id === undefined) return;
      const result = request.method === "initialize"
        ? { userAgent: "test" }
        : request.method === "thread/start"
          ? { thread: { id: "thread-shared" } }
          : {};
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
        data: JSON.stringify({ id: request.id, result }),
      })));
    }
    close() {}
  }
  return { FakeWebSocket, requests };
}

test("creates and names an empty Codex Project thread without starting a turn", async () => {
  const server = fakeAppServer();
  const result = await startCodexProjectThread({
    codexExecutable: "codex",
    cwd: "C:/repo",
    name: "Fix login",
    sandboxMode: "workspace-write",
    spawnProcess: () => server.child,
  });
  assert.deepEqual(result, { id: "thread-1", name: "Fix login" });
  assert.deepEqual(server.requests.map(({ method }) => method), [
    "initialize",
    "initialized",
    "thread/start",
    "thread/name/set",
  ]);
  assert.equal(server.requests.some(({ method }) => method === "turn/start"), false);
  assert.deepEqual(server.requests[1], { method: "initialized", params: {} });
  assert.equal(server.requests[2].params.cwd, "C:/repo");
  assert.equal(server.requests[2].params.sandbox, "workspace-write");
});

test("fails closed when App Server rejects thread creation", async () => {
  const server = fakeAppServer({ failAt: 2 });
  await assert.rejects(() => startCodexProjectThread({
    codexExecutable: "codex",
    cwd: "C:/repo",
    name: "Fix login",
    sandboxMode: "read-only",
    spawnProcess: () => server.child,
  }), /failed/);
});

test("creates and names an empty task through the shared App Server", async () => {
  const server = fakeWebSocketServer();
  const result = await startCodexProjectThread({
    codexExecutable: "codex",
    cwd: "C:/independent",
    name: "Independent task",
    sandboxMode: "workspace-write",
    appServerUrl: "ws://127.0.0.1:47321/rpc",
    WebSocketImpl: server.FakeWebSocket,
  });

  assert.deepEqual(result, { id: "thread-shared", name: "Independent task" });
  assert.deepEqual(server.requests.map(({ method }) => method), [
    "initialize", "initialized", "thread/start", "thread/name/set",
  ]);
  assert.equal(server.requests[2].params.cwd, "C:/independent");
  assert.equal(server.requests.some(({ method }) => method === "turn/start"), false);
});

test("renames an existing Codex task without starting or resuming a turn", async () => {
  const server = fakeAppServer();
  const result = await setCodexThreadName({
    codexExecutable: "codex",
    cwd: "C:/repo",
    threadId: "thread-existing",
    name: "Feishu group",
    spawnProcess: () => server.child,
  });
  assert.deepEqual(result, { threadId: "thread-existing", name: "Feishu group" });
  assert.deepEqual(server.requests.map(({ method }) => method), ["initialize", "initialized", "thread/name/set"]);
  assert.deepEqual(server.requests[2].params, { threadId: "thread-existing", name: "Feishu group" });
  assert.equal(server.requests.some(({ method }) => method === "turn/start"), false);
});

test("renames through the shared App Server used by Codex Desktop and the relay", async () => {
  const server = fakeWebSocketServer();
  const result = await setCodexThreadName({
    codexExecutable: "codex",
    cwd: "C:/repo",
    threadId: "thread-existing",
    name: "Feishu group",
    appServerUrl: "ws://127.0.0.1:47321/rpc",
    WebSocketImpl: server.FakeWebSocket,
  });
  assert.deepEqual(result, { threadId: "thread-existing", name: "Feishu group" });
  assert.deepEqual(server.requests.map(({ method }) => method), ["initialize", "initialized", "thread/name/set"]);
});
