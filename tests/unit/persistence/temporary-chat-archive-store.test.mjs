import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  renderTemporaryChatArchive,
  TemporaryChatArchiveStore,
} from "../../../src/persistence/temporary-chat-archive-store.mjs";

const record = {
  threadId: "019ff5b8-decb-7ca3-802c-f115f2f196de",
  createdAt: Date.parse("2026-09-07T01:02:03.000Z"),
  endedAt: Date.parse("2026-09-07T01:05:00.000Z"),
};

const thread = {
  id: record.threadId,
  status: { type: "idle" },
  turns: [{
    id: "turn-one",
    items: [
      { type: "userMessage", content: [
        { type: "text", text: "Explain this image" },
        { type: "localImage", path: "C:\\private\\sample.png" },
      ] },
      { type: "agentMessage", phase: "commentary", text: "I am checking the image." },
      { type: "reasoning", summary: ["private reasoning"] },
      { type: "agentMessage", phase: "final_answer", text: "It shows a cell." },
    ],
  }],
};

test("renders only public temporary Chat content as reviewable Markdown", () => {
  const markdown = renderTemporaryChatArchive(record, thread);
  assert.match(markdown, /^# 临时 Codex 对话归档/m);
  assert.match(markdown, /### 用户\n\nExplain this image/);
  assert.match(markdown, /图片：sample\.png/);
  assert.match(markdown, /### Codex（过程）/);
  assert.match(markdown, /### Codex\n\nIt shows a cell\./);
  assert.doesNotMatch(markdown, /private reasoning/);
  assert.doesNotMatch(markdown, /C:\\private/);
});

test("writes one deterministic archive file and reuses it on retry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "temporary-chat-archive-"));
  const store = new TemporaryChatArchiveStore(path.join(directory, "archives"));
  const first = await store.archive(record, thread);
  const original = await readFile(first, "utf8");
  const second = await store.archive(record, { ...thread, turns: [] });

  assert.equal(second, first);
  assert.equal(await store.has(record), true);
  assert.equal(await readFile(second, "utf8"), original);
  assert.deepEqual(await readdir(path.dirname(first)), [path.basename(first)]);
});

test("rejects a mismatched Codex thread before writing an archive", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "temporary-chat-archive-"));
  const store = new TemporaryChatArchiveStore(directory);
  await assert.rejects(() => store.archive(record, { ...thread, id: "another-thread" }), /does not match/);
  assert.deepEqual(await readdir(directory), []);
});
