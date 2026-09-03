---
title: hkb at a glance
summary: "The moving parts: CLI, board protocol, dispatcher loop, workers — and the one rule that shapes them all: the store is the only state."
category: architecture
kind: explanation
audience: [dev]
read_when: "your first session in this repo, or changing how state, dispatch, and workers fit together"
covers:
  - path: src/cli.js
    sha: 565b5ca72ec257acd2a350d8b465d302061199c3
  - path: src/gh.js
    sha: 8154ea477e52ed3f769238f1c1bda588fd767798
  - path: src/model.js
    sha: 35b0e9901257c7236ab59b93850b56cd711f8a4e
  - path: src/store/index.js
    sha: bf81d3c348f76a5146931ab57d1af34be05aef18
  - path: src/forge.js
    sha: 0e424d2844bee9b0fdd2f809f7e9ae4314d69e74
  - path: src/lifecycle.js
    sha: af197411d2798847fdc6707c39ae3b60989dc9ed
  - path: src/dispatch.js
    sha: 492b6362444d3589e4fc0989cf89cd58aad93ccb
  - path: src/context.js
    sha: be28b4843c2a09afc0c835c4fe195706af86bb15
  - path: src/hook.js
    sha: 464c411be61b06c8513fd248847bf0eeceb3eef0
  - path: src/jobs.js
    sha: a5b255731602cb2363ff33745fa1039e211ffdd1
  - path: src/board.js
    sha: 53192b4670920a4ead1181c925075285dc8ee105
  - path: src/doctor.js
    sha: ea334d91ff5b9b4411cfd213ac8fcf696fcb963d
generated_at_commit: e16f166
last_refreshed: 2026-09-03
related: [concepts/store, concepts/board-protocol, concepts/claims-and-leases, concepts/worker-identity, architecture/dispatcher-tick, concepts/roles-and-seats, features/update-notice, features/hook-install-shapes]
---

# hkb at a glance

