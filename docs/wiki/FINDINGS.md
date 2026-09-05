# Findings inbox

One line per suspected code defect, awaiting triage. Not a tracker: every item leaves through one of
four exits — fixed now, promoted into the page that owns it, filed in the issue tracker, or dismissed
with a reason — and the departure gets a `log.md` line. Treat every item as a **claim to re-verify**,
not a fact. Grammar and the triage rules are in `AGENTS.md`.

- [bug] **Two boards on one repository collide on the attempt's worktree name** — `branchFor` derives `kb-<jobId>-<k>` from the Job id alone, and job ids are unique only per database, so a second board reached through `HKB_DATABASE_URL` (which the test suite is) cuts `git worktree add -B kb-1-1` over the first board's live worktree and the attempt is recorded `crashed`. Evidence `src/worktree.ts:74-105` <!-- repolore:sha=8cba275 captured=2026-09-05 --> → howto/running-the-daemon
