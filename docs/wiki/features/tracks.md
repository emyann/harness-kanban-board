---
title: Tracks — the second engine, and why it became an orchestrator
summary: One session for a whole subgraph: how a track is resolved and refused, why every node keeps its own verb and PR, and how a wave of siblings became one isolated subagent each instead of N things in a row.
category: features
kind: explanation
audience: [dev]
read_when: "touching src/track.js, the track branch of the dispatcher tick, the claude-track profile's allow-list, or the runner brief"
covers:
  - path: src/track.js
    sha: 4741b0697555435dcb76768a44ec86e1ef6eb4a0
  - path: src/dispatch.js
    sha: fb85767e0b4b962930ee74c608c5bb0e1bd7ae4f
  - path: src/board.js
    sha: 70992e7f84308320417651ed6c5d309028a4f581
  - path: src/gc.js
    sha: 40672cb7a84da7170be3f5d99df42f326f9dc1e5
related: [architecture/overview, features/harness-profiles, concepts/worker-identity, decisions/adr-004-roles-and-adoption]
generated_at_commit: b20276e
last_refreshed: 2026-08-29
---

# Tracks — the second engine, and why it became an orchestrator

> hkb has two ways to execute a dependency graph. The default is the durable
> one: the tick picks a ready task, spawns a cold session for it, and pays a
> tick of latency plus a re-derived context at every edge. A **track** is the
> other: one session takes a root and everything still blocking it. It was
> introduced as one session doing N nodes *in a row* — which bought latency and
> lost parallelism — and #129 replaced that inner loop with an orchestrator that
> hands each node to its own isolated subagent. The board contract did not move
> an inch, and that is the whole point.

## A track is a view, not an object

`resolveTrack` (`src/track.js`) walks the root's `blockedBy` edges depth-first
and returns `{root, order, nodes, missing, cycle}` — `order` is post-order, so
blockers come before what they block and the root is last. A blocker closed as
completed is skipped (`blockerDone`): finished work is not a node, so **a track
shrinks as it runs** and a resumed track is exactly what is left of it.

Everything in `src/track.js` is pure — a function of the board read the tick
already did, no extra request. That is deliberate: the per-node brief is *not*
built here, because `hkb context <n>` prints the same `workerContext` that
node's cold worker would get, and fetching it when the node starts is cheaper
than paying for N of them up front.

`trackWaves` groups `order` by longest-path depth over in-track edges only.
Nothing in a wave depends on anything else in it, which is what makes a wave
safe to run all at once.

## The refusals are the design

`trackReadiness` answers `{ok, why, waves}`, and **every "no" is a fallback,
never an error**: node dispatch is always available, so anything unusual just
means "dispatch it node by node". A non-track profile, a cycle, a root that is
not `todo`/`ready`, a `kb:needs-human` node, a node with an open PR, a blocker
that is not on this board, a node scheduled for later, a node on a profile
outside `track_agents` (cross-harness tracks are out of scope: one session is
one harness) — and, via `trackAlreadyAttempted`, **a root that has already had
one runner**. That last one is the safety valve: the fast engine gets one go,
then the durable one finishes whatever is left.

`planTracks` runs live tracks first, so the nodes a running runner owns are
`covered` before any pending candidate is judged. `covered` is what tells the
tick not to reclaim, not to claim, and **not to count the slots** of a node
under a live root: a track is one session, so it is one running slot however
many nodes it holds. The `path_overlap` guard uses `trackPaths`, the union of
every node's `kb.paths`, rather than the root's own.

## Every node is still a checkpoint

The safety argument is one sentence: **every node is claimed, worked and
finished with its own terminal verb, and opens its own PR with exactly one
`Closes #<n>`**. So a runner that dies mid-track leaves a board with per-node
truth on it, and the ordinary tick finishes the rest — no new crash semantics,
no new recovery path, and nothing to write for "resume".

One PR per node is not style. A body with two `Closes #` drags the unfinished
node into *review* behind the finished one, where neither the runner nor the
dispatcher can close it properly.

## From N-in-a-row to one subagent per node (#129)

The old brief said, in as many words, *"You execute all N tasks in this one
session … Claim a node when you are about to start it, and end it before you
claim the next."* `trackWaves` already existed; the brief just walked it one
node at a time. A seven-node track therefore carried seven nodes' context in
one window, and two siblings that node dispatch would have run side by side ran
one after the other.

What changed is only the runner's brief and one line of allow-list:

- **`Agent` is on `claude-track` and no other profile** (`CLAUDE_TRACK_TOOLS`,
  `src/board.js`). A worker launches with `--permission-mode dontAsk`, which
  *denies* an unlisted tool rather than prompting, so the allow-list is the
  capability. Cold node workers stay single-agent on purpose: one that could
  fan out would spawn children nothing on the board has claimed.
