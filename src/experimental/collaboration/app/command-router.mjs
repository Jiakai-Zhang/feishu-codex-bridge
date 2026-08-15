import { randomUUID } from "node:crypto";
import { buildCapacityMarkdown, buildModelMarkdown } from "../codex/codex-status.mjs";
import { inspectDesktopProject } from "../codex/desktop-project-state.mjs";
import { buildKnowledgeArtifactMarkdown, buildKnowledgeListMarkdown, parseKnowledgeCommand } from "../commands/knowledge-commands.mjs";
import { buildAuditMarkdown, buildMetricsMarkdown, parseAuditLimit } from "../commands/operational-commands.mjs";
import {
  buildBranchesMarkdown,
  buildProjectMarkdown,
  buildProjectThreadsMarkdown,
  buildWorktreesMarkdown,
  parseNewCommandArgument,
  parseThreadsCommandArgument,
} from "../commands/project-commands.mjs";
import { buildTeamMarkdown } from "../commands/team-commands.mjs";
import {
  buildTaskLandingMarkdown,
  buildTeamTasksMarkdown,
  parseDelegateArgument,
  parseTaskAcceptArgument,
  parseTaskActionArgument,
} from "../commands/team-task-commands.mjs";
import { compactTitle } from "./progress-renderer.mjs";

export function commandName(content) {
  const trimmed = String(content || "").trim();
  const separator = trimmed.search(/\s/);
  return separator < 0 ? trimmed : trimmed.slice(0, separator);
}

export const immediateCommands = new Set([
  "/status", "/model", "/capacity", "/quota", "/current", "/project", "/branches", "/worktrees", "/threads", "/team", "/team-tasks", "/team-options", "/audit", "/metrics", "/help",
  "/chat", "/endchat", "/end",
]);

