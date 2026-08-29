---
name: kanban
description: Work a hkb task from the GitHub Issues board — read the task with `hkb show`, work in the worktree, open a PR that closes the issue, and finish with exactly one terminal verb (complete / block / request-review). Use whenever KB_TASK is set, when asked to "work task <n>", "pick up the next kanban task", or to create/link tasks on the board. Also runs a whole track (a root plus everything blocking it) in one session, plans the board — `/kanban:specify <n>` rewrites a one-liner into a spec and promotes it, `/kanban:decompose <n>` proposes a dependency graph for a goal and materializes it once a human approves — and operates it: `/kanban:operate` brings the board up, watches it, and reacts per event kind while the approvals stay with the human.
license: MIT
compatibility: Requires the `gh` CLI (authenticated) and `hkb` (npm hkb-cli) on PATH. Works with Claude Code, GitHub Copilot CLI and Codex CLI.
metadata:
  author: hkb
  version: 0.6.0
allowed-tools: Bash(hkb *) Bash(gh api *) Bash(gh pr *) Bash(gh issue view *) Bash(git *)
---

# kanban — the board protocol

The board is GitHub Issues. A task is an issue with `kb:*` labels; its dependencies are GitHub issue dependencies
(`blocked by`). The dispatcher (`hkb dispatch`) claims a task by creating the git ref `refs/kb/locks/<n>/<attempt>`
and launches you with `KB_TASK`, `KB_ATTEMPT`, `KB_BOARD`, `KB_REPO` set. Everything you need to know about the task
comes from `hkb`; everything you report goes through `hkb`. See `references/protocol.md` for the data model.

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
   reclaimed mid-flight. It is a compare-and-swap on your lock ref —
   `hkb` advances `refs/kb/locks/<n>/<k>` by an empty commit with `git push --force-with-lease`, so it is free and
   writes nothing to the issue. Never push that ref yourself. If the lease is rejected the ref is no longer yours:
   `hkb` prints `LOCK_LOST` and exits **3**. Stop immediately — do not commit, do not push, do not call `complete`.
   The dispatcher reclaimed the task and a new attempt owns it. (Workers that cannot push refs — cloud tiers, with
   `"heartbeat": "comment"` on their profile — heartbeat by writing the run record instead, floored at 10 minutes;
   `hkb` falls back to that by itself when git cannot reach the remote, and says so.)
4. Commit in small, clear steps. Never `git push --force`. Before finishing: `git fetch origin && git rebase origin/<default>`,
   then run the project's lint and tests (see CLAUDE.md / AGENTS.md).
5. Push and open a **draft** PR whose body contains `Closes #$KB_TASK` and a real description:
   `gh pr create --draft --title "..." --body "Closes #$KB_TASK\n\n<what/why/how verified>"`.
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
runs the whole subgraph in **one** session, in dependency order, with the context flowing in memory instead of being
re-derived per node. You get one when the root carries `kb:agent:claude-track` — any profile with `"track": true` in
`.kanban/board.json`.

Nothing about the protocol changes. You run it once per node, in the order your prompt lists:

| per node | |
|---|---|
| 1 | `hkb context <n>` — the exact brief that node's own cold worker would get. Read it before you touch anything |
| 2 | `hkb claim <n>` — creates `refs/kb/locks/<n>/<k>` and moves the node to *running*. `held` means another worker owns it: skip it and everything behind it |
| 3 | work, on a branch of its own cut from the branch of the node it is blocked by (or the default branch when it has none) |
| 4 | push, and open one **draft** PR per node — `--base` that same branch, exactly one `Closes #<n>` in the body |
| 5 | exactly one terminal verb for that node: `hkb finish <n>` / `hkb block <n>` / `hkb request-review <n>` |

Step 5 is what makes a track safe to run at all: every node is a durable checkpoint, so a runner that dies leaves a
board the ordinary dispatcher can finish node by node — and it does. A root whose track attempt has ended is never
handed to a second runner; the durable engine takes the rest.

Four things really are different:

