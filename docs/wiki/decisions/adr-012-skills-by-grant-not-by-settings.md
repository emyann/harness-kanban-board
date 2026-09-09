---
title: 'ADR-012: A worker gets a repository''s skills by grant, and never its settings'
summary: "The coupling that blocked this is not real, and the measurement broke it: `plugins: [{type:'local', path}]` puts a repository's own skills in front of a worker with `settingSources` still empty. So hkb never loads `.claude/settings.json` — those hooks are shell commands the repository author writes and hkb would run on the operator's machine — and skills arrive instead as a directory the operator grants, per board or per Job, resolved against `Board.repoPath` so a human merge stays the boundary. The grant unit is a directory rather than a skill, because `Options.skills` was measured not to narrow anything."
category: decisions
kind: decision
audience: [dev]
read_when: "giving a worker access to a repository's skills, agents or MCP servers, or asking why settingSources is empty"
status: accepted
date: 2026-09-06
supersedes: ~
superseded_by: ~
covers:
  - path: src/runtime/claude.ts
    sha: 5ae775633cae411b71443add232b79f1325c4075
  - path: src/admission.ts
    sha: ce4e291113aa9868314ce771f7fd1deb97b67ba8
  - path: src/spec.ts
    sha: 8792a804835fd0602a992aeccf978e110fe2a98f
  - path: prisma/schema.prisma
    sha: 4e4b7aa6863fad5e660435982912460565ebabf3
related:
  [
    decisions/adr-007-workload-scheduler,
    concepts/admission-control,
    architecture/runtime-layer,
    architecture/overview,
    features/skill-invocation,
  ]
generated_at_commit: 8aa5ade
last_refreshed: 2026-09-09
---

# ADR-012: A worker gets a repository's skills by grant, and never its settings

## Context

This repository carries nine Prisma skills at `.claude/skills/`. Its own workers cannot see them, so
every Job that touches Prisma rebuilds that knowledge from training data — against a version of Prisma
newer than most of it. That is the concrete form of "hkb cannot yet build hkb well", and
`docs/rebuild-plan.md` § "Parked, with the design done" B lists it as the item to decide before any
`skills` spec column is added.

The plan records the blocker as a coupling: `settingSources: ['project']` is the only route to a
repository's skills, and it re-admits project settings into a worker whose isolation rests entirely on
SDK-supplied hooks (`src/runtime/claude.ts`). **The coupling half of that is wrong**, and the way to
find out was to measure rather than to reason.

### What a worker actually sees, measured

Against the Agent SDK at `0.3.261`, in this repository, read off the `system`/`init` message — which
carries `skills`, `agents`, `mcp_servers` and `slash_commands` and arrives before any model turn, so a
variant costs one process start and no tokens:

| variant | skills | this repo's 9 |
|---|---|---|
| hkb today — `settingSources: []`, `skills` omitted | 17 | no |
| `skills: 'all'` | 17 | no |
| `skills: []` | 17 | no |
| `settingSources: ['project']` | 26 | **yes** |
| **`plugins: [{type:'local', path: <repo>/.claude}]`, `settingSources: []`** | **26** | **yes** |
| `plugins: [{type:'local', path: <repo>}]` — the repo root | 17 | no |
| plugin + `skills: ['prisma-cli']` | 26 | yes — *not narrowed* |
| plugin + `skills: ['.claude:prisma-cli']` (the qualified name) | 26 | yes — *not narrowed* |

Three things follow, and each one changes the decision:

1. **Skills and settings are separable.** The plugin route reaches exactly the same nine skills with
   `settingSources` still empty. The guard change the plan treated as the price of this feature is not
   the price of anything.
2. **The plugin path is the directory that *contains* `skills/`**, not the repository — `<repo>/.claude`
   works and `<repo>` does not.
3. **`Options.skills` narrows nothing**, in either spelling. It did not filter the advertised list with
   the bare name or the plugin-qualified one, and `skills: []` does not turn skills off. It is a context
   filter that, in this version, filters nothing — treat it as curation and never as a boundary.

### What loading settings would actually admit

The SDK's own type for `settingSources` says `'project'` loads `.claude/settings.json` and that it
"must include `'project'` to load CLAUDE.md files". And a hook in a settings file is
`{ type: 'command', command: string }` — *"Shell command to execute"*, which without an argument list
"runs through a shell (bash on POSIX, PowerShell on Windows)".

So loading a repository's settings is not trusting a document. **It is executing the repository**, on
the operator's machine, with the operator's credentials, at every tool call — for a repository whose
contents hkb is running an agent against precisely because nobody has read it yet.

That is decisive on its own and needs no further measurement.

## Decision

**hkb never loads a repository's settings. A repository's skills reach a worker as a plugin directory
the operator granted.**

