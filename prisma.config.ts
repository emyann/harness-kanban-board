import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Where the board lives.
 *
 * `.kanban/board.db`, next to `board.json` — **not** `.git/hkb/index.db`, which is where the
 * old live tier sat. That was correct while the git ref was the source of truth and the
 * database was a disposable index; it is wrong now that the database *is* the board, because
 * nothing in `.git/` is carried by a clone or survives a fresh checkout.
 *
 * `HKB_DATABASE_URL` overrides it — that is how the tests point at a scratch file.
 */
export const DEFAULT_DATABASE_URL = `file:${path.join(import.meta.dirname, '.kanban', 'board.db')}`;

export const databaseUrl = () => process.env.HKB_DATABASE_URL || DEFAULT_DATABASE_URL;

export default defineConfig({
  schema: path.join(import.meta.dirname, 'prisma', 'schema.prisma'),
  migrations: {
    path: path.join(import.meta.dirname, 'prisma', 'migrations'),
  },
  datasource: {
    url: databaseUrl(),
  },
});
