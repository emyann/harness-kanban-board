-- The base of the checkout becomes a spec field (`docs/workflow-study.md` §4.1).
--
-- Every Job branched from `origin/<default>` — a constant nobody chose, resolved fresh on every
-- attempt — so two Jobs could not be connected: a coding Job's deliverable is a branch, and there
-- was nowhere to say "start from where that one finished". One nullable column on each side, so
-- null keeps exactly the behaviour every Job had, and both are `ADD COLUMN` rather than the table
-- rebuild a required column would emit — this runs against a board a daemon may be holding.
--
-- It is a REF and never a reference to another Job: `job:33` would be `Job.after` with a readiness
-- question attached, rejected on four counts in study §2 rather than deferred.

-- AlterTable
ALTER TABLE "Board" ADD COLUMN "defaultBase" TEXT;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "base" TEXT;
