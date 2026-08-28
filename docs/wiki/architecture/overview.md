---
title: hkb at a glance
summary: "The moving parts: CLI, board protocol, dispatcher loop, workers — and the one rule that shapes them all: the board is the only state."
category: architecture
kind: explanation
audience: [dev]
read_when: "your first session in this repo, or changing how state, dispatch, and workers fit together"
covers:
  - path: src/cli.js
    sha: 0dc546fc625e1f725aa446b68a2bdf915b34aca2
  - path: src/gh.js
    sha: b728c07d7f5e7bfd29e3dc4c2e0e2786d29522ee
  - path: src/model.js
    sha: 75de5e5f6c86b87fd90d878b77643a805d020251
  - path: src/tasks.js
    sha: 2faa63591dbb3f96fcb3747141f9e4d42ae24736
  - path: src/lock.js
    sha: 680eae74c9955003c948a6df9750c25548ccaf86
  - path: src/lifecycle.js
    sha: c729b37a295528722f19a3d2382c5f40d7537084
  - path: src/dispatch.js
    sha: 0cdcd4fea6cdc34ea29807ca292f5de26bd03019
  - path: src/context.js
    sha: 0de994e57a7d7540c632757864e1af8027cffa03
  - path: src/hook.js
    sha: 76c8c61468a9382d8e554081b316c5faace75ba0
  - path: src/jobs.js
    sha: ee051802f87ebbf0b1ac87aab43247505398a15b
  - path: src/board.js
    sha: 7e895ff3e7e8380a61fd275e609d93dfce2140e1
  - path: src/doctor.js
    sha: 9a5a658d95cd1b463cb3d6c78f0625e66f7b8bb6
generated_at_commit: c46b183
last_refreshed: 2026-08-28
related: [concepts/board-protocol, concepts/claims-and-leases, architecture/dispatcher-tick, concepts/roles-and-seats, features/update-notice]
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
done, then claim and spawn workers under guard rails. Its in-process memory
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
guard rails enforced by the Stop/PreToolUse hooks in `src/hook.js`. The
protocol is what a worker follows; the harness is interchangeable.

*Which* card is the subtle part, and it is not always the environment. The
dispatcher exports `KB_TASK`/`KB_ATTEMPT` on the launch (`src/dispatch.js`),
which answers it for any harness run as a child process — but not for a
background agent: `claude --bg` hands the request to a long-lived session
daemon and exits, so that environment stops at the CLI and never reaches the
session doing the work. The default profile is one of those. `whichAttempt`
(`src/hook.js`) therefore falls back to the `kb-<n>-<k>` checkout the launch
names, which is already the identity the tick matches a running job by
(`matchJobByWorktree`, `src/jobs.js`).

Session identity travels the same asymmetry. What session a worker *is*
(`CLAUDE_CODE_SESSION_ID`, plus the job record `currentSession` reads in
`src/jobs.js`, which names the transcript on disk) is recorded onto the attempt
row by the **terminal verb**, not by the Stop hook — the verb is the one thing
every worker runs, and it is already writing that row. `sessionForAttempt`
(`src/hook.js`) stamps only an attempt this session actually ran: its own, or a
node it claimed in-session, so a track's nodes carry the runner's transcript
while an operator's own terminal records nothing. That is what leaves
`hkb stats` something to price when the harness itself reports no cost.

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
