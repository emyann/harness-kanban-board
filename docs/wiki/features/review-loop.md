---
title: The review loop — `request-changes` and continuing one PR
summary: How a reviewed card goes back for another round on the same PR: the one exemption to the active_pr guard, the checkout the dispatcher makes on the PR's branch, and the block in the brief that stops a second PR.
category: features
kind: explanation
audience: [dev]
read_when: "touching the active_pr guard, the claim loop's worktree creation, hkb request-changes, or the worker brief"
covers:
  - path: src/model.js
    sha: de323e59fae958580450c490eea7fa56520e28a5
  - path: src/dispatch.js
    sha: 6a31798b86f2e330b93d1bf20f659e4843d6a022
  - path: src/board.js
    sha: 0337a17cf70442cac66fb457c880e4b27a52672e
  - path: src/context.js
    sha: be28b4843c2a09afc0c835c4fe195706af86bb15
  - path: src/lifecycle.js
    sha: 29089f8c1ba2f46a320316634593773d1d2b67b0
  - path: src/gc.js
    sha: cc129d307e845211036472a76ed7e0f456be1329
  - path: src/cli.js
    sha: b183d59750a4bace38fb612026657ed3ded95708
  - path: src/forge.js
    sha: 1d9e17cd8fad3500b512ef10843d541cda2c65a4
related: [features/auto-merge, features/tracks, architecture/overview, architecture/dispatcher-tick]
generated_at_commit: 53ecf5a
last_refreshed: 2026-09-03
---

# The review loop — `request-changes` and continuing one PR

> `review → ready → running → review` is the loop the protocol draws, and until
> #153 it did not turn: two rules contradicted each other for exactly the card
> `hkb request-changes` produces, so the verb was a no-op on any board with a
> dispatcher. Closing that meant three things — an exemption in one guard, a
> checkout on the PR's own branch, and a block in the brief — because a card
> that *can* be relaunched still opens a second PR if nobody tells it not to.

## The contradiction

Two rules, both right on their own:

- **`request-changes` sends the card back to `ready`** and leaves the PR alone
  (`requestChanges`, `src/lifecycle.js`). Its whole output is a `ready` card
  with an open PR.
- **The `active_pr` guard parks a `ready` card whose PR is open in `review`**
  (the claim loop, `src/dispatch.js`) — right for a worker that finished and is
  waiting on a human, since a second worker would redo the work.

Reported from hkb's own board on 2026-08-28 (issue #153): three cards sent back
within three minutes were each in `review` again 13–15 seconds later, on the
next tick. The reviewer's brief landed in the attempt history and nothing ever
read it. The alternative a reviewer was left with — close the PR — throws away
the branch the next attempt needs.

## The exemption, and why it is keyed where it is

`activePrGuard(attempts, prs)` (`src/model.js`) is the whole decision, pure so
the table lives in a test: an open PR guards, **unless the latest attempt row is
`changes_requested`**. That row is synthetic and written only by
`requestChanges` under the reserved `reviewer` profile, so the exemption is
keyed on the reviewer's own act and nothing else — every other open-PR case
(completed, review requested, crashed, no attempts at all) keeps the guard.

Two consequences worth knowing:

- **Only the latest row exempts.** A continuation that crashes leaves `crashed`
  on top, so the guard parks the card again rather than respawning. One
  `request-changes` buys exactly one relaunch; a runaway loop is impossible by
  construction, and the reviewer decides whether there is a second round.
- **The guard now reads the run record.** It used to decide from the board query
  alone. The read happens only for a `ready` card that *has* an open PR, and
  such a card leaves `ready` on that same tick — so a board where nothing was
  sent back pays nothing, and the claim path was going to read the record
  anyway (`loadRun` is hoisted and reused in the claim loop, `src/dispatch.js`).

## The second half: continuing, not duplicating

A claimable card is not enough. The next attempt gets `kb-<n>-<k+1>`, a fresh
checkout on a fresh branch, and would open a **second** PR for one card. So the
dispatcher makes that checkout itself, on the PR's head branch:

`worktreeOnBranch` (`src/board.js`) fetches the branch, frees it from the ended
attempt's worktree when that still holds it — git refuses to check one branch
out twice, and nothing sweeps the worktree of a card sitting in `review` — and
`git worktree add`s it at the same `.claude/worktrees/kb-<n>-<k>` path every
other attempt uses. Freeing is deliberately narrow: only a worktree of *this*
task, never one a live session still holds (the same pid-in-the-lock check
`hkb gc` makes), and `git worktree remove` takes the checkout, not the commits.