1. **`settingSources` stays `[]`.** Not for want of a use — the CLAUDE.md cost below is real — but
   because the mechanism cannot be admitted for skills and refused for shell commands: it is one flag
   and it brings both.

2. **A grant is a path, on the Board and on the Job.** `Board.pluginPaths` and `Job.pluginPaths`,
   resolving through `src/spec.ts` the way every other spec field already does — the Job's value wins,
   the Board's fills a null, and the built-in is the empty list. Each path is passed as
   `plugins: [{ type: 'local', path }]`.

3. **It is called `pluginPaths`, not `skills`, because that is what it grants.** A plugin directory was
   measured to load **commands** as well as skills — a probe directory containing `skills/`,
   `commands/` and `hooks/` advertised both its skill and its slash command — and the SDK documents
   plugins as providing "custom commands, agents, skills, and hooks", with a `${CLAUDE_PLUGIN_ROOT}`
   placeholder defined on the hook-command type for exactly that case. A column named `skills` that
   also admits agents and hooks would be the sixth declaration in this project to say less than it
   does.

   > TODO-VERIFY: that a `hooks/` entry inside a granted plugin directory is *executed*. The command
   > loading was measured; hook execution was not, because observing it needs a model turn. Treat it as
   > loaded until someone measures otherwise — the assumption that costs nothing if wrong.

4. **The grant unit is a directory, and hkb does not pretend otherwise.** Per-skill grants do not exist
   at this SDK version (measurement 7 and 8 above), so no per-skill column ships. An operator who wants
   a worker to see one skill and not another arranges the directories; hkb records which directory.

5. **A path resolves against `Board.repoPath`, not against the worktree**, and a path that escapes it is
   refused at file time — the same fence `checkExportPath` puts round an export, one medium over.

6. **Nothing is granted by default**, including hkb's own `.claude` on hkb's own board.

## Consequences

**The blocker is gone, and it was never where the plan put it.** hkb can build hkb with hkb's own Prisma
skills, at the cost of one nullable column and one SDK option. The plan's Parked-B item 2 — "skills are
coupled to a guard" — is withdrawn on measurement, and this record is where that reversal is written
down.

**"It is our own repository" is not a trust boundary, and that is the answer to the second question.**
The plan asked whether hkb-builds-hkb differs from a worker on somebody else's repo. It does not, and
the reason is worth stating rather than assuming: **the thing writing to this repository is the worker.**
hkb's workers open pull requests against hkb. A worker that added `.claude/settings.json`, or a
`hooks/` directory beside the skills, would be writing configuration that a later worker executes — and
if the grant resolved against the *worktree*, a worker could write a hook that its own next attempt
runs, with no merge in between. Resolving against `Board.repoPath` makes the human merge the boundary.
It is a review boundary rather than a mechanical one, which is exactly why it should be the only one
and should be explicit.

**A worker still cannot read this repository's CLAUDE.md, and that is now a named cost rather than a
side effect.** `settingSources: ['project']` is the only route to it, and this record refuses that
route. So the contributor guide — run `npm run lint && npm test`, everything through a pull request,
prefer a builtin, do not add YAML — reaches a worker only insofar as `src/brief.ts` restates it. The
protocol rules that matter most are in the brief already. The rest are not, and closing that gap is its
own decision with its own mechanism (`systemPrompt` takes an array; `additionalDirectories` and
`AgentDefinition`s take content programmatically). **This record does not solve it and does not pretend
the plugin route did.**

**Two ceilings do not move.** The admission gate is unchanged: a granted skill is prose a worker may
read, and every tool it might suggest is still denied unless `allowedTools` admits it
(`src/admission.ts`). And the study's own layer table says why that ordering is right — prose is layer
6, the layer that "guarantees nothing; measured guaranteeing nothing twice", while admission is layer 2,
"the only layer that held when `permissionMode` did not". Granting a skill widens what a worker *knows*
and nothing about what it may *do*.

**What a worker is advertised today is unchanged and still wrong.** 17 user-level skills, 5 agents, 4
claude.ai MCP connectors and 52 slash commands, none of them permitted, all of them paid for in context
on every run, none excluded by `settingSources: []`. This record adds nine more. That the operator's
personal surface leaks into every worker is a separate defect with a separate cause, and it should not
be smuggled into a record about repository skills.

**MCP is still untouched.** Nothing passes `mcpServers` to `query()`, and `skipMcpDiscovery` on the
plugin config exists precisely because a plugin can carry MCP connections the host may not want. The
plan's ordering holds: MCP as config plus grant is next, and discovery (`hkb capabilities`) after it.

<!-- Dual mutability: once status: accepted, NEVER rewrite this record.
When the decision changes, write a new ADR, set its `supersedes`, and set
`superseded_by` here. A stale flag from wiki-check on an accepted ADR is a
prompt to consider superseding — not to edit. -->
