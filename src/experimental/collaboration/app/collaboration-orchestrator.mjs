import path from "node:path";
import {
  createAgentEvent,
  decodeAgentEvent,
  encodeAgentEvent,
  validateIncomingAgentEvent,
} from "../protocol/agent-protocol.mjs";
import { buildLandingPlan, effectiveReceiveMode, resolveLandingChoice } from "../git/collaboration-landing.mjs";
import { buildTaskLandingMarkdown } from "../commands/team-task-commands.mjs";
import { buildPeerControlReply, parsePeerControlMessage } from "../commands/team-commands.mjs";
import { sanitizeProgressNote } from "./progress-renderer.mjs";

export function createCollaborationOrchestrator({
  config, channel, agentEventOutbox, audit, log, safeError, safeErrorCode,
  collaborationGit, projectContext, getThread, collaborationInbox,
  teamTaskStore, enqueueWork, taskLeaseStore, executor, selectThread,
  replyCommand, listProjectThreads, isChannelConnected,
}) {
  const collaborationInboxInFlight = new Set();

  function trustedPeer(agentId) {
    return config.collaboration.trustedPeers.find((peer) => (
      peer.enabled
      && peer.agentId === agentId
    ));
  }

  function requireTaskApprover(openId, task, { allowRequester = false } = {}) {
    if (config.collaboration.approverOpenIds.includes(openId)) return;
    if (allowRequester && task?.requesterHumanOpenId === openId) return;
    throw new Error("该操作只允许配置的协作审批者执行");
  }

  function eventForTask(task, kind, payload) {
    return createAgentEvent({
      kind,
      taskId: task.taskId,
      groupChatId: task.groupChatId,
      githubRepository: task.githubRepository,
      fromAgentId: config.agent.id,
      toAgentId: task.peerAgentId,
      requesterAgentId: task.requesterAgentId,
      executorAgentId: task.executorAgentId,
      payload,
    }, { ttlMs: config.collaboration.eventTtlMs });
  }

  async function deliverAgentEventRecord(record) {
    const peer = trustedPeer(record.peerAgentId);
    if (!peer?.botOpenId) throw new Error("Trusted peer Bot identity is unavailable");
    if (record.chatId !== config.collaboration.groupChatId) throw new Error("Agent event target is not the bound collaboration group");
    // The authenticated wire must be a text message. Markdown is emitted as a
    // Feishu post and the router deliberately rejects non-text Bot messages.
    await channel.send(record.chatId, { text: encodeAgentEvent(record.event) }, {
      mentions: [{ key: "peer", openId: peer.botOpenId, name: peer.displayName, isBot: true }],
    });
  }

  function agentEventNoticeMarkdown(event, peer) {
    const common = [
      `## Agent 协作 · ${event.kind}`,
      "",
      `- 对方：${peer.humanDisplayName} + ${peer.displayName}`,
      `- 任务：\`${event.taskId}\``,
      `- 仓库：\`${event.githubRepository}\``,
    ];
    if (event.kind === "task.request") {
      common.push(
        `- 标题：${sanitizeProgressNote(event.payload.title, 160)}`,
        `- Git：\`${event.payload.git.branch}@${event.payload.git.commit.slice(0, 12)}\``,
        `- 接收模式：\`${event.payload.receiveMode}\``,
        "",
        sanitizeProgressNote(event.payload.prompt, 2_000),
      );
    } else if (event.kind === "task.result") {
      common.push(
        `- Git：\`${event.payload.git.branch}@${event.payload.git.commit.slice(0, 12)}\``,
        "",
        sanitizeProgressNote(event.payload.summary, 2_000),
      );
    } else if (event.payload?.reason) {
      common.push("", sanitizeProgressNote(event.payload.reason, 1_000));
    } else if (event.payload?.message) {
      common.push("", sanitizeProgressNote(event.payload.message, 1_000));
    }
    return common.join("\n");
  }

  async function announceAgentEvent(peer, chatId, event) {
    if (!new Set(["task.request", "task.result", "task.blocked", "task.rejected"]).has(event.kind)) return;
    await channel.send(chatId, { markdown: agentEventNoticeMarkdown(event, peer) }, {
      mentions: [
        { key: "human", openId: peer.humanOpenId, name: peer.humanDisplayName },
        { key: "bot", openId: peer.botOpenId, name: peer.displayName, isBot: true },
      ],
    });
  }

  async function sendAgentEvent(peer, chatId, event, { announce = true } = {}) {
    const record = {
      peerAgentId: peer.agentId,
      chatId,
      event,
      createdAt: Date.now(),
    };
    await agentEventOutbox.put(record);
    try {
      if (announce) {
        await announceAgentEvent(peer, chatId, event).catch((error) => {
          log(`Agent event public notice failed for ${event.eventId}: ${safeError(error)}`);
        });
      }
      await deliverAgentEventRecord(record);
      await agentEventOutbox.remove(event.eventId);
      await audit("agent_event.delivered", `agent:${config.agent.id}`, {
        taskId: event.taskId,
        details: { eventId: event.eventId, kind: event.kind, peerAgentId: peer.agentId },
      });
      return true;
    } catch (error) {
      await agentEventOutbox.markFailure(event.eventId, error);
      await audit("agent_event.queued", `agent:${config.agent.id}`, {
        taskId: event.taskId,
        details: { eventId: event.eventId, kind: event.kind, peerAgentId: peer.agentId, errorCode: safeErrorCode(error) },
      });
      log(`Agent event ${event.eventId} queued for retry: ${safeError(error)}`);
      return false;
    }
  }

  async function sendTaskEvent(task, kind, payload) {
    const peer = trustedPeer(task.peerAgentId);
    if (!peer) throw new Error(`Trusted peer ${task.peerAgentId} is unavailable in the bound collaboration group`);
    const event = eventForTask(task, kind, payload);
    const delivered = await sendAgentEvent(peer, task.chatId || config.collaboration.groupChatId, event);
    return { event, delivered };
  }

  async function validateLocalCollaborationRequest(request) {
    if (!config.collaboration.enabled || !collaborationGit) throw new Error("Collaboration is disabled for this Bridge Project");
    if (request.source.agentId !== config.agent.id) throw new Error("Collaboration request source Agent does not match this Bridge");
    if (request.source.projectId !== config.project.id) throw new Error("Collaboration request source Project does not match this machine");
    if (request.source.groupChatId !== config.collaboration.groupChatId) throw new Error("Collaboration request group does not match this Project binding");
    if (request.source.githubRepository !== config.collaboration.githubRepository) throw new Error("Collaboration request repository does not match this Project binding");
    if (request.source.remote !== config.collaboration.remote) throw new Error("Collaboration request remote does not match this Project binding");
    const peer = trustedPeer(request.action.peerAgentId);
    if (!peer) throw new Error(`Agent ${request.action.peerAgentId} is not a trusted member of this collaboration group`);
    if (request.action.resultMode === "resume" && !request.source.threadId) {
      throw new Error("resultMode resume requires a source Codex task");
    }
    if (request.source.threadId) {
      const snapshot = await projectContext.refresh();
      const sourceThread = await projectContext.validateThread(getThread(request.source.threadId), snapshot);
      if (!sourceThread || sourceThread.worktree.branch !== request.source.branch) {
        throw new Error("Source Codex task is outside this Project or no longer matches the handoff branch");
      }
    }
    return peer;
  }

  async function dispatchCollaborationRequest(request, {
    requesterHumanOpenId = config.agent.ownerOpenId,
    taskId = `task:${request.requestId.slice("req:".length)}`,
  } = {}) {
    const peer = await validateLocalCollaborationRequest(request);
    const git = await collaborationGit.publishRequest(request);
    let task = teamTaskStore.get(taskId);
    let event;
    let delivered;
    if (!task) {
      event = createAgentEvent({
        kind: "task.request",
        taskId,
        groupChatId: config.collaboration.groupChatId,
        githubRepository: config.collaboration.githubRepository,
        fromAgentId: config.agent.id,
        toAgentId: peer.agentId,
        requesterAgentId: config.agent.id,
        executorAgentId: peer.agentId,
        payload: {
          title: request.action.title,
          prompt: request.action.prompt,
          receiveMode: request.action.receiveMode,
          resultMode: request.action.resultMode,
          git,
        },
      }, { ttlMs: config.collaboration.eventTtlMs });
      task = await teamTaskStore.createOutboundRequest(event, {
        peer,
        chatId: config.collaboration.groupChatId,
        requesterHumanOpenId,
        sourceThreadId: request.source.threadId,
        localProjectId: config.project.id,
      });
      delivered = await sendAgentEvent(peer, config.collaboration.groupChatId, event);
    } else {
      if (task.direction !== "outbound" || task.peerAgentId !== peer.agentId
        || task.prompt !== request.action.prompt || task.branch !== git.branch
        || task.requestGit?.commit !== git.commit || task.githubRepository !== config.collaboration.githubRepository) {
        throw new Error(`Existing task ${taskId} does not match this collaboration request`);
      }
      ({ event, delivered } = await sendTaskEvent(task, "task.request", {
        title: task.title,
        prompt: task.prompt,
        receiveMode: task.receiveMode,
        resultMode: task.resultMode,
        git: task.requestGit,
      }));
    }
    await audit("task.delegated", `agent:${config.agent.id}`, {
      taskId: task.taskId,
      details: {
        peerAgentId: task.peerAgentId,
        branch: task.branch,
        commit: task.requestGit.commit,
        delivered,
      },
    });
    return { task, event, delivered };
  }

  function requestIdFromInboxPath(filePath) {
    const match = path.basename(filePath).match(/^req_([0-9a-f-]{36})\.json$/i);
    return match ? `req:${match[1]}` : undefined;
  }

  async function processCollaborationInboxRecord(record) {
    const requestId = record.request?.requestId || requestIdFromInboxPath(record.filePath);
    if (!requestId) {
      log(`ignored collaboration inbox file with an invalid name`);
      return;
    }
    if (record.error) {
      await collaborationInbox.finish(record.filePath, requestId, {
        ok: false,
        status: "blocked",
        error: "Bridge rejected an invalid or expired collaboration request; inspect /audit.",
        errorCode: record.error.name || "validation_error",
      });
      await audit("collaboration_request.rejected", `agent:${config.agent.id}`, {
        details: { requestId, errorCode: record.error.name || "validation_error" },
      });
      return;
    }
    try {
      const { task, event, delivered } = await dispatchCollaborationRequest(record.request);
      await collaborationInbox.finish(record.filePath, requestId, {
        ok: true,
        status: delivered ? "delivered" : "queued",
        taskId: task.taskId,
        eventId: event.eventId,
        git: task.requestGit,
      });
    } catch (error) {
      await collaborationInbox.finish(record.filePath, requestId, {
        ok: false,
        status: "blocked",
        error: "Bridge blocked the collaboration request; inspect /audit for the local reason.",
        errorCode: safeErrorCode(error),
      });
      await audit("collaboration_request.blocked", `agent:${config.agent.id}`, {
        details: { requestId, errorCode: safeErrorCode(error) },
      });
      log(`collaboration request ${requestId} blocked: ${safeError(error)}`);
    }
  }

  async function scanCollaborationInbox() {
    if (!isChannelConnected() || !collaborationInbox) return;
    const pending = await collaborationInbox.list();
    for (const record of pending) {
      if (collaborationInboxInFlight.has(record.filePath)) continue;
      collaborationInboxInFlight.add(record.filePath);
      void enqueueWork(async () => {
        try { await processCollaborationInboxRecord(record); }
        finally { collaborationInboxInFlight.delete(record.filePath); }
      });
    }
  }

  let agentEventRetryInFlight = false;

  async function retryPendingAgentEvents() {
    if (!isChannelConnected() || agentEventRetryInFlight) return;
    agentEventRetryInFlight = true;
    try {
      for (const record of agentEventOutbox.list({ dueAt: Date.now() })) {
        if (Number.isFinite(record.event.expiresAt) && record.event.expiresAt <= Date.now()) {
          await agentEventOutbox.remove(record.eventId);
          await audit("agent_event.expired", `agent:${config.agent.id}`, {
            taskId: record.event.taskId,
            details: { eventId: record.eventId, kind: record.event.kind, peerAgentId: record.peerAgentId },
          });
          continue;
        }
        try {
          await deliverAgentEventRecord(record);
          await agentEventOutbox.remove(record.eventId);
          await audit("agent_event.retry_delivered", `agent:${config.agent.id}`, {
            taskId: record.event.taskId,
            details: { eventId: record.eventId, kind: record.event.kind, peerAgentId: record.peerAgentId, attempts: record.attempts },
          });
        } catch (error) {
          await agentEventOutbox.markFailure(record.eventId, error);
          log(`Agent event retry failed for ${record.eventId}: ${safeError(error)}`);
        }
      }
    } finally {
      agentEventRetryInFlight = false;
    }
  }

  async function landingPlanForTask(task, { persist = true } = {}) {
    if (!task || task.direction !== "inbound") throw new Error("Unknown inbound collaboration task");
    const snapshot = await projectContext.refresh();
    const threads = await listProjectThreads({ branch: task.branch, snapshot, limit: 100 });
    const plan = buildLandingPlan({ branch: task.branch, threads, snapshot });
    const mode = effectiveReceiveMode(task.receiveMode, config.collaboration.receiveMode);
    if (persist && new Set(["pending", "blocked"]).has(task.state)) {
      await teamTaskStore.setLandingRecommendation(task.taskId, plan.recommendation);
    }
    return { plan, mode };
  }

  async function executeInboundTask(taskId, {
    commandMessage,
    approvedByOpenId,
    landingChoice = "auto",
  } = {}) {
    let task = teamTaskStore.get(taskId);
    let leaseAcquired = false;
    if (!task || task.direction !== "inbound") throw new Error(`Unknown inbound task ${taskId}`);
    if (approvedByOpenId !== "auto") requireTaskApprover(approvedByOpenId, task);
    try {
      if (task.state === "pending" || task.state === "blocked") {
        const { plan } = await landingPlanForTask(task);
        const landing = resolveLandingChoice(plan, landingChoice);
        task = await teamTaskStore.acceptInbound(taskId, approvedByOpenId || "auto", {
          landing: landing.landing,
          targetThreadId: landing.threadId,
        });
      } else if (task.state !== "accepted") {
        throw new Error(`Task ${taskId} cannot be executed from ${task.state}`);
      }
      await audit("task.accepted", approvedByOpenId === "auto" ? `agent:${config.agent.id}` : `human:${approvedByOpenId}`, {
        taskId: task.taskId,
        details: { peerAgentId: task.peerAgentId, branch: task.branch, autoAccepted: approvedByOpenId === "auto" },
      });
      await taskLeaseStore.acquire({
        projectId: config.project.id,
        branch: task.branch,
        taskId: task.taskId,
        ownerAgentId: config.agent.id,
        leaseMs: config.collaboration.taskLeaseMs,
      });
      leaseAcquired = true;
      await audit("task.lease_acquired", `agent:${config.agent.id}`, {
        taskId: task.taskId,
        details: { branch: task.branch, leaseMs: config.collaboration.taskLeaseMs },
      });
      if (commandMessage) {
        await channel.reply(commandMessage, {
          markdown: `⏳ 已审批协作任务 \`${task.taskId}\`，正在同步 \`${task.githubRepository}:${task.branch}\` 并准备本地 Codex 落点。`,
        });
      }

      if (!collaborationGit) throw new Error("Collaboration Git handoff is unavailable");
      const worktree = await collaborationGit.prepareIncoming(task.requestGit);
      let thread;
      if (task.landing === "existing-thread") {
        thread = getThread(task.targetThreadId);
        const scoped = await projectContext.validateThread(thread, await projectContext.refresh());
        if (!scoped || scoped.worktree.branch !== task.branch) {
          throw new Error("Selected existing Codex task is no longer bound to the collaboration branch");
        }
      } else {
        thread = await executor.createThread(`[peer:${task.peerAgentId}] ${task.title}`, undefined, worktree.path);
      }
      const scopedThread = await selectThread(thread, await projectContext.refresh());
      task = await teamTaskStore.markRunning(task.taskId, {
        threadId: thread.id,
        worktree: scopedThread.worktree.path,
        branch: scopedThread.worktree.branch,
        landing: task.landing,
      });
      await audit("task.started", `agent:${config.agent.id}`, {
        taskId: task.taskId,
        details: { peerAgentId: task.peerAgentId, branch: task.branch, executorType: executor.type },
      });
      await sendTaskEvent(task, "task.accepted", {
        message: "accepted by the local Bridge",
        landing: task.landing,
      });
      await sendTaskEvent(task, "task.progress", { message: "Codex task started at the selected local Project landing" });

      const prompt = [
        `你正在执行一个经过本地审批的 Agent 协作任务。`,
        `请求 Agent：${task.requesterAgentId}`,
        `执行 Agent：${task.executorAgentId}`,
        `共享 GitHub 仓库：${task.githubRepository}`,
        `起始 Git：${task.requestGit.branch}@${task.requestGit.commit}`,
        `本机 Bridge Project：${config.project.id}`,
        `任务 ID：${task.taskId}`,
        "",
        "只在当前 Project/worktree 权限边界内完成任务并验证。不要修改任务协议字段或绕过审批状态。完成前只提交本任务需要的改动，并确保 worktree 干净；Bridge 会以非 force push 同步结果。不得把 App Secret、凭据、本机路径或本机 Codex task ID 写入提交。",
        "",
        task.prompt,
      ].join("\n");
      const answer = await executor.runTurn(prompt, (update) => updateActiveWork(update));
      const summary = String(answer || "任务完成，但 Codex 未返回文本结果。").slice(0, 12_000);
      const resultGit = await collaborationGit.publishResult({
        cwd: task.localWorktree,
        branch: task.localBranch,
      });
      task = await teamTaskStore.markCompleted(task.taskId, summary, { git: resultGit });
      await audit("task.completed", `agent:${config.agent.id}`, {
        taskId: task.taskId,
        details: { peerAgentId: task.peerAgentId, branch: task.branch, executorType: executor.type },
      });
      await sendTaskEvent(task, "task.result", { summary, git: task.resultGit });
      const doneMarkdown = [
        `## 协作任务已完成`,
        "",
        `- 任务：\`${task.taskId}\``,
        `- peer：\`${task.peerAgentId}\``,
        `- Git：\`${task.resultGit.branch}@${task.resultGit.commit.slice(0, 12)}\``,
        "- 状态：等待请求方审批结果",
      ].join("\n");
      if (commandMessage) await replyCommand(commandMessage, doneMarkdown);
      else await channel.send(task.chatId, { markdown: doneMarkdown });
      return true;
    } catch (error) {
      const latest = teamTaskStore.get(taskId);
      const peerReason = "本地执行未完成；请由本地审批者检查 Bridge 状态后决定是否重试。";
      if (latest && new Set(["accepted", "running"]).has(latest.state)) {
        task = await teamTaskStore.markBlocked(taskId, peerReason);
        await audit("task.blocked", `agent:${config.agent.id}`, {
          taskId: task.taskId,
          details: { peerAgentId: task.peerAgentId, branch: task.branch, errorCode: safeErrorCode(error) },
        });
        await sendTaskEvent(task, "task.blocked", { reason: peerReason }).catch((sendError) => {
          log(`failed to notify peer about blocked task ${taskId}: ${safeError(sendError)}`);
        });
      }
      if (commandMessage) {
        await replyCommand(commandMessage, `协作任务 \`${taskId}\` 被本地安全检查阻塞（\`${safeErrorCode(error)}\`）。请使用 \`/audit\` 在本机核对原因；不会向 peer 发送本机路径或凭据。`);
        return false;
      }
      log(`auto-accepted team task ${taskId} failed: ${safeError(error)}`);
      return false;
    } finally {
      if (leaseAcquired) {
        const released = await taskLeaseStore.release({
          projectId: config.project.id,
          branch: task.branch,
          taskId: task.taskId,
        });
        if (released) await audit("task.lease_released", `agent:${config.agent.id}`, {
          taskId: task.taskId,
          details: { branch: task.branch },
        });
      }
    }
  }

  async function resumeOutboundResult(task) {
    if (!collaborationGit) throw new Error("Collaboration Git handoff is unavailable");
    if (task.direction !== "outbound" || task.state !== "completed" || task.resultMode !== "resume") {
      throw new Error(`Task ${task.taskId} is not an outbound resumable result`);
    }
    if (!task.sourceThreadId) throw new Error("The collaboration request has no local source Codex task");
    await collaborationGit.prepareIncoming(task.resultGit);
    const sourceThread = getThread(task.sourceThreadId);
    const scopedThread = await projectContext.validateThread(sourceThread, await projectContext.refresh());
    if (!scopedThread || scopedThread.worktree.branch !== task.resultGit.branch) {
      throw new Error("The source Codex task no longer matches the returned Git branch");
    }
    await selectThread(sourceThread);
    const prompt = [
      "对方 Agent 已完成你委派的协作任务，Bridge 已将返回分支 fast-forward 到当前干净 worktree。",
      `协作任务：${task.taskId}`,
      `对方 Agent：${task.peerAgentId}`,
      `共享 GitHub 仓库：${task.githubRepository}`,
      `返回 Git：${task.resultGit.branch}@${task.resultGit.commit}`,
      "",
      "请结合当前对话历史、返回提交和下面的对方总结检查结果，并自然决定下一步。不要假设对方的本机 Project、worktree 路径或 Codex task ID。若还需对方处理，可继续使用本 Project 的 Feishu Agent Collaboration Skill。",
      "",
      task.result,
    ].join("\n");
    const answer = await executor.runTurn(prompt, (update) => updateActiveWork(update));
    const markdown = [
      "## 原请求 Agent 已继续处理协作结果",
      "",
      `- 任务：\`${task.taskId}\``,
      `- Git：\`${task.resultGit.branch}@${task.resultGit.commit.slice(0, 12)}\``,
      "",
      String(answer || "Agent 已接收结果，但没有返回文本总结。").slice(0, config.maxReplyChars),
    ].join("\n");
    await channel.send(task.groupChatId, { markdown }, {
      mentions: [{ key: "requester", openId: task.requesterHumanOpenId, name: "请求者" }],
    });
    await audit("task.result_resumed", `agent:${config.agent.id}`, {
      taskId: task.taskId,
      details: { peerAgentId: task.peerAgentId, branch: task.resultGit.branch, commit: task.resultGit.commit },
    });
  }

  function inboundEventMarkdown(event, task) {
    const labels = {
      "task.request": "收到新的 Git 协作任务",
      "task.accepted": "peer 已接单",
      "task.progress": `peer 进度：${event.payload.message}`,
      "task.result": "peer 已返回结果，等待请求者或审批者确认",
      "task.blocked": `peer 阻塞：${event.payload.reason}`,
      "task.rejected": `peer 已拒绝：${event.payload.reason}`,
      "task.approved": "请求方已批准结果",
    };
    return [
      `## ${labels[event.kind]}`,
      "",
      `- 任务：\`${task.taskId}\``,
      `- requester：\`${task.requesterAgentId}\``,
      `- executor：\`${task.executorAgentId}\``,
      `- 仓库：\`${task.githubRepository}\``,
      `- Git：\`${(event.payload.git || task.requestGit || task.resultGit)?.branch || task.branch}@${((event.payload.git || task.requestGit || task.resultGit)?.commit || "unknown").slice(0, 12)}\``,
    ].join("\n");
  }

  async function processPeerControlMessage(msg, route, content) {
    if (content.startsWith("/agent-event")) {
      const decoded = decodeAgentEvent(content);
      const event = validateIncomingAgentEvent(decoded, { config, peer: route.peer, chatId: msg.chatId });
      const recorded = await teamTaskStore.recordInboundEvent(event, {
        peer: route.peer,
        chatId: msg.chatId,
        localProjectId: config.project.id,
      });
      if (recorded.duplicate) {
        log(`duplicate Agent event ${event.eventId} ignored for ${event.taskId}`);
        await audit("agent_event.duplicate", `peer:${route.peer.agentId}`, {
          taskId: event.taskId,
          details: { eventId: event.eventId, kind: event.kind },
        });
        return true;
      }
      await audit("agent_event.accepted", `peer:${route.peer.agentId}`, {
        taskId: event.taskId,
        details: { eventId: event.eventId, kind: event.kind, chatId: msg.chatId },
      });
      if (event.kind === "task.request") {
        const current = teamTaskStore.get(event.taskId);
        const { plan, mode } = await landingPlanForTask(current);
        await replyCommand(msg, buildTaskLandingMarkdown(current, plan, mode));
        if (mode === "auto") {
          void enqueueWork(() => executeInboundTask(event.taskId, {
            approvedByOpenId: "auto",
            landingChoice: "auto",
          }));
        }
        log(`Agent task request accepted from ${route.peer.agentId} for ${event.taskId} in ${mode} mode`);
        return true;
      }
      await replyCommand(msg, inboundEventMarkdown(event, recorded.task));
      if (event.kind === "task.result" && recorded.task.resultMode === "resume") {
        void enqueueWork(async () => {
          try { await resumeOutboundResult(teamTaskStore.get(event.taskId)); }
          catch (error) {
            await audit("task.result_resume_blocked", `agent:${config.agent.id}`, {
              taskId: event.taskId,
              details: { errorCode: safeErrorCode(error) },
            });
            await channel.send(msg.chatId, {
              markdown: `协作结果已收到，但自动继续被本地安全检查阻塞。请查看 \`/team-tasks\` 和 \`/audit\` 后人工处理。`,
            }, {
              mentions: [{ key: "requester", openId: recorded.task.requesterHumanOpenId, name: "请求者" }],
            });
            log(`task result resume blocked for ${event.taskId}: ${safeError(error)}`);
          }
        });
      }
      log(`Agent event ${event.kind} accepted from ${route.peer.agentId} for ${event.taskId}`);
      return true;
    }
    const request = parsePeerControlMessage(content);
    if (request.error) {
      log(`peer control ${msg.messageId} rejected: ${request.error}`);
      return false;
    }
    if (request.githubRepository !== config.collaboration.githubRepository) {
      log(`peer control ${msg.messageId} rejected: repository_mismatch`);
      return false;
    }
    await replyCommand(msg, buildPeerControlReply(config, route.peer, request));
    await audit("peer_control.accepted", `peer:${route.peer.agentId}`, {
      details: { action: request.action, requestId: request.requestId },
    });
    log(`peer control ${request.action} accepted from ${route.peer.agentId} for ${config.project.id}`);
    return true;
  }


  return {
    trustedPeer,
    requireTaskApprover,
    sendTaskEvent,
    dispatchCollaborationRequest,
    scanCollaborationInbox,
    retryPendingAgentEvents,
    landingPlanForTask,
    executeInboundTask,
    processPeerControlMessage,
  };
}
