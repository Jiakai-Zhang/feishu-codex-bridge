import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { connect as connectPipe } from "node:net";
import path from "node:path";
import process from "node:process";

const WINDOWS_PIPE_DIRECTORY = "\\\\.\\pipe\\";
const APP_TOOLS_PIPE_PREFIX = "codex-browser-use-";
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const PIPE_SERVER_IDENTITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CodexAppToolsPipeIdentity {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetNamedPipeServerProcessId(SafeFileHandle pipe, out uint pid);
}
'@
$pipePath = [Environment]::GetEnvironmentVariable('FEISHU_CODEX_APP_TOOLS_PIPE_PATH', 'Process')
$handle = [CodexAppToolsPipeIdentity]::CreateFile($pipePath, [uint32]2147483648, [uint32]3, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)
if ($handle.IsInvalid) { exit 2 }
try {
  [uint32]$serverProcessId = 0
  if (-not [CodexAppToolsPipeIdentity]::GetNamedPipeServerProcessId($handle, [ref]$serverProcessId)) { exit 3 }
} finally {
  $handle.Dispose()
}
$server = Get-CimInstance Win32_Process -Filter "ProcessId=$serverProcessId" -ErrorAction Stop
if (-not $server -or [string]$server.Name -ine 'ChatGPT.exe' -or [string]::IsNullOrWhiteSpace([string]$server.ExecutablePath)) { exit 4 }
Import-Module -Name (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$signature = Get-AuthenticodeSignature -FilePath ([string]$server.ExecutablePath)
if ([string]$signature.Status -ne 'Valid' -or [string]$signature.SignerCertificate.Subject -notlike '*O="OpenAI OpCo, LLC"*') { exit 5 }
[Console]::Out.Write('trusted')
`;

function hostError(code, message) {
  const error = new Error(message);
  error.name = "CodexAppToolsHostError";
  error.code = code;
  error.rpcCode = -32000;
  return error;
}

function unique(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function requestFrame(method, params, id) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw hostError("codex_app_tool_request_too_large", "The Codex app tool request is too large");
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function requestCodexAppToolsPipe(pipePath, method, params, {
  timeoutMs = 2_000,
  connectImpl = connectPipe,
} = {}) {
  return new Promise((resolve, reject) => {
    let socket;
    let settled = false;
    let requestWritten = false;
    let received = Buffer.alloc(0);
    let expectedLength;
    const id = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch {}
      if (error) reject(error);
      else resolve(result);
    };

    const failUnavailable = () => finish(hostError(
      requestWritten && method === "tools/call"
        ? "codex_app_tool_outcome_unknown"
        : "codex_app_tools_host_unavailable",
      requestWritten && method === "tools/call"
        ? "The Codex Desktop app-tools connection closed before the result arrived; the tool outcome is unknown, so inspect Desktop before retrying"
        : "The Codex Desktop app-tools host is unavailable",
    ));

    const timer = setTimeout(failUnavailable, timeoutMs);
    timer.unref?.();

    try {
      socket = connectImpl(pipePath);
      socket.once("connect", () => {
        try {
          socket.write(requestFrame(method, params, id));
          requestWritten = true;
        }
        catch (error) { finish(error); }
      });
      socket.on("data", (chunk) => {
        received = Buffer.concat([received, chunk]);
        if (expectedLength === undefined && received.length >= 4) {
          expectedLength = received.readUInt32LE(0);
          if (expectedLength > MAX_FRAME_BYTES) {
            finish(hostError("codex_app_tools_protocol_error", "The Codex app-tools host returned an oversized response"));
            return;
          }
        }
        if (expectedLength === undefined || received.length < expectedLength + 4) return;
        let response;
        try { response = JSON.parse(received.subarray(4, expectedLength + 4).toString("utf8")); }
        catch {
          finish(hostError("codex_app_tools_protocol_error", "The Codex app-tools host returned invalid JSON"));
          return;
        }
        if (response?.id !== id) {
          finish(hostError("codex_app_tools_protocol_error", "The Codex app-tools host returned a mismatched response"));
        } else if (response.error) {
          const error = hostError(
            "codex_app_tool_failed",
            String(response.error.message || "The Codex app tool failed"),
          );
          if (Number.isInteger(response.error.code)) error.rpcCode = response.error.code;
          finish(error);
        } else {
          finish(undefined, response.result);
        }
      });
      socket.once("error", failUnavailable);
      socket.once("close", () => {
        if (!settled) failUnavailable();
      });
    } catch {
      failUnavailable();
    }
  });
}

export async function listCodexAppToolsPipePaths({
  env = process.env,
  platform = process.platform,
  readdirImpl = readdir,
} = {}) {
  const configuredPipePath = env.CODEX_APP_TOOLS_PIPE_PATH;
  if (typeof configuredPipePath === "string" && configuredPipePath) {
    return [configuredPipePath];
  }
  const candidates = [];
  if (platform === "win32") {
    try {
      const names = await readdirImpl(WINDOWS_PIPE_DIRECTORY);
      candidates.push(...names
        .filter((name) => name.startsWith(APP_TOOLS_PIPE_PREFIX))
        .map((name) => `${WINDOWS_PIPE_DIRECTORY}${name}`));
    } catch {}
  }
  return unique(candidates);
}

export function validateWindowsCodexAppToolsPipe(pipePath, {
  env = process.env,
  execFileImpl = execFile,
  timeoutMs = 5_000,
} = {}) {
  return new Promise((resolve) => {
    const powershell = env.SystemRoot
      ? path.win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : "powershell.exe";
    execFileImpl(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PIPE_SERVER_IDENTITY_SCRIPT],
      {
        env: { ...env, FEISHU_CODEX_APP_TOOLS_PIPE_PATH: pipePath },
        timeout: timeoutMs,
        windowsHide: true,
      },
      (error, stdout) => resolve(!error && String(stdout).trim() === "trusted"),
    );
  });
}

function validateDynamicToolCall(params) {
  if (!params || typeof params !== "object") {
    throw hostError("codex_app_tool_invalid_request", "The dynamic tool request is missing parameters");
  }
  for (const field of ["threadId", "turnId", "callId", "tool"]) {
    if (typeof params[field] !== "string" || !params[field]) {
      throw hostError("codex_app_tool_invalid_request", `The dynamic tool request is missing ${field}`);
    }
  }
  if (params.namespace !== null && typeof params.namespace !== "string") {
    throw hostError("codex_app_tool_invalid_request", "The dynamic tool request has an invalid namespace");
  }
}

function hasRequestedTool(result, namespace, tool) {
  return Array.isArray(result?.tools) && result.tools.some((candidate) => (
    candidate?.name === tool && (candidate?.namespace ?? null) === namespace
  ));
}

function validateToolResponse(result) {
  const validContentItems = Array.isArray(result?.contentItems) && result.contentItems.every((item) => {
    if (!item || typeof item !== "object") return false;
    if (item.type === "inputText") return typeof item.text === "string";
    if (item.type === "inputImage") return typeof item.imageUrl === "string";
    if (item.type === "inputAudio") return typeof item.audioUrl === "string";
    return false;
  });
  if (!validContentItems || typeof result?.success !== "boolean") {
    throw hostError("codex_app_tools_protocol_error", "The Codex app-tools host returned an invalid tool result");
  }
  return result;
}

export class CodexAppToolsPipeClient {
  constructor({
    listPipePaths = listCodexAppToolsPipePaths,
    requestPipe = requestCodexAppToolsPipe,
    validatePipePath = validateWindowsCodexAppToolsPipe,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    log = () => {},
  } = {}) {
    this.listPipePaths = listPipePaths;
    this.requestPipe = requestPipe;
    this.validatePipePath = validatePipePath;
    this.probeTimeoutMs = probeTimeoutMs;
    this.callTimeoutMs = callTimeoutMs;
    this.log = log;
  }

  async handleRequest(method, params) {
    if (method !== "item/tool/call") {
      const error = hostError("codex_app_tool_unsupported_request", `Unsupported dynamic tool request: ${method}`);
      error.rpcCode = -32601;
      throw error;
    }
    validateDynamicToolCall(params);

    const candidates = await this.listPipePaths();
    const probes = await Promise.allSettled(candidates.map(async (pipePath) => {
      const result = await this.requestPipe(
        pipePath,
        "tools/list",
        { threadStartKind: "all" },
        { timeoutMs: this.probeTimeoutMs },
      );
      return hasRequestedTool(result, params.namespace, params.tool) ? pipePath : undefined;
    }));
    const matchingPipePaths = unique(probes
      .filter((probe) => probe.status === "fulfilled" && probe.value)
      .map((probe) => probe.value));
    if (matchingPipePaths.length !== 1) {
      if (matchingPipePaths.length > 1) {
        this.log("Multiple Codex Desktop app-tools hosts advertised the requested dynamic tool");
        throw hostError(
          "codex_app_tools_host_ambiguous",
          "Multiple Codex Desktop app-tools hosts advertised the requested tool; close stale Desktop windows or configure CODEX_APP_TOOLS_PIPE_PATH explicitly",
        );
      }
      this.log("Codex Desktop app-tools host did not advertise the requested dynamic tool");
      throw hostError(
        "codex_app_tool_unavailable",
        "The requested Codex Desktop tool is unavailable; keep Codex Desktop open and restart it after the Bridge is ready",
      );
    }
    const [pipePath] = matchingPipePaths;
    if (!await this.validatePipePath(pipePath)) {
      throw hostError(
        "codex_app_tools_host_untrusted",
        "The selected app-tools pipe is not owned by a signed Codex Desktop process",
      );
    }

    const result = await this.requestPipe(pipePath, "tools/call", {
      arguments: params.arguments,
      callId: params.callId,
      namespace: params.namespace,
      threadId: params.threadId,
      tool: params.tool,
      turnId: params.turnId,
    }, { timeoutMs: this.callTimeoutMs });
    return validateToolResponse(result);
  }
}

export function createWindowsCodexAppToolRequestHandler(options) {
  const client = new CodexAppToolsPipeClient(options);
  return (method, params) => client.handleRequest(method, params);
}
