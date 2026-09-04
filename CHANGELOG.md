# Changelog

Notable changes to hkb, newest first. See `docs/local-first.md` for the plan
this entry is part of, and `docs/wiki/` for the design detail behind it.

## Unreleased

### Local-first store (track A)

A new board now lives on this machine by default instead of on GitHub: a
`refs/kb/boards/<name>` git ref (one file per card, one run record per card,
written with plumbing so no working tree is touched) plus a `.git/hkb/index.db`
`node:sqlite` index for locks, live attempt state and the event log
`hkb watch`/`hkb serve` stream from. Every verb — `create`, `list`, `claim`,
`heartbeat`, `finish`, `block`, `request-review`, `comment`, `sync`, `serve`
— runs unchanged against either driver, chosen once by `"store"` in
`.kanban/board.json` (absent means `github`). `hkb init --import` migrates an
existing GitHub board onto the local store, keeping ids, statuses and run
records; `hkb init --store github` keeps the old behaviour. A board has one
writer, named on the board; a clone restores it with `hkb sync` and reads the
whole board, and every write is refused there until `hkb init --take-over`
moves the board to that host.

The board is a git **ref**, not a branch: it never appears in `git branch`, in
a branch picker or in GitHub's branch list. The cost of that is that a default
`git clone` does not carry it, so `hkb init` appends
`+refs/kb/boards/*:refs/kb/remotes/<remote>/boards/*` to `remote.<name>.fetch`
(never replacing the `+refs/heads/*` line), `hkb doctor` reports the refspec
when it is missing, and `hkb sync` names it on the command line so restoring a
board onto a new machine stays `git clone` then `hkb sync`. Two boards in one
repository (`--board alpha`, `--board beta`) now get two refs, where they used
to share one branch.

Also in this track: the Node floor moved to 22.13 (`node:sqlite` needs no
flag past 22 with its `ExperimentalWarning` silenced at the entry point), and
the GitHub Actions runner (`templates/actions/`, `init --with-actions`, the
`claude-action` profile) was removed — pull requests, review and merge still
go through the forge (`src/forge.js`), only the store moved.

See the wiki for the design: `docs/wiki/concepts/store.md` for the concept,
`docs/wiki/architecture/store-seam.md` for the interface, and
`docs/wiki/architecture/local-store.md` for the two-tier mechanics, and
`docs/wiki/architecture/board-ref.md` for the board's ref and what living
outside `refs/heads` costs and buys.
