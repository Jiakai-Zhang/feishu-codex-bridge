import { streamCodexInSingleMessage } from "../feishu/stream-progress.mjs";
import { commandName } from "./command-router.mjs";
import { formatDuration } from "./progress-renderer.mjs";

export function createSessionTurnOrchestrator({
  config,
  channel,
  executor,
  activeWorks,
  setLastWork,
  updateActiveWork,
  deliveryOutbox,
  log,
  handleCommand,
  projectContext,
  getThread,
  replyCommand,
  audit,
  persistCompleted,
  retryPendingDeliveries,
  safeError,
  safeErrorCode,
}) {
  async function streamCodex(msg, content, targetThreadId, work) {
    // Feishu disables native streaming_mode after ten minutes. End it early,
    // then PATCH the same message as a regular card so long tasks neither freeze
    // nor create a new continuation card every eight minutes.
    const configuredSegmentMs = Number(config.streamSegmentMs) || 480_000;
    const segmentMs = Math.min(540_000, Math.max(60_000, configuredSegmentMs));
    return streamCodexInSingleMessage({
      channel,
      msg,
      content,
      askCodex: async (prompt, onProgress) => {
        const answer = await executor.runTurn(prompt, (update) => {
          updateActiveWork(work, update);
          onProgress?.(update);
        }, targetThreadId);
        if (work) {
          work.phase = "正在回传最终结果";
          work.lastUpdate = "Codex 已完成，正在更新飞书消息";
          work.lastUpdateAt = Date.now();
        }
        return answer;
      },
      onAnswerReady: (answer) => deliveryOutbox.put({
        messageId: msg.messageId,
        chatId: msg.chatId,
        threadId: msg.threadId,
        markdown: answer,
        createdAt: Date.now(),
      }),
      log,
      streamWindowMs: segmentMs,
    });
  }

  async function processMessage(msg, content, targetThreadId, work) {
    const messageStartedAt = Date.now();
    log(`accepted ${msg.messageId}`);

    try {
      if (await handleCommand(msg, content)) return true;
      const projectSnapshot = await projectContext.refresh();
      const targetThread = getThread(targetThreadId);
      const scopedThread = await projectContext.validateThread(targetThread, projectSnapshot);
      if (!scopedThread) {
        await replyCommand(msg, [
          `当前没有选中 Project **${config.project.name}** 内的 Codex 任务。`,
          "",
          "发送 `/threads` 选择已有任务，或发送 `/new` 在默认 worktree 中创建任务。需要修改代码时建议使用 `/new --branch task/<ID> <主题>`。",
        ].join("\n"));
        return true;
      }
      await audit("turn.started", `human:${msg.senderId}`, {
        details: { messageId: msg.messageId, threadId: scopedThread.id, branch: scopedThread.worktree.branch, executorType: executor.type },
      });
      await streamCodex(msg, content, targetThreadId, work);
      await audit("turn.completed", `agent:${config.agent.id}`, {
        details: { messageId: msg.messageId, threadId: scopedThread.id, branch: scopedThread.worktree.branch, executorType: executor.type },
      });
      await deliveryOutbox.remove(msg.messageId);
      await persistCompleted(msg.messageId);
      try {
        await channel.reply(msg, {
          text: `✅ Codex 任务已完成（用时 ${formatDuration(Date.now() - messageStartedAt)}），请查看上一条结果。`,
        });
        log(`completion notice sent for ${msg.messageId}`);
      } catch (noticeError) {
        log(`completion notice failed for ${msg.messageId}: ${safeError(noticeError)}`);
      }
      log(`completed ${msg.messageId}`);
      return true;
    } catch (error) {
      log(`failed ${msg.messageId}: ${safeError(error)}`);
      await audit("message.failed", `agent:${config.agent.id}`, {
        details: { messageId: msg.messageId, errorCode: safeErrorCode(error) },
      }).catch((auditError) => log(`message failure audit failed: ${safeError(auditError)}`));
      if (deliveryOutbox.has(msg.messageId)) {
        log(`result delivery deferred for ${msg.messageId}; background retry will not call Codex again`);
        void retryPendingDeliveries();
        return false;
      }
      try {
        await channel.reply(msg, { text: "Codex 暂时无法处理这条消息。请确认桌面端任务没有正在运行，然后稍后重试。" });
      } catch (replyError) {
        log(`error reply failed for ${msg.messageId}: ${safeError(replyError)}`);
      }
      return false;
    }
  }

  async function processQueuedMessage(msg, content, targetThreadId) {
    const startedAt = Date.now();
    const command = commandName(content);
    const work = {
      messageId: msg.messageId,
      threadId: targetThreadId,
      startedAt,
      phase: command.startsWith("/") ? `正在执行 ${command}` : "正在启动 Codex",
      lastUpdate: "消息已从等待队列取出",
      lastUpdateAt: startedAt,
    };
    activeWorks.set(targetThreadId, work);
    let ok = false;
    try {
      ok = await processMessage(msg, content, targetThreadId, work);
    } finally {
      setLastWork({ messageId: msg.messageId, finishedAt: Date.now(), ok });
      if (activeWorks.get(targetThreadId) === work) activeWorks.delete(targetThreadId);
    }
  }

  return { processMessage, processQueuedMessage };
}
