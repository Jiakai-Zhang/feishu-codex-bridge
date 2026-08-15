import assert from "node:assert/strict";
import test from "node:test";
import { buildPeerControlReply, buildTeamMarkdown, parsePeerControlMessage } from "../../../../../src/experimental/collaboration/commands/team-commands.mjs";

const config = {
  agent: {
    id: "local-codex",
    displayName: "Local Codex",
    botOpenId: "ou_localbot",
    allowedHumanOpenIds: ["ou_owner", "ou_member"],
  },
  project: { id: "local-bridge-project" },
  collaboration: {
    enabled: true,
    groupChatId: "oc_team",
    githubRepository: "example/shared-repository",
    remote: "origin",
    groupHumanMessageMode: "owner",
    receiveMode: "recommend",
    approverOpenIds: ["ou_owner"],
    trustedPeers: [{
      agentId: "alice-codex",
      displayName: "Alice Bot",
      humanDisplayName: "Alice",
      humanOpenId: "ou_alice",
      botOpenId: "ou_alice_bot",
      enabled: true,
    }],
  },
  teamHub: { enabled: true, repositoryIds: ["bridge"] },
};

test("parses repository-bound peer control messages", () => {
  assert.deepEqual(parsePeerControlMessage("/peer ping Example/Shared-Repository req-1"), {
    action: "ping",
    githubRepository: "example/shared-repository",
    requestId: "req-1",
  });
  assert.deepEqual(parsePeerControlMessage("/peer status https://github.com/example/shared-repository.git"), {
    action: "status",
    githubRepository: "example/shared-repository",
    requestId: undefined,
  });
  assert.equal(parsePeerControlMessage("fix this code").error, "unsupported_peer_control");
  assert.equal(parsePeerControlMessage("/peer ping ../other-project").error, "invalid_github_repository");
  assert.equal(parsePeerControlMessage(`/peer ping example/repo ${"x".repeat(81)}`).error, "invalid_request_id");
});

test("team status shows the one-group one-repository boundary and local receive policy", () => {
  const markdown = buildTeamMarkdown(config);
  assert.match(markdown, /local-codex/);
  assert.match(markdown, /alice-codex/);
  assert.match(markdown, /local-bridge-project/);
  assert.match(markdown, /oc_team/);
  assert.match(markdown, /example\/shared-repository/);
  assert.match(markdown, /普通 owner 群消息会进入自己的 Agent/);
});

test("peer control replies distinguish local Project from shared authority", () => {
  const markdown = buildPeerControlReply(config, config.collaboration.trustedPeers[0], {
    action: "ping",
    githubRepository: "example/shared-repository",
    requestId: "req-1",
  });
  assert.match(markdown, /req-1/);
  assert.match(markdown, /Project ID 不是跨机器授权凭据/);
  assert.doesNotMatch(markdown, /<at|@_/i);
});
