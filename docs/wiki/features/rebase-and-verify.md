---
title: Rebase before the pull request
summary: "The base a Job is cut from is fetched before the checkout and replayed onto after the run: a branch that no longer sits on what a reviewer will merge is rebased and force-pushed under a lease, or fails the attempt as `conflicted`. Why the controller does the rewriting the worker is forbidden to do, and what this deliberately does not fix."
category: features
kind: explanation
audience: [dev]
read_when: "a Job failed as `conflicted`, a worker branch was rewritten under a draft PR, or you are about to make the checkout base a spec field"
covers:
  - path: src/rebase.ts
    sha: 5b0df395ad3a5c5a8b2bad44a782d40e92d40d28
  - path: src/worktree.ts
    sha: 0fd70150e01756dd5ace7b862e094b3746f285d0
  - path: src/controller.ts
    sha: f7ad36d78481f66cd84913e0042dc7140c085c6a
  - path: src/brief.ts
    sha: e34bc16f6bcd9864078e47ff114f0790e32a359e
  - path: prisma/schema.prisma
    sha: 34921e6803578d6831938ada63d477d55a95eb6a
related:
  [
    features/the-checkout-base,
    gotchas/merge-composition,
    architecture/job-kind,
    architecture/the-loop,
    features/declared-outputs,
    decisions/adr-014-no-preset-three-rules,
  ]
generated_at_commit: 6075a95
last_refreshed: 2026-09-08
---

# Rebase before the pull request

> A Job's checkout is cut from `origin/<default>` when the attempt is claimed and the base keeps
> moving while the work runs. Two things now happen about that: the base branch is **fetched** once
> per repository per pass, before any worktree is cut, and after a successful run the attempt's
> branch is **replayed onto the base as it is then** (`rebaseOntoBase`, `src/rebase.ts`). A clean
> replay is pushed with `--force-with-lease` if the worker had already pushed; three ways of
> failing to get the branch onto the base end the attempt as `Outcome.conflicted` with the checkout
> kept to fix it in.

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
- It **is not** decomposition. The base *has* since become a spec field
  (*features/the-checkout-base*), which is what lets a graph's children branch from their parent
  rather than from origin — but drawing the graph is still the DAG kind's job, not this one's.

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

The same trap is reachable from the *prompt*, and was: a worktree shares its parent's ref store, so
a worker running `git fetch origin` inside one updates every remote-tracking ref there. The brief
therefore names the branch — `git fetch origin main` — and says why in one line. A guard that the
prompt beside it hands back is not a guard.

**And it is one fetch per repository per pass, not per Job.** It runs in the serial pre-dispatch
section, whose own comment justifies its placement with *"cutting a worktree is fast"*; a network
round trip is not. Five Jobs claimed together would otherwise have made five identical fetches one
after another, each able to burn the full twenty-second timeout before any worker started.

## Why the controller rewrites history the worker may not

The worker's protocol has always said *never `git push --force`* (`withProtocol`, `src/brief.ts`)
and that rule is unchanged. But a branch that has already been pushed and whose base has since
moved can only be rebased by rewriting what is on the remote. If the worker may not and a human
should not have to, the controller is the only candidate left — and it is a defensible owner: it
created the branch, and `kb-<id>-<k>` is hkb's namespace on that remote.

The rest of that argument is *"the pull request it lands under is a draft nobody has reviewed"*, and
it is now enforced rather than asserted. The controller reads the pull request **before** the rebase
and passes `mayRewrite`; a pull request out of draft stops the whole operation, reported as
`current`. That case is not hypothetical — ADR-010's gate suspends an attempt *precisely* so a human
reviews the diff, and the approved attempt would otherwise force-push out from under their comments.

The other half of the safety is `--force-with-lease`, which refuses when the remote is not where our
own tracking ref says it is.

### The worker's own rebase, and where it is NOT asked for

The brief asks for a rebase only when the branch has **not yet been pushed** — which the controller
decides with `pushedRef`. A resumed attempt lands in the previous attempt's checkout, on a branch
already on the remote: rebasing there makes the next `git push -u` a non-fast-forward rejection, and
the very next rule in the same protocol forbids the force that would fix it. Asking anyway is asking
for a step with no legal ending, and a worker in that position reports a failed push and often
skips the pull request entirely. The controller rebases that case itself after the run.

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

Three other pure pieces sit beside it, and two of them exist because git's exit code lies:

- `conflictReason` — git says a great deal on a failed rebase, and the `CONFLICT` lines are the part
  that names whose change collided. Capped at three, because the result lands in `Attempt.reason`,
  which is 300 characters.
- **`conflictedPaths`** — a `rebase --autostash` that replays every commit and then cannot reapply
  the stash **exits 0**. Believing that means reporting `rebased`, force-pushing, recording the
  attempt as succeeded, and leaving the operator an unmerged index full of conflict markers with the
  worker's uncommitted output in an unnamed stash entry. It is the reachable case, not a theoretical
  one: a Job with declared `exports` ends with a dirty tree every time, because exporting copies
  rather than moves. Detected, nothing is pushed, and the attempt blocks with the stash named.

  It reads the **state** — the unmerged codes in `git status --porcelain` — and not git's own
  message. The first version matched the string *"Applying autostash resulted in conflicts"*, passed
  on git 2.43 and failed on 2.55: prose is not an interface, and a check that reads one expires
  quietly on somebody else's machine.
- **`pushRefused`** — the difference between the remote *refusing* us and our failing to *reach* it,
  which is the difference between blocking an attempt and not.

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

## What blocks an attempt, and what is only said

Three states are the Job's problem and end the attempt as `conflicted`: the replay hit a conflict,
the lease refused because somebody else moved the branch, and the replay worked while the autostash
did not.

One is **ours** and does not block: a push that never reached the remote. A twenty-second timeout on
a large repository, an auth blip or a forge outage would otherwise fail an attempt whose work
succeeded and is already on the remote with a pull request open — and the state such a failure
leaves is exactly the state that existed before this module did. It is said out loud, with the
command to finish it, and the Job stands. The same reasoning covers a failed *fetch*: it is carried
on every result as `staleBase` and printed, because everything downstream then ran against the ref
as it stood.

And two states leave the branch legitimately **off** its base with nothing to report at all:
`rebasePlan` returning `nothing` because a pushed branch's pull request is no longer a draft, and
any result carrying `staleBase`. Neither fails the attempt and neither should — but the completion
check runs on this tree immediately afterwards, and the whole argument for running it *after* the
rebase is that it tests what would merge. So the result carries `onBase` as well
(`src/rebase.ts`), the controller reads it as `onBase && !staleBase`, and a check that judged an
un-replayed tree says so on the record and in the log rather than letting the claim stand
unqualified (`features/check`).

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

The refusing cases are the ones that carry the feature, and each one fails a test when its guard is
neutered: a branch that will not replay must leave the local branch, the remote and the working tree
exactly as the worker left them, with no rebase in progress for the operator to discover; a remote
somebody else moved must be refused by the lease rather than overwritten; an autostash that did not
come back must block rather than ride git's exit code; a remote that went away must **not** fail the
Job; a pull request out of draft must stop the rewrite; and the brief must never ask for a blanket
fetch.
