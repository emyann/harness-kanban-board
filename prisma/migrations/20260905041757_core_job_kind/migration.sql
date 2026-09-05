-- CreateTable
CREATE TABLE "Board" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slug" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Job" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "boardId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "brief" TEXT NOT NULL,
    "agent" TEXT NOT NULL DEFAULT 'worker',
    "model" TEXT,
    "effort" TEXT,
    "maxTurns" INTEGER NOT NULL DEFAULT 20,
    "maxBudgetUsd" REAL NOT NULL DEFAULT 1,
    "isolate" BOOLEAN NOT NULL DEFAULT true,
    "maxRetries" INTEGER NOT NULL DEFAULT 2,
    "phase" TEXT NOT NULL DEFAULT 'pending',
    "lastSessionId" TEXT,
    "lastError" TEXT,
    "suspendedFor" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    CONSTRAINT "Job_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Attempt" (
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
    "costUsd" REAL,

    PRIMARY KEY ("jobId", "k"),
    CONSTRAINT "Attempt_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Lease" (
    "jobId" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "holder" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "Lease_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Event" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "jobId" INTEGER,
    "actor" TEXT,
    "payload" JSONB,
    CONSTRAINT "Event_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Board_slug_key" ON "Board"("slug");

-- CreateIndex
CREATE INDEX "Job_boardId_phase_idx" ON "Job"("boardId", "phase");

-- CreateIndex
CREATE INDEX "Job_phase_idx" ON "Job"("phase");

-- CreateIndex
CREATE INDEX "Attempt_endedAt_idx" ON "Attempt"("endedAt");

-- CreateIndex
CREATE INDEX "Event_jobId_id_idx" ON "Event"("jobId", "id");
