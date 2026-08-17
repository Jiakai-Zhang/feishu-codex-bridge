import { assertPlatform } from "../detect.mjs";

export const MACOS_LABELS = Object.freeze({
  environment: "com.feishu-codex-bridge.environment",
  appServer: "com.feishu-codex-bridge.app-server",
  bridge: "com.feishu-codex-bridge.bridge",
  relay: "com.feishu-codex-bridge.desktop-relay",
});

export const RELAY_ENVIRONMENT_VARIABLE = "CODEX_APP_SERVER_WS_URL";

export function assertMacOS() {
  return assertPlatform("macos");
}
