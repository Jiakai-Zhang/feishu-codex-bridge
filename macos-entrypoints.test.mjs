import assert from "node:assert/strict";
import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { safeLoopbackProxyArgument } from "./macos-admin.mjs";

const execFile = promisify(nodeExecFile);
const repositoryRoot = path.dirname(fileURLToPath(import.meta.url));

test("macOS lifecycle wrappers route through the single safe Node launcher", async () => {
  const commands = new Map([
    ["bootstrap.sh", "dependencies"],
    ["install.sh", "install"],
    ["setup-channel-secret.sh", "setup-secret"],
    ["start-bridge.sh", "start"],
    ["stop-bridge.sh", "stop"],
    ["status-bridge.sh", "status"],
    ["doctor.sh", "doctor"],
    ["configure-codex-desktop-relay.sh", "configure-desktop-relay"],
    ["launch-codex-desktop-with-relay.sh", "launch-desktop-relay"],
    ["lark-cli.sh", "lark-cli"],
    ["update.sh", "update"],
  ]);
  for (const [name, command] of commands) {
    const content = await fs.readFile(path.join(repositoryRoot, name), "utf8");
    assert.match(content, new RegExp(`macos-node\\.sh\" ${command.replace("-", "\\-")} `));
    assert.doesNotMatch(content, /LARK_APP_SECRET|security\s+add-generic-password/);
  }
});

test("macOS secret setup uses an interactive Keychain prompt, never a password argument", async () => {
  const content = await fs.readFile(path.join(repositoryRoot, "macos-admin.mjs"), "utf8");
  assert.match(content, /"add-generic-password", "-U"/);
  assert.match(content, /identity\.label, "-w"/);
  assert.doesNotMatch(content, /"-w",\s*(?:secret|options|get\()/i);
  assert.doesNotMatch(content, /bridge\.config\.json[\s\S]{0,120}LARK_APP_SECRET/);
});

test("macOS binding helper returns only a safe JSON error when no installation exists", async (t) => {
  const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-binding-home-"));
  t.after(() => fs.rm(temporaryHome, { recursive: true, force: true }));
  const script = path.join(repositoryRoot, "skills", "feishu-session-bind", "scripts", "request-binding.mjs");
  let output = "";
  try {
    ({ stdout: output } = await execFile(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, HOME: temporaryHome, FEISHU_CODEX_BRIDGE_HOME: "" },
    }));
  } catch (error) {
    output = error.stdout;
  }
  const response = JSON.parse(output);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "binding_request_unavailable");
  assert.deepEqual(response.error.missingScopes, []);
  assert.equal(output.includes(temporaryHome), false);
});

test("session binding skill documents both macOS and Windows entrypoints", async () => {
  const skill = await fs.readFile(path.join(repositoryRoot, "skills", "feishu-session-bind", "SKILL.md"), "utf8");
  assert.match(skill, /request-binding\.sh/);
  assert.match(skill, /request-binding\.ps1/);
});

test("macOS Desktop relay accepts only an explicit unauthenticated loopback proxy", () => {
  assert.equal(safeLoopbackProxyArgument("http://127.0.0.1:7897"), "--proxy-server=http://127.0.0.1:7897");
  assert.equal(safeLoopbackProxyArgument("socks5://localhost:1080"), "--proxy-server=socks5://localhost:1080");
  assert.equal(safeLoopbackProxyArgument("https://proxy.example.com:443"), undefined);
  assert.equal(safeLoopbackProxyArgument("http://user:password@127.0.0.1:7897"), undefined);
});
