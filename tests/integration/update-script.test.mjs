import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Windows updater preserves state and rolls back a broken release", {
  skip: process.platform !== "win32",
  timeout: 120_000,
}, async () => {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(repositoryRoot, "update-smoke.ps1"),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    },
  );
  assert.match(stdout, /Updater smoke test passed, including automatic rollback\./);
});
