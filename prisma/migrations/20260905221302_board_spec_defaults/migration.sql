-- Board spec defaults, nullable Job spec columns, and the cap frozen onto the Attempt.
--
-- Two changes that have to land together. `Job.maxTurns`, `maxBudgetUsd` and `maxRetries` lose
-- their database defaults and become nullable, because a column defaulting to 20 cannot tell "the
-- operator asked for 20" from "the operator said nothing" — and without that distinction a Board
-- default is outranked by every Job that ever existed. Existing values are preserved by the copy
-- below, so no Job filed before this migration changes behaviour.
--
-- `Attempt.maxBudgetUsd` is the cap a run was CLAIMED under, and it is NOT NULL on purpose: the
-- admission gate sums it over live attempts, and a null there is the failure this whole change had
-- to design around. Existing attempts are backfilled from their Job's cap, which is still NOT NULL
-- at that point in this script — the Attempt table is rebuilt before the Job table is. `COALESCE`
-- covers only the impossible orphan; the foreign key means there is not one.

-- AlterTable
ALTER TABLE "Board" ADD COLUMN "defaultEffort" TEXT;
ALTER TABLE "Board" ADD COLUMN "defaultMaxBudgetUsd" REAL;
ALTER TABLE "Board" ADD COLUMN "defaultMaxRetries" INTEGER;
ALTER TABLE "Board" ADD COLUMN "defaultMaxTurns" INTEGER;
ALTER TABLE "Board" ADD COLUMN "defaultModel" TEXT;

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
    "branch" TEXT,
    "prNumber" INTEGER,
    "prUrl" TEXT,
    "exported" JSONB,
    "costUsd" REAL,

    PRIMARY KEY ("jobId", "k"),
    CONSTRAINT "Attempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Attempt" ("branch", "costUsd", "endedAt", "exported", "host", "jobId", "k", "outcome", "prNumber", "prUrl", "reason", "runtime", "sessionId", "startedAt", "summary", "maxBudgetUsd") SELECT "branch", "costUsd", "endedAt", "exported", "host", "jobId", "k", "outcome", "prNumber", "prUrl", "reason", "runtime", "sessionId", "startedAt", "summary", COALESCE((SELECT "j"."maxBudgetUsd" FROM "Job" AS "j" WHERE "j"."id" = "Attempt"."jobId"), 1) FROM "Attempt";
DROP TABLE "Attempt";
ALTER TABLE "new_Attempt" RENAME TO "Attempt";
CREATE INDEX "Attempt_endedAt_idx" ON "Attempt"("endedAt");
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
INSERT INTO "new_Job" ("agent", "boardId", "brief", "createdAt", "effort", "endedBy", "endedFor", "exports", "finishedAt", "id", "isolate", "lastError", "lastSessionId", "maxBudgetUsd", "maxRetries", "maxTurns", "model", "name", "phase", "suspendedFor", "timeoutMs", "updatedAt") SELECT "agent", "boardId", "brief", "createdAt", "effort", "endedBy", "endedFor", "exports", "finishedAt", "id", "isolate", "lastError", "lastSessionId", "maxBudgetUsd", "maxRetries", "maxTurns", "model", "name", "phase", "suspendedFor", "timeoutMs", "updatedAt" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE INDEX "Job_boardId_phase_idx" ON "Job"("boardId", "phase");
CREATE INDEX "Job_phase_idx" ON "Job"("phase");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
