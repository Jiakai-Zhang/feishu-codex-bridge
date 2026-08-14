import assert from "node:assert/strict";
import test from "node:test";
import { inspectDesktopProject } from "./desktop-project-state.mjs";

const repoRoot = "C:\\work\\bridge";

test("finds a registered Codex Desktop project by repository root", async () => {
  const status = await inspectDesktopProject({
    repoRoot,
    desktopProjectId: "desktop-project-1",
  }, {
    codexHome: "C:\\codex-home",
    readFile: async () => JSON.stringify({
      "local-projects": {
        "desktop-project-1": {
          id: "desktop-project-1",
          name: "Bridge",
          rootPaths: [repoRoot],
        },
      },
    }),
  });

  assert.equal(status.stateReadable, true);
  assert.equal(status.registered, true);
  assert.equal(status.configurationMatches, true);
  assert.equal(status.projectId, "desktop-project-1");
  assert.equal(status.name, "Bridge");
});

test("reports a stale configured Desktop project id", async () => {
  const status = await inspectDesktopProject({
    repoRoot,
    desktopProjectId: "old-project-id",
  }, {
    readFile: async () => JSON.stringify({
      "local-projects": {
        "new-project-id": {
          id: "new-project-id",
          name: "Bridge",
          rootPaths: [repoRoot],
        },
      },
    }),
  });

  assert.equal(status.registered, true);
  assert.equal(status.configurationMatches, false);
  assert.equal(status.projectId, "new-project-id");
});

test("handles an unavailable Desktop state file without throwing", async () => {
  const status = await inspectDesktopProject({ repoRoot }, {
    readFile: async () => {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
  });

  assert.equal(status.stateReadable, false);
  assert.equal(status.registered, false);
  assert.equal(status.errorCode, "ENOENT");
});
