---
title: The capability map — binding a kind of work to what this harness calls it
summary: How a profile came to say what it reaches for inside a session, not just how to start one — the closed intent vocabulary, the board-local binding, the brief that names it, the tool grant derived from it, and the doctor check that proves the two agree.
category: features
kind: explanation
audience: [dev]
read_when: "adding or binding a capability intent, or changing how a launch's tool list is derived"
covers:
  - path: src/model.js
    sha: 4e63d8cb11f662324cd2f2d4888b471e980db053
  - path: src/board.js
    sha: 28238d1670e4c6c0807b0113adb47a8a40069b37
  - path: src/context.js
    sha: aa62c340280ec085020e25c9936c7806a2420a55
  - path: src/doctor.js
    sha: 9625ca70f81eb363002a01afbe515b540ee81d9a
  - path: src/dispatch.js
    sha: 18a622a26529bfb3b7a16cacc44f1079eee4cfb8
  - path: src/track.js
    sha: 054947b027ccb0313f31e5170b67b065aa9d99ed
  - path: src/hook.js
    sha: e47513833b60b70d069be5e9b768486e5bf3f9e9
  - path: skills/kanban/SKILL.md
    sha: 386f0eebb9da5374092734e492e109f8f9ceed4e
generated_at_commit: 1590a97
last_refreshed: 2026-09-01
related: [concepts/capability-portability, features/harness-profiles, features/operator-seat]
---

# The capability map — binding a kind of work to what this harness calls it

Before this, a profile was entirely about *spawning*: `mode`, `launch`,
`allowed_tools`, `model`, `effort`, `heartbeat` (`src/board.js`). Every field
answered "how do I start a session". None answered "what does this harness *do*
for a kind of work once the session is running".

The gap was not theoretical. `kb.skills` was a card field the brief rendered as
``Skills to apply: `/foo` `` while `Skill` was absent from the launch's tool
list — and workers launch `--permission-mode dontAsk`, which **denies** an
unlisted tool rather than prompting. The field instructed a worker to do
something the launch guaranteed it would be refused (#114). The cause is the
thing this feature fixes: a field named a capability, and nothing connected a
named capability to the launch that would have to grant it.

## The shape, in the order the pieces run

| Piece | Where | What it settles |
| --- | --- | --- |
| the seam | `effectiveTools(profile, task, board)`, `src/model.js` | one derivation of a launch's tool list, returning `{ tools, dropped }` |
| the vocabulary | `CAPABILITIES`, `src/model.js` | a frozen intent → meaning map; hkb knows the intent, never the command |
| the binding | `profile.capabilities`, validated in `loadBoard` (`src/board.js`) | what *this* board's harness calls each intent |
| the brief | `briefIntents` / `capabilityLine`, `src/context.js` | which intents a card triggers, and the one line each renders |
| the grant | `capabilityGrants` → `grantWithCapabilities`, inside `effectiveTools` | the permission a binding implies, derived rather than typed |
| the check | the `capability map` check, `src/doctor.js` | prints the map; flags a binding the launch cannot grant |
| the seat | the `review` row of `/kanban:operate` (`skills/kanban/SKILL.md`) | the operator runs the declared review capability *and* judges against *Done when* |

The seam landed first and alone, deliberately: `effectiveTools` shipped with no
new configuration and no behaviour change, so that the capability map and the
tool posture (#223) would both plug into one function instead of each reaching
into the launch and growing a second answer.

## Why the grant is derived and not a second config key

`capabilityTool` (`src/model.js`) reads the *shape* of whatever the board wrote,
never the name: a binding whose command starts with `/` on a launch whose first
element is `claude` implies `Skill`; everything else implies nothing. That
answer feeds `capabilityGrants`, whose only consumer is `grantWithCapabilities`
inside `effectiveTools` — so the permission a binding needs is computed in
exactly one place, and `hkb doctor` *asks* that function rather than working the
answer out for itself (`src/doctor.js`).

The ordering is the subtle part: **the profile widens itself first, then the
card narrows.** A card can still never widen its own grant; anything it asks for
that its profile lacks is dropped and reported in `dropped`, which `spawnWorker`
logs (`src/dispatch.js`).

## The promise that keeps it portable

A board that declares nothing is unchanged — not approximately, identically. An
unbound intent renders no line and raises no error; a profile that binds nothing
gets its own `allowed_tools` array back rather than a copy; doctor's check prints
nothing. That is what lets a Copilot or Codex board carry on without ever
learning the key exists, and it is the difference between a capability map and a
dependency. It is pinned per layer — an unchanged launch line, a `===`-identical
brief, no doctor output — and confirmed end to end on this repo's own board:
declaring `{ "review": "/code-review", "goal": "/goal" }` on the `claude` profile
adds exactly one line to `hkb context` and two to `hkb doctor`; removing it
restores both outputs byte for byte.

## Status and known gaps

Shipped across #255 (seam), #259 (vocabulary and binding), #260 (brief), #261
(derived grant, doctor, operator seat). Live behaviour verified on this board.

- **A narrowing card can strip the derived grant.** `kb.tools` intersects the
  profile's list *after* the capability widening, so a card that narrows to a set
  excluding `Skill` loses the binding's permission while the brief still names
  the bound command — the #114 drift returning through the card rather than the
  profile. Nothing reports it: the removal is not in `dropped`, which records only
  what the card asked for and did not get (`src/model.js`).
- **Fixed (#273): the two readers outside the seam now go through `effectiveTools`.**
  `trackFanout` (`src/track.js`) took an optional `task` and derives its `Agent`
  check from `effectiveTools(profile, task, cfg)`, so a root card whose `kb.tools`
  narrows `Agent` away no longer gets told to fan out — `src/dispatch.js` passes
  the root task at the one call site. The Stop hook's `preToolHook`
  (`src/hook.js`) derives `allowedCmds` from `effectiveTools(profile, null,
  ctx.cfg).tools` rather than the profile's raw list, so a capability-derived
  grant is on its radar too; it passes no `task` because it fires once per tool
  call, and fetching the card there would be a request per call rather than per
  session — so it still cannot see a card's `kb.tools`/`kb.mcp` narrowing.
- **The drift guarantee is Claude-only.** One invocation shape is known; a
  binding on any other harness implies no tool. Honest, but it means doctor can
  only prove the two agree where hkb knows how the command is invoked.
- **`kb.skills` still grants `Skill` from the card side.** Its source is a card
  field rather than a profile binding, so the map does not subsume it and #114's
  hardcoded grant stays.
