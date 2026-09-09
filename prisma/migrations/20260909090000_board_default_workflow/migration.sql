-- `defaultWorkflow` — where a hand-filed Job gets its finishing steps (ADR-017 decisions 1 and 5).
--
-- The core stopped telling every isolated worker to push and open a draft pull request: that is a
-- step's content, and `src/brief.ts` now says only what the machinery refuses on afterwards. A Job
-- filed with `--from <workflow>` carries its own steps in its brief; a Job filed by hand had
-- nowhere to get any, so a board names one workflow that says how work on it FINISHES.
--
-- A name, not a body: the file lives in `.hkb/workflows/` under the board's repository and is read
-- there, so changing the steps is a commit and a merge rather than a column update — the same fence
-- `--from`, a guide and a plugin grant already sit behind.
--
-- One nullable `ADD COLUMN`, which is what a board a daemon may be holding leases in can take.
-- Null — the shipped default — is a board that adds nothing to a Job's brief.

-- AlterTable
ALTER TABLE "Board" ADD COLUMN "defaultWorkflow" TEXT;
