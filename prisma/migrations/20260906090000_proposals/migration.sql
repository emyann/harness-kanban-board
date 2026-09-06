-- ADR-011's remaining half: a workload proposes, the controller writes.
--
-- Four nullable columns and one unique index, which is all this needs. `proposes` is a string
-- naming what may be proposed rather than a boolean, so it is `ADD COLUMN` against a board a daemon
-- may be running in rather than the table rebuild a required column would emit.
--
-- The index is the idempotency. A created Job carries the attempt that proposed it and its position
-- in that proposal, so re-applying the same approval re-creates the same triple and SQLite refuses
-- the second one. Every Job filed by hand carries three NULLs, and SQLite counts NULLs as distinct
-- under a unique index, so they do not collide with each other.

-- AlterTable
ALTER TABLE "Attempt" ADD COLUMN "proposal" JSONB;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "proposalIndex" INTEGER;
ALTER TABLE "Job" ADD COLUMN "proposedByJobId" INTEGER;
ALTER TABLE "Job" ADD COLUMN "proposedByK" INTEGER;
ALTER TABLE "Job" ADD COLUMN "proposes" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Job_proposedByJobId_proposedByK_proposalIndex_key" ON "Job"("proposedByJobId", "proposedByK", "proposalIndex");
