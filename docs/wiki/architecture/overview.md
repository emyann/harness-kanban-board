---
title: hkb at a glance
summary: "The moving parts: CLI, board protocol, dispatcher loop, workers — and the one rule that shapes them all: the board is the only state."
category: architecture
kind: explanation
audience: [dev]
read_when: "your first session in this repo, or changing how state, dispatch, and workers fit together"
covers:
  - path: src/cli.js
    sha: edc60d49312690f0691119e2a3396aa3176fd0c7
  - path: src/gh.js
    sha: b728c07d7f5e7bfd29e3dc4c2e0e2786d29522ee
  - path: src/model.js
    sha: 6717b59327df4d7d9bc175b8146081696cec1bbb
  - path: src/tasks.js
    sha: 2faa63591dbb3f96fcb3747141f9e4d42ae24736
  - path: src/lock.js
    sha: 680eae74c9955003c948a6df9750c25548ccaf86
  - path: src/lifecycle.js
    sha: 3938c82f3e181fb260fc54bb2f3150074459e224
  - path: src/dispatch.js
    sha: ce2fcdb53caa648426f64509294e3795a005b5cc
  - path: src/context.js
    sha: ab7afc4eb5158a879ea1700221892229329dce64
  - path: src/hook.js
    sha: 9c279d75961f372331295d9783dde522e4e175b2
  - path: src/jobs.js
    sha: a5b255731602cb2363ff33745fa1039e211ffdd1
  - path: src/board.js
    sha: 05c992709b2d3d1d3ffd453dbbbd6b647de30fad
  - path: src/doctor.js
    sha: 80ed434085da105bdd1c293146fecefe77795bc6
generated_at_commit: f2d9b40
last_refreshed: 2026-09-01
related: [concepts/board-protocol, concepts/claims-and-leases, concepts/worker-identity, architecture/dispatcher-tick, concepts/roles-and-seats, features/update-notice, features/hook-install-shapes]
---

# hkb at a glance

> hkb turns GitHub Issues into a Hermes-style kanban that coding agents work
> autonomously. Every structural choice below follows from one rule: **the
> board is the only durable state**. Processes hold caches, never truth — so
> any process (dispatcher, worker, a human's laptop, an Actions runner) can
> crash at any moment and the system re-derives itself from GitHub.

## The state model

A task is a GitHub issue wearing the board's labels (`kb:status:*`,
`kb:agent:*`, `kb:board:*`); structured fields ride in an HTML-comment block
in the issue body, and execution history rides in two structured comments —
a run record (attempts) and a result record (the handoff) — parsed and
serialized by pure functions in `src/model.js`. Issue⇄task translation and
every board read/write live in `src/tasks.js`. Dependencies use GitHub's
native `blocked_by` issue relations, which makes the board a DAG, not a list.

## The one atomic primitive

GitHub offers exactly one cheap compare-and-swap: **git refs**. Claims are
`refs/kb/locks/<n>/<k>` created via the API (`src/lock.js`) — a 201 means the
claim is yours, "already exists" means someone holds it, anything else means
*unknown*, and callers must treat unknown as "back off", never as either
success or failure. Worker heartbeats are CAS updates of the same ref; a
rejected lease push is `LOCK_LOST` (exit 3) and the worker must stop.

## The dispatcher is deliberately dumb

`src/dispatch.js` is a no-LLM loop. Each tick re-reads the whole board (one
GraphQL query) and derives every action from it: replay unsent writes,
reclaim crashed work, reap finished agents, promote cards whose blockers are
done, then claim and spawn workers under guard rails, *ready* cards
highest-`kb.priority` first and oldest issue first within a tie
(`sortReady` in `src/model.js`). The number itself carries no enforced
scale — `README.md` names a **priority band** (`0` unfiled default · `1`
normal · `2` next up · `3` urgent) so two filers share a ruler, but
`sortReady` only ever compares the raw integer. Its in-process memory
is only an optimization — since the 2026-08-27 outage it drops its own caches
and ultimately exits (code 4) when claims stop resolving, because a fresh
process rebuilt from the board is always correct. Judgment (what to build,
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

## Workers are any harness

A worker is whatever a profile in `src/board.js` can launch — Claude Code,
Copilot CLI, Codex, or a GitHub Actions run — pointed at one card. Its
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
`X-GitHub-Api-Version`; `src/tasks.js` and `src/lock.js` are the only files
that know board state lives in GitHub. Everything above them speaks statuses,
claims, and attempts — backend-neutral by construction, so a future
`src/backends/` split is mechanical. Pure decision logic stays in
`src/model.js` (unit-tested, no I/O); `src/cli.js` only parses and routes.

## Related

- [board-protocol](../concepts/board-protocol.md)
- [claims-and-leases](../concepts/claims-and-leases.md)
- [dispatcher-tick](../architecture/dispatcher-tick.md)
- [roles-and-seats](../concepts/roles-and-seats.md)
- [Telling an adopter their hkb is old](../features/update-notice.md)
- [Where a hook command may say hkb is](../features/hook-install-shapes.md)
