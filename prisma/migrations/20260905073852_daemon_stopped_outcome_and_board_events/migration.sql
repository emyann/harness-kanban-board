-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Event" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "jobId" INTEGER,
    "boardId" INTEGER,
    "actor" TEXT,
    "payload" JSONB,
    CONSTRAINT "Event_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Event_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Event" ("actor", "at", "id", "jobId", "kind", "payload") SELECT "actor", "at", "id", "jobId", "kind", "payload" FROM "Event";
DROP TABLE "Event";
ALTER TABLE "new_Event" RENAME TO "Event";
CREATE INDEX "Event_jobId_id_idx" ON "Event"("jobId", "id");
CREATE INDEX "Event_boardId_id_idx" ON "Event"("boardId", "id");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
