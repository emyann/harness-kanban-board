import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

/**
 * Making the board exist, and refusing to open one from the future.
 *
 * A machine-level default only works if the first `hkb` command on a fresh machine works. Telling
 * the operator to go and run `prisma migrate deploy` fails that on two counts: it is the "yes, by
 * hand" answer this project treats as a bug report, and `prisma` is a devDependency that a global
 * install does not have. So the migrations are applied here, from the committed SQL, using the
 * SQLite driver we already ship.
 *
 * The rows written to `_prisma_migrations` are the ones Prisma writes, so `prisma migrate status`
 * and `prisma migrate dev` keep working in a checkout — this bootstraps the same history rather
 * than a parallel one.
 */

import { IS_CHECKOUT, migrationsDir } from './paths.ts';

const require = createRequire(import.meta.url);
const MIGRATIONS_DIR = migrationsDir();

/** The migrations this build knows about, in the order Prisma applies them (lexical = temporal). */
export function knownMigrations(dir = MIGRATIONS_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'migration.sql')))
    .map((e) => e.name)
    .sort();
}

/** Prisma's checksum is the sha256 of the migration file, hex. */
const checksum = (sql: string) => crypto.createHash('sha256').update(sql).digest('hex');

const CREATE_LEDGER = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" TEXT PRIMARY KEY NOT NULL,
  "checksum" TEXT NOT NULL,
  "finished_at" DATETIME,
  "migration_name" TEXT NOT NULL,
  "logs" TEXT,
  "rolled_back_at" DATETIME,
  "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
  "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

export type SchemaResult = { applied: string[]; alreadyApplied: number };

/**
 * May this build apply pending migrations to this board without being asked?
 *
 * Pure, because it is the whole of the decision and the failing case is silent. `ensureSchema` used
 * to answer *yes, always*, and that cost the operator a board: running any command from a feature
 * checkout wrote that branch's migrations into `~/.hkb/board.db`, after which every other checkout
 * refused to open it (`this board was migrated by a newer hkb`). The refusal was guarded; the cause
 * was not.
 *
 * Three inputs, and each is there for a reason:
 *
 * - **`isNew`** — a board with nothing applied is one nobody is using yet, and creating it is the
 *   whole of "the first command on a fresh machine works". Refusing here would trade a real bug for
 *   a worse one. This is also why the test suite is unaffected: every test makes its own board.
 * - **`isCheckout`** — an installed `hkb` is a *release*, and a release migrating a board on upgrade
 *   is ordinary. A checkout is whatever branch somebody has out, which is not a thing to migrate a
 *   board you use with. `npm link` counts as a checkout, and that is the case that bit us.
 * - **`asked`** — `hkb migrate` exists so the refusal has a way through. An operator who says the
 *   words gets the migration.
 */
export function mayMigrate(o: { isNew: boolean; isCheckout: boolean; asked: boolean }): boolean {
  return o.asked || o.isNew || !o.isCheckout;
}

/** What a board refuses when a checkout tries to migrate it out from under the operator. */
export function refuseMigration(dbPath: string, pending: string[]): Error & { exitCode: number } {
  const one = pending.length === 1;
  const e = new Error(
    `${dbPath} would gain ${pending.length} migration${one ? '' : 's'} this checkout has and it does not `
    + `(${pending.join(', ')}) — and then every hkb without ${one ? 'it' : 'them'} would refuse to open it. `
    + 'A checkout does not migrate a board you use. Run `hkb migrate` to apply '
    + `${one ? 'it' : 'them'} deliberately, or point HKB_DATABASE_URL at a board you do not mind rewriting.`,
  ) as Error & { exitCode: number };
  e.exitCode = 2;
  return e;
}

/**
 * Bring a database up to this build's schema, creating it if it does not exist.
 *
 * Idempotent, and safe to call on every open: with nothing to do it is one indexed read.
 */
