-- AlterTable
ALTER TABLE "Attempt" ADD COLUMN "exported" JSONB;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "exports" JSONB;