- **`trackFanout(cfg, profile)`** (`src/track.js`) reads that list, and the
  dispatcher passes its answer to `trackContext` when it builds the track prompt
  (`src/dispatch.js`, the track branch of the tick). A profile without `Agent`
  gets the older node-after-node brief, which is always a correct way to run a
  track — the board reads the same either way.
- **`trackContext({..., fanout: true})`** is an orchestrator brief: claim the
  wave, spawn one subagent per node *in a single message* (sequential spawns are
  a fan-out coat over a sequential track), heartbeat the root while they work,
  verify each node's verb, then the next wave. The root is the one node the
  orchestrator does itself — the integration pass, by the only participant that
  has read every subagent's report.

### What the spike established (Claude Code 2.1.251, job `cadca6f1`)

These are measured facts about the harness, not code you can read here — which
is exactly why they are written down:

- A `--bg --worktree` root under `dontAsk` spawns an isolated subagent the
  moment `Agent` is allow-listed. Nothing else was needed.
- The child's checkout is `.claude/worktrees/agent-<id>` **at the repo level** —
  a sibling of `kb-<n>-<k>`, not nested — and is **removed with its branch when
  the subagent returns unchanged**. A subagent that committed keeps its
  worktree, with `kb/<n>` checked out, until `hkb gc` clears it — which it now
  does once that branch's PR is merged or closed (`agentWorktreeNode`/
  `sweepAgentWorktrees`, `src/gc.js`). Hence the brief's *commit and push before
  you return*. The name is the harness's, so `parseWorktreeName` can never
  identify the node from the checkout; the brief passes `<n>` explicitly.
- The child inherits the root's `CLAUDE_CODE_SESSION_ID` and `CLAUDE_JOB_DIR`,
  so a node finished from inside a subagent stamps the *runner's* session and
  the counted-once rule in `docs/harnesses.md` still holds.
- The launch's `--settings` hooks fire inside children — `PreToolUse` with
  `agent_id` set and `cwd` in the child worktree — so the permission policy
  holds all the way down. `SubagentStop` fires for the child, `Stop` for the
  root only.
- The worktree-isolation guard refuses compound and `$VAR` commands in root and
  child alike (`a; b`, `echo "$VAR"`). Both briefs therefore say: one command
  per Bash call, `printenv` for the environment.
- The root's turn **ends while its subagents are still running**, and `Stop`
  fires at that moment. Left alone the Stop hook would nudge for a terminal verb
  mid-wave; #163 taught it to stand aside while a subagent of the attempt is
  live (see `concepts/worker-identity`).

## Known gaps

- **The verb check is brief-level, not enforced.** The Stop nudge keys on
  `KB_TASK`, which is the root, so it never fires for a child. The orchestrator
  is told to read `hkb show <n> --json` after each wave and file or block a node
  its subagent left `running`. If it does not, the node is simply a stale claim
  the ordinary dispatcher reclaims after `stale_after` — the failure mode is
  latency, not corruption.
- **`hkb stats` under-reports a fanned-out track.** A subagent's usage goes to a
  sidecar transcript (`…/<session>/subagents/agent-<id>.jsonl`) that
  `usageFromTranscript` never opens (#155). Whether `--max-budget-usd` counts
  subagent tokens is unmeasured; `claude-track` launches with `50` on the
  assumption that it does.
- **Disjoint `kb.paths` are what make a wave safe**, and nothing at wave time
  re-checks them — `/kanban:decompose` enforces disjointness when the graph is
  built. A hand-written graph with overlapping paths will have siblings fighting
  over the same files in different worktrees.
- **A `--bg` root longer than `stale_after` (3600s) with the wrong beat is reclaimed while its
  subagents are still live.** The tick applies `stale_after` to the running attempt and then falls
  back to the lock-ref beat (`src/dispatch.js`); a root parked waiting on a node has nothing writing
  that beat unless the node itself does, since `ScheduleWakeup` is not on the orchestrator's
  allow-list and it cannot wake itself to heartbeat. The per-node brief tells every subagent to run
  `hkb heartbeat <root>` (not its own number) every ~10 minutes for exactly this reason
  (`casHeartbeat`, `src/lock.js`). The beat defends only against `stale_after`: the tick checks the root's
  `max_runtime` first (`src/dispatch.js`, default 3600 s) and times the root out regardless of beats, so a
  track root also needs `kb.max_runtime` larger than the whole track — heartbeat is necessary, not sufficient — but, like the verb check above, it is brief-level: a subagent
  that skips it leaves the whole track exposed to reclaim past the hour mark, uncovering every node
  for a cold worker.
- **A daemon-leaked `KB_TASK` in a child resolves to the wrong task.** `subagentStopHook`'s
  `attemptIdentity` accepts an environment with `profile: null` rather than falling back to
  `CLAUDE_PROJECT_DIR`, so a `KB_TASK` leaked into a child's environment by the daemon (#150) makes
  the hook resolve the leaked task instead of the track root, suppressing the root's own `Stop` up to
  `MAX_SUPPRESSED_STOPS`.
