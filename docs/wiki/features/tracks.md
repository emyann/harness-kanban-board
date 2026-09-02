---
title: Tracks — the second engine, and why it became an orchestrator
summary: One session for a whole subgraph: how a root is inferred from the graph, how a track is resolved and refused, why every node keeps its own verb and PR, and how a wave of siblings became one isolated subagent each instead of N things in a row.
category: features
kind: explanation
audience: [dev]
read_when: "touching src/track.js, isTrackRoot, the track branch of the dispatcher tick, the claude-track profile's allow-list, or the runner brief"
covers:
  - path: src/model.js
    sha: 4e63d8cb11f662324cd2f2d4888b471e980db053
  - path: src/track.js
    sha: 054947b027ccb0313f31e5170b67b065aa9d99ed
  - path: src/dispatch.js
    sha: 18a622a26529bfb3b7a16cacc44f1079eee4cfb8
  - path: src/init.js
    sha: ef82ab4c5a872e8bfda06227c8ae1ae9812eeaa3
  - path: src/board.js
    sha: 28238d1670e4c6c0807b0113adb47a8a40069b37
  - path: src/gc.js
    sha: 04d99352d5029211f2a3c9ae8d591bcbab4aa366
  - path: src/tasks.js
    sha: 8542b5c7d4905306e774b95db8b8dcd4390b2748
  - path: src/doctor.js
    sha: 9625ca70f81eb363002a01afbe515b540ee81d9a
  - path: src/lock.js
    sha: e9920df913b5e6cd8a648dad6e679cf4a41a6a1a
related: [architecture/overview, features/harness-profiles, features/review-loop, concepts/worker-identity, decisions/adr-004-roles-and-adoption]
generated_at_commit: 1590a97
last_refreshed: 2026-09-01
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

## Who is a root: the graph decides, the label overrides (#161)

A track used to be a per-goal choice a human made *after* `/kanban:decompose`
(`hkb adopt <root> --agent claude-track`), and the label history said how that
went: three applications ever, all by hand, every other decomposed goal running
node-by-node because nobody typed it. The flag existed because tracks were
sequential (#40), so node dispatch was genuinely faster for independent
siblings; #129 removed that reason. With that gone the mode is a property of the
**graph**, so it is inferred:

`isTrackRoot(task, cfg, {board})` (`src/model.js`, pure) answers
`{track, mode, why, profile, children}` with one of four modes:

| mode | when | runs as |
|---|---|---|
| `forced` | the card's own profile has `"track": true` | a track, even with nothing blocking it (`trackReadiness` then refuses in its own words) |
| `opted-out` | the card carries `kb:no-track` | node dispatch |
| `inferred` | it has ≥1 unfinished child, nothing on the board is still blocked by *it*, and some track profile's `track_agents` can execute its own profile | a track, on **that** profile |
| `none` | anything else — a leaf, a root whose children are all done, a profile no track profile can run | node dispatch |

Two consequences worth holding on to. **The label is never rewritten**: an
inferred root keeps `kb:agent:claude` and runs on `claude-track`, because that
label is what node dispatch reads on every fallback — so the tick takes the
launch profile from the decision (`cand.profile`), and counts the running
track's slot against that profile's cap rather than the card's
(`plan.profiles`, `src/dispatch.js`). And **only the outermost root is
inferred**: in `41 → 42 → 26`, `#42` has an unfinished child too, but `#26` is
still blocked by it, so it is a node of the bigger track and not a candidate of
its own. That check needs the whole board, which is why `board` is a parameter —
`hkb show`, which reads one issue, answers without it and says only what the
card is in isolation.

`hkb track <n>` is the command for all of this: it prints the verdict and its
reason, and `--off`/`--on` toggle `kb:no-track`. That label is created by
`hkb init` alongside the statuses (`src/init.js`) and checked by `hkb doctor`'s
`labels` line, so a board set up before inference landed is told to re-run init
rather than left with an opt-out that only exists once someone hand-makes it in
the GitHub UI. `hkb doctor` warns when a board
holds cards with unfinished children and no profile with `"track": true` to send
them to (`checkTrackProfile`, `src/doctor.js`) — the one configuration where
inference silently has nowhere to go.

## The refusals are the design

`trackReadiness` answers `{ok, why, waves, profile, mode}`, and **every "no" is
a fallback, never an error**: node dispatch is always available, so anything
unusual just means "dispatch it node by node". A card that is not a root, a cycle, a root that is
not `todo`/`ready`, a `kb:needs-human` node, a node with an open PR, a blocker
that is not on this board, a node scheduled for later, a node on a profile
outside `track_agents` (cross-harness tracks are out of scope: one session is
one harness) — and, via `trackAlreadyAttempted`, **a root that has already had
one runner**. That last one is the safety valve: the fast engine gets one go,
then the durable one finishes whatever is left.

`planTracks` asks `isTrackRoot` which cards are roots at all, then runs live
tracks first, so the nodes a running runner owns are
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
- **`trackFanout(cfg, profile, task)`** (`src/track.js`) checks for `Agent` via
  `effectiveTools(profile, task, cfg)` rather than the profile's raw list (#273),
  so the root card's own `kb.tools` can narrow `Agent` away — the dispatcher
  passes the root task at its one call site (`src/dispatch.js`, the track branch
  of the tick) and passes its answer to `trackContext` when it builds the track
  prompt. A profile without `Agent` (or a card that narrowed it away) gets the
  older node-after-node brief, which is always a correct way to run a track —
  the board reads the same either way.
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

## Branch strategy: every node stacks on the track branch, never on a sibling (#245)

Before #245, a node's brief pointed `<base>` at the branch of the node it was
blocked by (`kb/<blocker>`), or the default branch when it had none — nodes
stacked on each other, in a chain. Running track #191 (six cards, five
children) broke that in three distinct ways in one attempt: `<base>` had no
answer for a diamond (#227 was blocked by *two* children, so the runner
improvised an unrecorded `kb/191-wave1` integration branch by hand), a stacked
PR is invisible to `closedByPullRequestsReferences` (GitHub only links a PR
into the default branch, so #227's card closed *done* with its work
unmerged), and eager merging of a lower node pulled the base out from under
everything stacked on it (#229's base branch was squash-merged and deleted
mid-task). The correlation was the evidence: both children with no blockers
sailed through, both children with blockers were lost.

