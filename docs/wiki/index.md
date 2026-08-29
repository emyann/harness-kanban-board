# hkb — wiki index

> GENERATED FILE — do not edit by hand. Regenerate with `node .repolore/scripts/wiki-index.mjs`.
> One line per page, taken verbatim from each page's frontmatter `title`/`summary`.
> Schema and authoring rules: [AGENTS.md](./AGENTS.md).

## Architecture

- [hkb at a glance](./architecture/overview.md): The moving parts: CLI, board protocol, dispatcher loop, workers — and the one rule that shapes them all: the board is the only state.

## Concepts

- [Worker identity — which attempt a session is, and who may say so](./concepts/worker-identity.md): The three answers to "which attempt is this session?" (launch environment, checkout, job record), the order of trust between them, and why a `claude --bg` launch must hand over none of them.

## Features

- [The last step — `dispatch.merge` and GitHub's auto-merge](./features/auto-merge.md): Why hkb never merges, how a board hands the last step to GitHub instead, and the branch-protection gate that is the only thing making that safe.
- [Where a hook command may say hkb is](./features/hook-install-shapes.md): hkb's hooks ride the worker launch (`--settings`) so no other session in the repo runs them; a settings file is opt-in, and what may go in that one still depends on where the running hkb lives.
- [The operator's seat as a procedure (`/kanban:operate`)](./features/operator-seat.md): The third slash command — why the one seat hkb cannot enforce got a written brief instead, where its reaction table's vocabulary comes from, and what keeps the two in sync.
- [The path_overlap guard — three modes, and never behind an idle attempt](./features/path-overlap-guard.md): Why the guard exists (the merge conflict, not the worktree one), the off/running/unmerged modes and their merge.mode defaults, and how idleness — job, pid, or lock-ref beat — keeps it from holding a card hostage.
- [The planning commands — `/kanban:specify` and `/kanban:decompose`](./features/planning-commands.md): The two board operations that need a model and so cannot be `hkb` verbs — one command source, registered twice, delegating to one procedure in SKILL.md.
- [The review loop — `request-changes` and continuing one PR](./features/review-loop.md): How a reviewed card goes back for another round on the same PR: the one exemption to the active_pr guard, the checkout the dispatcher makes on the PR's branch, and the block in the brief that stops a second PR.
- [Tracks — the second engine, and why it became an orchestrator](./features/tracks.md): One session for a whole subgraph: how a track is resolved and refused, why every node keeps its own verb and PR, and how a wave of siblings became one isolated subagent each instead of N things in a row.
- [Starting and stopping a board (`hkb up` / `hkb down`)](./features/up-and-down.md): The two long-running processes as one idempotent verb — pid files as the whole protocol, why only their writer may delete one, why the child gets no KB_*, and the line between reporting exit 4 and supervising it.
- [Telling an adopter their hkb is old](./features/update-notice.md): Updates are pull-only, so something has to say there is something to pull — one npm GET a day, in doctor and the dispatcher loop, and why a stale CLI hides a stale skill.
- [The web board (`hkb serve`)](./features/web-board.md): One local server, one inline page, N repos — where the board list comes from and who maintains it, how the board is read, how a drag becomes a verb, how every request is routed to the board it names, and how the drawer draws a card's dependency subgraph from the payload it already has.

## Decisions

- [ADR-004: Three seats — operator, dispatcher, worker](./decisions/adr-004-roles-and-adoption.md): hkb has exactly three seats (operator = the human, dispatcher = a tick, worker = any harness); the dispatcher is not an orchestrator, and adoption is a ladder of the same protocol driven by hand or by the tick.

## Planned (not yet written)

- architecture/dispatcher-tick: The tick pipeline (outbox, reclaim, reap, orphan sweep, reconcile, promote, tracks, guards, claim+spawn) and the live incident behind each stage.
- concepts/board-protocol: Statuses, kb:* labels, the body block, run/result comments, terminal verbs — the backend-neutral contract every harness drives through gh.
- concepts/claims-and-leases: Git refs as the only atomic CAS on GitHub: claim classification (created/held/unknown), heartbeats, LOCK_LOST, and the self-heal ladder.
- concepts/roles-and-seats: Operator, supervisor, dispatcher, workers: who decides, who judges, who loops, who codes — and which seats are optional.
- decisions/adr-001-github-native-backend: GitHub Issues + native dependencies + ref locks won over MCP-first and repo-native designs; stacked PRs rejected for board sequencing.
- decisions/adr-002-zero-npm-dependencies: The CLI ships with zero npm dependencies; presentation may use Node built-ins only. What would justify revisiting.
- decisions/adr-003-npm-trusted-publishing: Releases publish via npm trusted publishing (OIDC) from release.yml only; no npm token exists anywhere.
- features/harness-profiles: The shipped profiles (claude, claude-p, claude-track, claude-action, copilot-cli, codex): modes, permissions, models, and what each harness can and cannot do.
- gotchas/github-api-quirks: 422 'already exists' means held, ref GETs prefix-match into arrays, 304s are free, GITHUB_ACTIONS env reroutes gh — the traps the code already survived.
- gotchas/long-lived-process-rot: The #61 outage: a 90-minute-old loop 404ing on every claim while a fresh process succeeded — why caches are per-tick and the loop exits 4.

> Backlog from the page plan (`pages:` in `wiki.config.yml`) — draft on demand: "draft `<slug>` from the wiki plan".
