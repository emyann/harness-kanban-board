# Findings inbox

One line per suspected code defect, awaiting triage. Not a tracker: every item leaves through one of
four exits — fixed now, promoted into the page that owns it, filed in the issue tracker, or dismissed
with a reason — and the departure gets a `log.md` line. Treat every item as a **claim to re-verify**,
not a fact. Grammar and the triage rules are in `AGENTS.md`.

- [bug] **Two boards on one repository collide on the attempt's worktree name** — `branchFor` derives `kb-<jobId>-<k>` from the Job id alone, and job ids are unique only per database, so a second board reached through `HKB_DATABASE_URL` (which the test suite is) cuts `git worktree add -B kb-1-1` over the first board's live worktree and the attempt is recorded `crashed`. Evidence `src/worktree.ts:74-105` <!-- repolore:sha=8cba275 captured=2026-09-05 --> → howto/running-the-daemon
- [bug] **`hkb up --status` reports spend the gate does not judge against, so a board can be refused on budget while its status line shows headroom** — `status()` sums only `Attempt.costUsd` inside the window and omits the committed-in-flight term, while `gateClaim` charges `spent24h + committedUsd + jobBudgetUsd`; a board at `$0.40 of $5.00 spent in 24h` with $4.00 committed to live runs refuses the next claim with a message naming a number the status line never showed. The code intends otherwise — *"a status that disagreed with the refusal it is meant to explain would be worse than not printing it"* — and got the window right while leaving out an addend. Evidence `src/daemon.ts:177-184,203-217` <!-- repolore:sha=1146651 captured=2026-09-06 --> → concepts/ceilings
