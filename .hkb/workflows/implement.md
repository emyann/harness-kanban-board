---
name: implement
description: the finishing steps for work on this repository — the whole git protocol lives here now
guide: CLAUDE.md
label: [workflow=implement]

# **This file grew, and that is ADR-018 landing.** The core used to tell every isolated worker to
# commit on its branch, rebase onto its base and push — the "sandbox contract" — because the
# machinery read pushed state afterwards. It does not any more: no rebase, no forge read, no
# `pre-push` hook, no `Job.base`. So the steps that were the core's are content, and content is
# here.
#
# No `input: [base=self:base]`, and now there is nothing to declare: `self:base` no longer exists
# either. A workspace is cut from the repository's default branch, always, which is exactly what
# `gh pr create` defaults to — so the `--base` this step used to pass is not merely unavailable, it
# is unnecessary. That is the deletion paying for itself.
---

The work is in your workspace and nobody else can see it. These are the steps that make it
reviewable, and every one of them is yours to run — hkb does none of them for you:

- **Commit what you have**, on the branch you are already on. Uncommitted work is invisible to
  everything downstream; a workspace is not a deliverable.
- **Rebase onto the trunk** before you finish, so what is reviewed is what would land:
  `git fetch origin && git rebase origin/HEAD`. If it will not replay, stop and say so plainly
  rather than forcing it — a conflict is a fact somebody needs to know, not an obstacle.
- **Push your branch**: `git push -u origin HEAD`.
- **Open a draft pull request**: `gh pr create --draft --title "…" --body "…"`. It opens against the
  repository's default branch, which is what your workspace was cut from.
- A human reviews and merges. **Never merge it yourself.**
- Reply with one line: what you did, and the pull request's URL.

If you could not finish, open the draft pull request anyway, saying plainly what is unfinished. Work
that is only in a workspace is work nobody can read — and the workspace is collected after its TTL.
