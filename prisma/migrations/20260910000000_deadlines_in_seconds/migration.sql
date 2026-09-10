-- AlterTable
ALTER TABLE "Board" ADD COLUMN "defaultActiveDeadlineSeconds" INTEGER;
ALTER TABLE "Board" ADD COLUMN "defaultAttemptDeadlineSeconds" INTEGER;

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
    "branch" TEXT,
    "prNumber" INTEGER,
    "prUrl" TEXT,
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
-- HAND-EDITED. `attemptDeadlineSeconds` is NOT NULL and past attempts have no value for it.
-- Backfilled with 1800, which is what every one of them actually ran under: it was the database
-- default on `Job.timeoutMs` and no flag could change it. A frozen column that guessed would be
-- worse than one that is right by construction.
INSERT INTO "new_Attempt" ("attemptDeadlineSeconds", "artifacts", "branch", "check", "costUsd", "denials", "endedAt", "exported", "host", "inputs", "jobId", "k", "maxBudgetUsd", "outcome", "prNumber", "prUrl", "proposal", "reason", "results", "runtime", "sessionId", "slot", "startedAt", "summary", "turns") SELECT 1800, "artifacts", "branch", "check", "costUsd", "denials", "endedAt", "exported", "host", "inputs", "jobId", "k", "maxBudgetUsd", "outcome", "prNumber", "prUrl", "proposal", "reason", "results", "runtime", "sessionId", "slot", "startedAt", "summary", "turns" FROM "Attempt";
DROP TABLE "Attempt";
ALTER TABLE "new_Attempt" RENAME TO "Attempt";
CREATE INDEX "Attempt_endedAt_idx" ON "Attempt"("endedAt");
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
    "base" TEXT,
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
-- HAND-EDITED. `migrate diff` drops `timeoutMs` and leaves `attemptDeadlineSeconds` null on every
-- existing row. The column is a RENAME plus a unit change, so the value is carried across and
-- divided: 1800000 ms -> 1800 s.
--
-- MAX(1, …) because this is INTEGER division: a hand-set `timeoutMs` below 1000 would land on 0,
-- and 0 is not "no clock" here — `pick` in src/spec.ts compares against null rather than
-- truthiness, so 0 would win over the board default and the built-in, `leaseFor(0)` would shrink
-- the lease to the bare grace, and `spec.timeoutMs ? setTimeout(...)` in the runtime is falsy at 0,
-- so the session would get no wall clock at all. Sub-second clocks only ever got there by hand,
-- which is exactly the population this migration exists for.
--
-- NULLIF is what keeps the nullable column honest. Every row today carries the old database default
-- 1800000, and copying that through would write "the operator asked for 30 minutes" onto Jobs whose
-- operator said nothing — the exact distinction the column was made nullable to keep, and it would
-- outrank the board default this migration exists to add.
INSERT INTO "new_Job" ("attemptDeadlineSeconds", "allowedTools", "artifacts", "base", "boardId", "brief", "check", "createdAt", "effort", "endedBy", "endedFor", "exports", "finishedAt", "gate", "guide", "id", "inputs", "isolate", "labels", "lastError", "lastSessionId", "maxBudgetUsd", "maxRetries", "maxTurns", "model", "name", "phase", "pluginPaths", "proposalIndex", "proposedByJobId", "proposedByK", "proposes", "results", "suspendedFor", "updatedAt") SELECT MAX(1, NULLIF("timeoutMs", 1800000) / 1000), "allowedTools", "artifacts", "base", "boardId", "brief", "check", "createdAt", "effort", "endedBy", "endedFor", "exports", "finishedAt", "gate", "guide", "id", "inputs", "isolate", "labels", "lastError", "lastSessionId", "maxBudgetUsd", "maxRetries", "maxTurns", "model", "name", "phase", "pluginPaths", "proposalIndex", "proposedByJobId", "proposedByK", "proposes", "results", "suspendedFor", "updatedAt" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE INDEX "Job_boardId_phase_idx" ON "Job"("boardId", "phase");
CREATE INDEX "Job_phase_idx" ON "Job"("phase");
CREATE UNIQUE INDEX "Job_proposedByJobId_proposedByK_proposalIndex_key" ON "Job"("proposedByJobId", "proposedByK", "proposalIndex");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

