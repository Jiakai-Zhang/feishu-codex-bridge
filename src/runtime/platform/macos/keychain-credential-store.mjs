import { execFile as nodeExecFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(nodeExecFile);

export const KEYCHAIN_FULL_ACCESS_HINT =
  "When running this command from Codex Desktop, set the current conversation to Full access "
  + "(\u5b8c\u5168\u8bbf\u95ee), then retry.";

export function keychainIdentity(repositoryRoot) {
  const suffix = createHash("sha256").update(path.resolve(repositoryRoot), "utf8").digest("hex").slice(0, 16);
  return Object.freeze({
    service: `com.feishu-codex-bridge.channel-secret.${suffix}`,
    account: os.userInfo().username,
    label: "Feishu Codex Bridge Channel Secret",
  });
}

export async function keychainHasSecret(identity) {
  try {
    await execFile("/usr/bin/security", [
      "find-generic-password", "-a", identity.account, "-s", identity.service,
    ], { encoding: "utf8", timeout: 10_000, maxBuffer: 64_000 });
    return true;
  } catch {
    return false;
  }
}

export async function readKeychainSecret(identity) {
  try {
    const { stdout } = await execFile("/usr/bin/security", [
      "find-generic-password", "-a", identity.account, "-s", identity.service, "-w",
    ], { encoding: "utf8", timeout: 10_000, maxBuffer: 64_000 });
    const secret = String(stdout || "").replace(/[\r\n]+$/, "");
    if (!secret) throw new Error("empty credential");
    return secret;
  } catch {
    throw new Error(
      `The macOS Keychain does not contain a readable Channel secret. ${KEYCHAIN_FULL_ACCESS_HINT}`,
    );
  }
}

export async function promptAndStoreKeychainSecret(identity) {
  process.stdout.write("Paste the Feishu App Secret at the macOS Keychain prompt. Input stays hidden.\n");
  const code = await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", [
      "add-generic-password", "-U", "-a", identity.account, "-s", identity.service,
      "-l", identity.label, "-w",
    ], { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (status) => resolve(status ?? 1));
  });
  if (code !== 0 || !(await keychainHasSecret(identity))) {
    throw new Error(
      `The Channel secret was not saved to macOS Keychain. ${KEYCHAIN_FULL_ACCESS_HINT}`,
    );
  }
  process.stdout.write("Channel secret saved in macOS Keychain; no plaintext file was created.\n");
}
