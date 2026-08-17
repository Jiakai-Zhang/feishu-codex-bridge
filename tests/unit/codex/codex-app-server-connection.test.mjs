import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexAppServerConnection,
  CodexAppServerRpcError,
} from "../../../src/codex/codex-app-server-connection.mjs";

class FakeWebSocket extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.dispatchEvent(closeEvent(1000));
  }

  receive(message) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

function closeEvent(code) {
  const event = new Event("close");
  Object.defineProperty(event, "code", { value: code });
  return event;
}

test("owns request correlation, notifications, and unsupported server requests", async () => {
  const notifications = [];
  const connection = new CodexAppServerConnection({
    url: "ws://127.0.0.1/rpc",
    WebSocketImpl: FakeWebSocket,
    onNotification: (method, params) => notifications.push([method, params]),
  });
  await connection.open();

  const pending = connection.request("thread/read", { threadId: "thread" });
  const request = connection.socket.sent.at(-1);
  connection.socket.receive({ id: request.id, result: { thread: { id: "thread" } } });
  assert.deepEqual(await pending, { thread: { id: "thread" } });

  connection.notify("initialized");
  assert.deepEqual(connection.socket.sent.at(-1), { method: "initialized", params: {} });

  connection.socket.receive({ method: "turn/started", params: { threadId: "thread" } });
  assert.deepEqual(notifications, [["turn/started", { threadId: "thread" }]]);

  connection.socket.receive({ id: 99, method: "account/read", params: {} });
  assert.deepEqual(connection.socket.sent.at(-1), {
    id: 99,
    error: { code: -32601, message: "Unsupported client request: account/read" },
  });
});

test("normalizes RPC failures and rejects pending work on close", async () => {
  const closes = [];
  const connection = new CodexAppServerConnection({
    url: "ws://127.0.0.1/rpc",
    WebSocketImpl: FakeWebSocket,
    onClose: (event) => closes.push(event),
  });
  await connection.open();

  const failed = connection.request("turn/start", {});
  const failedRequest = connection.socket.sent.at(-1);
  connection.socket.receive({ id: failedRequest.id, error: { code: 123, message: "rejected" } });
  await assert.rejects(failed, (error) => {
    assert.equal(error instanceof CodexAppServerRpcError, true);
    assert.equal(error.code, "codex_app_server_error");
    assert.equal(error.rpcCode, 123);
    return true;
  });

  const pending = connection.request("thread/read", {});
  connection.socket.dispatchEvent(closeEvent(1006));
  await assert.rejects(pending, (error) => error.code === "codex_app_server_unavailable");
  assert.equal(closes.length, 1);
  assert.equal(closes[0].intentional, false);
});
