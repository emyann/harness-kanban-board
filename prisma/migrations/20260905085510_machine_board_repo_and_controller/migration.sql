-- AlterTable
ALTER TABLE "Board" ADD COLUMN "repoPath" TEXT;

-- CreateTable
CREATE TABLE "Controller" (
    "boardId" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "holder" TEXT NOT NULL,
    "intervalMs" INTEGER NOT NULL,
    "version" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "renewedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    CONSTRAINT "Controller_boardId_fkey" FOREIGN KEY ("boardId") REFERENCES "Board" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
