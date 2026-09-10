# What the harness exposes about a subagent — a measurement

Card #63. **Nothing here changes behaviour.** It is the record behind a one-page finding, kept so the
numbers can be re-read rather than re-argued. The question it answers is where the line falls between
what hkb schedules and what it delegates: `Agent` is off `DEFAULT_TOOLS`, no Job on this board had ever
been granted it, and `admitSpawn` / `subagentIsolation` (`src/admission.ts`) were written from the SDK's
documentation rather than from a run.

Measured 2026-09-09/10 against `@anthropic-ai/claude-agent-sdk@0.3.261`, model `claude-opus-5`.

## How it was measured

Two Jobs, the same brief, on a scratch board (`HKB_DATABASE_URL=file:/tmp/hkb-probe63/board.db`) whose
`Board.repoPath` is this repository — a scratch board only so the probe would not take the live board's
single slot; every code path is the shipped one.

| | Job #1 | Job #2 (control) |
|---|---|---|
| tool surface | `Read,Glob,Grep,Bash,TodoWrite,Agent` | the same, **without `Agent`** |
| outcome | completed, **$2.6907**, 22 turns, 7 denials, **8m38s** | completed, **$2.6024**, 26 turns, 10 denials, **9m48s** |
| session | `6086c35d-cfc2-4afb-a466-28ed52c44023` | `fbde42f1-24b0-443a-b0b8-0704e03c2ab4` |

`Write` and `Edit` were deliberately left OFF both surfaces, and the brief made each subagent call
`Write` — the gate test that asks the guard to *refuse*.

Four smaller probes drove the SDK directly through **hkb's own `queryOptions`**
(`/tmp/hkb-probe63/stream-probe*.mjs`), so the options under measurement are the shipped ones, and
logged every raw stream message.

Evidence, all still on disk:

- transcripts — `~/.claude/projects/-home-yrnd1-projects-harness-kanban-board--hkb-worktrees-kb-1-1/6086c35d-….jsonl`,
  and the subagents' own at `…/6086c35d-…/subagents/agent-*.jsonl` (+ `.meta.json`);
  the control at `…-kb-2-1/fbde42f1-….jsonl`
- the workers' own reports — `/tmp/hkb-probe63/artifacts/1-1/report` (32 KB), `…/2-1/report`
- raw streams — `/tmp/hkb-probe63/stream.jsonl` (spawn), `/tmp/hkb-probe63/stream3.jsonl` (messaging)
- the probe board and its briefs — `/tmp/hkb-probe63/`

## 1. What the stream shows about a spawn

Everything the docs promise, and one thing more.

```
{"type":"assistant","parent_tool_use_id":null,"blocks":["tool_use:Agent:toolu_01QctpyGL…"]}
{"ADMISSION":"mutate Agent — isolation injected (was null)"}
{"type":"system","subtype":"task_started"}
{"type":"user",     "parent_tool_use_id":"toolu_01QctpyGL…","blocks":["text:\"Run `pwd` …\""]}
{"type":"system","subtype":"task_progress"}
{"type":"assistant","parent_tool_use_id":"toolu_01QctpyGL…","blocks":["tool_use:Bash:toolu_01Jmqx…"]}
{"type":"user",     "parent_tool_use_id":"toolu_01QctpyGL…","blocks":["tool_result:toolu_01Jmqx…:ok"]}
{"type":"system","subtype":"task_updated"} {"type":"system","subtype":"task_notification"}
{"type":"user","parent_tool_use_id":null,"blocks":["tool_result:toolu_01QctpyGL…:ok"]}
```

- The subagent's messages **do** arrive with `parent_tool_use_id` set to the `Agent` call's
  `tool_use.id`, exactly as `sdk.d.ts` says. The spawn is fully attributable in the stream.
- Its **tool calls arrive by name**, in real time: over Job #1, hkb's own event log recorded 33 tool
  events while the parent transcript holds only 21 — the extra 12 are the two subagents' six calls each
  (`Bash`×4, `Read`, `Write`). **hkb already sees every subagent tool call and cannot tell it from the
  parent's**, because `src/runtime/claude.ts` reads `block.name` and drops `parent_tool_use_id`.
