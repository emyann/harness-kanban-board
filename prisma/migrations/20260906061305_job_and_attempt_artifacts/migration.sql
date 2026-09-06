-- AlterTable
ALTER TABLE "Attempt" ADD COLUMN "artifacts" JSONB;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "artifacts" JSONB;
