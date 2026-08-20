function selectionNumber(value) {
  const match = /^\s*(\d+)\s*$/.exec(String(value || ""));
  return match ? Number(match[1]) : undefined;
}

function choiceLine(number, label) {
  return `\`${number}\` ${label}`;
}

function ageLabel(updatedAtMs, nowMs) {
  const ageMs = Math.max(0, nowMs - Number(updatedAtMs || 0));
  if (ageMs < 60 * 60_000) return `${Math.max(1, Math.round(ageMs / 60_000))} 分钟前`;
  if (ageMs < 24 * 60 * 60_000) return `${Math.round(ageMs / 3_600_000)} 小时前`;
  return `${Math.round(ageMs / 86_400_000)} 天前`;
}

function withNotice(markdown, notice) {
  return notice ? `${notice}\n\n${markdown}` : markdown;
}

function projectMenu(catalog, notice) {
  const independentLabel = catalog.independentLabel || "独立";
  const lines = [
    "### 创建 Session 群",
    "",
    "回复编号选择任务归属：",
    "",
    choiceLine(1, `**${independentLabel}**`),
  ];
  catalog.projects.forEach((project, index) => {
    const suffix = project.accessKind === "unassigned" ? " · 无归属" : "";
    lines.push(choiceLine(index + 2, `${project.name}${suffix}`));
  });
  if (catalog.canCreateProject) {
    lines.push(choiceLine(catalog.projects.length + 2, "**新建 Project**"));
  }
  lines.push("", "发送 `/cancel` 取消。");
  return withNotice(lines.join("\n"), notice);
}

function emptyProjectMenu(selection, notice) {
  const lines = [
    `### ${selection.name}：暂无可绑定任务`,
    "",
    "Bridge 已检查 Codex 原生归属和唯一 Git worktree，当前列表仍为空。",
    "",
    choiceLine(1, "**重新扫描**"),
    choiceLine(2, "**返回 Project 列表**"),
    choiceLine(3, "**新建任务**"),
    "",
    "> 新建任务会使用该 Project 登记的首个有效工作目录；不会直接修改 Codex 全局 Project 状态。",
    "",
    "回复操作编号，或发送 `/cancel` 取消。",
  ];
  return withNotice(lines.join("\n"), notice);
}

function sessionMenu(state, nowMs, notice) {
  const { selection, sessions, pageSize } = state;
  const independent = selection.kind === "independent";
  if (sessions.length === 0 && !independent) return emptyProjectMenu(selection, notice);
  const pageCount = Math.max(1, Math.ceil(sessions.length / pageSize));
  const page = Math.min(pageCount - 1, Math.max(0, state.page || 0));
  state.page = page;
  const start = page * pageSize;
  const visible = sessions.slice(start, start + pageSize);
  const lines = [
    `### ${selection.name}：选择 Codex 任务`,
    "",
  ];
  if (independent && page === 0) lines.push(choiceLine(1, "**新建独立任务**"), "");
  visible.forEach((session, localIndex) => {
    const sessionIndex = start + localIndex;
    const number = sessionIndex + (independent ? 2 : 1);
    const bound = session.binding ? " · 已绑定" : "";
    lines.push(choiceLine(number, `${session.displayTitle}（${ageLabel(session.updatedAtMs, nowMs)}${bound}）`));
  });
  if (pageCount > 1) {
    lines.push("", `第 ${page + 1}/${pageCount} 页；回复“下一页”或“上一页”翻页。`);
  }
  if (!independent) {
    lines.push("", choiceLine(sessions.length + 1, "**新建任务**"));
  }
  lines.push("", "回复任务编号，或发送 `/cancel` 取消。");
  return withNotice(lines.join("\n"), notice);
}

function successReply(result, { projectTaskCreated = false } = {}) {
  if (result.alreadyBound) {
    return [
      "### 已经绑定",
      "",
      "该 Codex 任务已经有固定飞书群，没有重复创建。",
    ].join("\n");
  }
  const lines = [
    "### Session 群已创建",
    "",
    `- 群名：${result.groupName}`,
    ...(result.feedGroupName ? [`- 标签：${result.feedGroupName}`] : []),
    "- 绑定：一个群固定对应一个 Codex 任务",
    "",
    "Bridge 将自动重载；群内只有一名用户时可直接发送 Prompt，无需 @Bot。邀请其他已启用成员进群后即共享 Session，多人聊天需 @Bot。",
  ];
  if (projectTaskCreated) {
    lines.push(
      "",
      "> 新任务已在所选 Project 的工作目录中创建并绑定；Codex Desktop 当前不会自动为外部创建的任务写入原生 Project 分组。",
    );
  }
  return lines.join("\n");
}

