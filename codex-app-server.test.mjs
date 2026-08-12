import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { startCodexProjectThread } from "./codex-app-server.mjs";

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
    "thread/start",
    "thread/name/set",
  ]);
  assert.equal(server.requests.some(({ method }) => method === "turn/start"), false);
  assert.equal(server.requests[1].params.cwd, "C:/repo");
  assert.equal(server.requests[1].params.sandbox, "workspace-write");
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