The fix replaces the chain with a hub. **A track claims its own integration
branch, `kb/track-<root>` (`trackBranchName`, `src/model.js`), the moment it
is claimed** — `ensureTrackBranch` (`src/lock.js`) creates it from the default
branch, at the same claim sha the lock ref itself uses, and the dispatcher
records it on the attempt row as `track_branch` (`src/dispatch.js`, the track
claim) *before* anything is spawned. That is the whole reliability argument:
the branch lives on the board, not in the runner's head, so a runner that dies
never strands work nothing can find. `ensureTrackBranch` is idempotent — a
retried claim (the first attempt crashed before it ever recorded `ended_at`)
reuses the existing branch rather than recreating it, because children may
already have based work on it.

```
main
 └── kb/track-<root>            created at claim time, from the default branch
      ├── kb/<child-a>          branched from the track branch, PR into it
      └── kb/<child-b>          branched from the track branch, PR into it
 └── kb/track-<root> ──────────> one PR into main, after the root's own pass
```

**Every node branches from the track branch, whatever its blockers are** —
`trackContext` (`src/track.js`) threads the branch name into both the
sequential loop and the fan-out's per-node brief: `git fetch origin
<track-branch> && git switch -c kb/<n> origin/<track-branch>`. The diamond
that broke #227 disappears: two blockers and one blocker produce the same
base, because a blocker's work is already sitting on the track branch by the
time a dependent starts. A node's own branch is still `kb/<n>` — unchanged,
still what `taskBranchRe` matches — only what it is cut *from* moved.

Every node's PR still targets that branch, not the default one, so
`closedByPullRequestsReferences` still never links it — this is exactly the
rung that **requires #234**: the head-branch fallback (`taskBranchRe`/
`openPrsByHead`/`branchFallbackPrs`, `src/tasks.js`) matches a PR by its
**head** (`kb/<n>`) whatever its `base` is, so `hkb finish` still finds the
node's PR through the fallback with a track-branch base exactly as it did with
a sibling's. `hkb finish` still refuses to land a card in *done* with no PR
found at all, and `hkb doctor`'s `checkOrphanedPrs` still catches a card that
already closed with its branch's PR unreferenced.

**The root's own pass runs on the track branch itself, not a `kb/<root>` of
its own**, and opens the track's *one* PR into the default branch — the PR
GitHub's own linking does auto-close, because that one targets the default
branch (`## Finishing the track` in the brief, `src/track.js`). That makes the
root's "check the pieces fit" verification a gate the work passes *before* it
lands, rather than an audit of something already merged — #191's root
verified work that had already shipped, unmerged branches and all.

