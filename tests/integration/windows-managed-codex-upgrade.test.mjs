import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const powershell = process.platform === "win32"
  ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  : null;

async function managedCodexCandidates() {
  const managedRoot = path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  const entries = await fs.readdir(managedRoot, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const executable = path.join(managedRoot, entry.name, "codex.exe");
    try {
      const stat = await fs.stat(executable);
      candidates.push({
        executable,
        hasCodeModeHost: await fs.access(path.join(managedRoot, entry.name, "codex-code-mode-host.exe"))
          .then(() => true, () => false),
        modifiedAt: stat.mtimeMs,
      });
    } catch {}
  }
  return candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForPort(port, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.setTimeout(250, () => { socket.destroy(); resolve(false); });
    });
    if (connected === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`port ${port} did not become ${expected ? "available" : "unavailable"}`);
}

async function assertDesktopCodexAppOverridesMerge(port, cwd) {
  assert.equal(typeof globalThis.WebSocket, "function", "Node.js must provide a WebSocket client");
  const socket = new WebSocket(`ws://127.0.0.1:${port}/rpc`);
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("App Server thread/start timed out")), 15_000);
    const finish = (callback, value) => {
      clearTimeout(timer);
      try { socket.close(); } catch {}
      callback(value);
    };
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "feishu_codex_desktop_compatibility_test",
          title: "Feishu Codex Desktop compatibility test",
          version: "1.0.0",
        },
      },
    })), { once: true });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.id === 1) {
          if (message.error) return finish(reject, new Error(message.error.message));
          socket.send(JSON.stringify({ method: "initialized", params: {} }));
          socket.send(JSON.stringify({
            method: "thread/start",
            id: 2,
            params: {
              cwd,
              approvalPolicy: "never",
              sandbox: "read-only",
              ephemeral: true,
              config: {
                "mcp_servers.codex_app.enabled_tools": ["automation_update"],
              },
            },
          }));
        } else if (message.id === 2) {
          finish(resolve, message);
        }
      } catch (error) {
        finish(reject, error);
      }
    });
    socket.addEventListener("error", () => finish(reject, new Error("App Server WebSocket failed")), { once: true });
  });
  assert.equal(response.error, undefined, response.error?.message);
  assert.equal(typeof response.result?.thread?.id, "string");
}

