import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_TASKS = 500;
const MAX_EVENT_IDS = 4000;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertTaskFlow(task, event, peer) {
  if (task.peerAgentId !== peer.agentId) throw new Error("Task peer identity does not match the authenticated sender");
  if (task.projectId !== event.projectId) throw new Error("Task Project cannot change across events");
  if (task.requesterAgentId !== event.requesterAgentId || task.executorAgentId !== event.executorAgentId) {
    throw new Error("Task ownership cannot change across events");
  }
}

function applyExecutorEvent(task, event) {
  const allowed = {
    requested: new Set(["task.accepted", "task.progress", "task.result", "task.blocked", "task.rejected"]),
    accepted: new Set(["task.progress", "task.result", "task.blocked", "task.rejected"]),
    running: new Set(["task.progress", "task.result", "task.blocked"]),
    blocked: new Set(["task.accepted", "task.progress", "task.result", "task.rejected"]),
  };
  if (!allowed[task.state]?.has(event.kind)) throw new Error(`Invalid outbound task transition ${task.state} -> ${event.kind}`);
  if (event.kind === "task.accepted") task.state = "accepted";
  if (event.kind === "task.progress") {
    task.state = "running";
    task.lastProgress = event.payload.message;
  }
  if (event.kind === "task.result") {
    task.state = "completed";
    task.result = event.payload.summary;
    task.remoteThreadId = event.payload.threadId;
  }
  if (event.kind === "task.blocked") {
    task.state = "blocked";
    task.reason = event.payload.reason;
  }
  if (event.kind === "task.rejected") {
    task.state = "rejected";
    task.reason = event.payload.reason;
  }
}

