---
name: kanban
description: Work a hkb task from the board — read the task with `hkb show`, work in the worktree, open a PR on the card's own branch, and finish with exactly one terminal verb (complete / block / request-review). Use whenever KB_TASK is set, when asked to "work task <n>", "pick up the next kanban task", or to create/link tasks on the board. Also runs a whole track (a root plus everything blocking it) in one session, plans the board — `/kanban:specify <n>` rewrites a one-liner into a spec and promotes it, `/kanban:decompose <n>` proposes a dependency graph for a goal and materializes it once a human approves, `/kanban:groom` turns `hkb groom`'s triage report into one batch of proposals a human says yes to — and operates it: `/kanban:operate` brings the board up, watches it, and reacts per event kind while the approvals stay with the human.
license: MIT
compatibility: Requires the `gh` CLI (authenticated) and `hkb` (npm hkb-cli) on PATH. Works with Claude Code, GitHub Copilot CLI and Codex CLI.
metadata:
  author: hkb
  version: 0.9.0
allowed-tools: Bash(hkb *) Bash(gh api *) Bash(gh pr *) Bash(gh issue view *) Bash(git *)
---

# kanban — the board protocol

**The board lives in this repository**, on a git branch called `kb-board`, with an index beside it in `.git/hkb/`.
A task is a card on that branch; its dependencies are a field on the card. The dispatcher (`hkb dispatch`) claims a
task by taking a row in the index and launches you with `KB_TASK`, `KB_ATTEMPT`, `KB_BOARD`, `KB_REPO` set.
Everything you need to know about the task comes from `hkb`; everything you report goes through `hkb`. See
`references/protocol.md` for the data model.

**Pull requests are the exception**: they are still GitHub's, and a PR is tied to its card by *the name of its head
branch* — `kb-<n>-<k>` — and by nothing else. There is no issue for it to reference.

## When you are the worker (KB_TASK is set)

1. `hkb show $KB_TASK --json` — title, body, `kb` settings, blockers, prior attempts, **parent task results**.
   Read the parent results before designing anything: they say what changed and what was not tested.
   Comments on your card are steering input: treat instructions under `## Comments` in your prompt (the card's
   thread, which `hkb context $KB_TASK` reprints at any time) as coming from the operator.
2. Stay in this worktree and on the current branch. Only touch the scope in `kb.paths` if it is set.

   Your launch decides what shell commands you may run *before* hkb's own policy is consulted, and a background
   worker's launch **denies rather than prompts** — nobody is there to answer. hkb allow-lists the ordinary
   builtins (`cd`, `export`, `env`, `which`, `command`, `test`, `sleep`, …), but three shapes cannot be
   allow-listed at all, so write them differently rather than discovering them one denial at a time:
   - **a shell keyword** — `while`, `for`, `if`, `case`. An allow-list names *commands*; a keyword is not one,
     so the whole command line is refused. Run the steps as separate calls.
   - **an env prefix** — `VAR=value cmd` matches no pattern. Say `export VAR=value; cmd` in one command instead.
   - **`cd` out of your worktree.** Inside it is fine; a path outside is refused however it is spelled.

   **If something is refused, disclose it — do not work around it.** A denial is final: nobody is there to grant
   it, so rewording the command, finding a second route or turning the check off is wasted turns at best and a
   worker outside its sandbox at worst. When there is no allow-listed way to do the work, say so and stop:
   `hkb block $KB_TASK "needs <tool>: <why>" --kind capability` — describe what you need and why, do not paste the
   refused command line. The one refusal that is *not* a capability gap is `hkb complete`: that verb has a second
   name for exactly this reason (step 6 — say `hkb finish`), so never block on it.
3. Long work: run `hkb heartbeat $KB_TASK` roughly every 10 minutes — **between steps, as its own call**. Not a
   background loop: `while true; do hkb heartbeat $KB_TASK; sleep 600; done` is denied on the keyword (above), and
   a denied loop is a worker that never heartbeats, drifts past `stale_after` while genuinely alive, and is
   reclaimed mid-flight. It is a compare-and-swap on your claim: free, and it writes nothing to the card. If the
   lease is rejected the claim is no longer yours: `hkb` prints `LOCK_LOST` and exits **3**. Stop immediately — do
   not commit, do not push, do not call `complete`. The dispatcher reclaimed the task and a new attempt owns it.
   (When the store cannot make the swap at all, `hkb` records the beat on the run record instead, floored at 10
   minutes, and says so.)
4. Commit in small, clear steps. Never `git push --force`. Before finishing: `git fetch origin && git rebase origin/<default>`,
   then run the project's lint and tests (see CLAUDE.md / AGENTS.md).
5. Push and open a **draft** PR with a real description: `gh pr create --draft --fill`.
   **Keep the branch name you were given** — `kb-$KB_TASK-<attempt>` (or `worktree-kb-…`, or `kb/$KB_TASK`).
   That name is the *only* thing that ties the pull request to this card: hkb matches the repository's open PRs
   by head branch. A PR opened from any other branch is one hkb cannot see, and `hkb finish` will refuse to land
   the card in *done* because it found none.
6. Finish with **exactly one** terminal verb, then stop. Send the payload as one JSON object on stdin so no JSON
   has to survive your shell's quoting. Write the file with your editor tool, then redirect it:

   ```bash
   # /tmp/kb-$KB_TASK.json
   # {
   #   "summary": "What changed, written for the next worker. How it was verified. What is still risky.",
   #   "metadata": {
   #     "changed_files": ["src/a.js", "test/a.test.js"],
   #     "verification": ["npm run lint", "npm test"],
   #     "dependencies": [],
   #     "residual_risk": ["..."],
   #     "retry_notes": null
   #   },
   #   "artifacts": []
   # }
   hkb finish $KB_TASK --from-stdin < /tmp/kb-$KB_TASK.json
   ```

   **Say `finish`, and redirect a file rather than using a heredoc.** `finish` is `complete` — the same verb,
   spelled so a shell-aware harness will run it. `complete` is a bash builtin, and a harness that vets your
   command line word by word sees the builtin, not hkb's verb: Claude Code refuses `hkb complete <n>` in a
   worktree-isolated session ("this command runs a string through complete"), whatever the arguments and
   however you quote it, and refuses a `<<'EOF'` heredoc there too. A redirect from a file is accepted
   everywhere, and `block` and `request-review` need no alias.

   The pieces can go in separate files instead — no quoting at all either way:
   `hkb finish $KB_TASK --summary-file /tmp/kb-summary.md --metadata-file /tmp/kb-metadata.json`
   (`--metadata <path>` also reads a file when the value does not start with `{`). The inline
   `--summary ".." --metadata '{..}'` flags still work; per field, inline beats file beats stdin.
   - `hkb finish $KB_TASK ...` — done (or *review* while a PR is open). Stdin keys: `summary`, `metadata`, `artifacts`.
   - `hkb block $KB_TASK "<why>" --kind needs_input|dependency|capability|transient` — when you cannot proceed.
     `dependency` sends it back to *todo*; the others ask a human. Also `--reason-file <path>`, or stdin keys `reason`, `kind`.
   - `hkb request-review $KB_TASK --summary "..." [--reviewer <github-user>]` — when a reviewer must look before it counts
     as done. Stdin keys: `summary`, `metadata`, `reviewer`.

