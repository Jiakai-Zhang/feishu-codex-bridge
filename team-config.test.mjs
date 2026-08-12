import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { normalizeBridgeConfig, sdkGroupAllowlist } from "./team-config.mjs";

const legacy = {
  appId: "cli_example",
  threadId: "019ff4bc-4bb0-7643-9781-136733a00616",
  allowedSenderOpenId: "ou_owner",
  workspace: "./workspace",
};

test("normalizes legacy single-user config without enabling group access", () => {
  const config = normalizeBridgeConfig(legacy, { configDir: "C:/config" });
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.agent.id, "local-codex");
  assert.deepEqual(config.agent.allowedHumanOpenIds, ["ou_owner"]);
  assert.equal(config.agent.executor.type, "codex");
  assert.equal(config.collaboration.enabled, false);
  assert.deepEqual(sdkGroupAllowlist(config), ["oc_collaboration_disabled"]);
  assert.equal(config.project.repoRoot, path.resolve("C:/config", "workspace"));
  assert.equal(config.repositories[0].path, config.project.repoRoot);
});

test("normalizes a Codex-first team config", () => {
  const config = normalizeBridgeConfig({
    ...legacy,
    agent: {
      id: "peiyuan-codex",
      ownerOpenId: "ou_owner",
      botOpenId: "ou_localbot",
      allowedHumanOpenIds: ["ou_teammate", "ou_owner"],
      executor: { type: "codex" },
    },
    collaboration: {
      enabled: true,
      groupChatIds: ["oc_team"],
      approverOpenIds: ["ou_owner"],
      trustedPeers: [{
        agentId: "alice-codex",
        botOpenId: "ou_alicebot",
        allowedProjectIds: ["bridge"],
      }],
    },
    repositories: [{ id: "bridge", path: "./bridge", defaultBranch: "main" }],
    project: {
      id: "bridge",
      name: "Bridge",
      desktopProjectId: "desktop-project-1",
      desktopProjectName: "Bridge Desktop",
      repoRoot: "./bridge",
      worktreeRoot: "../worktrees/bridge",
      allowedWorktreeRoots: ["./bridge", "../worktrees/bridge"],
      allowedRemotes: ["origin"],
    },
    teamHub: {
      enabled: true,
      path: "../team-agent-hub",
      writerOpenIds: ["ou_owner"],
      repositoryIds: ["bridge"],
    },
  }, { configDir: "C:/config" });

  assert.equal(config.agent.id, "peiyuan-codex");
  assert.deepEqual(config.agent.allowedHumanOpenIds, ["ou_owner", "ou_teammate"]);
  assert.deepEqual(sdkGroupAllowlist(config), ["oc_team"]);
  assert.deepEqual(config.collaboration.approverOpenIds, ["ou_owner"]);
  assert.equal(config.collaboration.defaultGroupChatId, "oc_team");
  assert.equal(config.collaboration.taskLeaseMs, 12 * 60 * 60_000);
  assert.equal(config.collaboration.trustedPeers[0].allowedProjectIds[0], "bridge");
  assert.equal(config.project.id, "bridge");
  assert.equal(config.project.desktopProjectId, "desktop-project-1");
  assert.equal(config.project.desktopProjectName, "Bridge Desktop");
  assert.equal(config.project.worktreeRoot, path.resolve("C:/config", "../worktrees/bridge"));
  assert.equal(config.teamHub.path, path.resolve("C:/config", "../team-agent-hub"));
  assert.deepEqual(config.teamHub.writerOpenIds, ["ou_owner"]);
  assert.deepEqual(config.teamHub.repositoryIds, ["bridge"]);
});

test("refuses collaboration without an explicit group", () => {
  assert.throws(() => normalizeBridgeConfig({
    ...legacy,
    agent: { ownerOpenId: "ou_owner", botOpenId: "ou_bot" },
    collaboration: { enabled: true, groupChatIds: [] },
  }), /groupChatIds/);
});

