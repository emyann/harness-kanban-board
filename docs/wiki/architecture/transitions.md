---
title: Transitions — the human half of a Job's lifecycle
summary: "A Job's phase moves for two reasons with two owners: the controller observes, and a person decides. The second half had no module and lived inside the CLI's switch, which is the ADR-015 test that failed. What a transition actually is, why the actor became a parameter, and what is still trapped."
category: architecture
kind: explanation
audience: [dev]
read_when: "building a second consumer, adding a verb that changes a Job's phase, or wondering why a guard lives in a module rather than beside the argument parsing"
covers:
  - path: src/transitions.ts
    sha: b7eceac893be1523b8bda846a9ed412ba8815df0
  - path: src/hkb.ts
    sha: 37b4de4b924ce76c8003ffec444982eebf3f4031
  - path: prisma/schema.prisma
    sha: deb0743051f8edc773e9c2abb60960b1bcb84b25
related:
  [
    decisions/adr-015-machinery-and-consumer,
    architecture/job-kind,
    decisions/adr-010-the-human-gate,
    architecture/the-board,
  ]
generated_at_commit: 73ac807
last_refreshed: 2026-09-07
---

# Transitions — the human half of a Job's lifecycle

> A **transition** is a Job moving between phases because a *person decided*, as opposed to the
> moves the controller makes by observing. `src/transitions.ts` holds all of them:
> `queueJob`, `triageJob`, `approveJob`, `rejectJob`, `retryJob`, `concludeJob`, `removeJob`.

## Two halves, one owner each

| moved by | which moves | where it lives |
|---|---|---|
| the **controller**, by observing | `pending → running`, `running → succeeded \| failed \| suspended \| pending`, reclaiming a dead lease | `src/controller.ts`, `nextPhase()` — a module since ADR-007 |
| a **person**, by deciding | queue, triage, approve, reject, retry, done, cancel, remove | `src/transitions.ts` — a module since this page |

The asymmetry is the whole story. The machine half got a module on day one because a controller is
obviously a thing. The human half grew one verb at a time inside `switch (verb)` in `src/hkb.ts`,
downstream of `parseArgs`, where nothing but the CLI could reach it — so `hkb` was not a consumer of
hkb, it was where half the machinery happened to be kept.

That is ADR-015's own test, stated in the record and failing at the time: *"Could a web board be
built without touching `src/hkb.ts`? No. The transition logic lives inside the CLI's `switch`."*
The record nominated `queue` and `triage` as the first two to move when next touched, and declined
to build an `ops/` layer up front (decision 5) on the grounds that the seam should fall out of
ordinary work. This is it falling out — a flat module beside `src/limits.ts` and `src/spec.ts`, not
a layer.

## A transition is not a phase write

Each one is a lookup, a set of refusals, and a group of writes that belong together. The refusals
are why it deserves a module, because they are the part a second implementation would get wrong:

- **a lease is refused by every one of them.** A lease is a worker running *right now*; concluding
  its Job out from under it leaves that worker reporting to a record which says the question was
  already settled. The message names the holder and when the lease lapses on its own, because the
  daemon is a thing the operator can stop.
- **the phase this transition starts from.** `queue` is for `triage` only, and says *"and this one
  is already queued"* when that is the reason. The gate's two ends refuse anything not `suspended`,
  because writing an approval the next reconcile ignores is worse than saying no.
- **`retry` refuses a spent budget under the same cap** — the same run, the same stopping point,
  the same bill. It distinguishes what the last attempt was *frozen at* from what the next one
  *would get*, which differ exactly when the board's default moved in between.
- **`concludeJob` refuses a Job the runtime already concluded**, and refuses to restate itself —
  but `done` and `cancelled` may restate *each other*, deliberately, because a mistyped verb is easy
  and the only other escape is deleting the Job, which is the trap the verb exists to remove. The
  correction is another Event, so the log keeps both statements in order.

## The actor is a parameter

The one deliberate change in the extraction. The verbs read `process.env.USER` and `os.hostname()`
to decide who acted; a web board's actor is a logged-in person and a daemon's is a host, and neither
is an environment variable. Every function takes `by`, and nothing in the module has an opinion
about who is calling it.

It is a small change and it is the one that actually opens the seam: a module that reads
`process.env` has quietly decided that only a CLI may call it.

## Writes are atomic, which three of them were not

`queue` and `approve` already used `$transaction`; `done`, `retry` and `rm` did the same work as
separate awaits, because they were written on different days. A phase moved without the Event that
explains it is a Job the log cannot account for — and for `approve` specifically it is worse, since
the Event *is* the approval and the next attempt would be handed the brief again instead of the
instruction (ADR-010 decision 4). All of them are transactions now.

**Two of them get a stronger guarantee than the rest, and the difference is worth knowing.**
Everywhere else the lease is read first and written after, so a daemon claiming the Job in between
is a stale read the next reconcile sorts out. For `concludeJob` and `removeJob` it is not: `Lease.job`
is `onDelete: Cascade`, so removing a Job silently deletes a lease a worker took a millisecond ago —
the exact outcome the guard exists to prevent.

Those two run inside an interactive transaction whose **first statement is a conditional write** —
`where: { id, lease: { is: null } }` — and a count of zero is the refusal. That shape was arrived at
twice over, and both wrong versions are worth recording because each looks right:

1. **Keeping the old outer check as well**, for its better message, made the inner one unreachable.
   No mutation of it failed a test, because nothing ever arrived there holding a lease — the same
   silently-inert shape this project has shipped three times.
2. **Reading the lease as the first statement inside the transaction** is correct and stalls the
   daemon. Prisma's better-sqlite3 adapter opens an interactive transaction with a deferred `BEGIN`,
   and this board runs in `journal_mode=delete`, so a *read* first takes a SHARED lock held for the
   whole transaction. Any other process writing the board in that window waits out `busy_timeout`
   and then fails `SQLITE_BUSY: database is locked` — `hkb up` running, an operator types
   `hkb done 12`, and the reconcile pass dies. Before any of this those verbs were autocommit writes
   with no read window at all.

A write first escalates SQLite to RESERVED immediately, where `busy_timeout` does its job, and the
guard becomes the write's own `WHERE` rather than a separate question. The lease is read only on the
refusal path, to say whose it is.

## What this does not move, and it matters

**Filing a Job is not here.** `hkb new` still holds `db.job.create` inside the switch, and it is a
different shape of problem: ~190 lines of it are argument parsing, template expansion and input
resolution, which is genuinely the CLI's job. What a second consumer needs from it is the small
part at the end. That extraction is a `fileJob(db, spec)` and it has not been done.

**Board operations are not here either** — `board_added`, `ceilings_set`, `board_stopped`,
`board_removed` remain in the switch. They are a different object's lifecycle, and they should move
on the same rule when they are next touched.

So the honest status of ADR-015's test: a second consumer can now *drive* a Job through its whole
life without touching `src/hkb.ts`. It cannot yet *create* one.

## How the tests changed, and what that shows

`test/transitions.test.ts` calls these directly — **no repository, no worktree, no CLI, no argv**.
That is worth noticing as evidence rather than as convenience: a transition is a decision about
board state, and its needing none of those is exactly what makes it callable by something that is
not a terminal. The existing CLI tests were not changed at all, which is the no-behaviour-change
claim checked against a suite that already exercised every one of these end to end.

One ordering detail the extraction had to learn: `queue` takes its brief as a **producer**, not a
string. `--brief -` blocks until EOF on stdin, so reading it before the guards turned
`hkb queue 999 --brief -` from an instant `no Job #999` into a process that never returned. The
guards run first and the read happens in the one place that knows they passed.
