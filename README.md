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

## How it maps to GitHub

| Hermes | hkb |
|---|---|
| SQLite row | Issue with `kb:status:*`, `kb:agent:*`, `kb:board:*` labels and a `<!-- kb: {...} -->` body block |
| parent → child | child **blocked by** parent (native issue dependencies) |
| `todo → ready` when all parents done | dispatcher tick, from `blockedBy { state stateReason }` |
| atomic claim | `POST git/refs refs/kb/locks/<n>/<attempt>` — 201 claimed; 422 "Reference already exists" (observed) or 409 held; anything else back off |
| runs table | one `<!-- kb-run -->` comment (attempts, failures, block loops) |
| `kanban_complete(summary, metadata)` | `<!-- kb-result -->` comment; open PR → *review*, else issue closed |
| worker tools | `hkb show/heartbeat/complete/block/request-review/comment/create/link` |
| stop nudge | Claude Code Stop hook (`hkb hook stop`, 2 nudges, inert unless `KB_TASK` is set) |
| crash / stale / timeout | pid check on the claiming host, `stale_after`, `max_runtime` → `ready` or `gave_up` |

Full protocol: [skills/kanban/references/protocol.md](skills/kanban/references/protocol.md).

## Profiles

`.kanban/board.json` declares profiles: a launch template plus caps. The built-in `claude` profile starts each
worker as a Claude Code **background agent** — `claude --bg --name "kb #<n> · <title>" --worktree kb-<n>-<k>
--permission-mode acceptEdits --allowedTools ... --max-budget-usd 5 "<prompt>"` — so workers show up in
`claude agents` (and the agents view of any session in the repo), can be opened with `claude attach <job>`, and are
stopped by the dispatcher once their attempt has ended. `hkb show <n>` prints the job id per attempt.
`claude-p` is the headless variant (`claude -p`, exits when done) for CI and containers without the session daemon.
Add `copilot-cli` or `codex` profiles with their own `launch` arrays; the protocol does not change.

## Local state (gitignored)

`.kanban/logs/` worker logs · `.kanban/state.json` spawn counters and auth pauses · `.kanban/outbox.jsonl` writes queued while GitHub was unreachable (replayed on the next tick) · `.kanban/cache.json` GraphQL capability cache.

## Status

MVP. Verified so far: unit tests for the model, lock classification and arg parsing; CLI wiring; and `hkb doctor --api`
against this repository (2026-08-26), which probes the things the design depends on:

- duplicate ref create returns **422 "Reference already exists"** (not 409) — `src/lock.js` treats both as `held`;
- GraphQL `Issue.blockedBy`, `blocking`, `subIssues` and `closedByPullRequestsReferences` all exist;
- REST `GET /issues/{n}/dependencies/blocked_by` works with `X-GitHub-Api-Version: 2026-03-10`.

Run `hkb doctor --api` on your own repo before the first dispatch; it re-checks all of the above.