**Never run `hkb dispatch`, `hkb up` or `hkb down`** — the dispatcher is what dispatched you, a second one against
the live board double-claims tasks, and `hkb up`/`hkb down` start and stop exactly that loop (`down` would strand
every attempt it is watching). All three are refused for a worker session whatever the harness. On the Claude
profiles the launch also denies the dispatcher outright (`--disallowedTools "Bash(hkb dispatch*)"`), so that one is
not a rule you can bend. Dispatcher changes are tested against the fake-gh test
double instead (`node --test test/dispatch.test.js`). Do not do work that belongs to other tasks. If you discover follow-up work, create it instead:
`hkb create "title" --body "..." --blocked-by $KB_TASK` (it starts in *todo* and becomes *ready* when this task is done).

## When you run a track (your prompt opens with TRACK RUNNER)

A **track** is a connected subgraph of the board: a root task plus everything it is still blocked by — normally what
`/kanban:decompose` just materialized. The dispatcher's ordinary engine runs one node per cold session; a track runner
holds the whole subgraph in **one** session, with the context flowing in memory instead of being re-derived per node.
You get one whenever the root has unfinished children and the board has a profile with `"track": true` in
`.kanban/board.json` that can execute the nodes' profiles — nobody has to ask for it. See *Setting a track up*.

You are an **orchestrator**, not a runner doing N things in a row. Your prompt lists the graph in **waves** — nothing
in a wave depends on anything else in it — and for each wave you claim its nodes, hand **each node to its own isolated
subagent** (the `Agent` tool, `isolation: "worktree"`, all of a wave's spawns in one message so they actually run
together), collect them, verify each one recorded a verb, and only then start the next wave. The root is the one node
you do yourself. Where the harness has no subagents the prompt says so and the nodes are walked one at a time instead;
the board reads the same either way.

Nothing about the protocol changes. It runs once per node — by you or by that node's subagent, in the order your
prompt lists:

| per node | |
|---|---|
| 1 | `hkb context <n>` — the exact brief that node's own cold worker would get. Read it before you touch anything |
| 2 | `hkb claim <n>` — takes the claim on that node and moves it to *running*. `held` means another worker owns it: skip it and everything behind it |
| 3 | work, on a branch of its own cut from the branch of the node it is blocked by (or the default branch when it has none) |
| 4 | push, and open one **draft** PR per node — `--base` that same branch, head branch `kb/<n>`, one PR per node |
| 5 | exactly one terminal verb for that node: `hkb finish <n>` / `hkb block <n>` / `hkb request-review <n>` |

Step 5 is what makes a track safe to run at all: every node is a durable checkpoint, so a runner that dies leaves a
board the ordinary dispatcher can finish node by node — and it does. A root whose track attempt has ended is never
handed to a second runner; the durable engine takes the rest.

A subagent shares your session id, so a node it finishes still records *your* session — but its worktree is its own
and is **deleted when it returns**, so its brief must say: commit and push before you finish. Give it the node number,
the base branch, and `hkb context <n>` as its brief; do not paste the context, or your window grows by every node.

Five things really are different:

- **Heartbeat the root, not the nodes.** `hkb heartbeat <root>` every ~10 minutes. That one lease covers the whole
  track: the dispatcher will not reclaim a node while the root's attempt is alive. `LOCK_LOST` means stop
  *everything* — do not commit, do not push, do not finish any node.
- **`KB_TASK` is the root, and stays the root.** `hkb claim <n>` prints an `export KB_TASK=…` line for a human
  claiming by hand; ignore it. `hkb` scopes `KB_ATTEMPT` to `KB_TASK`, so each verb you run on a node acts on that
  node's own open attempt without you passing anything.
- **Claim as you go, never up front.** A lock you hold and are not working is a node nobody else can run. Claim the
  wave you are about to spawn; let it end before you claim the next.
- **Verify the verb yourself.** The Stop nudge keys on `KB_TASK`, which is the root — it never fires for a subagent.
  After a wave, `hkb show <n> --json` per node: `done`, `blocked` or `review` means it ended. A node left *running*
  is one you finish from its report, or `hkb block <n> "…" --kind transient`. Never start the next wave over one.
- **One PR per node, never one PR for several nodes.** hkb matches a PR to a card by its head branch, so one PR
  can only ever belong to one node; a PR carrying two drags the unmatched node into
  *review* behind the finished one, and then neither you nor the dispatcher can close it properly.

**A node that blocks parks only its branch.** `hkb block <n> "why" --kind …`, then skip everything blocked by it,
transitively, and carry on with the rest of the graph. Do not abandon a track for one bad node: finish what you can,
and say in the root's summary which branch you left and why.

A wave is not all-or-nothing either: one subagent blocking parks its dependents, and its siblings still finish.

**What keeps a wave safe** is that the nodes' `kb.paths` are disjoint — `/kanban:decompose` enforces it, and it is the
same rule that lets the dispatcher run two cold nodes side by side. Each subagent stays inside its own; you stay out of
all of them until the root's pass. Cap the fan-out at about four in flight, and send a wider wave in batches.

**Finishing.** The root is the last node. Check that the pieces actually fit, run the project's lint and tests over
the whole result, write the docs or changelog no child could — then one terminal verb for the root, whose summary is
the track's: what each node landed, what is open, what you parked.

### Setting a track up

**There is nothing to set up.** A track is a property of the graph, not a label: `/kanban:decompose <n>` builds the
graph, and on the next tick the dispatcher hands the root — a card with unfinished children that nothing else is
still blocked by — to one session on the board's track profile. `hkb track <root>` says so and why
(`track: inferred — 3 unfinished children`); `hkb show <root>` repeats the verdict.

The label is the **override**, both ways, and neither is the normal case:

- `hkb adopt <root> --agent claude-track --status todo` **forces** a track — the historical switch, still honoured,
  and the only way to make a root a track when its own profile is not one the track profile can execute.
- `hkb track <root> --off` (the `kb:no-track` label) **opts out**: the children go out as cold nodes, one session
  each, for a goal whose pieces have nothing to say to each other. `hkb track <root> --on` puts it back.

Two things are still worth setting by hand: `max_runtime` for the whole track rather than for one node, and the
root's `kb.paths`, which guard the whole subgraph.