export function ensureSchema(
  dbPath: string,
  dir = MIGRATIONS_DIR,
  opts: { asked?: boolean; isCheckout?: boolean } = {},
): SchemaResult {
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');
    db.exec(CREATE_LEDGER);
    const done = new Set(
      (db.prepare('SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL')
        .all() as { migration_name: string }[]).map((r) => r.migration_name),
    );

    const pending = knownMigrations(dir).filter((n) => !done.has(n));
    if (!pending.length) return { applied: [], alreadyApplied: done.size };

    // Whose migration is this? See `mayMigrate`. The board is opened on every command, so this is
    // the one place that can tell "creating the machine's board" from "rewriting it from a branch".
    if (!mayMigrate({ isNew: done.size === 0, isCheckout: opts.isCheckout ?? IS_CHECKOUT, asked: !!opts.asked })) {
      throw refuseMigration(dbPath, pending);
    }

    // ---- foreign keys OFF, and *outside* the transaction, which is the only place saying so
    // works. SQLite documents `PRAGMA foreign_keys` as a no-op within a transaction, and a no-op
    // is what it silently was: every migration Prisma generates for a changed column is a
    // "RedefineTables" block that copies a table, DROPs the original and renames the copy over it,
    // and it opens with `PRAGMA foreign_keys=OFF` precisely because DROP TABLE performs an
    // implicit DELETE that fires ON DELETE CASCADE on every child. Wrapped in BEGIN, that pragma
    // did nothing, so redefining `Job` deleted every Attempt, Lease and Event on the board —
    // cascaded away by a statement whose entire purpose was to leave the data alone.
    //
    // Nothing had noticed because the two migrations that redefine `Job` shipped before anyone
    // had a board with rows in it. `test/schema.test.ts` now migrates a populated board and
    // counts what survived, which is the only form of this that stays true.
    //
    // `defer_foreign_keys`, which those blocks also set, is not a substitute: it defers the
    // *checking* of a violation to commit time, and a cascade is not a violation. Only OFF stops
    // the delete.
    db.pragma('foreign_keys = OFF');
    try {
      const applied: string[] = [];
      for (const name of pending) {
        const sql = fs.readFileSync(path.join(dir, name, 'migration.sql'), 'utf8');
        // Each migration is one unit: a half-applied schema is worse than an unapplied one, and
        // SQLite gives us the transaction for free.
        db.exec('BEGIN');
        try {
          db.exec(sql);
          // The price of turning enforcement off: a migration that leaves a row pointing at a
          // parent that is gone commits silently and is found weeks later as a crash in a join.
          // Checked before the commit, so the answer is still a rollback rather than a post-mortem.
          const dangling = db.pragma('foreign_key_check') as unknown[];
          if (dangling.length) {
            throw new Error(
              `it left ${dangling.length} row${dangling.length === 1 ? '' : 's'} referring to a parent that `
              + 'is not there. Nothing was written — fix the migration, or the board it was run against',
            );
          }
          db.prepare(
            `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count)
             VALUES (?, ?, current_timestamp, ?, 1)`,
          ).run(crypto.randomUUID(), checksum(sql), name);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw new Error(`could not apply migration ${name}: ${(e as Error).message}`);
        }
        applied.push(name);
      }
      return { applied, alreadyApplied: done.size };
    } finally {
      db.pragma('foreign_keys = ON');
    }
  } finally {
    db.close();
  }
}

/**
 * Refuse a board migrated by a newer build.
 *
 * The forward direction is handled by `ensureSchema` — an older database is simply brought up. The
 * backward one cannot be: a global `hkb` opening a board that a dev checkout has already migrated
 * would fail somewhere deep in Prisma with an error naming a column, not a cause. One machine-level
 * board makes this reachable rather than theoretical, so it gets a real message.
 */
export function assertNotFromTheFuture(dbPath: string, dir = MIGRATIONS_DIR): void {
  if (!fs.existsSync(dbPath)) return;
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    const hasLedger = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='_prisma_migrations'`,
    ).get();
    if (!hasLedger) return;
    const known = new Set(knownMigrations(dir));
    const ahead = (db.prepare('SELECT migration_name FROM _prisma_migrations WHERE rolled_back_at IS NULL')
      .all() as { migration_name: string }[])
      .map((r) => r.migration_name)
      .filter((n) => !known.has(n));
    if (!ahead.length) return;
    const e = new Error(
      `this board was migrated by a newer hkb (${ahead.join(', ')}) — run the newer \`hkb\`, `
      + `or point HKB_DATABASE_URL at a different board`,
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  } finally {
    db.close();
  }
}
