---
title: 'ADR-005: hkb is a control plane — a board is a namespace, a host is the node, a pause lives on its object'
summary: "The Kubernetes model is adopted as hkb's mental model with one correction (a board is a namespace, not a node); the operator gets start/pause/resume/stop at worker and board level; a pause is recorded on the object it pauses; the tick stays one loop; the runtime behind a profile mode becomes a seam."
category: decisions
kind: decision
audience: [dev]
read_when: "adding an operator verb, touching how the tick judges liveness, adding a profile mode, or explaining hkb to someone who knows Kubernetes"
status: accepted
date: 2026-09-02
supersedes: ~
superseded_by: ~
covers:
  - path: src/dispatch.js
    sha: 26a3197921f09d3ef2f4a21f1858c1cc6b5e7fd6
  - path: src/jobs.js
    sha: a5b255731602cb2363ff33745fa1039e211ffdd1
  - path: src/cli.js
    sha: 9d7fc11ad734643205e89668a176d4f29115805f
generated_at_commit: 2a3a7e3
last_refreshed: 2026-09-02
related: [decisions/adr-004-roles-and-adoption, decisions/adr-006-local-store, architecture/overview, features/up-and-down, features/tracks]
---

# ADR-005: hkb is a control plane — a board is a namespace, a host is the node, a pause lives on its object

## Context

The maintainer asked whether "the whole system is a cluster, a board is a node, a worker is a pod" is
a good model, and for a way to start, pause and stop a worker or a whole board. Nothing on the board
offers that today: the web board's own refusal says "only the dispatcher starts a task"
(`NO_SUCH_VERB.running`, `src/serve.js`), the only stop paths are inside the tick (`killPid`,
`stopJob` from `failAttempt` and the reap, `src/dispatch.js`), and `hkb down` deliberately leaves
workers alone. What the maintainer sees when a laptop sleeps — workers resuming where they left off —
is a race the tick happens to win because sleeps are short: nothing detects the gap, every liveness
judgement is a wall-clock subtraction, and a sleep longer than `max_runtime` has the first tick write
every local attempt off as `timed_out` (`src/dispatch.js`, the reclaim loop).

The analogy holds where it matters. hkb keeps desired state in a store it does not own, reconciles it
with a dumb, level-triggered, idempotent loop (ADR-004), coordinates through leases renewed by
compare-and-swap (`src/lock.js`), and models a card as a Job with a retry budget and a deadline
(`failure_limit`, `max_runtime`). It breaks in one place: a **board is not a node**. One board is
dispatched by two hosts (the laptop loop beside the Actions tick) and one host serves several boards
(`~/.config/hkb/boards.json`). A node is capacity; a board is a namespace holding Jobs.

Two measurements shaped the design (2026-09-02, Claude Code 2.1.258): a `claude --bg` job exposes a
pid only while it is on a turn, so a signal freeze is not a primitive the default profile can rely on;
and `claude stop` keeps the conversation while `claude --bg --resume <session> "<prompt>"` continues
it under the same job id — flag-less, because flags fork a copy, and with a prompt, because a bare wake
idles while reporting itself as working. The same measurement found that the reap never stops a parked
background job: `reapDecision` gates on a pid parked jobs do not have (`src/dispatch.js`).

## Decision

- **The mapping is adopted as the mental model, corrected**: cluster = every board the machine knows;
  store = the board's state (today GitHub; ADR-006 moves it); node = a host running the dispatcher
  loop; the tick = kubelet, scheduler, controller-manager and garbage collector in one loop, never split
  into services; namespace = a board and its `dispatch.*` caps; Job = a card; Pod = an attempt;
  container runtime = a profile's `mode`; Lease = the lock. The CLI uses hkb's words, not Kubernetes's:
  `start`, `pause`, `resume`, `stop`, never `cordon`, `drain`, `suspend`.
- **Four verbs, three levels, one shape**: `hkb start | pause | resume | stop [<n>] [--all]`. With `<n>`
  the verb acts on a worker; without it, on this board; with `--all`, on every board in the registry.
  `hkb up` and `hkb down` stay what they are: the control-plane process, never the workload. `hkb ps
  [--all]` is the matching read.
- **A pause lives on its object.** A worker pause is recorded on the attempt row (`paused_at`,
  `pauses[]`), a card suspend on the card (`suspended`), a board pause on the board. Every liveness clock
  subtracts `pauses[]`. A host's own facts (`paused_attempts` for the hooks, the sleep stamp) stay in
  `.kanban/state.json`.
- **`hkb pause` on a board freezes its running workers** (`--keep-workers` cordons only); a paused
  board's tick keeps its bookkeeping and stops claiming and reclaiming.
- **`hkb stop <n>` suspends the card**, closes the attempt with the neutral outcome `stopped`, keeps the
  worktree as the checkpoint, and — on a track root — closes every covered node's attempt the same way.
  `hkb start <n>` resumes the last stopped session in its worktree when one exists.
- **Per runtime**: `claude-bg` pauses by checkpoint (`claude stop` / flag-less `--resume` with a prompt);
  `process` by `SIGSTOP`/`SIGCONT` on its process group (refused on Windows), and its stop sends
  `SIGCONT` before `SIGTERM`; `manual` records the row only.
- **The runtime behind a profile mode becomes a seam**: `src/runtime/{process,claude-bg,manual}.js`
  each exporting `launch`, `inspect`, `stop`, `pause`, `resume`; the tick and `src/jobs.js` stop
  branching on the mode; a fake runtime lets `tick` tests run without a `claude` binary.
- **The tick is sleep-aware**: a gap longer than three intervals between ticks is written into
  `pauses[]` of every attempt with a local handle.
- **Workers never operate the board**: the four verbs are refused under `KB_TASK` and denied on the
  launch line, the way `hkb dispatch` is.

## Consequences

- The design, the verb semantics, the runtime table and the clock rules are written out once, in
  `docs/local-first.md` §2–§5, which every implementing card references; this record states the
  decision, not the design.
- Kubernetes never pauses a pod; hkb does, because a worker carries a transcript the harness keeps. That
  is the one place hkb goes further than the model, and the reason `claude-bg` pauses by checkpoint.
- The reap's pid gate is a live bug and is fixed in the same step as the seam.
- The Actions runner and the `trigger` mode leave (ADR-006), so the seam has three adapters.
- Ordering: the seam before the verbs, the clocks before any pause, so that no verb is written against
  code that is about to move.

<!-- Dual mutability: once status: accepted, NEVER rewrite this record.
When the decision changes, write a new ADR, set its `supersedes`, and set
`superseded_by` here. -->
