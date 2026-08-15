import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSessionRelayConfig } from "../relay/session-relay-config.mjs";
import { requestSessionBinding } from "../persistence/session-binding-inbox.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "../..");
const config = await loadSessionRelayConfig(path.join(repositoryRoot, "bridge.config.json"));
const argumentIndex = process.argv.indexOf("--thread-id");
const threadId = argumentIndex >= 0 ? process.argv[argumentIndex + 1] : process.env.CODEX_THREAD_ID;
const directory = path.join(config.workspace, "work", "feishu-codex-bridge", "session-binding-requests");

try {
  const response = await requestSessionBinding({ directory, threadId });
  process.stdout.write(`${JSON.stringify(response)}\n`);
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      code: String(error?.code || "binding_request_failed"),
      message: String(error?.message || "Session binding request failed").slice(0, 300),
    },
  })}\n`);
  process.exitCode = 1;
}
