---
title: The checkout base (`--base`)
summary: "Where a Job's branch starts, as a spec field rather than a constant. A coding Job's output is a branch, so the base is the connector between one Job and the next — and it is a ref, never a reference to another Job, because that would be the ordering edge study §2 rejected."
category: features
kind: explanation
audience: [dev]
read_when: "chaining Jobs, filing work against an integration branch, or about to give `base` the ability to name another Job"
covers:
  - path: src/worktree.ts
    sha: 614ed72ba5eda3e5208eecf5882fda75a198c4a1
  - path: src/spec.ts
    sha: 8924cf095921bd72fd50912552ec348d2b139b3a
  - path: src/controller.ts
    sha: b0c5c54ab9e66da964a704153c3776c89fb00c2d
  - path: src/rebase.ts
    sha: 2adf640c2c4f9e639dee6a1876118a774002d028
  - path: prisma/schema.prisma
    sha: deb0743051f8edc773e9c2abb60960b1bcb84b25
related:
  [
    features/rebase-and-verify,
    features/workflow-templates,
    gotchas/merge-composition,
    architecture/job-kind,
    decisions/adr-015-machinery-and-consumer,
  ]
generated_at_commit: aa34c9c
last_refreshed: 2026-09-07
---

# The checkout base (`--base`)

> `Job.base` is the ref a Job's worktree is cut from and the ref its branch is kept on top of
> afterwards. Null means the repository's default branch — what every Job got when this was a
> constant. `hkb new "review it" --base kb-33-1` starts a Job from where an earlier one finished.

## Why a *constant* was the problem

hkb's unit of work produces a **branch**. That is its output in the sense that matters: a human
merges it, and anything that wants to build on the work has to start from it. But `baseRef()`
resolved `origin/HEAD` on every attempt and nothing could say otherwise, so every Job in a
repository started from the same place. Two Jobs could not be connected at all — not because
anything forbade it, but because there was nowhere to write it down.

`docs/workflow-study.md` §4.1 named this and the operator answered it: *the base of the checkout
becomes a spec field*. `docs/rebuild-plan.md` item 5 had already called for the same thing under the
name *integration branch*, and item 10's note says the graph kind waits on it. This is that field.

## It is a ref, and never a reference to another Job

`--base job:33` is the obvious next thought and it is refused by not existing. It would be
`Job.after` wearing a hat: a dependency on a sibling of its own kind, which `docs/workflow-study.md`
§2 rejected on four counts rather than deferring — no core Kubernetes object carries one, the Job
controller would have to read another Job's status to know when the ref was ready, and the predicate
would be wrong anyway, because `succeeded` is a phase this codebase documents as carrying no
judgement.

The distinction that makes `base` allowed where `after` is not: **a ref is a fact about a checkout
and it schedules nothing.** Filing step two before step one has pushed does not wait — it fails,
loudly, and you file it again. Ordering between workloads stays where ADR-007 decision 5 put it, in
a second kind whose controller creates Jobs.

This is the line to hold when somebody asks for `base` to wait. Making it wait is not a small
extension of this feature; it is the rejected feature.

## Resolution, and its one fallback

`baseFor` (`src/worktree.ts`) tries the ref as written, then `origin/<name>`. Two tries, not a
search path — and the second one is not politeness, it is the case that actually happens: the local
`kb-33-1` branch exists right up until the sweep removes that Job's checkout, which deletes the
branch with it, after which only the remote-tracking ref is left. A chain filed a day later would
otherwise break for a reason nobody could see. Anything else git understands — a tag, a sha,
`origin/release-2` — resolves on the first try and never reaches the fallback.

**A base that resolves to nothing fails the Job as `no_input`, at claim time, before a session is
bought** (`src/controller.ts`). Three things about that are deliberate:

- **not at file time.** `hkb new` may legitimately file step two before step one has pushed the
  branch it names; refusing there would refuse the one workflow the field exists for.
- **not `pending`.** The checkout-failure path leaves a Job pending for the next pass, which is
  right for our own plumbing and wrong here: a ref that does not exist does not start existing
  because a controller asked again, and the Job would loop for ever.
- **`no_input` rather than a value of its own.** It is the same fact as a declared input that
  cannot be read — the run never started, nothing was spent, and the fault is in the spec or in the
  repository.

The message names both the ref asked for and the `origin/` form that was also tried, because "it is
not there" is not actionable and "neither `kb-999-1` nor `origin/kb-999-1` names a commit" is.

## What it changes downstream

`Worktree.baseLabel` was already the record of what a checkout was cut from; it now carries the
Job's answer rather than the repository's. Three things read it, and all three had the constant
baked in before:

- `createWorktree` cuts from it.
- `fetchBase` fetches *that branch* — a step branching from `origin/kb-33-1` needs that ref current,
  and the default branch having been fetched says nothing about it. The controller's per-pass fetch
  memo is therefore keyed by repository **and** base.
- `rebaseOntoBase` keeps the branch on top of it (*features/rebase-and-verify*). This is the one
  that would break the feature quietly if it were missed: a step rebased onto `origin/main` at the
  end of its run arrives back at the trunk carrying the previous step's commits as its own diff,
  which is the opposite of what it was filed to do.

`existingWorktree` and `newestWorktree` take it too, so a *resumed* attempt of a Job that branched
from an integration branch is not measured against the repository's default one.

## The board's default

`Board.defaultBase` fills a null on the Job, through the ordinary three levels in `src/spec.ts`
(Job wins, board fills, built-in last). The built-in is null and the null means something specific:
*the repository's own default branch, resolved fresh*. Writing a branch name into `BUILT_IN` would
make one branch the answer for every repository hkb runs in, which is the constant this field exists
to remove.

The board level is for a repository whose trunk is not what `origin/HEAD` points at — a protected
`main` with an integration branch in front of it. `hkb boards set <slug> --base <ref>`, and it prints
in the board's defaults line, because a board silently building on something other than the default
branch is a surprise waiting in a diff nobody can explain.

## What it makes possible, and what it does not

`base` is a key in the workflow template format (*features/workflow-templates*), because the keys
are the flags — so a chain is authorable in a file with no hkb release, which is ADR-015 decision 3.

What it does **not** do, and this is worth being plain about: it does not decompose work, it does
not order anything, and it does not make per-PR CI compose (*gotchas/merge-composition* — the
collisions that started this had no merge conflict to answer). It is the piece those things were all
missing: somewhere for one Job's output to be the next one's starting point.