- Each forwarded subagent `assistant` message carries its own `usage` block, so **token deltas are
  forwarded** per message, contrary to the note in the docs.
- Text: with `forwardSubagentText` unset (hkb does not set it) a **foreground** subagent's text is not
  forwarded, but a **background** one's is — subagent A's "I'll run through these probes in order." and
  its whole final report appear in hkb's log and nowhere in the parent's transcript.
- On completion the parent is handed `agentId`, and a usage block:
  `subagent_tokens: 31262, tool_uses: 6, duration_ms: 36777`, plus `worktreePath` / `worktreeBranch`.
  Tokens and a bare count of tool uses — no dollars, no tool names.
- The harness also writes a **durable per-subagent record** beside the parent's transcript:
  `…/<session>/subagents/agent-<id>.meta.json` = `{agentType, worktreePath, spawnedWithWorktree,
  worktreeBranch, description, name, toolUseId, spawnDepth}`, with the full JSONL transcript next to it.
  This is #52's `spawned` row, already written, already addressed by the session id hkb stores.

## 2. The admission gate fires for a subagent's tool calls

Both subagents called `Write`. Both got hkb's own text back, as a tool error:

```
Write is not part of this workload's tool surface. Available: Read, Glob, Grep, Bash, TodoWrite, Agent.
```

The `PreToolUse` hook runs in hkb's process for a subagent's calls: in the raw stream a subagent's
`ToolSearch` call produced `ADMISSION: deny ToolSearch (not on the allowlist)` between the `tool_use`
and its `tool_result`, both stamped with `parent_tool_use_id`. `permission_denials` on the result
carried the parent's denial and the subagent's alike, so **`Attempt.denials` already counts both**.

**But the fence is not one fence, and the other half does not hold.** hkb's `pre-push` hook is installed
with `git config --worktree core.hooksPath` on *the attempt's worktree* (`src/push.ts`), and a subagent
gets a **different worktree**, which has no per-worktree config at all:

```
.git/worktrees/kb-1-1/config.worktree           → [core] hooksPath = …/hooks
.git/worktrees/agent-a4df4d453ff924c85/…        → no config.worktree
```

Measured against a throwaway bare repo, the same push, one from each checkout:

```
$ git -C .hkb/worktrees/kb-1-1 push /tmp/…/bare.git HEAD:refs/heads/probe-foreign
hkb: this push writes `refs/heads/probe-foreign`, and this attempt owns `kb-1-1` and nothing else …
$ git -C .claude/worktrees/agent-a4df… push /tmp/…/bare.git HEAD:refs/heads/probe-from-subagent
 * [new branch]      HEAD -> probe-from-subagent
```

A subagent granted `Bash` is outside the git sandbox: it can push any ref to any remote, including
`main`. The tool surface crosses the spawn; the push policy does not.

Two smaller facts from the same runs: `Bash` walks around a denied `Write` inside a subagent exactly as
it does in a parent (`echo > file` succeeded in the directory `Write` was refused for) — the surface is a
tool list, never a filesystem guard. And the refusal string advertises `TodoWrite`, which the harness
then refuses with *"TodoWrite is disabled for this session, in subagents as well as here"*: hkb names 6
tools, 5 exist.

## 3. Budget covers the tree; turns do not

The result message carries two different numbers and only one of them is the tree:

| | parent transcript | subagent transcript | `result.usage` | `result.modelUsage[opus-5]` |
|---|---|---|---|---|
| input | 4 | 4 | 4 | **8** |
| output | 194 | 118 | 194 | **312** |
| cache write | 17,468 | 10,480 | 17,468 | **27,948** |
| cache read | 17,118 | 9,743 | 17,118 | **26,861** |