`spawnWorker` (`src/dispatch.js`) then runs the harness **in** that directory
and strips the harness's own worktree flag (`withoutWorktreeFlag`) — Claude
Code's `--worktree kb-<n>-<k>` would otherwise make a second checkout on a fresh
branch. The path basename is unchanged, so everything keyed on it still works:
the background job is matched by its cwd basename, and `hkb gc` still recognises
the directory as attempt `k`'s.

This is the one place a harness's own isolation is overridden, and it is
overridden the same way for all of them: profiles that already declare
`workspace: "worktree"` (Copilot CLI, Codex) change nothing, and the ones with a
flag lose it for this attempt only.

**When it cannot be done** — the branch is held by a live session, there is no
remote, the branch is gone — the attempt still runs, on an ordinary fresh
worktree. The attempt row says which path was taken: `continues_pr` always,
`continues_branch` only when the checkout is really on that branch.

**Kept caught up, not just checked out (#162).** `git worktree add <dir>
<branch>` reuses the *local* branch exactly as it is; the fetch just above it
only updates `origin/<branch>`, so a human (or another host) pushing to the PR
since the previous attempt left the checkout behind and its own eventual
`git push` would be rejected non-fast-forward. `worktreeOnBranch` now runs
`git merge --ff-only origin/<branch>` right after the add — best effort, and
never a force: a clean fast-forward is silent, and a genuine divergence sets
`stale` on the result, which `spawnWorker` (`src/dispatch.js`) turns into
`continues_branch_stale` on the attempt row and a fallback to the brief's
catch-up recipe (below) even though the checkout is, in fact, on the right
branch. The branch already has one when a died-mid-spawn attempt is reused
(the checkout exists on the right branch already, above) — that path fetches
and runs the same catch-up rather than trusting the leftover checkout as-is.
`hkb claim --spawn` (`src/cli.js`) takes the same path as the dispatcher's own
claim and records `continues_branch_stale` too, so a manual continuation is
not silently less honest than an automatic one.

**The one profile that never made this checkout is gone.** A `mode: "trigger"`
profile (`claude-action`, the GitHub Actions runner) only *started* work
elsewhere, on its own unrelated `actions/checkout`, so `spawnWorker` skipped
`worktreeOnBranch` for it and such an attempt recorded `continues_pr` only.
[ADR-006](../decisions/adr-006-local-store.md) removed the runner and the mode
(#290), so every profile the dispatcher can launch now runs a worker on this
host and takes the checkout path above.

## The brief is what actually prevents the second PR

The checkout is a convenience; the instruction is the contract. `src/context.js`
derives the continuation from the card itself (`continuation()` calls the same
`activePrGuard`), so `hkb context <n>` shows a worker exactly what the
dispatcher put in its prompt, and emits one block near the top naming the PR,
its branch, and the rule: do not open a second one. Three standing protocol
lines change with it, because each would otherwise point the worker the wrong
way: "work on the current branch" becomes the PR's branch, "open a draft PR"
becomes "push to the one that exists", and "rebase on the default branch before
you finish" becomes **merge** it in. That last one is not a preference — the
branch is already pushed, so rebasing it would need the force-push the same
sentence forbids and the shipped Claude and Copilot profiles deny outright
(`--disallowedTools` / `--deny-tool` in `DEFAULT_PROFILES`, `src/board.js`).

Without the checkout the block carries the recipe instead (`git fetch` +
`git reset --hard FETCH_HEAD`, then `git push origin HEAD:<branch>`), which
works from whatever branch the fresh worktree happens to be on. A checkout
that exists on the right branch but could not be fast-forwarded (`stale`,
above) gets a third, accurate variant: fetch and `git reset --hard
origin/<branch>` rather than the "already there" line or the fresh-branch
recipe, so the brief never claims a plain `git push` will land when it would
not.

## What the thread says afterwards

`hkb finish` on a continued attempt already did the right thing — an open PR
means `review`, not `done` — but the record was silent about which PR. It now
names it: `complete`/`requestReview` (`src/lifecycle.js`) read `continues_pr`
off the attempt row and pass it to `serializeResultComment` (`src/model.js`),
which renders `**PR:** #147 — continued after changes requested, not reopened`.
`hkb request-changes` says the same thing forward, in its one-liner: `#146 →
ready (PR #147 stays open; the next attempt continues it)`.

So `hkb log <n>` on a card that went round twice reads `review_requested →
changes_requested → completed`, all against one PR number.

## Finding the PR at all — the head branch *is* the link

Everything above assumes `task.prs` names the open PR. Nothing on the forge's
side puts it there: the board is a branch in this repository (ADR-006), so
there is no issue for a pull request to reference and no field to read it out
of. **A PR belongs to the card whose branch name it is on**, and that is the
whole of the association.

`fillPrs(ctx, tasks)` (`src/forge.js`) is the join, and every read that goes on
to judge a card by its PR calls it: the tick's board read, the terminal verbs,
`hkb show`, `hkb list`, `hkb serve`, `hkb gc`. It reads the repository's pull
requests once — `openPrsByHead`, one `GET /pulls?state=open`, memoized on
`ctx._cache` and dropped at the top of every tick — and matches them against
`taskBranchRe(n)`: `kb/<n>`, `kb-<n>-<k>`, `worktree-kb-<n>-<k>`, and
`kb/track-<n>` for a track root's own PR. One listing per tick, never one per
card (#234).

This started as a *fallback*. `closedByPullRequestsReferences` was the primary
source while the board was GitHub Issues, and it answered a narrower question
than hkb asked of it — "would merging this close the issue", which requires the
PR to target the default branch, and (#228) came back empty at least once even
then. A card whose PR it missed had `activePrGuard` never fire and `hkb finish`
close it as *done* with the branch unmerged and nothing on the board chasing it
(#227, #228 — see `features/tracks.md`'s branch-strategy section for the fuller
incident). The head-branch match was added beside it; it is now the only path,
which is *simpler* rather than weaker — one rule, stated in the worker's brief
and in the track runner's, instead of two with a silent gap between them.

Two consequences worth stating plainly:

- **A PR on any other branch name is invisible to hkb.** `hkb finish` refuses to
  land a card in *done* with no PR found (protocol_violation, `noPrDecision`,
  `src/lifecycle.js`) unless the worker says `--no-pr "why"` — so an unplaceable
  PR stops the card rather than closing it silently. The brief
  (`src/context.js`) says the branch name is the link, in the step that tells
  the worker to open the PR.
- **`hkb doctor`'s `checkOrphanedPrs` is the other side.** It looks up each
  hkb-shaped branch's card *through the store* and warns when a settled card
  still has an open PR on its branch — the case a live read cannot reach,
  because a card in *done* is not one anything revisits. A card it could not read
  at all is named and suppresses the `ok`: the check swallowed those throws once,
  and printed "all on cards still open" — a positive verdict derived from nothing
  — on a board where every read was failing.
- **A merged PR does not drag a reopened card back.** `hkb request-changes` on a
  card whose PR has merged is exactly the fix line above, and the reconcile pass
  has to honour it: a card whose `updatedAt` is newer than the PR's `mergedAt` is
  left where the reviewer put it rather than forced to *done* by the next tick
  (`reconcileDecision`, `src/dispatch.js`; see `features/auto-merge.md`).
- **The join degrades rather than failing the read.** The cards are local and the
  pull requests are the forge's, so a forge that cannot be reached leaves
  `prs: []` and a line saying why (`prsUnavailable`, `src/forge.js`) — except in
  `hkb finish`/`request-review`/`merge`, where "no PR" is a verdict about the
  worker's work and must not be inferred from a listing that failed.

## Known gaps

- A continuation that crashes is parked in `review` by design (above), which
  means the ordinary crash-retry ladder does not apply to it. A reviewer has to
  send it back again.
- `worktreeOnBranch` assumes the remote is `origin` unless `remote` is set in
  `board.json`; it fetches best-effort and a fetch failure is silent. Measured,
  not assumed: when a tracking ref from an earlier fetch already exists, a
  failed fetch leaves it exactly where it was, and `git merge --ff-only
  origin/<branch>` against that stale ref succeeds trivially ("Already up to
  date") — the checkout is reported **clean** even though the real remote may
  be ahead. Only when no tracking ref exists yet (the first attempt to ever
  fetch this branch name) does the ff-only merge have nothing to resolve —
  `worktreeOnBranch` checks for that ref with `git rev-parse --verify --quiet`
  before attempting the merge, so this case is reported `stale` with its own
  message ("no `<remote>/<branch>` ref to catch up to") rather than the
  generic ff-only failure a true divergence gets.
- The continued worktree is `kb-<n>-<k>` with the *previous* attempt's branch
  checked out, so when the task finishes `hkb gc` removes the directory and
  deletes that local branch (`removeWorktree`, `src/gc.js`). Only the local one:
  the PR lives on the remote and a later attempt re-fetches it.

## Related

- [The last step — `dispatch.merge` and GitHub's auto-merge](./auto-merge.md)
- [hkb at a glance](../architecture/overview.md)
