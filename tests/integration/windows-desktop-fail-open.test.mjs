import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const powershell = process.platform === "win32"
  ? path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe") : null;
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

async function shell(command, env = {}) {
  return run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
    windowsHide: true, timeout: 15_000, env: { ...process.env, ...env },
  });
}

// Small test-only RFC6455 peer; real .NET ClientWebSocket performs the handshake.
async function protocolPeer(t, { reject = false, fragmented = false, silent = false } = {}) {
  const methods = [];
  const sockets = new Set();
  const server = http.createServer();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let pending = Buffer.alloc(0);
    socket.on("data", (data) => {
      pending = Buffer.concat([pending, data]);
      while (pending.length >= 2) {
        const opcode = pending[0] & 15;
        let length = pending[1] & 127;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        }
        if (length === 127) return socket.destroy();
        const masked = Boolean(pending[1] & 128);
        const maskLength = masked ? 4 : 0;
        if (pending.length < offset + maskLength + length) return;
        const body = Buffer.from(pending.subarray(offset + maskLength, offset + maskLength + length));
        if (masked) for (let index = 0; index < body.length; index++) body[index] ^= pending[offset + index % 4];
        pending = pending.subarray(offset + maskLength + length);
        if (opcode !== 1) continue;
        const message = JSON.parse(body.toString());
        methods.push(message.method);
        if (message.method !== "initialize" || silent) continue;
        const payload = Buffer.from(JSON.stringify(reject
          ? { id: message.id, error: { code: -1, message: "not ready" } }
          : { id: message.id, result: { userAgent: "fixture" } }));
        if (fragmented) {
          const half = Math.floor(payload.length / 2);
          socket.write(Buffer.concat([Buffer.from([1, half]), payload.subarray(0, half),
            Buffer.from([128, payload.length - half]), payload.subarray(half)]));
        } else socket.write(Buffer.concat([Buffer.from([129, payload.length]), payload]));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `ws://127.0.0.1:${server.address().port}/rpc`, methods };
}

for (const scenario of [
  { name: "successful initialize", expected: true },
  { name: "fragmented initialize response", fragmented: true, expected: true },
  { name: "RPC initialization failure", reject: true, expected: false },
  { name: "listener without initialize response", silent: true, expected: false },
]) {
  test(`Windows readiness probe handles ${scenario.name}`, { skip: !powershell }, async (t) => {
    const peer = await protocolPeer(t, scenario);
    const probe = path.join(repositoryRoot, "scripts/windows/app-server-readiness.ps1");
    const response = await shell(`. ${quote(probe)}; Test-CodexAppServerInitialize -Url ${quote(peer.url)} -TimeoutMilliseconds 1000`);
    assert.equal(response.stdout.trim().toLowerCase(), String(scenario.expected));
    assert.equal(peer.methods[0], "initialize");
    assert.ok(peer.methods.every((method) => ["initialize", "initialized"].includes(method)));
  });
}

for (const scenario of ["healthy", "activation-failure", "initialize-failure", "rotated-endpoint"]) {
  test(`Desktop launcher is process-isolated for ${scenario}`, { skip: !powershell }, async (t) => {
    const peer = await protocolPeer(t, { reject: scenario === "initialize-failure" });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-launch-fixture-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const capture = path.join(directory, "captured.json");
    const fakeDesktop = path.join(directory, "Codex.exe");
    await fs.writeFile(fakeDesktop, "fixture only: Start-Process is mocked");
    await fs.mkdir(path.join(directory, "scripts/windows"), { recursive: true });
    for (const file of ["launch-codex-desktop-with-relay.ps1", "scripts/windows/app-server-readiness.ps1"]) {
      await fs.copyFile(path.join(repositoryRoot, file), path.join(directory, file));
    }
    const initialUrl = scenario === "rotated-endpoint" ? "ws://127.0.0.1:1/rpc" : peer.url;
    await fs.writeFile(path.join(directory, "bridge.config.json"), JSON.stringify({ sessionRelay: { appServerUrl: initialUrl } }));
    // All service/task/registry operations are replaced by fixtures. No live installation is touched.
    await fs.writeFile(path.join(directory, "configure-codex-desktop-relay.ps1"), scenario === "activation-failure"
      ? "throw 'fixture startup failure'"
      : `$config = Get-Content (Join-Path $PSScriptRoot 'bridge.config.json') -Raw | ConvertFrom-Json; $config.sessionRelay.appServerUrl = ${quote(peer.url)}; $config | ConvertTo-Json | Set-Content (Join-Path $PSScriptRoot 'bridge.config.json')`);
    await fs.writeFile(path.join(directory, "desktop-relay-pointer.ps1"), "param($Url, [switch]$Preparing) # fixture: no registry writes");
    const command = `
      $ErrorActionPreference = 'Stop'
      function Get-AppxPackage { }
      function Get-StartApps { }
      function Get-CimInstance {
        if (Test-Path ${quote(capture)}) {
          [pscustomobject]@{ Name='Codex.exe'; ExecutablePath=${quote(fakeDesktop)}; CommandLine='' }
        }
      }
      function Start-Process {
        param($FilePath, $ArgumentList)
        [pscustomobject]@{
          relay=$env:CODEX_APP_SERVER_WS_URL; http=$env:HTTP_PROXY; https=$env:HTTPS_PROXY;
          all=$env:ALL_PROXY; file=$FilePath
        } | ConvertTo-Json | Set-Content ${quote(capture)}
      }
      & ${quote(path.join(directory, "launch-codex-desktop-with-relay.ps1"))} -DesktopExecutable ${quote(fakeDesktop)} -NoProxy
    `;
    const response = await shell(command, {
      LOCALAPPDATA: directory,
      CODEX_APP_SERVER_WS_URL: "ws://127.0.0.1:1/rpc",
      HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1",
    });
    const child = JSON.parse((await fs.readFile(capture, "utf8")).replace(/^\uFEFF/u, ""));
    const healthy = scenario === "healthy" || scenario === "rotated-endpoint";
    assert.equal(child.relay || null, healthy ? peer.url : null);
    assert.equal(child.http || null, null);
    assert.equal(child.https || null, null);
    assert.equal(child.all || null, null);
    assert.match(response.stdout, healthy ? /verified shared App Server/ : /local App Server/);
    assert.equal(peer.methods.includes("initialize"), scenario !== "activation-failure");
  });
}
