---
title: Backlog grooming — `hkb groom` and `/kanban:groom`
summary: The triage lane as a report: the arithmetic computed without a model from the one board read, the judgment left to the skill, and the human yes that is the only thing that writes.
category: features
kind: explanation
audience: [dev]
read_when: "adding a groom finding or action, changing the frozen groom --json shape, touching how blockers are filled, or wondering why hkb groom never promotes anything"
covers:
  - path: src/model.js
    sha: 96d73c3e1721735a52e0ca67752476040135d04a
  - path: src/cli.js
    sha: c349ca9283acb8f7899354061cd7b9cdd7cefeef
  - path: src/tasks.js
    sha: f67ad46d8fdf8791f2477e0c55db8e2433a084b8
  - path: src/doctor.js
    sha: 976283bd0771f28d8a687aa83509d62b86468210
  - path: skills/kanban/SKILL.md
    sha: 7c36fd46a71d2a636e88db89aa064a63e44ab5f3
  - path: commands/groom.md
    sha: 4fc2dc2db984033fe8801e8d28b50e8e68fefddc
  - path: skills/kanban/references/protocol.md
    sha: 771770f1e8c420d821bf81c34bd63cd9dbc23d87
generated_at_commit: 108bd15
last_refreshed: 2026-09-01
related: [features/planning-commands, features/operator-seat, features/path-overlap-guard, features/tracks]
---

# Backlog grooming — `hkb groom` and `/kanban:groom`

> Triage is where a card waits for a human's yes. Nothing on the board used to say *what* was waiting
> or *why* — five cards could sit there with every blocker closed and no surface mentioned it. Grooming
> is the answer, and it is deliberately cut in two: the half that is arithmetic is a `hkb` verb that
> writes nothing, and the half that is judgment is a slash command that writes only what a human
> approved, row by row.

## The cut: arithmetic in the CLI, judgment in the skill

The frugality rule is that the dispatcher holds no model. Most of what a groomer wants to know is not a
judgment at all — whether every blocker is closed as completed, whether `kb.paths` is empty, whether the
body has a spec shape, which cards name each other, which pairs share files. That is arithmetic over the
board read `hkb list` already makes, so it lives in `src/model.js` beside `blockerDone`, `computeReady`,
`priorityOf` and `pathsOverlap`.

What is left genuinely needs a model — is this a duplicate, which way does the link point, is the decision
already made for the worker — so it lives in `SKILL.md` next to specify and decompose
(`skills/kanban/SKILL.md:503`), for the same reason those are not CLI verbs
([the planning commands](planning-commands.md)).

The seam between the halves is a **closed vocabulary exported from code**, not prose that hopes to stay in
sync: `GROOM_KINDS` maps every finding kind to its level (`src/model.js:601`) and `GROOM_ACTIONS` is the
fixed list of things a row may propose (`src/model.js:634`). `test/skill.test.js` asserts every kind has a
row in the skill section and every action appears in the action column — the drift test is what makes the
export a contract rather than a coincidence.

## Levels are advice about who decides, not severity

A finding carries `act`, `ask`, `info`, or `needs_judgment` (`src/model.js:601-633`), and the distinction is
about **who is competent to decide**, not how bad it is:

- **act** — mechanical and safe to propose as a command (`unblocked`, `no_paths`, `malformed_kb`, `cycle`,
  `two_agents`, `blocker_off_board`).
- **ask** — real but false-positive-prone, so the model must look (`thin_spec`, `dead_blocker`,
  `blocker_in_triage`, `priority_inversion`, `merged_pr_open`, `broad_path`).
- **info** — context for a row, never an action (`no_blockers`, `unknown_blockers`).
- **needs_judgment** — a *shortlist*, explicitly not a verdict: `mentions_unlinked` and `overlap_pair` say
  "these deserve a look", and the skill supplies one fixed question per kind.

Two of these levels are computed rather than fixed. `no_goal` is `act` in the table but is emitted as
`info` when the body already carries a Done-when heading — a card with no `kb.goal` and a real acceptance
section is promotable as written, and on this repo's board twelve cards are exactly that. And `unblocked`
requires `blockedBy.length >= 1`: without that clause a card that was never blocked by anything matches
too, and the finding stops meaning anything.

### The three false-positive guards worth knowing about

These are the ones a later change is most likely to break:

- **Hubs.** A path most of the board names — `src/model.js`, `src/cli.js` — carries no signal about any
  particular pair. `pathHubs(tasks, share = 0.25)` (`src/model.js:719`) finds them and `pathJaccard`
  (`src/model.js:758`) removes them before scoring an overlap, so pairs are ranked on the files that
  actually distinguish them. The threshold is floored at three cards: a quarter of a small board is two,
  and a path exactly two cards name is the pair signal itself.
