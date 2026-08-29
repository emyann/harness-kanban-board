---
title: Where a hook command may say hkb is
summary: hkb's hooks ride the worker launch (`--settings`) so no other session in the repo runs them; a settings file is opt-in, and what may go in that one still depends on where the running hkb lives.
category: features
kind: explanation
audience: [dev, ops]
read_when: "changing where hkb's Claude Code hooks are installed, what `hkb init` writes into a settings file, the Codex/Copilot hook files or .mcp.json, doctor's hook checks, or adopting hkb as a devDependency of a repo; also when a hook command in a repo does not resolve"
covers:
  - path: src/init.js
    sha: dd28e7c0fa2f5885faaef9ca2902368747ed9d8b
  - path: src/model.js
    sha: 0b6cab6f25caa911b717dca9ba8c01d5a8510de5
  - path: src/board.js
    sha: 2e9735c80d0fcc92c298efd10b96def73f4ea03b
  - path: src/doctor.js
    sha: f50c1dc678bff1d13b9a72d930afff7e8fd479ac
  - path: src/mcp.js
    sha: d74908871c707796ca47047b2de1bcba2474127f
  - path: skills/kanban/scripts/hkb
    sha: 619505ca77807157084e456057e1857eb9a31419
  - path: scripts/smoke-pack.mjs
    sha: aea7c5459b0687a0401a52e6fafb20832c54b818
related: [architecture/overview, features/update-notice, concepts/roles-and-seats]
generated_at_commit: 79d3b50
last_refreshed: 2026-08-28
---

# Where a hook command may say hkb is

> Everything else `hkb init` writes is data — labels, `board.json`, a copied
> skill. The two Claude Code hooks are the one thing that is a **command line
> executed by somebody else's session**, in a plain `/bin/sh` with a PATH hkb
> does not control, on machines hkb has never seen. That asymmetry is the whole
> subject of this page.

## The constraint that makes this hard

Both hooks are registered with `matcher: "*"` (`CLAUDE_HOOKS`, `src/init.js`),
so the `PreToolUse` one runs before *every tool call* in every session that
reads the file it is in — including sessions that have nothing to do with the
board. A command that does not resolve therefore fails constantly, with an
error nobody in that repo wrote or can explain. Meanwhile both hooks are inert
without `KB_TASK` (`src/hook.js`), so all that noise buys exactly nothing in an
ordinary session.