export class TeamTaskStore {
  static async open(filePath, { now = Date.now } = {}) {
    let saved = { schemaVersion: 1, tasks: [], seenEventIds: [] };
    try { saved = JSON.parse(await fs.readFile(filePath, "utf8")); }
    catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Team task store is unreadable: ${error.message}`);
    }
    if (saved?.schemaVersion !== 1 || !Array.isArray(saved.tasks) || !Array.isArray(saved.seenEventIds)) {
      throw new Error("Team task store has an unsupported schema");
    }
    return new TeamTaskStore(filePath, saved, { now });
  }

  constructor(filePath, saved, { now = Date.now } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.tasks = new Map(saved.tasks.map((task) => [task.taskId, task]));
    this.seenEventIds = new Set(saved.seenEventIds);
    this.writeTail = Promise.resolve();
  }

  get(taskId) {
    return clone(this.tasks.get(taskId));
  }

  list({ direction, state, limit = 50 } = {}) {
    return [...this.tasks.values()]
      .filter((task) => !direction || task.direction === direction)
      .filter((task) => !state || task.state === state)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit)
      .map(clone);
  }

  async createOutboundRequest(event, { peer, chatId, requesterHumanOpenId }) {
    if (event.kind !== "task.request") throw new TypeError("Outbound task creation requires task.request");
    if (this.tasks.has(event.taskId)) throw new Error(`Task ${event.taskId} already exists`);
    const task = {
      taskId: event.taskId,
      direction: "outbound",
      state: "requested",
      projectId: event.projectId,
      title: event.payload.title,
      prompt: event.payload.prompt,
      branch: event.payload.branch,
      requesterAgentId: event.requesterAgentId,
      executorAgentId: event.executorAgentId,
      peerAgentId: peer.agentId,
      peerBotOpenId: peer.botOpenId,
      chatId,
      requesterHumanOpenId,
      createdAt: event.createdAt,
      updatedAt: this.now(),
      lastEventKind: event.kind,
    };
    this.tasks.set(task.taskId, task);
    this.rememberEvent(event.eventId);
    await this.persist();
    return clone(task);
  }

  async recordInboundEvent(event, { peer, chatId }) {
    if (this.seenEventIds.has(event.eventId)) return { duplicate: true, task: this.get(event.taskId) };
    let task = this.tasks.get(event.taskId);
    if (event.kind === "task.request") {
      if (task) {
        const sameRequest = task.direction === "inbound"
          && task.peerAgentId === peer.agentId
          && task.projectId === event.projectId
          && task.title === event.payload.title
          && task.prompt === event.payload.prompt
          && task.branch === event.payload.branch;
        if (!sameRequest) throw new Error(`Task ${event.taskId} was requested more than once with different content`);
        this.rememberEvent(event.eventId);
        await this.persist();
        return { duplicate: true, task: clone(task) };
      }
      task = {
        taskId: event.taskId,
        direction: "inbound",
        state: "pending",
        projectId: event.projectId,
        title: event.payload.title,
        prompt: event.payload.prompt,
        branch: event.payload.branch,
        requesterAgentId: event.requesterAgentId,
        executorAgentId: event.executorAgentId,
        peerAgentId: peer.agentId,
        peerBotOpenId: peer.botOpenId,
        chatId,
        createdAt: event.createdAt,
        updatedAt: this.now(),
        lastEventKind: event.kind,
      };
      this.tasks.set(task.taskId, task);
    } else {
      if (!task) throw new Error(`Unknown task ${event.taskId}`);
      assertTaskFlow(task, event, peer);
      if (event.kind === "task.approved") {
        if (task.direction !== "inbound" || task.state !== "completed") {
          throw new Error(`Invalid inbound task transition ${task.state} -> task.approved`);
        }
        task.state = "approved";
        task.approvalNote = event.payload.note;
      } else {
        if (task.direction !== "outbound") throw new Error("Executor updates require an outbound task");
        applyExecutorEvent(task, event);
      }
      task.updatedAt = this.now();
      task.lastEventKind = event.kind;
    }
    this.rememberEvent(event.eventId);
    await this.persist();
    return { duplicate: false, task: clone(task) };
  }

  async acceptInbound(taskId, approvedByOpenId) {
    const task = this.requireTask(taskId, "inbound");
    if (task.state === "accepted" && task.approvedByOpenId === approvedByOpenId) return clone(task);
    if (task.state !== "pending" && task.state !== "blocked") throw new Error(`Task ${taskId} cannot be accepted from ${task.state}`);
    task.state = "accepted";
    task.approvedByOpenId = approvedByOpenId;
    task.updatedAt = this.now();
    await this.persist();
    return clone(task);
  }

  async markRunning(taskId, { threadId, worktree, branch } = {}) {
    const task = this.requireTask(taskId, "inbound");
    if (!new Set(["accepted", "running", "blocked"]).has(task.state)) throw new Error(`Task ${taskId} cannot run from ${task.state}`);
    task.state = "running";
    if (threadId) task.localThreadId = threadId;
    if (worktree) task.localWorktree = worktree;
    if (branch) task.branch = branch;
    task.updatedAt = this.now();
    await this.persist();
    return clone(task);
  }

  async markCompleted(taskId, summary) {
    const task = this.requireTask(taskId, "inbound");
    if (!new Set(["accepted", "running", "blocked"]).has(task.state)) throw new Error(`Task ${taskId} cannot complete from ${task.state}`);
    task.state = "completed";
    task.result = summary;
    task.updatedAt = this.now();
    await this.persist();
    return clone(task);
  }

  async markBlocked(taskId, reason) {
    const task = this.requireTask(taskId, "inbound");
    if (!new Set(["accepted", "running"]).has(task.state)) throw new Error(`Task ${taskId} cannot block from ${task.state}`);
    task.state = "blocked";
    task.reason = reason;
    task.updatedAt = this.now();
    await this.persist();
    return clone(task);
  }

  async rejectInbound(taskId, reason, rejectedByOpenId) {
    const task = this.requireTask(taskId, "inbound");
    if (task.state === "rejected" && task.reason === reason && task.rejectedByOpenId === rejectedByOpenId) return clone(task);
    if (!new Set(["pending", "accepted", "blocked"]).has(task.state)) throw new Error(`Task ${taskId} cannot be rejected from ${task.state}`);
    task.state = "rejected";
    task.reason = reason;
    task.rejectedByOpenId = rejectedByOpenId;
    task.updatedAt = this.now();
    await this.persist();
    return clone(task);
  }

  async approveOutbound(taskId, note, approvedByOpenId) {
    const task = this.requireTask(taskId, "outbound");
    if (task.state === "approved" && task.approvalNote === note && task.approvedByOpenId === approvedByOpenId) return clone(task);
    if (task.state !== "completed") throw new Error(`Task ${taskId} cannot be approved from ${task.state}`);
    task.state = "approved";
    task.approvalNote = note;
    task.approvedByOpenId = approvedByOpenId;
    task.updatedAt = this.now();
    await this.persist();
    return clone(task);
  }

  requireTask(taskId, direction) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    if (direction && task.direction !== direction) throw new Error(`Task ${taskId} is not ${direction}`);
    return task;
  }

  rememberEvent(eventId) {
    this.seenEventIds.add(eventId);
    while (this.seenEventIds.size > MAX_EVENT_IDS) this.seenEventIds.delete(this.seenEventIds.values().next().value);
  }

  async persist() {
    const tasks = [...this.tasks.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_TASKS);
    this.tasks = new Map(tasks.map((task) => [task.taskId, task]));
    const snapshot = JSON.stringify({
      schemaVersion: 1,
      tasks,
      seenEventIds: [...this.seenEventIds],
    }, null, 2);
    this.writeTail = this.writeTail.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(this.filePath, snapshot, "utf8");
    });
    await this.writeTail;
  }
}