- **Heartbeat the root, not the nodes.** `hkb heartbeat <root>` every ~10 minutes. That one lease covers the whole
  track: the dispatcher will not reclaim a node while the root's attempt is alive. `LOCK_LOST` means stop
  *everything* — do not commit, do not push, do not finish any node.
- **`KB_TASK` is the root, and stays the root.** `hkb claim <n>` prints an `export KB_TASK=…` line for a human
  claiming by hand; ignore it. `hkb` scopes `KB_ATTEMPT` to `KB_TASK`, so each verb you run on a node acts on that
  node's own open attempt without you passing anything.
- **Claim as you go, never up front.** A lock you hold and are not working is a node nobody else can run. Claim a
  node when you are about to start it; end it before you claim the next.
- **One PR per node, never one PR for several nodes.** A body with two `Closes #` drags the unfinished node into
  *review* behind the finished one, and then neither you nor the dispatcher can close it properly.

**A node that blocks parks only its branch.** `hkb block <n> "why" --kind …`, then skip everything blocked by it,
transitively, and carry on with the rest of the graph. Do not abandon a track for one bad node: finish what you can,
and say in the root's summary which branch you left and why.

**Independent branches.** Nodes in the same wave — nothing in the graph between them — may be fanned out to subagents
if your harness has them, one git worktree each, because two agents cannot share a checkout. Sequence is always a
correct answer; the board reads the same either way.

**Finishing.** The root is the last node. Check that the pieces actually fit, run the project's lint and tests over
the whole result, write the docs or changelog no child could — then one terminal verb for the root, whose summary is
the track's: what each node landed, what is open, what you parked.

### Setting a track up

- `/kanban:decompose <n>` builds the graph. Then put the track profile on the **root only**:
  `hkb adopt <root> --agent claude-track --status todo`, and give it room — `max_runtime` for the whole track, not
  for one node.
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
- `hkb promote <n>` (triage → todo, or force ready) · `hkb unblock <n>` · `hkb request-changes <n> "reason"` · `hkb archive <n>`.
- `hkb claim <n>` — take a task by hand, with no dispatcher: it creates the lock ref, moves the card to *running* and
  prints the `export KB_TASK=… KB_ATTEMPT=…` line to work under. The protocol is then exactly the worker's, above.
  A hand-claimed attempt has no process for anyone to watch, so **the heartbeat is the only thing holding it**:
  `hkb heartbeat <n>` every ~10 minutes, or the tick reclaims the task once you have been quiet for `stale_after`
  (1h by default) and your next heartbeat exits `LOCK_LOST`. `--spawn` hands it to the profile's launch command instead.
- `hkb dispatch --dry-run` shows what the next tick would do; `hkb dispatch --loop 60` runs it.
- Planning, not managing: `/kanban:specify <n>` sharpens one triage one-liner into a spec, `/kanban:decompose <n>`
  splits a goal into a dependency graph. Both are below, and both stop for approval before they write anything.
- Running the board rather than reading it: `/kanban:operate` — bring it up, watch it, react per event kind, and
  know what goes back to the human. Also below.
- All three are **real slash commands**, registered by `hkb init` (which writes `.claude/commands/kanban/`) or by
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
foreground form is for a human under a real supervisor: cron, systemd, Actions.) `hkb up` is your verb; a
`hkb dispatch` that runs a tick is nobody's from inside a session — every worker launch denies it outright,
which is the same rule seen from the other side. `hkb dispatch --dry-run` is the exception, and only because it
runs nothing: it prints what the next tick would claim, which is a read.

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
| `appeared` | `+ on the board (triage)` | nothing — unless you are the planner too, and then it is `/kanban:specify` work, not a card to start |
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
| `review` | the row that is really yours. Read the PR against the card's *Done when*, run the repo's own checks, then follow the board's merge policy — `dispatch.merge.mode` in `.kanban/board.json`, which is the only place it is written: `hkb doctor` checks the policy but says nothing about a `"manual"` board, so silence there is not an answer. `"auto"` means the dispatcher already handed the merge to GitHub and its gates hold it; `"manual"` means **the human merges**, which is the entire meaning of the setting — a session that merges anyway has taken an approval nobody gave it. Falls short? `hkb request-changes <n> "<the one specific gap>"` puts it back on the same PR, and the reason you type *is* the next attempt's brief: name the gap, not the disappointment |
| `blocked` | read the block kind off the attempt row (`hkb show <n>`), then the block table below |
| `triage` | planning, not operating |
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

