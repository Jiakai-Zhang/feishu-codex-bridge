import assert from "node:assert/strict";
import test from "node:test";
import { createCodexAppToolRequestHandler } from "../../../src/runtime/codex-app-tools-host.mjs";

test("installs the app-tools handler only for the Windows runtime", async () => {
  assert.equal(createCodexAppToolRequestHandler({ runtimePlatform: "darwin" }), undefined);

  const handler = createCodexAppToolRequestHandler({
    runtimePlatform: "win32",
    listPipePaths: async () => [],
    validatePipePath: async () => true,
  });
  assert.equal(typeof handler, "function");
  await assert.rejects(
    () => handler("item/tool/call", {
      threadId: "thread",
      turnId: "turn",
      callId: "call",
      namespace: null,
      tool: "missing",
      arguments: {},
    }),
    (error) => error.code === "codex_app_tool_unavailable",
  );
});
