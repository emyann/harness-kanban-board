---
name: kanban
description: Work a hkb task from the GitHub Issues board — read the task with `hkb show`, work in the worktree, open a PR that closes the issue, and finish with exactly one terminal verb (complete / block / request-review). Use whenever KB_TASK is set, when asked to "work task <n>", "pick up the next kanban task", or to create/link tasks on the board. Also runs a whole track (a root plus everything blocking it) in one session, and plans the board — `/kanban:specify <n>` rewrites a one-liner into a spec and promotes it, `/kanban:decompose <n>` proposes a dependency graph for a goal and materializes it once a human approves.
license: MIT
compatibility: Requires the `gh` CLI (authenticated) and `hkb` (npm hkb-cli) on PATH. Works with Claude Code, GitHub Copilot CLI and Codex CLI.
metadata:
  author: hkb
  version: 0.5.4
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
  Those two are **real slash commands**, registered by `hkb init` (which writes `.claude/commands/kanban/`) or by
  the `kanban` plugin; their bodies do nothing but send you to the section of this file with the same name. In a
  harness with no slash commands — Copilot CLI, Codex — ask for the section by name instead; the procedure is
  identical, and `hkb` is the only thing either one calls.

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
