const STATUS_LABELS = Object.freeze({
  pendingInit: "正在启动",
  running: "工作中",
  interrupted: "已中断",
  completed: "已完成",
  errored: "执行失败",
  shutdown: "已关闭",
  notFound: "暂不可用",
  unknown: "等待状态",
});

const ACTION_LABELS = Object.freeze({
  spawnAgent: ["正在启动子 agent…", "已启动子 agent"],
  sendInput: ["正在向子 agent 发送任务…", "已向子 agent 发送任务"],
  resumeAgent: ["正在恢复子 agent…", "已恢复子 agent"],
  wait: ["正在等待子 agent 的结果…", "已更新子 agent 状态"],
  closeAgent: ["正在关闭子 agent…", "已发送子 agent 关闭请求"],
});

const ACTIVITY_STATUS = Object.freeze({
  started: "running", interacted: "running", interrupted: "interrupted", completed: "completed",
});

export function isSubagentItem(item) {
  return item?.type === "collabAgentToolCall" || item?.type === "subAgentActivity";
}

// Only public lifecycle enums leave this adapter. Prompts, agent paths, results,
// errors and receiver identifiers must never become progress text.
export function collectSubagentProgress(agents, item) {
  let action;
  const update = (id, status) => {
    if (typeof id !== "string" || !id) return;
    const current = agents.get(id) || { number: agents.size + 1, status: "unknown" };
    if (Object.hasOwn(STATUS_LABELS, status)) current.status = status;
    agents.set(id, current);
  };
  if (item?.type === "collabAgentToolCall") {
    const labels = Object.hasOwn(ACTION_LABELS, item.tool) ? ACTION_LABELS[item.tool] : undefined;
    if (!labels || !["inProgress", "completed", "failed"].includes(item.status)) return undefined;
    action = item.status === "failed" ? "子 agent 协作调用失败" : labels[item.status === "completed" ? 1 : 0];
    const states = item.agentsStates && typeof item.agentsStates === "object" ? item.agentsStates : {};
    const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
    for (const id of new Set([...receivers, ...Object.keys(states)])) update(id, states[id]?.status);
  } else if (item?.type === "subAgentActivity" && Object.hasOwn(ACTIVITY_STATUS, item.kind)) {
    update(item.agentThreadId, ACTIVITY_STATUS[item.kind]);
    if (!agents.has(item.agentThreadId)) return undefined;
    action = "子 agent 协作状态";
  } else return undefined;
  const entries = [...agents.values()];
  const lines = entries.slice(0, 12).map(({ number, status }) => `子 agent #${number}：${STATUS_LABELS[status]}`);
  if (entries.length > 12) lines.push(`另有 ${entries.length - 12} 个子 agent`);
  return [action, ...lines].join("\n");
}
