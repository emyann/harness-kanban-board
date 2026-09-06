-- AlterTable
ALTER TABLE "Board" ADD COLUMN "defaultAllowedTools" JSONB;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "allowedTools" JSONB;
