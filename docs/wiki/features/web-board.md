---
title: The web board (`hkb serve`)
summary: One local server, one inline page, N repos — how the board is read, how a drag becomes a verb, and how every request is routed to the board it names.
category: features
kind: explanation
audience: [dev]
read_when: "touching hkb serve, the board page, or anything that has to work across more than one checkout"
covers:
  - path: src/serve.js
    sha: 2008378241ae5a4bed69c2343ef1fbced525cc93
  - path: web/index.html
    sha: ece8530c9344246187f1194e03b3fc23c88967fb
generated_at_commit: 2f3f11d
last_refreshed: 2026-08-27
related: [architecture/overview, concepts/board-protocol, architecture/dispatcher-tick]
---

# The web board (`hkb serve`)

> `hkb serve` is a local HTTP server (`src/serve.js`) and one inline page
> (`web/index.html`) over the live board. It is not a mirror: every read is the
> same `fetchBoard` query the CLI runs and every write is the same lifecycle
> verb, so there is no second source of truth to drift. Since #87 one server
> holds **several boards at once** — the read side of "two repos should not cost
> two servers, two ports and two tabs".

## The surface

Seven columns, fixed: `COLUMNS` in `src/serve.js:21` and `COLS` in the page,
which a test pins to each other (`test/serve.test.js`, "the page draws the
columns the server serves"). `archived` is a verb, not a column.

Four routes, and nothing else (`parseRoute`, `src/serve.js:196-209`):

| route | what it is |
| --- | --- |
| `GET /` | the page, read off disk on every request — no build step, no bundler |
| `GET /api/board` | every board, one payload, one ETag |
| `GET \| POST /api/boards/<key>/tasks/<n>[/<verb>]` | one task on one named board |
| `GET \| POST /api/tasks/<n>[/<verb>]` | the same, unscoped — see *ambiguity* below |

There is no auth. The server binds `127.0.0.1` and `checkOrigin`
(`src/serve.js:226-240`) refuses a non-loopback `Host` (the DNS-rebinding
defence) and any cross-origin `Origin`; POST bodies must be
`application/json`, which is what stops a plain HTML form from driving it.

## One server, many boards

Everything downstream of a `ctx` is scoped to one repo — `ctx.root` is a
checkout, `ctx.repo` an owner/name, `ctx.board` a `kb:board:*` slug. So holding
several boards is exactly this: hold several contexts, and route every read
and every write through the right one.

**Where the list comes from** (`serveContexts`, `src/serve.js:128-141`). The
checkout you ran in is always first. Then either `--repos <path,path>` — an
explicit flag, so a path that is not an `hkb init`ed checkout is fatal — or, with
no flag, the user-level list at `~/.config/hkb/boards.json` (`userBoardsFile` /
`loadUserBoards`, `src/board.js`), where a stale entry is a warning and a skip
so a deleted repo cannot break `hkb serve` everywhere. A `#slug` after a path
picks a board *inside* that checkout. The filesystem is never scanned: hkb shows
the checkouts you named and no others.

**The list is live** (`reloadBoards`, `src/serve.js:350-372`). `serveContexts`
runs again at most once per poll interval, driven by the requests the page
already makes — no timer, and nothing re-read while nobody is watching. It costs
no GitHub call: `loadUserBoards` is a local file read. A board that appeared is
added and addressable on that same request; one that left the list stops being
served and its cache goes with it. A board still in the list keeps its *state
object* — cached cards, `generation` counter, detail map — so a reload never
blanks a working board and never refetches one; that is the whole difference
between this and a restart. `--repos` is an explicit set typed for one run and
never reloads. Both failure modes are reported once, not once per poll: a stale
entry's `skipping …` line, and a `boards.json` that stops parsing (which keeps
the boards the server already holds).

**How a board is addressed** (`keyBoards`, `src/serve.js:147-156`). Each board
gets a key of `owner~repo~slug` (`boardKey` in `src/model.js` collapses anything
outside `[A-Za-z0-9._-]` to `~`, so a key is always one safe path segment), made
unique by `uniqueKeys` if two ever collide. Two checkouts of the same repo on the
same board fold into one entry — one board, one query.

**What is per board.** Each entry owns a closure with its own cache, its own
in-flight read, its own `generation` counter and its own detail map
(`boardState`, `src/serve.js:375`). That is where the isolation actually
lives: `dispatcherState(b.ctx.root)` reads *that* checkout's
`.kanban/dispatch.pid`, `logPathFor(b.ctx.root, …)` resolves *that* checkout's
`.kanban/logs`, and a verb runs `spec.run(d, b.ctx, n, body)` against *that*
repo. A write invalidates one board's cache, not the page's.

**Ambiguity is refused, never guessed** (`boardFor`). An unscoped
`/api/tasks/12/promote` resolves to the only board when there is one — which is
what keeps single-repo use and any script over it working unchanged — and is a
400 naming the keys when there are more, because `#12` on two boards is two
different tasks. An unknown key is a 404 that lists the keys there are.

## Frugality

One `fetchBoard` — one GraphQL query — per board per poll interval, shared by
every open tab: N tabs still cost N boards' worth of reads, not N×tabs. The
snapshot TTL is derived from `--poll` (`ttlMs`), and the page's poll is a
conditional GET: `boardEtag` hashes the boards payload with `fetched_at`
deliberately left out (it changes every tick and would bust the ETag on an
unchanged board), so a quiet board answers 304 with no body.

A board whose read throws does not fail the page. Its snapshot keeps the last
good cards, carries `error` (and `stale`), and is cached like a success so a
broken repo is not retried on every request; the page shows a strip naming it
and renders every other board normally.

## A drag is a verb

`MOVES` (`src/serve.js:33-46`) is the whole table of column-to-column moves the
protocol has a verb for; `NO_SUCH_VERB` explains the columns that can never be a
drop target (nothing but the dispatcher starts a task, nothing but `hkb complete`
reaches review or done). `moveDecision` is pure — no I/O, no GitHub — and returns
either the verb steps, the fields still needed (`block` and `request-changes`
want a reason, which the page collects in a modal before anything is written), or
a refusal with the reason. So the board can never show a state no CLI command
could have produced.

The decision is made against a **fresh** `getTask` on the card's own board, not
against the snapshot the page happens to be showing.

On the page, the board key travels with the card: `data-card="<key>#<n>"`, the
same string goes into `dataTransfer` on `dragstart`, and the column's `drop`
handler parses it back rather than assuming "the" board. Every follow-up — the
drawer, its verb buttons, the log tail, an issue reference inside a body — is
addressed by that key. `test/serve.test.js` replays a real dragstart/drop pair
through a fake DOM and asserts the POST went to the dragged card's board and
that the other repo was never touched.

## The page

One file, one inline `<script>`, no build step, no CDN, no external asset —
asserted, because nothing else stands between a typo and a blank board. Issue
bodies go through `mdLite`, which escapes first and only then linkifies, so a
body can never inject markup.

With one board the page looks exactly as it always did. With more, a board bar
appears under the header: one chip per board with its own dispatcher dot and card
count, click to narrow the page to it, and every card grows a chip naming its
repo. The seven columns are shared; boards cluster within them in list order.

## Related

- [hkb at a glance](../architecture/overview.md)
