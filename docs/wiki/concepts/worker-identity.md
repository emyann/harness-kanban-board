---
title: Worker identity — which attempt a session is, and who may say so
summary: The three answers to "which attempt is this session?" (launch environment, checkout, job record), the order of trust between them, and why a `claude --bg` launch must hand over none of them.
category: concepts
kind: explanation
audience: [dev, ops]
read_when: "touching the launch environment, the Stop or PreToolUse hooks, session_id/transcript_path on an attempt row, or anything that reads KB_TASK"
covers:
  - path: src/hook.js
    sha: a1c4de45dbb0a29e6bf602b0925e9a1da3be498a
  - path: src/model.js
    sha: fc0671faed32f913ec5bcbe16819476f50ceeeb2
  - path: src/jobs.js
    sha: a5b255731602cb2363ff33745fa1039e211ffdd1
  - path: src/dispatch.js
    sha: 202feb141cef1529814ea4fedc91514f3f446335
  - path: src/doctor.js
    sha: a6afe38be8a47394bf2341c24a24cec2a0d9ed1c
  - path: src/lifecycle.js
    sha: 20ebc63bcdd5e63634de41fb620aa84a38e720b3
generated_at_commit: 9597b41
last_refreshed: 2026-08-28
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
| the launch environment | `KB_TASK`/`KB_ATTEMPT`/`KB_BOARD`/`KB_REPO`/`KB_LOCK_REF`/`KB_ROOT`/`KB_PROFILE`, set by `spawnWorker` (`src/dispatch.js`) | every harness the dispatcher runs as a child process |
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

`attemptIdentity` (`src/model.js`) holds the rule, and `whichAttempt` gives it
the cwd's basename plus whether that cwd *is* `KB_ROOT`. An environment naming a
task whose worktree this plainly is not is a leak, not an identity: it is
dropped, the checkout answers if it can, and the caller gets one line on stderr
(`hkb hook: KB_TASK=146 in the environment but this is not its worktree …`).

The judgement is deliberately narrow in *which profiles* it applies to, but not
in *which cwd* counts as agreement: only a `kb-<n>-<k>` checkout naming this
exact task and attempt is evidence for the environment. Everything else — the
board root, a `kb-<n>-<k>` naming a different attempt, a review worktree, a
session the same poisoned daemon went on to host for an unrelated repo — is a
leak. That widening (#150's own follow-up review, "B1") mattered because a
daemon's `KB_ROOT` and `KB_TASK` outlive the incident that started it: they sit
in that process's environment until it is restarted, and it can go on to host
sessions anywhere on the host, not only at the one board root that happened to
launch it. It only fires at all for a profile whose worker hkb actually knows
the location of (`worksInWorktree`,
`src/model.js`: `mode: "claude-bg"`, whose job is matched by its worktree, and
`workspace: "worktree"`, which the dispatcher hands that directory as its cwd).
A `mode: "process"` Claude profile also passes `--worktree`, but where *its*
hooks run is the harness's business; a `trigger` profile's worker runs in an
Actions checkout that is nobody's worktree and sets no `KB_ROOT`
(`templates/actions/kanban-worker-claude.yml`). Both are left exactly as they
were, because neither can be the source of a leak.

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
