const CONTROL_REQUEST_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const PROJECT_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function inlineCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

export function parsePeerControlMessage(content) {
  const match = String(content || "").trim().match(/^\/peer\s+(ping|status)\s+(\S+)(?:\s+(\S+))?$/i);
  if (!match) return { error: "unsupported_peer_control" };
  if (!PROJECT_ID.test(match[2])) return { error: "invalid_project_id" };
  const requestId = match[3] || undefined;
  if (requestId && !CONTROL_REQUEST_ID.test(requestId)) return { error: "invalid_request_id" };
  return { action: match[1].toLowerCase(), projectId: match[2], requestId };
}

export function buildTeamMarkdown(config, connectedBotOpenId = config.agent.botOpenId) {
  const peers = config.collaboration.trustedPeers.filter(({ enabled }) => enabled);
  const peerLines = peers.length
    ? peers.map((peer) => `- ${peer.displayName}（${inlineCode(peer.agentId)}）· Projects：${peer.allowedProjectIds.map(inlineCode).join("、")}`)
    : ["- 尚未配置可信 peer Bot"];
  return [
    `## ${config.agent.displayName} 协作状态`,
    "",
    `- 本地 Agent：${inlineCode(config.agent.id)}`,
    `- 本地 Bot：${inlineCode(connectedBotOpenId || "连接后确认")}`,
    `- 当前 Project：${inlineCode(config.project.id)}`,
    `- 多 Bot 协作：**${config.collaboration.enabled ? "已启用" : "未启用"}**`,
    `- 可信群：${config.collaboration.groupChatIds.length} 个`,
    `- 可调用本 Bot 的成员：${config.agent.allowedHumanOpenIds.length} 人`,
    `- 协作任务审批者：${config.collaboration.approverOpenIds.length} 人`,
    `- 默认协作群：${inlineCode(config.collaboration.defaultGroupChatId || "未配置")}`,
    `- peer 自动接单：**${config.collaboration.autoAcceptPeerTasks ? "已启用" : "未启用"}**`,
    `- Team Hub：**${config.teamHub.enabled ? "已启用" : "未启用"}**${config.teamHub.enabled ? ` · repositories ${config.teamHub.repositoryIds.map(inlineCode).join("、")}` : ""}`,
    "",
    "### 可信 peer Bot",
    "",
    ...peerLines,
    "",
    "> 群消息必须真实提及本 Bot。peer Bot 还必须通过发送者 open_id 与当前 Project allowlist 校验；本阶段只接受 `/peer ping|status` 控制消息，不会执行 peer 提供的 Codex 提示词。",
  ].join("\n");
}

export function buildPeerControlReply(config, peer, request) {
  const requestLine = request.requestId ? `\n- 请求 ID：${inlineCode(request.requestId)}` : "";
  return [
    `## Peer ${request.action === "ping" ? "连通性确认" : "状态"}`,
    "",
    `- 响应 Agent：${inlineCode(config.agent.id)}`,
    `- 请求 Agent：${inlineCode(peer.agentId)}`,
    `- Project：${inlineCode(config.project.id)}`,
    `- 控制面：**ready**${requestLine}`,
    "",
    "> 该回复不包含 Bot 提及，不会触发 peer 回声；任务委派协议尚未启用。",
  ].join("\n");
}
