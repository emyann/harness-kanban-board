---
title: The checkout base (`--base`)
summary: "Where a Job's branch starts, as a spec field rather than a constant. A coding Job's output is a branch, so the base is the connector between one Job and the next — and it is a ref, never a reference to another Job, because that would be the ordering edge study §2 rejected."
category: features
kind: explanation
audience: [dev]
read_when: "chaining Jobs, filing work against an integration branch, or about to give `base` the ability to name another Job"
covers:
  - path: src/worktree.ts
    sha: 98d0b677291d536701dc137cf1d5997f8fd80a3f
  - path: src/spec.ts
    sha: 8792a804835fd0602a992aeccf978e110fe2a98f
  - path: src/controller.ts
    sha: 3673f449a7ebf15f9b21900915183b3bec63b6e5
  - path: src/rebase.ts
    sha: 5b0df395ad3a5c5a8b2bad44a782d40e92d40d28
  - path: prisma/schema.prisma
    sha: 4e4b7aa6863fad5e660435982912460565ebabf3
related:
  [
    features/rebase-and-verify,
    features/workflow-templates,
    gotchas/merge-composition,
    architecture/job-kind,
    decisions/adr-015-machinery-and-consumer,
  ]
generated_at_commit: f8ea774
last_refreshed: 2026-09-09
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

## What may be written there at all

**A ref reaches `git` as a bare argv token, so a value beginning with `-` is an option.** Measured:
`git fetch --quiet origin '--upload-pack=touch /tmp/x && git-upload-pack'` runs the command. A base
arrives from `hkb new --base`, from `hkb boards set --base`, and from the `base:` key of a workflow
file — the last written by whoever wrote the *repository*, who is not necessarily whoever is running
hkb.

`validRef` is a pure predicate over what a branch, tag or sha actually looks like, and `checkRef`
is the refusal at the two write points. The character class is deliberately one expression rather
than a regex plus a separate `startsWith('-')` line: the separate line was unreachable, no mutation
of it failed a test, and an inert guard that reads like the load-bearing one is how this project has
shipped three checks that did nothing.

## Resolution, and its one fallback

`baseFor` (`src/worktree.ts`) tries `origin/<name>` first and the ref as written second. Two tries,
not a search path, and the **remote-first order is the load-bearing half**: preferring the local ref
meant `fetchBase` refreshing `origin/develop` while the checkout was cut from a local `develop`
nobody had pulled for weeks — the fetch became a no-op for the ref actually used, which is the exact
staleness it exists to remove, on the daemon host where nobody pulls. `baseRef` answers
`origin/<default>` for the same reason.

The plain ref stays as the fallback because it is what a repository with no remote has, and what a
tag or a sha resolves to. A chain is unaffected by the order: a parent branch is always pushed
before a child can name it.

**A base that resolves to nothing fails the Job as `no_input`, at claim time, before a session is
bought** (`src/controller.ts`). Three things about that are deliberate:

- **not at file time.** `hkb new` may legitimately file step two before step one has pushed the
  branch it names; refusing there would refuse the one workflow the field exists for.
- **not `pending`.** The checkout-failure path leaves a Job pending for the next pass, which is
  right for our own plumbing and wrong here: a ref that does not exist does not start existing
  because a controller asked again, and the Job would loop for ever.
- **only when a fresh checkout is being cut.** A resumed attempt continues in a tree that already
  exists and asks the base for nothing — and a chain step's parent branch is deleted the moment its
  pull request merges, so checking unconditionally would kill a Job over a question nobody asked.
- **`no_input` rather than a value of its own.** It is the same fact as a declared input that
  cannot be read — the run never started, nothing was spent, and the fault is in the spec or in the
  repository.

The message names both the ref asked for and the `origin/` form that was also tried — and only when
there *was* a second form, since a base already written `origin/foo` is tried as given and "neither
`origin/foo` nor `origin/foo`" reads as a bug in the message, which it was.

There is no verb that edits `Job.base` yet (`hkb job set` is still unfiled), so the exit from a
permanently missing base is `hkb rm` and re-file. The message says so rather than implying a repair
that does not exist.

## What it changes downstream

`Worktree.baseLabel` was already the record of what a checkout was cut from; it now carries the
Job's answer rather than the repository's. Three things read it, and all three had the constant
baked in before:

