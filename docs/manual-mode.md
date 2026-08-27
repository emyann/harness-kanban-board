# Driving a board by hand

Hand mode and autonomous mode are the same protocol with a different dispatcher — you, or the tick. Nothing on
the board knows which one moved a card: the claim is a git ref either way, the attempt is a row in the same run
comment, and a finished card leaves the same structured result behind for whoever picks up the next one. This
page is the whole day-one loop with no `hkb dispatch --loop` running anywhere.

Adoption is a ladder, not a migration. You can stop on any rung, and nothing you do on the way up has to be
undone: turning the tick on later is one command against a board that already has the shape it needs.

## Day one

```bash
npx hkb-cli init                 # labels, .kanban/board.json, the worker skill, the Stop + PreToolUse hooks, the CLAUDE.md/AGENTS.md section
npx hkb-cli doctor --api         # gh auth, labels, GraphQL fields, the issue-dependency API and lock-ref CAS
```

Setup is the same one an autonomous board gets — you simply never start the loop. Skip `--with-actions`, and
keep the hooks: they are what makes an agent *you* launch obey the protocol (see *Hand the card to an agent*).
Everything below assumes `hkb` on your PATH (`npm i -g hkb-cli`); `npx hkb-cli <verb>` works just as well.

## File the work

```bash
hkb create "Design the auth schema" --paths packages/db/     # → #41 ready
hkb create "Implement the auth API" --blocked-by 41          # → #42 todo, because #41 is still open
hkb create "Rip out the legacy session table" --triage       # → #43 triage, an idea to sharpen later
```

A card with no open blocker is created **ready**, one with an open blocker is **todo**, and `--triage` parks it
before either. `--blocked-by` is GitHub's own issue dependency, so the order you just described is visible in
GitHub's UI and survives every tool that reads the repo. The rest of `create` is the same as always
(`--agent`, `--priority`, `--paths`, `--model`, `--max-runtime`, `--goal` …) — nothing about a card says whether
a human or a dispatcher will work it.

## See the board

```bash
hkb list                         # every card, grouped: triage todo ready running blocked review done
hkb list --status ready          # your queue
hkb show 42                      # one card: settings, blockers, every attempt, parent results, the PR
hkb serve                        # http://127.0.0.1:4666
```

`hkb serve` is the human view of the same labels: a zero-dependency server and one inline page, no build step and
no second source of truth. Drag-drop between columns runs the same verbs the CLI does — only the legal moves, and
an illegal one is refused with the reason — so a board you drive by hand is fully drivable from the browser.

## Work a card

```bash
hkb claim 42
# #42 claimed (attempt 1, refs/kb/locks/42/1)
# export KB_TASK=42 KB_ATTEMPT=1   # then work, and finish with hkb complete|block|request-review
```

`claim` creates the lock ref, moves the card to *running* and opens attempt 1 — marked `manual`, because no
process was spawned. The ref is the atomicity: a second claim on a card that already has one prints `held` and
exits 2, so two people (or a laptop and an Actions runner) cannot both take #42. `--spawn` hands the card to the
profile's launch command instead, which is exactly what the tick would have done.

Then read the brief:

```bash
hkb context 42                   # or pipe it straight to an agent: claude "$(hkb context 42)"
```

`hkb context` is not a summary of the card — it is the exact prompt the dispatcher would have launched a worker
with: the body, the acceptance criteria, the scope in `kb.paths`, **every parent's structured result**, prior
attempts on this card, the comments left since the last attempt ended, and the protocol reminder. Read it
yourself or hand it to an agent; it is the same text either way.

Work on a branch and open a PR whose body says `Closes #42` — the same convention every dispatched worker
follows, and what turns a merge into a closed card. Nobody makes a worktree for you here: by hand you are in your
own checkout, and `git worktree add` is yours to run if you want the isolation.

Then finish with **exactly one** terminal verb:

```bash
hkb complete 42 --from-stdin <<'EOF'
{"summary": "what changed, for the next worker",
 "metadata": {"changed_files": ["src/auth.js"], "verification": ["npm test"], "residual_risk": ["..."]}}
EOF
hkb block 42 "the Stripe key is not in the repo" --kind needs_input
hkb request-review 42 --summary "..." --reviewer <github-user>
```

`complete` on a card with an open PR that says `Closes #42` moves it to *review*, not *done* — merging the PR is
what closes the issue. `block` sends it to *blocked* (or back to *todo* for `--kind dependency`) and flags most
kinds `kb:needs-human`, which is a note to yourself when you are the human.

The summary is not paperwork. It is what the next card's worker reads under `## Parent task results`: every agent
run leaves a summary the next run reads — even when you launch the agent yourself.

## The heartbeat contract

A hand-claimed attempt has no process for anyone to watch, so **the heartbeat is the only thing holding it**:

```bash
hkb heartbeat 42                 # every ~10 minutes of long work
```

It is a compare-and-swap on your own lock ref — an empty commit pushed with `--force-with-lease` — so it costs
nothing and writes nothing to the issue. If the lease is rejected the ref is no longer yours: `hkb` prints
`LOCK_LOST` and exits **3**. Stop there. Do not commit, do not push, do not call a terminal verb.

Two clocks judge a hand attempt, and only these two — the "no pid, must have crashed" rule that governs spawned
workers deliberately does not apply to it:

| clock | default | where | what happens |
|---|---|---|---|
| `stale_after` | 3600s | `.kanban/board.json` → `dispatch.stale_after` | quiet for longer and the next tick reclaims the card back to *ready*; your next heartbeat is `LOCK_LOST` |
| `max_runtime` | 3600s | the card's `kb.max_runtime`, else `dispatch.max_runtime_default` | an attempt older than this is `timed_out` however faithfully it beat |