### Conflict on the way into the track branch is an event, not a discovery

Two children's PRs colliding on their way into the track branch is the
trigger the design settled on for reviewing the assembled whole, and it is a
detectable signal rather than a judgement call: `trackConflictPass`
(`src/dispatch.js`, run every tick after `autoMergePass`) reads every open PR
whose base is a running track's branch (`openPrsByHead`, filtered by
`baseRefName`), and asks GitHub outright via `prMergeStates` — one GraphQL
request aliasing every candidate PR number, since REST's list-PRs endpoint
carries neither `mergeable` nor `mergeStateStatus` and a track child's PR is
exactly the shape `closedByPullRequestsReferences` cannot surface either. The
pure verdict, `trackBranchConflict` (`src/model.js`), treats GitHub's own
`'CONFLICTING'` as the only positive — `'UNKNOWN'` (not yet computed) is
"ask again next tick", never a false alarm, and fewer than two candidate PRs
can never conflict. A real conflict adds `kb:needs-human` to the root (the
event `hkb watch` already reports the moment the label lands) and a comment
naming which PRs collide, once per attempt — `track_conflict_notified` on the
attempt row is what stops it from repeating every tick.

### Lifecycle: created at claim, deleted once the root is settled

A track branch is not the runner's to delete — `hkb gc`'s `sweepTrackBranches`
(`src/gc.js`) is the one sweep in that file that costs a GitHub request rather
than a local `git` call, because `ensureTrackBranch` makes the branch through
the API rather than a local push. It deletes a root's `kb/track-<root>` once
that root is *done* or *archived* — the same `finishedHere` predicate the
ordinary branch sweep (`sweepBranches`) already uses — and leaves an open
root's branch alone even if its last track attempt already ended without
merging, because the branch may still hold work worth recovering by hand.
That gap is exactly what `hkb doctor`'s `checkTrackBranches` is for: every
`kb/track-<root>` on the repo (`listTrackBranches`, one `git/matching-refs`
read), cross-checked against its root's last track attempt — no live root, or
an attempt that already ended, is flagged as having no live runner, the same
class of bug `checkOrphanedPrs` already covers for an unreferenced PR.

## Known gaps

- **A dead runner's leftover nodes fall back to the default branch, not the
  track branch.** `src/context.js`'s ordinary cold-worker brief (`workerContext`)
  has no lookup from a node back to an ancestor track's `track_branch` — a
  deliberate scope cut, not an oversight (`src/track.js`'s header comment). So
  once a track's one run has ended (`trackAlreadyAttempted`) and node dispatch
  picks up whatever is left, a node with no open PR yet starts on a fresh
  worktree cut from the default branch and cannot see its still-unmerged
  siblings' work sitting on `kb/track-<root>`. A node that *had* already opened
  a PR is unaffected — `continuation`'s `cont.base` reads straight off that PR's
  own `baseRefName`, which is the track branch, so a `request-changes` or a
  reclaimed-mid-review node reattaches correctly either way. `hkb doctor`'s
  `checkTrackBranches` is the safety net for the gap: it flags a track branch
  with no live runner so a human notices and reconciles it by hand rather than
  the tick silently losing the assembled work.
- **The verb check is brief-level, not enforced.** The Stop nudge keys on
  `KB_TASK`, which is the root, so it never fires for a child. The orchestrator
  is told to read `hkb show <n> --json` after each wave and file or block a node
  its subagent left `running`. If it does not, the node is simply a stale claim
  the ordinary dispatcher reclaims after `stale_after` — the failure mode is
  latency, not corruption.
- **A root that is `running` for any other reason still covers its nodes.**
  `planTracks` marks a running root's nodes `covered` from its status, not from
  its run record, so a root someone claimed by hand (`hkb claim <root>`) holds
  its children for as long as that attempt lives. True before #161 for
  `claude-track` roots and now true for every inferred one; the effect is
  latency (the children wait for one attempt to end), never a double claim.
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
