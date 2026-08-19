import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SessionAccessStore } from "../persistence/session-access-store.mjs";
import { loadSessionRelayConfig } from "../relay/session-relay-config.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../..");
export async function configureSessionAccess({
  repositoryDirectory = repositoryRoot,
  projectRoot,
  ownerDirectoryName,
} = {}) {
  const config = await loadSessionRelayConfig(path.join(repositoryDirectory, "bridge.config.json"));
  const runtimeDirectory = path.join(config.workspace, "work", "feishu-codex-bridge");
  const accessPath = path.join(runtimeDirectory, "session-relay-access.json");
  await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const store = await SessionAccessStore.open(accessPath, { ownerOpenId: config.agent.ownerOpenId });
  await store.configureProjectRoot({
    projectRoot,
    ownerDirectoryName,
  });
}

async function main() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  try {
    const request = JSON.parse(input);
    await configureSessionAccess({
      projectRoot: request?.projectRoot,
      ownerDirectoryName: request?.ownerDirectoryName,
    });
    process.stdout.write("Bridge Project root and Owner directory configured locally.\n");
  } catch (error) {
    const code = String(error?.code || "invalid_configuration").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    process.stderr.write(`Project root configuration failed (${code || "invalid_configuration"}); no path was printed.\n`);
    process.exitCode = 1;
  }
}

const invokedPath = await fs.realpath(path.resolve(process.argv[1] || "")).catch(() => path.resolve(process.argv[1] || ""));
const modulePath = await fs.realpath(fileURLToPath(import.meta.url)).catch(() => fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  await main();
}
