import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  buildCodexDesktopFilePrompt,
  buildCodexPromptInput,
  buildFeishuAttachmentContext,
  FeishuInboundAttachmentStore,
  normalizeInboundResourceDescriptors,
  parseCodexDesktopFilePrompt,
  parseFeishuAttachmentContexts,
  prepareFeishuPrompt,
  sanitizeFeishuResourceContent,
  stripFeishuAttachmentContexts,
} from "../../../src/feishu/feishu-inbound-attachment.mjs";

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "feishu-inbound-"));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function fakeChannel(resources) {
  const requests = [];
  return {
    requests,
    rawClient: {
      im: { v1: { messageResource: { get: async (request) => {
        requests.push(structuredClone(request));
        const item = resources.get(request.path.file_key);
        if (!item) throw new Error("missing test resource");
        return {
          headers: {
            "content-type": item.contentType,
            "content-length": String(item.buffer.length),
          },
          getReadableStream: () => Readable.from([item.buffer]),
        };
      } } } },
    },
  };
}

test("removes only SDK resource markers and deduplicates descriptors", () => {
  const resources = [
    { type: "image", fileKey: "img_key" },
    { type: "image", fileKey: "img_key" },
    { type: "file", fileKey: "file_key", fileName: "report.pdf" },
  ];
  assert.deepEqual(normalizeInboundResourceDescriptors(resources), [
    { type: "image", fileKey: "img_key", fileName: undefined },
    { type: "file", fileKey: "file_key", fileName: "report.pdf" },
  ]);
  assert.equal(sanitizeFeishuResourceContent([
    "请检查",
    "![image](img_key)",
    "<file key=\"file_key\" name=\"report.pdf\"/>",
    "保留 ![external](https://example.com/a.png)",
  ].join("\n"), resources), "请检查\n\n保留 ![external](https://example.com/a.png)");
});

