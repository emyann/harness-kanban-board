---
title: Skill invocation — the grant that did nothing until `Skill` was on the surface
summary: "ADR-012 measured a repository's skills REACHING a worker and never one being CALLED — `Skill` was absent from the default tool surface and the admission gate denies what is not on it, so every plugin grant on every board was inert. Admitting it widens nothing: a skill is a prompt expansion, and every tool it then reaches for comes back through the same gate. With the three runs that measured the first skill invocation this project has recorded, and what stays denied."
category: features
kind: explanation
audience: [dev]
read_when: "granting a --plugin-dir, narrowing --allow-tool, or wiring a step that runs a slash command like /code-review"
covers:
  - path: src/plugins.ts
    sha: 50314938ab90cd9f5793091dc79faf6a5bd52e65
  - path: src/runtime/surface.ts
    sha: e7660f0ce513bfc804cc31a0a92040e5bdc7fa1a
  - path: src/runtime/claude.ts
    sha: c19d9065a63bc8265bbad6bcb29f1643bfe72938
  - path: src/runtime/fake.ts
    sha: 6a1ec6e6f7890b54a254018b3b7d277020b4b23e
related:
  [
    decisions/adr-012-skills-by-grant-not-by-settings,
    concepts/admission-control,
    architecture/runtime-layer,
    gotchas/prompt-is-not-a-guarantee,
  ]
generated_at_commit: ff67f87
last_refreshed: 2026-09-09
---

# Skill invocation

A plugin grant put a repository's skills in front of a worker and the worker
could not run any of them. Both halves were true for three days and neither was
visible from the other: `--plugin-dir .claude` was accepted, resolved,
containment-checked and passed to the SDK, and `Skill` — the tool that *invokes*
a skill — was not on the default tool surface, so the admission gate denied it
like anything else absent from the list.

That is the shape the contributor guide warns about: a declaration that reads as
load-bearing and does nothing.

## Why it was invisible

ADR-012 measured the right thing and stopped one step early. Its table reads the
session's `init` message and shows the advertised tool count going 17 → 26 with a
local plugin granted — the nine skills **reach** the worker. Reaching is what an
`init` message can show, and it costs no tokens to read, which is exactly why the
measurement stopped there. Being *called* needs a model turn, and nothing had
ever bought one for this question.

So the record's own consequence — "granting a skill widens what a worker *knows*
and nothing about what it may *do*" — was true in a stronger sense than intended:
it widened what a worker knew and the worker could do nothing with it.

## Why admitting `Skill` widens nothing

The layers are `docs/workflow-study.md` §4. Invoking a skill is a **prompt
expansion** — layer 6, the layer that guarantees nothing: the skill's markdown
arrives in context and the model reads it. Every tool the skill then reaches for
is an ordinary tool call and arrives back at **layer 2**, the `PreToolUse` gate,
judged against the same surface as any other call (`src/admission.ts`,
`concepts/admission-control`).

So the grant and the gate keep pointing in the directions ADR-012 gave them:
`--plugin-dir` widens what a worker may *read*, `--allow-tool` bounds what it may
*do*, and `Skill` is on the *do* side only in the trivial sense that reading is
something a worker does.

`Agent` is the exception and it is not this feature's question. A skill that
spawns subagents — `/code-review` — needs `Agent`, and `Agent` is denied on the
default surface (`src/runtime/surface.ts`). The spawn is a tool call, so the gate
refuses it whether the prompt asking for it came from a brief or from a skill.

## The measurement

2026-09-09, three Jobs on a clone of this repository, each `--no-isolate` with
`--plugin-dir .claude` (its nine Prisma skills), on the Agent SDK's default
model. Read from the attempt rows the controller wrote — `denials` is the SDK's
own `permission_denials` count (`src/runtime/claude.ts`).

| surface | what the worker tried | tool stream | turns | `denials` | cost |
|---|---|---|---|---|---|
| default | invoke `prisma-cli` | `-> Skill` | 3 | **0** | $0.206 |
| `--allow-tool Read --allow-tool Bash` | invoke `prisma-cli` | `-> Skill` (**denied**) | 2 | **1** | $0.160 |
| default | invoke `prisma-cli`, then use it | `-> Skill`, `-> Read` | 4 | **0** | $0.121 |

Three things this pins down, and none of them was known before:

1. **A worker invoked a skill.** The call it reported making was
   `Skill(skill: ".claude:prisma-cli")` — the plugin-qualified name, which is the
   form ADR-012 measured the SDK advertising.
2. **The skill's content actually loaded**, rather than the tool merely being
   permitted. The run came back with the consent-variable rule from
   `.claude/skills/prisma-cli/SKILL.md:194` —
   `PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION`, set to the user's exact message
   and never invented text — which is skill text, not a thing to guess.
3. **The gate still refuses, at a real narrowing.** The middle row is the
   refusing case run against the real SDK: an operator who narrows to `Read` and
   `Bash` has dropped `Skill` with everything else, the worker is told so in the
   gate's own words (*"not part of this workload's tool surface. Available: Read,
   Bash."*), and the refusal is counted on the attempt where `hkb show` prints
   it. A grant is not a permission.

The third row is the one that answers "does the gate stay in front of what a
skill causes": the `Read` after the `Skill` is a tool call like any other and
went through the same hook.

## Where the default surface lives, and why it moved

