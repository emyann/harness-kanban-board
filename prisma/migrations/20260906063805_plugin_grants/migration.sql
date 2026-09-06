-- AlterTable
ALTER TABLE "Board" ADD COLUMN "defaultPluginPaths" JSONB;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "pluginPaths" JSONB;
