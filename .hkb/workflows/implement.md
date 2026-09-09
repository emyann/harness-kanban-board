---
name: implement
description: the finishing steps for work on this repository
guide: CLAUDE.md
label: [workflow=implement]

# No `input: [base=self:base]`, though `self:base` is exactly the ref the step below wants. A board's
# default workflow reaches EVERY Job filed by hand, including a `--no-isolate` one that has no
# checkout of its own — and an input a Job cannot resolve fails the attempt before it starts. A
# workflow used with `--from`, on a Job that is known to have a branch, is where that declaration
# belongs. Here the base is named the way the worker already knows it: the ref it was told to rebase
# onto.
---

When the work is done and committed on your branch:

- Push it: `git push -u origin <branch>`.
- Open a **draft** pull request from it against your base — the ref you were told to rebase onto.
  Never the repository's default branch when your base is not it: your diff would carry the commits
  you were built on, and merging it would merge somebody else's unreviewed work into the trunk.
- A human reviews and merges. Never merge it yourself.
- Reply with one line: what you did, and the pull request's URL.

If you could not finish, push what you have and open the draft pull request anyway, saying plainly
what is unfinished. Work that is only in a worktree is work nobody can read.
