# Project status and verified behaviour

Where hkb actually is, what has been checked against a live GitHub repository, and how it is exercised day to
day. The README describes what hkb does for you; this page is the evidence behind it.

## Status: MVP

Everything in the README works and is exercised, but the surface is young: version `0.1.0`, one maintainer, and
GitHub as the only backend. Treat the CLI's flags as stable and the internals as not.

Verified so far:

- **Unit tests** over the pure model — status transitions, lock classification, dependency promotion, arg
  parsing, date and duration handling. Over four hundred of them, run on every push and pull request
  ([`.github/workflows/test.yml`](../.github/workflows/test.yml)) under two timezones, `UTC` and
  `America/New_York`, because a date test that only holds in one of them is a flake waiting for a bad day.
- **CLI wiring** — every verb reaches the function it claims to.
- **The published tarball** — the same workflow packs hkb, installs the tarball into an empty directory and
  runs the CLI from there, so a `files` list that stops shipping `skills/` or `templates/` fails CI instead of
  failing a stranger's first `npx hkb init`. After a release, [`release.yml`](../.github/workflows/release.yml)
  repeats the check against the copy npm actually served. See [Releasing](releasing.md).
- **`hkb doctor --api` against this repository** (2026-08-26), which probes the GitHub behaviour the design
  depends on rather than trusting the docs. Those probes are below.

Run `hkb doctor --api` on your own repo before the first dispatch; it re-checks all of it, on your account, with
your token, and names the fix for anything that fails.

## The API facts the design leans on

Each of these was observed against a real repository, not read off a changelog. They are the load-bearing ones:
if any changed, hkb would be wrong rather than merely slower.

**A duplicate ref create returns `422 Reference already exists`, not `409`.** This is the atomic claim: two
dispatchers racing for task #42 both `POST git/refs` for `refs/kb/locks/42/1`, and exactly one gets `201`. The
loser must be able to tell "someone else holds this" from "GitHub is having a bad day", because the first means
*skip this task* and the second means *back off and retry*. `src/lock.js` therefore treats both 422 and 409 as
`held` and everything else as transient.

**`--force-with-lease` on a lock ref rejects both a moved ref and a deleted one**, in both cases with
`(stale info)` in the output. That is what makes the heartbeat free: a worker proves it is alive by pushing an
empty commit onto its own lock ref with the lease set to what it last saw, which costs no API call and no rate
limit. A rejected lease is unambiguous — the lock was reclaimed — and hkb exits `3` (`LOCK_LOST`) so the worker
stops before it commits anything.

**`GET git/commits/<sha>` returns the committer date**, which is how the dispatcher ages a lock without writing
anything: the beat's date is the last time the worker was demonstrably alive, compared against the task's
`stale_after`. Round-tripped on this repository on 2026-08-26.

**The GraphQL fields exist**: `Issue.blockedBy`, `Issue.blocking`, `Issue.subIssues` and
`Issue.closedByPullRequestsReferences`. These are the whole graph — one query per board per tick reads every
task, its blockers and the PR that will close it.

**REST `GET /issues/{n}/dependencies/blocked_by` works with `X-GitHub-Api-Version: 2026-03-10`.** The version
header is pinned in `src/gh.js` so a server-side default bump cannot silently change the shape of a response.

## How it is exercised

hkb runs its own board. The issues in this repository carry `kb:*` labels, the dependency graph between them is
what the dispatcher promotes, and the features described in the README were built by workers that claimed those
issues, opened `Closes #<n>` draft PRs and ended with a terminal verb — including the multi-node
[tracks](../skills/kanban/references/protocol.md#tracks--the-second-execution-engine), which were first run on
this repo's own decomposed work.

That is a genuine test and a genuine bias. It means every path in the README has been walked end to end on at
least one real repository; it also means the shape of *this* repository — a small Node CLI, one maintainer,
GitHub-hosted — is the shape hkb has the most evidence for. A large monorepo with heavy branch protection and a
dozen concurrent workers is a case the design accounts for (`kb.paths`, `max_in_progress`, per-profile
dispatch) but has less mileage on.

## What is not proven yet

- **Backends other than GitHub.** The protocol is deliberately backend-neutral — statuses, claims, attempts and
  handoff say nothing about GitHub, and every GitHub-ism is behind `gh.js` / `tasks.js` / `lock.js` — but no
  second backend exists, so "portable" is a property of the design, not yet a demonstrated fact.
- **Scale.** Boards here have been tens of tasks, not hundreds. The one-query-per-tick read holds by
  construction; the write volume during a busy reconcile has not been stress-tested.
- **Harness parity.** Claude Code has the most mileage by a wide margin. Copilot CLI and Codex CLI implement the
  same protocol and are checked by `hkb doctor`, but they have run far fewer real tasks.
