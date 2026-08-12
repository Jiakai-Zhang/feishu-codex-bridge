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

function collaboration(overrides = {}) {
  return {
    enabled: true,
    groupChatId: "oc_team",
    githubRepository: "Example/Bridge",
    remote: "origin",
    approverOpenIds: ["ou_owner"],
    trustedPeers: [{
      agentId: "alice-codex",
      botOpenId: "ou_alicebot",
      humanOpenId: "ou_alice",
    }],
    ...overrides,
  };
}

test("normalizes legacy single-user config without enabling group access", () => {
  const config = normalizeBridgeConfig(legacy, { configDir: "C:/config" });
  assert.equal(config.schemaVersion, 3);
  assert.equal(config.agent.id, "local-codex");
  assert.deepEqual(config.agent.allowedHumanOpenIds, ["ou_owner"]);
  assert.equal(config.agent.executor.type, "codex");
  assert.equal(config.collaboration.enabled, false);
  assert.deepEqual(sdkGroupAllowlist(config), ["oc_collaboration_disabled"]);
  assert.equal(config.project.repoRoot, path.resolve("C:/config", "workspace"));
  assert.equal(config.repositories[0].path, config.project.repoRoot);
});

test("normalizes a one-group, one-Project, one-GitHub-repository team config", () => {
  const config = normalizeBridgeConfig({
    ...legacy,
    agent: {
      id: "peiyuan-codex",
      ownerOpenId: "ou_owner",
      botOpenId: "ou_localbot",
      allowedHumanOpenIds: ["ou_owner"],
      executor: { type: "codex" },
    },
    collaboration: collaboration(),
    repositories: [{ id: "bridge", path: "./bridge", defaultBranch: "main" }],
    project: {
      id: "bridge-local",
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
  assert.deepEqual(sdkGroupAllowlist(config), ["oc_team"]);
  assert.equal(config.collaboration.groupChatId, "oc_team");
  assert.equal(config.collaboration.githubRepository, "example/bridge");
  assert.equal(config.collaboration.receiveMode, "recommend");
  assert.equal(config.collaboration.groupHumanMessageMode, "owner");
  assert.equal(config.collaboration.trustedPeers[0].humanOpenId, "ou_alice");
  assert.equal(config.project.id, "bridge-local");
  assert.equal(config.project.desktopProjectId, "desktop-project-1");
  assert.equal(config.project.worktreeRoot, path.resolve("C:/config", "../worktrees/bridge"));
  assert.equal(config.teamHub.path, path.resolve("C:/config", "../team-agent-hub"));
});

test("requires exactly one collaboration group and one GitHub repository", () => {
  const base = { ...legacy, agent: { ownerOpenId: "ou_owner", botOpenId: "ou_bot" } };
  assert.throws(() => normalizeBridgeConfig({
    ...base,
    collaboration: collaboration({ groupChatId: undefined }),
  }), /groupChatId/);
  assert.throws(() => normalizeBridgeConfig({
    ...base,
    collaboration: collaboration({ githubRepository: undefined }),
  }), /githubRepository/);
  assert.throws(() => normalizeBridgeConfig({
    ...base,
    collaboration: collaboration({ groupChatIds: ["oc_team", "oc_other"] }),
  }), /exactly one/);
  assert.throws(() => normalizeBridgeConfig({
    ...base,
    collaboration: collaboration({ githubRepository: "gitlab.example/org/repo" }),
  }), /owner\/name/);
});

test("requires unique peer Bot and human identities", () => {
  const base = { ...legacy, agent: { ownerOpenId: "ou_owner", botOpenId: "ou_bot" } };
  assert.throws(() => normalizeBridgeConfig({
    ...base,
    collaboration: collaboration({ trustedPeers: [
      { agentId: "alice", botOpenId: "ou_same", humanOpenId: "ou_alice" },
      { agentId: "bob", botOpenId: "ou_same", humanOpenId: "ou_bob" },
    ] }),
  }), /bot open_ids must be unique/);
  assert.throws(() => normalizeBridgeConfig({
    ...base,
    collaboration: collaboration({ trustedPeers: [
      { agentId: "alice", botOpenId: "ou_alice_bot", humanOpenId: "ou_same" },
      { agentId: "bob", botOpenId: "ou_bob_bot", humanOpenId: "ou_same" },
    ] }),
  }), /human open_ids must be unique/);
});

test("refuses local identities in the trusted peer roster", () => {
  const base = {
    ...legacy,
    agent: { id: "local", ownerOpenId: "ou_owner", botOpenId: "ou_bot" },
    project: { id: "bridge", repoRoot: "./workspace" },
  };
  assert.throws(() => normalizeBridgeConfig({
    ...base,
    collaboration: collaboration({
      trustedPeers: [{ agentId: "local", botOpenId: "ou_peer", humanOpenId: "ou_peer_human" }],
    }),
  }), /local agent id/);
  assert.throws(() => normalizeBridgeConfig({
    ...base,
    collaboration: collaboration({
      trustedPeers: [{ agentId: "alice", botOpenId: "ou_bot", humanOpenId: "ou_alice" }],
    }),
  }), /local bot open_id/);
  assert.throws(() => normalizeBridgeConfig({
    ...base,
    collaboration: collaboration({
      trustedPeers: [{ agentId: "alice", botOpenId: "ou_alice_bot", humanOpenId: "ou_owner" }],
    }),
  }), /local owner open_id/);
});

test("restricts receive and group-human routing modes", () => {
  const base = { ...legacy, agent: { ownerOpenId: "ou_owner", botOpenId: "ou_bot" } };
  assert.throws(() => normalizeBridgeConfig({
    ...base,
    collaboration: collaboration({ receiveMode: "guess" }),
  }), /receiveMode/);
  assert.throws(() => normalizeBridgeConfig({
    ...base,
    collaboration: collaboration({ groupHumanMessageMode: "everyone" }),
  }), /groupHumanMessageMode/);
});

test("restricts approvers, Team Hub writers, and repository scopes", () => {
  assert.throws(() => normalizeBridgeConfig({
    ...legacy,
    agent: { ownerOpenId: "ou_owner", botOpenId: "ou_bot" },
    collaboration: collaboration({ approverOpenIds: ["ou_unknown"] }),
  }), /subset/);
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

test("refuses a worktree root or collaboration remote outside Project allowlists", () => {
  assert.throws(() => normalizeBridgeConfig({
    ...legacy,
    project: {
      id: "bridge",
      repoRoot: "./bridge",
      worktreeRoot: "C:/untrusted/worktrees",
      allowedWorktreeRoots: ["./bridge"],
    },
  }, { configDir: "C:/config" }), /worktreeRoot must be inside/);
  assert.throws(() => normalizeBridgeConfig({
    ...legacy,
    agent: { ownerOpenId: "ou_owner", botOpenId: "ou_bot" },
    project: { allowedRemotes: ["origin"] },
    collaboration: collaboration({ remote: "upstream" }),
  }), /collaboration.remote/);
});
