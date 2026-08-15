const AGENT_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TASK_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const BRANCH = /^(?![./])(?!.*(?:\.\.|\/\.|\.lock(?:\/|$)))[A-Za-z0-9._/-]{1,200}$/;

function inlineCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function compact(value, max = 100) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function parseDelegateArgument(argument) {
  const match = String(argument || "").trim().match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
  if (!match) return { error: "用法：`/delegate <peer-agent-id> <branch> <任务说明>`" };
  if (!AGENT_ID.test(match[1])) return { error: "peer-agent-id 格式无效" };
  if (!BRANCH.test(match[2])) return { error: "branch 格式无效" };
  const prompt = match[3].trim();
  if (!prompt || prompt.length > 12_000) return { error: "任务说明必须为 1–12000 个字符" };
  return { peerAgentId: match[1], branch: match[2], prompt, title: compact(prompt, 120) };
}

export function parseTaskActionArgument(argument, { requireNote = false } = {}) {
  const match = String(argument || "").trim().match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (!match || !TASK_ID.test(match[1])) return { error: "任务 ID 格式无效" };
  const note = String(match[2] || "").trim();
  if (requireNote && !note) return { error: "该操作必须填写原因" };
  if (note.length > 2_000) return { error: "说明不能超过 2000 个字符" };
  return { taskId: match[1], note };
}

export function parseTaskAcceptArgument(argument) {
  const match = String(argument || "").trim().match(/^(\S+)(?:\s+(\S+))?$/);
  if (!match || !TASK_ID.test(match[1])) return { error: "任务 ID 格式无效" };
  const choice = match[2] || "auto";
  if (!/^(?:auto|new|new-worktree|worktree|new-thread|thread:[A-Za-z0-9._:-]{8,160})$/.test(choice)) {
    return { error: "接收位置必须是 auto、thread:<任务ID>、new-thread 或 new-worktree" };
  }
  return { taskId: match[1], choice };
}

export function buildTaskLandingMarkdown(task, plan, effectiveMode) {
  const optionLines = plan.options.map((option) => {
    if (option.landing === "existing-thread") {
      return `- 继续对话 ${inlineCode(option.threadId)}${option.title ? ` · ${compact(option.title, 80)}` : ""}：${inlineCode(`/team-accept ${task.taskId} thread:${option.threadId}`)}`;
    }
    if (option.landing === "new-thread") {
      return `- 在已有 worktree 新建对话：${inlineCode(`/team-accept ${task.taskId} new-thread`)}`;
    }
    return `- 创建该分支的 worktree 和新对话：${inlineCode(`/team-accept ${task.taskId} new-worktree`)}`;
  });
  return [
    `## 协作任务接收选项`,
    "",
    `- 任务：${inlineCode(task.taskId)}`,
    `- 仓库：${inlineCode(task.githubRepository)}`,
    `- 分支：${inlineCode(task.branch)}`,
    `- 接收策略：${inlineCode(effectiveMode)}`,
    `- 推荐：${inlineCode(plan.recommendation.landing)}${plan.recommendation.threadId ? ` · ${inlineCode(plan.recommendation.threadId)}` : ""}`,
    "",
    ...optionLines,
    "",
    `- 使用推荐项：${inlineCode(`/team-accept ${task.taskId} auto`)}`,
    `- 拒绝：${inlineCode(`/team-reject ${task.taskId} <原因>`)}`,
  ].join("\n");
}

export function buildTeamTasksMarkdown(tasks) {
  const lines = tasks.map((task, index) => [
    `${index + 1}. **${compact(task.title, 80)}** · ${inlineCode(task.state)} · ${task.direction === "inbound" ? "接收" : "委派"}`,
    `   ${inlineCode(task.taskId)} · ${inlineCode(task.githubRepository || "legacy")}`,
    `   Git ${inlineCode(`${task.branch}@${(task.resultGit?.commit || task.requestGit?.commit || "unknown").slice(0, 12)}`)}`,
    `   requester ${inlineCode(task.requesterAgentId)} → executor ${inlineCode(task.executorAgentId)}`,
    task.reason ? `   阻塞/拒绝：${compact(task.reason, 160)}` : undefined,
    task.result ? `   结果：${compact(task.result, 160)}` : undefined,
  ].filter(Boolean).join("\n"));
  return [
    "## Agent 协作任务",
    "",
    ...(lines.length ? lines : ["当前没有协作任务。"]),
    "",
    "- `/delegate <peer> <branch> <任务>`：向可信 peer 委派",
    "- `/team-options <taskId>`：查看可用 worktree/对话和推荐项",
    "- `/team-accept <taskId> [auto|thread:<id>|new-thread|new-worktree]`：选择位置并执行",
    "- `/team-reject <taskId> <原因>`：拒绝收到的任务",
    "- `/team-approve <taskId> [说明]`：批准 peer 返回的结果",
  ].join("\n");
}
