import { execFile as nodeExecFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

export async function readPid(filePath) {
  try {
    const value = Number((await fs.readFile(filePath, "utf8")).trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export function pidIsRunning(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function processCommand(pid) {
  if (!pidIsRunning(pid)) return undefined;
  try {
    const { stdout } = await execFile("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 256_000,
    });
    return String(stdout || "").trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function isExpectedProcess(pid, requiredFragments) {
  const command = await processCommand(pid);
  if (!command) return false;
  return requiredFragments.every((fragment) => command.includes(String(fragment)));
}
