---
title: Worker identity — which attempt a session is, and who may say so
summary: The three answers to "which attempt is this session?" (launch environment, checkout, job record), the order of trust between them, why a `claude --bg` launch must hand over none of them, and — this is also the page for it — how `SubagentStop` resolves a fourth, child-checkout answer via `CLAUDE_PROJECT_DIR`.
category: concepts
kind: explanation
audience: [dev, ops]
read_when: "touching the launch environment, the Stop, PreToolUse or SubagentStop hooks, session_id/transcript_path on an attempt row, or anything that reads KB_TASK"
covers:
  - path: src/hook.js
    sha: 464c411be61b06c8513fd248847bf0eeceb3eef0
  - path: src/model.js
    sha: de323e59fae958580450c490eea7fa56520e28a5
  - path: src/jobs.js
    sha: a5b255731602cb2363ff33745fa1039e211ffdd1
  - path: src/dispatch.js
    sha: 6a31798b86f2e330b93d1bf20f659e4843d6a022
  - path: src/doctor.js
    sha: c29b0cd7856ca394203cb53b8755bf85e25bd239
  - path: src/lifecycle.js
    sha: 29089f8c1ba2f46a320316634593773d1d2b67b0
generated_at_commit: 53ecf5a
last_refreshed: 2026-09-03
related: [architecture/overview, features/harness-profiles, features/tracks, decisions/adr-004-roles-and-adoption]
---

# Worker identity — which attempt a session is, and who may say so