`modelUsage` is the exact sum of parent + subagent; `usage` is the parent alone. `total_cost_usd`
($0.26246) = `modelUsage` opus-5 ($0.26145) + a `claude-haiku-4-5` line ($0.00101) the harness spends on
its own. hkb stores that figure as `Attempt.costUsd`, so **the board's spend ceiling already counts
subagents** — and counts the harness's own auxiliary model too.

The cap **binds**, and the refusing case was run: `maxBudgetUsd: 0.12`, a parent asked for four
subagents, and the session ended `Reached maximum budget ($0.12)` after the first one — the parent's own
spend at that point was roughly half the cap, so it was the subagent's that crossed it.

`num_turns` is the other story. In the two-turn probe the parent took 2 turns and the subagent 2, and
`num_turns` was **2** — subagent turns are not counted. Worse, a **background** spawn splits the run:
the messaging probe emitted **three** result messages, `turns=7, 1, 1` with cost `0.207 → 0.256 → 0.281`.
Cost is cumulative so the last one is right; `num_turns` is per segment, and `src/runtime/claude.ts`
keeps the last result — so `Attempt.turns` recorded 1 for a nine-turn run. **`maxTurns` is not a ceiling
on a Job that spawns**, and `Attempt.turns` is not a count of what it did.

## 4. Where the subagents' work lands

The gate's forced `isolation: "worktree"` works — `mutate Agent — isolation injected (was null)` fired on
every spawn, and both subagents ran in worktrees they never asked for. Where it puts them is the finding:

- the worktree is cut **in the main checkout**, `<repoPath>/.claude/worktrees/agent-<id>`, on a branch
  `worktree-agent-<id>` — never inside the Job's worktree;
- it is cut **from `origin/main`**, not from the Job's branch. `git reflog` says
  `branch: Created from origin/main`, and the decisive probe made the two differ: a parent standing in a
  linked worktree on branch `feature`, one commit ahead with `MARKER.txt`, spawned a subagent that
  reported `git log --oneline -2 → 6fa019c base` and an `ls` with no `MARKER.txt`.

So a subagent of a Job **cannot see the Job's work** — not its commits, not its uncommitted tree — and
nothing brings its work back: after Job #1, `kb-1-1` was byte-for-byte unchanged and
`probe-a-bash.txt` sat untracked in `<repoPath>/.claude/worktrees/agent-a4df…/`.

What is left behind: a worktree survives **iff** it is dirty. Subagent A wrote a file with `Bash`, so its
4.3 MB checkout and its branch outlived the run; subagent B's only write was the refused `Write`, so its
worktree was destroyed on exit with anything in it. hkb's sweep filters to
`<root>/.hkb/worktrees/*` ("Only ours", `sweepWorktrees`), so it never sees these — and the leftover
branch shows up in the parent repository's own `git branch --list`. Nothing commits a subagent's work,
and whether it survives at all is decided by a dirty-check nobody wrote down.