> hkb is a Hermes-style kanban that coding agents work autonomously, on a board
> that lives **in the repository it drives**. Every structural choice below
> follows from one rule: **the store is the only durable state**. Processes hold
> caches, never truth — so any process (dispatcher, worker, a human's laptop) can
> crash at any moment and the system re-derives itself from whatever
> `openStore(ctx)` answers.

## The state model

A board is whatever `openStore(ctx)` (`src/store/index.js`) answers, and there
is one store: a card is a file on the `kb-board` git branch,
`.git/hkb/index.db` (`node:sqlite`) indexes it and holds claims and the event
log, and both are composed behind the interface by `src/store/local.js`
(*concepts/store*, *architecture/local-store*). Structured fields ride in an
HTML-comment block at the top of the card's body and execution history in a run
record beside it, all parsed and serialized by pure functions in
`src/model.js`. Dependencies are edges between cards (`blocked_by`), which makes
the board a DAG, not a list.

GitHub Issues was the other driver until ADR-006 retired it. The seam is what
made that a deletion rather than a rewrite — no verb branches on the store, so
`src/store/github.js` and the `src/tasks.js`/`src/lock.js` shims over it were
removed with no caller changed (*architecture/store-seam*). What remains of it
is `src/bridge/github-issues.js`, read-only, reachable only from
`hkb init --import`.

## The one atomic primitive

A claim is **one `BEGIN IMMEDIATE` transaction** on the index
(`src/store/sqlite.js`): insert the lock under `UNIQUE(task_id, k)`, insert the
attempt row, set the status. A row already there means someone holds it;
anything else means *unknown*, and callers must treat unknown as "back off",
never as either success or failure. A worker's heartbeat is a compare-and-swap
on that row's token, leased on this host's own mirror of where it left the
chain; zero rows updated is `LOCK_LOST` (exit 3) and the worker must stop.

## The dispatcher is deliberately dumb

`src/dispatch.js` is a no-LLM loop. Each tick re-reads the whole board (one
read) and derives every action from it: replay unsent writes, move the cards
whose pull request merged on the forge, reclaim crashed work, reap finished
agents, promote cards whose blockers are done, then claim and spawn workers
under guard rails, *ready* cards highest-`kb.priority` first and oldest card
first within a tie
(`sortReady` in `src/model.js`). The number itself carries no enforced
scale — `README.md` names a **priority band** (`0` unfiled default · `1`
normal · `2` next up · `3` urgent) so two filers share a ruler, but
`sortReady` only ever compares the raw integer. Its in-process memory
is only an optimization — since the 2026-08-27 outage it drops its own caches
and ultimately exits (code 4) when claims stop resolving, because a fresh
process rebuilt from the board is always correct.

**One thing the tick cannot derive from the board: a pull request.** The board
is local and nothing on the forge's side points back at a card, so the tick
reads the repository's pull requests once and matches them to cards by *head
branch* — `kb-<n>-<k>` and the other names hkb creates (`taskBranchRe`,
`src/model.js`; `fillPrs`, `src/forge.js`). That join is what the `active_pr`
guard, the terminal verbs and the reconcile pass all run on: a merged PR on a
card's branch is what moves it to *done*, and `hkb merge` does the same at once
rather than waiting for the next tick. Judgment (what to build,
whether a PR merges) lives outside the loop, in the seats described in
`concepts/roles-and-seats`. The tick still never merges anything: a board on
`dispatch.merge.mode: "auto"` has it enable *GitHub's* auto-merge on a
reviewed card's PR and walk away, which delegates the mechanical last step
without moving the judgment inside the loop — see `features/auto-merge`.

The loop does two things a tick does not, both at most once a day and both
outside `tick()` because they write `.kanban/state.json`: warn before KB_TOKEN
expires, and say when npm has moved past the hkb running it
(`tokenExpiryNotice`/`versionNotice`, `src/doctor.js`; see
`features/update-notice`). Neither is a decision and neither can fail a tick —
an unreachable probe is silent and simply retried.

Modules load once, at process start, so a loop that has been up for hours
keeps running the code it imported even after a merge to `main` changes the
checkout the global `hkb` symlinks into (#140). Every tick, `loop` compares
`installStamp()` — the checkout's own `git rev-parse HEAD` when it has one,
the package version otherwise, both read fresh off disk, never cached — against
the stamp it captured at startup. A mismatch is exit 4, the same code the
self-heal ladder above uses: `hkb: this loop is running <old>, the installed
hkb is <new> — restarting`. It is a local `git` call, not a GitHub read, so a
board where the loop is current pays nothing per tick for it.

## Workers are any harness

A worker is whatever a profile in `src/board.js` can launch — Claude Code,
Copilot CLI, Codex, or a harness someone wrote a `launch` array for — pointed
at one card. Its
contract is small: the verbs in `src/lifecycle.js` (complete / block /
request-review), a prompt assembled from the card by `src/context.js`, and
guard rails on the launch line itself. The protocol is what a worker follows;
the harness is interchangeable.

**The launch line is the permission policy.** `--permission-mode dontAsk` with
an `--allowedTools` / `--disallowedTools` pair (`CLAUDE_TOOLS` and
`CLAUDE_DENY`, `src/board.js`) is the layer that is live on every profile,
including the `claude --bg` default where the `KB_TASK`-gated PreToolUse hook
never fires. So what a worker must never run is said there — `Bash(hkb
dispatch*)` beside the force-push patterns — and hkb's own `preToolHook`
(`src/hook.js`) is deliberately **deny-or-silent**: it can subtract from that
list and never widen it, because a hook `allow` overrides Claude Code's own
checks and would let one profile's worker run what the identical worker beside
it is refused. A denial names the way out rather than inviting a workaround:
`hkb block <n> "needs …" --kind capability`.

**The launch line also carries the hooks** (`{hook_settings}` in the Claude
launches, `src/board.js`; `workerHookSettings`, `src/init.js`). Both of hkb's
Claude Code hooks are `matcher: "*"` and both are inert outside a worker, so a
settings file — read by every session in the repo — bought other sessions a
process per tool call and, once its command stopped resolving, a failure per
tool call. `--settings` is a per-launch source, forwarded into the `--bg`
session daemon, so the hooks reach only sessions hkb started and `hkb init`
writes no settings file (`--shared-hooks` remains the opt-in). See
[hook install shapes](../features/hook-install-shapes.md).

*Which* card is the subtle part, and it is not always the environment. The
dispatcher exports `KB_TASK`/`KB_ATTEMPT` on the launch (`src/dispatch.js`),
which answers it for any harness run as a child process — but not for a
background agent: `claude --bg` hands the request to a long-lived session
daemon and exits, so that environment stops at the CLI and never reaches the
session doing the work. The default profile is one of those. `whichAttempt`
(`src/hook.js`) therefore falls back to the `kb-<n>-<k>` checkout the launch
names, which is already the identity the tick matches a running job by
(`matchJobByWorktree`, `src/jobs.js`). And when the two *disagree* the checkout
wins: an environment can be inherited — a session daemon a `claude --bg` launch
cold-started keeps that launch's `KB_TASK` for life and hands it to every
session it hosts — where a directory cannot, so hkb no longer passes any `KB_*`
on that launch and a hook that finds a contradicted one stands aside
(`attemptIdentity`, `src/model.js`; see *concepts/worker-identity*).

Session identity travels the same asymmetry. What session a worker *is*
(`CLAUDE_CODE_SESSION_ID`, plus the job record `currentSession` reads in
`src/jobs.js`, which names the transcript on disk) is recorded onto the attempt
row by the **terminal verb**, not by the Stop hook — the verb is the one thing
every worker runs, and it is already writing that row. Which is why the verb has
to be a command the worker can actually type: `complete` is a bash builtin, and
Claude Code's worktree-isolated sessions refuse it (and refuse heredocs) before
hkb sees the line, so `VERB_ALIASES` (`src/cli.js`) resolves `finish` to
`complete` ahead of routing and everything a worker reads names `finish`. `sessionForAttempt`
(`src/hook.js`) stamps only an attempt this session actually ran: its own, or a
node it claimed in-session, so a track's nodes carry the runner's transcript
while an operator's own terminal records nothing. That is what leaves
`hkb stats` something to price when the harness itself reports no cost.

The attempts that never reach a verb — crashed, timed out, written off as a
protocol violation — are exactly the ones a human reopens, so the tick fills
those from the other end. It has already matched the background job to decide
whether the attempt is alive, and that job names a record on disk;
`jobSessionUpdate` (`src/jobs.js`) turns it into the same fields, one tick after
the launch (`src/dispatch.js`). Blanks only: a row a verb has stamped is left
exactly as it is, and a resumed job's record is never half-merged into one. A
pid-mode attempt has no job record, but the same worker log `parseSessionLog`
already reads for session and cost, so the tick backfills it from there too,
the tick just before it calls `failAttempt` (`src/dispatch.js`).

`parseSessionLog` (`src/model.js`) reads the whole result `claude -p
--output-format json` signs off with, not just what to bill: `terminal_reason`
and `api_error_status` say why the run ended, `model_usage` (read off the
result's own `modelUsage`, the one camelCase field in an otherwise snake_case
object) breaks cost down per model, and `permission_denials` is the tool calls
the harness refused before the worker ever saw a prompt. `watchChild`
(`src/dispatch.js`) reads `api_error_status` off that result to pause a
profile on a 401/429, falling back to scanning the raw log tail only for a log
with no JSON result line to read a status from at all.

## The seams that keep it portable

`src/gh.js` is the only file that shells out to `gh`, and it pins
`X-GitHub-Api-Version`. Board state now sits behind one named interface —
`openStore(ctx)` in `src/store/index.js`, with the GitHub bodies in
`src/store/github.js` — and pull requests sit beside it rather than inside it,
in `src/forge.js`, because a board kept locally still opens its work on a
forge. Everything above the seam speaks statuses, claims and attempts, so the
local tiers arrive as further drivers rather than as an edit to every caller.
See [the store seam](store-seam.md). Pure decision logic stays in
`src/model.js` (unit-tested, no I/O); `src/cli.js` only parses and routes.

## Related

- [store](../concepts/store.md)
- [board-protocol](../concepts/board-protocol.md)
- [claims-and-leases](../concepts/claims-and-leases.md)
- [dispatcher-tick](../architecture/dispatcher-tick.md)
- [roles-and-seats](../concepts/roles-and-seats.md)
- [Telling an adopter their hkb is old](../features/update-notice.md)
- [Where a hook command may say hkb is](../features/hook-install-shapes.md)
