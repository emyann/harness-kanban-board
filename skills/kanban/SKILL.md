---
name: kanban
description: Work a hkb task from the GitHub Issues board — read the task with `hkb show`, work in the worktree, open a PR that closes the issue, and finish with exactly one terminal verb (complete / block / request-review). Use whenever KB_TASK is set, when asked to "work task <n>", "pick up the next kanban task", or to create/link tasks on the board. Also plans the board — `/kanban:specify <n>` rewrites a one-liner into a spec and promotes it, `/kanban:decompose <n>` proposes a dependency graph for a goal and materializes it once a human approves.
license: MIT
compatibility: Requires the `gh` CLI (authenticated) and `hkb` (npm hkb) on PATH. Works with Claude Code, GitHub Copilot CLI and Codex CLI.
metadata:
  author: hkb
  version: 0.3.0
allowed-tools: Bash(hkb *) Bash(gh api *) Bash(gh pr *) Bash(gh issue view *) Bash(git *)
---

# kanban — the worker protocol

The board is GitHub Issues. A task is an issue with `kb:*` labels; its dependencies are GitHub issue dependencies
(`blocked by`). The dispatcher (`hkb dispatch`) claims a task by creating the git ref `refs/kb/locks/<n>/<attempt>`
and launches you with `KB_TASK`, `KB_ATTEMPT`, `KB_BOARD`, `KB_REPO` set. Everything you need to know about the task
comes from `hkb`; everything you report goes through `hkb`. See `references/protocol.md` for the data model.

## When you are the worker (KB_TASK is set)

1. `hkb show $KB_TASK --json` — title, body, `kb` settings, blockers, prior attempts, **parent task results**.
   Read the parent results before designing anything: they say what changed and what was not tested.
2. Stay in this worktree and on the current branch. Only touch the scope in `kb.paths` if it is set.
3. Long work: run `hkb heartbeat $KB_TASK` roughly every 10 minutes. It is a compare-and-swap on your lock ref —
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
   has to survive your shell's quoting (recommended — a heredoc with no nested quotes):

   ```bash
   hkb complete $KB_TASK --from-stdin <<'EOF'
   {
     "summary": "What changed, written for the next worker. How it was verified. What is still risky.",
     "metadata": {
       "changed_files": ["src/a.js", "test/a.test.js"],
       "verification": ["npm run lint", "npm test"],
       "dependencies": [],
       "residual_risk": ["..."],
       "retry_notes": null
     },
     "artifacts": []
   }
   EOF
   ```

   If your harness has a file-write tool, write the pieces to files and point at them — no quoting at all:
   `hkb complete $KB_TASK --summary-file /tmp/kb-summary.md --metadata-file /tmp/kb-metadata.json`
   (`--metadata <path>` also reads a file when the value does not start with `{`). The inline
   `--summary ".." --metadata '{..}'` flags still work; per field, inline beats file beats stdin.
   - `hkb complete $KB_TASK ...` — done (or *review* while a PR is open). Stdin keys: `summary`, `metadata`, `artifacts`.
   - `hkb block $KB_TASK "<why>" --kind needs_input|dependency|capability|transient` — when you cannot proceed.
     `dependency` sends it back to *todo*; the others ask a human. Also `--reason-file <path>`, or stdin keys `reason`, `kind`.
   - `hkb request-review $KB_TASK --summary "..." [--reviewer <profile>]` — when a reviewer must look before it counts
     as done. Stdin keys: `summary`, `metadata`, `reviewer`.

Do not do work that belongs to other tasks. If you discover follow-up work, create it instead:
`hkb create "title" --body "..." --blocked-by $KB_TASK` (it starts in *todo* and becomes *ready* when this task is done).

## When a human asks you to manage the board

- `hkb list` / `hkb show <n>` / `hkb log <n>` — read.
- `hkb create "title" [--blocked-by 12,13] [--agent claude] [--priority N] [--paths apps/web/]` — add work.
  Decide before you fan out: put design decisions in the body; children cannot see their siblings.
- `hkb link <parent> <child>` / `hkb unlink` — dependencies (same board only).
- `hkb promote <n>` (triage → todo, or force ready) · `hkb unblock <n>` · `hkb request-changes <n> "reason"` · `hkb archive <n>`.
- `hkb dispatch --dry-run` shows what the next tick would do; `hkb dispatch --loop 60` runs it.
- Planning, not managing: `/kanban:specify <n>` sharpens one triage one-liner into a spec, `/kanban:decompose <n>`
  splits a goal into a dependency graph. Both are below, and both stop for approval before they write anything.

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

# e. write the graph down where the humans and the next session will find it
hkb comment 12 "$(cat /tmp/kb-graph.md)"
```

- **Link before you promote, and promote once.** Step (a) is `/kanban:specify` without its `hkb promote` — that is step
  (d), and running it twice matters: `hkb promote` on a task already in *todo* forces it to *ready* with its blockers
  still open. If the root was in *todo* or *ready* rather than *triage*, skip (d) — `link` has already left it in *todo*.
- A child with no blockers is created **ready**, so the next tick claims it. For a big graph, create every child with
  `--triage`, eyeball `hkb list`, then `hkb promote 41 42 43` in one go — that moves them to *todo* and the next tick
  makes the unblocked ones *ready*.
- Cross-board links are refused: every child must be on the root's board.

Then check your work: `hkb show 12` lists the blockers, `hkb list` shows which children are ready, and
`hkb dispatch --dry-run` names the ones the next tick would claim.

### 4. What the root becomes

The root stays open as the handle for the track: it carries the graph comment, and when the last leaf closes as
completed it becomes *ready* itself. That attempt is the **verify and synthesize pass**: check that the pieces actually
fit, then write the docs or changelog no child could, and complete.

Its worker gets every *leaf's* result under "Parent task results" (`hkb show <root> --json` lists them under
`parents`) — only its own blockers, so name the children in between and tell it to `hkb show` them. All of that is the
brief step 3a puts in the root's body; without it the root's worker will cheerfully redo a child's work.

A full worked example — the graph above, the resulting board, and the invariants it satisfies — is in
`references/protocol.md`.

## Rules

- One terminal verb per attempt. No verb = protocol violation = the attempt is retried and eventually parked for a human.
- Summaries are for the *next* worker: what changed, how it was verified, what is still risky.
- Never edit the `<!-- kb-run -->` or `<!-- kb-result -->` comments by hand; `hkb` owns them.
