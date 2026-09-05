import path from 'node:path';

/**
 * Where the board file lives, as a SQLite connection URL.
 *
 * Its own module because two very different things need the same answer and neither should
 * import the other: `prisma.config.ts` (the CLI, at migrate time) and `src/db.ts` (the
 * client, at run time). Nothing here imports Prisma, so the config file does not drag the
 * generated client in before it exists.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** `.kanban/board.db` — beside `board.json`, and deliberately not inside `.git/`. */
export const DEFAULT_DB_PATH = path.join(REPO_ROOT, '.kanban', 'board.db');

export function databaseUrl(): string {
  return process.env.HKB_DATABASE_URL || `file:${DEFAULT_DB_PATH}`;
}
