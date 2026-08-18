import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const stableDomains = ["app", "relay", "codex", "feishu", "persistence"];

async function javaScriptFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return javaScriptFiles(target);
    return entry.isFile() && entry.name.endsWith(".mjs") ? [target] : [];
  }));
  return nested.flat();
}

test("keeps operating-system integrations behind the runtime platform boundary", async () => {
  const violations = [];
  for (const domain of stableDomains) {
    const directory = path.join(repositoryRoot, "src", domain);
    for (const filePath of await javaScriptFiles(directory)) {
      const source = await fs.readFile(filePath, "utf8");
      if (/process\.platform|["'](?:darwin|win32)["']|\/bin\/launchctl|\/usr\/bin\/security/.test(source)) {
        violations.push(path.relative(repositoryRoot, filePath));
      }
      if (/runtime\/platform\/(?:macos|windows)/.test(source)) {
        violations.push(path.relative(repositoryRoot, filePath));
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("keeps macOS implementation modules out of the repository root", async () => {
  const rootEntries = await fs.readdir(repositoryRoot);
  assert.deepEqual(rootEntries.filter((name) => /^macos-.*\.mjs$/.test(name)), []);
  for (const name of [
    "admin-cli.mjs",
    "desktop-runtime.mjs",
    "health.mjs",
    "installer.mjs",
    "keychain-credential-store.mjs",
    "launchd-service-manager.mjs",
  ]) {
    await fs.access(path.join(repositoryRoot, "src", "runtime", "platform", "macos", name));
  }
});
