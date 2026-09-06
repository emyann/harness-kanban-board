# hkb — wiki index

> GENERATED FILE — do not edit by hand. Regenerate with `node .repolore/scripts/wiki-index.mjs`.
> One line per page, taken verbatim from each page's frontmatter `title`/`summary`.
> Schema and authoring rules: [AGENTS.md](./AGENTS.md).

## Architecture

- [The Job kind and its controller](./architecture/job-kind.md): The first and only workload kind — one agent, one brief, run to completion — with a Kubernetes-shaped mapping (Job/Pod/Lease/Namespace) and a single reconcile pass that is safe to run repeatedly, interrupt, or run concurrently with another host.
- [hkb at a glance](./architecture/overview.md): The moving parts of a workload scheduler: a CLI over one SQLite board, a level-triggered controller that claims a Job under a lease and runs it inline, a runtime seam over the Agent SDK, and a git worktree as the sandbox. Where state lives, and what is deliberately not here.
- [The runtime layer — running a worker on the Agent SDK](./architecture/runtime-layer.md): One seam, run(spec) -> WorkerOutcome, with the Claude Agent SDK as the first driver and a fake for tests; what the SDK stores for us (so the board does not), and the three SDK behaviours that each cost a bug to learn.
- [The loop — a level-triggered daemon, and why the clock is not enough](./architecture/the-loop.md): hkb up runs reconcile on a 45s timer over every board on the machine. Why a controller is level-triggered rather than event-driven, why a lapsed lease is evidence and not proof, why leadership is a row rather than a pid file, and why an operator stop is its own outcome.

## Concepts

- [Admission control — an instruction is not an invariant](./concepts/admission-control.md): Why hkb enforces its tool surface, worktree isolation and (later) dependency ordering in a PreToolUse hook rather than in a prompt, a permission mode, or canUseTool — with the three measurements that ruled the other three out.
- [The Node floor and the type check](./concepts/node-floor-and-type-check.md): The floor is >=22.18.0, measured — the first release that strips types unflagged, which a shebang cannot ask for. Why a published hkb must be JavaScript (Node refuses to strip under node_modules), how the publish transpile works, and what the CI matrix is for.

## Features

- [Carrying gitignored files into a worktree (`.worktreeinclude`)](./features/worktree-includes.md): A worktree is a fresh checkout, so the `.env` the tests need is not in it — a repository declares what to carry across, git answers both halves of the match rule, and no pattern may reach the board.

## Decisions

- [ADR-004: Three seats — operator, dispatcher, worker](./decisions/adr-004-roles-and-adoption.md): hkb has exactly three seats (operator = the human, dispatcher = a tick, worker = any harness); the dispatcher is not an orchestrator, and adoption is a ladder of the same protocol driven by hand or by the tick.
- [ADR-005: hkb is a control plane — a board is a namespace, a host is the node, a pause lives on its object](./decisions/adr-005-control-plane.md): The Kubernetes model is adopted as hkb's mental model with one correction (a board is a namespace, not a node); the operator gets start/pause/resume/stop at worker and board level; a pause is recorded on the object it pauses; the tick stays one loop; the runtime behind a profile mode becomes a seam.
- [ADR-006: The source of truth is local and travels with a clone — a git branch plus a SQLite index; GitHub becomes a bridge later](./decisions/adr-006-local-store.md): The board's state moves off GitHub into two local tiers (durable content on a dedicated git branch, live state and an index in node:sqlite under the common git dir); a board has one control plane; the Actions runner is removed; the GitHub store is retired and returns later as a bridge adapter under a strict direction rule; the Node floor becomes 22.13 and TypeScript ships transpiled.
- [ADR-007: hkb is a workload scheduler — one SQLite board behind Prisma, a runtime seam over the Agent SDK, and Job as the first kind](./decisions/adr-007-workload-scheduler.md): The two-tier store of ADR-006 collapses into one SQLite file behind Prisma; the kb block becomes columns; workers run on the Claude Agent SDK behind a runtime seam; the first workload kind is a Job (one agent, one brief, run to completion) with a reconcile loop and an admission gate; the kanban DAG becomes a second kind that does not exist yet; zero-dependency and the no-build-step rule end.
- [ADR-008: A Job declares its outputs, and the board gets them out of the sandbox](./decisions/adr-008-declared-outputs.md): A Job's deliverable becomes part of its spec rather than a consequence of `isolate`: `results` for small structured values the board keeps, `exports` for paths copied out of the worktree before teardown, and an undeclared output is litter. A declared output that is not produced is a failure, which is what finally makes `succeeded` mean something.
- [ADR-009: The pre-ADR-007 system is retired, and the scheduler takes back the name](./decisions/adr-009-retiring-the-first-system.md): The GitHub-Issues kanban — 36 verbs, a board on refs/kb/boards/<slug>, a dispatcher tick, a shipped skill and a web board — is deleted rather than migrated; `kb` is renamed `hkb`, the per-repo directory becomes `.hkb/`, and the published tarball ships only the transpile. The board's git ref is kept as an archive.
- [ADR-010: The human gate is a field, not a kind — and groom is a brief](./decisions/adr-010-the-human-gate.md): propose → approve → apply does not need a second workload kind: a Job declares `results`, a `gate` on its spec suspends it once those results exist, and approve resumes the session with the approver's instruction as the prompt. The approver may be a human, a delegated agent, or an auto-approve policy. Groom becomes a brief plus board arithmetic; ADR-008's unshipped `results` half ships as the precondition it was always named as; and whether a *running* Job can be steered stays open, because that is a streaming-input decision the gate does not need.
- [ADR-011: A workload proposes, the controller writes — board mutation travels as a declared output](./decisions/adr-011-proposals-not-board-access.md): A workload never writes to the board: it declares a proposal as an output, and the controller validates and applies it once an approval is recorded — which keeps the sandbox, makes the write retry-safe where an in-session API call is not, and leaves groom's apply half with the controller rather than making groom a kind.

## Howto

- [Running the daemon under a supervisor](./howto/running-the-daemon.md): Keep `hkb up` alive across reboots — a systemd user unit or a launchd agent around `hkb up --foreground`, where the log goes, and the restart-after-upgrade rule.

## Planned (not yet written)

- architecture/the-board: The schema as a model: what a row of each table means, why the spec columns are nullable, what is frozen onto an Attempt at claim time and why, and the self-bootstrapping migration path.
- concepts/ceilings: The three claim-time refusals (stopped, concurrency, budget), why none of them may stop a running worker, and why committed-but-unspent budget has to be counted.
- concepts/leases-and-liveness: Why a lapsed lease is evidence and not proof: the three-valued alive/dead/unknown answer, the boot-time check, and why a wall clock cannot decide this across a suspend.
- features/declared-exports: --export as a spec field: what is copied out before teardown, why an undeclared output is litter, and the path syntax that is refused before a checkout is ever made.
- gotchas/merge-composition: Four collisions where every PR was individually correct and CI-green: what parallel workers on one base actually collide on (shared invariants, not shared files), and why briefing fixed it where machinery could not.

> Backlog from the page plan (`pages:` in `wiki.config.yml`) — draft on demand: "draft `<slug>` from the wiki plan".
