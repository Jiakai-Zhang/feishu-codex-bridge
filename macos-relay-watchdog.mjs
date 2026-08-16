import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appServerReadyProbe,
  assertMacOS,
  getLaunchEnvironment,
  isExpectedProcess,
  launchDomain,
  launchctl,
  MACOS_LABELS,
  parseLoopbackAppServerUrl,
  readBridgeConfig,
  readPid,
  RELAY_ENVIRONMENT_VARIABLE,
  runtimeLayout,
  setLaunchEnvironment,
  unsetLaunchEnvironmentIfOwned,
  writeJsonAtomic,
} from "./macos-runtime.mjs";

assertMacOS();
const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));
const { raw: config } = await readBridgeConfig(repositoryRoot);
const layout = runtimeLayout(repositoryRoot, config);
const endpoint = parseLoopbackAppServerUrl(config.sessionRelay?.appServerUrl);
let stopping = false;
let lastKickAt = 0;

async function ownedListenerReady() {
  const pid = await readPid(layout.appServerPidPath);
  return Boolean(pid
    && await isExpectedProcess(pid, [String(config.codexExecutable), "app-server", `:${endpoint.port}`])
    && await appServerReadyProbe(endpoint));
}

async function publish(state, detail) {
  let activationId;
  try { activationId = JSON.parse(await fs.readFile(layout.relayStatePath, "utf8")).activationId; }
  catch {}
  await writeJsonAtomic(layout.relayStatusPath, {
    schemaVersion: 1,
    activationId,
    state,
    detail,
    url: endpoint.href,
    heartbeatAt: new Date().toISOString(),
    appServerPid: await readPid(layout.appServerPidPath),
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { stopping = true; });
}

try {
  while (!stopping) {
    if (await ownedListenerReady()) {
      if (await getLaunchEnvironment(RELAY_ENVIRONMENT_VARIABLE) !== endpoint.href) {
        await setLaunchEnvironment(RELAY_ENVIRONMENT_VARIABLE, endpoint.href);
      }
      await publish("ready", "owned listener verified");
    } else {
      await unsetLaunchEnvironmentIfOwned(RELAY_ENVIRONMENT_VARIABLE, endpoint.href);
      await publish("recovering", "owned listener unavailable");
      if (Date.now() - lastKickAt >= 10_000) {
        lastKickAt = Date.now();
        await launchctl(["kickstart", "-k", `${launchDomain()}/${MACOS_LABELS.appServer}`], { allowFailure: true });
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
} finally {
  await unsetLaunchEnvironmentIfOwned(RELAY_ENVIRONMENT_VARIABLE, endpoint.href);
  await publish("stopped", "watchdog stopped");
}
