---
title: The web board (`hkb serve`)
summary: One local server, one inline page, N repos — where the board list comes from and who maintains it, how the board is read, how a drag becomes a verb, how every request is routed to the board it names, and how the drawer draws a card's dependency subgraph from the payload it already has.
category: features
kind: explanation
audience: [dev]
read_when: "touching hkb serve, the board page, the user-level board list, or anything that has to work across more than one checkout"
covers:
  - path: src/serve.js
    sha: fe50acf9c37de567f1a90fd802e682ab746f6d50
  - path: web/index.html
    sha: 322aa96236ef37657a9a2326b83dc7b480672134
  - path: src/board.js
    sha: 5b2d5227aa6157021e68c1bd169a5019c79e6944
  - path: src/init.js
    sha: d41dc9ecf44f892d994c175ebad8565cfc0da690
  - path: src/lifecycle.js
    sha: 3d8234ec94517fa40a1fdbef460486d3bf873068
  - path: src/track.js
    sha: 054947b027ccb0313f31e5170b67b065aa9d99ed
  - path: src/model.js
    sha: a0ada59cd3061302ebe8ab640b50d690700803f7
generated_at_commit: 90132a1
last_refreshed: 2026-09-03
related: [architecture/overview, concepts/board-protocol, architecture/dispatcher-tick, features/up-and-down]
---

# The web board (`hkb serve`)

> `hkb serve` is a local HTTP server (`src/serve.js`) and one inline page
> (`web/index.html`) over the live board. It is not a mirror: every read is the
> same `fetchBoard` query the CLI runs and every write is the same lifecycle
> verb, so there is no second source of truth to drift. Since #87 one server
> holds **several boards at once** — the read side of "two repos should not cost
> two servers, two ports and two tabs".

## The surface

