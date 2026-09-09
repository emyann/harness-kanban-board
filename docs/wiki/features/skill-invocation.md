---
title: Skill invocation — the grant that did nothing until `Skill` was on the surface
summary: "ADR-012 measured a repository's skills REACHING a worker and never one being CALLED — `Skill` was absent from the default tool surface and the admission gate denies what is not on it, so every plugin grant on every board was inert. Admitting it widens nothing: a skill is a prompt expansion, and every tool it then reaches for comes back through the same gate. With the three runs that measured the first skill invocation this project has recorded, and what stays denied."
category: features
kind: explanation
audience: [dev]
read_when: "granting a --plugin-dir, narrowing --allow-tool, or wiring a step that runs a slash command like /code-review"
covers:
  - path: src/runtime/surface.ts
    sha: 91dc14a46f39d60c04e59d95dbc5d6c4c360d67c
  - path: src/runtime/claude.ts
    sha: 99f48dce1ec77266c5f486a386d55d438a02397c
  - path: src/runtime/fake.ts
    sha: 1a034150eee10661a6f1e5abac96e0e58499492d
related:
  [
    decisions/adr-012-skills-by-grant-not-by-settings,
    concepts/admission-control,
    architecture/runtime-layer,
    gotchas/prompt-is-not-a-guarantee,
  ]
generated_at_commit: 01c316b
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

## Known gaps

- **`hkb show` prints `(runtime default)` rather than the resolved list** for a
  Job that named no surface (`src/hkb.ts`), so an operator cannot see that
  `Skill` is on it without reading the code. Until that lands, `hkb --help`'s
  `--allow-tool` entry names `Skill` — and names `Agent` as absent — so a
  narrowing operator knows what they are dropping.
- **A grant is per-directory, not per-skill.** ADR-012 measured `Options.skills`
  narrowing nothing in either spelling, so granting `.claude` grants all nine
  Prisma skills and anything else that directory later carries. The fence is the
  human merge, not a filter.
- **`/code-review` and the reviewer step still cannot run.** They need `Agent`,
  which stays denied until the subagent fence is measured across a spawn.
- The measurement above ran `--no-isolate` on a clone, because nothing about
  admission is worktree-shaped. A skill invoked inside a sandboxed worktree
  additionally meets the `pre-push` hook and the two escape refusals
  (`concepts/admission-control`), which are unchanged by any of this.