The blast radius is why the tracked `.claude/settings.json` was off-limits for
so long (#85): it is read by teammates, and *most* commands hkb can write are
true only on the machine that wrote them.

## The answer that removed the question (#144)

A settings file was always the wrong container: hkb's hooks serve exactly one
kind of session — the worker hkb launched — and both settings files are read by
every session in the repo. So the default is now **neither file**. The hooks
ride the worker's own launch line as `--settings '{"hooks":…}'`
(`HOOK_SETTINGS_VAR` in `src/board.js`, spent by `expandLaunch` in
`src/dispatch.js`), built by `workerHookSettings` (`src/init.js`) over the pure
`hookSettings` (`src/model.js`). `installClaudeHooks` writes no file unless
`--shared-hooks` asks, and strips hkb's own entries out of
`.claude/settings.local.json` on every run.

Two consequences worth holding on to:

- The command in that JSON **may name this machine** — `node "<abs>/bin/hkb.js"`
  when `hkb` is not on PATH — because a launch line is spent where it was built.
  That is the exact case #85 had to forbid for a file other people read.
- `.kanban/board.json` is **tracked**, so it holds the placeholder and never the
  JSON (the launch templates in `DEFAULT_PROFILES`, `src/board.js`). The value
  is resolved per spawn, in `spawnWorker`.

`claude --bg` was measured before this was built, not assumed: a background
launch hands the request to Claude Code's session daemon, so a per-launch flag
reaches it only if the CLI forwards it. In Claude Code 2.1.251 the `--bg`
dispatch path forwards exactly six per-launch sources — `--settings`,
`--add-dir`, `--mcp-config`, both `--plugin-dir` flags and `--strict-mcp-config`
— and passes a `--settings` value beginning with `{` through as inline JSON
rather than resolving it as a path. That is why `claude` and `claude-track` get
the hooks and not only the process-mode `claude-p`.

> TODO-VERIFY: the six-source forwarding list and the inline-JSON branch were
> read out of the shipped 2.1.251 binary's own argument-forwarding table, not
> observed at runtime — re-check against a live `--bg` marker-file probe, and
> on any Claude Code that changes the `--bg` handoff.

## One question, three answers — for the file `--shared-hooks` writes

`hkbCommandForHook` (`src/init.js`) is still the single decision point, and it
still governs what a *tracked* file may say. The question it asks is not "which
package manager" but **"is the running hkb inside the repo it is setting up"**:

| where the running hkb lives | command written with `--shared-hooks` |
|---|---|
| inside the repo — `npm i -D hkb-cli` | `f="$CLAUDE_PROJECT_DIR/node_modules/hkb-cli/bin/hkb.js"; [ -f "$f" ] \|\| exit 0; exec node "$f" hook stop` |
| inside the repo — a checkout of hkb setting *itself* up | the same, with `$CLAUDE_PROJECT_DIR/bin/hkb.js` |
| anywhere else — a global, another checkout, an npx cache | `hkb hook stop` |

The third row never gets an absolute path: a tracked file may only hold a
portable command (`isPortableHookCommand`). An npx cache path is never written
*anywhere* — `isEphemeralPath` rejects it, because it stops existing for the
installer too the next time npm cleans that cache.

The launch calls the same function with `shared: false` **and `binRel: null`**
(`workerHookSettings`), so it takes none of the rows above: it names the hkb
that is running — a bare `hkb` when that is on PATH, an absolute
`node "<abs>/bin/hkb.js"` otherwise, `npx -y hkb-cli` only from a cache. Passing
`binRel` there would be a category error: `$CLAUDE_PROJECT_DIR` exists to be
right on machines this one has never seen, and a launch never leaves this
machine, so all it could add is the guard's silence — see below.

## Why living inside the repo changes the answer (#146)

An hkb under the repo root moves the answer to "where is hkb" from the machine
to the **project**. With `npm i -D hkb-cli` the version is pinned in
`package.json` and the lockfile, so every machine that runs `npm install` has
the same one at the same relative path; with a checkout of hkb the file is
simply *there*, in the same place for everyone who cloned it. Claude Code sets
`CLAUDE_PROJECT_DIR` for hook commands precisely so a project can name its own
files, so this is the one command that is exact *here* and correct *everywhere
else* at the same time. `isPortableHookCommand` says so, and it is what makes
`--shared-hooks` worth using at all on such a repo: commit
`.claude/settings.json` and a teammate's `git pull && npm install` is the entire
setup — they never run `hkb init`. (Before #144 this shape *chose* the tracked
file on its own. It no longer does: being portable answers "may it go there",
never "should it", and only a human asking wants hooks in every session.)

The second row is not a curiosity: hkb's own repo is that case, and the
`hkb: not found` noise that filed #146 was read there as well as on the adopter.
A rule that required `<root>/node_modules/` would leave the tool unable to fix
the repo it ships from.

### The remainder is measured, not composed

`projectBinRel` (`src/init.js`) joins two facts: `insideRepo(root, PKG_ROOT)`
(`src/model.js`), which returns the real `/`-separated remainder — `''` for a
checkout of hkb, `node_modules/hkb-cli` for a devDependency — and
`packageBinRel()`, the `bin` entry read out of the package's own `package.json`.
Composing `node_modules/<name>` instead would be a guess, and a wrong one for
two layouts that really occur: pnpm resolves through
`node_modules/.pnpm/<name>@<version>/node_modules/<name>`, and a nested install
sits under another package. A guessed path that does not exist is the worst
possible failure here, because the guard makes it *silent*: the hook exits 0
forever and nothing ever fires.

Two paths under the root are refused rather than named: an npx cache wherever it
sits, and a `.claude/worktrees/<attempt>` checkout (`worktreePath`,
`src/model.js`) — gitignored, and gone with the attempt, so an hkb run out of
one must never put that path in a file the whole team reads.

## The trap: "is hkb on PATH" is the wrong question

`hkbOnPath` (`src/board.js`) is asked on behalf of a process that is not this
one. Run as `npx hkb init`, npm has already put `node_modules/.bin` on this
process's PATH — so an unfiltered `command -v hkb` answers **yes** for a repo
that only installed hkb locally, init writes the bare `hkb` form, and it
resolves nowhere else: not in a hook's `/bin/sh`, not for a teammate. The fix is
to strip those entries before asking (`stripNodeModulesBin`, `src/model.js`),
and to answer the question that actually matters by **path comparison** instead
(`insideRepo`) — where `PKG_ROOT` sits relative to the repo root, which no PATH
can lie about.

## The guard is about worktrees, not paranoia

A worker runs in `.claude/worktrees/kb-<n>-<k>` (`worktreePath`,
`src/model.js`), a fresh checkout with no `node_modules` until it runs
`npm ci` — and `$CLAUDE_PROJECT_DIR` there is the worktree, not the main
checkout. So `guardedHookCommand` tests for its own file and exits 0 silently
when it is missing. Nothing is lost by waiting: both hooks are inert without
`KB_TASK` anyway, and by the time the `Stop` hook has a nudge to deliver the
worker has installed.

#144 closed the cost that came with waiting, and this is the reason
`workerHookSettings` passes `binRel: null`. A worker's `$CLAUDE_PROJECT_DIR` is
that empty worktree, so a guarded command in its launch would be silent for
exactly the early part of an attempt where a short card can be finished without
ever seeing a Stop nudge. The launch names the hkb that ran the dispatcher
instead — installed by definition — and the guard is left to the
`--shared-hooks` file, which the worker also reads and where it is still exactly
right: silence until the install.

## What doctor makes of it

`checkHooks` (`src/doctor.js`) asks its question of the *launch* first — it
builds the command a worker will run with `hkbCommandForHook` and checks that,
naming `hookLaunchProfiles` as the source — and of any settings file that still
has hkb hooks second. It resolves `$CLAUDE_PROJECT_DIR` against the repo root
before looking (`resolveHookPath`, which normalises to platform separators so a
Windows lookup is not half-POSIX) and reports the file it found, not the
variable. Two checks belong to the move itself:

- **`hooks in settings`** — a warning per settings file that still configures
  hkb's hooks, because they run in every session there and a worker runs them
  twice. The per-developer copy's fix is `hkb init`, which removes it; the
  tracked one is the operator's to delete, since `--shared-hooks` writes it on
  purpose.
- **`launch hooks`** — a warning per Claude launch frozen in `board.json`
  without `{hook_settings}` (`staleHookLaunches`). `loadBoard` lets an array in
  the file win whole, so a launch an older `init` wrote out never gains the
  flag, and with no settings file to fall back on that profile's workers would
  quietly get no Stop nudge and record no session id. This is the same
  frozen-copy blind spot `worker permissions` watches on `allowed_tools`, and
  the fix branches the same way: drop `"launch"` from one of hkb's own profiles,
  or add the token by hand to a custom one.

Three older verdicts are specific to the command shape:

- a **guarded** command whose file is missing is a *warning* naming
  `npm install` — that is the normal state of a checkout nobody has installed
  yet, not a fault;
- unless the repo's own hkb is somewhere else entirely, in which case the
  committed path has *moved* (a version-stamped pnpm store after an upgrade) and
  no install brings it back: a **failure** naming `hkb init`, because silence
  here is the bug rather than the state;
- a bare `hkb` in a repo that carries its own is a **failure** naming
  `hkb init`, even where it happens to work: it is in the file everyone reads,
  and everyone else has only what their checkout gave them.

## Two small parser consequences

The guarded form is the first command hkb writes that is not `<program> <args>`,
and two pure functions had to grow up rather than gain a special case:

- `hookCommandNeeds` records `VAR=value` assignments, expands `$VAR`/`${VAR}`,
  and looks for `node` anywhere in the line rather than only at the front — so
  it reports the file a guarded command needs, plus a `guarded` flag that is
  what lets doctor tell "waiting" from "broken";
- `isHkbHookCommand` now accepts `;` as well as whitespace after the binary,
  because the guarded form names `hkb.js` inside an assignment that ends with
  one. It has to keep matching every form hkb has *ever* written: that predicate
  is what lets init rewrite and — since #144 — *remove* its own hooks without
  touching an operator's (`stripHkbHooks`).

## Codex, Copilot and `.mcp.json` get the same remainder, unguarded (#166)

`projectBinRel` measures one remainder; four writers spend it. Two more —
`installHarness` and `mcpLaunch` (`src/init.js`, `src/mcp.js`) — used to call
`hkbCommandForHook()`/`projectBinRel()` with no `root`, so on a devDependency
or self-checkout repo they always fell through to the machine-specific branch
and wrote an absolute path into the tracked `.codex/hooks.json`,
`.github/hooks/kanban.json` and `.mcp.json` — the exact failure #146 fixed for
Claude's settings file, just not reached from these two call sites.

Neither Codex nor Copilot sets `$CLAUDE_PROJECT_DIR`, but both already run
their hook's command from the project root — Codex's `-C <worktree>` is also
its cwd, and Copilot's dispatcher-made worktree the same — so the fix is the
same remainder, named relative to that cwd instead of through a variable:
`relativeHookCommand` (`src/init.js`), reached through
`hkbCommandForHook(verb, { cwd: true })`. `mcpLaunch` (`src/mcp.js`) does the
matching thing for `.mcp.json`, since Claude Code and VS Code launch MCP
servers from the project directory too — `{ command: 'node', args: [rel,
'mcp'] }` instead of the absolute fallback.

The one thing that does **not** carry over is the guard. `guardedHookCommand`'s
`f="…"; [ -f "$f" ] || exit 0; exec …` is shell syntax, and whether Codex or
Copilot run `command` through a shell is not documented by either — so
`relativeHookCommand` ships unguarded: `node "<rel>" hook <verb>`, correct as
plain argv or as a `sh -c` line either way. The cost is a hard failure, rather
than the guarded form's silent exit 0, in the narrow window before a fresh
worktree has run `npm ci` — accepted rather than risk a `f="…";` that some
harness might exec literally as a program name. `checkHarnesses` and the new
`checkMcp` (`src/doctor.js`) run the same resolve check on these files that
`checkHooks` runs on Claude's settings, reading the command back out of the
generated JSON (`harnessHookCommand`) rather than trusting what was last
written. `docs/harnesses.md` has the side-by-side table of what all three
writers produce for each install shape.

## What needed no case at all

`skills/kanban/scripts/hkb`, the shim a worker calls, was already right: a
session started through npm/npx has `node_modules/.bin` on PATH, and `npx -y
hkb-cli` resolves `node_modules/.bin` before the registry — so both of its
branches land on the pinned copy. Only the hooks, running in a bare `/bin/sh`,
ever had to be told.

Proof that the shape works end to end lives in `scripts/smoke-pack.mjs`
(`checkInitInsideRepo`, called twice — `checkInitDevDependency` and
`checkInitSelfCheckout`). Only a tarball run can prove it, because the source
tests cannot put `PKG_ROOT` anywhere but this checkout: it puts the packed
package *into* a scratch repo — under `node_modules/`, then as the repo itself —
runs init, checks the tracked file names the measured path and not the temp
directory, and runs the generated command through `sh` twice, once with the file
present and once against a checkout that has not installed, asserting exit 0 and
no output both times.

## Related

- [hkb at a glance](../architecture/overview.md)
- [Telling an adopter their hkb is old](./update-notice.md)