test("refuses duplicate peer bot identities", () => {
  assert.throws(() => normalizeBridgeConfig({
    ...legacy,
    agent: { ownerOpenId: "ou_owner", botOpenId: "ou_bot" },
    collaboration: {
      enabled: true,
      groupChatIds: ["oc_team"],
      trustedPeers: [
        { agentId: "alice", botOpenId: "ou_same", allowedProjectIds: ["local-codex"] },
        { agentId: "bob", botOpenId: "ou_same", allowedProjectIds: ["local-codex"] },
      ],
    },
  }), /bot open_ids must be unique/);
});

test("requires an explicit Project allowlist for every enabled peer", () => {
  assert.throws(() => normalizeBridgeConfig({
    ...legacy,
    agent: { id: "local", ownerOpenId: "ou_owner", botOpenId: "ou_bot" },
    project: { id: "bridge", repoRoot: "./workspace" },
    collaboration: {
      enabled: true,
      groupChatIds: ["oc_team"],
      trustedPeers: [{ agentId: "alice", botOpenId: "ou_alice" }],
    },
  }), /allowedProjectIds/);
});

test("refuses local identities in the trusted peer roster", () => {
  const base = {
    ...legacy,
    agent: { id: "local", ownerOpenId: "ou_owner", botOpenId: "ou_bot" },
    project: { id: "bridge", repoRoot: "./workspace" },
    collaboration: { enabled: true, groupChatIds: ["oc_team"] },
  };
  assert.throws(() => normalizeBridgeConfig({
    ...base,
    collaboration: {
      ...base.collaboration,
      trustedPeers: [{ agentId: "local", botOpenId: "ou_peer", allowedProjectIds: ["bridge"] }],
    },
  }), /local agent id/);
  assert.throws(() => normalizeBridgeConfig({
    ...base,
    collaboration: {
      ...base.collaboration,
      trustedPeers: [{ agentId: "alice", botOpenId: "ou_bot", allowedProjectIds: ["bridge"] }],
    },
  }), /local bot open_id/);
});

test("restricts task approvers and the default group to configured allowlists", () => {
  assert.throws(() => normalizeBridgeConfig({
    ...legacy,
    agent: { ownerOpenId: "ou_owner", botOpenId: "ou_bot" },
    collaboration: {
      enabled: true,
      groupChatIds: ["oc_team"],
      approverOpenIds: ["ou_unknown"],
    },
  }), /subset/);
  assert.throws(() => normalizeBridgeConfig({
    ...legacy,
    agent: { ownerOpenId: "ou_owner", botOpenId: "ou_bot" },
    collaboration: {
      enabled: true,
      groupChatIds: ["oc_team"],
      defaultGroupChatId: "oc_other",
    },
  }), /defaultGroupChatId/);
});

test("restricts Team Hub writers and repository scopes to configured identities", () => {
  assert.throws(() => normalizeBridgeConfig({
    ...legacy,
    repositories: [{ id: "bridge", path: "./workspace" }],
    teamHub: { enabled: true, path: "./hub", writerOpenIds: ["ou_unknown"] },
  }), /writerOpenIds/);
  assert.throws(() => normalizeBridgeConfig({
    ...legacy,
    repositories: [{ id: "bridge", path: "./workspace" }],
    teamHub: { enabled: true, path: "./hub", repositoryIds: ["unknown"] },
  }), /repositoryIds/);
});

test("refuses a worktree creation root outside the allowed Project roots", () => {
  assert.throws(() => normalizeBridgeConfig({
    ...legacy,
    project: {
      id: "bridge",
      repoRoot: "./bridge",
      worktreeRoot: "C:/untrusted/worktrees",
      allowedWorktreeRoots: ["./bridge"],
    },
  }, { configDir: "C:/config" }), /worktreeRoot must be inside/);
});
