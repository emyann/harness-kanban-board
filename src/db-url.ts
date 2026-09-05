import os from 'node:os';
import path from 'node:path';

/**
 * Where the board file lives, as a SQLite connection URL.
 *
 * Its own module because two very different things need the same answer and neither should
 * import the other: `prisma.config.ts` (the CLI, at migrate time) and `src/db.ts` (the
 * client, at run time). Nothing here imports Prisma, so the config file does not drag the
 * generated client in before it exists.
 *
 * **The default is the machine, not the repository.** One board per machine with a Board row per
 * repository is the same shape as one Kubernetes cluster with a namespace per project — and it is
 * the only shape in which "show me everything running here" is a query rather than a hunt across
 * checkouts. A per-repo database is still reachable through `HKB_DATABASE_URL`, and tests use
 * exactly that.
 */
import { PACKAGE_ROOT } from './paths.ts';

/** `~/.hkb/board.db` — the machine's board. */
export const MACHINE_DB_PATH = path.join(os.homedir(), '.hkb', 'board.db');

/** The pre-machine-board location, kept only so `kb` can point at it when it finds one. */
export const REPO_DB_PATH = path.join(PACKAGE_ROOT, '.kanban', 'board.db');

export function databaseUrl(): string {
  return process.env.HKB_DATABASE_URL || `file:${MACHINE_DB_PATH}`;
}

/** The directory the board lives in — where its log files go too. */
export function boardDir(url = databaseUrl()): string {
  return path.dirname(url.replace(/^file:/, ''));
}
