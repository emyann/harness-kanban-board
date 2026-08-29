---
title: The operator's seat as a procedure (`/kanban:operate`)
summary: The third slash command — why the one seat hkb cannot enforce got a written brief instead, where its reaction table's vocabulary comes from, and what keeps the two in sync.
category: features
kind: explanation
audience: [dev, ops]
read_when: "changing what a session may do on someone's board, adding an event kind / status / outcome / block kind, or wondering why the operator's limits are prose rather than a guard"
covers:
  - path: skills/kanban/SKILL.md
    sha: dd45aeca67178e556d9426803731b38bb96697d1
  - path: commands/operate.md
    sha: 7c1cb7c0a592fc3ea8ca641ca37b860a975ded66
  - path: src/watch.js
    sha: 8aba4c441e35c9241124c1278b5f4824706f7e52
  - path: src/model.js
    sha: 0b6cab6f25caa911b717dca9ba8c01d5a8510de5
  - path: src/cli.js
    sha: 61d45ac3e0e5db14140374ee021c50eda045030f
  - path: src/lifecycle.js
    sha: 2affd18fb3d2882db47ba164199b10160ba70ddb
  - path: src/init.js
    sha: 8821eb7b1550e01b157424dd32480518eb7b8b71
  - path: src/stats.js
    sha: f81bc37dad19e253bf23a696ba899b4219dd5e53
generated_at_commit: 29375f5
last_refreshed: 2026-08-28
related: [features/planning-commands, decisions/adr-004-roles-and-adoption, features/up-and-down, features/review-loop, concepts/roles-and-seats]
---

# The operator's seat as a procedure (`/kanban:operate`)

