---
title: Where a hook command may say hkb is
summary: A `matcher:"*"` hook that cannot resolve breaks every tool call in a repo — so what `hkb init` writes depends on how hkb was installed, and only a devDependency earns the tracked settings file.
category: features
kind: explanation
audience: [dev, ops]
read_when: "changing what `hkb init` writes into a Claude Code settings file, doctor's hook checks, or adopting hkb as a devDependency of a repo"
covers:
  - path: src/init.js
    sha: cc7eb33b5f81c3997925b0f74c05914b7d08ea0a
  - path: src/model.js
    sha: 81a26d05ab749762d686fd93ff16a7e86ee220b4
  - path: src/board.js
    sha: 4b68e6095f7c1a2c2c3214d0e472c956f59d0e38
  - path: src/doctor.js
    sha: 27fdcb59b972a3010ece0fc72ed512cfd088727a
  - path: skills/kanban/scripts/hkb
    sha: 619505ca77807157084e456057e1857eb9a31419
  - path: scripts/smoke-pack.mjs
    sha: f82dadd95e14235637e1c9950523e5034590f90c
related: [architecture/overview, features/update-notice, concepts/roles-and-seats]
generated_at_commit: 616f0b7
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
so the `PreToolUse` one runs before *every tool call in every session* in that
repo — including sessions that have nothing to do with the board. A command
that does not resolve therefore fails constantly, with an error nobody in that
repo wrote or can explain. Meanwhile both hooks are inert without `KB_TASK`
(`src/hook.js`), so all that noise buys exactly nothing in an ordinary session.

The blast radius is why the tracked `.claude/settings.json` was off-limits for
so long (#85): it is read by teammates, and *most* commands hkb can write are
true only on the machine that wrote them.

## Three installs, three answers

`hkbCommandForHook` (`src/init.js`) is the single decision point, and
`hookPlacement` picks the file from the same facts:

| install | command written | file |
|---|---|---|
| `npm i -D hkb-cli` (the repo's own devDependency) | `f="$CLAUDE_PROJECT_DIR/node_modules/hkb-cli/bin/hkb.js"; [ -f "$f" ] \|\| exit 0; exec node "$f" hook stop` | `.claude/settings.json`, **tracked**, no flag |
| `npm i -g hkb-cli` | `hkb hook stop` | `.claude/settings.local.json`; tracked only with `--shared-hooks` |
| a checkout, or `npx` from the cache | `node "<abs>/bin/hkb.js" …`, or `npx -y hkb-cli …` | `.claude/settings.local.json` only |

The third row's absolute path is never written into a tracked file, and an npx
cache path is never written *anywhere* — `isEphemeralPath` rejects it, because
it stops existing for the installer too the next time npm cleans that cache.

## Why the devDependency changes the answer (#146)

`npm i -D hkb-cli` moves the answer to "where is hkb" from the machine to the
**project**: the version is pinned in `package.json` and the lockfile, so every
machine that runs `npm install` has the same one, at a path relative to the
repo. Claude Code sets `CLAUDE_PROJECT_DIR` for hook commands precisely so a
project can name its own files, so this is the one command that is exact *here*
and correct *everywhere else* at the same time. `isPortableHookCommand` says so,
`hookPlacement` puts it in the tracked file without anybody passing
`--shared-hooks`, and a teammate's `git pull && npm install` is then the entire
setup — they never run `hkb init` at all.

`localInstallRel` (`src/init.js`) builds the path from the package's own name
and `bin` entry via `packageInfo()`, never from a literal: rename the package
and the generated hooks follow.

## The trap: "is hkb on PATH" is the wrong question

`hkbOnPath` (`src/board.js`) is asked on behalf of a process that is not this
one. Run as `npx hkb init`, npm has already put `node_modules/.bin` on this
process's PATH — so an unfiltered `command -v hkb` answers **yes** for a repo
that only installed hkb locally, init writes the bare `hkb` form, and it
resolves nowhere else: not in a hook's `/bin/sh`, not for a teammate. The fix is
to strip those entries before asking (`stripNodeModulesBin`, `src/model.js`),
and to detect the local install by **path comparison** instead
(`isLocalInstall`) — `PKG_ROOT` under `<root>/node_modules/`, which is also true
for pnpm's store layout.

## The guard is about worktrees, not paranoia

A worker runs in `.claude/worktrees/kb-<n>-<k>` (`worktreePath`,
`src/model.js`), a fresh checkout with no `node_modules` until it runs
`npm ci` — and `$CLAUDE_PROJECT_DIR` there is the worktree, not the main
checkout. So `guardedHookCommand` tests for its own file and exits 0 silently
when it is missing. Nothing is lost by waiting: both hooks are inert without
`KB_TASK` anyway, and by the time the `Stop` hook has a nudge to deliver the
worker has installed. The cost is a real one to name in the worker prompt on
such a board — work finished before `npm ci` gets no Stop nudge (#144 closes
this by handing the worker the absolute path of the hkb that ran the dispatcher).

## What doctor makes of it

`checkHooks` (`src/doctor.js`) resolves `$CLAUDE_PROJECT_DIR` against the repo
root before looking (`resolveHookPath`) and reports the file it found, not the
variable. Two of its verdicts are specific to this shape:

- a **guarded** command whose file is missing is a *warning* naming
  `npm install` — that is the normal state of a checkout nobody has installed
  yet, not a fault;
- a bare `hkb` in a repo that installs its own is a **failure** naming
  `hkb init`, even where it happens to work: it is in the file everyone reads,
  and everyone else has only what `npm install` gave them.

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
  is what lets init move and rewrite its own hooks without touching an
  operator's (`stripHkbHooks`).

## What needed no case at all

`skills/kanban/scripts/hkb`, the shim a worker calls, was already right: a
session started through npm/npx has `node_modules/.bin` on PATH, and `npx -y
hkb-cli` resolves `node_modules/.bin` before the registry — so both of its
branches land on the pinned copy. Only the hooks, running in a bare `/bin/sh`,
ever had to be told.

Proof that the shape works end to end lives in `scripts/smoke-pack.mjs`
(`checkInitLocalInstall`): it installs the packed tarball *into* a scratch repo,
runs init, and then runs the generated command through `sh` twice — once with
the install present, once against a checkout that has not run `npm install` —
asserting exit 0 and no output both times.

## Related

- [hkb at a glance](../architecture/overview.md)
- [Telling an adopter their hkb is old](./update-notice.md)