- **The guard-aware overlap wording.** `overlap_pair` never claims two cards *will* serialize; it says they
  serialize only when `dispatch.guards.path_overlap` is on, and the live report states whether it is on for
  this board (`src/cli.js:441-457` passes the mode in). On a board with the guard off, an overlap is a
  merge-conflict risk and nothing more.
- **Unknown ≠ empty.** An empty `blockedBy` on a card nobody looked up is not "no blockers"; reporting it
  as such would be the silent wrong answer the values forbid. `fetchBoard(ctx, { blockers: 'all' })`
  (`src/tasks.js:140-144`) REST-fills every open card on a repo without the GraphQL `Issue.blockedBy` field,
  and the fill's provenance travels with the board and is read back through `blockersOf` / `blockersKnown`
  (`src/tasks.js:91-100`). `unknown_blockers` is what a card outside the fill's scope gets. The same gate
  gets the ` ⇡ unblocked` nudge in `hkb list` right (`src/cli.js:359`): the marker is computed in memory
  from the same rule, and suppressed entirely when blockers were never filled.

## `hkb groom` writes nothing, and costs one request

The verb is one `fetchBoard` then one pure `groomBoard` (`src/cli.js:441-457`), and that is the whole
implementation: no per-card call, no second query, no write of any kind. Verified live against this
board — `hkb groom --json` made exactly **one** `gh api graphql` invocation and zero REST writes.
`protocol.md:136` states the same thing as a protocol fact: `hkb groom` is a read exactly as
`hkb dispatch --dry-run` is, changing no status, label or transition.

On a repo *without* GraphQL `blockedBy` the read is no longer free — it becomes one REST call per open
card — so `hkb doctor` names that cost before anyone runs it on a large board
(`src/doctor.js:464-478`), and stays silent about it when the field is present.

The `--json` field names are **frozen**: later kinds are added to a card's `findings`, never renamed. The
token argument for the shape is `bodyText`, which is attached only to cards that need judgment (or under
`--bodies all`) — the whole point is that a groom read is a fraction of dumping the lane's bodies.

## The procedure, and the one thing that writes

`/kanban:groom` (`skills/kanban/SKILL.md:503`, registered from `commands/groom.md`) reads the report
**once**, judges only `judgment.cards` and `judgment.pairs`, proposes one table grouped by cluster, and
then stops. Nothing is applied until a human says yes per row. What the approved batch may execute is
deliberately short — `hkb comment`, `hkb create --triage --blocked-by`, `hkb link`, and one `hkb promote`
of cards that are already in triage. `hkb edit` now exists (below) but the procedure does not yet route
`specify`-flagged findings through it — a body/`kb` rewrite still goes through the `/kanban:specify` PATCH
recipe. Archive, supersede and close-as-duplicate stay **handed back as pre-staged commands** rather than
run, because the verbs that would make them safe do not exist yet (see the gaps below).

This is also the one sanctioned exception to the operator's "never promote" rule: the human's per-row yes
is what makes the promotion theirs rather than the agent's.

## `hkb edit` — the write half of the kb block

`hkb edit <n>... [--paths a,b] [--goal ".."] [--scheduled-at ISO] [--priority N]`
(`src/cli.js`, `case 'edit'`) sets exactly the kb keys a flag names, spreading
them over the task's existing `kb` object and leaving every other key as read,
then writes the block back with `updateBody` (`src/tasks.js:330`) — the same
PATCH-the-body-block path `/kanban:specify` uses by hand. It takes multiple
task numbers, like `promote`/`archive`, because `priority_inversion`'s
suggestion can name more than one blocker at once
(`src/model.js:901`). `test/cli.test.js` pins it two ways: one test asserts a
partial edit changes only the keys named, and another runs every `hkb edit`
line a groomed board actually suggests (`malformed_kb`, `no_paths`,
`broad_path`, `priority_inversion`) straight through `hkb edit` and asserts
none of them throw a usage error.

## Known gaps

- **`hkb promote --triage-only` does not exist.** The design called for a flag that skips a card not in
  triage without writing; `promote` takes numbers only, so the procedure leans on reading the `forced`
  line in the output and treating it as a stop-and-report.
- **No close-as-duplicate verb**, which is why the handback list exists at all.
- Deliberately deferred as too noisy to be worth a row today: `stale` / `--older-than`, `decision_open`,
  `too_big`, `--comments`, and web-board chips — `src/serve.js` is untouched by the feature.

## Related

- [The planning commands](planning-commands.md)
- [The operator seat](operator-seat.md)
- [The path-overlap guard](path-overlap-guard.md)