> hkb has three seats. Two of them are briefed: a worker gets `hkb context <n>`
> and the whole worker protocol, a planner gets `/kanban:specify` and
> `/kanban:decompose`. The operator — the seat the README says a session may
> drive on the human's behalf — got one sentence, and every session that took it
> rediscovered the loop by trial: `ps` for the dispatcher, a hand-rolled
> `tail -f | grep` on a scratch log to learn that a card had been claimed,
> transcript `.jsonl` files grepped to see what a worker was doing, and only on
> the fourth try `hkb watch`, the tool built for exactly that. `/kanban:operate`
> is that loop written down (#149).

## Why this seat is different from the other two

A worker is *told* what to do by the thing that launched it, and hkb enforces
the rest: `refuseIfWorker` (`src/cli.js:235-238`) refuses `dispatch`, `up` and
`down` outright, the same three land in `DENY_PATTERNS` (`src/model.js:724-732`)
for the PreToolUse hook, and the shipped Claude launches deny the dispatcher at
the harness level. Every one of those tests `process.env.KB_TASK`.

An operator session has no `KB_TASK`. Nothing in hkb distinguishes it from the
human's own terminal, and nothing should: the CLI cannot tell whose fingers are
on the keyboard, and a flag that claimed to would be a guard anyone could unset.
So **for this seat the boundary is the brief** — which is precisely why the brief
had to exist, and why step 4 of the section states the limits as a list rather
than leaving them to taste. The section says the reason in one line: a seat that
can widen its own permissions is not a seat.

## Where it lives, and why not anywhere else

The shape is the one `/kanban:specify` and `/kanban:decompose` already
established (see [features/planning-commands](./planning-commands.md)): one flat
file in `commands/`, registered twice (the plugin's `"commands": "./commands"`,
and the copy `hkb init` writes into `.claude/commands/kanban/`), whose body does
nothing but send the reader to the section of the same name in
`skills/kanban/SKILL.md`. Three consequences carried over unchanged:

- **The procedure is written once.** `commands/operate.md` restates two rules
  only — `hkb watch` is the monitor, and the approvals stay with the human — and
  points at the section for everything else.
- **A harness with no slash commands gets the identical brief.** Copilot CLI and
  Codex ask the skill for the section by name; the whole SKILL.md body is also
  spliced verbatim into the generated Copilot agent (`src/init.js`, `protocolText`).
- **Nothing enumerates the commands.** `commandFiles()` reads the directory, so
  the third command needed no code change to be installed, doctored or shipped —
  only the fixed lists in the tests and `scripts/smoke-pack.mjs`, which are
  deliberately spelled out there rather than derived.

There is no `hkb operate` verb for the same reason there is no `hkb decompose`:
it would put an LLM inside the dispatcher. The seat reads a board and decides;
the tick reconciles labels and never judges.

## The reaction table is a projection of the code's vocabulary

The middle of the section is a table per event kind, and its rows are not free
prose — they are the four enumerations the CLI already exports:

| the table's column | comes from |
|---|---|
| the ten event kinds | `EVENT_KINDS` (`src/watch.js:29`) — what `hkb watch` can emit |
| the status a `status` event landed on | `STATUSES` (`src/model.js:4`) |
| the outcome an `outcome` event landed on | `OUTCOMES` (`src/model.js:5`) |
| the `kind` on a `blocked` outcome | `BLOCK_KINDS` (`src/model.js:6`) |

Those same tokens are what `--kinds` accepts (`KIND_TOKENS`, `src/watch.js:35`),
so the table doubles as the filter vocabulary. A test asserts that every token in
all four lists appears in the section (`test/skill.test.js`, "the operate section
has a row for every event kind, outcome and block kind"): adding an outcome to
`src/model.js` without saying what the operator does about it now fails
`npm test`. That is the only coupling that keeps a written procedure honest
against code that moves.

## The four rows that encode something you cannot guess

Most rows are "nothing — the tick owns this". These four are load-bearing, and
each one is a behaviour of `src/lifecycle.js` a session would otherwise get
wrong:

- **`needs_input`: comment *then* unblock.** `unblock` clears `kb:needs-human`,
  resets the failure counter and sends the card back to *ready* / *todo*
  (`src/lifecycle.js:302-313`). It carries no answer with it — so unblocking
  without first writing the answer onto the card relaunches a worker into the
  same wall, and burns an attempt doing it.
- **Not every block asks for a human.** `block --kind dependency` puts the card
  in *todo* and adds no label; `transient` leaves it *blocked* with no label
  either; the rest add `kb:needs-human` (`src/lifecycle.js:294-299`). The third
  block on the *same reason* stops going to *blocked* at all and lands in
  *triage* with the label (`block_recurrence_limit`, `src/lifecycle.js:283-293`)
  — the board's own way of saying this is a loop, not a task.
- **`review` is the seat's one real decision, and `manual` is a real answer.**
  On `dispatch.merge.mode: "auto"` the *dispatcher* enables GitHub's auto-merge
  and the branch's gates hold it; `"manual"` means the human merges. A session
  that merges anyway has taken an approval nobody gave it — see
  [features/auto-merge](./auto-merge.md).
- **`request-changes` is a relaunch, not a rejection.** The reason typed becomes
  the next attempt's brief, on the same PR ([features/review-loop](./review-loop.md)),
  which is why the section asks for one named gap rather than a verdict.

## Known gaps

- **Nothing verifies the behaviour, only the text.** The tests assert that the
  section names every token and the commands it must run; no test drives a
  session through a `review` and a `needs_input` transition. That verification is
  a human's, once, on a live board.
- **The spend row is ahead of the data.** The section asks for `hkb stats --json`
  once a cycle and names `attempts.by_outcome` and `spend.by_profile`
  (`src/stats.js`), which exist. A per-model breakdown does not — `zeroUsage()`
  is five token counters for the whole window, with no `by_model` — and neither
  do per-*shape* completion rates or the model ladder they would argue for: they
  arrive with the cards that record a per-attempt model and an effort/ladder
  field. Until then the row is a judgement the operator makes from outcomes, and
  — either way — a proposal to the human, never a `board.json` edit.

## Related

- [features/planning-commands](./planning-commands.md)
- [features/auto-merge](./auto-merge.md)
- [features/review-loop](./review-loop.md)
- [features/up-and-down](./up-and-down.md)
- [decisions/adr-004-roles-and-adoption](../decisions/adr-004-roles-and-adoption.md)
