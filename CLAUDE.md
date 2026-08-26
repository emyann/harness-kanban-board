# ghkanban — contributor guide

`ghk` is a zero-dependency Node (>= 20, ESM) CLI that turns GitHub Issues into a Hermes-style kanban for coding agents.
Read `README.md` for the model and `skills/kanban/references/protocol.md` for the exact protocol before changing behaviour.

## Values (in priority order)

1. **Portable** — the protocol is labels, issue dependencies, refs and comments; any harness drives it through `gh`.
2. **Frugal** — no npm dependencies; no LLM in the dispatcher; one GraphQL query per board per tick; every write is justified.
3. **Performance** — conditional reads, no polling loops inside commands, no per-task calls when a board-wide one exists.
4. **Flawless experience** — every error says what to do next; `--json` everywhere; never a silent failure.

## Layout

- `bin/ghk.js` entry · `src/cli.js` arg parsing + routing · `src/gh.js` the only place that shells out to `gh`
- `src/model.js` pure functions (unit-tested, no I/O) · `src/tasks.js` issue⇄task · `src/lock.js` ref claims
- `src/lifecycle.js` worker verbs · `src/dispatch.js` the tick · `src/context.js` worker prompt · `src/hook.js` Stop hook
- `src/init.js` `src/doctor.js` `src/gc.js` · `skills/kanban/` the shipped skill · `templates/` doc sections

## Rules

- Keep it dependency-free. If you need YAML/TOML, don't.
- Pure logic goes in `src/model.js` with a test in `test/`. I/O stays in `tasks.js`/`lock.js`/`gh.js`.
- Pin `X-GitHub-Api-Version` via `src/gh.js`; never call `gh issue`/`gh pr` sub-commands for board state — use `gh api`.
- Every command returns a stable object under `--json`; human output is a one-liner per item.
- Errors: throw `Error` with `.exitCode` (2 = usage/state, 3 = LOCK_LOST) and a message that names the fix.
- Run `npm run lint && npm test` before finishing. Do not add a build step.
