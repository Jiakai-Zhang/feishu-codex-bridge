import { canonicalGitHubRepository } from "./collaboration-request-inbox.mjs";

const CONTROL_REQUEST_ID = /^[A-Za-z0-9._:-]{1,80}$/;

function inlineCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

export function parsePeerControlMessage(content) {
  const match = String(content || "").trim().match(/^\/peer\s+(ping|status)\s+(\S+)(?:\s+(\S+))?$/i);
  if (!match) return { error: "unsupported_peer_control" };
  let githubRepository;
  try { githubRepository = canonicalGitHubRepository(match[2]); }
  catch { return { error: "invalid_github_repository" }; }
  const requestId = match[3] || undefined;
  if (requestId && !CONTROL_REQUEST_ID.test(requestId)) return { error: "invalid_request_id" };
  return { action: match[1].toLowerCase(), githubRepository, requestId };
}

export function buildTeamMarkdown(config, connectedBotOpenId = config.agent.botOpenId) {
  const peers = config.collaboration.trustedPeers.filter(({ enabled }) => enabled);
  const peerLines = peers.length
    ? peers.map((peer) => `- ${peer.humanDisplayName} + ${peer.displayName}（Agent ${inlineCode(peer.agentId)}）`)
    : ["- 尚未配置可信成员/Bot 对"];
  return [
    `## ${config.agent.displayName} 协作状态`,
    "",
    `- 本地 Agent：${inlineCode(config.agent.id)}`,
    `- 本地 Bot：${inlineCode(connectedBotOpenId || "连接后确认")}`,
    `- 本机 Bridge Project：${inlineCode(config.project.id)}`,
    `- 多 Bot 协作：**${config.collaboration.enabled ? "已启用" : "未启用"}**`,
    `- 绑定飞书群：${inlineCode(config.collaboration.groupChatId || "未配置")}`,
    `- 绑定 GitHub 仓库：${inlineCode(config.collaboration.githubRepository || "未配置")}`,
    `- Git remote：${inlineCode(config.collaboration.remote)}`,
    `- 个人群消息：${inlineCode(config.collaboration.groupHumanMessageMode)}`,
    `- 接收策略：${inlineCode(config.collaboration.receiveMode)}`,
    `- 协作任务审批者：${config.collaboration.approverOpenIds.length} 人`,
    `- Team Hub：**${config.teamHub.enabled ? "已启用" : "未启用"}**${config.teamHub.enabled ? ` · repositories ${config.teamHub.repositoryIds.map(inlineCode).join("、")}` : ""}`,
    "",
    "### 可信成员 + Bot",
    "",
    ...peerLines,
    "",
    "> 这个群只绑定这一台机器上的一个 Bridge Project；其他成员可以使用不同的本机 Project ID，但群与规范化 GitHub 仓库必须完全一致。普通 owner 群消息会进入自己的 Agent，由 Agent 判断是讨论还是指令；peer Bot 事件仍必须真实提及本 Bot。",
  ].join("\n");
}

export function buildPeerControlReply(config, peer, request) {
  const requestLine = request.requestId ? `\n- 请求 ID：${inlineCode(request.requestId)}` : "";
  return [
    `## Peer ${request.action === "ping" ? "连通性确认" : "状态"}`,
    "",
    `- 响应 Agent：${inlineCode(config.agent.id)}`,
    `- 请求 Agent：${inlineCode(peer.agentId)}`,
    `- 绑定群：${inlineCode(config.collaboration.groupChatId)}`,
    `- GitHub 仓库：${inlineCode(config.collaboration.githubRepository)}`,
    `- 本机 Project：${inlineCode(config.project.id)}`,
    `- 控制面：**ready**${requestLine}`,
    "",
    "> 本机 Project ID 不是跨机器授权凭据；跨 Agent 边界由群、Bot 身份和 GitHub 仓库共同确定。",
  ].join("\n");
}