async function prepareRelease(tempRoot, executable, port) {
  const releaseRoot = path.join(tempRoot, "release");
  const workspace = path.join(tempRoot, "workspace");
  await fs.mkdir(releaseRoot, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.copyFile(path.join(repositoryRoot, "start-app-server.ps1"), path.join(releaseRoot, "start-app-server.ps1"));
  await fs.writeFile(path.join(releaseRoot, "bridge.config.json"), `${JSON.stringify({
    mode: "session-relay",
    workspace,
    codexExecutable: executable,
    sessionRelay: { appServerUrl: `ws://127.0.0.1:${port}/rpc` },
  }, null, 2)}\n`);
  const runtime = path.join(workspace, "work", "feishu-codex-bridge");
  await fs.mkdir(runtime, { recursive: true });
  return { releaseRoot, runtime };
}

function runStarter(releaseRoot, localAppData) {
  return spawnSync(powershell, [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(releaseRoot, "start-app-server.ps1"), "-PassThru",
  ], {
    cwd: releaseRoot,
    encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: localAppData },
    timeout: 45_000,
    windowsHide: true,
  });
}

async function prepareManagedInstall(tempRoot, source) {
  const localAppData = path.join(tempRoot, "local-app-data");
  const managedRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  const previousRoot = path.join(managedRoot, "previous");
  const currentRoot = path.join(managedRoot, "current");
  await fs.mkdir(previousRoot, { recursive: true });
  await fs.mkdir(currentRoot, { recursive: true });

  const sourceRoot = path.dirname(source.executable);
  for (const targetRoot of [previousRoot, currentRoot]) {
    await fs.copyFile(source.executable, path.join(targetRoot, "codex.exe"));
    await fs.copyFile(
      path.join(sourceRoot, "codex-code-mode-host.exe"),
      path.join(targetRoot, "codex-code-mode-host.exe"),
    );
  }
  const previousTime = new Date(Date.now() - 60_000);
  const currentTime = new Date();
  await fs.utimes(path.join(previousRoot, "codex.exe"), previousTime, previousTime);
  await fs.utimes(path.join(currentRoot, "codex.exe"), currentTime, currentTime);
  return {
    localAppData,
    previous: path.join(previousRoot, "codex.exe"),
    current: path.join(currentRoot, "codex.exe"),
  };
}

async function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopProcess(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0 || !await processExists(processId)) return;
  spawnSync(path.join(process.env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(processId), "/T", "/F"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
}

function stopProcessesUnder(directory) {
  const escapedDirectory = directory.replaceAll("'", "''");
  spawnSync(powershell, [
    "-NoProfile", "-NonInteractive", "-Command",
    `$root = [IO.Path]::GetFullPath('${escapedDirectory}'); `
      + "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and "
      + "[IO.Path]::GetFullPath([string]$_.ExecutablePath).StartsWith($root, "
      + "[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { "
      + "& (Join-Path $env:SystemRoot 'System32\\taskkill.exe') /PID $_.ProcessId /T /F | Out-Null }",
  ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
}

test("managed Codex upgrade replaces only the recorded old App Server and persists the new executable", {
  skip: process.platform !== "win32",
  timeout: 60_000,
}, async (t) => {
  const source = (await managedCodexCandidates().catch(() => []))
    .find((candidate) => candidate.hasCodeModeHost);
  if (!source) {
    t.skip("requires a complete managed Codex installation");
    return;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-upgrade-"));
  const managed = await prepareManagedInstall(tempRoot, source);
  const port = await unusedPort();
  const { releaseRoot, runtime } = await prepareRelease(tempRoot, managed.previous, port);
  let replacementProcessId = 0;
  const oldProcess = spawn(managed.previous, ["app-server", "--listen", `ws://127.0.0.1:${port}`], {
    cwd: tempRoot,
    env: { ...process.env, LOCALAPPDATA: managed.localAppData },
    stdio: "ignore",
    windowsHide: true,
  });
  t.after(async () => {
    await stopProcess(replacementProcessId);
    await stopProcess(oldProcess.pid);
    stopProcessesUnder(managed.localAppData);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await waitForPort(port, true);
  await fs.writeFile(path.join(runtime, "codex-app-server.pid"), String(oldProcess.pid));
  const result = runStarter(releaseRoot, managed.localAppData);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  replacementProcessId = Number(await fs.readFile(path.join(runtime, "codex-app-server.pid"), "utf8"));
  const config = JSON.parse(await fs.readFile(path.join(releaseRoot, "bridge.config.json"), "utf8"));
  const executableResult = spawnSync(powershell, [
    "-NoProfile", "-NonInteractive", "-Command",
    `(Get-CimInstance Win32_Process -Filter \"ProcessId=${replacementProcessId}\").ExecutablePath`,
  ], { encoding: "utf8", timeout: 10_000, windowsHide: true });

  assert.notEqual(replacementProcessId, oldProcess.pid);
  assert.equal(await processExists(oldProcess.pid), false);
  assert.equal(path.resolve(config.codexExecutable).toLowerCase(), path.resolve(managed.current).toLowerCase());
  assert.equal(path.resolve(executableResult.stdout.trim()).toLowerCase(), path.resolve(managed.current).toLowerCase());
  await waitForPort(port, true);
  await assertDesktopCodexAppOverridesMerge(port, tempRoot);
});

test("an unverified listener is left running when App Server ownership cannot be proven", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, async (t) => {
  const source = (await managedCodexCandidates().catch(() => []))
    .find((candidate) => candidate.hasCodeModeHost);
  if (!source) {
    t.skip("requires a complete managed Codex installation");
    return;
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-codex-ownership-"));
  const managed = await prepareManagedInstall(tempRoot, source);
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = listener.address();
  const { releaseRoot } = await prepareRelease(tempRoot, managed.current, port);
  t.after(async () => {
    await new Promise((resolve) => listener.close(resolve));
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = runStarter(releaseRoot, managed.localAppData);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /already in use by an unverified process/);
  assert.equal(listener.listening, true);
});
