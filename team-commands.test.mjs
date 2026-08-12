import assert from "node:assert/strict";
import test from "node:test";
import { buildPeerControlReply, buildTeamMarkdown, parsePeerControlMessage } from "./team-commands.mjs";

const config = {
  agent: {
    id: "local-codex",
    displayName: "Local Codex",
    botOpenId: "ou_localbot",
    allowedHumanOpenIds: ["ou_owner", "ou_member"],
  },
  project: { id: "bridge" },
  collaboration: {
    enabled: true,
    groupChatIds: ["oc_team"],
    defaultGroupChatId: "oc_team",
    approverOpenIds: ["ou_owner"],
    autoAcceptPeerTasks: false,
    trustedPeers: [{
      agentId: "alice-codex",
      displayName: "Alice Codex",
      enabled: true,
      allowedProjectIds: ["bridge"],
    }],
  },
  teamHub: { enabled: true, repositoryIds: ["bridge"] },
};

test("parses only bounded peer control messages", () => {
  assert.deepEqual(parsePeerControlMessage("/peer ping bridge req-1"), {
    action: "ping",
    projectId: "bridge",
    requestId: "req-1",
  });
  assert.deepEqual(parsePeerControlMessage("/peer status bridge"), {
    action: "status",
    projectId: "bridge",
    requestId: undefined,
  });
  assert.equal(parsePeerControlMessage("fix this code").error, "unsupported_peer_control");
  assert.equal(parsePeerControlMessage("/peer ping ../other-project").error, "invalid_project_id");
  assert.equal(parsePeerControlMessage(`/peer ping bridge ${"x".repeat(81)}`).error, "invalid_request_id");
});

test("team status shows identities and Project scopes", () => {
  const markdown = buildTeamMarkdown(config);
  assert.match(markdown, /local-codex/);
  assert.match(markdown, /alice-codex/);
  assert.match(markdown, /bridge/);
  assert.match(markdown, /oc_team/);
  assert.match(markdown, /Team Hub：\*\*已启用/);
  assert.match(markdown, /只接受 `\/peer ping\|status`/);
});

test("peer control replies are deterministic and non-mentioning", () => {
  const markdown = buildPeerControlReply(config, config.collaboration.trustedPeers[0], {
    action: "ping",
    projectId: "bridge",
    requestId: "req-1",
  });
  assert.match(markdown, /req-1/);
  assert.doesNotMatch(markdown, /<at|@_/i);
});
