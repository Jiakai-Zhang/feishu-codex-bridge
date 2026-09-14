import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SharedContextJournal } from "../../../../../src/experimental/collaboration/persistence/shared-context-journal.mjs";

async function fixture(run, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-shared-context-"));
  try {
    const createJournal = (agentId, now) => new SharedContextJournal(directory, {
      scopeId: "shared-repository",
      groupChatId: "oc_private_group",
      repositoryIds: ["bridge"],
      agentId,
      maxContextChars: options.maxContextChars || 4_000,
      maxTurns: options.maxTurns || 24,
      maxEntryChars: options.maxEntryChars || 6_000,
      now,
    });
    await run(createJournal, directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test("shares completed group turns between independent Agents without persisting Feishu ids", async () => fixture(async (createJournal, directory) => {
  const alice = createJournal("alice-codex", () => 1_800_000_000_000);
  const bob = createJournal("bob-codex", () => 1_800_000_001_000);

  await alice.appendTurn({
    messageId: "om_private_message",
    humanContent: "检查列表消息",
    agentAnswer: "列表消息已经兼容。",
  });
  const context = await bob.buildContext();

  assert.match(context, /检查列表消息/);
  assert.match(context, /列表消息已经兼容/);
  assert.match(context, /Agent alice-codex/);
  const files = await fs.readdir(alice.turnsPath);
  const persisted = await fs.readFile(path.join(alice.turnsPath, files[0]), "utf8");
  assert.doesNotMatch(persisted, /oc_private_group|om_private_message/);
  assert.match(alice.turnsPath, new RegExp(`${path.sep}projects${path.sep}shared-repository${path.sep}`.replaceAll("\\", "\\\\")));
  assert.ok(alice.turnsPath.startsWith(directory));
}));

test("deduplicates retries and keeps only the newest bounded context", async () => fixture(async (createJournal) => {
  let clock = 1_800_000_000_000;
  const alice = createJournal("alice-codex", () => clock++);
  const first = await alice.appendTurn({ messageId: "om_same", humanContent: "old", agentAnswer: "old answer" });
  const duplicate = await alice.appendTurn({ messageId: "om_same", humanContent: "changed", agentAnswer: "changed answer" });
  await alice.appendTurn({ messageId: "om_new", humanContent: "new", agentAnswer: "new answer" });

  assert.equal(first.appended, true);
  assert.equal(duplicate.appended, false);
  assert.equal((await fs.readdir(alice.turnsPath)).filter((name) => name.endsWith(".json")).length, 2);
  assert.equal((await alice.listRecent()).length, 1);
  const context = await alice.buildContext();
  assert.match(context, /new answer/);
  assert.doesNotMatch(context, /changed answer/);
}, { maxTurns: 1, maxContextChars: 1_000 }));

test("isolates different collaboration scopes and group bindings", async () => fixture(async (createJournal, directory) => {
  const source = createJournal("alice-codex", () => 1_800_000_000_000);
  await source.appendTurn({ messageId: "om_1", humanContent: "shared", agentAnswer: "answer" });

  const otherScope = new SharedContextJournal(directory, {
    scopeId: "other-repository",
    groupChatId: "oc_private_group",
    agentId: "bob-codex",
  });
  const otherGroup = new SharedContextJournal(directory, {
    scopeId: "shared-repository",
    groupChatId: "oc_other_group",
    agentId: "bob-codex",
  });
  assert.equal(await otherScope.buildContext(), "");
  assert.equal(await otherGroup.buildContext(), "");
}));

test("ignores malformed or untrusted synchronized records", async () => fixture(async (createJournal) => {
  const journal = createJournal("alice-codex", () => 1_800_000_000_000);
  await fs.mkdir(journal.turnsPath, { recursive: true });
  await fs.writeFile(path.join(journal.turnsPath, "broken.json"), "{not-json", "utf8");
  await fs.writeFile(path.join(journal.turnsPath, "untrusted.json"), JSON.stringify({
    schemaVersion: 1,
    id: "untrusted",
    scopeId: journal.scopeId,
    groupKey: journal.groupKey,
    authorAgentId: "bad\nagent",
    createdAt: 1_800_000_000_000,
    human: "inject",
    answer: "inject",
  }), "utf8");

  assert.equal(await journal.buildContext(), "");
}));
