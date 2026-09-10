-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Attempt" (
    "jobId" INTEGER NOT NULL,
    "k" INTEGER NOT NULL,
    "host" TEXT,
    "runtime" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "outcome" TEXT,
    "sessionId" TEXT,
    "summary" TEXT,
    "reason" TEXT,
    "maxBudgetUsd" REAL NOT NULL,
    "attemptDeadlineSeconds" INTEGER NOT NULL,
    "exported" JSONB,
    "costUsd" REAL,
    "results" JSONB,
    "slot" INTEGER,
    "inputs" JSONB,
    "proposal" JSONB,
    "artifacts" JSONB,
    "check" JSONB,
    "turns" INTEGER,
    "denials" INTEGER,

    PRIMARY KEY ("jobId", "k"),
    CONSTRAINT "Attempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Attempt" ("artifacts", "attemptDeadlineSeconds", "check", "costUsd", "denials", "endedAt", "exported", "host", "inputs", "jobId", "k", "maxBudgetUsd", "outcome", "proposal", "reason", "results", "runtime", "sessionId", "slot", "startedAt", "summary", "turns") SELECT "artifacts", "attemptDeadlineSeconds", "check", "costUsd", "denials", "endedAt", "exported", "host", "inputs", "jobId", "k", "maxBudgetUsd", "outcome", "proposal", "reason", "results", "runtime", "sessionId", "slot", "startedAt", "summary", "turns" FROM "Attempt";
DROP TABLE "Attempt";
ALTER TABLE "new_Attempt" RENAME TO "Attempt";
CREATE INDEX "Attempt_endedAt_idx" ON "Attempt"("endedAt");
CREATE TABLE "new_Board" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slug" TEXT NOT NULL,
    "repoPath" TEXT,
    "pausedAt" DATETIME,
    "pausedBy" TEXT,
    "dailyBudgetUsd" REAL,
    "maxConcurrent" INTEGER NOT NULL DEFAULT 1,
    "defaultModel" TEXT,
    "defaultEffort" TEXT,
    "defaultMaxTurns" INTEGER,
    "defaultAttemptDeadlineSeconds" INTEGER,
    "defaultActiveDeadlineSeconds" INTEGER,
    "defaultMaxBudgetUsd" REAL,
    "defaultMaxRetries" INTEGER,
    "defaultAllowedTools" JSONB,
    "defaultPluginPaths" JSONB,
    "defaultGuide" TEXT,
    "defaultCheck" TEXT,
    "defaultWorkflow" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Board" ("createdAt", "dailyBudgetUsd", "defaultActiveDeadlineSeconds", "defaultAllowedTools", "defaultAttemptDeadlineSeconds", "defaultCheck", "defaultEffort", "defaultGuide", "defaultMaxBudgetUsd", "defaultMaxRetries", "defaultMaxTurns", "defaultModel", "defaultPluginPaths", "defaultWorkflow", "id", "maxConcurrent", "pausedAt", "pausedBy", "repoPath", "slug", "updatedAt") SELECT "createdAt", "dailyBudgetUsd", "defaultActiveDeadlineSeconds", "defaultAllowedTools", "defaultAttemptDeadlineSeconds", "defaultCheck", "defaultEffort", "defaultGuide", "defaultMaxBudgetUsd", "defaultMaxRetries", "defaultMaxTurns", "defaultModel", "defaultPluginPaths", "defaultWorkflow", "id", "maxConcurrent", "pausedAt", "pausedBy", "repoPath", "slug", "updatedAt" FROM "Board";
DROP TABLE "Board";
ALTER TABLE "new_Board" RENAME TO "Board";
CREATE UNIQUE INDEX "Board_slug_key" ON "Board"("slug");
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "Job_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Job" ("activeDeadlineSeconds", "allowedTools", "artifacts", "attemptDeadlineSeconds", "boardId", "brief", "check", "createdAt", "effort", "endedBy", "endedFor", "exports", "finishedAt", "gate", "guide", "id", "inputs", "isolate", "labels", "lastError", "lastSessionId", "maxBudgetUsd", "maxRetries", "maxTurns", "model", "name", "phase", "pluginPaths", "proposalIndex", "proposedByJobId", "proposedByK", "proposes", "results", "suspendedFor", "updatedAt") SELECT "activeDeadlineSeconds", "allowedTools", "artifacts", "attemptDeadlineSeconds", "boardId", "brief", "check", "createdAt", "effort", "endedBy", "endedFor", "exports", "finishedAt", "gate", "guide", "id", "inputs", "isolate", "labels", "lastError", "lastSessionId", "maxBudgetUsd", "maxRetries", "maxTurns", "model", "name", "phase", "pluginPaths", "proposalIndex", "proposedByJobId", "proposedByK", "proposes", "results", "suspendedFor", "updatedAt" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE INDEX "Job_boardId_phase_idx" ON "Job"("boardId", "phase");
CREATE INDEX "Job_phase_idx" ON "Job"("phase");
CREATE UNIQUE INDEX "Job_proposedByJobId_proposedByK_proposalIndex_key" ON "Job"("proposedByJobId", "proposedByK", "proposalIndex");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

