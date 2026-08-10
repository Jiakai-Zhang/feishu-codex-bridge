function safeError(error) {
  if (error && typeof error === "object" && "code" in error) return `code=${String(error.code)}`;
  return error instanceof Error ? error.message : String(error);
}

function truncateSummary(markdown, max = 50) {
  const compact = String(markdown || "").replace(/\s+/g, " ").trim();
  if (!compact) return "Codex 正在处理";
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

export function buildMarkdownCard(markdown) {
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: truncateSummary(markdown) },
    },
    body: {
      elements: [{
        tag: "markdown",
        content: markdown,
      }],
    },
  };
}

export async function streamCodexInSingleMessage({
  channel,
  msg,
  content,
  askCodex,
  onAnswerReady,
  log = () => {},
  streamWindowMs = 480_000,
  heartbeatIntervalMs = 30_000,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const startedAt = now();
  const activities = ["正在恢复所选 Codex 任务并读取上下文"];
  const notes = [];
  let answer;
  let taskError;
  let taskDone = false;
  let taskPromise;
  let currentController;
  let patchMessageId;
  let patchFailed = false;
  let updates = Promise.resolve();
  let answerRecorded = false;
  let lastRenderQueuedAt = startedAt;
  const heartbeatMs = Math.max(1_000, Number(heartbeatIntervalMs) || 30_000);

  const recordAnswer = async () => {
    if (answerRecorded || taskError || !answer) return;
    answerRecorded = true;
    try { await onAnswerReady?.(answer); }
    catch (error) { log(`answer outbox persistence failed for ${msg.messageId}: ${safeError(error)}`); }
  };

  const renderProgress = () => {
    const elapsed = Math.max(1, Math.floor((now() - startedAt) / 1000));
    const publicNotes = notes.length
      ? notes.slice(-3).map((note) => `> ${note.replace(/\n/g, "\n> ")}`).join("\n\n")
      : "> Codex 正在读取任务上下文，稍后会在这里说明具体进展。";
    const recent = activities.slice(-6).map((stage) => `- ${stage}`).join("\n");
    return [
      `⏳ Codex 正在处理… 已用时 ${elapsed} 秒`,
      "",
      "### Codex 过程说明",
      publicNotes,
      "",
      "### 最近活动",
      recent,
      "",
      "⚠️ 当前为完全本机权限模式。这里只展示可公开说明，不展示隐藏思维链。",
    ].join("\n");
  };

  const enqueueRender = () => {
    const markdown = renderProgress();
    lastRenderQueuedAt = now();
    const controller = currentController;
    const messageId = patchMessageId;
    if (!controller && (!messageId || patchFailed)) return;

    updates = updates
      .then(async () => {
        if (controller && controller === currentController) {
          await controller.setContent(markdown);
          return;
        }
        if (!controller && messageId === patchMessageId && !patchFailed) {
          await channel.updateCard(messageId, buildMarkdownCard(markdown));
        }
      })
      .catch((error) => {
        if (!controller) {
          patchFailed = true;
          log(`same-message card update failed for ${msg.messageId}: ${safeError(error)}`);
        }
      });
  };

  const pushProgress = (update) => {
    if (!update) return;
    const normalized = typeof update === "string"
      ? { kind: "activity", text: update }
      : update;
    if (!normalized.text) return;
    if (normalized.kind === "note") {
      if (notes.at(-1) === normalized.text) return;
      notes.push(normalized.text);
    } else {
      if (activities.at(-1) === normalized.text) return;
      activities.push(normalized.text);
    }
    enqueueRender();
  };

  const startTask = () => {
    if (taskPromise) return taskPromise;
    taskPromise = askCodex(content, pushProgress)
      .then((value) => { answer = value; }, (error) => { taskError = error; })
      .finally(() => { taskDone = true; });
    return taskPromise;
  };

  let streamResult;
  try {
    streamResult = await channel.stream(msg.chatId, {
      markdown: async (controller) => {
        currentController = controller;
        updates = Promise.resolve();
        await controller.setContent(renderProgress());
        lastRenderQueuedAt = now();
        startTask();

        const streamDeadline = now() + streamWindowMs;
        try {
          while (!taskDone) {
            const remaining = streamDeadline - now();
            if (remaining <= 0) break;
            await Promise.race([taskPromise, sleep(Math.min(1000, remaining))]);
            if (!taskDone && now() - lastRenderQueuedAt >= heartbeatMs) enqueueRender();
          }
        } finally {
          currentController = undefined;
          await updates;
        }

        if (taskDone) {
          if (taskError) throw taskError;
          await recordAnswer();
          const summary = activities.slice(-6).join(" → ");
          await controller.setContent(`${answer}\n\n---\n**处理摘要：** ${summary}`);
          return;
        }

        activities.push("原生流式窗口结束，后续将在本卡片内低频更新");
        await controller.setContent(renderProgress());
      },
    }, { replyTo: msg.messageId, replyInThread: Boolean(msg.threadId) });
  } catch (streamError) {
    log(`stream fallback for ${msg.messageId}: ${safeError(streamError)}`);
    if (!taskPromise) startTask();
    await taskPromise;
    if (taskError) throw taskError;
    await recordAnswer();
    await channel.reply(msg, { markdown: answer });
    return answer;
  }

  if (taskDone) return answer;

  patchMessageId = streamResult.messageId;
  try {
    await channel.updateCard(patchMessageId, buildMarkdownCard(renderProgress()));
    log(`switched ${msg.messageId} to same-message card updates after native streaming window`);
  } catch (error) {
    patchFailed = true;
    log(`same-message card transition failed for ${msg.messageId}: ${safeError(error)}`);
  }

  while (!taskDone) {
    await Promise.race([taskPromise, sleep(Math.min(1_000, heartbeatMs))]);
    if (!taskDone && now() - lastRenderQueuedAt >= heartbeatMs) enqueueRender();
  }
  await recordAnswer();
  await updates;
  if (taskError) throw taskError;

  const summary = activities.slice(-6).join(" → ");
  const finalMarkdown = `${answer}\n\n---\n**处理摘要：** ${summary}`;
  if (!patchFailed) {
    try {
      await channel.updateCard(patchMessageId, buildMarkdownCard(finalMarkdown));
      return answer;
    } catch (error) {
      patchFailed = true;
      log(`same-message final card update failed for ${msg.messageId}: ${safeError(error)}`);
    }
  }

  await channel.reply(msg, { markdown: answer });
  return answer;
}
