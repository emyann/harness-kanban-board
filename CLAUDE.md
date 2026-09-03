# hkb — contributor guide

`hkb` is a zero-dependency Node (>= 22.13, ESM) CLI that turns GitHub Issues into a Hermes-style kanban for coding agents.
Read `README.md` for the model and `skills/kanban/references/protocol.md` for the exact protocol before changing behaviour.

## Values (in priority order)

1. **Portable** — the protocol is labels, issue dependencies, refs and comments; any harness drives it through `hkb` verbs; GitHub is the default store today and becomes a bridge (ADR-006).
2. **Frugal** — no npm dependencies; no LLM in the dispatcher; one GraphQL query per board per tick; every write is justified.
3. **Performance** — conditional reads, no polling loops inside commands, no per-task calls when a board-wide one exists.
4. **Frictionless** — the default path asks nothing of the human that the tool could work out itself: one command over two, a
   sensible default over a flag, an inferred answer over a prompt. A rung that is *possible* but tedious is a gap to close, not a
   workflow to document — if the answer to "can hkb do X" is "yes, by hand", that is a bug report.
5. **Flawless experience** — every error says what to do next; `--json` everywhere; never a silent failure.

## Layout

- `bin/hkb.js` entry · `src/cli.js` arg parsing + routing · `src/gh.js` the only place that shells out to `gh`
- `src/model.js` pure functions (unit-tested, no I/O) · `src/store/` the board behind one interface (`index.js` the
  contract, `github.js` today's driver) · `src/forge.js` pull requests, reviews, merges · `src/tasks.js` and
  `src/lock.js` are thin re-export shims over the store, kept so existing imports still resolve
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
- The protocol (statuses, claims, attempts, handoff) is backend-neutral; GitHub is an adapter. Keep every GitHub-ism behind `gh.js`/`src/store/github.js`/`src/forge.js`; the store's conformance suite
  (`test/store.test.js`) is what a second driver has to pass, and `test/fake-gh.js` is the GitHub double it runs
  against. See ADR-006 and `docs/local-first.md` §6 for the local store the interface exists for.
- Pin `X-GitHub-Api-Version` via `src/gh.js`; never call `gh issue`/`gh pr` sub-commands for board state — use `gh api`.
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

Tasks are GitHub issues on the `kb:*` board. If `KB_TASK` is set you are a worker: run `hkb show $KB_TASK --json` first,
work only in this worktree, open a draft PR that says `Closes #$KB_TASK`, and finish with **exactly one** of
`hkb finish <n> --summary "..."`, `hkb block <n> "why" --kind needs_input`, or `hkb request-review <n> --summary "..."`.
(`finish` is `complete` under a name no shell claims — `complete` is a bash builtin, and a harness that vets your
command line word by word will refuse it. Redirect a file rather than using a heredoc, for the same reason.)
Never `git push --force`. Full protocol: `.agents/skills/kanban/SKILL.md`.
<!-- hkb:end -->

@AGENTS.md