*(The probe's leftover worktree and branch were removed by hand afterwards; the repository is as it was.)*

## 5. Reaching a running subagent

It works, and hkb's surface is the only reason it did not.

Inside the Job, `ListAgents`, `SendMessage` and `ToolSearch` were all refused by admission — the harness
told the model twice to use `SendMessage` (in the system prompt, and in the Agent tool's own result) and
the gate correctly refused a tool nobody granted. Re-run with those tools **granted**:

- `ListAgents` returns the live subagents *and* — the part that matters —
  **`Peer sessions (2): harness-kanban-board-82 … · interactive · shell`, `kb-63-1-d7 … · interactive`**:
  the operator's other Claude sessions on this machine, addressable by name.
- `SendMessage {to: "probe-a"}` → `{"success":false,"message":"No agent named 'probe-a' is reachable."}`
  — the model reported no `name` property on its `Agent` schema and launched without one, so what was
  measured is that **the address is the opaque `agentId` the launch result hands back**. (Whether a
  `name` set at spawn is addressable is *not* measured: Job #1 did pass one, and the harness recorded it
  in `agent-….meta.json`, but `SendMessage` was refused there by the gate.) With the id:
  `SendMessage {to: "<agentId from the launch result>"}` →
  `{"success":true,"message":"Message queued for delivery to … at its next tool round."}`, and the
  subagent's final report quoted the token: `CROSS-MESSAGE-OK-7731`.

So the parked cross-messaging direction has a working mechanism **today**: no streaming input, no
`parent_tool_use_id` plumbing — it is an ordinary tool call, and therefore already gated by admission.
It also has a hole with it: granting these tools hands a worker a channel to the operator's *interactive*
sessions, which is outside anything a Job's brief is about.

## 6. Cost and wall clock, with and without `Agent`

$2.6907 / 8m38s / 22 turns with `Agent`, against $2.6024 / 9m48s / 26 turns without it — same brief, same
model, same board. The subagents were 6,918 of the run's 49,064 output tokens (14%) and 49,241 of its
112,616 cache-creation tokens. Read it as: **spawning is not visibly expensive, and that is the problem** —
the difference is inside one run-to-run variance, and one Attempt row is where it all disappears.

The control's numbers are not "the same work done serially": with `Agent` denied, that Job spent its
turns investigating the refusal. What the pair does say is that neither cost nor wall clock will tell an
operator that a Job fanned out.

## What this decides

A subagent has **none of the four row-reasons** in `docs/workflow-study.md` §5, by construction:

| reason | a subagent has it? |
|---|---|
| decision — something outside must decide | no: nothing can suspend it, and until §5 above it could not even be spoken to |
| budget / retry of its own | no: one cap for the tree, and no retry — a subagent that fails fails inside the parent's turn |
| review — the output is a diff a human merges | no: its branch is cut from `origin/main`, never pushed, never merged, deleted if clean |
| identity — another repo, model, trust level | partly: its own `agentType` and worktree, but the same lease, the same credentials, the same surface |

That is §9's anti-correlation, measured: the spawn is exactly the kind of boundary hkb should *not*
schedule. **The fence holds across the spawn where it is a tool surface, and breaks where it is a git
hook.** And the board can already SEE a spawn without owning it — `parent_tool_use_id` in the stream,
`subagents/agent-*.meta.json` on disk, subagent denials in `permission_denials`, subagent spend in
`costUsd`.

## Recommendation

**The harness keeps** orchestration, isolation, the subagent transcript and the per-subagent usage
record. hkb should not model a subagent as a row; it should read the harness's.

**Before a Job may be granted `Agent` on a board with a budget ceiling**, four things:

1. **Extend the push fence to a subagent's worktree.** Today it is per-worktree config on the attempt's
   checkout only, and a spawn steps outside it. Until it is fixed, `Agent` plus `Bash` is a Job that can
   push `main`. This is the one that is not optional. (`hooksPath` is settable at repository scope, or
   the policy file can be keyed to admit the parent's own branch only from paths hkb created.)
2. **Fix `Attempt.turns`, or stop printing it.** Keep the max `num_turns`, or sum the segments; a
   background spawn currently reports the last segment. `maxTurns` bounds the parent's turns and nothing
   the tree does — say so where the cap is documented, because `maxBudgetUsd` is the only real ceiling.
3. **Record the spawn** (#52): the runtime already receives `parent_tool_use_id` on every forwarded
   message and a usage block on every completion. One `spawned` event per `Agent` result — agent id,
   `agentType`, worktree, branch, tokens, tool count, duration — makes fan-out visible for the cost of
   reading a field the loop currently discards. Attribute the tool events with the same field, so
   `hkb watch` stops showing a parent that called `Read` when it did not.
4. **Say in the brief that a subagent starts from `origin/main`.** A worker that delegates "finish this
   file" to a subagent is delegating to a checkout that cannot see the file. That is a property of the
   harness, not a bug in hkb, and it is invisible from inside the Job.

And one that is not about `Agent`: **never put `SendMessage` or `ListAgents` on a default surface**. They
reach the operator's other sessions. If cross-messaging is ever wanted, the gate needs a rule about `to:`,
not just about the tool's name.
