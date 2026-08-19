import assert from "node:assert/strict";
import test from "node:test";
import {
  executeMembersCommand,
  parseMembersCommand,
  publicMembersFailure,
} from "../../../src/relay/session-access-commands.mjs";

test("parses the owner member-management command surface", () => {
  assert.deepEqual(parseMembersCommand("/members"), { action: "status" });
  assert.deepEqual(parseMembersCommand("/members add alice @user"), { action: "add", args: "alice @user" });
  assert.deepEqual(parseMembersCommand("/members remove @user"), { action: "remove", args: "@user" });
  assert.equal(parseMembersCommand("hello"), undefined);
});

test("adds exactly one mentioned member with one safe directory name", async () => {
  const calls = [];
  const onboardingCalls = [];
  const accessStore = {
    addMember: async (record) => calls.push(record),
    snapshot: () => ({ projectRoot: "private", users: [
      { role: "owner" },
      { role: "member", status: "active", displayName: "Alice", directoryName: "alice" },
    ] }),
    isConfigured: () => true,
  };
  const result = await executeMembersCommand(parseMembersCommand("/members add alice @user"), {
    accessStore,
    botOpenId: "ou_bot",
    mentions: [{ openId: "ou_member", name: "Alice", isBot: false }],
    sendMemberOnboarding: async (record) => onboardingCalls.push(record),
  });
  assert.equal(result.restart, true);
  assert.equal(result.onboarding, "sent");
  assert.deepEqual(calls, [{ openId: "ou_member", directoryName: "alice", displayName: "Alice" }]);
  assert.deepEqual(onboardingCalls, [{ memberOpenId: "ou_member" }]);
  assert.match(result.markdown, /私聊.*`\/add`/);
  assert.doesNotMatch(result.markdown, /private/);
});

test("keeps the member active and gives the owner a fallback when onboarding delivery fails", async () => {
  let added = false;
  const accessStore = {
    addMember: async () => { added = true; },
    snapshot: () => ({ projectRoot: "private", users: [
      { role: "owner" },
      { role: "member", status: "active", displayName: "Alice", directoryName: "alice" },
    ] }),
    isConfigured: () => true,
  };
  const result = await executeMembersCommand(parseMembersCommand("/members add alice @user"), {
    accessStore,
    botOpenId: "ou_bot",
    mentions: [{ openId: "ou_member", name: "Alice", isBot: false }],
    sendMemberOnboarding: async () => { throw new Error("private SDK failure"); },
  });
  assert.equal(added, true);
  assert.equal(result.restart, true);
  assert.equal(result.onboarding, "failed");
  assert.match(result.markdown, /成员已登记/);
  assert.match(result.markdown, /可用范围/);
  assert.doesNotMatch(result.markdown, /private SDK failure/);
});

test("refuses to deactivate a member that still owns a Session binding", async () => {
  let deactivated = false;
  const accessStore = {
    deactivateMember: async () => { deactivated = true; },
    snapshot: () => ({ users: [] }),
    isConfigured: () => true,
  };
  await assert.rejects(
    executeMembersCommand(parseMembersCommand("/members remove @user"), {
      accessStore,
      botOpenId: "ou_bot",
      mentions: [{ openId: "ou_member", name: "Alice", isBot: false }],
      listBindings: async () => [{ ownerOpenId: "ou_member", threadId: "thread-a" }],
    }),
    (error) => error?.code === "member_owns_bindings",
  );
  assert.equal(deactivated, false);
});

test("does not expose the global member roster in a shared group acknowledgement", async () => {
  const accessStore = {
    addMember: async () => {},
    snapshot: () => ({ projectRoot: "private", users: [
      { role: "owner" },
      { role: "member", status: "active", displayName: "Alice", directoryName: "alice" },
      { role: "member", status: "active", displayName: "Bob", directoryName: "bob" },
    ] }),
    isConfigured: () => true,
  };
  const result = await executeMembersCommand(parseMembersCommand("/members add alice @user"), {
    accessStore,
    botOpenId: "ou_bot",
    mentions: [{ openId: "ou_member", name: "Alice", isBot: false }],
    includeRoster: false,
    sendMemberOnboarding: async () => {},
  });
  assert.doesNotMatch(result.markdown, /Alice|Bob|2/);
  assert.match(result.markdown, /完整成员清单只在与 Bot 的私聊中显示/);
});

test("points missing Project root setup at both supported platform entrypoints", () => {
  const result = publicMembersFailure({ code: "project_root_missing" });
  assert.match(result, /setup-project-root\.ps1/);
  assert.match(result, /setup-project-root\.sh/);
});
