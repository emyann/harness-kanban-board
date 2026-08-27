# hkb — harness kanban board

Turn a GitHub repo's issues into a kanban board that coding agents can work on their own — a portable, frugal
alternative to [Hermes kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban) that needs
no server, no database and no npm dependencies.

## Quickstart

Three commands, in a repo you can push to, with [`gh`](https://cli.github.com) already logged in:

```bash
npx hkb-cli init                 # labels, .kanban/board.json, the worker skill, the Stop + PreToolUse hooks, a CLAUDE.md/AGENTS.md section
npx hkb-cli doctor --api         # verifies gh auth, labels, GraphQL fields, the issue-dependency API and lock-ref CAS
npx hkb-cli dispatch --loop 60   # the 60-second dispatcher, on your machine
```

That is the whole free path. `npx hkb-cli init --import` also pulls your existing open issues onto the board as
*triage*. Prefer it on your PATH? `npm i -g hkb-cli`, then drop the `npx`.

The labels are the only part of `init` that needs the network, so there is a way to do the rest without it:
`npx hkb-cli init --repo owner/name --no-labels` writes every local file — the skill, the two hooks, the board,
the `.gitignore` block, the `CLAUDE.md`/`AGENTS.md` section — and sends nothing at all, for a machine where `gh`
is not logged in yet. Run `init` again without the flag when it is; everything else is idempotent.

Now file some work and watch it get picked up:

```bash
npx hkb-cli create "Design auth schema" --agent claude --priority 2 --paths packages/db/
npx hkb-cli create "Implement auth API" --blocked-by 41    # todo until #41 is done, then ready automatically
npx hkb-cli list                                           # triage todo ready running blocked review done
```

### Or drive it by hand

No loop, no automation: take a card yourself and be the worker.

```bash
npx hkb-cli claim 41             # creates the lock ref, moves the card to running, prints the export line
npx hkb-cli context 41           # the brief — the same prompt the dispatcher would launch a worker with
npx hkb-cli complete 41 --summary "..."     # or block / request-review: exactly one, and the card moves
```

Hand mode and autonomous mode are the same protocol with a different dispatcher — you, or the tick. Every agent
run leaves a summary the next run reads — even when you launch the agent yourself — so a board you drove by hand
for a week is a board `hkb dispatch --loop 60` can take over mid-stream, with nothing to undo. The whole day-one
loop, and what a tick would otherwise have done for you: [Driving a board by hand](docs/manual-mode.md).

[![npm](https://img.shields.io/npm/v/hkb-cli.svg)](https://www.npmjs.com/package/hkb-cli)
[![test](https://github.com/emyann/harness-kanban-board/actions/workflows/test.yml/badge.svg)](https://github.com/emyann/harness-kanban-board/actions/workflows/test.yml)
[![node](https://img.shields.io/node/v/hkb.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/hkb.svg)](LICENSE)

## How it works

- **A card is an issue.** Status, agent and board live in `kb:*` labels; the task's settings live in a
  `<!-- kb: {...} -->` block in the body. Nothing is stored outside the repo.
- **An edge is a dependency.** "Blocked by" is GitHub's own issue-dependency link, so the graph is visible in
  GitHub's UI and a task turns *ready* the moment its last blocker closes.
- **A lock is a git ref.** Claiming task #42 creates `refs/kb/locks/42/1`. Creating a ref that exists fails, so
  the claim is atomic; the heartbeat is a `--force-with-lease` push on the same ref, which costs nothing.
- **A handoff is a comment.** Each attempt ends with a structured result on the card, and the next worker —
  on that card or on one blocked by it — is handed it as part of its brief.

Because all of that is labels, dependencies, refs and comments, any harness — or a shell script — can drive the
same board. Full protocol: [skills/kanban/references/protocol.md](skills/kanban/references/protocol.md).

## Who runs a board: the seats

hkb has exactly three seats. Everything else — reviewer, profile, host, track runner, supervisor — is vocabulary,
not a role.

- **The operator is the human.** You own the repo, the token and the scope: you file and sharpen cards, steer with
  comments, review and merge, answer `kb:needs-human`, and restart a dispatcher that gave itself up. An agent
  session may drive those verbs for you — the approvals and the credentials stay with you.
- **The dispatcher is a tick, not an agent — and not an orchestrator.** `hkb dispatch` promotes what became ready,
  reclaims what died, launches what it can, and exits. It holds no workflow and has no LLM in it: the graph lives
  on the cards as issue dependencies, and the loop only reconciles labels, locks and attempts against it. That
  dumbness is the point — deterministic code, one GraphQL query per board per tick.
- **A worker is any harness.** Claude Code, Copilot CLI and Codex CLI ship as profiles; an Actions job, a shell
  script or you in your own terminal are workers too. A worker reads its brief with `hkb context <n>`, works in a
  worktree, opens a draft PR that says `Closes #42`, and ends with exactly one of `hkb complete` / `hkb block` /
  `hkb request-review`.

Which of them a machine fills is a setting, not a fork of the protocol, so adoption is a ladder rather than a
migration: cards only → the protocol by hand → explicit order → the tick → tracks and a board that runs with the
laptop closed. [Driving a board by hand](docs/manual-mode.md) is a rung, not a fallback.

## What it costs

- The board and the dispatcher cost nothing on any GitHub plan (personal or org, public or private).
- Workers bill only against the harness plan you already have. Paid profiles (Actions, Managed Agents, vendor
  cloud agents) are opt-in per board, never the default.
- The dispatcher is deterministic code, never an LLM. One GraphQL query per board per tick.
- Zero npm dependencies. Everything goes through `gh api`.

## Working the board

```bash
hkb create "Write auth tests" --blocked-by 42
hkb show 42                    # task, blockers, attempts, parent results
hkb list --status ready --json
hkb dispatch --dry-run         # what the next tick would do
```

A worker — spawned by the dispatcher, or you by hand with `hkb claim 42` and `export KB_TASK=42 KB_ATTEMPT=1` —
reads `hkb context 42`, works in a worktree, opens a draft PR that `Closes #42`, and finishes with exactly one of:

```bash
hkb complete 42 --from-stdin <<'EOF'
{"summary": "...", "metadata": {"changed_files": ["src/auth.js"], "verification": ["npm test"]}}
EOF
hkb block 42 "needs the Stripe key" --kind needs_input
hkb request-review 42 --summary "..."
```

Every terminal verb also takes `--summary-file` / `--metadata-file` / `--reason-file`, or the inline
`--summary ".." --metadata '{..}'` flags — no harness has to push JSON through shell quoting.

Humans get `hkb promote`, `hkb unblock`, `hkb request-changes`, `hkb comment`, `hkb link/unlink`, `hkb archive`,
`hkb log`. `hkb --help` lists everything.

### Planning the board: two slash commands

Two things a board needs are not CLI verbs, because they need a model and the dispatcher deliberately has none:

| | |
|---|---|
| `/kanban:specify <n>` | rewrites one triage one-liner into a spec a cold worker can execute — Why / What / Done when, plus `paths`, `priority` and `goal` — and promotes it |
| `/kanban:decompose <n>` | proposes the whole dependency graph for a goal (children, blockers, disjoint `paths`), and materializes it on the board once you say yes |

Both stop and show you what they propose before writing anything. `hkb init` installs them into
`.claude/commands/kanban/`, so they work in Claude Code with nothing else installed; the plugin registers the same
two names. Their bodies delegate to the sections of the same name in
[`skills/kanban/SKILL.md`](skills/kanban/SKILL.md), so a harness without slash commands — Copilot CLI, Codex —
gets the identical procedure by asking the skill for it.

## The last step: who merges

**hkb never merges.** A finished card waits in *review* with an open PR until that PR lands, and by default the
human lands it. On a repo where you merge every agent PR a minute after it opens, that click is a rote step; on a
repo with a careful review culture it is the one gate you would never give up. That is a difference between repos,
so it is board policy — `dispatch.merge` in `.kanban/board.json`:

```jsonc
"dispatch": { "merge": { "mode": "manual" } }                  // the default — nothing changes
"dispatch": { "merge": { "mode": "auto", "method": "squash" } } // squash | merge | rebase
```

On `auto` the dispatcher does not merge either: it enables **GitHub's own auto-merge** on the card's PR, once, when
the card reaches review — one `enablePullRequestAutoMerge` per PR, no new query, no polling. GitHub takes it from
there and enforces its own gates: required checks, required reviews, up-to-date branches. hkb never has to answer
"is this safe to merge", which is not a question it should be in the business of answering, and the failure mode is
the quiet one — a red check or an unanswered review request just means the PR never merges. Nothing to retry,
nothing to reconcile. The **dispatcher** enables it, never the worker: merge authority is an operator concern.

That only holds if something has to go green first. **Auto-merge on an unprotected branch merges immediately** — it
would land agent-authored code the moment the PR opened, unreviewed and untested — so `hkb doctor` treats `auto`
on a base branch that requires no status check and no approving review as a **hard failure** with the fix on it,
and the tick refuses the same combination card by card rather than enabling it. Classic branch protection and
rulesets both count; a branch whose protection the token cannot read counts as no gate, because a gate that cannot
be verified is not one. The gate is checked on the branch each PR actually targets, so a track's **stacked** node
PR — based on the previous node's branch, not on the default one — is left to you unless that branch is protected
too.

One thing worth knowing before you turn it on: auto-merge waits for what the branch *requires*. `hkb request-review
<n> --reviewer alice` **requests** a review, it does not require one — if the branch only requires status checks,
the PR lands when they pass, whether or not Alice looked. Require approving reviews on the branch and the reviewer
becomes the gate that holds the merge; `hkb doctor` prints which of the two you have.

## The board in a browser

```bash
hkb serve                                  # http://127.0.0.1:4666
hkb serve --repos ../api,../infra#release  # several checkouts, one server, one port, one tab
```

`hkb serve` is a zero-dependency http server and one inline page — no build step, no second source of truth.
It reads the live board with the same `fetchBoard` query (one GraphQL call per board per poll, shared by every
tab, ETag so an unchanged board costs nothing), and drag-drop between columns runs the same verbs the CLI does:
only the legal moves, and an illegal one is refused with the reason. Cards show agent, priority, blockers and
the PR; the drawer shows the description, the `kb` block, every attempt, the latest result and the worker's log
tail. There is no auth — it binds `127.0.0.1`, refuses cross-origin calls, and warns loudly if you pass `--host`.

**More than one repo.** A second repository does not cost a second server, a second port and a second tab.
`--repos <path,path>` adds those checkouts to the one you ran in; `#slug` after a path picks a board inside it.
The seven columns stay, boards become chips in a bar under the header — each with its own dispatcher dot and
count, click one to narrow the page to it — and every card carries the repo it belongs to, because `#12` on two
boards is two different tasks. Each board keeps its own everything: its own poll query, its own dispatcher
state, its own worker logs, and its own verbs — a card can only ever act on the repo it came from. One board
that fails to read (expired auth, no network) says so in a strip and keeps its last good cards; the others
carry on. `gh` auth is already global, so one token reads them all.

A set of repos you always want together goes in a user-level list instead of a flag — it spans repos, so it
cannot live in any one `.kanban/`. `hkb serve` with no flag reads `~/.config/hkb/boards.json`
(`$XDG_CONFIG_HOME`/`$KB_CONFIG_HOME` if set) and shows those boards alongside the current one:

```json
{ "version": 1, "boards": ["~/code/web", "~/code/api", { "path": "~/code/infra", "board": "release" }] }
```

An entry that no longer exists is a warning and a skip, never a broken `hkb serve`. Nothing is scanned for:
hkb only ever shows the checkouts you named.

## The board as a stream

```bash
hkb watch                                   # one line per board transition, until Ctrl-C
hkb watch --kinds completed,blocked --json  # only those, as JSONL, for a script to consume
hkb tail 42                                 # follow one task's status, attempts and comments
```

Each poll is a conditional `GET`: hkb sends back the `ETag` of the last representation as `If-None-Match`, and
GitHub answers `304 Not Modified` with an empty body — which costs nothing against the rate limit, so watching a
quiet board all day is free. Only a `200` is diffed against the previous snapshot, and only a difference prints.
`--kinds` takes event kinds (`status`, `attempt`, `outcome`, `result`, `comment`, …) or the status/outcome an
event landed on, so `--kinds completed` reads the way you'd guess. `GHK_DEBUG=1` shows every poll with its status
and the rate-limit counter:

```
hkb watch: board: GET repos/o/r/issues?labels=kb%3Aboard%3Adefault&... → 304 Not Modified · rate 219 (+0) · etag 594b2e9a588b
```

## What it ran, and what it spent

```bash
hkb stats                       # the last 7 days: what ran, how it ended, what it cost
hkb stats --since 24h --json    # the same object, for a script or a dashboard
hkb stats --since all           # every attempt the board has ever recorded
```

`hkb stats` is the board's own ledger, so a paid profile is never a surprise:

```
board "default" · acme/board · window 7d (since 2026-08-19T23:20:45Z)

tasks      21 (5 open) · 12 with news in the window
           ready 3 · running 2 · done 16
attempts   35 over 20 tasks · 33 ended · 2 active
           completed 13 · crashed 2 · timed_out 3 · spawn_failed 2 · protocol_violation 10 · gave_up 3
           delivered 13 (39%) · blocked 0 · failed 20
duration   mean 1h18m · median 10m11s · p90 1h20m · max 15h07m  (29 ended)
spawns     30 / 40 today · 10 left
spend      $9.02 · recorded on 3 of 29 worker attempts
           claude          $9.02 · 3 attempts · mean $3.01 · max $5.14 · 120 turns
           26 worker attempts recorded no cost — the real total is higher

read 1 board query + 21 run records; nothing was written.
```

It invents no new state: statuses come from the labels, attempts and outcomes from the `<!-- kb-run -->`
comments, today's spawn count from the dispatcher's `.kanban/state.json`, and spend from the `total_cost_usd`
an attempt row carries — what `claude -p --output-format json` signs off with. A row without one falls back to
the worker's own log on disk, which is free; harnesses whose log has no final JSON simply report no cost, and
the report says how many of them there were rather than quietly understating the total. `--since` takes a span
(`90m`, `36h`, `7d`, `2w`), a date, or `all`. The read is one board query plus the run comment of each task the
window actually touched — a comment write bumps the issue's `updatedAt`, so "updated since" is "has news" —
plus every `running` task, whose ref-CAS heartbeat leaves no trace on the issue.

## Harnesses

`.kanban/board.json` declares profiles: a launch template plus caps. The built-in `claude` profile starts each
worker as a Claude Code **background agent** — `claude --bg --name "kb #<n> · <title>" --worktree kb-<n>-<k>
--permission-mode acceptEdits --allowedTools ... --max-budget-usd 5 "<prompt>"` — so workers show up in
`claude agents` (and the agents view of any session in the repo), can be opened with `claude attach <job>`, and are
stopped by the dispatcher once their attempt has ended. `hkb show <n>` prints the job id per attempt.
`claude-p` is the headless variant (`claude -p`, exits when done) for CI and containers without the session daemon.

A board carries **only the profiles you asked for**: a bare `hkb init` writes `claude` and its one `kb:agent:claude`
label, and nothing else. `--profiles a,b` (or `--harness copilot|codex`, which brings its own) is the whole list —
so a Claude-only repo never grows labels for harnesses it will not install, and `hkb doctor` has nothing to warn
about. Re-running init only *adds*: `hkb init --profiles claude-track` puts that profile on an existing board and
leaves everything already there — including profiles you wrote by hand — untouched.

`claude-track` is the same launcher pointed at a whole **track** — a root task plus everything still blocking it,
usually what `/kanban:decompose` just materialized. One session executes the subgraph in dependency order instead of
one cold session per node, so a dependent pair costs no tick of latency and no re-derived context; the board is
unchanged, because the track runner still claims each node, works it, and finishes it with its own terminal verb. Every
node stays a durable checkpoint, so a track runner that dies leaves a board the ordinary dispatcher finishes node by node —
and a root that has had one track attempt is never handed to a second track runner. Put it on the **root only**
(`hkb adopt <root> --agent claude-track --status todo`) and give it a `max_runtime` for the whole track. A track
costs one `max_in_progress` slot however many nodes it holds; per-node `kb.paths` still guard against everything else
running. Cross-harness tracks are out of scope: a node on a profile outside the track runner's `track_agents` simply makes
the track un-claimable and the board falls back to node dispatch. See
[Tracks](skills/kanban/references/protocol.md#tracks--the-second-execution-engine).

`copilot-cli` is the same deal for **GitHub Copilot CLI**, which is included in Copilot Free:

```bash
hkb init --harness copilot     # adds the profile and generates the two files Copilot needs
hkb doctor                     # checks `copilot` is on PATH and the generated files are there
```

`--harness copilot` writes `.github/agents/kanban-worker.agent.md` (the custom agent the profile selects with
`copilot --agent kanban-worker`; its body is spliced out of `skills/kanban/SKILL.md`, so the protocol text lives in
one place) and `.github/hooks/kanban.json` (an `agentStop` hook running `hkb hook stop` — the same two-nudge
enforcement Claude Code gets from its `Stop` hook). Both are generated: re-running init overwrites them.
Copilot CLI has no worktree flag, so the profile carries `workspace: "worktree"` and the dispatcher runs
`git worktree add .claude/worktrees/kb-<n>-<k> -b kb-<n>-<k>` itself before launching the worker there.
Compared with the Claude profiles you lose structured JSON output — everything hkb records about an attempt comes
from the `hkb` commands the worker runs — and `max_in_progress` defaults to 1, because Copilot Free's credit pool
is small.

`codex` is the third local harness, **OpenAI Codex CLI**:

```bash
hkb init --harness codex       # adds the profile, .codex/hooks.json and the setup notes
hkb doctor                     # codex on PATH · the generated files · the schema the launch names
```

Each attempt runs `codex exec -C <worktree> --sandbox workspace-write --output-schema
.agents/skills/kanban/schema/terminal.json "<prompt>"` in a worktree the dispatcher created, so the sandbox — not
an allowlist — is the permission policy, and the final message mirrors the terminal verb into
[`terminal.json`](skills/kanban/schema/terminal.json). Codex will not run project hooks until you trust the
project once (`/hooks`, or `trust_level = "trusted"`), and its `workspace-write` sandbox needs network access
before a worker can push: both steps are written into `.codex/README.md` with your paths filled in.

Any other harness plugs in the same way — a `launch` array in `.kanban/board.json`; the protocol does not change.
Details, flags and troubleshooting for all of them: [docs/harnesses.md](docs/harnesses.md).

## Runs when the laptop is closed

The dispatcher is one command, so it also runs in GitHub Actions. `hkb init --with-actions` generates the two
workflows that do it — nothing else about the board changes:

```bash
hkb init --with-actions        # .github/workflows/kanban-dispatch.yml + kanban-worker-claude.yml
gh secret set KB_TOKEN         # fine-grained PAT, this repo: Issues, Contents, Pull requests, Actions RW
claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN     # or: gh secret set ANTHROPIC_API_KEY
git add .github/workflows && git commit -m "kanban: dispatch from Actions" && git push
```

That last line is not a formality: Actions only ever runs the copy of a workflow that is on the **default
branch**. No secret is ever written into a template — both files reference `${{ secrets.* }}` and nothing else,
and until `KB_TOKEN` exists the dispatcher prints a `::notice::` saying so and dispatches nothing.

**`kanban-dispatch.yml`** is `hkb dispatch --max 1`, triggered by what actually changes the board —
`issues: [closed, reopened, labeled, unlabeled]`, `pull_request: [closed]`, `pull_request_review`,
`workflow_run` (a worker finishing), `workflow_dispatch` — with `schedule: */15` as a **sweeper only**, for the
things no event announces: a worker that died, a `scheduled_at` that came due. `concurrency: kb-dispatch-<board>`
with `cancel-in-progress: false` keeps it to one tick at a time, because a cancelled tick can leave a claimed
lock ref with no worker behind it. It passes `--profiles claude-action`, so an Actions runner claims only the profile
it can actually launch and leaves your laptop's `claude` tasks alone; reclaim, promote and reconcile still cover the
whole board on every tick.

**`kanban-worker-claude.yml`** is one attempt on one task. The `claude-action` profile's launch does not start a
worker locally — it is `gh workflow run kanban-worker-claude.yml -f task=<n> -f attempt=<k>` and exits, so the
attempt is recorded as `remote`: no pid, no background job, and its heartbeat (the same CAS on
`refs/kb/locks/<n>/<k>`) plus `max_runtime` are the whole liveness check. On the Actions runner, a step turns
`hkb context <n>` into the prompt for [`anthropics/claude-code-action@v1`](https://github.com/anthropics/claude-code-action)
— the same brief a local worker is launched with, the same allowlist, the same `Closes #<n>` draft PR, the same
terminal verb. There is no `Stop` hook on an Actions runner, so a final `if: always()` step ends an attempt that finished
without one (`hkb block … --kind transient`) instead of leaving it `running` until the stale reclaim.

**The honest latency.** The 60-second cadence exists only while your laptop loop runs. Actions' cron floor
is 5 minutes, top-of-hour schedules are routinely 15-20+ minutes late, and scheduled workflows are dropped
entirely on a public repo with no activity for 60 days — which is exactly why the cron here is a sweeper and the
events are the real trigger. **Laptop-off latency is 15-75 minutes**, end to end. If you want 60 seconds, run
`hkb dispatch --loop 60` on a machine that stays on; the two dispatchers are safe to run together, because the
lock ref is the arbiter.

What you give up, plainly: Actions minutes (free on public repos; a platform fee per minute on private ones —
the board itself stays free), no enforced `Stop` nudge, a per-task `model` override that is not plumbed through
workflow inputs yet, and a worker whose run is cancelled or killed is only noticed at `stale_after`, not at
`workflow_run`. Details and the whole table: [docs/harnesses.md](docs/harnesses.md#github-actions--claude-action).

## MCP (optional — the CLI is the protocol)

Harnesses that prefer tools to a shell get the same verbs over MCP:

```bash
hkb init --mcp   # writes .mcp.json, prints the Codex and VS Code equivalents
hkb mcp          # the server itself: JSON-RPC 2.0 on stdio, no dependency
```

`.mcp.json` is read verbatim by Claude Code and Copilot CLI:

```json
{"mcpServers": {"kanban": {"type": "stdio", "command": "hkb", "args": ["mcp"]}}}
```

Codex reads MCP servers from `~/.codex/config.toml` and VS Code from `.vscode/mcp.json` — neither is hkb's file
to write, so `--mcp` prints those two snippets instead of generating them.

The nine tools are the nine verbs — `kanban_show`, `kanban_heartbeat`, `kanban_complete`, `kanban_block`,
`kanban_request_review`, `kanban_comment`, `kanban_create`, `kanban_link`, `kanban_unblock` — and each one calls
the function the CLI calls and returns the object its `--json` prints. There is no second code path: a
`tools/call` of `kanban_show` is byte-for-byte `hkb show <n> --json`. `task` defaults to `$KB_TASK`, so a worker
just calls `kanban_show`. Nothing about the board requires MCP; it is a second doorway to one protocol.

## GitHub Projects mirror (opt-in, off by default)

If you live in GitHub's own Projects UI, link a Projects v2 board and the dispatcher will mirror the board onto it:

```bash
gh auth refresh -s project      # Projects v2 needs its own scope
hkb init --project new          # or: --project 7 / --project https://github.com/users/me/projects/7
```

`init` links (or creates) the project, makes sure its single-select **Status** field has an option per kb status —
appending only, so columns you already made are kept, and `Todo` / `In Progress` / `Done` are reused as
`todo` / `running` / `done` — and stores the ids in `.kanban/board.json` under `"project"`. Delete that key to turn the
mirror off; `hkb doctor` reports the scope and whether the project is still there.

**Strictly one-way.** Labels are canonical and the Project is a read surface: dragging a card changes nothing on the
board, and the next tick puts it back where the label says. Only the dispatcher writes, so a transition a worker makes
(`hkb complete` → *review*) appears on the next tick, not instantly.

**What it costs**, on top of the free path, and only while it is on: one GraphQL read of the project's items per tick,
one mutation per status transition, and two the first time an issue is added to the project (`hkb dispatch --dry-run`
prints the moves it would make). Deleting the Project, or losing the scope, costs the mirror and nothing else — the
tick logs the fix once an hour and carries on.

## How it maps to GitHub

| Hermes | hkb |
|---|---|
| SQLite row | Issue with `kb:status:*`, `kb:agent:*`, `kb:board:*` labels and a `<!-- kb: {...} -->` body block |
| parent → child | child **blocked by** parent (native issue dependencies) |
| `todo → ready` when all parents done | dispatcher tick, from `blockedBy { state stateReason }` |
| atomic claim | `POST git/refs refs/kb/locks/<n>/<attempt>` — 201 claimed; 422 "Reference already exists" (observed) or 409 held; anything else back off |
| heartbeat | CAS on the same ref: `git push <empty commit>:<ref> --force-with-lease=<ref>:<expected>` — free, and a rejected lease is `LOCK_LOST` (exit 3). Profiles that cannot push refs use `"heartbeat": "comment"` |
| runs table | one `<!-- kb-run -->` comment (attempts, failures, block loops) |
| `kanban_complete(summary, metadata)` | `<!-- kb-result -->` comment; open PR → *review*, else issue closed |
| worker tools | `hkb show/heartbeat/complete/block/request-review/comment/create/link`, or the same nine as MCP tools (`hkb mcp`) |
| stop nudge | Claude Code / Codex `Stop`, Copilot CLI `agentStop` hook (`hkb hook stop`, 2 nudges, inert unless `KB_TASK` is set). Claude Code's pair goes in `.claude/settings.local.json` — per-developer and gitignored, because the command names whichever `hkb` *this* machine has; `hkb init --shared-hooks` puts them in the tracked `.claude/settings.json` instead, where the command is always a plain `hkb` every teammate needs on PATH (`hkb doctor` says so when it is not there) |
| worker permissions | Claude Code `PreToolUse` hook (`hkb hook pretool`, also inert unless `KB_TASK` is set) — file tools confined to the worktree, `hkb dispatch`/`kill`/force-push/`sudo`/`rm -rf <abs>` denied outright, everything else checked against the profile's allowlist: allow or deny, never a prompt. `hkb init` writes it beside the Stop hook |
| kanban dashboard | `hkb serve` — local page over the live board; drag-drop calls the same verbs |
| live event stream | `hkb watch` / `hkb tail <n>` — conditional `GET` with `If-None-Match`; an unchanged board answers 304 and is not charged |
| runs/spend report | `hkb stats` — the same labels and run comments, rolled up: outcomes, duration, spawns vs the daily cap, `total_cost_usd` per profile |
| crash / stale / timeout | pid check on the claiming host, `stale_after` (against the lock ref's commit date, then the run comment), `max_runtime` → `ready` or `gave_up` |

## Local state (gitignored)

`.kanban/logs/` worker logs · `.kanban/state.json` spawn counters and auth pauses · `.kanban/outbox.jsonl` writes queued while GitHub was unreachable (replayed on the next tick) · `.kanban/cache.json` GraphQL capability cache · `.kanban/dispatch.pid` the loop's singleton lock · `.kanban/nudges/` and `.kanban/sessions/` stop-hook bookkeeping · `.claude/settings.local.json` the two hooks, whose command names this machine's `hkb`.

`hkb init` adds all of them to `.gitignore`, one line at a time — your own entries are left alone. `.kanban/board.json` is the exception: it is the board's configuration and belongs in the repo.

## Docs

- [The protocol](skills/kanban/references/protocol.md) — statuses, claims, attempts, handoff; what a worker must do.
- [Driving a board by hand](docs/manual-mode.md) — the day-one loop with no dispatcher: claim, context, one
  terminal verb, the heartbeat contract, and moving an existing roadmap onto the board.
- [Harnesses](docs/harnesses.md) — per-harness setup, profiles, generated files, Codex's one-time trust, Actions.
- [Releasing](docs/releasing.md) — how a version gets to npm: one tag, provenance, and a clean-room `npx` check.
- [Project status and verified behaviour](docs/status.md) — how far along this is, and the GitHub API facts the
  design leans on, each with the probe that confirmed it.
- [Design rationale](docs/EVALUATION.md) — judged alternatives and the roadmap.

Requires Node >= 20 and the [GitHub CLI](https://cli.github.com), authenticated. MIT licensed.