Seven columns, fixed: `COLUMNS` in `src/serve.js:20` and `COLS` in the page,
which a test pins to each other (`test/serve.test.js`, "the page draws the
columns the server serves"). `archived` is a verb, not a column.

Four routes, and nothing else (`parseRoute`, `src/serve.js:219-232`):

| route | what it is |
| --- | --- |
| `GET /` | the page, read off disk on every request — no build step, no bundler |
| `GET /api/board` | every board, one payload, one ETag |
| `GET \| POST /api/boards/<key>/tasks/<n>[/<verb>]` | one task on one named board |
| `GET \| POST /api/tasks/<n>[/<verb>]` | the same, unscoped — see *ambiguity* below |

There is no auth. The server binds `127.0.0.1` and `checkOrigin`
(`src/serve.js:249-263`) refuses a non-loopback `Host` (the DNS-rebinding
defence) and any cross-origin `Origin`; POST bodies must be
`application/json`, which is what stops a plain HTML form from driving it.

**Who starts and stops it.** Since #148 the server claims `.kanban/serve.pid`
once the port is bound and drops it on the way out (`claimServePid`,
`src/serve.js:122-134`), which is what makes it a process `hkb up --serve` can
start detached and `hkb down --serve` can stop. That same file is why a taken
port can be reported as *already up on that port* rather than the generic
advice — but only when it names a live process that is not this one
(`portInUse`, `src/serve.js:622-628`). The pid protocol is
[features/up-and-down](up-and-down.md).

Since #204 `claimServePid` also carries the URL: it writes `.kanban/serve.url`
to the real bound origin (`http://<host>:<port>`) once the port is actually
open, overwriting the guess `hkb up` pre-wrote from `--port` at spawn time —
the same pre-write/correct relationship the pid file already has with
`claimPid`. `processState('serve', ...)` reads it back (`src/board.js`), so
`hkb up --serve`, `hkb up --status` and `hkb doctor` all name the URL without
grepping `.kanban/logs/serve.log`.

## One server, many boards

Everything downstream of a `ctx` is scoped to one repo — `ctx.root` is a
checkout, `ctx.repo` an owner/name, `ctx.board` a `kb:board:*` slug. So holding
several boards is exactly this: hold several contexts, and route every read
and every write through the right one.

**Where the list comes from** (`serveContexts`, `src/serve.js:151-164`). The
checkout you ran in is always first. Then either `--repos <path,path>` — an
explicit flag, so a path that is not an `hkb init`ed checkout is fatal — or, with
no flag, the user-level list at `~/.config/hkb/boards.json` (`userBoardsFile` /
`loadUserBoards`, `src/board.js`), where a stale entry is a warning and a skip
so a deleted repo cannot break `hkb serve` everywhere. A `#slug` after a path
picks a board *inside* that checkout.

**How a checkout gets on the list** (`registerUserBoard`, `src/board.js:538-544`;
called once, from `registerCheckout` at `src/init.js:803-818`). Until #98 that
file had a reader and no writer, so the only way onto the page was to hand-edit
it — the one step of adoption a repo cannot tell you about from inside itself.
`hkb init` now writes it as its last step (`src/init.js:988`), which is only
defensible because of three properties:

- **Idempotent.** Equivalence is the *resolved* path plus the board slug, so
  `~/code/web` already listed and `/home/you/code/web` registered are one entry.
  The pure merge (`mergeBoardEntry`, `src/model.js`) only ever appends: an entry
  it did not add keeps its position and its spelling, so a file you maintain by
  hand survives an init verbatim. The write itself is a temp file and a `rename`
  (`saveUserBoards`, `src/board.js:500-512`) — this server reads that file while
  other commands add to it, so a half-written list must not be observable.
- **Never silent.** One line either way, naming the file: `registered this
  checkout in … — hkb serve will show it`, or `already listed in …`. That line
  *is* the disclosure that init wrote outside the repo, which is why there is no
  `--no-register` flag to suppress it.
- **Never fatal.** An unwritable config dir or a `boards.json` somebody broke is
  a warning naming the path to add by hand, and exit 0. The repo is already set
  up; the list is a convenience beside it.

A linked worktree registers its **main** checkout, never itself (`mainWorktree`,
`src/board.js:520-527`, via `git rev-parse --git-common-dir`): a worker running
in `.claude/worktrees/kb-99-1` is in a directory that will be deleted, and it has
no business on anyone's board list.

The entry init writes is a **bare path**, not `path#board`, even when init was
given `--board`: `contextForPath` reads a bare entry's slug from the checkout's
own `.kanban/board.json`, so the bare form resolves identically today and follows
a later rename — and it is the spelling a human writes, so a checkout somebody
already listed by hand registers as a no-op instead of a second card.

The filesystem is still never scanned: hkb shows the checkouts you named and no
others, and a checkout that registers itself is not an exception — running
`hkb init` in a directory *is* the act of naming it. That is the distinction that
makes automatic registration compatible with the promise.

**The list is live** (`reloadBoards`, `src/serve.js:373-395`). `serveContexts`
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

**How a board is addressed** (`keyBoards`, `src/serve.js:170-179`). Each board
gets a key of `owner~repo~slug` (`boardKey` in `src/model.js` collapses anything
outside `[A-Za-z0-9._-]` to `~`, so a key is always one safe path segment), made
unique by `uniqueKeys` if two ever collide. Two checkouts of the same repo on the
same board fold into one entry — one board, one query.

**What is per board.** Each entry owns a closure with its own cache, its own
in-flight read, its own `generation` counter and its own detail map
(`boardState`, `src/serve.js:398`). That is where the isolation actually
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

`MOVES` (`src/serve.js:32-46`) is the whole table of column-to-column moves the
protocol has a verb for; `NO_SUCH_VERB` explains the columns that can never be a
drop target (nothing but the dispatcher starts a task, nothing but `hkb complete`
reaches review or done). `moveDecision` is pure — no I/O, no GitHub — and returns
either the verb steps, the fields still needed (`block` and `request-changes`
want a reason, which the page collects in a modal before anything is written), or
a refusal with the reason. So the board can never show a state no CLI command
could have produced.

The decision is made against a **fresh** `getTask` on the card's own board, not
against the snapshot the page happens to be showing.

### Promote cascades forward, never backward (#209)

`triage>todo` and `blocked>ready` still map to the single `promote` step, but
`promote` itself (`src/lifecycle.js:430-448`) now moves a **subgraph**, not one
card: it resolves `number` plus every task still blocking it
(`resolveTrack`, `src/track.js:59`) and walks that in dependency order,
blockers first. Dragging a root with open triage blockers therefore sweeps
them along to `todo` in the same call — dropping only the root and leaving its
blockers behind would land it in `todo` with no way for the tick to ever ready
it, since the tick only promotes `todo`→`ready` once every blocker is closed
(#209's original bug).

The cascade never forces a blocker to `ready`: `promoteDecision`
(`src/model.js`, next to `computeReady`) only lets a `todo` card advance when
it is genuinely ready, and skips a `blocked` card outright rather than
guessing at the human flag that put it there. Forcing stays available, but
only for the single-card case — a card with no open blockers left resolves to
a track of one, and *that* call keeps today's behaviour: `hkb promote <n>` on
a `todo`/`blocked` leaf still forces it straight to `ready` and clears
`needsHuman`, exactly as it did before #209. `runVerb`
(`src/serve.js:497-508`) and `move` (`src/serve.js:513-527`) both accept
`promote`'s answer as a list of `{number, status, ...}` rows and pick out the
row for the dragged card to decide whether the drop landed; the rest ride
along under `moved` and are not drawn specially — **no cascade logic lives in
`serve.js`**, and no card the drag didn't request shows anything until the
next poll re-reads the board. That is the same invariant `moveDecision`
already protects: the board can never show a state no CLI command could have
produced.

There is no reverse cascade, and there is no reverse verb at all: `NO_SUCH_VERB.triage`
refuses every drop back onto Triage, and the only backwards drag,
onto `blocked`, takes a reason and touches one card. Blocking a root does not
invalidate the work already done on its children, so `block` stays
single-card by design, not by oversight.

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

## The drawer draws the subgraph (#108)

Opening a card shows its dependency subgraph as inline SVG above *Blocked by*:
the card, everything it is transitively blocked by, and everything transitively
waiting on it. It is a **rendering, not a feature of the server** — `cardOf`
already puts `blockedBy: [{number, title, done}]` on every card in `/api/board`,
so the picture costs no route, no fetch, no server change and no dependency.
`depGraph` and `graphSvg` are two pure top-level functions in the page's one
classic `<script>`, which is what lets the suite assert layers, node count and
edge count over a diamond in a vm, with no DOM.

Four decisions worth knowing:

- **Every edge between the collected nodes is drawn**, not only the ones on the
  path from the focused card. That is what turns two chains back into the diamond
  they actually are, and it is why the picture is the same opened from either end.
- **A blocker that is no card on the board is still a node.** `fetchBoard` reads
  open issues only, so a *finished* blocker is not on the board — but the cards
  that name it carry its number, title and done state, so it becomes a node from
  that stub rather than a hole where the shared dependency was.
- **Nodes reuse the column colours** (`--col`, the same custom property a card
  sets) and the existing `data-open` handler, so there is no second palette and
  no second way to open a card in the drawer.
- **Nothing is drawn** when a card has neither blockers nor anything waiting on
  it — no empty box.

Layout is longest-path layering (row 0 is what nothing in the picture waits on)
plus two barycenter ordering passes. It is honest about its limits: readable at
5–15 nodes, roughly 6.8 average crossings on random 12-node DAGs, and a cap of
40 nodes with a note saying the picture is not all of it. If it ever needs to be
prettier the answer is a vendored renderer on its own ETag'd route — never inline,
never a CDN, because the self-containment assertions are the page's only build
step. A module `<script>` is not an option either: a top-level `import` makes
`new vm.Script` throw and takes every page test with it.

**The one place the picture can be wrong, and says so.** Without GitHub's GraphQL
`blockedBy` field, `fetchBoard` REST-fills `todo`/`blocked` cards only
(`fillBlockedByRest`, applied in `fetchBoard`, `src/store/github.js`) —
widening that would be a per-task
REST call on every read, which Values 2 and 3 forbid. That leaves a fingerprint
the page can read off the payload it already has: edges exist, and *none* of them
hang off a card that is neither todo nor blocked. `edgesMayBeMissing` looks for
exactly that and the graph carries a one-line note, rather than drawing a
confidently wrong picture of what a track depended on.

## A clone is a reader, and the page is what a reader gets

On a local board the whole board travels with the repository, so "share the
board" is `git clone` — and what a clone should get is exactly this page. Which
store a clone is on needs no configuration: `storeKind` (`src/store/index.js`)
calls the board local on the presence of `kb-board` or `origin/kb-board` alone.

What a clone cannot do is write. The branch names one owning host, and every
mutating verb — including the ones the page's drag-and-drop calls — is refused
on any other with exit 2 naming `hkb init --take-over` (`assertOwningHost`,
`src/cli.js`; `assertLocalOwner`, `src/store/local.js`).

What a clone *can* do is more than "read the cards", because the guard is on the
invocation rather than the verb (`invocationWritesBoard`, `src/cli.js`). `hkb
serve` is not on the writing list at all, so a reader serves the page; `hkb up
--status` reads pid files and liveness; `hkb dispatch --dry-run` says what a
tick would decide. `hkb up --serve` is still refused, since it brings a
dispatcher up beside the server — the reader's way to serve is `hkb serve`.

> **Not reachable yet.** `src/serve.js` reads the board through `fetchBoard`
> (`src/tasks.js`, the GitHub driver's re-export), not through `openStore`, so
> serving a local board — from a clone or from the owning host — is waiting on
> the verb migration in track C of `docs/local-first.md`. The store underneath
> is done and the refusals above are live; the page is not wired to it.

## Related

- [hkb at a glance](../architecture/overview.md)
- [architecture/local-store](../architecture/local-store.md)
