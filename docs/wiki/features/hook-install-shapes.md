---
title: Where a hook command may say hkb is
summary: A `matcher:"*"` hook that cannot resolve breaks every tool call in a repo — so what `hkb init` writes depends on where the running hkb lives, and only one that lives inside the repo earns the tracked settings file.
category: features
kind: explanation
audience: [dev, ops]
read_when: "changing what `hkb init` writes into a Claude Code settings file, doctor's hook checks, or adopting hkb as a devDependency of a repo; also when a hook command in a repo does not resolve"
covers:
  - path: src/init.js
    sha: 352a6abaaaaa92d5b989b4a1f14fd1ebbff4b3f2
  - path: src/model.js
    sha: 9ec1c457784b57b6c9e4d8e0eb1de1d4ea2693cc
  - path: src/board.js
    sha: 0d1c297b6990a63cf28b6bf18f9e4e85180b8c21
  - path: src/doctor.js
    sha: 874e74bb49f3d9c6a20ffd504d4845909b1b360b
  - path: skills/kanban/scripts/hkb
    sha: 619505ca77807157084e456057e1857eb9a31419
  - path: scripts/smoke-pack.mjs
    sha: 0e2463ed7aff790ed98e3a2cf8dfcfb09b98054d
related: [architecture/overview, features/update-notice, concepts/roles-and-seats]
generated_at_commit: 6444cf9
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

## One question, four answers

`hkbCommandForHook` (`src/init.js`) is the single decision point, and
`hookPlacement` picks the file from the same facts. The question it asks is not
"which package manager" but **"is the running hkb inside the repo it is setting
up"**:

| where the running hkb lives | command written | file |
|---|---|---|
| inside the repo — `npm i -D hkb-cli` | `f="$CLAUDE_PROJECT_DIR/node_modules/hkb-cli/bin/hkb.js"; [ -f "$f" ] \|\| exit 0; exec node "$f" hook stop` | `.claude/settings.json`, **tracked**, no flag |
| inside the repo — a checkout of hkb setting *itself* up | the same, with `$CLAUDE_PROJECT_DIR/bin/hkb.js` | `.claude/settings.json`, **tracked** |
| `npm i -g hkb-cli` | `hkb hook stop` | `.claude/settings.local.json`; tracked only with `--shared-hooks` |
| somebody else's checkout, or `npx` from the cache | `node "<abs>/bin/hkb.js" …`, or `npx -y hkb-cli …` | `.claude/settings.local.json` only |

The last row's absolute path is never written into a tracked file, and an npx
cache path is never written *anywhere* — `isEphemeralPath` rejects it, because
it stops existing for the installer too the next time npm cleans that cache.

## Why living inside the repo changes the answer (#146)

An hkb under the repo root moves the answer to "where is hkb" from the machine
to the **project**. With `npm i -D hkb-cli` the version is pinned in
`package.json` and the lockfile, so every machine that runs `npm install` has
the same one at the same relative path; with a checkout of hkb the file is
simply *there*, in the same place for everyone who cloned it. Claude Code sets
`CLAUDE_PROJECT_DIR` for hook commands precisely so a project can name its own
files, so this is the one command that is exact *here* and correct *everywhere
else* at the same time. `isPortableHookCommand` says so, `hookPlacement` puts it
in the tracked file without anybody passing `--shared-hooks`, and a teammate's
`git pull && npm install` is then the entire setup — they never run `hkb init`
at all.

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
worker has installed. The cost is a real one to name in the worker prompt on
such a board — work finished before `npm ci` gets no Stop nudge (#144 closes
this by handing the worker the absolute path of the hkb that ran the dispatcher).

## What doctor makes of it

`checkHooks` (`src/doctor.js`) resolves `$CLAUDE_PROJECT_DIR` against the repo
root before looking (`resolveHookPath`) and reports the file it found, not the
variable. Three of its verdicts are specific to this shape:

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
  is what lets init move and rewrite its own hooks without touching an
  operator's (`stripHkbHooks`).

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