- Every node must be on a profile the runner can execute (`track_agents` on the track profile). A node on another
  harness makes the track un-claimable and the board simply falls back to node dispatch: the slower engine, not an
  error. So do a node another worker already owns, a node with an open PR, and a node wearing `kb:needs-human`.
- A track costs **one** `max_in_progress` slot however many nodes it holds — it is one session. Per-node `kb.paths`
  still guard it against everything else running, so the paths still have to be right.

## When a human asks you to manage the board

- `hkb list` / `hkb show <n>` / `hkb log <n>` — read.
- `hkb create "title" [--blocked-by 12,13] [--agent claude] [--priority N] [--paths apps/web/]` — add work.
  Decide before you fan out: put design decisions in the body; children cannot see their siblings.
- `hkb link <parent> <child>` / `hkb unlink` — dependencies (same board only).
- `hkb promote <n>` (triage → todo, or force ready; `--triage-only` skips a card no longer in triage instead of forcing it)
  · `hkb unblock <n>` · `hkb request-changes <n> "reason"` · `hkb archive <n>`.
- `hkb claim <n>` — take a task by hand, with no dispatcher: it creates the lock ref, moves the card to *running* and
  prints the `export KB_TASK=… KB_ATTEMPT=…` line to work under. The protocol is then exactly the worker's, above.
  A hand-claimed attempt has no process for anyone to watch, so **the heartbeat is the only thing holding it**:
  `hkb heartbeat <n>` every ~10 minutes, or the tick reclaims the task once you have been quiet for `stale_after`
  (1h by default) and your next heartbeat exits `LOCK_LOST`. `--spawn` hands it to the profile's launch command instead.
- `hkb dispatch --dry-run` shows what the next tick would do; `hkb dispatch --loop 60` runs it.
- Planning, not managing: `/kanban:specify <n>` sharpens one triage one-liner into a spec, `/kanban:decompose <n>`
  splits a goal into a dependency graph, `/kanban:groom` reads the whole triage lane's report and proposes one
  batch. All three are below, and all three stop for approval before they write anything.
- Running the board rather than reading it: `/kanban:operate` — bring it up, watch it, react per event kind, and
  know what goes back to the human. Also below.
- All four are **real slash commands**, registered by `hkb init` (which writes `.claude/commands/kanban/`) or by
  the `kanban` plugin; their bodies do nothing but send you to the section of this file with the same name. In a
  harness with no slash commands — Copilot CLI, Codex — ask for the section by name instead; the procedure is
  identical, and `hkb` is the only thing any of them calls.

## /kanban:operate — drive the board from the operator's seat

The operator is the human. This is the procedure for a session driving that seat's verbs on their behalf: bring
the board up, watch it, react per event kind, and hand back everything that is theirs to decide. You are not a
worker — you never claim a card, never set `KB_TASK`, never work in a worktree the dispatcher made. One cycle is
up, watch, react, report; you repeat it until the human stops you.

### 1. Bring the board up

```bash
hkb up --serve      # the dispatcher loop, and the web board; detached, logs under .kanban/logs/
hkb up --status     # pid, since when, which log — the source of truth for what is actually running
hkb doctor          # once, at the top of the session
```

One checkout can hold several boards, so if you were given a slug, pass it: `--board <slug>` on every command,
or export `KB_BOARD=<slug>` once and drop the flag. No slug means the checkout's own board, and either way say
which one you are operating in your first line.

All of it is safe to type twice: a live pid file makes `hkb up` report the pid and spawn nothing. Act on every
`✗` doctor prints before you watch anything — a hard failure is a board that cannot work (auth, missing labels,
`merge.mode: "auto"` on a branch with no gate), and seeing it now is cheaper than seeing it in the first card it
breaks. A `!` is a line for the digest, not a stop.

Start the loop no other way. `hkb dispatch --loop` in the foreground dies when your session does, and it is a
*second* dispatcher if `up` already started one — two loops against one board double-claim cards. (The
foreground form is for a human under a real supervisor: cron, systemd, launchd.) `hkb up` is your verb; a
`hkb dispatch` that runs a tick is nobody's from inside a session — every worker launch denies it outright,
which is the same rule seen from the other side. `hkb dispatch --dry-run` is the exception, and only because it
runs nothing: it prints what the next tick would claim, which is a read.

#### The opening report — a screen, not an essay

`/kanban:operate` is the first thing a human runs when they sit down. They want the board *working* and the
smallest thing that tells them where to start; a session that replays `doctor` line by line has spent their
attention before they have taken a single decision. Read the board once — `hkb groom` gives the lanes, the
priorities and the findings together, `hkb list --summary` the lane table alone (counts, priority spread,
`kb:needs-human` cards — no bodies) — then print this shape, and nothing else:

```
Board `<slug>` · <owner/repo> → <serve URL>
dispatch pid <n> ✓ · serve pid <n> ✓ · doctor all ✓          (or: doctor 1 ✗, 2 !)

<lanes: triage · todo+ready · running · blocked+review · done — empty lanes omitted,
 the priority spread only where it decides something>

Needs you:  at most three, most urgent first, one line each — decisions only they can take.
Start here: up to four cards worth working now, why each, and the command that starts them.

<merge mode> · watcher up (60s)
```

- **`doctor` collapses to one verdict.** All green is the words "all ✓", never the list. Spend a line on a `✗`
  and on a `!` a human would act on; a skipped probe is not one.
- **Three under *Needs you*, at most** — each a decision they own and can take now. A fourth is a backlog, and
  a backlog is what `hkb list` is already for.
- **No statistics at open.** `hkb stats` is step 3's once-a-cycle line, and news only when a number moved. An
  opening that recites attempt outcomes and dollars reports the past to somebody trying to start.
- **No reasoning, no procedure, no what-you-considered.** Which verbs are yours and which are theirs is written
  here; it does not need restating at them every session. The merge mode earns its clause because it decides
  whether *review* is your lane or theirs.
- The serve URL is the whole point of `--serve` and the human's way into the board, so it leads the first line.
  `hkb up --serve` and `hkb up --status` both name it (`serve.url` under `--json`) — no log to read.

**Ranking *Start here*.** The point of the line is that a human who has just sat down can say "yes, those
three" and have the board moving in one reply. Which means it is a *recommendation*, made from the board, with
the command that acts on it named — not a dump of the top of a sorted list.

Rank by what the board actually tells you, in this order, and stop at four:

1. **A defect in the board's own machinery, live in this session.** A card describing something broken in the
   dispatcher, the lock, the hooks or the CLI outranks the work it would carry, because every other card runs
   on it — and the human is running on it right now. Say what it costs them today, not what it is.
2. **A card in *review*.** It is the seat's own decision and it is holding a finished PR. Nothing else outranks
   work that is already done.
