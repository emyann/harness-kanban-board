import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from './generated/prisma/client.ts';
import { databaseUrl } from './db-url.ts';

export { Phase, Outcome } from './generated/prisma/enums.ts';
export type { PrismaClient } from './generated/prisma/client.ts';

/**
 * The board.
 *
 * One handle per process, memoized — the same rule `openStore` had, and for the same reason:
 * `hkb serve` opens several stores per request and `hkb doctor` twenty per run, so "close it
 * in a finally" has to be written correctly at forty call sites or the handle leak comes back
 * at the one that forgot.
 */
let handle: PrismaClient | null = null;

export function openBoard(url: string = databaseUrl()): PrismaClient {
  if (handle) return handle;
  const adapter = new PrismaBetterSqlite3({ url });
  handle = new PrismaClient({ adapter });
  return handle;
}

export async function closeBoard(): Promise<void> {
  if (!handle) return;
  const open = handle;
  handle = null;
  await open.$disconnect();
}
