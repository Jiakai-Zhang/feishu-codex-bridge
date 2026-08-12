const ADDRESS = /^(knowledge|summaries|references)\/([a-z0-9](?:[a-z0-9._-]{0,78}[a-z0-9])?)$/;
const REVISION = /^[a-f0-9]{64}$/;

function inlineCode(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}

function parseAddress(value) {
  const match = String(value || "").match(ADDRESS);
  return match ? { category: match[1], id: match[2] } : undefined;
}

export function parseKnowledgeCommand(argument) {
  const value = String(argument || "").trim();
  if (!value || value === "list") return { action: "list" };
  const firstSpace = value.search(/\s/);
  const action = firstSpace < 0 ? value : value.slice(0, firstSpace);
  const rest = firstSpace < 0 ? "" : value.slice(firstSpace).trim();
  if (action === "show") {
    const address = parseAddress(rest);
    return address ? { action, ...address } : { error: "用法：`/knowledge show <knowledge|summaries|references>/<id>`" };
  }
  if (action === "create") {
    const separator = rest.search(/\s/);
    const address = parseAddress(separator < 0 ? rest : rest.slice(0, separator));
    const content = separator < 0 ? "" : rest.slice(separator).trim();
    if (!address || !content) return { error: "用法：`/knowledge create <category>/<id> <Markdown 内容>`" };
    return { action, ...address, content, title: address.id };
  }
  if (action === "update") {
    const match = rest.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
    const address = parseAddress(match?.[1]);
    if (!match || !address || !REVISION.test(match[2]) || !match[3].trim()) {
      return { error: "用法：`/knowledge update <category>/<id> <完整 revision> <Markdown 内容>`" };
    }
    return { action, ...address, expectedRevision: match[2], content: match[3].trim() };
  }
  return { error: "支持：`/knowledge [list|show|create|update]`" };
}

export function buildKnowledgeListMarkdown(records, config) {
  const lines = records.map((record) => record.error
    ? `- ${inlineCode(`${record.category}/${record.id}`)} · 读取失败`
    : `- ${inlineCode(`${record.category}/${record.id}`)} · ${record.title} · rev ${inlineCode(record.revision.slice(0, 12))}${record.externalChange ? " · 外部修改" : ""}`);
  return [
    `## ${config.project.name} Team Hub`,
    "",
    `- 稳定知识根：${inlineCode(config.teamHub.path)}`,
    `- 关联 repositories：${config.teamHub.repositoryIds.map(inlineCode).join("、")}`,
    `- Codex 上下文上限：${config.teamHub.maxContextChars} 字符`,
    "",
    ...(lines.length ? lines : ["当前没有共享知识条目。"]),
    "",
    "> 实时 Agent 任务状态保存在 Bridge 运行目录，不写入 Team Hub。",
  ].join("\n");
}

export function buildKnowledgeArtifactMarkdown(artifact) {
  const { metadata, content, revision, externalChange } = artifact;
  return [
    `## ${metadata.title}`,
    "",
    `- 条目：${inlineCode(`${metadata.category}/${metadata.id}`)}`,
    `- revision：${inlineCode(revision)}`,
    `- repositories：${metadata.repositoryIds.map(inlineCode).join("、")}`,
    `- 最近作者 Agent：${inlineCode(metadata.authorAgentId)}`,
    `- 状态：${externalChange ? "文件被外部修改；更新时必须使用上方实际 revision" : "metadata 与内容一致"}`,
    "",
    content.slice(0, 8_000),
    ...(content.length > 8_000 ? ["", "（内容过长，飞书预览已截断。）"] : []),
  ].join("\n");
}