`DEFAULT_TOOLS` was a constant inside the Agent SDK driver, which made the
shipped default reachable only by buying a session. Every test of the gate
therefore supplied its own `allow` list — proving the code and not the product,
which is the failure mode CLAUDE.md names.

It is now `src/runtime/surface.ts`: `DEFAULT_TOOLS`, `toolSurface(spec)` and
`admissionPolicy(spec)`, a pure module with no I/O, in the pattern of
`src/limits.ts` and `src/liveness.ts`. `src/runtime/fake.ts` builds the policy
from the same function and puts its own tool calls through the real gate, so
"what may a Job that named no surface call" is a question the free test suite can
ask — and be refused by (`test/tool-surface.test.ts`).

That also makes the fake's `denials` real rather than a hardcoded `0`.

## The fence: only what was granted

Admitting `Skill` to the surface is not the whole feature, and the first
implementation of this card shipped without the other half. ADR-012's rule is
that nothing reaches a worker the operator did not grant it, and its own
Consequences section records what a worker is advertised with `settingSources:
[]` and **no grant at all**: *"17 user-level skills, 5 agents, 4 claude.ai MCP
connectors and 52 slash commands, none of them permitted"*.

**"None of them permitted" was true only because `Skill` was off the surface.**
Put it on and leave `Options.skills` unset, and every ordinary Job — nothing
granted, no `--plugin-dir` near it — can invoke the operator's own `~/.claude`
skills: content nobody granted, on a repository hkb is running an agent against
precisely because nobody has read it yet.

So the driver passes `Options.skills` explicitly on every run
(`skillFilter`, `src/runtime/surface.ts`):

| the Job | what the SDK is handed | why |
|---|---|---|
| no plugin grant | `[]` | nothing was granted, so nothing is enabled |
| granted `.claude` | that directory's skills, twice each | only what the operator granted |
| `--allow-tool Read,Bash` | `[]` | the operator dropped `Skill`; the SDK hears it too, not just the gate |

Omitting the option is **not** "skills off" — `sdk.d.ts` says so in as many
words: *"omitted (default): no SDK auto-configuration. The CLI's own defaults
still apply."* An empty array is what shuts the door.

### Two spellings, because the canonical name is not ours to know

`sdk.d.ts` matches an entry against *"the exact canonical name (e.g.
`my-plugin:my-skill`) or a `:name` suffix of it"*. Whether a local plugin's
skills are canonically bare (`prisma-cli`) or qualified (`<plugin>:prisma-cli`)
depends on how the SDK names a local plugin, which hkb does not control and has
not measured. `skillFilter` emits **both** `name` and `:name`, so the fence
matches either — and no guess can fail open, because a name matching nothing
enables nothing.

The names come from the granted directories themselves (`discoverSkills`,
`src/plugins.ts`): `<grant>/skills/<name>/SKILL.md`, directory name wins,
symlinks followed — this repository's own `.claude/skills/*` are symlinks into
`.agents/skills/`, so a reader that skipped them would be inert in the shipped
layout.

### ADR-012 measurement 7 and the SDK now disagree

That record says *"`Options.skills` narrows nothing, in either spelling"* and
declines to ship a per-skill column on the strength of it. At the pinned
`0.3.261` the SDK documents the opposite: a `string[]` enables only the listed
skills, and *"unlisted skills are hidden from the model's listing and rejected
by the Skill tool."* The measurement and the shipped contract disagree, and the
contract is what runs. **This is a note, not a quiet edit to an accepted record**
— ADR-012 wants a fresh measurement and probably a superseding one.

### What the fence is not

`sdk.d.ts`, restated because it bounds the claim: *"This is a context filter,
not a sandbox: unlisted skills are hidden from the model's listing and rejected
by the Skill tool, but their files remain on disk and are reachable via
Read/Bash."* That is a property of granting `Bash` at all, not something this
undoes.

## `Skill` is not in `allowedTools`, deliberately

The gate's list and the SDK's list are the same value minus one entry
(`queryOptions`, `src/runtime/claude.ts`). `Skill` stays on the **gate's**
surface — a skill invocation is a tool call and admission judges it — while
`Options.allowedTools` must not carry it: `sdk.d.ts` deprecates that spelling
twice and points at `Options.skills` as *"the single place to turn skills on"*.
Leaving it there works today and stops working on the SDK bump that drops the
deprecated handling — silently, with no failing test, which is this card's own
bug returning by another door.

## Known gaps

- **A grant is per-directory, not per-skill.** Granting `.claude` grants all
  nine Prisma skills and anything that directory later carries. The fence above
  is per-*grant*, not per-skill; narrowing further is an operator's job with a
  second directory, and the human merge is still the boundary.
- **`/code-review` and the reviewer step still cannot run.** They need `Agent`,
  which stays denied until the subagent fence is measured across a spawn (#63).
- The measurement above ran `--no-isolate` on a clone, because nothing about
  admission is worktree-shaped. A skill invoked inside a sandboxed worktree
  additionally meets the `pre-push` hook and the two escape refusals
  (`concepts/admission-control`), which are unchanged by any of this.
- **The two-spelling fence has not been measured against a real session.** It
  cannot fail open, but if the SDK matched neither spelling a granted skill
  would be silently unavailable — fail-closed, and the same state the board was
  in before this card. Worth one paid run to settle.
