---
title: The tool-grant ceiling — the board grants, a card lowers, only a human raises
summary: The one-sentence ceiling rule behind a worker's permissions: the board's profile is the ceiling, `kb.tools`/`kb.mcp` on a card can only lower it, and nothing raises it but a human editing board.json — plus where that rule is enforced and where doctor prints it.
category: concepts
kind: explanation
audience: [dev]
read_when: "touching kb.tools/kb.mcp on a card, a profile's tool posture or MCP list, or anything that decides what a worker may run"
covers:
  - path: src/model.js
    sha: 3fc2333b8ea559cea894aad79c82906b0d7b4387
  - path: src/tasks.js
    sha: 6cbae757123f219fc49887566f1f647936dcc88e
  - path: src/doctor.js
    sha: 5abc1e90778b7ac61fab595b66146c00e965927d
generated_at_commit: 77b1616
last_refreshed: 2026-09-01
related: [concepts/capability-portability, features/denied-tools-ledger, features/harness-profiles]
---

# The tool-grant ceiling — the board grants, a card lowers, only a human raises

> **The rule in one sentence: the board is the ceiling, a card can lower it, and
> nothing raises it but a human editing `.kanban/board.json`.**

That is the whole invariant. Everything below is where it is enforced and how you
can see it.

## Why a ceiling at all

A worker runs unattended under `--permission-mode dontAsk`, where an unlisted tool
is **denied rather than prompted**. So the permission decision is made entirely in
advance, by config, and the only question that matters is *who gets to write that
config*. If a card could add a tool to its own launch, then whoever can file an
issue can grant an agent a capability the board never approved — the seat problem
one rung down. Hence the asymmetry: narrowing is a card's business, widening is a
human's.

## The three places the rule lives

| Where | What it does |
| --- | --- |
| `effectiveTools(profile, task, board)` in `src/model.js` | the **only** derivation of a launch's tool list, and the one place the rule is enforced: the profile's grant is intersected with `kb.tools`, then filtered by `kb.mcp`, and anything the profile does not cover comes back in `dropped` with a reason instead of in `tools` |
| `normalizeCardGrants(kb)` in `src/tasks.js` | the path the card keys enter on (`toTask`): they are settled into lists of trimmed, deduplicated names. A key that is not a list at all is left untouched — coercing it would be a guess on the one axis where a guess widens someone's permissions |
| `checkToolPosture` / `checkCardGrants` in `src/doctor.js` | print what the board decided (posture, ceiling size, MCP answer, one line per profile) and flag any open card asking for what its profile does not grant |

Note what is *not* in that table: nothing recomputes the grant. Doctor asks
`effectiveTools` with the card, exactly as the dispatcher does (`src/dispatch.js`),
so the check cannot drift from the launch — the same discipline the capability map
follows (`concepts/capability-portability`).

## Narrowing on two axes

- **`kb.tools`** — tool patterns. The result is the card's list, minus everything the
  profile does not cover. `covers` in `src/model.js` treats `*` as the only wildcard,
  so `Bash(git *)` on the profile covers `Bash(git status)` on the card.
- **`kb.mcp`** — MCP server names. It keeps only tools belonging to the named servers
  and leaves every non-MCP tool alone, so a card can say "this task talks to
  react-aria and nothing else" without listing its whole tool set.

Both compose, and both drop rather than grant. `kb.tools: []` is legal and means
exactly what it says — no tools at all — which is the strictest thing a card can ask
for and still the *right* direction of travel.

## What a card cannot do, stated as failure modes

- Ask for a tool the profile lacks → dropped, reported in `dropped`, and reported
  again by `hkb doctor`'s `card grants` check with the board.json edit that would
  actually grant it.
- Ask for an MCP server the profile does not reach → same, as `mcp__<server>__*`.
- Write `"tools": "Read"` instead of a list → narrows nothing. It *reads* like a
  restriction and is not one, so doctor calls it out by name rather than letting a
  card look safer than it is.

## Posture, and what doctor prints

A profile also states a **posture** — `"tools": "inherit" | "curate"`, absent meaning
`curate` (`toolPosture`, `src/model.js`) — and its `mcp` key means opposite things at
the two ends: under `curate` the servers a worker *may* reach, under `inherit` the
servers to *exclude*, so a "never let this board touch production supabase" rule is
expressible as a subtraction. `hkb doctor` prints one line per profile naming the
posture, the ceiling, and which of those two readings its MCP list is under —
unconditionally, because a posture nobody can see is indistinguishable from no
posture at all.

## Known gaps

- The posture is printed, not yet spent: `effectiveTools` derives from
  `allowed_tools` whatever the posture says. Wiring `inherit` into the launch line
  and resolving `mcp` into it belong to other cards on the same track.
