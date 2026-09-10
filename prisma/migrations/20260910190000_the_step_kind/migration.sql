-- CreateTable
CREATE TABLE "Run" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "boardId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Run_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Step" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "after" JSONB NOT NULL DEFAULT '[]',
    CONSTRAINT "Step_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

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
    "attemptDeadlineSeconds" INTEGER,
    "activeDeadlineSeconds" INTEGER,
    "maxBudgetUsd" REAL,
    "isolate" BOOLEAN NOT NULL DEFAULT true,
    "allowedTools" JSONB,
    "pluginPaths" JSONB,
    "guide" TEXT,
    "maxRetries" INTEGER,
    "exports" JSONB,
    "inputs" JSONB,
    "results" JSONB,
    "artifacts" JSONB,
    "check" TEXT,
    "labels" JSONB,
    "gate" TEXT,
    "proposes" TEXT,
    "phase" TEXT NOT NULL DEFAULT 'pending',
    "lastSessionId" TEXT,
    "lastError" TEXT,
    "suspendedFor" TEXT,
    "endedBy" TEXT,
    "endedFor" TEXT,
    "proposedByJobId" INTEGER,
    "proposedByK" INTEGER,
    "proposalIndex" INTEGER,
    "stepId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "Job_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Job_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "Step" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Job" ("activeDeadlineSeconds", "allowedTools", "artifacts", "attemptDeadlineSeconds", "boardId", "brief", "check", "createdAt", "effort", "endedBy", "endedFor", "exports", "finishedAt", "gate", "guide", "id", "inputs", "isolate", "labels", "lastError", "lastSessionId", "maxBudgetUsd", "maxRetries", "maxTurns", "model", "name", "phase", "pluginPaths", "proposalIndex", "proposedByJobId", "proposedByK", "proposes", "results", "suspendedFor", "updatedAt") SELECT "activeDeadlineSeconds", "allowedTools", "artifacts", "attemptDeadlineSeconds", "boardId", "brief", "check", "createdAt", "effort", "endedBy", "endedFor", "exports", "finishedAt", "gate", "guide", "id", "inputs", "isolate", "labels", "lastError", "lastSessionId", "maxBudgetUsd", "maxRetries", "maxTurns", "model", "name", "phase", "pluginPaths", "proposalIndex", "proposedByJobId", "proposedByK", "proposes", "results", "suspendedFor", "updatedAt" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE UNIQUE INDEX "Job_stepId_key" ON "Job"("stepId");
CREATE INDEX "Job_boardId_phase_idx" ON "Job"("boardId", "phase");
CREATE INDEX "Job_phase_idx" ON "Job"("phase");
CREATE UNIQUE INDEX "Job_proposedByJobId_proposedByK_proposalIndex_key" ON "Job"("proposedByJobId", "proposedByK", "proposalIndex");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Run_boardId_idx" ON "Run"("boardId");

-- CreateIndex
CREATE INDEX "Step_runId_idx" ON "Step"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "Step_runId_name_key" ON "Step"("runId", "name");

