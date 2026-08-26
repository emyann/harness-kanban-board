# hkb — harness kanban board

A portable, frugal alternative to [Hermes kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban) for coding agents.
**GitHub Issues are the board**, issue dependencies are the graph, git refs are the locks, and any harness —
Claude Code, GitHub Copilot CLI, Codex CLI — works the same tasks through one small CLI.

- The board and the dispatcher cost nothing on any GitHub plan (personal or org, public or private).
- Workers bill only against the harness plan you already have. Paid profiles (Actions, Managed Agents, vendor cloud agents) are opt-in per board, never the default.
- The dispatcher is deterministic code, never an LLM. One GraphQL query per board per tick.
- Zero npm dependencies. Everything goes through `gh api`.

Design rationale, judged alternatives and the roadmap: [docs/EVALUATION.md](docs/EVALUATION.md).

## Install (free path, ~2 commands)

```bash
npm i -g hkb            # or: npx hkb ...
cd your-repo
hkb init                     # labels, .kanban/board.json, skill, Stop hook, CLAUDE.md/AGENTS.md section
hkb doctor --api             # verifies gh auth, labels, GraphQL fields, issue-dependency API, lock-ref CAS
hkb dispatch --loop 60       # the Hermes 60-second dispatcher, on your machine
```

`hkb init --import` also puts your existing open issues into *triage* on the board.

## Use

```bash
hkb create "Design auth schema" --agent claude --priority 2 --paths packages/db/
hkb create "Implement auth API" --blocked-by 41            # todo until #41 is done, then ready automatically
hkb create "Write auth tests"   --blocked-by 42
hkb list                       # columns: triage todo ready running blocked review done
hkb show 42                    # task, blockers, attempts, parent results
hkb dispatch --dry-run         # what the next tick would do
```

A worker (spawned by the dispatcher, or you with `hkb claim 42` + `export KB_TASK=42 KB_ATTEMPT=1`) reads
`hkb show`, works in a worktree, opens a draft PR that `Closes #42`, and finishes with exactly one of:

```bash
hkb complete 42 --from-stdin <<'EOF'
{"summary": "...", "metadata": {"changed_files": ["src/auth.js"], "verification": ["npm test"]}}
EOF
hkb block 42 "needs the Stripe key" --kind needs_input
hkb request-review 42 --summary "..."
```

Every terminal verb also takes `--summary-file` / `--metadata-file` / `--reason-file`, or the inline
`--summary ".." --metadata '{..}'` flags — no harness has to push JSON through shell quoting.

Humans: `hkb promote`, `hkb unblock`, `hkb request-changes`, `hkb comment`, `hkb link/unlink`, `hkb archive`, `hkb log`.

```bash
hkb serve                      # the same board in a browser, on http://127.0.0.1:4666
```

`hkb serve` is a zero-dependency http server and one inline page — no build step, no second source of truth.
It reads the live board with the same `fetchBoard` query (one GraphQL call per poll, shared by every tab, ETag
so an unchanged board costs nothing), and drag-drop between columns runs the same verbs the CLI does: only the
legal moves, and an illegal one is refused with the reason. Cards show agent, priority, blockers and the PR;
the drawer shows the description, the `kb` block, every attempt, the latest result and the worker's log tail.
There is no auth — it binds `127.0.0.1`, refuses cross-origin calls, and warns loudly if you pass `--host`.

```bash
hkb watch                                  # one line per board transition, until Ctrl-C
hkb watch --kinds completed,blocked --json  # only those, as JSONL, for a script to consume
hkb tail 42                                # follow one task's status, attempts and comments
```

