---
title: The last step — `dispatch.merge` and GitHub's auto-merge
summary: Why hkb never merges, how a board hands the last step to GitHub instead, and the branch-protection gate that is the only thing making that safe.
category: features
kind: explanation
audience: [dev, ops]
read_when: "touching dispatch.merge, the auto-merge pass in the tick, the doctor merge check, or anything about who lands an agent's PR"
covers:
  - path: src/model.js
    sha: 1ee3e8e45a93fe97ad198cda8c74e3b0cc2ba13f
  - path: src/dispatch.js
    sha: 159ba13573ea1d691b03d195363403c60b7c15ea
  - path: src/doctor.js
    sha: 2b963d7d84437279c9561acb8746d3d9f2cb34bd
  - path: src/tasks.js
    sha: 373dd83d0ba4c554ebf5c70c01ba27676db61b8a
  - path: src/board.js
    sha: d231efaf79725e04b101d334c738924ec932506b
related: [architecture/overview, decisions/adr-004-roles-and-adoption, architecture/dispatcher-tick]
generated_at_commit: 876b9ee
last_refreshed: 2026-08-27
---

# The last step — `dispatch.merge` and GitHub's auto-merge

> hkb does not merge, and never has. What #89 added is a board-level choice
> about who does: keep the last step (the default), or hand it to **GitHub's
> own auto-merge**. The dispatcher enables that once per PR and walks away —
> it never merges anything itself, and neither does a worker.

## Why this is a policy and not a feature

Every PR this board has produced was merged by hand. On a repo where the
operator merges each agent PR within a minute of it opening, that click is a
rote step the tool could take — value 4 (*frictionless*) calls that a gap, not
a workflow. On a repo with a careful review culture it is the opposite: the one
gate anybody would want to keep. Neither answer is right for both, so it lives
in `.kanban/board.json` beside the other dispatcher knobs and defaults to
today's behaviour (`DEFAULT_BOARD.dispatch.merge`, `src/board.js`):

```jsonc
"dispatch": { "merge": { "mode": "manual" } }                   // default
"dispatch": { "merge": { "mode": "auto", "method": "squash" } } // squash | merge | rebase
```

`mergePolicy()` (`src/model.js`) is the only reader of that key, and it
**never throws**: a mode or method hkb cannot parse leaves `auto: false` and
sets `error`, so an unreadable policy behaves exactly like `manual` while
doctor still fails on it. A policy that cannot be understood must not be able
to take out every command that loads board.json, and must never be guessed
*towards* merging.

## Why GitHub does the merging, not hkb

The tick sends one `enablePullRequestAutoMerge` per PR
(`enableAutoMerge`, `src/tasks.js`) and nothing else. Three consequences, and
each is a reason:

- **Frugal.** One mutation at review time. No polling, no timer, no new query:
  the PR node id and `autoMergeRequest` both ride the board query the tick
  already runs (`ISSUE_FIELDS`, `src/tasks.js`), so "is it already enabled" is
  free and enabling is once per PR, not once per tick.
- **GitHub enforces the gates.** Required checks, required reviews, up-to-date
  branches. hkb never has to answer "is this safe to merge" — a question a
  dispatcher with no LLM in it has no business answering.
- **It degrades correctly.** A failing check or an unanswered review request
  means the PR simply does not merge. There is no state to reconcile, because
  hkb is not holding any.

**The dispatcher enables it, never the worker.** Merge authority is an operator
concern; ADR-004 puts the worker seat at one attempt on one task, and the
permission policy already keeps workers away from anything with blast radius.

## The gate is the feature

The load-bearing fact, and the reason #89 was blocked behind #84:

> **Auto-merge on an unprotected branch merges immediately.**

With nothing required, "hand the last step to GitHub" means "land
agent-authored code on `main` the moment the PR opens, unreviewed and
untested". So the refusal ships in the same change as the capability:

- `mergeGate()` (`src/model.js`) answers yes only when the base branch requires
  a status check **or** an approving review. A branch that is protected but
  requires neither is a refusal; so is one whose protection the token cannot
  read, because *a gate that cannot be verified is not a gate*.
- `checkMergePolicy()` (`src/doctor.js`) makes that a **hard failure** — `hkb
  doctor` exits non-zero — never a warning. It is silent on a `manual` board.
- The tick refuses card by card and logs the fix (`autoMergePass`,
  `src/dispatch.js`), rather than enabling something it cannot vouch for.

Protection is read from **two** mechanisms, cheapest first, because a repo may
use either (`branchProtection`, `src/tasks.js`): classic branch protection
(`/branches/<b>/protection`, admin-only, 404 when there is none) and rulesets
(`/rules/branches/<b>`, readable without admin). A 403 on the first with no
ruleset behind it is `known: false` — *unreadable*, which the gate treats as no
gate, never as "unprotected" and never as "fine".

The read costs at most two requests, happens only when there is actually a PR
to enable, and is memoised per base branch for the tick (`ctx._cache.mergeGate`).
A `manual` board never reaches any of it.

The gate is checked on the branch **the PR targets** (`baseRefName`, added to
the board query in the same change), not on the repo's default branch. That is
what keeps a stacked PR honest: a track's node PR is based on the previous
node's branch (`trackContext`, `src/track.js`), which nothing protects, so it
is refused and left to the operator rather than auto-landed into a feature
branch nobody gated.

## Where it sits in the tick

After the claim loop and before the Projects mirror. That ordering is
deliberate: `setStatus` mutates the task objects in place, so a card the
`active_pr` guard moved to *review* earlier in the same tick is handed over
immediately rather than one tick later.

The pass also declines to ask GitHub for things it is known to refuse — a draft
PR, a closed one, a PR that already carries an auto-merge request
(`autoMergeDecision`, `src/model.js`). Workers open drafts, but every terminal
verb takes the PR out of draft before the card reaches review
(`finishPr`, `src/lifecycle.js`), so by review time there is a real PR to hand
over.

## For ops

- Turn it on with `"dispatch": {"merge": {"mode": "auto"}}` and run `hkb
  doctor` — it is the check that tells you whether the branch can hold a merge
  at all, and it fails rather than warns.
- `hkb dispatch --json` reports the pass under `auto_merge`: one entry per card
  it enabled or refused, with `why` and `fix` on the refusals.
  `hkb dispatch --dry-run` enables nothing and prints what it would have done.
- **`request-review --reviewer <user>` requests a review; it does not require
  one.** Auto-merge waits for what the *branch* requires, so on a
  checks-only branch a PR lands when the checks pass whether or not the
  reviewer looked. Require approving reviews on the branch to make the reviewer
  the gate; doctor's passing line says which of the two you have.
- If enabling fails every tick with GitHub's "Auto merge is not allowed for
  this repository", the repo setting is off: Settings → General → Pull
  Requests → Allow auto-merge. Doctor checks that too, once the gate passes.

## Related

- [ADR-004: Three seats](../decisions/adr-004-roles-and-adoption.md) — why merge authority is the operator's, not the worker's
- [hkb at a glance](../architecture/overview.md)