> Almost everything hkb does inside a worker turns on one question: *which
> attempt is this session?* The nudge that blocks a stop, the permission policy
> that answers a tool call, the `session_id` a post-mortem reopens and the
> transcript `hkb stats` prices all read it first. There are three possible
> answers, they can disagree, and the two incidents on this board (#125, #150)
> were both a disagreement nobody had ruled on.

## The three answers

| Answer | Where it comes from | Whose it is |
| --- | --- | --- |
| the launch environment | `KB_TASK`/`KB_ATTEMPT`/`KB_BOARD`/`KB_REPO`/`KB_ROOT`/`KB_PROFILE`, set by `spawnWorker` (`src/dispatch.js`) | every harness the dispatcher runs as a child process |
| the checkout | the `kb-<n>-<k>` directory name (`parseWorktreeName`, `src/model.js`) | a `claude --bg` worker, and the tick matching a job (`matchJobByWorktree`, `src/jobs.js`) |
| the job record | `~/.claude/jobs/<id>/state.json` — `sessionId`, `linkScanPath` (`sessionFromJobState`, `src/model.js`) | which *session* ran it, not which attempt |

The first two answer "which attempt", the third answers "which session", and
`whichAttempt` (`src/hook.js`) is the one place the first two are reconciled.

## Why the environment is not enough, and not harmless either

`claude --bg` does not run the worker. It hands the request to Claude Code's
session daemon and exits, and the daemon does not forward the launch
environment to the session it starts. Two consequences, found six weeks apart,
and they pull in opposite directions:

- **#125 — nothing arrives.** On the default profile every behaviour keyed on
  `KB_TASK` was silently inert: no Stop nudge, no session id, nothing for
  `hkb stats` to price. The answer was the checkout: the launch already names it
  `kb-<n>-<k>` and the dispatcher already identifies a running job by exactly
  that name, so `whichAttempt` falls back to the directory (`src/hook.js`).
- **#150 — too much stays.** A launch that finds *no* daemon starts one, and
  that daemon keeps the environment it was started with for its whole life. On
  2026-08-28 a cold start put `KB_TASK=146 KB_PROFILE=claude KB_ROOT=…` into
  every session that daemon hosted — including an operator conversation older
  than the card. That session's Stop hook stamped *its* `session_id` onto #146's
  attempt row, and hkb's worker allowlist was enforced on the operator's shell.

So the environment goes on that path: `scrubKbEnv` (`src/model.js`) strips every
`KB_*` key, and `spawnWorker` uses it for `mode: "claude-bg"` only
(`src/dispatch.js`). Nothing is lost, because nothing was arriving. Every other
mode keeps the environment exactly as it was — for a child process it is the
only identity there is, and it dies with the process, so it can never leak.

> Claude Code 2.1.x has no flag that hands an environment to the *session* a
> `--bg` launch creates (checked against `claude --help`, 2026-08-28) — which is
> why the fix is subtraction rather than plumbing.

## When they disagree, the checkout wins

`attemptIdentity` (`src/model.js`) holds the rule, and `whichAttempt`
(`src/hook.js`) — `checkEnvLeak` (`src/doctor.js`) does the same — gives it the
cwd's basename *and* `path.resolve`d absolute path, plus `KB_ROOT`'s own
resolved path. An environment naming a task whose worktree this plainly is not
is a leak, not an identity: it is dropped, the checkout answers if it can, and
the caller gets one line on stderr
(`hkb hook: KB_TASK=146 in the environment but this is not its worktree …`).

The judgement is deliberately narrow in *which profiles* it applies to, but not
in *which cwd* counts as agreement: only a `kb-<n>-<k>` checkout naming this
exact task and attempt, whose resolved path equals `KB_ROOT` joined with that
same `kb-<n>-<k>` (`worktreePath`, `src/model.js`), is evidence for the
environment. A directory that merely happens to be *named* right — a
same-numbered `kb-<n>-<k>` worktree under an unrelated board's `KB_ROOT`, not
only a review worktree or a foreign repo entirely — fails that path compare and
is a leak too, even though its basename alone would have agreed (`source:
'worktree'`, not `'env'`, so the checkout still names an attempt, just not
authoritatively). `KB_ROOT` unset is the same failure mode: with nothing to
compare against, agreement can never be proven. That exact-path requirement
(#150's own follow-up review, "B1" — the initial cut compared only basenames,
so a same-numbered checkout anywhere still read as agreement) mattered because
a daemon's `KB_ROOT` and `KB_TASK` outlive the incident that started it: they
sit in that process's environment until it is restarted, and it can go on to
host sessions anywhere on the host, not only under the one `KB_ROOT` that
happened to launch it. It only fires at all for a profile whose worker hkb
actually knows the location of (`worksInWorktree`,
`src/model.js`: `mode: "claude-bg"`, whose job is matched by its worktree, and
`workspace: "worktree"`, which the dispatcher hands that directory as its cwd).
A `mode: "process"` Claude profile also passes `--worktree`, but where *its*
hooks run is the harness's business, and its environment dies with the process.
It is left exactly as it was, because it cannot be the source of a leak.

## A worktree carries no developer approvals either (#254)

The identity question above is about *which attempt a session is*; a related
and easily-conflated one is *what that session inherits from the repo it runs
in* — and the same worktree boundary answers both the same way. **A worker's
worktree carries tracked files only, and none of the developer's own
approvals**: `.mcp.json` and `.claude/settings.json` are tracked and reach a
worktree, but `.claude/settings.local.json` — where Claude Code writes
`enabledMcpjsonServers`/`enableAllProjectMcpServers`, a trust decision one
human made on one machine — is gitignored and never checked out into one. A
server defined in `.mcp.json` and granted in a profile's `allowed_tools` looks
granted on the board; if its only approval lives in the local file, it is
inert on every worker, silently, because nothing about the launch or the
allow-list says so. `mcpVisibilityDiagnosis`/`mcpApproved` (`src/model.js`)
read the three files this can be diagnosed from, and `checkDeniedTools`'s
`mcp visibility` check (`src/doctor.js`) and `hkb init` (`src/init.js`) both
report it — see [the denied-tools ledger](../features/denied-tools-ledger.md)
for the mechanism. MCP is only the first instance found; anything else Claude
Code records in `settings.local.json` (trusted directories, remembered
permission decisions) is invisible to a worker the same way.

## What each reader does with the answer

- **The Stop nudge** takes either answer: a background worker identified only by
  its checkout is still nudged for its terminal verb (`stopHook`, `src/hook.js`).
- **The PreToolUse policy** takes `source: 'env'` and nothing else. The policy is
  the *profile's* `allowed_tools`, and a checkout name says which task a session
  is, never which profile launched it; applied with no profile it would allow
  `hkb`, `git` and `gh` and deny a worker `npm test`. So it is deliberately inert
  on `claude --bg`, where the launch's own `--allowedTools` is the whole policy —
  and inert on a leaked environment, which is the same rule doing its job.
- **The terminal verb** stamps the session onto an attempt only when this session
  actually ran it — its own, or a node it claimed in-session and left a
  `.kanban/sessions/<n>-<k>` marker for (`sessionForAttempt`, `src/hook.js`;
  called from `src/lifecycle.js`). That is what keeps an operator finishing a
  card by hand out of the row, and what gives a track's nodes the runner's
  transcript.
- **The tick** names the session behind a live background attempt from the job
  record, one tick after the launch, for the attempts no verb ever reaches
  (`jobSessionUpdate`, `src/jobs.js`).

Answering the identity question is what makes the *rest* of the row worth
having. `SESSION_FIELDS` (`src/model.js`) is what a stamp carries, and since
#155 it is no longer only "which session, and what it cost": alongside
`session_id` / `transcript_path` / `total_cost_usd` / `num_turns` /
`duration_ms` it now records `terminal_reason`, `api_error_status`,
`model_usage` and `permission_denials`. The point is what that removes — an
attempt that ended badly used to require reopening its transcript to learn
*why*, which is the one thing a post-mortem cannot do once the session is
gone. Two consequences worth knowing before touching `sessionUpdate`: the
result object names per-model usage `modelUsage`, camelCase and unlike every
other field beside it, so it is read under an alias; and two of the four are an
object and an array, so the "is this new?" comparison is by value — a
reference check would call every Stop hook fire a change and rewrite the row
each time.

## The tick's identity outranks a hook stamp

When the row already names a session and the job the tick matched to that
attempt names another, the job wins and the row is rewritten — including the
fields the job cannot name, so a corrected id is never left beside the replaced
session's transcript. The tick logs the correction with the id it replaced
(`src/dispatch.js`).

The reasoning is what the tick can see that a hook cannot: it resolved that job
from the attempt's own checkout, whereas a Stop hook fires in whichever session
had `KB_TASK` in its environment — which #150 proved is not always the right one.
The rule only ever reaches an *open* attempt, because that is all the reclaim
step looks at, and a terminal verb closes the row it stamps; so it cannot
overwrite a verb's own record of itself.

> The one row this could not repair is the one that prompted it: #146 attempt 1
> was already closed, so no tick will look at it again. It was corrected once by
> applying the same function to the job id the row already carried.

The same "who is alive here" question guards the *reconcile* pass, and for a
harder reason. A card in `running` whose pull request merges on the forge looks,
from the outside, exactly like a card whose worker died with its work landed —
but a reviewer merging a worker's PR mid-task produces the same picture, and
reconciling it releases the claim of an attempt that is still going. There is no
recovery from that: the worker's next `hkb heartbeat` is LOCK_LOST, it exits 3,
and no terminal verb is ever filed. So the pass asks the same third answer the
reap does, `openAttempt` plus `a.host === ctx.host && pidAlive(a.pid)`
(`src/dispatch.js`, `src/gc.js`), and skips the card entirely while that is true
— reporting it as `reconcile_left: worker_alive` rather than silently. Note the
limit this inherits: a pid is only checkable on the host that owns it, so an
attempt whose `host` is another machine is not protected this way. It is
protected by the *claim* instead, which is the reclaim clock's business.

## A fourth session that answers for the root: `SubagentStop` from the child's own cwd

`SubagentStop` (#163) breaks the "checkout answers for itself" pattern above in
one specific way: it fires from the **child's** worktree
(`.claude/worktrees/agent-<id>`, measured 2026-08-28, spike job `cadca6f1`),
never the root's `kb-<n>-<k>` checkout — so `whichAttempt(ctx.root)` answers
nothing there, silently, because a child worktree's basename parses as neither
a `kb-<n>-<k>` checkout nor a leaked environment (it carries no `KB_*` at all).
`subagentStopHook` (`src/hook.js`) asks `process.env.CLAUDE_PROJECT_DIR` —
which Claude Code sets to the *root* session's project directory even inside a
child's own turn — **first**, whenever it is set and disagrees with the cwd,
falling back to the cwd only when the env agrees or is absent. Skipping that
env lookup entirely was reviewed and rejected on PR #178: without it, `ended`
never advances for a session that ever spawns a subagent, and the root goes
unnudged for the rest of the attempt. Trying the cwd *first*, as #178 shipped
it, was itself wrong the other way (#187): a child checkout can have its own
`.kanban/` — no `board.json`, but present — in which case `whichAttempt(cwd)`
silently falls through to the *inherited* `KB_*` env instead of failing
outright, and `ended` lands on the child's own (nonexistent, board-less)
`.kanban/sessions/` rather than the root's, reproducing the original #163 bug
on that one edge. The whole fix rests on one measured fact, not a documented
contract: `CLAUDE_PROJECT_DIR` inside a child's `SubagentStop` is the root's
own `kb-<n>-<k>` checkout (spike-measured, 2026-08-28, job `cadca6f1`).
Nothing else identifies the root from inside a child's turn — without this
variable, `ended` is never recorded (b-neg probe: the child's cwd carries no
`KB_*` of its own to fall back to).

That bookkeeping (`started`/`ended`/`suppressed` under
`.kanban/sessions/<n>-<k>.subagents`) is append-only, not read-modify-write —
two `SubagentStop`s landing together must not both read `ended: 0` and both
write `ended: 1`, which would lose one of them the same way the missing
`CLAUDE_PROJECT_DIR` fallback did. And because a denied `Agent` call or a
subagent that dies before firing `SubagentStop` can leave `started` ahead of
`ended` forever, `shouldNudgeOnStop` (`src/model.js`) bounds how many
consecutive Stops it will suppress before nudging anyway — see its doc comment
for the exact count and the idle-tick cadence it is chosen against. Consecutive
is literal: `readAgentCounts` (`src/hook.js`) resets the streak to 0 on every
`E` line, so a track root that fans out several waves in a row gets a fresh
budget of suppressed Stops each time a wave finishes — a wave-5 root is not
penalised for the suppressed Stops waves 1–4 already spent (#187; before the
fix, `suppressed` counted `X` lines over the whole attempt, so a root fanning
out five or more waves could trip the bound on a wave that was, itself,
correctly waiting).

## For ops

`hkb doctor` has a line for this — `worker environment` — and it only appears
when doctor's own shell is carrying a worker identity that its directory
contradicts (`checkEnvLeak`, `src/doctor.js`). On Linux it also names the
session daemon holding the variables, by pid, read from `/proc/<pid>/environ`
(`daemonsWithKbEnv`, same file). The fix is to let that daemon's sessions finish
and end it: the next `claude --bg` starts a clean one, and a dispatcher on this
version cannot poison the replacement. Symptoms worth recognising before doctor
is run: a session being nudged about a card it never touched, ordinary shell
commands denied with `hkb:` in the reason, and an `hkb show <n>` resume line
that opens somebody else's conversation.

## Related

- [architecture/overview](../architecture/overview.md)
- [decisions/adr-004-roles-and-adoption](../decisions/adr-004-roles-and-adoption.md)
- *features/tracks* (planned) — one session, many attempts: the other case where
  "which attempt is this?" has more than one answer
