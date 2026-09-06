import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Where the board lives.
 *
 * This is the **migrate-time** default only, and it is deliberately not the runtime one: at run
 * time the board is `~/.hkb/board.db`, machine-level, resolved by `src/db-url.ts`. What this file
 * answers is "which database does `prisma migrate dev` touch in a checkout", and the answer is a
 * throwaway inside the repository rather than the operator's real board.
 *
 * `HKB_DATABASE_URL` overrides it — that is how the tests point at a scratch file.
 */
export const DEFAULT_DATABASE_URL = `file:${path.join(import.meta.dirname, '.hkb', 'board.db')}`;

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
