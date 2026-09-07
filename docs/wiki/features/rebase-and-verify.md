---
title: Rebase before the pull request
summary: "The base a Job is cut from is fetched before the checkout and replayed onto after the run: a branch that no longer sits on what a reviewer will merge is rebased and force-pushed under a lease, or fails the attempt as `conflicted`. Why the controller does the rewriting the worker is forbidden to do, and what this deliberately does not fix."
category: features
kind: explanation
audience: [dev]
read_when: "a Job failed as `conflicted`, a worker branch was rewritten under a draft PR, or you are about to make the checkout base a spec field"
covers:
  - path: src/rebase.ts
    sha: cccbc000ced08a0b486f76ae6a7cf6079536f379
  - path: src/worktree.ts
    sha: 95c1207c4eaa7318526b9cd4df337802c08a521d
  - path: src/controller.ts
    sha: e346f83af40789b9fb4292972c6014f30cde34e1
  - path: src/brief.ts
    sha: 11efbf53da940f7e23f1ddc0335bea2e748783af
  - path: prisma/schema.prisma
    sha: b6d31a7e665c57a075972e88e98e2501da2c45d7
related:
  [
    gotchas/merge-composition,
    architecture/job-kind,
    architecture/the-loop,
    features/declared-outputs,
    decisions/adr-014-no-preset-three-rules,
  ]
generated_at_commit: f2c1da5
last_refreshed: 2026-09-06
---

# Rebase before the pull request

> A Job's checkout is cut from `origin/<default>` when the attempt is claimed and the base keeps
> moving while the work runs. Two things now happen about that: the base branch is **fetched**
> before the worktree is cut, and after a successful run the attempt's branch is **replayed onto
> the base as it is then** (`rebaseOntoBase`, `src/rebase.ts`). A clean replay is pushed with
> `--force-with-lease` if the worker had already pushed; one that will not replay fails the attempt
> with `Outcome.conflicted` and keeps the checkout to fix it in.

## The hole this closes, and the two it does not

`docs/wiki/gotchas/merge-composition.md` is the history: two dogfooding rounds produced pull
requests that were individually correct, individually green and jointly broken. `docs/rebuild-plan.md`
item 10 split the answer in two — *"the cheap half is a rebase-and-test before the PR is called
ready; the honest half is admitting a Job cannot verify a claim about a tree it has never seen"*.
This is the cheap half, and the boundary matters because the temptation is to read it as more:

- It **does not** make per-PR CI compose. Two branches that never touch the same line can still
  break the same invariant, which is the whole finding of the gotcha page.
- It **does not** survive the base moving again. It makes the branch current at the moment the
  attempt ends; a pull request merged five minutes later moves the base again and nothing re-runs.
- It **is not** the base becoming a spec field (`docs/workflow-study.md` §4.1) — a graph's children
  branching from their parent rather than from origin. That is the real fix, it is the DAG's
  precondition, and it is deliberately not started here.

What it does close is the measured friction: on 2026-09-06 four parallel Jobs cost four hand
rebases, and 82 line-number citations in this wiki drifted because every branch was cut from a base
that then moved.

## Nothing fetched, so every base was as stale as the last pull

The first half is one call and it is the half that is easy to miss. `baseRef` and `resolveBase`
(`src/worktree.ts`) only ever read **local** refs — `refs/remotes/origin/HEAD`, then `origin/main`
or `origin/master`, then `HEAD` — and nothing in hkb had ever updated one. A Job filed a minute
after a pull request landed was therefore cut from a base without it, and the daemon is the case
that makes this systematic: it runs for days on a machine nobody is pulling on.

`fetchBase` (`src/worktree.ts`) runs before the worktree is cut (`src/controller.ts`, in the claim
loop) and is best effort by construction — a repository with no remote, an unreachable one, and one
that wants credentials all mean the same thing, which is that the local ref is the best answer
available. It uses the non-interactive, time-limited git the sweep already needed (`NET_ENV`,
`NET_TIMEOUT_MS`), because a fetch that blocks on a credential prompt blocks the whole pass.

**It fetches the base branch alone, and that is a guard rather than a saving.** A blanket
`git fetch origin` would also refresh `refs/remotes/origin/kb-<id>-<k>`, which is precisely the ref
`--force-with-lease` compares the remote against — refreshing it turns the lease into a plain
`--force` and the protection disappears with nothing to notice. `test/rebase.test.ts` pins it: a
stranger pushes to the attempt branch, `fetchBase` runs, and the tracking ref must still be where
it was.

## Why the controller rewrites history the worker may not

