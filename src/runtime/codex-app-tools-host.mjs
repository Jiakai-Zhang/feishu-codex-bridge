import process from "node:process";
import { fileURLToPath } from "node:url";
import { PLATFORM_IDS, platformId } from "./platform/detect.mjs";
import { createWindowsCodexAppToolRequestHandler } from "./platform/windows/codex-app-tools-pipe-client.mjs";

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
