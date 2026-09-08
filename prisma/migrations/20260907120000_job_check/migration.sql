-- `check` — the exit code hkb does not have (ADR-016 §3).
--
-- A Kubernetes Job is complete when its container exits 0. hkb's container is an agent session and
-- it always finishes successfully, so hkb has no exit code: ADR-008's declared outputs reconstruct
-- one for FILES, and this reconstructs one for BEHAVIOUR — a shell command run in the attempt's
-- checkout after the rebase, whose non-zero exit fails the attempt.
--
-- Two nullable spec columns, so null on both levels keeps exactly the behaviour every board has
-- today: nothing runs. Both are `ADD COLUMN` rather than the table rebuild a required column would
-- emit — this runs against a board a daemon may be holding leases in.
--
-- `Attempt.check` is the third, and it is a record rather than a spec: what the command was, what
-- it exited with and the tail of what it printed. The next attempt is TOLD that, which is the
-- difference between a retry and a retry that knows why it is retrying.
--
-- `Outcome.check_failed` needs no DDL: SQLite has no enum type, and Prisma stores an enum as TEXT.

-- AlterTable
ALTER TABLE "Attempt" ADD COLUMN "check" JSONB;

-- AlterTable
ALTER TABLE "Board" ADD COLUMN "defaultCheck" TEXT;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "check" TEXT;