The worker's protocol has always said *never `git push --force`* (`withProtocol`, `src/brief.ts`)
and that rule is unchanged. But a branch that has already been pushed and whose base has since
moved can only be rebased by rewriting what is on the remote. If the worker may not and a human
should not have to, the controller is the only candidate left — and it is a defensible owner: it
created the branch, `kb-<id>-<k>` is hkb's namespace on that remote, and the pull request the
rewrite lands under is a *draft* nobody has reviewed.

The safety is `--force-with-lease`, which refuses when the remote is not where our own tracking ref
says it is. When it refuses, the attempt fails as `conflicted` too, with its own message: the branch
here has been rebased and the remote has not, which is a state somebody has to resolve rather than
a state to leave quietly.

## The prompt half, and why it is not the mechanism

`withProtocol` now asks the worker to rebase **before** it pushes, and only when there is an
`origin/` base to rebase onto — telling a worker in a remote-less repository to `git fetch origin`
is an instruction to fail. The step is placed before the push because that is the one moment it is
free: after the push it costs a rewrite.

ADR-014 recorded that prompt text is layer 6 and guarantees nothing, and that is exactly the
relationship here. The prose makes the common case free — `rebaseOntoBase` then finds the branch
already on the base, spends one `merge-base`, and rewrites nothing. The controller's pass is what
makes it *true*. Neither is the other's substitute, and the pairing is the point.

## The decision, which is the part with no I/O in it

`rebasePlan` (`src/rebase.ts`) takes the base label, how many commits the branch is ahead, and
whether the base is already an ancestor of the tip, and returns one of two acts. Both "nothing"
cases are named rather than collapsed, because they are different facts about a run:

- **already on the base** — it never moved, or the worker rebased because the brief said to. The
  common case, and it must stay free.
- **nothing was committed on it** — there is nothing to replay. A Job whose deliverable is a
  `results` value rather than a diff never commits; and a branch whose commits are already *in* the
  new base (its pull request landed while the attempt was still running) reads identically.
  Rebasing either would rewrite a branch and spend a force-push to produce the base itself.

`conflictReason` is the other pure piece: git says a great deal on a failed rebase and the
`CONFLICT` lines are the part that names whose change collided. It is capped at three, because the
result lands in `Attempt.reason`, which is 300 characters.

## Where it sits in the run, and why there

In `runAndRecord` (`src/controller.ts`) the rebase happens **after** exports, results, artifacts and
the proposal validator, and **before** the gate:

- *after* the collection blocks, because a conflict is a fact about the branch and not about the
  work. What an attempt produced is a durable record of what happened and is worth keeping whether
  or not its diff still applies.
- *before* the gate, because nobody should be asked to approve a diff that no longer sits on what
  they would merge it into.

It is gated on `heldToTheEnd` like every other write outside the attempt's own row: the branch and
the remote are contended state too, and a holder that lost its lease mid-run must not rewrite
history the new holder's worker is committing onto.

## `conflicted`, and why it is not `no_output`

`Outcome.conflicted` (`prisma/schema.prisma`) is its own value because it sends an operator
somewhere else. `no_output` is a fault in the work and the answer is another run; a conflict is the
base having moved, and the answer is a hand rebase. It is **not resumable**, for the reason a
missing declared output is not: a resumed worker may not force-push, so it has no move here that a
human does not have to make first.

Two consequences worth knowing before reading a board:

- **the checkout is kept**, against the usual rule. A conflicting branch has normally been pushed,
  so nothing is unpushed and nothing is dirty, and `removeWorktree` would take it and the local
  branch with it. Finding the conflict early is only worth anything if the tree to resolve it in is
  still there when the operator reads the message.
- **the pull request is still recorded.** The forge read happens after this and is not conditional
  on the outcome, so a `conflicted` attempt still carries `prUrl` — a Job that says `failed` next
  to a pull request that looks fine is the expected reading, and `lastError` names the two commands
  that finish it.

## What a test of this has to do

Every case here is git's own behaviour, so `test/rebase.test.ts` runs against a real bare
repository with two clones of it rather than against a double: whether `--force-with-lease`
actually refuses, whether an aborted rebase really leaves the branch where it was, and whether a
fetch of one branch touches another are three questions a double would answer the way the author
expected instead of the way git does.

The refusing cases are the ones that carry the feature: a branch that will not replay must leave the
local branch, the remote, and the working tree exactly as the worker left them, with no rebase in
progress for the operator to discover; and a remote somebody else moved must be refused by the lease
rather than overwritten.
