import assert from "node:assert/strict";
import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  appServerReadyProbe,
  buildLaunchAgentPlist,
  ensurePrivateDirectory,
  keychainIdentity,
  nodeVersionSupported,
  parseLoopbackAppServerUrl,
  runtimeLayout,
  writeFileAtomic,
} from "./macos-runtime.mjs";

const execFile = promisify(nodeExecFile);

test("macOS launcher enforces Node.js 22.13 or newer", () => {
  for (const version of ["v22.13.0", "v22.13.1", "v23.0.0", "v24.19.0", "node v30.1.2"]) {
    assert.equal(nodeVersionSupported(version), true, version);
  }
  for (const version of ["v22.12.9", "v21.99.0", "22", "not-a-version", "v2.213.0"]) {
    assert.equal(nodeVersionSupported(version), false, version);
  }
});

test("macOS App Server URL accepts only an explicit loopback /rpc endpoint", () => {
  assert.deepEqual(parseLoopbackAppServerUrl("ws://127.0.0.1:47321/rpc"), {
    href: "ws://127.0.0.1:47321/rpc",
    host: "127.0.0.1",
    port: 47321,
    listenUrl: "ws://127.0.0.1:47321",
  });
  assert.equal(parseLoopbackAppServerUrl("ws://[::1]:47321/rpc").listenUrl, "ws://[::1]:47321");
  for (const value of [
    "wss://127.0.0.1:47321/rpc",
    "ws://0.0.0.0:47321/rpc",
    "ws://example.com:47321/rpc",
    "ws://127.0.0.1:47321/",
    "ws://user@127.0.0.1:47321/rpc",
    "ws://127.0.0.1:47321/rpc?x=1",
  ]) assert.throws(() => parseLoopbackAppServerUrl(value), /loopback URL/);
});

test("macOS runtime layout uses native Application Support, LaunchAgents, and Logs", () => {
  const repositoryRoot = path.join(os.tmpdir(), "Feishu Bridge repo");
  const workspace = path.join(os.tmpdir(), "Feishu Bridge workspace");
  const layout = runtimeLayout(repositoryRoot, { workspace });
  assert.equal(layout.runtimeDir, path.join(workspace, "work", "feishu-codex-bridge"));
  assert.equal(layout.bridgeReadyPath, path.join(workspace, "work", "feishu-codex-bridge", "bridge-ready.json"));
  assert.equal(layout.launchAgentsDir, path.join(os.homedir(), "Library", "LaunchAgents"));
  assert.equal(layout.logsDir, path.join(os.homedir(), "Library", "Logs", "FeishuCodexBridge"));
  assert.equal(layout.installationDir, path.join(
    os.homedir(), "Library", "Application Support", "FeishuCodexBridge", "installation",
  ));
  assert.equal(layout.installPointerPath, path.join(
    os.homedir(), "Library", "Application Support", "FeishuCodexBridge", "bootstrap", "installation.json",
  ));
});

test("App Server readiness probe requires a successful /readyz response", async (t) => {
  let healthy = true;
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, origin: request.headers.origin });
    response.writeHead(healthy ? 200 : 503);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, "object");
  const endpoint = { host: "127.0.0.1", port: address.port };

  assert.equal(await appServerReadyProbe(endpoint), true);
  healthy = false;
  assert.equal(await appServerReadyProbe(endpoint), false);
  assert.deepEqual(requests, [
    { url: "/readyz", origin: undefined },
    { url: "/readyz", origin: undefined },
  ]);
});

test("Keychain identity is stable without embedding the repository path", () => {
  const root = path.join(os.tmpdir(), "private", "bridge");
  const first = keychainIdentity(root);
  const second = keychainIdentity(root);
  assert.deepEqual(first, second);
  assert.match(first.service, /^com\.feishu-codex-bridge\.channel-secret\.[0-9a-f]{16}$/);
  assert.equal(first.service.includes(root), false);
});

test("launchd plist escapes values and passes no shell command string", async (t) => {
  const plist = buildLaunchAgentPlist({
    label: "com.example.a&b",
    programArguments: ["/path with spaces/node", "worker.mjs", "a<b"],
    workingDirectory: "/tmp/a&b",
    environment: { HOME: "/Users/a&b" },
    keepAlive: { SuccessfulExit: false },
    stdoutPath: "/tmp/stdout.log",
    stderrPath: "/tmp/stderr.log",
  });
  assert.match(plist, /<string>com\.example\.a&amp;b<\/string>/);
  assert.match(plist, /<string>a&lt;b<\/string>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.doesNotMatch(plist, /ProgramArguments<\/key><string>/);

  if (process.platform !== "darwin") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-plist-test-"));
  const filePath = path.join(root, "agent.plist");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(filePath, plist);
  await execFile("/usr/bin/plutil", ["-lint", filePath]);
});

test("atomic runtime files are owner-only on POSIX", async (t) => {
  if (process.platform === "win32") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-atomic-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "state.json");
  await writeFileAtomic(filePath, "{}\n");
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
});

test("private runtime directories are owner-only on POSIX", async (t) => {
  if (process.platform === "win32") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-private-directory-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "runtime");
  await fs.mkdir(directory, { mode: 0o755 });
  await ensurePrivateDirectory(directory);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
});
