import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ensureSchema, assertNotFromTheFuture, knownMigrations } from '../src/schema.ts';

/**
 * Making the board exist, and refusing one from the future.
 *
 * Both matter more since the board became machine-level. The first command on a fresh machine has
 * to work, and "go and run a migration" is the answer this project treats as a bug report. And one
 * shared board means a global `kb` and a dev checkout genuinely can meet on the same file, which
 * used to be theoretical.
 */

const require = createRequire(import.meta.url);
const dirs: string[] = [];
const scratch = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-schema-'));
  dirs.push(d);
  return path.join(d, 'board.db');
};
test.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const open = (p: string) => new (require('better-sqlite3') as typeof import('better-sqlite3'))(p);

test('a board that does not exist is created, migrated and usable', () => {
  const p = scratch();
  const r = ensureSchema(p);
  assert.deepEqual(r.applied, knownMigrations(), 'every migration this build knows about');
  assert.ok(r.applied.length > 0);

  const db = open(p);
  try {
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
      .map((t) => t.name);
    for (const t of ['Board', 'Job', 'Attempt', 'Lease', 'Event', 'Controller']) {
      assert.ok(tables.includes(t), `${t} exists`);
    }
  } finally {
    db.close();
  }
});

test('running it again applies nothing — it is safe on every open', () => {
  const p = scratch();
  ensureSchema(p);
  const again = ensureSchema(p);
  assert.deepEqual(again.applied, [], 'idempotent, because it runs on every openBoard()');
  assert.equal(again.alreadyApplied, knownMigrations().length);
});

test('the ledger it writes is the one Prisma reads, not a parallel history', () => {
  // If this drifted, `prisma migrate dev` in a checkout would try to re-apply everything and a
  // developer would get a schema conflict from a tool they never ran.
  const p = scratch();
  ensureSchema(p);
  const db = open(p);
  try {
    const rows = db.prepare(
      'SELECT migration_name, checksum, finished_at, applied_steps_count FROM _prisma_migrations ORDER BY migration_name',
    ).all() as { migration_name: string; checksum: string; finished_at: string; applied_steps_count: number }[];
    assert.deepEqual(rows.map((r) => r.migration_name), knownMigrations());
    for (const r of rows) {
      assert.match(r.checksum, /^[0-9a-f]{64}$/, 'sha256 of the migration file, as Prisma stores it');
      assert.ok(r.finished_at, 'and marked finished, or Prisma treats it as a failed migration');
      assert.equal(r.applied_steps_count, 1);
    }
  } finally {
    db.close();
  }
});

test('a partly-migrated board is brought the rest of the way, not started over', () => {
  const p = scratch();
  const all = knownMigrations();
  const db = open(p);
  db.exec(`CREATE TABLE "_prisma_migrations" (
    "id" TEXT PRIMARY KEY NOT NULL, "checksum" TEXT NOT NULL, "finished_at" DATETIME,
    "migration_name" TEXT NOT NULL, "logs" TEXT, "rolled_back_at" DATETIME,
    "started_at" DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count" INTEGER UNSIGNED NOT NULL DEFAULT 0)`);
  // Pretend the first migration ran, by applying it and recording it exactly as Prisma would.
  const first = fs.readFileSync(path.join(
    path.resolve(import.meta.dirname, '..', 'prisma', 'migrations'), all[0], 'migration.sql'), 'utf8');
  db.exec(first);
  db.prepare('INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) VALUES (?,?,current_timestamp,?,1)')
    .run('seed', 'x', all[0]);
  db.close();

  const r = ensureSchema(p);
  assert.deepEqual(r.applied, all.slice(1), 'only what was missing');
});

test('a board migrated by a newer build is refused, and the message says what to do', () => {
  const p = scratch();
  ensureSchema(p);
  const db = open(p);
  db.prepare('INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count) VALUES (?,?,?,current_timestamp,1)')
    .run('future', 'z', '29990101000000_a_column_we_do_not_know_about');
  db.close();

  assert.throws(
    () => assertNotFromTheFuture(p),
    (e: Error & { exitCode?: number }) => {
      assert.equal(e.exitCode, 2, 'a state error, not a crash');
      assert.match(e.message, /29990101000000_a_column_we_do_not_know_about/, 'names the migration it does not have');
      assert.match(e.message, /run the newer `kb`/);
      assert.match(e.message, /HKB_DATABASE_URL/, 'and the other way out');
      return true;
    },
  );
});

test('a board this build is in step with is not refused', () => {
  const p = scratch();
  ensureSchema(p);
  assert.doesNotThrow(() => assertNotFromTheFuture(p));
});

test('a database file that does not exist yet is not from the future', () => {
  assert.doesNotThrow(() => assertNotFromTheFuture(scratch()));
});