**Yours:** every read — `list`, `show`, `log`, `graph`, `stats`, `watch`, `tail`, `doctor`; `hkb comment`;
`hkb unblock`, when the answer was on the board and you have just written it there; `hkb request-changes`;
`hkb up` after an exit 4; and `hkb create` for a card you can justify from evidence on the board — filed with
`--triage` and linked to the card that revealed it, not started. Say `--triage` and mean it: without the flag a
card with no blockers lands in *ready*, and the next tick launches a worker on a sentence you wrote as a note.
Leave `--priority` off too — it is a number where **higher wins**, and the queue's order is the human's.

**Never yours:** merging on a `manual` board, and any release or publish; editing `.kanban/board.json` at all —
profiles, `allowed_tools`, models, `max_in_progress`, `merge.mode`; re-prioritising, promoting or archiving
someone else's plan; clearing `kb:needs-human` for any reason but an answer you have just written onto the card;
spending on a paid profile the human has not agreed to;
`git push --force`, anywhere; and any `hkb dispatch` that *runs* a tick — `--loop`, `--max`, a bare `dispatch` —
or a second loop of any kind. (`hkb dispatch --dry-run` writes nothing and is a read like any other.)

When you hand something back, hand back the whole thing: the card, what you read, what you would do, and which
of the three you need — a decision, a credential, or an approval. "#142 is blocked" is not a handback.

### 5. Report every cycle

The digest `hkb watch` already prints — one line per transition — is the report. Add two things under it: **what
you did**, one line per verb and card, and **what you handed back**, with what you need from the human. A quiet
cycle says so, and says what is in flight (`hkb list --status running`).

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
   issue before a human says yes.
4. **Apply.** Rewrite the body keeping the `<!-- kb: {...} -->` first line — `hkb` owns it: one line, valid JSON, only
   the fields you named changed. Then promote.

```bash
# write the new body with your file tool (or a quoted heredoc): the kb block, then the prose
gh api repos/{owner}/{repo}/issues/12 -X PATCH \
  -H "X-GitHub-Api-Version: 2026-03-10" -F body=@/tmp/kb-12-body.md
hkb show 12 --json    # verify: kb._malformed means you broke the JSON — a bad block falls back to defaults, silently
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
| C | Document the limits and the 429 contract | — | `docs/`, `README.md` | claude | 3 |

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
gh api repos/{owner}/{repo}/issues/12 -X PATCH -H "X-GitHub-Api-Version: 2026-03-10" -F body=@/tmp/kb-root.md

# b. children, parents first so the numbers exist for --blocked-by
hkb create "Token bucket + tests" --priority 2 --paths src/limit.js,test/limit.test.js \
  --goal "npm test covers burst, refill and retryAfterMs" --body "$(cat /tmp/kb-child-a.md)"   # → #41 ready
hkb create "Wire the limiter into the server" --blocked-by 41 --priority 2 --paths src/server.js \
  --goal "the 61st request in a minute gets 429 with Retry-After" --body "$(cat /tmp/kb-child-b.md)"  # → #42 todo
hkb create "Document the limits and the 429 contract" --priority 3 --paths docs/,README.md \
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
cold session per node. That is a per-goal choice, made after the graph exists: `hkb adopt <root> --agent claude-track
--status todo`. Prefer it when the children are tightly coupled (each one's output is the next one's input) and they
all run on the same harness; leave it off when they are genuinely independent, because node dispatch runs those in
parallel and a track does not. Either way the board is identical — see *When you run a track* above.

A full worked example — the graph above, the resulting board, and the invariants it satisfies — is in
`references/protocol.md`.

## Rules

- One terminal verb per attempt. No verb = protocol violation = the attempt is retried and eventually parked for a human.
- Summaries are for the *next* worker: what changed, how it was verified, what is still risky.
- Never edit the `<!-- kb-run -->` or `<!-- kb-result -->` comments by hand; `hkb` owns them.
