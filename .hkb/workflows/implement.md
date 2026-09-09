---
name: implement
description: the finishing steps for work on this repository
guide: CLAUDE.md
label: [workflow=implement]

# No `input: [base=self:base]`, though `self:base` is exactly the ref the step below wants. A board's
# default workflow reaches EVERY Job on the board, and an input a Job cannot resolve fails the
# attempt before it starts — so a declaration here would be one more thing to keep true of every
# Job rather than of this step. A workflow used with `--from`, on a Job that is known to have a
# branch, is where that declaration belongs. Here the base is named the way the worker already has
# it: the sandbox contract states it, on every attempt, resumed or not.
---

Your branch is pushed, so the work is visible. What is left is the review:

- Open a **draft** pull request from your branch against your base — the ref the sandbox contract
  named, which is not always the repository's default branch. A pull request opened against the
  default branch when your base is not it carries the commits you were built on into your own diff,
  and merging it would merge somebody else's unreviewed work into the trunk.
  `gh pr create --draft --base <your base> --head <your branch> --title "…" --body "…"`
- A human reviews and merges. Never merge it yourself.
- Reply with one line: what you did, and the pull request's URL.

If you could not finish, open the draft pull request anyway, saying plainly what is unfinished. Work
that is only in a worktree is work nobody can read.
