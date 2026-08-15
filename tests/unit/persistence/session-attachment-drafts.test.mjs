import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SessionAttachmentDraftStore,
  shouldStageAttachmentPrompt,
} from "../../../src/persistence/session-attachment-drafts.mjs";

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "session-attachment-drafts-"));
  try {
    await run(path.join(directory, "drafts.json"), directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function attachment(directory, name, { kind = "file", size = 10 } = {}) {
  return { kind, localPath: path.join(directory, name), name, size };
}

test("stages file-only messages, accumulates multiple uploads, and persists them", async () => {
  await fixture(async (filePath, directory) => {
    const store = await SessionAttachmentDraftStore.open(filePath, { maxItems: 3, maxTotalBytes: 100 });
    assert.equal(shouldStageAttachmentPrompt({
      text: "",
      attachments: [attachment(directory, "one.xlsx")],
    }), true);
    assert.equal(shouldStageAttachmentPrompt({
      text: "",
      attachments: [attachment(directory, "image.png", { kind: "image" })],
    }), false);

    await store.stage({
      messageId: "om_file_1",
      sessionThreadId: "thread-a",
      chatId: "oc_a",
      attachments: [attachment(directory, "one.xlsx")],
      createdAt: 1,
    });
    await store.stage({
      messageId: "om_file_2",
      sessionThreadId: "thread-a",
      chatId: "oc_a",
      attachments: [attachment(directory, "two.pdf")],
      createdAt: 2,
    });
    assert.equal(store.count("thread-a"), 2);
    assert.equal(shouldStageAttachmentPrompt({
      text: "",
      attachments: [attachment(directory, "image.png", { kind: "image" })],
    }, { hasPendingDraft: store.hasPending("thread-a") }), true);

    const reopened = await SessionAttachmentDraftStore.open(filePath, { maxItems: 3, maxTotalBytes: 100 });
    assert.deepEqual(reopened.list("thread-a").map(({ messageId }) => messageId), ["om_file_1", "om_file_2"]);
    assert.deepEqual(reopened.protectedMessageIds(), ["om_file_1", "om_file_2"]);
  });
});

test("claims all staged attachments for the first text prompt and commits atomically", async () => {
  await fixture(async (filePath, directory) => {
    const store = await SessionAttachmentDraftStore.open(filePath, { maxItems: 4, maxTotalBytes: 100 });
    await store.stage({
      messageId: "om_file_1",
      sessionThreadId: "thread-a",
      chatId: "oc_a",
      attachments: [attachment(directory, "one.xlsx")],
    });
    await store.stage({
      messageId: "om_file_2",
      sessionThreadId: "thread-a",
      chatId: "oc_a",
      attachments: [attachment(directory, "two.pdf")],
    });

    const claim = await store.claim("thread-a", "om_prompt", {
      additionalAttachments: [attachment(directory, "inline.png", { kind: "image" })],
    });
    assert.deepEqual(claim.attachments.map(({ name }) => name), ["one.xlsx", "two.pdf", "inline.png"]);
    assert.equal(store.count("thread-a"), 0);
    assert.equal(store.list("thread-a", { includeClaimed: true }).length, 2);

    const reopened = await SessionAttachmentDraftStore.open(filePath, { maxItems: 4, maxTotalBytes: 100 });
    assert.equal(reopened.list("thread-a").length, 0);
    assert.equal(await reopened.completeClaim("om_prompt"), 2);
    assert.equal(reopened.list("thread-a", { includeClaimed: true }).length, 0);
  });
});

test("releases an unaccepted claim after restart and drops an accepted claim", async () => {
  await fixture(async (filePath, directory) => {
    const store = await SessionAttachmentDraftStore.open(filePath);
    await store.stage({
      messageId: "om_file_1",
      sessionThreadId: "thread-a",
      chatId: "oc_a",
      attachments: [attachment(directory, "one.xlsx")],
    });
    await store.claim("thread-a", "om_failed");
    assert.deepEqual(await store.reconcile({ isPromptAccepted: () => false }), { completed: 0, released: 1 });
    assert.equal(store.count("thread-a"), 1);

    await store.claim("thread-a", "om_accepted");
    assert.deepEqual(await store.reconcile({ isPromptAccepted: (id) => id === "om_accepted" }), {
      completed: 1,
      released: 0,
    });
    assert.equal(store.list(undefined, { includeClaimed: true }).length, 0);
  });
});

test("enforces item and aggregate byte limits across separate messages", async () => {
  await fixture(async (filePath, directory) => {
    const store = await SessionAttachmentDraftStore.open(filePath, { maxItems: 2, maxTotalBytes: 15 });
    await store.stage({
      messageId: "om_file_1",
      sessionThreadId: "thread-a",
      chatId: "oc_a",
      attachments: [attachment(directory, "one.xlsx", { size: 10 })],
    });
    await assert.rejects(() => store.stage({
      messageId: "om_file_2",
      sessionThreadId: "thread-a",
      chatId: "oc_a",
      attachments: [attachment(directory, "two.xlsx", { size: 6 })],
    }), (error) => error?.code === "attachment_draft_total_too_large");
    await assert.rejects(() => store.claim("thread-a", "om_prompt", {
      additionalAttachments: [
        attachment(directory, "inline-1.png", { kind: "image", size: 1 }),
        attachment(directory, "inline-2.png", { kind: "image", size: 1 }),
      ],
    }), (error) => error?.code === "attachment_draft_full");
  });
});
