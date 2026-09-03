---
title: The capability map — the intent travels, the binding is local
summary: The portability contract behind a profile's `capabilities`: hkb ships a closed vocabulary of intents, a board binds each one to what its own harness calls it, an unbound intent falls back to prose, and the permission a binding needs is derived from the binding rather than typed twice.
category: concepts
kind: explanation
audience: [dev]
read_when: "adding a capability intent, binding one on a board, or touching how a launch's tool list is derived"
covers:
  - path: src/model.js
    sha: 27854e20c9e609f08ab2c49afd2f83eb0fdf08c1
  - path: src/board.js
    sha: 42bd1bb173651d9109208a702564cfc3e5e51410
  - path: src/doctor.js
    sha: 03a19a3c5f2cab7dcae844c9290ed34c03637b80
generated_at_commit: 2a3a7e3
last_refreshed: 2026-09-02
related: [features/harness-profiles, concepts/worker-identity]
---

# The capability map — the intent travels, the binding is local

> **The contract in one sentence: the intent travels, the binding is local, and
> an unmapped intent is prose.**

A harness can do things hkb has no name for. Claude Code has a review command;
Copilot and Codex have their own, or none. hkb must be able to say *"review this"*
to a session without ever knowing what the local word for it is — that is the whole
design, and the reason no command name appears anywhere in hkb outside a board's
own config.

## The three halves of the contract

| Half | Where it lives | Rule |
| --- | --- | --- |
| the **intent** | `CAPABILITIES` in `src/model.js` — a frozen map of intent → its one-line meaning | closed vocabulary; adding one means writing what it means, and a test refuses a key with no meaning |
| the **binding** | `profile.capabilities` in a board's `board.json`, validated by `loadBoard` (`src/board.js`) | local; hkb reads it, never writes a command name of its own |
| the **fallback** | `capabilityCommand(profile, intent)` returning `null` (`src/model.js`) | an unbound intent is **not** an error — it falls back to today's prose brief, which is why a board that has never heard of the key is untouched |

That last row is the difference between a capability map and a dependency. Every
board today answers `null` to every intent, and the whole feature is therefore
invisible until someone binds something.

## The grant is derived, not declared twice

The reason the map exists rather than a second config key is #114: a card naming a
skill and a launch granting the `Skill` tool were two facts a human kept in sync,
and under `--permission-mode dontAsk` an unlisted tool is *denied rather than
prompted*, so the drift was silent — the worker simply could not do the thing it
had been told to do.

So a binding carries its own permission. `effectiveTools(profile, task, board)`
(`src/model.js`) is the one derivation of a launch's tool list, and the widening
happens inside it: `capabilityGrants(profile)` reads each binding, `capabilityTool`
answers what invoking it needs on that harness (today: a slash command on a `claude`
launch needs `Skill`, everything else needs nothing), and the tool joins the
profile's grant. Nothing computes that a second time — `hkb doctor`'s
`capability map` check (`src/doctor.js`) *asks* `effectiveTools` rather than working
the answer out for itself, precisely so the check cannot disagree with the launch.

Order matters: the profile widens itself first, then the card narrows. A card still
cannot widen its own permissions, and a card that narrows past the derived tool
takes it away like any other — the profile grants, the card chooses.

## What doctor can still catch

Derivation closes the drift between a binding and its permission. It cannot close
the gap between a permission and a launch line that never spends it, so
`hkb doctor` flags a binding whose implied tool is missing from the effective tools
(a `claude` profile with no `allowed_tools` list at all) or whose launch array never
contains `{allowed_tools}`. It also prints the map, unconditionally: an operator
reading doctor to find out what *this* board calls "review" must not have to make
every binding pass first.

## Known gaps

- Only one invocation shape is known — a slash command on a Claude launch. A
  binding on another harness implies no tool, which is honest (hkb does not know how
  that harness invokes it) but means the drift guarantee is Claude-only for now.
