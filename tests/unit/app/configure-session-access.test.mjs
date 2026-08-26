import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureSessionAccess } from "../../../src/app/configure-session-access.mjs";

test("configures the shared Session access store for a platform-owned interactive entrypoint", async (t) => {
  const repositoryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "configure-session-access-"));
  t.after(() => fs.rm(repositoryDirectory, { recursive: true, force: true }));
  const workspace = path.join(repositoryDirectory, "runtime");
  const projectRoot = path.join(repositoryDirectory, "projects");
  const config = {
    mode: "session-relay",
    appId: "cli_configure_access",
    workspace,
    nodeExecutable: process.execPath,
    codexExecutable: process.execPath,
    agent: { ownerOpenId: "ou_owner" },
    sessionRelay: {
      appServerUrl: "ws://127.0.0.1:47321/rpc",
      bindings: [],
    },
  };
  await fs.writeFile(
    path.join(repositoryDirectory, "bridge.config.json"),
    `${JSON.stringify(config)}\n`,
    { mode: 0o600 },
  );

  await configureSessionAccess({
    repositoryDirectory,
    projectRoot,
    ownerDirectoryName: "owner",
  });

  const accessPath = path.join(workspace, "work", "feishu-codex-bridge", "session-relay-access.json");
  const access = JSON.parse(await fs.readFile(accessPath, "utf8"));
  assert.equal(access.projectRoot, await fs.realpath(projectRoot));
  assert.equal(access.users[0].role, "owner");
  assert.equal(access.users[0].directoryName, "owner");
  assert.equal((await fs.stat(path.join(projectRoot, "owner"))).isDirectory(), true);
});
