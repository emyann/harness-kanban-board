---
title: Carrying gitignored files into a worktree (`.worktreeinclude`)
summary: A worktree is a fresh checkout, so the `.env` the tests need is not in it — a repository declares what to carry across, git answers both halves of the match rule, and no pattern may reach the board.
category: features
kind: explanation
audience: [dev, ops]
read_when: "a worker fails on a repository whose tests pass locally, or you are touching the copy step or the board guard in src/worktree.ts"
covers:
  - path: src/worktree.ts
    sha: c2952d1d9be9885c198bef296e3bfc92208fca8a
related: [architecture/job-kind, concepts/admission-control]
generated_at_commit: 3a5e8cf
last_refreshed: 2026-09-05
---

# Carrying gitignored files into a worktree (`.worktreeinclude`)

> Every attempt runs in its own checkout (`src/worktree.ts`), and a checkout is
> of a *commit*. Nothing gitignored is in it. So a repository whose test suite
> needs a `.env` passes for the human and fails for the worker — and it fails
> as a broken build, a missing key, a suite that will not start, none of which
> point at the real cause. The repository may now say what it needs carried.

## The declaration

`.worktreeinclude` at the repository root, in `.gitignore` syntax. This is
[Claude Code's file, name and semantics](https://code.claude.com/docs/en/worktrees#copy-gitignored-files-into-worktrees)
on purpose: an operator who already writes one for `claude --worktree` should
not have to learn a second spelling for the same idea.

```text
.env
.env.local
config/secrets.json
```

A file is carried in only if it **matches a pattern and is itself gitignored**.
That second half is the whole safety of it: a tracked file is never duplicated
into the checkout that already contains it, so a pattern can never smuggle the
operator's uncommitted edits into a worker's tree.

## Both halves are asked of git

`includedFiles` (`src/worktree.ts`) never parses a pattern. It runs
`git ls-files --others --ignored` twice and intersects:

- `--exclude-from=.worktreeinclude` — the untracked files the declaration matches.
- `--exclude-standard` — the files git already considers ignored.

`--others` is what makes a tracked file impossible in either list. A second
`.gitignore` matcher living in this repository would be a second set of bugs,
and this one is the matcher the patterns were written against.

Two consequences worth knowing:

- A globstar pattern reaches inside a wholly-ignored directory here. Claude
  Code's own matcher has a documented restriction there; git has none, so an
  operator does not need to know a matcher quirk to write a working pattern.
- The second `ls-files` is narrowed to the paths the first one named, with
  `:(literal)` pathspecs. `.kanban/worktrees/` is itself gitignored, so an
  unbounded listing would walk every earlier attempt's checkout —
  `node_modules` and all — to answer a question about three files.

## The board is not carriable, however the pattern is written

`.kanban/` holds `board.db`, its WAL, the daemon's pid files, and the
worktrees. The controller owns every store write; a worker holding a copy would
read state that stops being true the moment the controller moves, and write
into a file nothing ever reads back.

So `refuseTheBoard` (`src/worktree.ts`) **refuses** — it does not quietly drop
the offending path. A pattern broad enough to catch `board.db` (`*.db`,
`.kanban/**`, a bare globstar) is a pattern whose author did not mean what they
wrote, and silently obeying the rest of it hides that. The check is on the
resolved paths rather than the pattern text, which is why it holds however the
pattern is spelled; `test/worktree.test.ts` runs four spellings through it and
requires each to throw.

The refusal is raised *before* `git worktree add`, so a bad declaration leaves
no half-made checkout behind, and the message names the file it refused and the
narrowing that fixes it (exit code 2, the usage/state code).

## Creation only, never resume

`createWorktree` copies; the early return for an existing directory does not.
A resumed attempt lands in a tree its session has been living in, and
re-copying would overwrite whatever that session did to its own `.env`. For the
same reason a destination that already exists is left alone during the copy:
nothing gitignored can be in a fresh checkout, so a collision means the base
commit tracks that path.

## For ops

- Nothing changes for a repository without a `.worktreeinclude`; the file is
  optional and its absence is a no-op.
- If an attempt dies at creation with a message about `.kanban/`, the fix is in
  your `.worktreeinclude`, not in the board: name the directory you meant
  (`config/secrets.json`) rather than a pattern that sweeps the tree.
- A secret listed here is copied into every attempt's checkout under
  `.kanban/worktrees/`. That is the point, and it is also the blast radius —
  declare the files the tests need, not the whole of `~/.config`.

## Related

- [The Job kind and its controller](../architecture/job-kind.md)
- [Admission control — an instruction is not an invariant](../concepts/admission-control.md)
