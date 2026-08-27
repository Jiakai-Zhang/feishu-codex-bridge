import process from "node:process";
import { PLATFORM_IDS, platformId } from "./platform/detect.mjs";
import { createWindowsCodexAppToolRequestHandler } from "./platform/windows/codex-app-tools-pipe-client.mjs";

export function createCodexAppToolRequestHandler({
  runtimePlatform = process.platform,
  ...options
} = {}) {
  if (platformId(runtimePlatform) !== PLATFORM_IDS.Windows) return undefined;
  return createWindowsCodexAppToolRequestHandler(options);
}
