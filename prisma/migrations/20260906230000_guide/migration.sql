-- The contributor guide a worker was never given (ADR-013).
--
-- Two nullable columns, so both are plain ADD COLUMNs against a board a daemon may be running in.
-- Nullable is also the modelling answer and not only the migration one: a null means the operator
-- has not granted a guide, which is a different fact from granting an empty one.

-- AlterTable
ALTER TABLE "Board" ADD COLUMN "defaultGuide" TEXT;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "guide" TEXT;
