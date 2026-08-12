import { promises as fs } from "node:fs";
import path from "node:path";

const MAX_TASKS = 500;
const MAX_EVENT_IDS = 4000;
const LANDINGS = new Set(["existing-thread", "new-thread", "new-worktree"]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertTaskFlow(task, event, peer) {
  if (task.peerAgentId !== peer.agentId) throw new Error("Task peer identity does not match the authenticated sender");
  if (task.groupChatId !== event.groupChatId) throw new Error("Task Feishu group cannot change across events");
  if (task.githubRepository !== event.githubRepository) throw new Error("Task GitHub repository cannot change across events");
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
  if (event.kind === "task.accepted") {
    task.state = "accepted";
    task.remoteLanding = event.payload.landing;
  }
  if (event.kind === "task.progress") {
    task.state = "running";
    task.lastProgress = event.payload.message;
  }
  if (event.kind === "task.result") {
    task.state = "completed";
    task.result = event.payload.summary;
    task.resultGit = event.payload.git;
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

function migrateSaved(saved) {
  if (saved?.schemaVersion === 2 && Array.isArray(saved.tasks) && Array.isArray(saved.seenEventIds)) return saved;
  if (saved?.schemaVersion === 1 && Array.isArray(saved.tasks) && Array.isArray(saved.seenEventIds)) {
    return {
      schemaVersion: 2,
      tasks: saved.tasks.map((task) => ({
        ...task,
        legacyProjectId: task.projectId,
        groupChatId: task.chatId,
        requestGit: task.branch ? { branch: task.branch } : undefined,
      })),
      seenEventIds: saved.seenEventIds,
    };
  }
  throw new Error("Team task store has an unsupported schema");
}

export class TeamTaskStore {
  static async open(filePath, { now = Date.now } = {}) {
    let saved = { schemaVersion: 2, tasks: [], seenEventIds: [] };
    try { saved = migrateSaved(JSON.parse(await fs.readFile(filePath, "utf8"))); }
    catch (error) {
      if (error?.code !== "ENOENT") throw new Error(`Team task store is unreadable: ${error.message}`);
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

  async createOutboundRequest(event, {
    peer,
    chatId,
    requesterHumanOpenId,
    sourceThreadId,
    localProjectId,
  }) {
    if (event.kind !== "task.request") throw new TypeError("Outbound task creation requires task.request");
    if (event.groupChatId !== chatId) throw new Error("Outbound task chat does not match its Agent event");
    if (this.tasks.has(event.taskId)) throw new Error(`Task ${event.taskId} already exists`);
    const task = {
      taskId: event.taskId,
      direction: "outbound",
      state: "requested",
      localProjectId,
      groupChatId: event.groupChatId,
      githubRepository: event.githubRepository,
      title: event.payload.title,
      prompt: event.payload.prompt,
      receiveMode: event.payload.receiveMode,
      resultMode: event.payload.resultMode,
      requestGit: event.payload.git,
      branch: event.payload.git.branch,
      requesterAgentId: event.requesterAgentId,
      executorAgentId: event.executorAgentId,
      peerAgentId: peer.agentId,
      peerBotOpenId: peer.botOpenId,
      peerHumanOpenId: peer.humanOpenId,
      chatId,
      requesterHumanOpenId,
      sourceThreadId,
      createdAt: event.createdAt,
      updatedAt: this.now(),
      lastEventKind: event.kind,
    };
    this.tasks.set(task.taskId, task);
    this.rememberEvent(event.eventId);
    await this.persist();
    return clone(task);
  }

  async recordInboundEvent(event, { peer, chatId, localProjectId }) {
    if (event.groupChatId !== chatId) throw new Error("Inbound task chat does not match its Agent event");
    if (this.seenEventIds.has(event.eventId)) return { duplicate: true, task: this.get(event.taskId) };
    let task = this.tasks.get(event.taskId);
    if (event.kind === "task.request") {
      if (task) {
        const sameRequest = task.direction === "inbound"
          && task.peerAgentId === peer.agentId
          && task.groupChatId === event.groupChatId
          && task.githubRepository === event.githubRepository
          && task.title === event.payload.title
          && task.prompt === event.payload.prompt
          && JSON.stringify(task.requestGit) === JSON.stringify(event.payload.git);
        if (!sameRequest) throw new Error(`Task ${event.taskId} was requested more than once with different content`);
        this.rememberEvent(event.eventId);
        await this.persist();
        return { duplicate: true, task: clone(task) };
      }
      task = {
        taskId: event.taskId,
        direction: "inbound",
        state: "pending",
        localProjectId,
        groupChatId: event.groupChatId,
        githubRepository: event.githubRepository,
        title: event.payload.title,
        prompt: event.payload.prompt,
        receiveMode: event.payload.receiveMode,
        resultMode: event.payload.resultMode,
        requestGit: event.payload.git,
        branch: event.payload.git.branch,
        requesterAgentId: event.requesterAgentId,
        executorAgentId: event.executorAgentId,
        peerAgentId: peer.agentId,
        peerBotOpenId: peer.botOpenId,
        peerHumanOpenId: peer.humanOpenId,
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

  async setLandingRecommendation(taskId, recommendation) {
    const task = this.requireTask(taskId, "inbound");
    if (task.state !== "pending" && task.state !== "blocked") {
      throw new Error(`Task ${taskId} cannot receive a landing recommendation from ${task.state}`);
    }
    if (!recommendation || !LANDINGS.has(recommendation.landing)) throw new TypeError("Invalid landing recommendation");
    task.landingRecommendation = clone(recommendation);
    task.updatedAt = this.now();
    await this.persist();
    return clone(task);
  }

  async acceptInbound(taskId, approvedByOpenId, { landing, targetThreadId } = {}) {
    const task = this.requireTask(taskId, "inbound");
    if (landing && !LANDINGS.has(landing)) throw new TypeError("Invalid task landing");
    if (task.state === "accepted" && task.approvedByOpenId === approvedByOpenId
      && task.landing === landing && task.targetThreadId === targetThreadId) return clone(task);
    if (task.state !== "pending" && task.state !== "blocked") throw new Error(`Task ${taskId} cannot be accepted from ${task.state}`);
    task.state = "accepted";
    task.approvedByOpenId = approvedByOpenId;
    task.landing = landing || task.landingRecommendation?.landing;
    task.targetThreadId = targetThreadId || task.landingRecommendation?.threadId;
    task.updatedAt = this.now();
    await this.persist();
    return clone(task);
  }

  async markRunning(taskId, { threadId, worktree, branch, landing } = {}) {
    const task = this.requireTask(taskId, "inbound");
    if (!new Set(["accepted", "running", "blocked"]).has(task.state)) throw new Error(`Task ${taskId} cannot run from ${task.state}`);
    task.state = "running";
    if (threadId) task.localThreadId = threadId;
    if (worktree) task.localWorktree = worktree;
    if (branch) task.localBranch = branch;
    if (landing) task.landing = landing;
    task.updatedAt = this.now();
    await this.persist();
    return clone(task);
  }

  async markCompleted(taskId, summary, { git } = {}) {
    const task = this.requireTask(taskId, "inbound");
    if (!new Set(["accepted", "running", "blocked"]).has(task.state)) throw new Error(`Task ${taskId} cannot complete from ${task.state}`);
    task.state = "completed";
    task.result = summary;
    if (git) task.resultGit = clone(git);
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
      schemaVersion: 2,
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
