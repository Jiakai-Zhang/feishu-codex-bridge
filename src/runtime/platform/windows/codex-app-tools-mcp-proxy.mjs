import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  listCodexAppToolsPipePaths,
  requestCodexAppToolsPipe,
  validateWindowsCodexAppToolsPipe,
} from "./codex-app-tools-pipe-client.mjs";

const TOOL_NAMESPACE = "codex_app";
const TOOL_NAME = "automation_update";
const PROBE_TIMEOUT_MS = 2_000;
const CALL_TIMEOUT_MS = 60_000;
const MCP_PROTOCOL_VERSION = "2025-06-18";

function proxyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requestedTool(result) {
  return Array.isArray(result?.tools)
    ? result.tools.find((tool) => tool?.namespace === TOOL_NAMESPACE && tool?.name === TOOL_NAME)
    : undefined;
}

export async function resolveAutomationTool({
  listPipePaths = listCodexAppToolsPipePaths,
  requestPipe = requestCodexAppToolsPipe,
  validatePipePath = validateWindowsCodexAppToolsPipe,
} = {}) {
  const candidates = await listPipePaths();
  const probes = await Promise.allSettled(candidates.map(async (pipePath) => {
    const result = await requestPipe(
      pipePath,
      "tools/list",
      { threadStartKind: "all" },
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    const tool = requestedTool(result);
    return tool ? { pipePath, tool } : undefined;
  }));
  const matches = probes
    .filter((probe) => probe.status === "fulfilled" && probe.value)
    .map((probe) => probe.value);
  if (matches.length !== 1) {
    throw proxyError(
      matches.length > 1 ? "codex_app_tools_host_ambiguous" : "codex_app_tool_unavailable",
      matches.length > 1
        ? "Multiple Codex Desktop app-tools hosts advertised automation_update"
        : "Codex Desktop did not advertise automation_update",
    );
  }
  if (!await validatePipePath(matches[0].pipePath)) {
    throw proxyError(
      "codex_app_tools_host_untrusted",
      "The automation_update host is not owned by a signed Codex Desktop process",
    );
  }
  return matches[0];
}

function mcpContent(items) {
  return (items || []).map((item) => {
    if (item?.type === "inputText") return { type: "text", text: String(item.text || "") };
    if (item?.type === "inputImage") return { type: "text", text: String(item.imageUrl || "") };
    if (item?.type === "inputAudio") return { type: "text", text: String(item.audioUrl || "") };
    return { type: "text", text: "Codex Desktop returned an unsupported content item" };
  });
}

export function createCodexAppToolsMcpHandler({
  threadId,
  resolveTool = resolveAutomationTool,
  requestPipe = requestCodexAppToolsPipe,
} = {}) {
  if (typeof threadId !== "string" || !threadId) {
    throw new TypeError("FEISHU_CODEX_THREAD_ID is required for the Codex app-tools MCP proxy");
  }
  return async function handleMcpRequest(method, params = {}) {
    if (method === "initialize") {
      return {
        protocolVersion: params.protocolVersion || MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "feishu-codex-app-tools-proxy", version: "1.0.0" },
      };
    }
    if (method === "ping") return {};
    if (method === "tools/list") {
      const { tool } = await resolveTool();
      return {
        tools: [{
          name: TOOL_NAME,
          description: String(tool.description || "Update a Codex Desktop automation"),
          inputSchema: tool.inputSchema || tool.input_schema || { type: "object" },
        }],
      };
    }
    if (method === "tools/call") {
      if (params.name !== TOOL_NAME) {
        throw proxyError("codex_app_tool_unsupported_request", `Unsupported Codex app tool: ${params.name}`);
      }
      const { pipePath } = await resolveTool();
      const result = await requestPipe(pipePath, "tools/call", {
        arguments: params.arguments || {},
        callId: randomUUID(),
        namespace: TOOL_NAMESPACE,
        threadId,
        tool: TOOL_NAME,
        turnId: randomUUID(),
      }, { timeoutMs: CALL_TIMEOUT_MS });
      if (typeof result?.success !== "boolean" || !Array.isArray(result?.contentItems)) {
        throw proxyError("codex_app_tools_protocol_error", "Codex Desktop returned an invalid automation result");
      }
      return { content: mcpContent(result.contentItems), isError: !result.success };
    }
    throw proxyError("method_not_found", `Unsupported MCP request: ${method}`);
  };
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export async function runCodexAppToolsMcpProxy({
  input = process.stdin,
  threadId = process.env.FEISHU_CODEX_THREAD_ID,
} = {}) {
  const handle = createCodexAppToolsMcpHandler({ threadId });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
      continue;
    }
    if (message.id === undefined) continue;
    try {
      const result = await handle(message.method, message.params || {});
      writeMessage({ jsonrpc: "2.0", id: message.id, result });
    } catch (error) {
      writeMessage({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: error?.code === "method_not_found" ? -32601 : -32000,
          message: String(error?.message || "Codex app-tools proxy failed"),
        },
      });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCodexAppToolsMcpProxy();
}
