import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appServerReadyProbe,
  loopbackPortOpen,
  parseLoopbackAppServerUrl,
} from "../../shared/network-probes.mjs";
import { ensurePrivateDirectory } from "../../shared/private-state.mjs";
import { safeError } from "../../shared/safe-error.mjs";
import { assertMacOS } from "./constants.mjs";
import { readBridgeConfig, runtimeLayout } from "./runtime-layout.mjs";

assertMacOS();
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const { raw: config } = await readBridgeConfig(repositoryRoot);
if (config.mode !== "session-relay") throw new Error("The shared App Server requires session-relay mode.");
const layout = runtimeLayout(repositoryRoot, config);
const endpoint = parseLoopbackAppServerUrl(config.sessionRelay?.appServerUrl);
const codexExecutable = path.resolve(repositoryRoot, String(config.codexExecutable || ""));
await fs.access(codexExecutable);
await ensurePrivateDirectory(layout.runtimeDir);

if (await loopbackPortOpen(endpoint)) {
  throw new Error(`Port ${endpoint.port} is already in use; refusing to replace an unverified listener.`);
}

const child = spawn(codexExecutable, ["app-server", "--listen", endpoint.listenUrl], {
  cwd: layout.workspace,
  env: process.env,
  stdio: ["ignore", "inherit", "inherit"],
});
const completion = new Promise((resolve) => {
  child.once("error", (error) => resolve({ code: 1, error }));
  child.once("close", (code, signal) => resolve({ code: code ?? 1, signal }));
});
let completed;
void completion.then((result) => { completed = result; });
if (!child.pid) throw new Error("Could not start the shared Codex App Server process.");
await fs.writeFile(layout.appServerPidPath, String(child.pid), { encoding: "utf8", mode: 0o600 });

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopping = true;
    try { child.kill(signal); } catch {}
  });
}

try {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !completed) {
    if (await appServerReadyProbe(endpoint)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!(await appServerReadyProbe(endpoint))) {
    const suffix = completed ? ` (${safeError(completed.error || completed.signal || completed.code)})` : "";
    throw new Error(`Shared Codex App Server did not pass /readyz within 15 seconds${suffix}.`);
  }
  const result = completed || await completion;
  if (!stopping && result.code !== 0) {
    process.stderr.write(`Shared Codex App Server exited: ${safeError(result.error || result.signal || result.code)}\n`);
    process.exitCode = result.code;
  }
} catch (error) {
  try { child.kill("SIGTERM"); } catch {}
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
} finally {
  const savedPid = Number((await fs.readFile(layout.appServerPidPath, "utf8").catch(() => "")).trim());
  if (savedPid === child.pid) await fs.rm(layout.appServerPidPath, { force: true });
}