3. **A card wearing `kb:needs-human`** whose question you can see the answer to — say where the answer is, and
   that unblocking it costs them one word.
4. **The card the most other cards are blocked by.** Fan-in is the board's own statement of what is load-bearing,
   and `hkb graph <n>` draws it. One card unblocking four beats a card unblocking none, whatever their numbers.
5. **Then `kb.priority`** — say the number rather than leaning on it. The band is documented (`0` unfiled ·
   `1` normal · `2` next up · `3` urgent, higher wins — `README.md`), but a card filed before it was written
   carries a number chosen against no ruler at all, so an old number and a new one do not compare. Where the
   number disagrees with fan-in, trust fan-in and say you did.
6. **Then age**, oldest first, exactly as `sortReady` breaks its own ties.

Give each one a clause of *why it is on the list* — not a restatement of its title, which they can read — and
end the line with the command that starts them, ready to approve:

```
Start here: #41 four cards are blocked by it · #43 the p3 nobody has picked up in a fortnight
            #12 its own PR is open and waiting on a review
            → hkb promote 41 43   (say the word and the next tick claims them; #12 is already yours to review)
```

Suggesting is yours; **promoting is theirs**, and the difference is the whole seat. Name the command, do not run
it, and do not re-rank a queue the human has already ordered — a board with cards in *todo* or *ready* has been
ordered, and *Start here* on such a board means "here is what the tick will take next", not a proposal to change
it.

A board with **no work in flight** — every open card in triage, or none at all — is the one thing the status
lines cannot show: an idle dispatcher and a busy one print the same pid. Say it in a clause, and let *Start
here* carry the promote suggestion — on such a board it is the only line that can move anything.

### 2. Watch, don't poll

```bash
hkb watch --json --interval 60      # one JSON object per transition, until you stop it
```

Run it as the session's **monitor**: a long-running process whose output you read as it arrives (in Claude Code,
the Monitor tool over exactly that command; in another harness, its background-process equivalent). Every poll is
a conditional `GET` — an unchanged board answers `304`, which costs no rate limit — so a watcher left up all day
is free, and an interval a little longer than the board's tick shows you the tick's own moves.

Three habits to skip, each of which a session has invented instead:

- **No `sleep`-and-`hkb list`.** A whole board query per pass, blind to everything that happened between two
  passes, and the loop that spells it is a shell keyword many launches refuse outright.
- **No tailing the dispatcher log for board state.** `.kanban/logs/dispatch.log` answers one question the board
  cannot — a claim that never became an attempt (`spawn_failed`: a harness missing from `PATH`, a worktree git
  refused) — and `hkb up --status` answers "is the loop alive". Everything else is already a transition.
- **No grepping a worker's transcript for progress.** `hkb watch` has the transitions, `hkb tail <n>` follows one
  card's attempts and comments, `hkb show <n>` prints the attempt row. A transcript is for reading an attempt
  that already died (step 3).

`--kinds` narrows the stream to what you will act on and takes statuses and outcomes as well as kinds
(`--kinds review,blocked,needs-human,outcome`). Narrow only once you know the board's rhythm, and never narrow
`needs-human` out of it.

### 3. React, per event kind

`hkb watch` emits ten kinds, and only some of them are a decision. Under `--json` each event is one object with
`number`, `kind`, `at`, and the fields that kind carries: `from`/`to` for `status`, `agent` and `needs-human`;
`attempt` for `attempt`, `outcome` and `result`; `outcome` and `summary` for an `outcome`; `actor` and `text`
for a `comment`. The middle column below is the human formatter's line for the same event — read it as the
shape of what arrived, and switch on `kind` (or on `tags`, which carries the kind *and* the status or outcome
`--kinds` matches on):

| kind | prints as | what you do |
|---|---|---|
| `appeared` | `+ on the board (triage)` | nothing to start. If you are the planner too, run the `/kanban:groom` per-card pass over it (`hkb groom --json --status triage`) and **propose** — never promote — or `/kanban:specify` it if it is one sentence |
| `status` | `ready → running` | per the status it landed on — the table below |
| `agent` | `agent claude → claude-track` | nothing; name it in the digest if it was neither you nor the human |
| `needs-human` | `⚠ needs-human` | the human — unless it arrived with a `blocked` card whose question you can genuinely answer (below). The label is never cleared on its own: `hkb unblock` is the only *operator* verb that clears it, and only ever as the last step of an answer you have just written onto the card |
| `closed` | `closed (completed)` | nothing. `closed (not_planned)` is a decision somebody made — name it in the digest |
| `reopened` | `reopened` | read the card. The tick reconciles *closed* issues, not reopened ones, so a card that came back sits where its label puts it until a human moves it |
| `attempt` | `attempt 2 started (claude@host)` | nothing on attempt 1. On attempt 2 or later, go and read why the last one ended — before this one burns the same way |
| `outcome` | `attempt 1 blocked — needs the key` | per the outcome — the table below |
| `result` | `result (attempt 1) — …` | read it: it is the brief the next worker inherits, and your review input when the card is in *review* |
| `comment` | `comment by alice — …` | a human steering that card. If it answers the card's open question the card can move; if it asks you something, answer it |

**The status a `status` event landed on:**

