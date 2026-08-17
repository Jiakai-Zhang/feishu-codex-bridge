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
  parseLoopbackAppServerUrl,
} from "../../../../src/runtime/shared/network-probes.mjs";
import { nodeVersionSupported } from "../../../../src/runtime/shared/node-version.mjs";
import {
  ensurePrivateDirectory,
  writeFileAtomic,
} from "../../../../src/runtime/shared/private-state.mjs";
import { keychainIdentity } from "../../../../src/runtime/platform/macos/keychain-credential-store.mjs";
import {
  buildLaunchAgentPlist,
  waitForLaunchAgentState,
} from "../../../../src/runtime/platform/macos/launchd-service-manager.mjs";
import {
  directNetworkEnvironment,
  launchEnvironment,
  NETWORK_PROXY_ENVIRONMENT_VARIABLES,
} from "../../../../src/runtime/platform/macos/launch-environment.mjs";
import { openPrivateFeishuUrl } from "../../../../src/runtime/platform/macos/private-browser-redirect.mjs";
import { runtimeLayout } from "../../../../src/runtime/platform/macos/runtime-layout.mjs";
import { assertSafeUpdateContext } from "../../../../src/runtime/platform/macos/update.mjs";

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

test("macOS launch environment is shared by installer and relay launch agents", () => {
  const nodeExecutable = path.join(os.tmpdir(), "node runtime", "bin", "node");
  assert.deepEqual(launchEnvironment(nodeExecutable), {
    HOME: os.homedir(),
    USERPROFILE: os.homedir(),
    PATH: `${path.dirname(nodeExecutable)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
  });
});

test("macOS direct network environment removes inherited Desktop proxy variables", () => {
  const source = {
    PATH: "/usr/bin:/bin",
    CUSTOM_VALUE: "preserved",
    HTTP_PROXY: "http://127.0.0.1:7897",
    HTTPS_PROXY: "http://127.0.0.1:7897",
    ALL_PROXY: "socks5://127.0.0.1:7897",
    http_proxy: "http://127.0.0.1:7897",
    https_proxy: "http://127.0.0.1:7897",
    all_proxy: "socks5://127.0.0.1:7897",
    NO_PROXY: "127.0.0.1",
    no_proxy: "localhost",
  };
  const direct = directNetworkEnvironment(source);
  assert.equal(direct.CUSTOM_VALUE, "preserved");
  for (const name of NETWORK_PROXY_ENVIRONMENT_VARIABLES) {
    assert.equal(name in direct, false, name);
    assert.equal(name in source, true, `source ${name}`);
  }
});

test("macOS launchd state wait covers asynchronous unregister completion", async () => {
  const states = [true, true, false];
  let calls = 0;
  const settled = await waitForLaunchAgentState("com.example.test", false, {
    timeoutMs: 100,
    intervalMs: 1,
    probe: async () => {
      calls += 1;
      return states.shift() ?? false;
    },
  });
  assert.equal(settled, true);
  assert.equal(calls, 3);
  assert.equal(await waitForLaunchAgentState("com.example.test", true, {
    timeoutMs: 5,
    intervalMs: 1,
    probe: async () => false,
  }), false);
});

test("macOS updater refuses active Codex and Desktop contexts before changing services", async () => {
  let desktopProbeCount = 0;
  await assert.rejects(() => assertSafeUpdateContext({
    environment: { CODEX_THREAD_ID: "private-thread-id" },
    listDesktopApplications: async () => {
      desktopProbeCount += 1;
      return [];
    },
    isEmbeddedDesktopAppServerRunning: async () => false,
  }), /independent Terminal/);
  assert.equal(desktopProbeCount, 0);

  await assert.rejects(() => assertSafeUpdateContext({
    environment: {},
    listDesktopApplications: async () => [{ bundlePath: "/Applications/ChatGPT.app" }],
    isEmbeddedDesktopAppServerRunning: async () => false,
  }), /Fully quit ChatGPT\/Codex Desktop/);

  await assert.rejects(() => assertSafeUpdateContext({
    environment: {},
    listDesktopApplications: async () => [],
    isEmbeddedDesktopAppServerRunning: async () => true,
  }), /Fully quit ChatGPT\/Codex Desktop/);

  await assert.doesNotReject(() => assertSafeUpdateContext({
    environment: {},
    listDesktopApplications: async () => [],
    isEmbeddedDesktopAppServerRunning: async () => false,
  }));
  await assert.doesNotReject(() => assertSafeUpdateContext({
    testMode: true,
    environment: { CODEX_SESSION_ID: "test-session" },
    listDesktopApplications: async () => [{ bundlePath: "/Applications/ChatGPT.app" }],
    isEmbeddedDesktopAppServerRunning: async () => true,
  }));
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

test("private Feishu browser handoff keeps the target out of process arguments", async () => {
  const target = "https://open.feishu.cn/page/launcher?clientID=cli_private_test&addons=encoded";
  let openedUrl;
  let redirectedTo;
  await openPrivateFeishuUrl(target, {
    timeoutMs: 2_000,
    open: async (localUrl) => {
      openedUrl = localUrl;
      await new Promise((resolve, reject) => {
        http.get(localUrl, (response) => {
          redirectedTo = response.headers.location;
          response.resume();
          response.once("end", resolve);
        }).once("error", reject);
      });
    },
  });
  assert.match(openedUrl, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+$/);
  assert.equal(openedUrl.includes("cli_private_test"), false);
  assert.equal(redirectedTo, target);
  await assert.rejects(
    () => openPrivateFeishuUrl("https://example.com/not-feishu"),
    /Feishu Open Platform/,
  );
  await assert.rejects(
    () => openPrivateFeishuUrl("https://open.feishu.cn:444/page/launcher"),
    /Feishu Open Platform/,
  );
  await assert.rejects(
    () => openPrivateFeishuUrl("https://user:password@open.feishu.cn/page/launcher"),
    /Feishu Open Platform/,
  );
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
