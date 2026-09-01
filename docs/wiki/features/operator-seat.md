---
title: The operator's seat as a procedure (`/kanban:operate`)
summary: The third slash command — why the one seat hkb cannot enforce got a written brief instead, where its reaction table's vocabulary comes from, and what keeps the two in sync.
category: features
kind: explanation
audience: [dev, ops]
read_when: "changing what a session may do on someone's board, adding an event kind / status / outcome / block kind, or wondering why the operator's limits are prose rather than a guard"
covers:
  - path: skills/kanban/SKILL.md
    sha: a6ffdcca307a58e568a02ff17cba8a00ef3e7caa
  - path: commands/operate.md
    sha: 868663f4ad694f7e336ebbdfec7952e4afd621e1
  - path: src/watch.js
    sha: 8aba4c441e35c9241124c1278b5f4824706f7e52
  - path: src/model.js
    sha: 022ed7b17c5debc59265f8a1627f82386864de00
  - path: src/cli.js
    sha: 13555690946205fd3e221a8c0b4dcb2b0a92c623
  - path: src/lifecycle.js
    sha: 98cf380069697936e2b62fb17402bae7099cf06f
  - path: src/init.js
    sha: aee5eed4dcc544f9a6fe81c7273f96432aaf1048
  - path: src/stats.js
    sha: f81bc37dad19e253bf23a696ba899b4219dd5e53
generated_at_commit: bcd1dc5
last_refreshed: 2026-09-01
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
`down` outright, the same three land in `DENY_PATTERNS` (`src/model.js:838-846`)
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

## Step 1 prints a shape, not a report

The section's first step brings the board up — `hkb up --serve`, `hkb up --status`,
`hkb doctor` — and for a while it asked only that the session "say which board you
are operating and what `hkb up --status` and `hkb doctor` report". Taken literally
that is an instruction to transcribe: every doctor line replayed, the spend window
recited, the seat's own rules restated at the human who wrote them. Operate is the
first command of a session, so the cost lands where attention is scarcest — the
human has read a page and still has to work out where to start.

So step 1 now specifies the artefact instead of the topic: board and serve URL, the
two pids, **one** verdict for `doctor`, a lane table, at most three things that need
the human, the merge mode. The rules under it are all subtractive — `doctor`
collapses to "all ✓" unless something is actually wrong, `hkb stats` belongs to
step 3's once-a-cycle line and is news only when a number moved, and the seat's
limits live in the section rather than in every opening.

One rule is additive, and it is the one a status line cannot give you: **an idle
dispatcher and a busy one print the same pid**. A board whose open cards are all in
*triage* will tick forever against an empty queue while every process reports
healthy, so the lane table is the only place that difference shows, and the section
requires it to be said out loud with the promote decision under *Needs you*.

The screen carries two lists, and the split between them is the seat's own
line. *Needs you* is decisions only the human can take. *Start here* is up to
four cards worth working now, ranked by what the board can actually say — a
defect in the board's own machinery first, because every other card runs on it
and the human is running on it right now, then a card in *review*, then a `kb:needs-human` card whose answer is visible,
then fan-in, the card the most others are blocked by — with `kb.priority`
below all three, because the flag has a documented direction and no documented
scale (#207) and numbers filed by different hands do not compare. The line ends
with the command that acts on it, unrun: suggesting is the seat's, promoting is
the human's, and naming the verb without typing it is exactly where that
boundary sits.

The boundary is written into step 5: the opening report is step 1's, every cycle
after it is the watch digest, and both keep the same economy — a transition, a verb
and a handback are worth a line each.

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
  (`src/lifecycle.js:304-314`). It carries no answer with it — so unblocking
  without first writing the answer onto the card relaunches a worker into the
  same wall, and burns an attempt doing it.
- **Not every block asks for a human.** `block --kind dependency` puts the card
  in *todo* and adds no label; `transient` leaves it *blocked* with no label
  either; the rest add `kb:needs-human` (`src/lifecycle.js:296-301`). The third
  block on the *same reason* stops going to *blocked* at all and lands in
  *triage* with the label (`block_recurrence_limit`, `src/lifecycle.js:285-295`)
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
- **The CLI cannot print step 1's screen.** The shape is specified; assembling
  it is still manual. `hkb up` prints no serve URL, so the URL comes out of the
  first line of `.kanban/logs/serve.log`, and the lane table comes from `hkb list`
  (every open card, bodies and all) or from `stats --json`, which pays for a 7-day
  attempt history to reach `tasks.by_status` and still has no priority spread.
  Filed as #204.
- **The spend row is ahead of the data.** The section asks for `hkb stats --json`
  once a cycle and names `attempts.by_outcome` and `spend.by_profile`
  (`src/stats.js`), which exist. A per-model breakdown does not — `zeroUsage()`
  (`src/stats.js:93`) is a turn count and four token counters, summed for the
  whole window, and `hkb stats --json` carries no `by_model` — and neither
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
