import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  CodexAppToolsPipeClient,
  createWindowsCodexAppToolRequestHandler,
  listCodexAppToolsPipePaths,
  requestCodexAppToolsPipe,
  validateWindowsCodexAppToolsPipe,
} from "../../../src/runtime/platform/windows/codex-app-tools-pipe-client.mjs";
import {
  createCodexAppToolsMcpHandler,
  resolveAutomationTool,
} from "../../../src/runtime/platform/windows/codex-app-tools-mcp-proxy.mjs";

const call = {
  threadId: "thread-one",
  turnId: "turn-one",
  callId: "call-one",
  namespace: "codex_app",
  tool: "automation_update",
  arguments: { mode: "create" },
};

function createClient(options) {
  return new CodexAppToolsPipeClient({
    validatePipePath: async () => true,
    ...options,
  });
}

function framed(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function fakePipe(responseForRequest, { chunks = 1 } = {}) {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => { socket.destroyed = true; };
  socket.write = (frame) => {
    const length = frame.readUInt32LE(0);
    const request = JSON.parse(frame.subarray(4, 4 + length).toString("utf8"));
    const response = responseForRequest(request);
    if (!response) return;
    const output = Buffer.isBuffer(response) ? response : framed(response);
    if (chunks === 1) socket.emit("data", output);
    else {
      const split = Math.min(3, output.length);
      socket.emit("data", output.subarray(0, split));
      socket.emit("data", output.subarray(split));
    }
  };
  queueMicrotask(() => socket.emit("connect"));
  return socket;
}

test("discovers the Desktop host that advertises the requested tool and forwards the call", async () => {
  const requests = [];
  const client = createClient({
    listPipePaths: async () => ["pipe-other", "pipe-desktop"],
    requestPipe: async (pipePath, method, params) => {
      requests.push({ pipePath, method, params });
      if (method === "tools/list") {
        return { tools: pipePath === "pipe-desktop"
          ? [{ namespace: "codex_app", name: "automation_update" }]
          : [{ namespace: "browser", name: "open" }] };
      }
      return { contentItems: [{ type: "inputText", text: "ok" }], success: true };
    },
  });

  const result = await client.handleRequest("item/tool/call", call);

  assert.deepEqual(result, { contentItems: [{ type: "inputText", text: "ok" }], success: true });
  assert.deepEqual(requests.at(-1), {
    pipePath: "pipe-desktop",
    method: "tools/call",
    params: {
      arguments: { mode: "create" },
      callId: "call-one",
      namespace: "codex_app",
      threadId: "thread-one",
      tool: "automation_update",
      turnId: "turn-one",
    },
  });
});

test("uses a short probe timeout and the Desktop-compatible call timeout", async () => {
  const timeouts = [];
  const client = createClient({
    listPipePaths: async () => ["desktop"],
    requestPipe: async (_pipePath, method, _params, options) => {
      timeouts.push([method, options.timeoutMs]);
      return method === "tools/list"
        ? { tools: [{ namespace: "codex_app", name: "automation_update" }] }
        : { contentItems: [], success: true };
    },
  });
  await client.handleRequest("item/tool/call", call);
  assert.deepEqual(timeouts, [["tools/list", 2_000], ["tools/call", 60_000]]);
});

test("fails closed when multiple Desktop hosts advertise the same tool", async () => {
  const client = createClient({
    listPipePaths: async () => ["desktop-one", "desktop-two"],
    requestPipe: async () => ({
      tools: [{ namespace: "codex_app", name: "automation_update" }],
    }),
  });
  await assert.rejects(
    () => client.handleRequest("item/tool/call", call),
    (error) => error.code === "codex_app_tools_host_ambiguous",
  );
});

test("refuses to call a tool through an untrusted pipe server", async () => {
  let calledTool = false;
  const client = createClient({
    listPipePaths: async () => ["spoofed"],
    validatePipePath: async () => false,
    requestPipe: async (_pipePath, method) => {
      if (method === "tools/call") calledTool = true;
      return { tools: [{ namespace: "codex_app", name: "automation_update" }] };
    },
  });
  await assert.rejects(
    () => client.handleRequest("item/tool/call", call),
    (error) => error.code === "codex_app_tools_host_untrusted",
  );
  assert.equal(calledTool, false);
});

test("does not invoke a tool when no Desktop host advertises it", async () => {
  let calledTool = false;
  const client = createClient({
    listPipePaths: async () => ["pipe-other"],
    requestPipe: async (_pipePath, method) => {
      if (method === "tools/call") calledTool = true;
      return { tools: [{ namespace: "browser", name: "open" }] };
    },
  });

  await assert.rejects(
    () => client.handleRequest("item/tool/call", call),
    (error) => error.code === "codex_app_tool_unavailable",
  );
  assert.equal(calledTool, false);
});

test("rejects malformed and unrelated app-server requests before pipe access", async () => {
  let listed = false;
  const client = createClient({
    listPipePaths: async () => {
      listed = true;
      return [];
    },
  });

  await assert.rejects(
    () => client.handleRequest("account/read", call),
    (error) => error.rpcCode === -32601,
  );
  await assert.rejects(
    () => client.handleRequest("item/tool/call", { ...call, callId: "" }),
    (error) => error.code === "codex_app_tool_invalid_request",
  );
  assert.equal(listed, false);
});

test("validates every required dynamic tool request field", async () => {
  const client = createClient({ listPipePaths: async () => [] });
  for (const params of [
    undefined,
    { ...call, threadId: "" },
    { ...call, turnId: "" },
    { ...call, tool: "" },
    { ...call, namespace: 42 },
  ]) {
    await assert.rejects(
      () => client.handleRequest("item/tool/call", params),
      (error) => error.code === "codex_app_tool_invalid_request",
    );
  }
});

test("ignores rejected probes and rejects malformed tool results", async () => {
  const client = createClient({
    listPipePaths: async () => ["broken", "desktop"],
    requestPipe: async (pipePath, method) => {
      if (pipePath === "broken") throw new Error("closed");
      if (method === "tools/list") {
        return { tools: [{ namespace: "codex_app", name: "automation_update" }] };
      }
      return { success: true };
    },
  });
  await assert.rejects(
    () => client.handleRequest("item/tool/call", call),
    (error) => error.code === "codex_app_tools_protocol_error",
  );
});

test("rejects malformed content items at the compatibility boundary", async () => {
  for (const contentItems of [
    [{ type: "inputText" }],
    [{ type: "inputImage", imageUrl: 42 }],
    [{ type: "inputAudio" }],
    [{ type: "unknown", text: "no" }],
  ]) {
    const client = createClient({
      listPipePaths: async () => ["desktop"],
      requestPipe: async (_pipePath, method) => method === "tools/list"
        ? { tools: [{ namespace: "codex_app", name: "automation_update" }] }
        : { contentItems, success: true },
    });
    await assert.rejects(
      () => client.handleRequest("item/tool/call", call),
      (error) => error.code === "codex_app_tools_protocol_error",
    );
  }
});

test("prefers an exact configured app-tools pipe over directory discovery", async () => {
  let enumerated = false;
  const paths = await listCodexAppToolsPipePaths({
    env: { CODEX_APP_TOOLS_PIPE_PATH: "\\\\.\\pipe\\codex-browser-use-explicit" },
    platform: "win32",
    readdirImpl: async () => { enumerated = true; return ["codex-browser-use-desktop"]; },
  });
  assert.deepEqual(paths, ["\\\\.\\pipe\\codex-browser-use-explicit"]);
  assert.equal(enumerated, false);

  assert.deepEqual(await listCodexAppToolsPipePaths({
    env: {},
    platform: "win32",
    readdirImpl: async () => [
      "unrelated",
      "codex-browser-use-desktop",
      "codex-browser-use-desktop",
    ],
  }), ["\\\\.\\pipe\\codex-browser-use-desktop"]);

  assert.deepEqual(await listCodexAppToolsPipePaths({
    env: {},
    platform: "linux",
    readdirImpl: async () => { throw new Error("must not enumerate"); },
  }), []);
  assert.deepEqual(await listCodexAppToolsPipePaths({
    env: { CODEX_APP_TOOLS_PIPE_PATH: "configured" },
    platform: "win32",
    readdirImpl: async () => { throw new Error("unavailable"); },
  }), ["configured"]);
});

test("validates pipe ownership through a signed Codex Desktop process", async () => {
  let invocation;
  const trusted = await validateWindowsCodexAppToolsPipe("\\\\.\\pipe\\desktop", {
    env: { SystemRoot: "C:\\Windows" },
    execFileImpl: (file, args, options, callback) => {
      invocation = { file, args, options };
      callback(null, "trusted");
    },
  });
  assert.equal(trusted, true);
  assert.equal(invocation.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(invocation.options.windowsHide, true);
  assert.equal(invocation.options.env.FEISHU_CODEX_APP_TOOLS_PIPE_PATH, "\\\\.\\pipe\\desktop");

  assert.equal(await validateWindowsCodexAppToolsPipe("pipe", {
    env: {},
    execFileImpl: (_file, _args, _options, callback) => callback(new Error("untrusted"), ""),
  }), false);
});

test("round-trips a framed native pipe response assembled from partial chunks", async () => {
  const result = await requestCodexAppToolsPipe("pipe", "tools/list", {}, {
    connectImpl: () => fakePipe((request) => ({
      id: request.id,
      result: { tools: [] },
    }), { chunks: 2 }),
  });
  assert.deepEqual(result, { tools: [] });
});

test("preserves native JSON-RPC errors and their codes", async () => {
  await assert.rejects(
    () => requestCodexAppToolsPipe("pipe", "tools/call", {}, {
      connectImpl: () => fakePipe((request) => ({
        id: request.id,
        error: { code: -32005, message: "not allowed" },
      })),
    }),
    (error) => error.code === "codex_app_tool_failed"
      && error.rpcCode === -32005
      && error.message === "not allowed",
  );
});

test("rejects invalid, mismatched, and oversized native pipe responses", async () => {
  const cases = [
    () => {
      const payload = Buffer.from("not-json", "utf8");
      const frame = Buffer.alloc(payload.length + 4);
      frame.writeUInt32LE(payload.length, 0);
      payload.copy(frame, 4);
      return frame;
    },
    (request) => ({ id: `${request.id}-other`, result: {} }),
    () => {
      const frame = Buffer.alloc(4);
      frame.writeUInt32LE(8 * 1024 * 1024 + 1, 0);
      return frame;
    },
  ];
  for (const response of cases) {
    await assert.rejects(
      () => requestCodexAppToolsPipe("pipe", "tools/list", {}, {
        connectImpl: () => fakePipe(response),
      }),
      (error) => error.code === "codex_app_tools_protocol_error",
    );
  }
});

test("normalizes pipe connection failures and timeouts", async () => {
  await assert.rejects(
    () => requestCodexAppToolsPipe("pipe", "tools/list", {}, {
      connectImpl: () => { throw new Error("connect failed"); },
    }),
    (error) => error.code === "codex_app_tools_host_unavailable",
  );

  const closed = new EventEmitter();
  closed.destroy = () => {};
  queueMicrotask(() => closed.emit("close"));
  await assert.rejects(
    () => requestCodexAppToolsPipe("pipe", "tools/list", {}, { connectImpl: () => closed }),
    (error) => error.code === "codex_app_tools_host_unavailable",
  );

  const silent = new EventEmitter();
  silent.destroy = () => {};
  await assert.rejects(
    () => requestCodexAppToolsPipe("pipe", "tools/list", {}, {
      connectImpl: () => silent,
      timeoutMs: 5,
    }),
    (error) => error.code === "codex_app_tools_host_unavailable",
  );
});

test("marks a lost tools/call response as an unknown outcome", async () => {
  const socket = new EventEmitter();
  socket.destroy = () => {};
  socket.write = () => { queueMicrotask(() => socket.emit("close")); };
  queueMicrotask(() => socket.emit("connect"));
  await assert.rejects(
    () => requestCodexAppToolsPipe("pipe", "tools/call", {}, { connectImpl: () => socket }),
    (error) => error.code === "codex_app_tool_outcome_unknown",
  );
});

test("rejects an oversized native pipe request before writing", async () => {
  await assert.rejects(
    () => requestCodexAppToolsPipe("pipe", "tools/call", { value: "x".repeat(8 * 1024 * 1024) }, {
      connectImpl: () => fakePipe(() => undefined),
    }),
    (error) => error.code === "codex_app_tool_request_too_large",
  );
});

test("creates a reusable Windows request handler", async () => {
  const handler = createWindowsCodexAppToolRequestHandler({
    listPipePaths: async () => ["desktop"],
    validatePipePath: async () => true,
    requestPipe: async (_pipePath, method) => method === "tools/list"
      ? { tools: [{ namespace: "codex_app", name: "automation_update" }] }
      : { contentItems: [], success: true },
  });
  assert.deepEqual(await handler("item/tool/call", call), { contentItems: [], success: true });
});

test("resolves one trusted automation_update host for the MCP proxy", async () => {
  const resolved = await resolveAutomationTool({
    listPipePaths: async () => ["pipe-a", "pipe-b"],
    requestPipe: async (pipePath) => ({
      tools: pipePath === "pipe-b"
        ? [{ namespace: "codex_app", name: "automation_update", description: "update", inputSchema: { type: "object" } }]
        : [],
    }),
    validatePipePath: async (pipePath) => pipePath === "pipe-b",
  });
  assert.equal(resolved.pipePath, "pipe-b");
  assert.equal(resolved.tool.name, "automation_update");
});

test("MCP proxy lists and calls automation_update through the trusted Desktop host", async () => {
  const calls = [];
  const tool = {
    namespace: "codex_app",
    name: "automation_update",
    description: "Update an automation",
    inputSchema: { type: "object", properties: { mode: { type: "string" } } },
  };
  const handle = createCodexAppToolsMcpHandler({
    threadId: "11111111-1111-4111-8111-111111111111",
    resolveTool: async () => ({ pipePath: "pipe", tool }),
    requestPipe: async (pipePath, method, params, options) => {
      calls.push({ pipePath, method, params, options });
      return { success: true, contentItems: [{ type: "inputText", text: "deleted" }] };
    },
  });

  const listed = await handle("tools/list");
  assert.deepEqual(listed, {
    tools: [{ name: "automation_update", description: "Update an automation", inputSchema: tool.inputSchema }],
  });
  const result = await handle("tools/call", {
    name: "automation_update",
    arguments: { mode: "delete", id: "automation-id" },
  });
  assert.deepEqual(result, { content: [{ type: "text", text: "deleted" }], isError: false });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "tools/call");
  assert.equal(calls[0].params.namespace, "codex_app");
  assert.equal(calls[0].params.tool, "automation_update");
  assert.equal(calls[0].params.threadId, "11111111-1111-4111-8111-111111111111");
  assert.deepEqual(calls[0].params.arguments, { mode: "delete", id: "automation-id" });
});