`hkb watch` and `hkb tail` are the board as a stream. Each poll is a conditional `GET`: hkb sends back the
`ETag` of the last representation as `If-None-Match`, and GitHub answers `304 Not Modified` with an empty body
— which costs nothing against the rate limit, so watching a quiet board all day is free. Only a `200` is
diffed against the previous snapshot, and only a difference prints. `--kinds` takes event kinds (`status`,
`attempt`, `outcome`, `result`, `comment`, …) or the status/outcome an event landed on, so `--kinds completed`
reads the way you'd guess. `GHK_DEBUG=1` shows every poll with its status and the rate-limit counter:

```
hkb watch: board: GET repos/o/r/issues?labels=kb%3Aboard%3Adefault&... → 304 Not Modified · rate 219 (+0) · etag 594b2e9a588b
```

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
| stop nudge | Claude Code / Codex `Stop`, Copilot CLI `agentStop` hook (`hkb hook stop`, 2 nudges, inert unless `KB_TASK` is set) |
| kanban dashboard | `hkb serve` — local page over the live board; drag-drop calls the same verbs |
| live event stream | `hkb watch` / `hkb tail <n>` — conditional `GET` with `If-None-Match`; an unchanged board answers 304 and is not charged |
| crash / stale / timeout | pid check on the claiming host, `stale_after` (against the lock ref's commit date, then the run comment), `max_runtime` → `ready` or `gave_up` |

Full protocol: [skills/kanban/references/protocol.md](skills/kanban/references/protocol.md).

## Profiles

`.kanban/board.json` declares profiles: a launch template plus caps. The built-in `claude` profile starts each
worker as a Claude Code **background agent** — `claude --bg --name "kb #<n> · <title>" --worktree kb-<n>-<k>
--permission-mode acceptEdits --allowedTools ... --max-budget-usd 5 "<prompt>"` — so workers show up in
`claude agents` (and the agents view of any session in the repo), can be opened with `claude attach <job>`, and are
stopped by the dispatcher once their attempt has ended. `hkb show <n>` prints the job id per attempt.
`claude-p` is the headless variant (`claude -p`, exits when done) for CI and containers without the session daemon.

`claude-track` is the same launcher pointed at a whole **track** — a root task plus everything still blocking it,
usually what `/kanban:decompose` just materialized. One session executes the subgraph in dependency order instead of
one cold session per node, so a dependent pair costs no tick of latency and no re-derived context; the board is
unchanged, because the runner still claims each node, works it, and finishes it with its own terminal verb. Every
node stays a durable checkpoint, so a runner that dies leaves a board the ordinary dispatcher finishes node by node —
and a root that has had one track attempt is never handed to a second runner. Put it on the **root only**
(`hkb adopt <root> --agent claude-track --status todo`) and give it a `max_runtime` for the whole track. A track
costs one `max_in_progress` slot however many nodes it holds; per-node `kb.paths` still guard against everything else
running. Cross-harness tracks are out of scope: a node on a profile outside the runner's `track_agents` simply makes
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

## Local state (gitignored)

`.kanban/logs/` worker logs · `.kanban/state.json` spawn counters and auth pauses · `.kanban/outbox.jsonl` writes queued while GitHub was unreachable (replayed on the next tick) · `.kanban/cache.json` GraphQL capability cache.

## Status

MVP. Verified so far: unit tests for the model, lock classification and arg parsing; CLI wiring; and `hkb doctor --api`
against this repository (2026-08-26), which probes the things the design depends on:

- duplicate ref create returns **422 "Reference already exists"** (not 409) — `src/lock.js` treats both as `held`;
- GraphQL `Issue.blockedBy`, `blocking`, `subIssues` and `closedByPullRequestsReferences` all exist;
- REST `GET /issues/{n}/dependencies/blocked_by` works with `X-GitHub-Api-Version: 2026-03-10`;
- `--force-with-lease` on a lock ref rejects both a moved ref and a deleted one with `(stale info)`, and
  `GET git/commits/<sha>` gives the dispatcher the beat's committer date (round trip on this repo, 2026-08-26).

Run `hkb doctor --api` on your own repo before the first dispatch; it re-checks all of the above.
