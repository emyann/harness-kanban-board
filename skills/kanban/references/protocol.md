# ghkanban protocol v1

Everything that must survive a crash lives in GitHub. Nothing here needs a paid plan.

## Task = issue

| Concern | Where | Notes |
|---|---|---|
| Status | one label `kb:status:<triage\|todo\|ready\|running\|blocked\|review\|done\|archived>` | `done` = closed as completed; `archived` = closed + label |
| Board | label `kb:board:<slug>` | one issue belongs to one board; cross-board links are refused |
| Profile (assignee) | label `kb:agent:<profile>` | profile = launcher + model + caps in `.kanban/board.json` |
| Needs a human | label `kb:needs-human` | orthogonal flag; set on gave_up, block loops, most block kinds |
| Machine fields | `<!-- kb: {...} -->` block at the top of the body | `priority, workspace, max_runtime, max_retries, model, skills[], paths[], scheduled_at, idempotency_key, goal`. Malformed → defaults, never a crash |
| Dependencies | GitHub issue dependencies: child **blocked by** parent | Hermes parent→child. A blocker counts as done only when closed as *completed* |
| Attempts (Hermes `runs`) | one `<!-- kb-run -->` comment, fenced JSON | `attempts[] {attempt, profile, host, pid, started_at, heartbeat_at, ended_at, outcome, summary, reason, log}`, `failures`, `block_loops` |
| Structured handoff | `<!-- kb-result -->` comment per completion / review request | `{summary, metadata{changed_files, verification, dependencies, residual_risk, retry_notes}, artifacts[]}` |
| Events | issue timeline + attempt rows (`ghk log`) | |
| Claim | git ref `refs/kb/locks/<n>/<attempt>` | create = atomic claim (201 claimed / held on **422 "Reference already exists"** — the observed duplicate response, verified 2026-08-26 — or 409 / anything else unknown → back off) |
| Output | branch + draft PR with `Closes #n` | PR merge closes the issue; an open PR moves the task to `review` |

Precedence when they disagree: run comment > labels > body block.

## State machine

```
triage  --(human / ghk promote)-------------------------------→ todo
todo    --(all blockers closed-as-completed AND scheduled_at <= now)--→ ready       [dispatcher, every tick]
ready   --(claim ref created)----------------------------------→ running
running --complete--→ done (issue closed)   | --block(kind)--→ blocked (or todo if kind=dependency)
running --request-review--→ review          | --crash/timeout/stale/protocol_violation--→ ready (failures++)
failures > max_retries -----------------------------------------→ blocked + kb:needs-human (gave_up)
review  --PR merged / reviewer complete--→ done | --request-changes--→ ready (same branch)
blocked --unblock / promote--→ ready (or todo if blockers open)
same block reason × block_recurrence_limit ---------------------→ triage + kb:needs-human
done    --archive--→ archived
```

`ready` derives **only** from blocker closure. PR state never gates readiness.

## Dispatcher tick (`ghk dispatch`)

1. Replay `.kanban/outbox.jsonl` (writes queued while GitHub was unreachable).
2. For every `running` task: crashed (pid gone on this host) · timed_out (`max_runtime`) · reclaimed (no heartbeat for `stale_after`) → close the attempt, release the ref, `failures++`, back to `ready` or `gave_up`.
3. Sweep orphan lock refs (no matching open attempt).
4. Promote `todo` → `ready`.
5. For `ready` tasks by priority: caps (`max_in_progress`, per-profile, daily spawn cap) → guards (`active_pr` → review, `blocker_auth` pause, `recent_success`, `path_overlap`) → claim ref → append attempt → label `running` → spawn the profile's launch command with `KB_*` env.

One GraphQL query per board per tick; everything else is per-task and only for tasks that changed state.

## Worker environment

`KB_TASK` `KB_ATTEMPT` `KB_BOARD` `KB_REPO` `KB_LOCK_REF` `KB_ROOT` `KB_PROFILE`

## Terminal verb inputs

`complete`, `block` and `request-review` take their payload from any of three sources, so no harness has to push JSON
through shell quoting. Per field, inline > file > stdin.

| Source | Form |
|---|---|
| stdin (**recommended**) | `--from-stdin` + one JSON object `{summary, metadata, artifacts, reason, kind, reviewer}`; unknown keys are refused |
| files | `--summary-file <path>` `--metadata-file <path.json>` `--reason-file <path>`; `--metadata <path>` reads a file when the value does not start with `{` |
| inline | `--summary ".." --metadata '{..}' --artifacts a,b` · `block <n> "reason" --kind <kind>` · `--reviewer <profile>` |

```bash
ghk complete "$KB_TASK" --from-stdin <<'EOF'
{"summary": "what changed, for the next worker", "metadata": {"changed_files": ["src/a.js"], "verification": ["npm test"]}}
EOF
```

`metadata` must be a JSON object (`changed_files, verification, dependencies, residual_risk, retry_notes` by convention);
`artifacts` a list of strings. Missing summary / reason → exit 2 with the fix in the message. A verb queued in the
outbox while GitHub is unreachable is stored in its inline form, so replay needs neither stdin nor the worker's files.

## Outcomes

`completed · blocked · crashed · timed_out · spawn_failed · reclaimed · protocol_violation · gave_up · review_requested · changes_requested`

## Exit codes

`0` ok · `1` error · `2` usage / wrong state · `3` LOCK_LOST (stop immediately)