export class SessionAddFlow {
  constructor({
    loadCatalog,
    provision,
    createIndependent,
    createProject,
    createWorkspaceProject,
    now = () => Date.now(),
    ttlMs = 15 * 60_000,
    pageSize = 20,
  }) {
    this.loadCatalog = loadCatalog;
    this.provision = provision;
    this.createIndependent = createIndependent;
    this.createProject = createProject;
    this.createWorkspaceProject = createWorkspaceProject;
    this.now = now;
    this.ttlMs = ttlMs;
    this.pageSize = pageSize;
    this.states = new Map();
  }

  has(conversationId) {
    const state = this.states.get(conversationId);
    if (!state) return false;
    if (this.now() - state.updatedAtMs <= this.ttlMs) return true;
    this.states.delete(conversationId);
    return false;
  }

  cancel(conversationId) {
    return this.states.delete(conversationId);
  }

  async begin(conversationId, actorOpenId) {
    const catalog = await this.loadCatalog(actorOpenId);
    this.states.set(conversationId, {
      step: "project",
      catalog,
      actorOpenId,
      updatedAtMs: this.now(),
    });
    return { handled: true, reply: projectMenu(catalog) };
  }

  async handle({ conversationId, text, actorOpenId }) {
    const content = String(text || "").trim();
    if (/^\/add(?:@[^\s]+)?$/i.test(content)) return this.begin(conversationId, actorOpenId);
    if (/^\/cancel(?:@[^\s]+)?$/i.test(content)) {
      if (!this.has(conversationId)) return { handled: false };
      this.states.delete(conversationId);
      return { handled: true, reply: "已取消创建 Session 群。" };
    }
    if (!this.has(conversationId)) return { handled: false };
    const state = this.states.get(conversationId);
    if (state.actorOpenId && actorOpenId && state.actorOpenId !== actorOpenId) {
      return { handled: true, reply: "这个创建流程属于另一名用户，请发送 `/add` 开始自己的流程。" };
    }
    state.updatedAtMs = this.now();

    if (state.step === "project") {
      const number = selectionNumber(content);
      const maxChoice = state.catalog.projects.length + 1 + (state.catalog.canCreateProject ? 1 : 0);
      if (!number || number > maxChoice) {
        return { handled: true, reply: `请输入 1-${maxChoice} 的 Project 编号，或发送 \`/cancel\`。` };
      }
      if (state.catalog.canCreateProject && number === state.catalog.projects.length + 2) {
        state.step = "new-workspace-project-name";
        return { handled: true, reply: "请输入新 Project 名称。Bridge 只会在你的个人 Project 目录中创建它。" };
      }
      const selection = number === 1
        ? {
            kind: "independent",
            id: "independent",
            name: state.catalog.independentLabel || "独立",
            sessions: state.catalog.independent,
          }
        : { ...state.catalog.projects[number - 2], kind: "project" };
      Object.assign(state, {
        step: "session",
        selection,
        sessions: [...selection.sessions],
        page: 0,
        pageSize: this.pageSize,
      });
      return { handled: true, reply: sessionMenu(state, this.now()) };
    }

    if (state.step === "session") {
      const independent = state.selection.kind === "independent";
      if (!independent && state.sessions.length === 0) {
        const action = selectionNumber(content);
        if (action === 1 || content === "重新扫描") {
          const catalog = await this.loadCatalog(state.actorOpenId);
          const project = catalog.projects.find(({ id }) => id === state.selection.id);
          state.catalog = catalog;
          if (!project) {
            Object.assign(state, { step: "project", selection: undefined, sessions: undefined, page: undefined });
            return {
              handled: true,
              reply: projectMenu(catalog, "重新扫描后，原 Project 已不在 Codex Desktop 列表中，请重新选择。"),
            };
          }
          Object.assign(state, {
            selection: { ...project, kind: "project" },
            sessions: [...project.sessions],
            page: 0,
          });
          const notice = state.sessions.length > 0
            ? `重新扫描完成，发现 ${state.sessions.length} 个可绑定任务。`
            : "重新扫描完成，仍未发现可绑定任务。";
          return { handled: true, reply: sessionMenu(state, this.now(), notice) };
        }
        if (action === 2 || content === "返回列表") {
          Object.assign(state, { step: "project", selection: undefined, sessions: undefined, page: undefined });
          return { handled: true, reply: projectMenu(state.catalog) };
        }
        if (action === 3 || content === "新建任务") {
          state.step = "new-project-name";
          return {
            handled: true,
            reply: `请输入要在 Project **${state.selection.name}** 中新建的任务名称。`,
          };
        }
        return { handled: true, reply: "请输入 1-3 的操作编号，或发送 `/cancel`。" };
      }
      if (content === "下一页" || content.toLowerCase() === "next") {
        state.page += 1;
        return { handled: true, reply: sessionMenu(state, this.now()) };
      }
      if (content === "上一页" || content.toLowerCase() === "prev") {
        state.page -= 1;
        return { handled: true, reply: sessionMenu(state, this.now()) };
      }
      const number = selectionNumber(content);
      if (!independent && number === state.sessions.length + 1) {
        state.step = "new-project-name";
        return {
          handled: true,
          reply: `请输入要在 Project **${state.selection.name}** 中新建的任务名称。`,
        };
      }
      if (independent && number === 1) {
        state.step = "new-name";
        return {
          handled: true,
          reply: "请输入新独立任务的名称（下一步会再询问本机工作目录）。",
        };
      }
      const index = number == null ? -1 : number - (independent ? 2 : 1);
      const session = state.sessions[index];
      if (!session) {
        return { handled: true, reply: "请输入列表中的任务编号，或发送 `/cancel`。" };
      }
      const options = state.actorOpenId ? { ownerOpenId: state.actorOpenId } : undefined;
      const result = await this.provision(session.id, options);
      this.states.delete(conversationId);
      return { handled: true, reply: successReply(result), result, restart: !result.alreadyBound };
    }

    if (state.step === "new-project-name") {
      if (!content || content.length > 100 || content.startsWith("/")) {
        return { handled: true, reply: "任务名称需要是 1-100 个字符，且不能以 `/` 开头。" };
      }
      const session = await this.createProject({
        name: content,
        project: state.selection,
        actorOpenId: state.actorOpenId,
      });
      const result = await this.provision(session.id, { session, ownerOpenId: state.actorOpenId });
      this.states.delete(conversationId);
      return {
        handled: true,
        reply: successReply(result, { projectTaskCreated: true }),
        result,
        restart: !result.alreadyBound,
      };
    }

    if (state.step === "new-name") {
      if (!content || content.length > 100 || content.startsWith("/")) {
        return { handled: true, reply: "任务名称需要是 1-100 个字符，且不能以 `/` 开头。" };
      }
      state.taskName = content;
      if (state.catalog.independentCreateMode === "member-root") {
        const session = await this.createIndependent({ name: content, actorOpenId: state.actorOpenId });
        const result = await this.provision(session.id, { session, ownerOpenId: state.actorOpenId });
        this.states.delete(conversationId);
        return { handled: true, reply: successReply(result), result, restart: !result.alreadyBound };
      }
      state.step = "new-cwd";
      return { handled: true, reply: "请输入新独立任务使用的本机绝对工作目录。" };
    }

    if (state.step === "new-cwd") {
      const session = await this.createIndependent({ name: state.taskName, cwd: content, actorOpenId: state.actorOpenId });
      const result = await this.provision(session.id, { session, ownerOpenId: state.actorOpenId });
      this.states.delete(conversationId);
      return { handled: true, reply: successReply(result), result, restart: !result.alreadyBound };
    }

    if (state.step === "new-workspace-project-name") {
      if (!content || content.length > 64 || content.startsWith("/")) {
        return { handled: true, reply: "Project 名称需要是 1-64 个字符，且不能以 `/` 开头。" };
      }
      if (!this.createWorkspaceProject) {
        this.states.delete(conversationId);
        return { handled: true, reply: "当前安装尚未启用 Bridge Project 创建。" };
      }
      const project = await this.createWorkspaceProject({ name: content, actorOpenId: state.actorOpenId });
      state.selection = { ...project, kind: "project" };
      state.step = "new-project-name";
      return {
        handled: true,
        reply: `Project **${project.name}** 已在你的个人目录中创建。请输入首个 Codex 任务名称。`,
      };
    }

    this.states.delete(conversationId);
    return { handled: true, reply: "创建流程状态已失效，请重新发送 `/add`。" };
  }
}
