# hkb — contributor guide

`hkb` is a zero-dependency Node (>= 20, ESM) CLI that turns GitHub Issues into a Hermes-style kanban for coding agents.
Read `README.md` for the model and `skills/kanban/references/protocol.md` for the exact protocol before changing behaviour.

## Values (in priority order)

1. **Portable** — the protocol is labels, issue dependencies, refs and comments; any harness drives it through `gh`.
2. **Frugal** — no npm dependencies; no LLM in the dispatcher; one GraphQL query per board per tick; every write is justified.
3. **Performance** — conditional reads, no polling loops inside commands, no per-task calls when a board-wide one exists.
4. **Frictionless** — the default path asks nothing of the human that the tool could work out itself: one command over two, a
   sensible default over a flag, an inferred answer over a prompt. A rung that is *possible* but tedious is a gap to close, not a
   workflow to document — if the answer to "can hkb do X" is "yes, by hand", that is a bug report.
5. **Flawless experience** — every error says what to do next; `--json` everywhere; never a silent failure.

## Layout

- `bin/hkb.js` entry · `src/cli.js` arg parsing + routing · `src/gh.js` the only place that shells out to `gh`
- `src/model.js` pure functions (unit-tested, no I/O) · `src/tasks.js` issue⇄task · `src/lock.js` ref claims
- `src/lifecycle.js` worker verbs · `src/dispatch.js` the tick · `src/context.js` worker prompt · `src/hook.js` Stop hook
- `src/init.js` `src/doctor.js` `src/gc.js` · `skills/kanban/` the shipped skill
- `templates/` what `hkb init` generates: `doc-section.md`, `copilot/` and `codex/` for `--harness <name>`
- `docs/harnesses.md` per-harness setup (profiles, generated files, Codex's one-time trust)

## Rules

- Keep it dependency-free. If you need YAML/TOML, don't.
- Pure logic goes in `src/model.js` with a test in `test/`. I/O stays in `tasks.js`/`lock.js`/`gh.js`.
- The protocol (statuses, claims, attempts, handoff) is backend-neutral; GitHub is an adapter. Keep every GitHub-ism behind `gh.js`/`tasks.js`/`lock.js` so a future `src/backends/{github,local,...}/` split is mechanical; the fake-gh test double (#3) doubles as the backend conformance suite.
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
`hkb complete <n> --summary "..."`, `hkb block <n> "why" --kind needs_input`, or `hkb request-review <n> --summary "..."`.
Never `git push --force`. Full protocol: `.agents/skills/kanban/SKILL.md`.
<!-- hkb:end -->

@AGENTS.md
