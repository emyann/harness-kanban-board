---
title: Watch — the board's event stream, followed
summary: The third question about the board, after "what is true now" and "what happened": tell me when something happens. Cursors rather than state, woken by the filesystem rather than polled, and resumable because an id never expires.
category: features
kind: explanation
audience: [dev]
read_when: "building anything that reacts to hkb — a status line, a notifier, a second controller — or wondering why the daemon still is not a subscriber"
covers:
  - path: src/watch.ts
    sha: 992b53f9dc3ef4284c2a1bf0201794490afee393
  - path: src/hkb.ts
    sha: f7cca4f068b7ccb229e6f7b87727de198f9efb6e
  - path: prisma/schema.prisma
    sha: 34921e6803578d6831938ada63d477d55a95eb6a
generated_at_commit: 6d4142a
last_refreshed: 2026-09-09
related:
  [
    architecture/the-loop,
    architecture/the-board,
    howto/running-the-daemon,
    architecture/overview,
  ]
---

# Watch — the board's event stream, followed

> `hkb ls` answers *what is true now*. `hkb log` answers *what happened up to now*. Neither answers
> *tell me when something happens*, so everything that wanted to react to hkb — a status line, a
> notifier, a second controller, a person watching a long run — had to poll one of them on a timer
> and diff the result. That is a caller re-deriving a stream the board already keeps.

## Cursors, not state

The stream is the `Event` table, and what makes it a stream rather than a log is that **every line
carries the id it was read at** (`eventLine`, `src/watch.ts`).

```
$ hkb watch
watching repo from event 1 for 25s — ctrl-c to stop
     4  2026-09-06T20:43:03.760Z  #1    claimed        YRND1-GG/26353@fake  {"k":1}
     5  2026-09-06T20:43:03.780Z  #1    completed      YRND1-GG/26353@fake  {"k":1,"phase":"succeeded"}
    12  2026-09-06T20:43:23.015Z  —     ceilings_set   YRND1-GG/26596@cli   {"maxConcurrent":3}
stopped at event 12 — resume with `hkb watch --after 12`
```

A consumer that dies comes back with `--after 12` and misses nothing — including anything written
while it was away, which is exactly what a poller loses. Nothing here ever emits *the current state
of Job #5*; it emits *event 5 says #5 completed*, and what the Job looks like now is `hkb show`'s
question. That is Kubernetes' `resourceVersion` split, and it is the property that makes a watcher
restartable rather than merely reconnectable.

**The cursor never expires**, which is the one way this is simpler than `resourceVersion`. Events are
append-only and their ids monotonic, so a consumer that was away for a week replays rather than being
told to start over — and there is therefore no bookmark event, because nothing needs to keep a
client's cursor fresh while the board is quiet.

Where to join is a decision the verb makes explicitly. The default is the **end** of the stream: a
watch is about what happens next, and replaying a month of history because somebody typed `hkb watch`
would bury it. `--after <id>` resumes exactly; `--since <dur>` starts from a moment; giving both is
refused, because they answer the same question differently and picking one silently would make the
same command line join in two places depending on flag order (`src/hkb.ts`).

## Why `id > cursor` is a complete read here

With an autoincrement key this is normally *not* safe: a transaction that took id 10 can commit after
one that took 11, and a reader that has advanced past 11 never sees 10. SQLite cannot do that —
there is one writer at a time, file-wide, so a row with a lower id always commits first.

The naive cursor is correct **because of the storage engine, not because of the query**. That is
worth knowing before this is pointed at anything else; on Postgres the same code would silently drop
events under concurrency.

## Woken, not polled

CLAUDE.md value 3 rules out polling loops inside commands, and a `hkb watch` on a quiet board should
cost nothing. So the loop is woken by `fs.watch` on the board's directory — a commit touches the
database file, which is a change the OS will report — and the timer underneath is a **fallback**
rather than the mechanism (`WATCH_FALLBACK_MS`, `src/watch.ts`).

That is the same shape as the controller itself, one layer out: a change is a *hint* that something
is worth re-reading, never the thing that is acted on. A filesystem that cannot report changes (no
inotify, a bind mount, a network share) makes the watch **later, never wrong**.

Both halves are pinned by tests, which matters because an optimisation nobody measures is one that
can stop working silently: one test points the watcher at a directory the board is not in and proves
the fallback alone delivers everything, and another sets the fallback 30 seconds away and requires
the event to arrive in under two (`test/watch.test.ts`). Measured on Linux: **5–14 ms** from commit to
emitted line.

## What it is not

- **Not a subscription for the controller.** `hkb up` is still a resync loop that reads desired state
  and takes a step; nothing in the controller depends on having seen an event, and this verb changes
  none of that (`architecture/the-loop`). The stream is for the world *outside* hkb.
- **Not the inbound direction.** Something arriving from outside and asking hkb to do work is a
  different problem with a different authorisation model, and it is still parked.
- **Not a state feed.** A consumer that wants to know what a Job looks like now reads the board. The
  stream tells it *when* to.

## For a machine

`--json` streams **one event per line** — NDJSON, not one object at the end, because a stream you
have to wait for the end of is a list. The header and the closing cursor go to **stderr**, which is
what lets `hkb watch --json | jq` be exactly the events and nothing else.

`-n <count>` and `--timeout <s>` both bound a watch, which is what makes it usable in a script that
waits for one thing rather than follows for ever.

## Related

- [the-loop](../architecture/the-loop.md) — why the controller is not a subscriber
- [the-board](../architecture/the-board.md) — the `Event` table this reads
