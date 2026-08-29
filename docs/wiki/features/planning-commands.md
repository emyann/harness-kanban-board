---
title: The planning commands — `/kanban:specify` and `/kanban:decompose`
summary: The two board operations that need a model and so cannot be `hkb` verbs — one command source, registered twice, delegating to one procedure in SKILL.md.
category: features
kind: explanation
audience: [dev]
read_when: "adding or renaming a /kanban:* command, changing what hkb init writes into .claude/, or wondering why decomposition is not a CLI verb"
covers:
  - path: src/init.js
    sha: 97954d3aaabb24d3b64b45aa10c2bad5cac4a3e4
  - path: src/doctor.js
    sha: 726a4571cf94906b8f54183c2b3223e125ad6149
  - path: skills/kanban/SKILL.md
    sha: 6371b1ff24fa12109c2bf1563194daffdc7c7df0
  - path: commands/specify.md
    sha: 4e307a13e4fd097f8581c312f9dca12868e1a62e
  - path: commands/decompose.md
    sha: bbf33b0d43e4f6d3f1269dbe3254d831a515d954
  - path: scripts/smoke-pack.mjs
    sha: 32bb83973bf13894c4d5201e14021a70d9257080
generated_at_commit: 39d9c05
last_refreshed: 2026-08-29
related: [features/operator-seat, architecture/overview, decisions/adr-004-roles-and-adoption, features/tracks]
---

# The planning commands — `/kanban:specify` and `/kanban:decompose`

> Two things a board needs are not `hkb` verbs and never will be: sharpening a triage one-liner into
> a spec, and splitting a goal into a dependency graph. Both need a model, and the dispatcher is
> deliberately free of one. They live instead as **harness slash commands** — which means something
> has to register them, and for a while nothing did.

## Why they are not CLI verbs

The frugality rule is that `hkb dispatch` holds no LLM: the graph lives on the cards as issue
dependencies, and the tick only reconciles labels, locks and attempts against it. A hypothetical
`hkb decompose` would put a model inside the dispatcher — so `SKILL.md` says outright that there is
no such verb (`skills/kanban/SKILL.md`, the `/kanban:decompose` section). The procedure runs in a
human's session, proposes, and stops for approval before it writes anything to the board.

That leaves the harness as the only place they can be named, and a slash command as the only shape
that reads like a verb: one issue number in, a fixed procedure out.

## One source, registered twice

`commands/` at the package root holds one flat file per command — `specify.md` and `decompose.md`, and
since #149 `operate.md`, which is not a planning command and has its own page
([features/operator-seat](./operator-seat.md)) — and they are registered by two different mechanisms
that happen to agree on the resulting name:

| install path | what registers it | resulting name |
|---|---|---|
| the Claude Code plugin | `"commands": "./commands"` in `.claude-plugin/plugin.json` | `/<plugin>:<file>` → `/kanban:specify` |
| `hkb init` (no plugin) | copied to `.claude/commands/kanban/` (`src/init.js:132-140`) | `/<dir>:<file>` → `/kanban:specify` |

A plugin namespaces its commands by **plugin name**; a project namespaces them by **directory**. The
plugin is named `kanban` and the directory init writes is `kanban`, so both spellings produce the same
two names — which is what lets `SKILL.md` document one invocation that is true either way.

Two consequences worth knowing before editing:

- **The plugin directory must stay flat.** A subdirectory under `commands/` would namespace a second
  time (`/kanban:<dir>:<name>`), and the skill would be advertising a name nobody can type. A test
  holds that line (`test/init.test.js`, "the plugin registers the same commands, and they ship").
- **hkb's own repo links rather than copies.** `installCommands()` calls `linkDir()` when
  `isPackageRepo()` is true (`src/init.js:132-140`), so `.claude/commands/kanban` is a symlink to
  `commands/` — the same reasoning as `.agents/skills/kanban`: in the repo that *is* the package, a
  copy would be a second source of truth that can be committed stale.

## The bodies delegate; the procedure has one home

Each command file is a handful of lines that sends the reader to the section of `SKILL.md` with the
same name (`commands/decompose.md`, `commands/specify.md`; the sections are at
`skills/kanban/SKILL.md:322` and `:350`). Nothing about the procedure is restated there, because two
copies of a procedure are one copy plus a future divergence — and the same text has to serve harnesses
with no slash commands at all. Copilot CLI and Codex read the skill and ask for the section by name;
they get the identical procedure.

Each file names both possible locations of `SKILL.md` (`.agents/skills/kanban/SKILL.md` after
`hkb init`, `${CLAUDE_PLUGIN_ROOT}/skills/kanban/SKILL.md` under the plugin) rather than assuming one,
because a single file is read in both contexts.

## What went wrong, and the three guards that replaced it (#92)

`SKILL.md` advertised both names — in its frontmatter `description` and as two section titles — while
nothing registered either one. There was no `commands/` directory, no `commands` key in the plugin
manifest, and no entry in the package `files` list. Typing `/kanban:decompose 103` on a fresh install
produced `Unknown command`. It survived because the failure only lands on the first person who types
it, and the people who wrote the skill asked for the section by name instead.

The fix ships the commands; what keeps them shipped is three checks, each aimed at a different way the
same bug comes back:

- **`files` stops shipping them** → `scripts/smoke-pack.mjs` fails. `commands/specify.md` and
  `commands/decompose.md` are in `MUST_SHIP` (`scripts/smoke-pack.mjs:37-38`), and the copies init
  writes are compared against the packaged originals in `FROM_PACKAGE`
  (`scripts/smoke-pack.mjs:68-69`) after a real `hkb init` in a scratch repo.
- **The skill names a command that does not exist** → `npm test` fails. One test scrapes every
  `/kanban:*` out of the installed `SKILL.md` and asserts the set equals the set of files that ship
  (`test/init.test.js`, "every /kanban:\* the skill advertises is a command that exists").
- **A repo where they were never installed** → `hkb doctor` says so. `checkCommands()`
  (`src/doctor.js:43-49`) warns with `hkb init` as the fix, rather than leaving the discovery to a
  session that types the command.

The general lesson is the one the card stated: documentation that instructs an action is a promise,
and the cheapest place to break it is a name nobody on the team has to type.

## Related

- [features/operator-seat](./operator-seat.md)
- [architecture/overview](../architecture/overview.md)
- [decisions/adr-004-roles-and-adoption](../decisions/adr-004-roles-and-adoption.md)