- `createWorktree` cuts from it.
- `fetchBase` fetches *that branch* — a step branching from `origin/develop` needs that ref current,
  and the default branch having been fetched says nothing about it. The controller's per-pass fetch
  memo is therefore keyed by repository **and** base.

  **Except an attempt branch, and this is the lease again.** Fetching `kb-33-1` updates
  `refs/remotes/origin/kb-33-1`, which is exactly what `--force-with-lease` compares against when
  Job 33's own attempt ends — so a chain step innocently refreshing its parent's branch would turn
  its parent's lease into a plain `--force` and let it destroy a commit somebody pushed by hand,
  with no refusal anywhere. `fetchBase` had already been narrowed from a blanket fetch for this
  reason (*features/rebase-and-verify*); naming a `kb-*` branch as a base walked it back in through
  the front door. The cost is that a chain step may branch from a parent tip one hand-pushed commit
  behind, which is the safe direction: stale work is recoverable and an overwritten commit is not.

  That skip is **silent**, and `FetchedBase.skipped` is what makes it so. There are two ways not to
  fetch and only one is worth a word: a repository with no remote and an attempt branch we refuse to
  refresh are decisions, while a network failure or a bad ref is not. Reporting the first pair would
  print "could not fetch the base" on every pass of every chain step — and the callers used to tell
  them apart by matching the message text, which is a filter that stops working the next time a
  reason is added.
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

## What the worker is told

The base changes two things in the brief (`withSandbox`, `src/brief.ts`), and the controller
computes both because only it knows the facts:

- **whether to rebase at all** — omitted for a resumed attempt, whose branch is already on the
  remote, where the rebase makes the next push non-fast-forward and the next rule in the same
  contract forbids the force that would fix it.
- **whether the worker may fetch first** — `false` when the base is an attempt branch. A worktree
  shares its parent's ref store, so `git fetch origin kb-33-1` there updates
  `refs/remotes/origin/kb-33-1` exactly as `fetchBase` would have. This is the *third* direction
  that one hole has been opened from: a blanket fetch in the prompt, then an attempt branch as a
  base, then the prompt again by way of the base. The rebase step stays; only the fetch goes.
There used to be a third — **what the pull request opens against** — and it left with the pull
request itself (*decisions/adr-017-the-workflow-is-content* decision 5). The concern it answered is
real and unchanged: `gh pr create` with no `--base` targets the repository's default branch, so a
chain step's diff would carry its parent's commits and merging it would merge the parent's
unreviewed work into the trunk. The rebase keeps the *branch* on the right base; only the review's
base keeps the *review* on it. What changed is who says so: the fact is now readable as data —
`--input where=self:base` gives a run the **branch name** its checkout was cut from (`kb-33-1`, or
the default branch), so the step's own content can open the review against it (`JOB_FIELDS`,
`src/inputs.ts`; `hkb --help`). A workflow that opens pull requests declares it; the core, which does
not know whether this Job opens one, no longer guesses.

Without the `origin/` prefix, deliberately, and it is the one place these two spellings differ: the
caller anybody writes is `gh pr create --base {{where}}`, and `gh` wants a branch on the repository
rather than a remote-tracking ref. The sandbox contract names the tracking ref instead
(`Your base … is origin/kb-33-1`), because the caller *there* is `git rebase`.

The contract names it on **every** attempt, including a resumed one that may not rebase at all. That
was the first version's gap: `rebaseOnto` is dropped once the branch is on the remote, and the base
went with it — so a resumed chain step was told nothing about its base, and its pull request opened
against the default branch carrying its parent's commits. Exactly the failure this field exists to
prevent, arriving through the door built to prevent it.

## What it makes possible, and what it does not

`base` is a key in the workflow template format (*features/workflow-templates*), because the keys
are the flags — so a chain is authorable in a file with no hkb release, which is ADR-015 decision 3.

`--base` with `--no-isolate` is **refused** rather than ignored: a Job with no worktree cuts no
branch, so the field would be stored, printed by `hkb show`, and never read — the silent failure the
project's fifth value forbids.

A base arriving from the *board's* default is not refused, and cannot usefully be: there is no
per-Job clear to escape with, and there cannot easily be one, because `pick` in `src/spec.ts` reads
a null column as **unset** and a cleared value falls straight through to the board default again.
That gap belongs to every board-defaulted field, not to this one. What is fixed instead is the
visible half — `hkb show` omits the base for an un-isolated Job rather than telling its operator
about a checkout that will never be made.

What it does **not** do, and this is worth being plain about: it does not decompose work, it does
not order anything, and it does not make per-PR CI compose (*gotchas/merge-composition* — the
collisions that started this had no merge conflict to answer). It is the piece those things were all
missing: somewhere for one Job's output to be the next one's starting point.
