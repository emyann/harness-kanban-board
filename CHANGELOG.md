# Changelog

Notable changes to hkb, newest first. See `docs/local-first.md` for the plan
this entry is part of, and `docs/wiki/` for the design detail behind it.

## Unreleased

### Local-first store (track A)

A new board now lives on this machine by default instead of on GitHub: a
`kb-board` git branch (one file per card, one run record per card, written
with plumbing so no working tree is touched) plus a `.git/hkb/index.db`
`node:sqlite` index for locks, live attempt state and the event log
`hkb watch`/`hkb serve` stream from. Every verb — `create`, `list`, `claim`,
`heartbeat`, `finish`, `block`, `request-review`, `comment`, `sync`, `serve`
— runs unchanged against either driver, chosen once by `"store"` in
`.kanban/board.json` (absent means `github`). `hkb init --import` migrates an
existing GitHub board onto the local store, keeping ids, statuses and run
records; `hkb init --store github` keeps the old behaviour. A board has one
writer, named on the branch; a clone reads the whole board with no setup and
every write is refused there, naming `hkb init --take-over` as the way to
move it.

Also in this track: the Node floor moved to 22.13 (`node:sqlite` needs no
flag past 22 with its `ExperimentalWarning` silenced at the entry point), and
the GitHub Actions runner (`templates/actions/`, `init --with-actions`, the
`claude-action` profile) was removed — pull requests, review and merge still
go through the forge (`src/forge.js`), only the store moved.

See the wiki for the design: `docs/wiki/concepts/store.md` for the concept,
`docs/wiki/architecture/store-seam.md` for the interface, and
`docs/wiki/architecture/local-store.md` for the two-tier mechanics.
