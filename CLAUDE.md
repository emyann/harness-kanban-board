# hkb — contributor guide

`hkb` is a zero-dependency Node (>= 22.13, ESM) CLI: a Hermes-style kanban for coding agents, kept on a branch in
the repository it drives, with GitHub as the forge.
Read `README.md` for the model and `skills/kanban/references/protocol.md` for the exact protocol before changing behaviour.

## Values (in priority order)

1. **Portable** — the protocol is cards, edges, claims and records behind one `Store` interface; any harness drives it through `hkb`. The board is local (ADR-006); GitHub is the forge, and comes back as a *bridge* adapter.
2. **Frugal** — no npm dependencies; no LLM in the dispatcher; one board read per tick and one pull-request listing; every write is justified.
3. **Performance** — conditional reads, no polling loops inside commands, no per-task calls when a board-wide one exists.
4. **Frictionless** — the default path asks nothing of the human that the tool could work out itself: one command over two, a
   sensible default over a flag, an inferred answer over a prompt. A rung that is *possible* but tedious is a gap to close, not a
   workflow to document — if the answer to "can hkb do X" is "yes, by hand", that is a bug report.
5. **Flawless experience** — every error says what to do next; `--json` everywhere; never a silent failure.

## Layout

- `bin/hkb.js` entry · `src/cli.js` arg parsing + routing · `src/gh.js` the only place that shells out to `gh`
- `src/model.js` pure functions (unit-tested, no I/O) · `src/store/` the board behind one interface (`index.js` the
  contract, `local.js` the one driver over `git.js` — the board's ref at `refs/kb/boards/<name>` — and
  `sqlite.js` — the index) ·
  `src/forge.js` pull requests, reviews, merges, and `fillPrs`, which joins the two by head branch ·
  `src/bridge/github-issues.js` the read-only GitHub Issues adapter `hkb init --import` migrates *from*
- `src/lifecycle.js` worker verbs · `src/dispatch.js` the tick · `src/context.js` worker prompt · `src/hook.js` Stop hook
- `src/init.js` `src/doctor.js` `src/gc.js` · `skills/kanban/` the shipped skill
- `templates/` what `hkb init` generates: `doc-section.md`, `copilot/` and `codex/` for `--harness <name>`
- `docs/harnesses.md` per-harness setup (profiles, generated files, Codex's one-time trust)

## Rules

- Keep it dependency-free. If you need YAML/TOML, don't.
- Pure logic goes in `src/model.js` with a test in `test/`. Board I/O goes behind the `Store` interface
  (`src/store/`); anything about a pull request goes in `src/forge.js`; `src/gh.js` stays the only place that shells
  out to `gh`. New board state is a method on the interface and a scenario in `test/store.test.js`, never a fresh
  call into `gh.js` from a caller.
- **The board and the forge are two systems, joined by a branch name.** The store answers with a card; `fillPrs`
  (`src/forge.js`) puts its pull request on it, matched against `taskBranchRe` — there is no issue for a PR to
  reference. A caller that reads `task.prs` must have called `fillPrs` on that read.
- The protocol (statuses, claims, attempts, handoff) is backend-neutral. Keep every GitHub-ism behind
  `gh.js`/`src/forge.js`/`src/bridge/`; the store's conformance suite (`test/store.test.js`) is what a driver has to
  pass. The doubles are split the same way: `test/fake-store.js` is the board, `test/fake-gh.js` the forge — a test
  that asserts on board state uses the first, and one that asserts on a pull request uses the second. See ADR-006
  and `docs/local-first.md` §6.
- Pin `X-GitHub-Api-Version` via `src/gh.js`; never call `gh issue`/`gh pr` sub-commands — use `gh api`.
- Every command returns a stable object under `--json`; human output is a one-liner per item.
- Errors: throw `Error` with `.exitCode` (2 = usage/state, 3 = LOCK_LOST, 4 = the dispatcher loop
  giving itself up for a supervisor to restart) and a message that names the fix.
- Run `npm run lint && npm test` before finishing. Do not add a build step.
- Touching `files` in `package.json`, or anything the CLI reads from the package at runtime? Run `npm run smoke`
  too — it packs, installs and runs the tarball. Releasing: `docs/releasing.md`.

## Commits and PRs

- Plain, human-style messages: a short imperative subject, an optional body explaining why.
- Never add `Co-Authored-By: Claude ...` trailers and never add "🤖 Generated with Claude Code" to commit messages or PR bodies.

<!-- hkb:start -->
## Kanban (hkb)

Tasks are cards on the board's git ref (`refs/kb/boards/<name>`) in this repository. If `KB_TASK` is set you are a worker: run
`hkb show $KB_TASK --json` first, work only in this worktree, open a draft PR **on this worktree's own branch**
(`kb-$KB_TASK-<attempt>` — the branch name is the only thing that ties a PR to its card), and finish with
**exactly one** of
`hkb finish <n> --summary "..."`, `hkb block <n> "why" --kind needs_input`, or `hkb request-review <n> --summary "..."`.
(`finish` is `complete` under a name no shell claims — `complete` is a bash builtin, and a harness that vets your
command line word by word will refuse it. Redirect a file rather than using a heredoc, for the same reason.)
Never `git push --force`. Full protocol: `.agents/skills/kanban/SKILL.md`.
<!-- hkb:end -->

@AGENTS.md
