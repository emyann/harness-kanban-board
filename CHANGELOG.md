# Changelog

Notable changes to hkb, newest first. `docs/wiki/decisions/` carries the design detail behind each
entry, and `docs/rebuild-plan.md` the order the work is happening in.

## Unreleased — 0.3.0

### hkb is a workload scheduler, and it is the only thing in this package

**Breaking, and completely.** The GitHub-Issues kanban that `hkb` meant through 0.2.x — the board on
`refs/kb/boards/<slug>`, the 36 verbs, `hkb init`, the dispatcher tick, the shipped skill and slash
commands, the harness profiles for Copilot CLI and Codex, the web board, the MCP server, the Stop and
PreToolUse hook installers — is **deleted**. There is no upgrade path and no migration; a 0.2.x board
is readable only by a pinned 0.2.x install. See
[ADR-009](docs/wiki/decisions/adr-009-retiring-the-first-system.md).

What `hkb` means now is the workload scheduler
[ADR-007](docs/wiki/decisions/adr-007-workload-scheduler.md) started, which shipped alongside it as a
second binary called `kb` and has been the only one anyone ran for months:

- **File a Job, and one agent runs one brief to completion** in a git worktree of its own, then
  commits, pushes and opens a **draft** pull request. A human reviews and merges — hkb never merges.
- **The board is `~/.hkb/board.db`** — SQLite behind Prisma, one per machine with a `Board` row per
  repository. It creates and migrates itself on first touch, and refuses to open a board a newer
  build wrote.
- **`hkb up`** reconciles every board on the machine on a timer, in a detached process, with
  leadership held as a row rather than a pid file. The controller is level-triggered: safe to run
  repeatedly, to interrupt, and to run while another host runs it.
- **Workers run on the Claude Agent SDK** behind a runtime seam (`src/runtime/`), with worktree
  isolation enforced in a `PreToolUse` admission gate rather than asked for in a prompt.
- **A Job can declare its outputs** — `--export <path>`, copied out of the worktree before teardown;
  a declared path the run did not produce fails the attempt
  ([ADR-008](docs/wiki/decisions/adr-008-declared-outputs.md)).
- **Ceilings and defaults per board**: `hkb boards set <slug>` carries `--max-concurrent` and
  `--daily-budget` alongside spec defaults for `--model`, `--effort`, `--max-turns`, `--max-budget`
  and `--max-retries`.

### Also

- **`hkb version`** is new. It reads the running package's own version and returns before opening a
  board, so asking what you have installed does not create one.
- **`hkb help`** works as a verb as well as `--help`.
- **The per-repository directory is `.hkb/`**, matching the machine board; it was `.kanban/`.
- **The tarball ships `dist/` and `prisma/` only** — 117 kB. The TypeScript sources were dead weight
  in it, since Node refuses to strip types under `node_modules`.
- **Node floor is `>=22.18.0`**, measured: the first release that strips types unflagged, which a
  shebang cannot ask for.
- **Kept**: the `kb-<jobId>-<k>` branch prefix, so existing branches and worktrees still resolve, and
  `refs/kb/boards/default` as an archive of the retired board.
