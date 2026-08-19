import { normalizeDirectoryName } from "../persistence/session-access-store.mjs";

export class SessionMemberCardFlow {
  constructor({ now = () => Date.now(), ttlMs = 15 * 60_000 } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
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

  begin({ conversationId, actorOpenId, target }) {
    if (!conversationId || !actorOpenId || !target?.openId) {
      throw new TypeError("Member card flow requires a conversation, actor, and target");
    }
    this.states.set(conversationId, {
      actorOpenId,
      target: { openId: target.openId, name: target.name },
      updatedAtMs: this.now(),
    });
    return {
      handled: true,
      reply: [
        "### 已读取成员名片",
        "",
        "请回复该成员使用的一级目录名。目录名不能包含空格或路径分隔符。",
        "",
        "发送 `/cancel` 取消；重新发送另一张名片会替换当前选择。",
      ].join("\n"),
    };
  }

  handle({ conversationId, actorOpenId, text }) {
    const content = String(text || "").trim();
    if (/^\/cancel(?:@[^\s]+)?$/i.test(content)) {
      if (!this.has(conversationId)) return { handled: false };
      this.states.delete(conversationId);
      return { handled: true, reply: "已取消通过用户名片登记成员。" };
    }
    if (!this.has(conversationId)) return { handled: false };
    if (content.startsWith("/")) {
      this.states.delete(conversationId);
      return { handled: false };
    }
    const state = this.states.get(conversationId);
    if (state.actorOpenId !== actorOpenId) {
      return { handled: true, reply: "这个成员登记流程属于另一名用户。" };
    }
    state.updatedAtMs = this.now();
    if (!content || /\s/.test(content)) {
      return {
        handled: true,
        reply: "成员目录名无效；请回复一个不含空格或路径分隔符的一级目录名，或发送 `/cancel`。",
      };
    }
    let directoryName;
    try { directoryName = normalizeDirectoryName(content); }
    catch {
      return {
        handled: true,
        reply: "成员目录名无效；请回复一个不含空格或路径分隔符的一级目录名，或发送 `/cancel`。",
      };
    }
    return {
      handled: true,
      action: "add",
      directoryName,
      target: { ...state.target },
    };
  }
}
