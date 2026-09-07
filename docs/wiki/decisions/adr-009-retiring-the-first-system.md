---
title: 'ADR-009: The pre-ADR-007 system is retired, and the scheduler takes back the name'
summary: "The GitHub-Issues kanban — 36 verbs, a board on refs/kb/boards/<slug>, a dispatcher tick, a shipped skill and a web board — is deleted rather than migrated; `kb` is renamed `hkb`, the per-repo directory becomes `.hkb/`, and the published tarball ships only the transpile. The board's git ref is kept as an archive."
category: decisions
kind: decision
audience: [dev]
read_when: "looking for a verb, a file or a concept the wiki or the git history mentions and the code does not have; or deciding what may still be assumed about hkb's shape"
status: accepted
date: 2026-09-05
supersedes: [decisions/adr-004-roles-and-adoption, decisions/adr-005-control-plane]
superseded_by: ~
covers:
  - path: package.json
    sha: 02ee69e9b3b3113a1826ffc0798b80a91a2c02ba
  - path: bin/hkb.ts
    sha: 698dd0e673a442929b7314d6bb409f87f89b8251
  - path: src/hkb.ts
    sha: ad82bb3c7ed6e991781246b941525708d8407a05
  - path: scripts/smoke-pack.mjs
    sha: abccc0340f0034e8f40aa9a30796fac84655f603
generated_at_commit: 2fcca6f
last_refreshed: 2026-09-07
related: [decisions/adr-007-workload-scheduler, architecture/overview, architecture/job-kind]
---

# ADR-009: The pre-ADR-007 system is retired, and the scheduler takes back the name

## Context

[ADR-007](./adr-007-workload-scheduler.md) reset hkb into a workload scheduler and said the old system
"still runs alongside it and is not migrated". That was the right call at the time and it had a price:
two systems in one repository, sharing no code, sharing a package, and sharing a name that only one of
them could have. The seam was held by a second binary — `kb` — and by a rule that nothing in `src/*.ts`
may import anything in `src/*.js`. Both held: the closure of `bin/kb.ts` reached no JavaScript file at
any point.

What made the second system finishable is what makes the first one deletable. The scheduler has been the
only one anyone runs for the two dogfood rounds recorded in `docs/rebuild-plan.md` — Jobs filed on the
scheduler, executed by the scheduler, landed as pull requests — and none of them touched the old CLI.
Meanwhile the old system's surface kept costing something real:

- **The tarball.** `files` shipped `skills/`, `commands/`, `hooks/`, `templates/`, `web/` and the whole of
  `src/`, because `hkb init` copied from them at runtime: 2.0 MB of sources across 79 files, nearly all of
  it a CLI nobody ran.
- **The test count.** `test/` held 45 legacy files against 12 for the rebuild, and `npm test` ran both into
  one number. `test:core` and `test:legacy` exist as separate scripts precisely because that number was
  quoted as though it said something about the system being built, and it did not.
- **The wiki.** Two thirds of its pages described features (`tracks`, `groom`, the operator seat, the
  denied-tools ledger, the web board) with no code behind them for anyone reading today.

Nothing was migrated *from* the old system because there was nothing to migrate: its 195 cards were
closed before the reset, and the decision not to bring them back is recorded in `docs/rebuild-plan.md`.

## Decision

**We delete the pre-ADR-007 system rather than deprecating it, and the scheduler takes the name `hkb`.**

1. **Deleted.** `bin/hkb.js` and every `src/**/*.js` behind it — the CLI and its 36 verbs, the dispatcher
   tick, the store seam and its git+SQLite driver, the GitHub Issues bridge, the forge join, the web
   board, the MCP server, the Stop/PreToolUse hook installer, `hkb init` — plus the 45 test files that
   covered them and the package surface only they read: `commands/`, `hooks/`, `skills/`, `templates/`,
   `web/`, `types/`, `.claude-plugin/`.
2. **Renamed.** `bin/kb.ts` → `bin/hkb.ts`, `src/kb.ts` → `src/hkb.ts`, and `bin.hkb` in `package.json`
   points at `dist/bin/hkb.js`. There is one binary again. The per-repository directory becomes `.hkb/`,
   matching the machine board at `~/.hkb/board.db`.
3. **Kept.** The `kb-<jobId>-<k>` branch prefix, unchanged: it names branches and worktrees that exist on
   remotes and in checkouts, and renaming it would orphan them to buy nothing. The board's git ref at
   `refs/kb/boards/default` stays as an archive — it is history, and it costs nothing.
4. **The tarball ships `dist/` and `prisma/` only.** The TypeScript sources were dead weight in it: Node
   refuses to strip types under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, by design),
   so nothing an installed `hkb` runs could ever resolve to them. The packed artifact is 117 kB.
5. **`hkb version` exists**, because the release workflow's clean-room verify has always run it and the
   scheduler had no such verb. It returns before `openBoard()`: asking what you have installed must not
   create a board.

The npm package keeps the name `hkb-cli`. The version goes to `0.3.0` — a `0.x` minor, which is what
semver gives a breaking change before 1.0, and every 0.2.x consumer's CLI is gone.

## Consequences

**Easier.** There is one system, one binary, one test number and one place a verb can be. The type check
covers everything the CLI runs rather than a mix of `checkJs` JSDoc and real TypeScript. `npm run smoke`
shrank to one install shape, because there is only one thing to install. The wiki can describe what is
here.

**Harder — and accepted.** Anyone on `hkb-cli@0.2.x` who was using the kanban CLI has no upgrade path;
they have a pinned version and a git history, and that is the whole of it. This is the trade `0.x` exists
to allow, and the README has carried an experimental notice saying so since before ADR-007.

**Lost.** Capabilities the old system had and the new one does not: a dependency graph between units of
work, a web board, GitHub Issues as a bridge, multi-harness workers (Copilot CLI, Codex), the planning
slash commands, and grooming. They are not deprecated ideas — the DAG and grooming are the next two
workload kinds in `docs/rebuild-plan.md`. What is gone is their first implementation, which was written
against a board that no longer exists.

**What this does to ADR-004 and ADR-005.** Both are marked superseded by this record, for different
reasons and to different depths:

- **ADR-004** named three seats: operator, dispatcher, worker. The *dispatcher* seat is gone as a thing
  the CLI has — a controller reconciles, and it is not a seat a human sits in. Operator and worker survive
  unchanged.
- **ADR-005** decided hkb is a control plane. Its **model survives and was carried into ADR-007**: a board
  is a namespace, a pause lives on the object it pauses, the runtime behind a profile mode is a seam
  (`src/runtime/`), and the tick is sleep-aware (`src/daemon.ts`). What is superseded is its **CLI
  vocabulary** — `hkb start | pause | resume | stop [<n>] [--all]` — and the two-tier store it assumed.
  Read it for the model, not for the surface.

<!-- Dual mutability: once status: accepted, NEVER rewrite this record.
When the decision changes, write a new ADR, set its `supersedes`, and set
`superseded_by` here. A stale flag from wiki-check on an accepted ADR is a
prompt to consider superseding — not to edit. -->
