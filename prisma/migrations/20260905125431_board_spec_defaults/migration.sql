-- AlterTable
ALTER TABLE "Board" ADD COLUMN "defaultEffort" TEXT;
ALTER TABLE "Board" ADD COLUMN "defaultMaxBudgetUsd" REAL;
ALTER TABLE "Board" ADD COLUMN "defaultMaxRetries" INTEGER;
ALTER TABLE "Board" ADD COLUMN "defaultMaxTurns" INTEGER;
ALTER TABLE "Board" ADD COLUMN "defaultModel" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Job" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "boardId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "agent" TEXT NOT NULL DEFAULT 'worker',
    "model" TEXT,
    "effort" TEXT,
    "maxTurns" INTEGER,
    "timeoutMs" INTEGER NOT NULL DEFAULT 1800000,
    "maxBudgetUsd" REAL,
    "isolate" BOOLEAN NOT NULL DEFAULT true,
    "maxRetries" INTEGER,
    "phase" TEXT NOT NULL DEFAULT 'pending',
    "lastSessionId" TEXT,
    "lastError" TEXT,
    "suspendedFor" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "Job_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Job" ("agent", "boardId", "brief", "createdAt", "effort", "finishedAt", "id", "isolate", "lastError", "lastSessionId", "maxBudgetUsd", "maxRetries", "maxTurns", "model", "name", "phase", "suspendedFor", "timeoutMs", "updatedAt") SELECT "agent", "boardId", "brief", "createdAt", "effort", "finishedAt", "id", "isolate", "lastError", "lastSessionId", "maxBudgetUsd", "maxRetries", "maxTurns", "model", "name", "phase", "suspendedFor", "timeoutMs", "updatedAt" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE INDEX "Job_boardId_phase_idx" ON "Job"("boardId", "phase");
CREATE INDEX "Job_phase_idx" ON "Job"("phase");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