export function createCommandRouter({
  config, projectContext, codexHome, channel, audit, auditLog, teamTaskStore,
  knowledgeHub, deliveryOutbox, agentEventOutbox, taskLeaseStore, executor,
  getChannelConnected, getQueuedWorkCount, getConnectedBotOpenId,
  getActiveThreadId, getTemporaryChat, getThread, listProjectThreads,
  activeProjectThread, getThreadSnapshot, buildStatusMarkdown, buildCurrentMarkdown,
  replyCommand, landingPlanForTask,
  requireTaskApprover, trustedPeer, normalizeCwd, dispatchCollaborationRequest,
  executeInboundTask, sendTaskEvent, selectThread, persistCompleted, log,
  startTemporaryChat, endTemporaryChat,
}) {
  const threadListSelections = new Map();

  function threadListKey(msg) {
    return `${msg.chatId}:${msg.senderId}`;
  }
  
  function rememberThreadList(msg, threads) {
    threadListSelections.set(threadListKey(msg), {
      threadIds: threads.map(({ id }) => id),
      expiresAt: Date.now() + 30 * 60_000,
    });
    if (threadListSelections.size > 100) {
      const oldest = threadListSelections.keys().next().value;
      threadListSelections.delete(oldest);
    }
  }
  
  async function selectedThreadFromList(msg, index) {
    const cached = threadListSelections.get(threadListKey(msg));
    if (cached?.expiresAt > Date.now()) return getThread(cached.threadIds[index]);
    return (await listProjectThreads())[index];
  }
  
  async function handleCommand(msg, content) {
    const trimmed = content.trim();
    const separator = trimmed.search(/\s/);
    const command = separator < 0 ? trimmed : trimmed.slice(0, separator);
    const argument = separator < 0 ? "" : trimmed.slice(separator).trim();
    if (command === "/chat") {
      await startTemporaryChat(msg, argument);
      return true;
    }
    if (command === "/endchat" || command === "/end") {
      await endTemporaryChat(msg);
      return true;
    }
    if (command === "/threads") {
      const filter = parseThreadsCommandArgument(argument);
      if (filter.error) {
        await replyCommand(msg, filter.error);
        return true;
      }
      const snapshot = await projectContext.refresh();
      const threads = await listProjectThreads({ branch: filter.branch, snapshot });
      rememberThreadList(msg, threads);
      await replyCommand(msg, buildProjectThreadsMarkdown(threads, filter));
      return true;
    }
    if (command === "/status") {
      const thread = getThread(getActiveThreadId());
      const [rolloutSnapshot, projectSnapshot] = await Promise.all([
        getThreadSnapshot(thread),
        projectContext.refresh(),
      ]);
      const scopedThread = await projectContext.validateThread(thread, projectSnapshot);
      await replyCommand(msg, buildStatusMarkdown(thread, rolloutSnapshot, scopedThread));
      return true;
    }
    if (command === "/audit") {
      const limit = parseAuditLimit(argument);
      await replyCommand(msg, limit
        ? buildAuditMarkdown(auditLog.tail(limit), auditLog.headHash())
        : "用法：`/audit [1-100]`"
      );
      return true;
    }
    if (command === "/metrics") {
      const tasks = teamTaskStore.list({ limit: 500 });
      const taskStates = tasks.reduce((counts, task) => ({
        ...counts,
        [task.state]: (counts[task.state] || 0) + 1,
      }), {});
      const knowledgeCount = knowledgeHub ? (await knowledgeHub.list()).length : 0;
      await replyCommand(msg, buildMetricsMarkdown({
        channelConnected: getChannelConnected(),
        queuedWorkCount: getQueuedWorkCount(),
        deliveryOutboxSize: deliveryOutbox.size(),
        agentEventOutboxSize: agentEventOutbox.size(),
        teamTaskCount: tasks.length,
        taskStates,
        knowledgeCount,
        auditCount: auditLog.size(),
        auditHead: auditLog.headHash(),
        taskLeaseCount: taskLeaseStore.list().length,
        executorType: executor.type,
        executorCapabilities: executor.capabilities,
      }));
      return true;
    }
    if (command === "/model") {
      const thread = getThread(getActiveThreadId());
      const scopedThread = await projectContext.validateThread(thread, await projectContext.refresh());
      await replyCommand(msg, scopedThread
        ? buildModelMarkdown(thread)
        : "当前没有选中 Project 内的 Codex 任务。请先使用 `/threads`、`/use` 或 `/new`。"
      );
      return true;
    }
    if (command === "/capacity" || command === "/quota") {
      const thread = getThread(getActiveThreadId());
      const scopedThread = await projectContext.validateThread(thread, await projectContext.refresh());
      await replyCommand(msg, scopedThread
        ? buildCapacityMarkdown(await getThreadSnapshot(thread))
        : "当前没有选中 Project 内的 Codex 任务。请先使用 `/threads`、`/use` 或 `/new`。"
      );
      return true;
    }
    if (command === "/current") {
      const thread = getThread(getActiveThreadId());
      const projectSnapshot = await projectContext.refresh();
      const scopedThread = await projectContext.validateThread(thread, projectSnapshot);
      await replyCommand(msg, buildCurrentMarkdown(thread, await getThreadSnapshot(thread), scopedThread));
      return true;
    }
    if (command === "/project") {
      const snapshot = await projectContext.refresh();
      const [selectedThread, desktopStatus] = await Promise.all([
        activeProjectThread(snapshot),
        inspectDesktopProject(config.project, { codexHome }),
      ]);
      await replyCommand(msg, buildProjectMarkdown(config, snapshot, selectedThread, desktopStatus));
      return true;
    }
    if (command === "/team") {
      await replyCommand(msg, buildTeamMarkdown(config, getConnectedBotOpenId()));
      return true;
    }
    if (command === "/team-tasks") {
      await replyCommand(msg, buildTeamTasksMarkdown(teamTaskStore.list()));
      return true;
    }
    if (command === "/team-options") {
      const request = parseTaskActionArgument(argument);
      if (request.error) {
        await replyCommand(msg, request.error);
        return true;
      }
      const task = teamTaskStore.get(request.taskId);
      requireTaskApprover(msg.senderId, task);
      const { plan, mode } = await landingPlanForTask(task);
      await replyCommand(msg, buildTaskLandingMarkdown(task, plan, mode));
      return true;
    }
    if (command === "/knowledge") {
      if (!knowledgeHub) {
        await replyCommand(msg, "Team Hub 尚未启用。请先配置 `teamHub.enabled=true` 与共享路径。");
        return true;
      }
      const request = parseKnowledgeCommand(argument);
      if (request.error) {
        await replyCommand(msg, request.error);
        return true;
      }
      if (request.action === "list") {
        await replyCommand(msg, buildKnowledgeListMarkdown(await knowledgeHub.list(), config));
        return true;
      }
      if (request.action === "show") {
        await replyCommand(msg, buildKnowledgeArtifactMarkdown(await knowledgeHub.get(request.category, request.id)));
        return true;
      }
      if (!config.teamHub.writerOpenIds.includes(msg.senderId)) {
        await replyCommand(msg, "该成员没有 Team Hub 写入权限；可继续使用 `/knowledge list|show` 只读查看。");
        return true;
      }
      const metadata = request.action === "create"
        ? await knowledgeHub.create({
            category: request.category,
            id: request.id,
            title: request.title,
            content: request.content,
            authorHumanOpenId: msg.senderId,
          })
        : await knowledgeHub.update({
            category: request.category,
            id: request.id,
            content: request.content,
            expectedRevision: request.expectedRevision,
            authorHumanOpenId: msg.senderId,
          });
      await audit(`knowledge.${request.action === "create" ? "created" : "updated"}`, `human:${msg.senderId}`, {
        details: { category: metadata.category, id: metadata.id, revision: metadata.revision, repositoryIds: metadata.repositoryIds },
      });
      await replyCommand(msg, [
        `已${request.action === "create" ? "创建" : "更新"}共享知识：\`${metadata.category}/${metadata.id}\`。`,
        "",
        `revision：\`${metadata.revision}\``,
        "",
        "后续 Codex 回合会在有界上下文中读取该条目；实时任务状态仍与 Team Hub 分离。",
      ].join("\n"));
      return true;
    }
    if (command === "/delegate") {
      if (!config.collaboration.enabled) {
        await replyCommand(msg, "多 Bot 协作尚未启用。请先绑定唯一飞书群、可信成员/Bot 和同一个 GitHub 仓库。");
        return true;
      }
      const request = parseDelegateArgument(argument);
      if (request.error) {
        await replyCommand(msg, request.error);
        return true;
      }
      const peer = trustedPeer(request.peerAgentId);
      if (!peer) {
        await replyCommand(msg, `未找到该协作群中的可信 peer：\`${request.peerAgentId}\``);
        return true;
      }
      const sourceThread = await activeProjectThread();
      if (!sourceThread) throw new Error("No Project Codex task is selected for this delegation");
      if (sourceThread.worktree.branch !== request.branch) {
        throw new Error(`The selected Codex task is on ${sourceThread.worktree.branch}, not ${request.branch}`);
      }
      const head = (await projectContext.git(["rev-parse", "HEAD"], { cwd: normalizeCwd(sourceThread.cwd) })).trim().toLowerCase();
      const now = Date.now();
      const collaborationRequest = {
        schemaVersion: 1,
        requestId: `req:${randomUUID()}`,
        createdAt: now,
        expiresAt: now + config.collaboration.eventTtlMs,
        source: {
          agentId: config.agent.id,
          projectId: config.project.id,
          groupChatId: config.collaboration.groupChatId,
          githubRepository: config.collaboration.githubRepository,
          cwd: normalizeCwd(sourceThread.cwd),
          threadId: sourceThread.id,
          remote: config.collaboration.remote,
          branch: request.branch,
          head,
        },
        action: {
          type: "delegate",
          peerAgentId: request.peerAgentId,
          title: request.title,
          prompt: request.prompt,
          receiveMode: "recommend",
          gitSyncMode: "push",
          resultMode: "resume",
        },
      };
      const { task, delivered: eventDelivered } = await dispatchCollaborationRequest(collaborationRequest, {
        requesterHumanOpenId: msg.senderId,
        taskId: `task:${msg.messageId}`,
      });
      await replyCommand(msg, [
        `已向 **${peer.humanDisplayName} + ${peer.displayName}** 委派任务。`,
        "",
        `- 任务：\`${task.taskId}\``,
        `- 仓库：\`${task.githubRepository}\``,
        `- Git：\`${task.branch}@${task.requestGit.commit.slice(0, 12)}\``,
        `- 状态：${eventDelivered ? "已投递，等待 peer 接单" : "已进入 Agent 事件发件箱，等待自动补发"}`,
      ].join("\n"));
      return true;
    }
    if (command === "/team-accept") {
      const request = parseTaskAcceptArgument(argument);
      if (request.error) {
        await replyCommand(msg, request.error);
        return true;
      }
      await executeInboundTask(request.taskId, {
        commandMessage: msg,
        approvedByOpenId: msg.senderId,
        landingChoice: request.choice,
      });
      return true;
    }
    if (command === "/team-reject") {
      const request = parseTaskActionArgument(argument, { requireNote: true });
      if (request.error) {
        await replyCommand(msg, request.error);
        return true;
      }
      const current = teamTaskStore.get(request.taskId);
      requireTaskApprover(msg.senderId, current);
      const task = await teamTaskStore.rejectInbound(request.taskId, request.note, msg.senderId);
      await sendTaskEvent(task, "task.rejected", { reason: request.note });
      await audit("task.rejected", `human:${msg.senderId}`, {
        taskId: task.taskId,
        details: { peerAgentId: task.peerAgentId, branch: task.branch },
      });
      await replyCommand(msg, `已拒绝协作任务 \`${task.taskId}\`，并通知 ${task.peerAgentId}。`);
      return true;
    }
    if (command === "/team-approve") {
      const request = parseTaskActionArgument(argument);
      if (request.error) {
        await replyCommand(msg, request.error);
        return true;
      }
      const current = teamTaskStore.get(request.taskId);
      requireTaskApprover(msg.senderId, current, { allowRequester: true });
      const task = await teamTaskStore.approveOutbound(request.taskId, request.note, msg.senderId);
      await sendTaskEvent(task, "task.approved", { note: request.note || undefined });
      await audit("task.approved", `human:${msg.senderId}`, {
        taskId: task.taskId,
        details: { peerAgentId: task.peerAgentId, branch: task.branch },
      });
      await replyCommand(msg, `已批准 peer 返回的任务结果：\`${task.taskId}\`。`);
      return true;
    }
    if (command === "/branches") {
      await replyCommand(msg, buildBranchesMarkdown(config, await projectContext.refresh()));
      return true;
    }
    if (command === "/worktrees") {
      const snapshot = await projectContext.refresh();
      const threads = await listProjectThreads({ snapshot, limit: 500 });
      await replyCommand(msg, buildWorktreesMarkdown(config, snapshot, threads, getActiveThreadId()));
      return true;
    }
    if (command === "/new") {
      if (getTemporaryChat()) {
        await replyCommand(msg, "当前处于临时 Chat。请先发送 `/endchat` 返回原任务，再使用 `/new` 创建新的长期任务。");
        return true;
      }
      const request = parseNewCommandArgument(argument);
      if (request.error) {
        await replyCommand(msg, request.error);
        return true;
      }
      let snapshot = await projectContext.refresh();
      const current = await activeProjectThread(snapshot);
      const targetWorktree = request.branch
        ? await projectContext.prepareWorktree(request.branch)
        : current?.worktree || snapshot.worktrees.find(({ branch }) => branch === config.project.defaultBranch) || snapshot.worktrees[0];
      if (!targetWorktree) {
        await replyCommand(msg, "Project 内没有可用 worktree；请检查 `project.repoRoot` 与 `allowedWorktreeRoots` 配置。");
        return true;
      }
      const topic = request.topic || (request.branch
        ? `${request.branch} 任务`
        : `${config.project.name} 新任务`);
      await channel.reply(msg, {
        markdown: [
          `⏳ 正在创建 Codex 任务：**${compactTitle(topic, 100)}**`,
          "",
          `- 分支：\`${targetWorktree.branch || "detached"}\``,
          `- worktree：\`${targetWorktree.path}\``,
          `- 权限：\`${projectContext.effectiveSandbox(targetWorktree, config.sandboxMode)}\``,
        ].join("\n"),
      });
      const thread = await executor.createThread(topic, undefined, targetWorktree.path);
      snapshot = await projectContext.refresh();
      const scopedThread = await selectThread(thread, snapshot);
      // Persist the side effect before replying so a transient reply failure cannot
      // cause the same Feishu delivery to create a second Codex task.
      await persistCompleted(msg.messageId);
      await channel.reply(msg, { markdown: [
        `已创建并切换到：**${compactTitle(thread.title, 100)}**`,
        "",
        `\`${thread.id}\``,
        "",
        `分支 \`${scopedThread.worktree.branch || "detached"}\` · worktree \`${scopedThread.worktree.path}\``,
        "",
        scopedThread.worktree.branch === config.project.defaultBranch && config.project.protectDefaultBranch
          ? "这是受保护的默认分支任务，只能读取和分析；需要改代码请用 `/new --branch <任务分支> <主题>`。"
          : "下一条普通消息会进入这个任务；旧任务仍然保留，可用 `/threads` 切回。",
        "",
        config.project.desktopProjectId
          ? "说明：该任务由独立 App Server 创建，当前 Codex Desktop 不会自动把它归入已注册的 Desktop Project；Bridge 的 cwd/worktree 安全边界不受影响。"
          : "说明：尚未配置 Desktop Project 关联；Bridge 的 cwd/worktree 安全边界不受影响。",
      ].join("\n") });
      log(`created and selected project thread ${thread.id} in ${scopedThread.worktree.path}`);
      return true;
    }
    if (command === "/use") {
      if (getTemporaryChat()) {
        await replyCommand(msg, "当前处于临时 Chat。请先发送 `/endchat` 返回原任务，再使用 `/use` 切换长期任务。");
        return true;
      }
      if (!argument) {
        await replyCommand(msg, "请先发送 `/threads`，然后使用 `/use 2`；也可以发送 `/use <完整任务ID>`。");
        return true;
      }
      let thread;
      if (/^\d+$/.test(argument)) thread = await selectedThreadFromList(msg, Number(argument) - 1);
      else if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(argument)) thread = getThread(argument);
      if (!thread) {
        await replyCommand(msg, "没有在最近的 Project 任务列表中找到该项。请重新发送 `/threads` 后选择。");
        return true;
      }
      let scopedThread;
      try { scopedThread = await selectThread(thread); }
      catch {
        await replyCommand(msg, "已拒绝切换：该 Codex 任务的 cwd 不属于当前 Project，或任务记录的分支已与 worktree 当前分支不一致。");
        return true;
      }
      await replyCommand(msg, [
        `已切换到：**${compactTitle(thread.title, 100)}**`,
        "",
        `分支 \`${scopedThread.worktree.branch || "detached"}\` · worktree \`${scopedThread.worktree.path}\``,
        "",
        "后续消息会携带该任务的完整历史继续处理；bridge 不会执行 git checkout。",
      ].join("\n"));
      log(`selected thread ${thread.id}`);
      return true;
    }
    if (command === "/help") {
      await replyCommand(msg, [
        "## 飞书 Codex 命令",
        "",
        "- `/project`：查看 Bot 绑定的 Project 与权限边界",
        "- `/branches`：列出本地/远端 refs 与分支 worktree",
        "- `/worktrees`：列出 Project 的 worktree、HEAD 与任务数",
        "- `/status`：查看桥接、运行任务、队列和最近进展（不调用模型）",
        "- `/model`：查看当前任务使用的模型和推理强度（不调用模型）",
        "- `/capacity`：查看上下文与账户周期剩余容量（不调用模型）",
        "- `/new 主题`：在当前 worktree 创建并切换到新任务",
        "- `/new --branch task/LOGIN-123 主题`：准备独立 worktree 后创建任务",
        "- `/threads`：只列出当前 Project 的任务",
        "- `/threads branch task/LOGIN-123`：按分支过滤任务",
        "- `/chat`：创建临时异步 Chat，同时保留原任务上下文",
        "- `/chat 正文`：创建临时异步 Chat，并直接处理后面的正文",
        "- `/endchat`（或 `/end`）：结束临时 Chat，立即返回原任务",
        "- `/use 2`：切换到列表中的第 2 个任务",
        "- `/current`：查看当前任务",
        "- `/team`：查看唯一群、GitHub 仓库、本机 Project 和可信成员/Bot",
        "- `/team-tasks`：查看 Agent 协作任务和所有权状态",
        "- `/delegate <peer> <branch> <任务>`：向可信 peer 委派任务",
        "- `/team-options <taskId>`：查看本机 worktree/对话落点",
        "- `/team-accept <taskId> [auto|thread:<id>|new-thread|new-worktree]`：选择落点并执行",
        "- `/team-reject <taskId> <原因>`：拒绝收到的任务",
        "- `/team-approve <taskId> [说明]`：批准 peer 返回的结果",
        "- `/knowledge [list|show|create|update]`：管理共享稳定知识、总结和参考资料",
        "- `/audit [1-100]`：查看追加式审计链摘要",
        "- `/metrics`：查看队列、发件箱、任务、知识、租约与 executor 指标",
        "- `/help`：显示帮助",
      ].join("\n"));
      return true;
    }
    return false;
  }
  
  
  return handleCommand;
}