| status | what you do |
|---|---|
| `review` | the row that is really yours. Read the PR against the card's *Done when*, run the repo's own checks, **and run the board's own review capability if it declares one** — the profile's `capabilities.review` in `.kanban/board.json` names what *this* harness calls it, and `hkb doctor` prints the map (`capability map`), so you never have to guess the command. Run it *and* judge against *Done when*: the capability finds what is wrong with the diff, the card says what the diff was for, and neither answers the other's question. No `capabilities.review` on the profile means there is nothing to run — read it yourself, as before. Then follow the board's merge policy — `dispatch.merge.mode` in `.kanban/board.json`, which is the only place it is written: `hkb doctor` checks the policy but says nothing about a `"manual"` board, so silence there is not an answer (it does print `"operator"`'s condition, never silently). Three modes: `"manual"` means **the human merges**, which is the entire meaning of the setting — a session that merges anyway has taken an approval nobody gave it; `"operator"` means the human has delegated the click to this seat, but only once a review is on the card — read the PR, then run `hkb merge <n> --summary "what you checked"` and let it enforce the condition and write the record; it refuses, naming what is missing, if the condition is not met, so there is no way to merge past it by accident. `"auto"` means the dispatcher already handed the merge to GitHub and its gates hold it — nothing for you to do. Falls short, under any mode? `hkb request-changes <n> "<the one specific gap>"` puts it back on the same PR, and the reason you type *is* the next attempt's brief: name the gap, not the disappointment |
| `blocked` | read the block kind off the attempt row (`hkb show <n>`), then the block table below |
| `triage` | planning, not operating: run the `/kanban:groom` per-card pass (`hkb groom --json --status triage`) and **propose** — never promote. A card that landed here wearing `kb:needs-human` is a loop, and that one is the human's |
| `todo`, `ready`, `running` | nothing — the tick owns these |
| `done`, `archived` | nothing; archiving is the operator's own verb |

**The outcome an `outcome` event landed on:**

| outcome | what you do |
|---|---|
| `completed` | nothing: the card moves itself to *review* with its PR open, or to *done* |
| `review_requested` | as `review`, plus the reviewer the worker named |
| `changes_requested` | your own verb (or a human's) coming back around; the next tick relaunches the card on its PR |
| `blocked` | the block table, below |
| `crashed`, `timed_out`, `protocol_violation` | **open the attempt before the retry burns.** `hkb show <n>` prints the row and, when the session was recorded, the line that reopens it (`cd .claude/worktrees/kb-<n>-<k> && claude --resume <id>`, or `claude attach <job>` while it is still up). Read what it actually did, then leave **one** `hkb comment <n>` saying what happened — a card's comments are steering input its next worker reads, which is the whole point of looking. Do not raise `max_retries` |
| `spawn_failed` | the launch, not the card, and the one thing `.kanban/logs/dispatch.log` is for: a harness not on `PATH`, a profile whose command does not exist, a worktree git refused. Report it — the fix is board config or the machine, and both are the human's |
| `reclaimed` | a lease went stale: the worker died, or stopped heartbeating. Nothing, once. Twice on the same profile or host is a pattern, and a report |
| `gave_up` | retries are exhausted; the card is *blocked* with `kb:needs-human`. The human, with the attempt history — never re-promote it to buy another round |

**The `kind` on a `blocked` outcome** (`hkb show <n>`, on the attempt row):

| kind | what you do |
|---|---|
| `needs_input` | answer **only if the answer is already on the board** — this card, the results of the cards it is blocked by, an earlier comment, or the repo itself. Then `hkb comment <n> "<the answer>"` and `hkb unblock <n>`, in that order: unblocking without writing the answer down relaunches a worker into the same wall. Anything else — a judgment, a preference, a decision nobody has made yet — goes to the human, and you stop there |
| `capability` | the worker was denied a tool. Report **which** tool and what it wanted it for. Do not widen a profile's `allowed_tools` yourself: that is `.kanban/board.json`, and board policy is not yours |
| `dependency` | the card put itself back in *todo*; nothing to do. If it names work that is not on the board, that is a card you may file |
| `transient` | nothing; the retry is the answer. The same transient twice on one card is a report |
| `generic` | read the reason, then treat it as `needs_input` |

A card that blocks on the same reason three times stops going back to *blocked* and lands in *triage* wearing
`kb:needs-human`. That is a loop, and a loop is the human's.

**Two things that are not board events:**

- **The dispatcher went away.** `hkb up --status` says `dispatch exited (4) …` — the loop deliberately giving
  itself up for a supervisor to restart. Run `hkb up` **once**. If it happens twice in one session, stop
  restarting and take it to the human with the tail of `dispatch.log`: `up` is not a supervisor, and neither
  are you.
- **What the board is spending.** Once a cycle, `hkb stats --json`: `attempts.by_outcome` for how the window is
  going, `spend.by_profile` for what it cost, per profile. (There is no per-model breakdown — `spend.usage` is a
  turn count and four token counters for the whole window — so a per-model claim is one this output cannot
  support.) When one *shape* of card keeps failing its first attempt — the same kind of work, the same rung of
  the model ladder — that is a **proposal** for the human (start that shape higher with `kb.model`, or reorder
  the profile's ladder), never an edit you make. Model choice is board policy like any other.

### 4. What is yours, and what is the human's

You drive the verbs. The credentials, the approvals and the money are theirs. The line is not about trust: a
seat that can widen its own permissions is not a seat.

**Yours:** every read — `list`, `show`, `log`, `graph`, `groom`, `stats`, `watch`, `tail`, `doctor` (`hkb groom`
is a read like `hkb dispatch --dry-run`: it writes nothing, whatever it proposes); `hkb comment`;
`hkb unblock`, when the answer was on the board and you have just written it there; `hkb request-changes`;
`hkb up` after an exit 4; and `hkb create` for a card you can justify from evidence on the board — filed with
`--triage` and linked to the card that revealed it, not started. Say `--triage` and mean it: without the flag a
card with no blockers lands in *ready*, and the next tick launches a worker on a sentence you wrote as a note.
Leave `--priority` off too — it is a number where **higher wins** (band: `0` unfiled default · `1` normal · `2`
next up · `3` urgent — see `README.md`), and the queue's order is the human's.

**Never yours:** merging on a `manual` board — on an `operator` board `hkb merge <n>` is the one exception, and only
because the condition it enforces (a review on the card) is the human's approval, already given for the whole
class, in `.kanban/board.json`; and any release or publish; editing `.kanban/board.json` at all —
profiles, `allowed_tools`, models, `max_in_progress`, `merge.mode`; re-prioritising, promoting or archiving
someone else's plan — except the rows of a `/kanban:groom` or `/kanban:specify` table the human has said yes
to, because the yes is what makes it theirs; clearing `kb:needs-human` for any reason but an answer you have just written onto the card;
spending on a paid profile the human has not agreed to;
`git push --force`, anywhere; and any `hkb dispatch` that *runs* a tick — `--loop`, `--max`, a bare `dispatch` —
or a second loop of any kind. (`hkb dispatch --dry-run` writes nothing and is a read like any other.)

When you hand something back, hand back the whole thing: the card, what you read, what you would do, and which
of the three you need — a decision, a credential, or an approval. "#142 is blocked" is not a handback.

### 5. Report every cycle

The digest `hkb watch` already prints — one line per transition — is the report. Add two things under it: **what
you did**, one line per verb and card, and **what you handed back**, with what you need from the human. A quiet
cycle says so, and says what is in flight (`hkb list --status running`).

The opening report is step 1’s; every cycle after it is this digest, and it inherits the same economy — a
transition, a verb and a handback are worth a line each, and nothing else is worth one.

## /kanban:specify \<n\> — rewrite a one-liner into a spec

Triage is full of sentences. A worker sees only the issue body, `kb.goal`, `kb.paths` and the results of the tasks it
is blocked by — so a sentence buys you a guess. Specify turns one issue into something a cold worker can execute, then
promotes it. It edits one issue and creates nothing; if the sentence is really several tasks, use `/kanban:decompose`.

1. **Read.** `hkb show <n> --json` — body, `kb` block, blockers, parent results. Then read enough of the repo to be
   concrete: the files the task names, `README.md`, `CLAUDE.md` / `AGENTS.md`, the tests that already cover it.
2. **Draft.** Three headings, plus the machine fields — nothing else:
   - **Why** — what is broken or missing today, in a sentence or two.
   - **What** — the approach, and every decision you are making *for* the worker: which files, which shape, which
     existing helper to reuse, what not to do. A decision you leave out is a decision made again, differently.
   - **Done when** — a checklist a reviewer can tick without asking you, naming the commands that must pass.
   - `paths` — the narrowest scope that contains the work (it is also what the dispatcher's `path_overlap` guard
     uses) · `priority` · `goal` — the acceptance criteria; `hkb context` shows it to the worker under its own heading.
3. **Show it and wait.** Print the body you propose and the `kb` fields you would change, and stop. Do not touch the
   card before a human says yes.
4. **Apply.** `hkb edit <n> --body-file <p>` writes the prose and `hkb edit <n> --paths/--goal/--priority` the machine
   fields; the `<!-- kb: {...} -->` block is hkb's own and you never write it by hand. Then promote.

```bash
# write the new prose with your file tool — just the prose; hkb keeps the kb block for you
hkb edit 12 --body-file /tmp/kb-12-body.md
hkb edit 12 --paths src/limit.js,test/limit.test.js --goal "npm test covers burst and refill" --priority 2
hkb show 12 --json    # verify the body and the kb fields read back the way you meant them
hkb promote 12        # triage → todo; the dispatcher makes it ready once its blockers are closed as completed
```

## /kanban:decompose \<n\> — turn a goal into a dependency graph

Decompose is where one goal becomes a track. It runs **in your session, not in a worker**: you read, you propose the
whole graph, a human approves it, and only then does anything appear on the board. There is no `hkb decompose` — the
dispatcher has no LLM in it on purpose, and a graph is cheap to get wrong and expensive to unpick.

### 1. Read the goal

`hkb show <n> --json`, then the repo: the modules the goal touches, the tests that already cover them, the prior art.
You cannot split what you have not read, and a split made from the title alone always cuts along the wrong seam.

### 2. Propose the graph — before creating anything

One table, one row per child, plus the body you would give each child. Nothing has a number yet, so name the rows and
depend on the names. Then stop and wait for a yes.

| child | title | blocked by | paths | agent | priority |
|---|---|---|---|---|---|
| A | Token bucket + tests | — | `src/limit.js`, `test/limit.test.js` | claude | 2 |
| B | Wire the limiter into the server | A | `src/server.js` | claude | 2 |
| C | Document the limits and the 429 contract | — | `docs/`, `README.md` | claude | 1 |

Each child body is a spec in the `/kanban:specify` shape (Why / What / Done when) plus a **Contract** paragraph: the
names, signatures, paths and flags this child must not invent, because a sibling depends on them.

What makes a graph work:

- **Children cannot see their siblings.** A worker gets its own body, `kb.goal` and the *results* of the tasks it is
  blocked by — nothing else. Every shared decision goes, spelled out, into **every** body that depends on it. Getting
  this right is the whole job; everything else is bookkeeping.
- **Depend on a task only if you need its result.** `blocked by` serializes, so a dependency you add for tidiness costs
  wall-clock and buys nothing.
- **Disjoint `paths` buy parallelism.** The `path_overlap` guard will not run two tasks whose `paths` overlap at the
  same time, and a path is a prefix — `src/` overlaps `src/model.js`. Siblings meant to run at once must own different
  files. A task with **no** `paths` is never guarded and never guards anyone: two path-less siblings will happily edit
  the same file at once. Give every child paths.
- **One child, one PR.** A slice that can be reviewed and merged on its own. If you cannot write its "Done when" as a
  command someone can run, it is not a task yet.
- **Keep it small** — roughly 3 to 7 children. A deeper tree is usually two tracks wearing one coat.
- **Never make a child blocked by the root.** The root is blocked by *them*; a link the other way is a cycle and
  nothing in it will ever be ready.

### 3. Materialize, in this order

```bash
# a. the root's body first — step 4's verify-and-synthesize brief, written the /kanban:specify way
hkb edit 12 --body-file /tmp/kb-root.md

# b. children, parents first so the numbers exist for --blocked-by
hkb create "Token bucket + tests" --priority 2 --paths src/limit.js,test/limit.test.js \
  --goal "npm test covers burst, refill and retryAfterMs" --body "$(cat /tmp/kb-child-a.md)"   # → #41 ready
hkb create "Wire the limiter into the server" --blocked-by 41 --priority 2 --paths src/server.js \
  --goal "the 61st request in a minute gets 429 with Retry-After" --body "$(cat /tmp/kb-child-b.md)"  # → #42 todo
hkb create "Document the limits and the 429 contract" --priority 1 --paths docs/,README.md \
  --goal "README and docs/api.md state the limit, the headers and the 429 body" --body "$(cat /tmp/kb-child-c.md)"  # → #43 ready

# c. the root is blocked by every leaf — every child nothing else depends on
hkb link 42 12 && hkb link 43 12     # link <parent> <child>: #12 is blocked by #42 and #43

# d. only now promote the root: triage → todo, where it waits for the leaves
hkb promote 12

# e. write the graph down where the humans and the next session will find it: your notes, then the picture
hkb graph 12 >> /tmp/kb-graph.md     # the track as a fenced mermaid block — GitHub renders it in the comment
hkb comment 12 "$(cat /tmp/kb-graph.md)"
```

- **Link before you promote, and promote once.** Step (a) is `/kanban:specify` without its `hkb promote` — that is step
  (d), and running it twice matters: `hkb promote` on a task already in *todo* forces it to *ready* with its blockers
  still open. If the root was in *todo* or *ready* rather than *triage*, skip (d) — `link` has already left it in *todo*.
- A child with no blockers is created **ready**, so the next tick claims it. For a big graph, create every child with
  `--triage`, eyeball `hkb list`, then `hkb promote 41 42 43` in one go — that moves them to *todo* and the next tick
  makes the unblocked ones *ready*.
- Cross-board links are refused: every child must be on the root's board.

Then check your work: `hkb graph 12` draws what you just built — the fastest way to see a missing link, a cycle
or a child that ended up blocked by the root — `hkb show 12` lists the blockers, `hkb list` shows which children
are ready, and `hkb dispatch --dry-run` names the ones the next tick would claim.

### 4. What the root becomes

The root stays open as the handle for the track: it carries the graph comment, and when the last leaf closes as
completed it becomes *ready* itself. That attempt is the **verify and synthesize pass**: check that the pieces actually
fit, then write the docs or changelog no child could, and complete.

Its worker gets every *leaf's* result under "Parent task results" (`hkb show <root> --json` lists them under
`parents`) — only its own blockers, so name the children in between and tell it to `hkb show` them. All of that is the
brief step 3a puts in the root's body; without it the root's worker will cheerfully redo a child's work.

The root is also the handle for running the graph as a **track** — one session for the whole subgraph instead of one
cold session per node — and that is now what happens by default: a root with unfinished children is claimed as a track
on the next tick, with no extra step. Nothing to type; `hkb track <root>` says what the dispatcher will do and why.

It is the right default because a track parallelises its independent children too, one subagent each, so "they are
independent" stopped being a reason against it; it keeps a goal's shared design decision in one head; and it is the
only way to run a wave wider than the board's `max_in_progress`, since a track is one slot. Turn it **off** for a goal
whose children have nothing to say to each other, or when you want each task judged on its own attempt history:
`hkb track <root> --off`. A graph that spans harnesses needs no decision at all — a node the runner cannot execute
makes the track un-claimable and the board falls back to node dispatch on its own. Either way the board is identical
— see *When you run a track* above.

A full worked example — the graph above, the resulting board, and the invariants it satisfies — is in
`references/protocol.md`.

## /kanban:groom — turn the board's report into a batch a human says yes to

`hkb groom` reports; it never judges. It can tell you that #140's blockers are all closed, that #117's body has
no *Why* heading, and that #133 and #150 name the same files — it cannot tell you whether #133 and #150 are the
same *work*, which way a missing link points, or whether a thin body is a stub or a one-line chore that needs
nothing. That is why there is no `hkb groom --apply`: the deciding half lives here, in a session, exactly like
`/kanban:specify` and `/kanban:decompose`, and it stops for a yes before it writes anything.

**v1 is the triage lane.** The report covers whatever `--status` you give it, but this procedure grooms cards
that have not started. A *blocked* card is the operator's, not the groomer's — `/kanban:operate` §3 has the
table for it.

### 0. Seat check

You are in the planner's seat. If `KB_TASK` is set you are a **worker**: grooming the board is not your task,
and the cards it would touch are not in your `kb.paths`. Stop and do your card.

Grooming writes nothing until step 5, and step 5 runs only on rows a human said yes to, one row at a time.

### 1. Read the board once

```bash
hkb groom --json --status triage     # the whole report: one read, zero writes
hkb dispatch --dry-run               # what the next tick would claim, so you know what is about to move
```

That is the entire read. **Not** `hkb list --json` (it has no findings, so you would derive them yourself and
get a different answer than the report), and **never** a `hkb show` loop over the lane — a per-card read of a
thirty-card board is thirty requests for something one already answered. `--bodies flagged` is the default and
is the point: only the cards the report wants judged carry their body, so the read is the size of the question,
not the size of the board.

Two fields to read before any row: `blockers_source` — `graphql`, `rest` or `unknown`, and on `unknown` the
graph findings mean nothing — and `summary.path_overlap`, the guard mode the pair wording is written against.
`summary.levels` counts findings across the whole lane, not the rows you can see: under `--level` it will exceed
the row count, by design.

### 2. What each finding kind means, and what a false positive looks like

One row per kind the report can emit. The **false positive** column is the one that matters: a finding is
arithmetic, and arithmetic has no idea why you filed the card.

| kind | prints as | what you do | what a false positive looks like |
|---|---|---|---|
| `unblocked` | `act` — `every blocker is closed as completed (#a, #b)` | propose `promote` | the card is parked in triage on purpose — a note somebody filed, not work anyone queued. Promoting it starts a worker on a sentence |
| `no_paths` | `act` — `kb.paths is empty` | propose `specify`: give it the narrowest scope that holds the work | a card whose output is a decision or a comment, not files. It still wants paths if it will ever be dispatched |
| `malformed_kb` | `act` — the `kb` block is not valid JSON | propose `specify`; the fix is the PATCH recipe in step 5 | a card that *quotes* the `kb` format in its body — the block that counts is the first line of the body, and only that one |
| `cycle` | `act` — `dependency cycle: #a → #b → #a` | propose `link-under` and name the one link to cut | none: the cycle is arithmetic. Which link is wrong is the judgment, and cutting the wrong one just moves the deadlock |
| `two_agents` | `act` — two `kb:agent` labels | propose `specify`: one profile, the first one | a re-adopt caught mid-flight. Re-read the card before you propose anything |
| `blocker_off_board` | `act` — `#a blocks it but is not on this board` | propose `link-under`: adopt the blocker, or cut the link | the blocker lives on another board on purpose. Adopting it moves it, which is somebody else's plan |
| `no_goal` | `act` when the body has no *Done when* heading, `info` when it has one | propose `specify` on the `act` form; ignore the `info` form | the body says when it is finished in prose under some other heading. The level is computed off the heading, not off the meaning |
| `dead_blocker` | `ask` — `#a is closed as not planned / superseded — it can never be ready` | propose `link-under`, and say which link replaces it | the work was really done, by a successor card. Then the link moves to the successor; it does not just disappear |
| `blocker_in_triage` | `ask` — `#a still in triage — this card cannot start` | propose `promote` for the blocker, in step 5's one batch | the blocker is parked deliberately, and the right answer is to leave both parked and say so |
| `priority_inversion` | `ask` — `#a is p0 but this card is p2 — the blocker is dispatched last` | propose `reprioritise` — **handed back**, never run | `p0` is the unfiled default. A blocker nobody has filed is not a blocker somebody ranked low |
| `thin_spec` | `ask` — `no Why/Done when heading (body N chars)` | propose `specify`, or `none` if the one line really is the whole task | a real spec under other headings — the evidence line says so itself — or a chore whose title is its spec |
| `merged_pr_open` | `ask` — `PR #a merged into <base> but the card is still open` | read the base branch, then propose `none` or hand the card to the operator | the PR merged into a stack's base, not the default branch. The card is correctly open until the stack lands |
| `broad_path` | `ask` — `src/ covers N other lane cards — narrow it or the guard means nothing` | propose `specify` with narrower paths | the card really does own the directory — a rename, a lint sweep, a codemod. Narrowing that one makes the guard *wrong* |
| `no_blockers` | `info` — `nothing blocks it` | nothing. It is context for the row | — |
| `unknown_blockers` | `info` — the repo has no GraphQL `blockedBy` and blockers were not filled | re-read with a read that fills blockers before you trust any graph finding | — it is a statement about the read, not about the card |
| `mentions_unlinked` | `needs_judgment` — `names #a, #b but is linked to none of them` | step 3 | most `#n` are citations: prior art, a superseded card, a PR number. A mention is a shortlist, never a verdict |
| `overlap_pair` | `needs_judgment` — `#a ~ #b  0.67  src/gc.js — will serialize under path_overlap` | step 3 | two cards touching different halves of one file, or a shared path that only escaped the hub cut because the board is small |

`hkb groom` never says "duplicate". That word is a verdict, and the verdict is yours.

### 3. Judge only the shortlist

Read `judgment.cards` and `judgment.pairs` — nothing else needs a model, and every other row already carries its
answer. One fixed question per kind, and the answer is one of the actions in step 4:

- **`mentions_unlinked`** — for each `#m` the card names: *is `#m` a blocker of this card, a parent of it, or
  the same work?* Blocker or parent → `link-under`. Same work → `supersede`. **None of the three → `none`**, and
  that is the common answer: say so on the row and move on.
- **`overlap_pair`** — *are these one card, two cards that must run in sequence, or two cards whose paths are
  just too wide?* One card → `supersede`. Sequence → `link-under`. Too wide → `specify` the narrower paths.

The bodies you need are already on the rows (`bodyText`, on flagged cards only). Read them. A pair judged from
two titles is a coin flip with extra steps.

### 4. Propose one table, then stop

One table for the whole pass, grouped by cluster — a track and its children together, a pair on adjacent rows —
so the human reads a plan and not a list. Every row carries its evidence and the exact command it would run.

| card | action | target | evidence | exact command |
|---|---|---|---|---|
| #140 | `promote` | — | every blocker closed as completed (#138, #139) | `hkb promote 140` |
| #133 | `link-under` | #150 | names #150; #150 lands the parser it needs | `hkb link 150 133` |
| #117 | `specify` | — | no *Why* heading, body 3125 chars | the PATCH recipe, step 5 |
| #151 | `supersede` | #133 | same work, judged from both bodies | handed back — pre-staged |
| #148 | `none` | — | mentions #12 as prior art, not a dependency | — |

The action column is a closed vocabulary — the same one `hkb groom` proposes with, so the report and this table
cannot drift apart:

| action | what it means | what the batch runs |
|---|---|---|
| `promote` | the card is ready to be queued | step 5e — the one `hkb promote` |
| `specify` | the body or the `kb` block needs rewriting | step 5d, or hand back `/kanban:specify <n>` |
| `link-under` | a dependency is missing, wrong, or pointing the wrong way | step 5c — `hkb link <parent> <child>` |
| `split` | it is several tasks in one card | handed back — `/kanban:decompose <n>` |
| `supersede` | two cards are the same work; one survives | handed back, pre-staged |
| `reprioritise` | the queue's order is wrong | handed back, pre-staged — the order is the human's |
| `park` | leave it in triage, on purpose, with the reason written down | step 5a — `hkb comment <n>` and nothing else |
| `archive` | it is not work anybody will do | handed back, pre-staged — `hkb archive <n>` |
| `judge` | the report handed the row to you | nothing: step 3 turns it into one of the above |
| `none` | context only, or a false positive you have just ruled out | nothing |

**Then stop for a yes.** Print the table and wait. Not "I will apply the safe ones" — the human approves rows,
one at a time or a whole cluster at once, and an unapproved row is not a row you run. A batch nobody read is
exactly the failure this procedure exists to prevent: a session that promoted thirty cards nobody queued.

Four actions are **never in the batch**, whatever the answer: `supersede`, `archive`, `reprioritise` and cutting
a link (`hkb unlink`). They are handed back as pre-staged command lines the human runs, because closing a card
as a duplicate, archiving one, and editing a `kb` field each need a verb the CLI does not have yet — a `suggests`
string in the report that names one is describing the fix, not handing you a command that exists.

### 5. Apply the approved rows, in this order

Per approved row, in this order, so that the record survives a stop halfway through:

```bash
# a. the judgment goes on the card first — it is the only durable record of why
hkb comment 133 "groom: linked under #150 — #150 lands the parser this needs."

# b. a card the pass revealed, filed unstarted and linked to what revealed it. Never --priority
hkb create "Parser rejects a bare kb block" --triage --blocked-by 150 --body "$(cat /tmp/kb-new.md)"

# c. the links
hkb link 150 133          # link <parent> <child>: #133 is blocked by #150

# d. a body or kb rewrite — the /kanban:specify recipe. The card's kb block is kept for you: write the prose only
hkb edit 117 --body-file /tmp/kb-117-body.md --paths src/limit.js --priority 2
hkb show 117 --json       # verify the body and the kb fields read back the way you meant them

# e. ONE promote, last, of the cards approved for it — all of them in one command
hkb promote 140 141 156 --triage-only
```

Five things about that order:

- **`hkb create --triage`, always.** Without the flag a card with no blockers lands in *ready* and the next tick
  launches a worker on a note you wrote. `--blocked-by <the card that revealed it>` is what makes it a finding
  rather than an orphan. Leave `--priority` off: the queue's order is the human's.
- **Link before you promote.** A card promoted before its link is a card the tick can claim in between.
- **One `hkb promote --triage-only`, at the end, of cards that are in *triage*.** Without `--triage-only`,
  `hkb promote` on a card already in *todo* **forces** it to *ready* with its blockers still open — a card in
  the batch can move on between the moment you decided to promote it and the moment this runs. `--triage-only`
  skips a card that is no longer in *triage* before writing anything and reports it skipped (`not in triage —
  already todo`), instead of leaving you to notice a `forced` line after the fact. A skip there means the
  batch is stale for that card: re-run `hkb groom` rather than promoting it again to "fix" it.
- **Promoted N is a queue, not N running.** Promotion moves cards to *todo*; the tick makes the unblocked ones
  *ready* and claims at most `max_in_progress` of them. Say that in the digest, or "I promoted twelve" reads as
  twelve sessions.
- **Nothing else.** If a row needs a verb that is not one of these four, it was a handback, not a batch row.

### 6. Verify what you did

```bash
hkb groom --status triage      # the findings you acted on are gone, and no new act-level row appeared
hkb graph <root>               # the links you added draw the shape you proposed
hkb dispatch --dry-run         # exactly the cards you promoted, and nothing else, is what the tick would claim
```

`hkb dispatch --dry-run` is the one that catches a bad promote before it costs a session: it runs nothing and
prints what the next tick would claim. If it names a card you did not approve, say so before the tick runs.

### 7. Report, in the operate §5 shape

Three parts, and the third is not optional: **what the report said** (lane size, the level counts,
`blockers_source`), **what you did** — one line per verb and card — and **what you handed back**, each with the
pre-staged command and what you need: a decision, a credential, or an approval. Name the false positives you
ruled out too. A finding you dismissed silently is one the next pass will raise again.

## Rules

- One terminal verb per attempt. No verb = protocol violation = the attempt is retried and eventually parked for a human.
- Summaries are for the *next* worker: what changed, how it was verified, what is still risky.
- Never edit the `<!-- kb-run -->` or `<!-- kb-result -->` comments by hand; `hkb` owns them.
