const RECEIVE_MODES = ["manual", "recommend", "auto"];
const LANDINGS = new Set(["existing-thread", "new-thread", "new-worktree"]);

export function effectiveReceiveMode(requested, local) {
  const requestedIndex = RECEIVE_MODES.indexOf(requested);
  const localIndex = RECEIVE_MODES.indexOf(local);
  if (requestedIndex < 0 || localIndex < 0) throw new TypeError("Receive mode must be manual, recommend, or auto");
  return RECEIVE_MODES[Math.min(requestedIndex, localIndex)];
}

export function buildLandingPlan({ branch, threads = [], snapshot }) {
  if (typeof branch !== "string" || !branch.trim()) throw new TypeError("A task branch is required");
  if (!snapshot || !Array.isArray(snapshot.worktrees)) throw new TypeError("A Project snapshot is required");
  const branchThreads = threads
    .filter((thread) => thread?.id && thread?.worktree?.branch === branch)
    .sort((left, right) => Number(right.updated_at_ms || 0) - Number(left.updated_at_ms || 0));
  const worktree = snapshot.worktrees.find((candidate) => candidate.branch === branch);
  const options = branchThreads.map((thread) => ({
    landing: "existing-thread",
    threadId: thread.id,
    worktreePath: thread.worktree.path,
    title: thread.title,
  }));
  if (worktree) options.push({ landing: "new-thread", worktreePath: worktree.path });
  else options.push({ landing: "new-worktree" });
  const recommendation = options[0];
  return { branch, worktree, threads: branchThreads, options, recommendation };
}

export function resolveLandingChoice(plan, choice = "auto") {
  if (!plan?.recommendation || !Array.isArray(plan.options)) throw new TypeError("A landing plan is required");
  const normalized = String(choice || "auto").trim();
  if (normalized === "auto") return { ...plan.recommendation };
  if (normalized.startsWith("thread:")) {
    const threadId = normalized.slice("thread:".length);
    const selected = plan.options.find((option) => option.landing === "existing-thread" && option.threadId === threadId);
    if (!selected) throw new Error(`Thread ${threadId} is not a valid task landing for branch ${plan.branch}`);
    return { ...selected };
  }
  const aliases = {
    worktree: "new-thread",
    "new-thread": "new-thread",
    new: "new-worktree",
    "new-worktree": "new-worktree",
  };
  const landing = aliases[normalized];
  if (!LANDINGS.has(landing)) throw new TypeError("Invalid task landing choice");
  const selected = plan.options.find((option) => option.landing === landing);
  if (!selected) throw new Error(`${landing} is not available for branch ${plan.branch}`);
  return { ...selected };
}
