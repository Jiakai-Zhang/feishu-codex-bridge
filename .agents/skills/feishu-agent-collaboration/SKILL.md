---
name: feishu-agent-collaboration
description: Delegate or hand off work in the current repository to a trusted teammate Agent through its bound Feishu collaboration group. Use when a user asks in natural language to collaborate, ask another member or Agent to continue work, synchronize the current branch for a teammate, request peer implementation or review, or send a Git-backed task to another Agent. Do not use for ordinary local-only work, another repository, or casual conversation that does not request another Agent.
---

# Feishu Agent Collaboration

Turn an explicit collaboration request into a durable Bridge inbox item. This repository is bound to exactly one Feishu group, one local Bridge Project, and one shared GitHub repository.

## Workflow

1. Inspect the current worktree, intended handoff scope, branch, and `git status --short`.
2. Never include unrelated dirty changes. If requested work is not committed, create a focused commit only when the user's handoff request authorizes committing that work; otherwise ask first.
3. Select the named peer Agent. Do not guess if more than one peer could match.
4. Select the receiver landing mode:
   - `manual`: the receiving human chooses an existing conversation, an existing worktree with a new conversation, or a new worktree and conversation.
   - `recommend`: default; the receiving Agent recommends a safe landing and waits for confirmation.
   - `auto`: only when the user asks the receiving Agent to take over automatically.
5. Select `resultMode`: use `notify` by default; use `resume` only when the user explicitly wants the originating Codex conversation resumed with the peer result.
6. Submit one JSON object on stdin to `scripts/delegate.mjs`. Do not include secrets, absolute paths, hidden reasoning, or complete chat history in the task prompt.

Example input:

```json
{
  "peerAgentId": "teammate-codex",
  "title": "Add focused login tests",
  "prompt": "Continue from the synchronized commit, add focused login tests, run them, and return the commit and evidence.",
  "receiveMode": "recommend",
  "gitSyncMode": "push",
  "resultMode": "notify"
}
```

Run the script from the active Project worktree. Pass JSON through stdin and use the absolute script path shown for this loaded skill:

```powershell
$request | ConvertTo-Json -Depth 5 -Compress |
  node "<skill-directory>\scripts\delegate.mjs" --cwd (Get-Location).Path --wait-ms 10000
```

Treat the returned status precisely:

- `delivered`: Git was synchronized and the task was published.
- `queued`: the request is durable, but the Bridge has not acknowledged it yet.
- `blocked` or `error`: report the stated reason; do not claim the peer received anything.

## Safety boundaries

- Never force-push, reset, clean, merge, delete a worktree, or push a protected default branch.
- Never send uncommitted changes as though Git contained them.
- The Bridge independently verifies the bound group, local Project, shared GitHub repository, sender, Git ref, commit, expiry, and receiver policy.
- A peer's local Project ID, absolute paths, and Codex conversation IDs are private and must not be used as cross-machine identity.
