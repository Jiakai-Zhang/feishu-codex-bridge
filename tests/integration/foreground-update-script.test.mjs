import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("foreground Windows updater is visible, one-shot, and preserves Desktop networking", async () => {
  const source = await fs.readFile(
    path.join(repositoryRoot, "update-windows-with-desktop-restart.ps1"),
    "utf8",
  );
  assert.match(source, /FeishuCodexBridge-ForegroundUpgrade-/);
  assert.match(source, /New-ScheduledTask -Action \$action -Principal \$principal -Settings \$settings/);
  assert.doesNotMatch(source, /New-ScheduledTask -Action \$action -Trigger/);
  assert.match(source, /-LogonType Interactive -RunLevel Limited/);
  assert.match(source, /Start-ScheduledTask -TaskName \$taskName/);
  assert.match(source, /waiting-for-desktop-exit/);
  assert.match(source, /PreflightOnly/);
  assert.match(source, /launch-codex-desktop-with-relay\.ps1/);
  assert.match(source, /-File \$launcherPath -Proxy/);
  assert.match(source, /-File \$launcherPath -NoProxy/);
  assert.match(source, /Invoke-StrictDoctor[\s\S]*Invoke-DesktopLauncher[\s\S]*Invoke-StrictDoctor/);
  assert.match(source, /attempting to reopen Desktop with the preserved network mode/);
  assert.doesNotMatch(
    source.match(/\$actionArguments = ([^\n]+)/u)?.[1] ?? "",
    /WindowStyle Hidden/,
  );
});

test("foreground Windows updater completes its isolated restart transaction", {
  skip: process.platform !== "win32",
  timeout: 180_000,
}, async () => {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repositoryRoot, "tests/integration/windows-foreground-update-smoke.ps1"),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    },
  );
  assert.match(
    stdout,
    /Foreground updater smoke test passed, including Desktop exit wait, proxy-preserving relaunch, and final Doctor\./,
  );
});
