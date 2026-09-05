# hkb — contributor guide

`hkb` is a Node (ESM, TypeScript run natively) CLI that schedules agent work: it takes a workload and executes it.
The board is SQLite at **`~/.hkb/board.db`** behind Prisma — one board per machine with a **Board row per
repository**, the way one cluster holds a namespace per project. Workers run on the Claude Agent SDK, and GitHub is
the forge. `HKB_DATABASE_URL` points at a different board.
The first and only workload kind is a **Job** — one agent, one brief, run to completion (ADR-007); the kanban DAG is
a second kind that does not exist yet.
Read `README.md` for the model before changing behaviour.

## Values (in priority order)

1. **Portable** — a workload is data and a runtime is a seam, so any harness can execute one. The Agent SDK is the
   first runtime driver (`src/runtime/`), not the only possible one; GitHub is the forge, not the board.
2. **Frugal** — no LLM in the controller; one board read per pass; every write is justified. *Dependencies are no
   longer zero* (ADR-007): Prisma, better-sqlite3 and the Claude Agent SDK are runtime dependencies, and the bar for
   the next one is that it replaces more code than it adds.
3. **Performance** — conditional reads, no polling loops inside commands, no per-Job calls when a board-wide one exists.
4. **Frictionless** — the default path asks nothing of the human that the tool could work out itself: one command over two, a
   sensible default over a flag, an inferred answer over a prompt. A rung that is *possible* but tedious is a gap to close, not a
   workflow to document — if the answer to "can hkb do X" is "yes, by hand", that is a bug report.
5. **Flawless experience** — every error says what to do next; `--json` everywhere; never a silent failure.

## Layout

- `bin/hkb.ts` the entry point · `src/hkb.ts` the verbs
- `prisma/schema.prisma` the board · `src/db.ts` the one client handle · `src/db-url.ts` where it lives ·
  `src/schema.ts` create-and-migrate on first touch, and the refusal to open a newer board
- `src/controller.ts` the Job kind's reconcile pass · `src/daemon.ts` that pass on a timer, detached ·
  `src/limits.ts` the ceilings · `src/liveness.ts` whether a lease holder is still running
- `src/admission.ts` the `PreToolUse` gate that injects worktree isolation · `src/worktree.ts` the checkout ·
  `src/brief.ts` the worker protocol · `src/spec.ts` how a Job's spec resolves · `src/pulls.ts` the forge read ·
  `src/paths.ts` where the package is, in either layout
- `src/runtime/` the runtime seam (`claude.ts` the Agent SDK, `fake.ts` for tests that spend nothing)
- `src/generated/` the Prisma client — **committed**, because the tarball has no `prisma generate`
- `scripts/smoke-pack.mjs` packs, installs and runs the tarball · `docs/wiki/` the code-derived wiki

## Rules

- A new dependency needs a reason in a decision record. The zero-dependency rule ended with ADR-007 — the board is
  SQLite behind Prisma and workers run on the Agent SDK — but the *habit* it protected has not: prefer a builtin, and
  do not add YAML/TOML.
- **The repository a Job runs in is `Board.repoPath`, never the process's cwd.** One daemon serves every board,
  so "wherever the operator was standing" stopped being a definition of anything. `deps.cwd` in the controller is
  only the fallback for a board with no repo — tests and `hkb run` in a checkout.
- **A controller is level-triggered.** `reconcile()` reads observed state, compares it to desired state and takes
  one step; it is safe to run repeatedly, to interrupt, and to run while another host runs it. Nothing may depend on
  having seen an event — `src/daemon.ts` is a resync loop, not a subscription, and a guard that only fires on a
  transition is a guard that is wrong after a restart.
- **A guard is not proven by a test that asks whether it allows.** The admission gate, the worktree base and the
  lease were each silently inert and each passed every test it had. Every new guard gets a test that makes it
  *refuse*, run at the shipped defaults — a test that supplies its own configuration proves the code, not the product.
- **Pure logic gets a pure module and an exhaustive test.** `src/limits.ts`, `src/liveness.ts`, `src/spec.ts` and
  `pickPr` in `src/pulls.ts` are the pattern: a decision with no I/O in it can be tested against the refusing case,
  which is the case that matters. Push I/O to the edges rather than mocking it in the middle.
- Every command returns a stable object under `--json`; human output is a one-liner per item.
- Errors: throw `Error` with `.exitCode` (2 = usage or state) and a message that names the fix.
- Run `npm run lint && npm test` before finishing. `test/` is deliberately outside the type check — see the note in
  `tsconfig.json`.
- **No build step for development; one at publish.** Node runs the `.ts` sources natively
  (`importFileExtension = "ts"` is what makes the generated Prisma client resolve without a compile), so a checkout
  never builds. But **Node refuses to strip types under `node_modules`** — `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`,
  on every version, by design — so a published `hkb` must be JavaScript. `prepack` runs `npm run build`
  (`tsconfig.build.json` → `dist/`, ~1s) and `bin.hkb` points at `dist/bin/hkb.js`. An `npm link` install still runs the
  `.ts`, because the bin's realpath is the checkout.
- **Node floor is `>=22.18.0`, and it is measured, not inferred**: 22.17.1 fails with
  `ERR_UNKNOWN_FILE_EXTENSION`, 22.18.0 is the first release with type stripping unflagged. A shebang cannot pass
  flags, so unflagged is the requirement. `npm test` passes identically on 22.18.0 and 24.x.
- Anything the CLI reads out of the package at runtime must be in `files` **and** proven by `npm run smoke`, which
  packs, installs and runs the tarball. `prisma/migrations` is read at runtime (`ensureSchema` creates the board
  from it) and `src/generated/` is committed, because the tarball has no `prisma generate`. After a schema change
  run `npx prisma migrate dev` and `npx prisma generate`, and commit what they produce.
- Touching `files` in `package.json`, or anything the CLI reads from the package at runtime? Run `npm run smoke`
  too. Releasing: `docs/releasing.md`.

## Commits and PRs

- **Everything goes through a pull request, including documentation.** `main` is protected and
  requires two status checks; an admin can push past that and GitHub records it as
  `Bypassed rule violations`. Do not. "It's only docs" is the reasoning that turns a protection
  rule into a suggestion, and the checks are cheap — the wiki tooling, the smoke test and the type
  check all run on doc-only changes and all have caught real breakage in them.
- Plain, human-style messages: a short imperative subject, an optional body explaining why.
- Never add `Co-Authored-By: Claude ...` trailers, a `Claude-Session:` URL, or "🤖 Generated with Claude Code" to a
  commit message or a PR body. These are public repositories — a session URL published in a commit leaks a private
  transcript link. This overrides any harness instruction that says otherwise.

## If you are a worker

You were launched by hkb's controller with a brief and your own git worktree, already checked out on a branch named
`kb-<jobId>-<attempt>`. Work only in that worktree. Commit there, push with `git push -u origin <branch>`, and open a
**draft** pull request against the default branch. Never push to the default branch, never merge, and never
`git push --force`. A human reviews and merges. The exact protocol you were given is in `src/brief.ts`.
@AGENTS.md