/**
 * The rows a migration must not take with it.
 *
 * Every Prisma migration that changes a column is a "RedefineTables" block: copy the table, DROP
 * the original, rename the copy over it. DROP TABLE performs an implicit DELETE, which fires
 * `ON DELETE CASCADE` on every child — so those blocks open with `PRAGMA foreign_keys=OFF`. SQLite
 * makes that pragma a NO-OP inside a transaction, and `ensureSchema` runs each migration in one, so
 * for six migrations the protection was not there: redefining `Job` would have deleted every
 * Attempt, Lease and Event on the board.
 *
 * It had never fired because the two migrations that redefine `Job` shipped before any board had
 * rows. This is the test that keeps it from firing later: it migrates a POPULATED board across the
 * whole history and counts what came out the other side.
 */
test('migrating a populated board keeps its attempts, leases and events', () => {
  const p = scratch();
  const all = knownMigrations();
  const MIGRATIONS = path.resolve(import.meta.dirname, '..', 'prisma', 'migrations');

  // Apply the first migration only, then fill the board — so everything after it, including every
  // table rebuild, runs against real rows.
  const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-staged-'));
  dirs.push(staged);
  fs.cpSync(path.join(MIGRATIONS, all[0]), path.join(staged, all[0]), { recursive: true });
  ensureSchema(p, staged);

  const seed = open(p);
  seed.exec(`INSERT INTO "Board" ("slug", "updatedAt") VALUES ('populated', datetime('now'))`);
  seed.exec(`INSERT INTO "Job" ("boardId", "name", "brief", "maxBudgetUsd", "maxTurns", "maxRetries", "updatedAt")
             VALUES (1, 'old', 'a job filed before the migration', 3.5, 7, 4, datetime('now'))`);
  seed.exec(`INSERT INTO "Attempt" ("jobId", "k", "host", "costUsd") VALUES (1, 1, 'a-host', 2.25)`);
  seed.exec(`INSERT INTO "Lease" ("jobId", "holder", "token", "expiresAt") VALUES (1, 'a-host', 't', datetime('now'))`);
  seed.exec(`INSERT INTO "Event" ("kind", "jobId") VALUES ('claimed', 1)`);
  seed.close();

  const r = ensureSchema(p);
  assert.deepEqual(r.applied, all.slice(1), 'the rest of the history ran');

  const db = open(p);
  try {
    const count = (t: string) => (db.prepare(`SELECT count(*) AS c FROM "${t}"`).get() as { c: number }).c;
    assert.equal(count('Job'), 1, 'the Job survived');
    assert.equal(count('Attempt'), 1, 'and so did its attempt — this is the one that used to vanish');
    assert.equal(count('Lease'), 1);
    assert.equal(count('Event'), 1);

    // Values, not just rows: a rebuild that copies the wrong columns loses data as quietly as one
    // that copies no rows.
    const job = db.prepare('SELECT maxBudgetUsd, maxTurns, maxRetries FROM "Job" WHERE id = 1').get() as Record<string, number>;
    assert.deepEqual(job, { maxBudgetUsd: 3.5, maxTurns: 7, maxRetries: 4 },
      'a Job filed before the columns became nullable keeps the numbers it was filed with');

    // The cap frozen onto the Attempt is NOT NULL, so every pre-existing attempt had to be
    // backfilled from its Job — the admission gate sums this column and cannot be handed a null.
    const attempt = db.prepare('SELECT costUsd, maxBudgetUsd FROM "Attempt" WHERE jobId = 1').get() as Record<string, number>;
    assert.deepEqual(attempt, { costUsd: 2.25, maxBudgetUsd: 3.5 }, 'backfilled from the Job it ran for');
  } finally {
    db.close();
  }
});

test('a migration that would leave a dangling reference is rolled back, not committed', () => {
  // The price of turning foreign keys off for the duration: nothing else would notice. The check
  // runs before the commit, so the answer is a refusal rather than a corrupt board.
  const p = scratch();
  ensureSchema(p);
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-bad-'));
  dirs.push(bad);
  fs.mkdirSync(path.join(bad, '99999999999999_orphan'));
  fs.writeFileSync(
    path.join(bad, '99999999999999_orphan', 'migration.sql'),
    `INSERT INTO "Job" ("id", "boardId", "name", "brief", "updatedAt")
     VALUES (1, 4242, 'orphan', 'points at a board that does not exist', datetime('now'));`,
  );

  assert.throws(
    () => ensureSchema(p, bad),
    /referring to a parent that is not there/,
    'and the message says the board was left alone',
  );
  const db = open(p);
  try {
    assert.equal((db.prepare('SELECT count(*) AS c FROM "Job"').get() as { c: number }).c, 0, 'nothing was written');
  } finally {
    db.close();
  }
});
