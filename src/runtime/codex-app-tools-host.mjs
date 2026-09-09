import process from "node:process";
import { fileURLToPath } from "node:url";
import { PLATFORM_IDS, platformId } from "./platform/detect.mjs";
import { createWindowsCodexAppToolRequestHandler } from "./platform/windows/codex-app-tools-pipe-client.mjs";
import { resolveAutomationTool } from "./platform/windows/codex-app-tools-mcp-proxy.mjs";

const WINDOWS_CODEX_APP_TOOLS_MCP_PROXY_PATH = fileURLToPath(new URL(
  "./platform/windows/codex-app-tools-mcp-proxy.mjs",
  import.meta.url,
));

export function createCodexAppAutomationToolConfig(threadId, {
  nodePath = process.execPath,
} = {}) {
  return Object.freeze({
    "mcp_servers.codex_app.command": nodePath,
    "mcp_servers.codex_app.args": Object.freeze([WINDOWS_CODEX_APP_TOOLS_MCP_PROXY_PATH]),
    "mcp_servers.codex_app.env": Object.freeze({ FEISHU_CODEX_THREAD_ID: threadId }),
    "mcp_servers.codex_app.enabled": true,
    "mcp_servers.codex_app.enabled_tools": Object.freeze(["automation_update"]),
  });
}

export function createCodexAppToolRequestHandler({
  runtimePlatform = process.platform,
  ...options
} = {}) {
  if (platformId(runtimePlatform) !== PLATFORM_IDS.Windows) return undefined;
  return createWindowsCodexAppToolRequestHandler(options);
}

export async function loadCodexAppAutomationDynamicTools({
  runtimePlatform = process.platform,
  ...options
} = {}) {
  if (platformId(runtimePlatform) !== PLATFORM_IDS.Windows) return Object.freeze([]);
  const { tool } = await resolveAutomationTool(options);
  return Object.freeze([Object.freeze({
    type: "namespace",
    name: String(tool.namespace || "codex_app"),
    description: "Codex Desktop tools",
    tools: Object.freeze([Object.freeze({
      type: "function",
      name: String(tool.name || "automation_update"),
      description: String(tool.description || "Update a Codex Desktop automation"),
      inputSchema: tool.inputSchema || tool.input_schema || { type: "object" },
    })]),
  })]);
}
