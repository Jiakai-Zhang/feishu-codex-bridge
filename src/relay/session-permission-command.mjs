import { SESSION_SANDBOX_MODES } from "../persistence/session-relay-settings.mjs";

const CONFIRM_WINDOW_MS = 5 * 60 * 1000;
const SANDBOX_MODE_SET = new Set(SESSION_SANDBOX_MODES);
const MODE_ALIASES = new Map([
  ["inherit", "inherit"],
  ["default", "inherit"],
  ["read-only", "read-only"],
  ["readonly", "read-only"],
  ["read", "read-only"],
  ["workspace-write", "workspace-write"],
  ["workspace", "workspace-write"],
  ["write", "workspace-write"],
  ["danger-full-access", "danger-full-access"],
  ["full-access", "danger-full-access"],
  ["full", "danger-full-access"],
]);

export class SessionPermissionError extends Error {
  constructor(code, publicMessage) {
    super(publicMessage);
    this.name = "SessionPermissionError";
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export function effectiveSessionSandboxMode(configuredMode, defaultSandboxMode) {
  const configured = SANDBOX_MODE_SET.has(configuredMode) ? configuredMode : "inherit";
  if (configured !== "inherit") return configured;
  if (!SANDBOX_MODE_SET.has(defaultSandboxMode) || defaultSandboxMode === "inherit") {
    throw new TypeError("A concrete Bridge default sandbox mode is required");
  }
  return defaultSandboxMode;
}

export function sessionSandboxModeLabel(mode) {
  switch (mode) {
    case "read-only": return "只读";
    case "workspace-write": return "工作区写入";
    case "danger-full-access": return "完全访问";
    case "inherit": return "继承 Bridge 主机默认";
    default: return "未知";
  }
}

export function parseSessionPermissionAction(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text || text === "status") return Object.freeze({ action: "status" });
  if (text === "confirm") return Object.freeze({ action: "confirm" });
  if (text === "cancel") return Object.freeze({ action: "cancel" });
  const mode = MODE_ALIASES.get(text);
  if (mode) return Object.freeze({ action: "set", mode });
  throw new SessionPermissionError(
    "permission_usage",
    "用法：`/permissions`、`/permissions inherit|read-only|workspace-write|danger-full-access`、`/permissions confirm` 或 `/permissions cancel`。",
  );
}

export function formatSessionPermission(settings, defaultSandboxMode, { changed = false } = {}) {
  const configuredMode = SANDBOX_MODE_SET.has(settings?.sandboxMode) ? settings.sandboxMode : "inherit";
  const effectiveMode = effectiveSessionSandboxMode(configuredMode, defaultSandboxMode);
  const lines = [
    `### Session 权限${changed ? "已更新" : ""}`,
    "",
    `- 当前权限：${sessionSandboxModeLabel(effectiveMode)}（\`${effectiveMode}\`）`,
    `- 设置来源：${configuredMode === "inherit" ? `继承 Bridge 主机默认（\`${defaultSandboxMode}\`）` : "当前 Session 独立设置"}`,
    "- 生效范围：仅当前 Session 的后续 Turn",
    "",
    "命令：`/permissions inherit|read-only|workspace-write|danger-full-access`",
    "",
    "> 修改不会影响正在运行的 Turn，也不会改动其他 Session、Bridge 全局配置或代理。",
  ];
  if (effectiveMode === "danger-full-access") {
    lines.push(
      "",
      "> ⚠️ 完全访问会让 Bridge 启动的 Codex Turn 在无需审批的情况下使用当前系统账户可访问的文件与命令；共享群成员提交的 Prompt 也使用这一权限边界。",
    );
  }
  return lines.join("\n");
}

function permissionChangeBusy(status) {
  return status?.status?.type === "active" || status?.goal?.status === "active";
}

async function assertPermissionChangeReady(controller, threadId) {
  const status = await controller.getStatus(threadId);
  if (permissionChangeBusy(status)) {
    throw new SessionPermissionError(
      "permission_change_busy",
      "当前 Session 正在回答或运行 Goal。请先使用 `/stop` 或 `/goal pause`，等待 `/status` 显示空闲后再修改权限。",
    );
  }
  if (status?.status?.type !== "idle") {
    throw new SessionPermissionError(
      "permission_change_unavailable",
      "当前 Session 尚未处于可安全修改权限的空闲状态。请先查看 `/status`，恢复连接后重试。",
    );
  }
}

export class SessionPermissionFlow {
  constructor({ now = () => Date.now(), confirmWindowMs = CONFIRM_WINDOW_MS } = {}) {
    this.now = now;
    this.confirmWindowMs = confirmWindowMs;
    this.pending = new Map();
  }

  #confirmationKey({ threadId, senderOpenId, conversationId }) {
    const values = [threadId, senderOpenId, conversationId].map((value) => String(value || ""));
    if (values.some((value) => !value)) {
      throw new TypeError("Permission confirmation requires Session, sender, and conversation context");
    }
    return JSON.stringify(values);
  }

  #pruneExpired() {
    const now = this.now();
    for (const [key, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(key);
    }
  }

  async #persistMode(settingsStore, threadId, mode) {
    const previousMode = settingsStore.get(threadId).sandboxMode;
    try {
      return await settingsStore.update(threadId, { sandboxMode: mode });
    } catch (error) {
      // The shared settings store updates its in-memory snapshot before the
      // durable write. Restore the old security boundary even if that write
      // fails, so a failed command can never leave a silent privilege change.
      try { await settingsStore.update(threadId, { sandboxMode: previousMode }); }
      catch {}
      throw error;
    }
  }

  cancel(context) {
    this.#pruneExpired();
    return this.pending.delete(this.#confirmationKey(context));
  }

  async execute(command, context = {}) {
    if (command?.name !== "permissions") throw new TypeError("A parsed permissions command is required");
    if (!context.isSessionOwner) {
      throw new SessionPermissionError(
        "permission_owner_required",
        "只有当前 Session 的所有者可以修改它的权限。",
      );
    }
    const { controller, settingsStore, threadId, defaultSandboxMode } = context;
    if (!controller || !settingsStore || !threadId) {
      throw new TypeError("Permission command requires a controller, settings store, and threadId");
    }
    const request = parseSessionPermissionAction(command.args);
    const key = this.#confirmationKey(context);
    this.#pruneExpired();

    if (request.action === "status") {
      return formatSessionPermission(settingsStore.get(threadId), defaultSandboxMode);
    }
    if (request.action === "cancel") {
      const cancelled = this.pending.delete(key);
      return cancelled
        ? "### 权限修改已取消\n\n当前 Session 权限没有变化。"
        : "### 没有待确认的权限修改\n\n当前 Session 权限没有变化。";
    }
    if (request.action === "confirm") {
      const pending = this.pending.get(key);
      if (!pending || pending.expiresAt <= this.now()) {
        this.pending.delete(key);
        throw new SessionPermissionError(
          "permission_confirmation_missing",
          "没有有效的完全访问确认请求。请先发送 `/permissions danger-full-access`；若主机默认就是完全访问，发送 `/permissions inherit`。",
        );
      }
      await assertPermissionChangeReady(controller, threadId);
      const updated = await this.#persistMode(settingsStore, threadId, pending.mode);
      this.pending.delete(key);
      return formatSessionPermission(updated, defaultSandboxMode, { changed: true });
    }

    const current = settingsStore.get(threadId);
    if (current.sandboxMode === request.mode) {
      this.pending.delete(key);
      return formatSessionPermission(current, defaultSandboxMode);
    }
    await assertPermissionChangeReady(controller, threadId);
    const effectiveTarget = effectiveSessionSandboxMode(request.mode, defaultSandboxMode);
    if (effectiveTarget !== "danger-full-access") {
      this.pending.delete(key);
      const updated = await this.#persistMode(settingsStore, threadId, request.mode);
      return formatSessionPermission(updated, defaultSandboxMode, { changed: true });
    }

    const humanMemberCount = Math.max(1, Number(context.humanMemberCount) || 1);
    this.pending.set(key, {
      mode: request.mode,
      expiresAt: this.now() + this.confirmWindowMs,
    });
    return [
      "### ⚠️ 确认完全访问",
      "",
      "完全访问会让当前 Session 之后由 Bridge 启动的 Codex Turn 在无需审批的情况下执行命令，并可能访问当前系统账户可访问的文件、系统凭据存储与其他敏感数据。",
      humanMemberCount > 1
        ? `当前群有 ${humanMemberCount} 名人类成员；其他已授权成员之后提交的 Prompt 也会使用完全访问。`
        : "当前设置只作用于这个 Session，不改动其他 Session 或 Bridge 全局默认。",
      "",
      "如确认承担这一风险，请在 5 分钟内发送：`/permissions confirm`",
      "",
      "发送 `/permissions cancel` 可取消。",
    ].join("\n");
  }
}
