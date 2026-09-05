import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

/**
 * Making the board exist, and refusing to open one from the future.
 *
 * A machine-level default only works if the first `kb` command on a fresh machine works. Telling
 * the operator to go and run `prisma migrate deploy` fails that on two counts: it is the "yes, by
 * hand" answer this project treats as a bug report, and `prisma` is a devDependency that a global
 * install does not have. So the migrations are applied here, from the committed SQL, using the
 * SQLite driver we already ship.
 *
 * The rows written to `_prisma_migrations` are the ones Prisma writes, so `prisma migrate status`
 * and `prisma migrate dev` keep working in a checkout — this bootstraps the same history rather
 * than a parallel one.
 */

const require = createRequire(import.meta.url);
const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', 'prisma', 'migrations');

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
 * Bring a database up to this build's schema, creating it if it does not exist.
 *
 * Idempotent, and safe to call on every open: with nothing to do it is one indexed read.
 */
export function ensureSchema(dbPath: string, dir = MIGRATIONS_DIR): SchemaResult {
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

    const applied: string[] = [];
    for (const name of knownMigrations(dir)) {
      if (done.has(name)) continue;
      const sql = fs.readFileSync(path.join(dir, name, 'migration.sql'), 'utf8');
      // Each migration is one unit: a half-applied schema is worse than an unapplied one, and
      // SQLite gives us the transaction for free.
      db.exec('BEGIN');
      try {
        db.exec(sql);
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
    db.close();
  }
}

/**
 * Refuse a board migrated by a newer build.
 *
 * The forward direction is handled by `ensureSchema` — an older database is simply brought up. The
 * backward one cannot be: a global `kb` opening a board that a dev checkout has already migrated
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
      `this board was migrated by a newer hkb (${ahead.join(', ')}) — run the newer \`kb\`, `
      + `or point HKB_DATABASE_URL at a different board`,
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  } finally {
    db.close();
  }
}
