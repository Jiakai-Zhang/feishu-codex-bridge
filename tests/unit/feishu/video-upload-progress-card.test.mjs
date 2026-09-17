import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVideoUploadProgressCard,
  createVideoUploadProgressReporter,
} from "../../../src/feishu/video-upload-progress-card.mjs";

test("builds a compact Card 2.0 video upload status with one percentage focus", () => {
  const card = buildVideoUploadProgressCard({
    stage: "uploading",
    uploadedBytes: 5 * 1024 * 1024,
    totalBytes: 20 * 1024 * 1024,
    elapsedMs: 65_000,
    attempt: 2,
  });

  assert.equal(card.schema, "2.0");
  assert.equal(card.config.width_mode, "compact");
  assert.equal(card.header.template, "blue");
  assert.equal(card.body.elements.length, 2);
  assert.match(card.body.elements[0].columns[0].elements[0].content, /25%/);
  assert.match(card.body.elements[1].fields[2].text.content, /1 分 5 秒/);
  assert.match(card.body.elements[1].fields[3].text.content, /第 2 次/);

  const completed = buildVideoUploadProgressCard({ stage: "complete", totalBytes: 100 });
  assert.equal(completed.header.template, "green");
  assert.match(completed.config.summary.content, /100%/);
});

test("serializes and throttles video upload card updates", async () => {
  let timestamp = 1_000;
  const updates = [];
  const reporter = createVideoUploadProgressReporter({
    attempt: 3,
    startedAt: 500,
    now: () => timestamp,
    update: async (card) => { updates.push(card); },
  });

  await reporter.report({ stage: "uploading", uploadedBytes: 1, totalBytes: 100 });
  timestamp += 100;
  await reporter.report({ stage: "uploading", uploadedBytes: 2, totalBytes: 100 });
  timestamp += 100;
  await reporter.report({ stage: "uploading", uploadedBytes: 10, totalBytes: 100 });
  await reporter.report({ stage: "sending", uploadedBytes: 100, totalBytes: 100 });
  await reporter.flush();

  assert.equal(updates.length, 3);
  assert.match(updates[0].body.elements[0].columns[0].elements[0].content, /1%/);
  assert.match(updates[1].body.elements[0].columns[0].elements[0].content, /10%/);
  assert.match(updates[2].config.summary.content, /100%/);
});
