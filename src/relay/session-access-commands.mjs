import { normalizeDirectoryName, SessionAccessStoreError } from "../persistence/session-access-store.mjs";

function cleanMentionName(value) {
  return String(value || "").replace(/[\r\n`]/g, " ").trim().slice(0, 80) || "未命名成员";
}

function humanMentions(mentions, botOpenId) {
  const byId = new Map();
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const openId = String(mention?.openId || "");
    if (!openId || openId === botOpenId || mention?.isBot) continue;
    byId.set(openId, mention);
  }
  return [...byId.values()];
}

export function parseMembersCommand(value) {
  const text = String(value || "").trim();
  const match = /^\/members(?:@[^\s]+)?(?:\s+([\s\S]*))?$/i.exec(text);
  if (!match) return undefined;
  const args = String(match[1] || "").trim();
  if (!args || args.toLowerCase() === "status") return Object.freeze({ action: "status" });
  const actionMatch = /^(add|remove)(?:\s+([\s\S]*))?$/i.exec(args);
  if (!actionMatch) return Object.freeze({ action: "invalid" });
  return Object.freeze({ action: actionMatch[1].toLowerCase(), args: String(actionMatch[2] || "").trim() });
}

function formatMembers(accessStore, { changed, includeRoster = true } = {}) {
  const state = accessStore.snapshot();
  const members = state.users.filter(({ role }) => role === "member");
  if (!includeRoster) {
    return [
      `### Bridge 成员${changed ? "已更新" : ""}`,
      "",
      "成员状态已在本机保存；Bridge 将自动重载。完整成员清单只在与 Bot 的私聊中显示。",
      "",
      "> Project 绝对路径不会显示在飞书中；停用成员不会删除本地文件。",
    ].join("\n");
  }
  const lines = [
    `### Bridge 成员${changed ? "已更新" : ""}`,
    "",
    `- Project 根目录：${accessStore.isConfigured() ? "本机已设置" : "尚未设置"}`,
    `- 已登记普通成员：${members.length}`,
  ];
  if (members.length > 0) {
    lines.push("", ...members.map((member, index) => (
      `${index + 1}. ${cleanMentionName(member.displayName || member.directoryName)} · ${member.status === "active" ? "已启用" : "已停用"}`
    )));
  }
  lines.push(
    "",
    "命令：发送用户名片后回复目录名，或使用 `/members add <目录名> @成员`、`/members remove @成员`",
    "",
    "> Project 绝对路径只允许在本机设置，不会显示在飞书中。成员目录停用后不会删除本地文件。",
  );
  return lines.join("\n");
}

function appendOnboardingNotice(markdown, status) {
  const notice = status === "sent"
    ? "已主动向新成员发送 Bot 私聊欢迎消息；Bridge 重载后，成员可在该私聊发送 `/add`。"
    : "成员已登记，但 Bot 主动私聊发送失败。请确认飞书应用可用范围包含该成员，并让其搜索 Bot 后发送 `/add`。";
  return `${markdown}\n\n> ${notice}`;
}

export async function executeMembersCommand(command, {
  accessStore,
  mentions,
  botOpenId,
  listBindings = async () => [],
  includeRoster = true,
  sendMemberOnboarding,
} = {}) {
  if (!command || !accessStore) throw new TypeError("Members command requires an access store");
  if (command.action === "status") return { markdown: formatMembers(accessStore), restart: false };
  if (command.action === "invalid") {
    return { markdown: "用法：发送用户名片后回复目录名，或使用 `/members`、`/members add <目录名> @成员`、`/members remove @成员`。", restart: false };
  }
  const targets = humanMentions(mentions, botOpenId);
  if (targets.length !== 1) {
    return { markdown: "请在命令中准确 @ 一名飞书成员。", restart: false };
  }
  const target = targets[0];
  if (command.action === "add") {
    if (typeof sendMemberOnboarding !== "function") {
      throw new TypeError("Members add requires a member onboarding sender");
    }
    const directoryTokens = command.args.split(/\s+/).filter((token) => token && !token.startsWith("@"));
    if (directoryTokens.length !== 1) {
      return { markdown: "用法：`/members add <目录名> @成员`。目录名不能包含空格或路径分隔符。", restart: false };
    }
    let directoryName;
    try { directoryName = normalizeDirectoryName(directoryTokens[0]); }
    catch {
      return { markdown: "成员目录名无效；请使用一个不含路径分隔符的安全目录名。", restart: false };
    }
    await accessStore.addMember({
      openId: target.openId,
      directoryName,
      displayName: target.name,
    });
    let onboarding = "sent";
    try {
      await sendMemberOnboarding({ memberOpenId: target.openId });
    } catch {
      onboarding = "failed";
    }
    return {
      markdown: appendOnboardingNotice(
        formatMembers(accessStore, { changed: true, includeRoster }),
        onboarding,
      ),
      restart: true,
      onboarding,
    };
  }

  const ownedBindings = (await listBindings()).filter(({ ownerOpenId }) => ownerOpenId === target.openId);
  if (ownedBindings.length > 0) {
    throw new SessionAccessStoreError(
      "member_owns_bindings",
      "The member still owns bound Sessions",
    );
  }
  await accessStore.deactivateMember(target.openId);
  return { markdown: formatMembers(accessStore, { changed: true, includeRoster }), restart: true };
}

export function publicMembersFailure(error) {
  switch (error?.code) {
    case "project_root_missing": return "请先在 Bridge 主机上运行 macOS `setup-project-root.sh` 或 Windows `setup-project-root.ps1` 设置 Project 根目录。";
    case "member_directory_not_empty": return "指定的成员目录已存在且不为空；为避免接管已有数据，没有添加该成员。";
    case "member_directory_conflict": return "该成员目录名已经分配给其他用户。";
    case "member_directory_immutable": return "该成员已有固定目录，不能通过飞书自动改到另一个目录。";
    case "member_owns_bindings": return "该成员仍拥有已绑定 Session。请先解除或转移这些绑定，再停用成员。";
    case "member_not_found": return "没有找到该 Bridge 成员。";
    case "member_is_owner": return "不能通过成员命令修改 Bridge Owner。";
    default: return "成员设置失败；本地目录和现有权限没有被自动覆盖。";
  }
}