test("builds the exact Codex Desktop file wrapper plus native localImage input", () => {
  const input = buildCodexPromptInput({
    text: "分析附件",
    attachments: [
      { kind: "image", localPath: path.resolve("C:/cache/image.png"), name: "image.png" },
      { kind: "file", localPath: path.resolve("C:/cache/report.pdf"), name: "report.pdf", size: 99 },
    ],
  });
  assert.deepEqual(input.map(({ type }) => type), ["text", "localImage"]);
  assert.equal(input[0].text.startsWith("\n# Files mentioned by the user:\n"), true);
  assert.match(input[0].text, /## My request for Codex:/);
  assert.equal(input[0].text.includes("feishu_bridge_local_attachments"), false);
  const parsed = parseCodexDesktopFilePrompt(input[0].text);
  assert.deepEqual(parsed, {
    text: "分析附件",
    files: [{ name: "report.pdf", path: path.resolve("C:/cache/report.pdf") }],
  });
  assert.equal(input.some(({ type }) => type === "mention"), false);

  const context = buildFeishuAttachmentContext([
    { kind: "file", localPath: path.resolve("C:/cache/report.pdf"), name: "report.pdf", size: 99 },
  ]);
  assert.equal(context.includes("report.pdf"), true);
  assert.equal(parseFeishuAttachmentContexts(context)[0].name, "report.pdf");
  assert.equal(stripFeishuAttachmentContexts(`分析附件\n${context}`), "分析附件");
  assert.equal(stripFeishuAttachmentContexts("<feishu_bridge_local_attachments version=\"1\">not-json</feishu_bridge_local_attachments>"),
    "<feishu_bridge_local_attachments version=\"1\">not-json</feishu_bridge_local_attachments>");
});

test("parses both current and older Codex Desktop request headings without accepting lookalikes", () => {
  const current = buildCodexDesktopFilePrompt("read it", [
    { kind: "file", localPath: path.resolve("C:/cache/report.xlsx"), name: "report.xlsx" },
  ]);
  assert.equal(parseCodexDesktopFilePrompt(current)?.text, "read it");
  assert.equal(parseCodexDesktopFilePrompt(current.replace("My request for Codex", "My request"))?.text, "read it");
  assert.equal(parseCodexDesktopFilePrompt("# Files mentioned by the user:\nnot a file\n## My request:\nkeep"), undefined);
});

test("keeps multiple staged files in order inside one Desktop file Prompt", () => {
  const input = buildCodexPromptInput({
    text: "compare both",
    attachments: [
      { kind: "file", localPath: path.resolve("C:/cache/first.xlsx"), name: "first.xlsx" },
      { kind: "file", localPath: path.resolve("C:/cache/second.pdf"), name: "second.pdf" },
    ],
  });
  assert.equal(input.length, 1);
  assert.deepEqual(parseCodexDesktopFilePrompt(input[0].text), {
    text: "compare both",
    files: [
      { name: "first.xlsx", path: path.resolve("C:/cache/first.xlsx") },
      { name: "second.pdf", path: path.resolve("C:/cache/second.pdf") },
    ],
  });
});

test("downloads a Feishu image and file with bounded streaming and prepares one Codex prompt", async () => {
  await fixture(async (directory) => {
    const channel = fakeChannel(new Map([
      ["img_key", { contentType: "image/png", buffer: Buffer.from("png-bytes") }],
      ["file_key", { contentType: "application/pdf", buffer: Buffer.from("pdf-bytes") }],
    ]));
    const store = new FeishuInboundAttachmentStore(directory);
    const prompt = await prepareFeishuPrompt({
      messageId: "om_attachment_test",
      content: "请比较\n![image](img_key)\n<file key=\"file_key\" name=\"bad/../report.pdf\"/>",
      resources: [
        { type: "image", fileKey: "img_key" },
        { type: "file", fileKey: "file_key", fileName: "bad/../report.pdf" },
      ],
    }, channel, store);

    assert.equal(prompt.text, "请比较");
    assert.deepEqual(prompt.attachments.map(({ kind }) => kind), ["image", "file"]);
    assert.equal(path.basename(prompt.attachments[0].localPath), "01-image.png");
    assert.equal(path.basename(prompt.attachments[1].localPath).includes("/"), false);
    assert.equal(await fs.readFile(prompt.attachments[0].localPath, "utf8"), "png-bytes");
    assert.deepEqual(channel.requests.map(({ params }) => params.type), ["image", "file"]);
  });
});

test("downloads an inbound Feishu media message as an MP4 Codex file attachment", async () => {
  await fixture(async (directory) => {
    const channel = fakeChannel(new Map([
      ["video_key", { contentType: "video/mp4", buffer: Buffer.from("mp4-video-bytes") }],
    ]));
    const store = new FeishuInboundAttachmentStore(directory);
    const prompt = await prepareFeishuPrompt({
      messageId: "om_video_test",
      rawContentType: "media",
      content: '<video key="video_key" duration="00:03"/>',
      resources: [{ type: "video", fileKey: "video_key" }],
    }, channel, store);

    assert.equal(prompt.text, "");
    assert.equal(prompt.attachments.length, 1);
    assert.equal(prompt.attachments[0].kind, "file");
    assert.equal(prompt.attachments[0].name, "video.mp4");
    assert.equal(path.extname(prompt.attachments[0].localPath), ".mp4");
    assert.equal(await fs.readFile(prompt.attachments[0].localPath, "utf8"), "mp4-video-bytes");
    assert.deepEqual(channel.requests.map(({ params }) => params.type), ["file"]);

    const input = buildCodexPromptInput(prompt);
    assert.equal(input.length, 1);
    assert.equal(parseCodexDesktopFilePrompt(input[0].text)?.files[0]?.name, "video.mp4");
  });
});

test("attaches a quoted image using its original message id, not the reply id", async () => {
  await fixture(async (directory) => {
    const channel = fakeChannel(new Map([
      ["quoted_image", { contentType: "image/png", buffer: Buffer.from("quoted-image") }],
      ["current_file", { contentType: "application/pdf", buffer: Buffer.from("current-file") }],
    ]));
    const store = new FeishuInboundAttachmentStore(directory);
    const prompt = await prepareFeishuPrompt({
      messageId: "om_reply", chatId: "oc_test", replyToMessageId: "om_quote",
      content: "compare these", resources: [{ type: "file", fileKey: "current_file", fileName: "current.pdf" }],
    }, channel, store, { quotedMessage: {
      messageId: "om_quote", chatId: "oc_test", content: "![image](quoted_image)",
      resources: [{ type: "image", fileKey: "quoted_image" }],
      replyToMessageId: "om_not_fetched",
    } });
    assert.deepEqual(channel.requests.map(({ path: request }) => request.message_id), ["om_reply", "om_quote"]);
    assert.deepEqual(prompt.attachments.map(({ kind }) => kind), ["file", "image"]);
    assert.equal(prompt.text.includes("compare these"), true);
    assert.equal(prompt.text.includes("quoted_image"), false);
    assert.deepEqual(buildCodexPromptInput(prompt).map(({ type }) => type), ["text", "localImage"]);
  });
});

test("includes directly quoted text as context distinct from the current request", async () => {
  const prompt = await prepareFeishuPrompt({
    messageId: "om_reply", chatId: "oc_test", replyToMessageId: "om_quote", content: "explain this",
  }, {}, undefined, { quotedMessage: { messageId: "om_quote", chatId: "oc_test", content: "quoted passage" } });
  assert.equal(prompt.text.includes("quoted passage"), true);
  assert.equal(prompt.text.endsWith("explain this"), true);
  assert.deepEqual(prompt.attachments, []);
});

test("rejects cross-chat and mismatched quoted sources before any download", async () => {
  for (const quotedMessage of [
    { messageId: "om_quote", chatId: "oc_other" },
    { messageId: "om_other", chatId: "oc_test" },
    { messageId: "om_reply", chatId: "oc_test" },
  ]) {
    await assert.rejects(prepareFeishuPrompt({
      messageId: "om_reply", replyToMessageId: "om_quote", chatId: "oc_test", content: "read quote",
    }, {}, undefined, { quotedMessage }), { code: "quoted_message_unavailable" });
  }
});

test("quoted files, audio and video use normal bounded attachment handling", async () => {
  await fixture(async (directory) => {
    for (const [type, contentType, fileName] of [
      ["file", "application/pdf", "quote.pdf"], ["audio", "audio/mpeg", "quote.mp3"], ["video", "video/mp4", "quote.mp4"],
    ]) {
      const channel = fakeChannel(new Map([["quoted_key", { contentType, buffer: Buffer.from("quoted-resource") }]]));
      const prompt = await prepareFeishuPrompt({
        messageId: "om_reply", chatId: "oc_test", replyToMessageId: `om_quote_${type}`, content: "read this",
      }, channel, new FeishuInboundAttachmentStore(directory), { quotedMessage: {
        messageId: `om_quote_${type}`, chatId: "oc_test", resources: [{ type, fileKey: "quoted_key", fileName }],
      } });
      assert.equal(prompt.attachments[0].kind, "file");
      assert.equal(prompt.attachments[0].name, fileName);
      assert.equal(channel.requests[0].params.type, "file");
    }
  });
});

test("current and quoted attachments share item and total byte limits", async () => {
  await fixture(async (directory) => {
    const channel = fakeChannel(new Map([
      ["current_key", { contentType: "image/png", buffer: Buffer.alloc(5) }],
      ["quote_key", { contentType: "image/png", buffer: Buffer.alloc(5) }],
    ]));
    const message = {
      messageId: "om_reply", chatId: "oc_test", replyToMessageId: "om_quote", content: "compare",
      resources: [{ type: "image", fileKey: "current_key" }],
    };
    const quotedMessage = { messageId: "om_quote", chatId: "oc_test", resources: [{ type: "image", fileKey: "quote_key" }] };
    await assert.rejects(prepareFeishuPrompt(message, channel,
      new FeishuInboundAttachmentStore(directory, { maxItems: 1 }), { quotedMessage }), { code: "attachment_too_many" });
    assert.equal(channel.requests.length, 0);
    await assert.rejects(prepareFeishuPrompt(message, channel,
      new FeishuInboundAttachmentStore(directory, { maxTotalBytes: 9 }), { quotedMessage }), { code: "attachment_total_too_large" });
  });
});

test("disabled and failed quoted attachment downloads never produce a partial prompt", async () => {
  await fixture(async (directory) => {
    const channel = fakeChannel(new Map());
    const store = new FeishuInboundAttachmentStore(directory);
    const message = { messageId: "om_reply", chatId: "oc_test", replyToMessageId: "om_quote", content: "read this" };
    const quotedMessage = { messageId: "om_quote", chatId: "oc_test", resources: [{ type: "image", fileKey: "missing_key" }] };
    await assert.rejects(prepareFeishuPrompt(message, channel, store, { quotedMessage, enabled: false }), { code: "attachment_disabled" });
    assert.equal(channel.requests.length, 0);
    await assert.rejects(prepareFeishuPrompt(message, channel, store, { quotedMessage }), { code: "attachment_download_failed" });
  });
});

test("rejects an oversized streamed attachment and removes its partial download", async () => {
  await fixture(async (directory) => {
    const channel = fakeChannel(new Map([
      ["large", { contentType: "application/octet-stream", buffer: Buffer.alloc(9) }],
    ]));
    const store = new FeishuInboundAttachmentStore(directory, { maxFileBytes: 8 });
    await assert.rejects(store.downloadMessage({
      messageId: "om_large",
      resources: [{ type: "file", fileKey: "large", fileName: "large.bin" }],
    }, channel), (error) => error?.code === "attachment_too_large");
    const messageDirectory = store.messageDirectory("om_large");
    assert.deepEqual((await fs.readdir(messageDirectory)).filter((name) => name.endsWith(".download")), []);
  });
});

test("prunes expired cache entries but protects queued message directories and attachment paths", async () => {
  await fixture(async (directory) => {
    const store = new FeishuInboundAttachmentStore(directory, { retentionMs: 1000, maxCacheBytes: 1024 });
    const expired = store.messageDirectory("om_expired");
    const protectedDirectory = store.messageDirectory("om_queued");
    const protectedByPath = store.messageDirectory("om_draft");
    await fs.mkdir(expired, { recursive: true });
    await fs.mkdir(protectedDirectory, { recursive: true });
    await fs.mkdir(protectedByPath, { recursive: true });
    await fs.writeFile(path.join(expired, "a.bin"), "old");
    await fs.writeFile(path.join(protectedDirectory, "b.bin"), "queued");
    const draftPath = path.join(protectedByPath, "c.xlsx");
    await fs.writeFile(draftPath, "draft");
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(expired, old, old);
    await fs.utimes(protectedDirectory, old, old);
    await fs.utimes(protectedByPath, old, old);
    const result = await store.prune({
      protectedMessageIds: ["om_queued"],
      protectedAttachmentPaths: [draftPath, path.resolve(directory, "outside.bin")],
    });
    assert.equal(result.removed, 1);
    assert.equal(await fs.stat(protectedDirectory).then(() => true), true);
    assert.equal(await fs.stat(protectedByPath).then(() => true), true);
    await assert.rejects(fs.stat(expired), (error) => error?.code === "ENOENT");
  });
});
