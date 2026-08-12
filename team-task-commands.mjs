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

export function buildTeamTasksMarkdown(tasks) {
  const lines = tasks.map((task, index) => [
    `${index + 1}. **${compact(task.title, 80)}** · ${inlineCode(task.state)} · ${task.direction === "inbound" ? "接收" : "委派"}`,
    `   ${inlineCode(task.taskId)} · branch ${inlineCode(task.branch)}`,
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
    "- `/team-accept <taskId>`：审批并执行收到的任务",
    "- `/team-reject <taskId> <原因>`：拒绝收到的任务",
    "- `/team-approve <taskId> [说明]`：批准 peer 返回的结果",
  ].join("\n");
}