Either way the card goes back to *ready* and the attempt is counted as a failure, so a card reclaimed past its
`max_retries` (2 by default) ends up *blocked* with `kb:needs-human` — which, when the human is you, is just the
board telling you where you left off. A hand session that will span a day wants the second clock raised on the
card: `hkb create "…" --max-runtime 86400`, or edit the `kb` block in the issue body.

The honest half: **only a tick reclaims anything.** With no dispatcher running anywhere, a silent attempt sits in
*running* forever and nothing takes it from you. The moment one does run — the reconcile below, an Actions
sweeper, a colleague's `--loop` — those two numbers are the whole liveness check.

## Steering, and the levers a tick would have pulled

```bash
hkb comment 42 "prefer the existing migration runner"     # steering: the next brief reprints it
hkb promote 43                                            # triage → todo · todo/blocked → ready
hkb request-changes 42 "no down step in the migration"    # review → ready, same branch
hkb unblock 42                                            # clears kb:needs-human and the failure count
hkb link 41 42                                            # #42 blocked by #41 (`unlink` undoes it)
hkb archive 42                                            # off the board, closed
```

A comment on a card is read back into the next brief: `hkb context` reprints the human comments left since the
last attempt ended (plus the last few standing ones) under `## Comments`, marked as coming from the operator. It
is the cheapest way to change what the next run does without rewriting the card.

`hkb promote` is the by-hand version of the tick's own promote step: *triage* → *todo* when an idea is sharp
enough, and *todo*/*blocked* → *ready* when it is workable — even with a blocker still open, which `hkb` reports
as `(forced: blockers not done)` rather than doing quietly. Nothing promotes itself while no tick runs, so this
is the lever that keeps `hkb list --status ready` an honest queue. (`hkb claim` never checks the status, so you
*can* claim straight out of *todo* — the statuses are for you and for whatever picks the board up next.)

## Reconcile what GitHub closed behind you

Merging a PR that says `Closes #42` closes the issue — GitHub does that, not hkb — so until something looks, the
card still wears `kb:status:review`. One command does the looking:

```bash
hkb dispatch --max 0             # reconcile + promote + reclaim + sweep; claims nothing, launches nothing
hkb dispatch --dry-run           # what a full tick would do, without writing
```

`--max 0` runs the entire tick except the claiming: cards GitHub closed land on *done*, *todo* cards whose
blockers all closed become *ready*, attempts past their clocks are reclaimed, and the worktrees, branches and
orphan lock refs of finished cards are swept. It is the one dispatcher command hand mode wants — after a merge,
or once a morning.

Run it from a shell with **no `KB_TASK` exported**: `hkb` refuses to dispatch from a worker's environment, because
a second dispatcher against a live board double-claims tasks.

## Hand the card to an agent

The `export` line that `claim` prints is for the agent's session, not for yours:

```bash
KB_TASK=42 KB_ATTEMPT=1 KB_PROFILE=claude claude "$(hkb context 42)"
```

With `KB_TASK` set, the hooks `hkb init` installed come alive in that session: the `Stop` hook nudges an agent
that tries to end its turn without a terminal verb (twice, then it lets go), and the `PreToolUse` hook applies the
worker permission policy — files inside the repo, commands on the profile's allowlist, decided rather than
prompted. That is why `KB_PROFILE` is worth setting: with no profile named, the allowlist is only `hkb`, `git`,
`gh` and shell builtins, so the agent's `npm test` is denied.

You need none of those variables yourself. Every verb takes the task number and resolves the card's open attempt,
so `hkb heartbeat 42` and `hkb complete 42 …` work from any shell, agent or no agent.

## Bringing an existing roadmap

You have a `roadmap.md` and a habit, not a board. The migration is five minutes of an agent's time, not a parser
— give your agent the file and the verb:

> Read `roadmap.md`. For each story, run `hkb create "<title>" --body "<the story's own text>"`. When a story
> depends on an earlier one, pass `--blocked-by <that story's number>`. Put anything still vague behind
> `--triage`. Then show me `hkb list`.

Review it with `hkb list` or `hkb serve`, fix the edges with `hkb link` / `hkb unlink`, and the roadmap *is* the
board — with the dependencies now visible to GitHub and to every harness.

There is deliberately **no `hkb import`**. Any fixed markdown grammar mis-parses a real roadmap: the wrong
indentation becomes the wrong dependency, silently, and a board of half-right edges is worse than no board. An
agent reads the document the way it was actually written, and you review what it created before anything runs.
(The name is taken anyway: `hkb init --import` pulls your existing open **issues** onto the board as *triage*,
which is a different job.) The decision, and what would make it worth revisiting:
[ADR-004](wiki/decisions/adr-004-roles-and-adoption.md).

## The ladder

| rung | what you add | what it buys |
|---|---|---|
| cards only | `create`, `list`, `show`, `serve` | one place the work lives, visible in GitHub |
| the protocol by hand | `claim` → `context` → one terminal verb | every run leaves a result the next run reads |
| explicit order | `--blocked-by`, `promote` | the graph, and a queue that is true without you |
| the tick | `hkb dispatch --max 0`, then `--loop 60` | reconcile and promotion stop being your job |
| tracks and the laptop-closed board | `claude-track`, `hkb init --with-actions` | a whole subgraph per session; a board that moves without you |

The payoff rung is the second one: from there on, the board carries the handoff, and whether the next worker is
you, an agent you launched, or one the tick launched is a setting — not a different way of working.
