function deleteCommand(value) {
  const match = /^\/delete(?:@[^\s]+)?(?:\s+([\s\S]*))?$/i.exec(String(value || "").trim());
  return match ? String(match[1] || "").trim().toLowerCase() : undefined;
}

function safeTitle(value) {
  return String(value || "当前 Codex 任务")
    .replace(/[\r\n]+/g, " ")
    .replace(/`/g, "'")
    .trim()
    .slice(0, 100) || "当前 Codex 任务";
}

export class SessionDeleteFlow {
  constructor({ remove, now = () => Date.now(), ttlMs = 5 * 60_000 }) {
    this.remove = remove;
    this.now = now;
    this.ttlMs = ttlMs;
    this.pending = new Map();
  }

  cancel(conversationId) {
    return this.pending.delete(conversationId);
  }

  async handle({ conversationId, text, binding, sessionTitle }) {
    const action = deleteCommand(text);
    if (action === undefined) return { handled: false };

    if (!binding) {
      this.pending.delete(conversationId);
      return {
        handled: true,
        reply: "`/delete` 只能在要解除绑定的 Session 群中使用；它不会删除飞书群或 Codex 任务。",
      };
    }

    if (!action) {
      this.pending.set(conversationId, {
        binding: { ...binding },
        expiresAt: this.now() + this.ttlMs,
      });
      return {
        handled: true,
        reply: [
          "### 确认解除 Session 绑定？",
          "",
          `> 当前群将停止转发到：${safeTitle(sessionTitle)}`,
          "",
          "- 不会删除飞书群",
          "- 不会删除或归档 Codex 任务",
          "- 会移除当前群的 Agent 标签",
          "- 如有待执行 Prompt，必须先用 `/queue clear` 清空",
          "",
          "请在 5 分钟内发送 `/delete confirm`；发送 `/delete cancel` 可取消。",
        ].join("\n"),
      };
    }

    if (["cancel", "取消"].includes(action)) {
      this.pending.delete(conversationId);
      return { handled: true, reply: "已取消解除 Session 绑定。" };
    }

    if (!["confirm", "确认"].includes(action)) {
      return {
        handled: true,
        reply: "用法：先发送 `/delete` 查看影响，再发送 `/delete confirm` 确认，或 `/delete cancel` 取消。",
      };
    }

    const pending = this.pending.get(conversationId);
    if (!pending || pending.expiresAt < this.now()) {
      this.pending.delete(conversationId);
      return { handled: true, reply: "解除确认已失效。请重新发送 `/delete` 查看影响。" };
    }
    if (pending.binding.groupChatId !== binding.groupChatId || pending.binding.threadId !== binding.threadId) {
      this.pending.delete(conversationId);
      return { handled: true, reply: "群绑定已经发生变化。请重新发送 `/delete` 查看当前状态。" };
    }

    const result = await this.remove(binding);
    this.pending.delete(conversationId);
    return {
      handled: true,
      restart: true,
      result,
      reply: [
        "### Session 绑定已解除",
        "",
        result?.tagRemoved
          ? "当前群不再向原 Codex 任务转发消息，Agent 标签也已移除。"
          : "当前群不再向原 Codex 任务转发消息。",
        "飞书群和 Codex 任务均已保留；Bridge 将自动重载。",
      ].join("\n"),
    };
  }
}
