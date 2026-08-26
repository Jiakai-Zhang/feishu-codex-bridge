import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Windows operational scripts parse under PowerShell 5.1 and PowerShell 7 when available", {
  skip: process.platform !== "win32",
}, async (t) => {
  const parser = [
    "$files=@('launch-codex-desktop-with-relay.ps1','update-windows-with-desktop-restart.ps1','tests/integration/windows-foreground-update-smoke.ps1')",
    "$failed=$false",
    "foreach($file in $files){",
    "$tokens=$null;$errors=$null",
    "[System.Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors)|Out-Null",
    "if($errors.Count){$errors|ForEach-Object{[Console]::Error.WriteLine($_.Message)};$failed=$true}",
    "}",
    "if($failed){exit 1}",
  ].join(";");
  await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", parser], {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  try {
    await execFileAsync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", parser], {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      t.diagnostic("PowerShell 7 is unavailable locally; Windows CI performs this parser check.");
      return;
    }
    throw error;
  }
});

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
  assert.match(source, /Test-DesktopWindowVisible/);
  assert.match(source, /Stop-LingeringDesktopProcesses/);
  assert.match(source, /MainWindowHandle/);
  assert.match(source, /Desktop window closed\. Stopping its verified residual package processes/);
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
    /Foreground updater smoke test passed, including residual Desktop shutdown, proxy-preserving relaunch, and final Doctor\./,
  );
});
