-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Job" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "boardId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "model" TEXT,
    "effort" TEXT,
    "maxTurns" INTEGER,
    "timeoutMs" INTEGER NOT NULL DEFAULT 1800000,
    "maxBudgetUsd" REAL,
    "isolate" BOOLEAN NOT NULL DEFAULT true,
    "allowedTools" JSONB,
    "maxRetries" INTEGER,
    "exports" JSONB,
    "phase" TEXT NOT NULL DEFAULT 'pending',
    "lastSessionId" TEXT,
    "lastError" TEXT,
    "suspendedFor" TEXT,
    "endedBy" TEXT,
    "endedFor" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "Job_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Job" ("allowedTools", "boardId", "brief", "createdAt", "effort", "endedBy", "endedFor", "exports", "finishedAt", "id", "isolate", "lastError", "lastSessionId", "maxBudgetUsd", "maxRetries", "maxTurns", "model", "name", "phase", "suspendedFor", "timeoutMs", "updatedAt") SELECT "allowedTools", "boardId", "brief", "createdAt", "effort", "endedBy", "endedFor", "exports", "finishedAt", "id", "isolate", "lastError", "lastSessionId", "maxBudgetUsd", "maxRetries", "maxTurns", "model", "name", "phase", "suspendedFor", "timeoutMs", "updatedAt" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE INDEX "Job_boardId_phase_idx" ON "Job"("boardId", "phase");
CREATE INDEX "Job_phase_idx" ON "Job"("phase");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

