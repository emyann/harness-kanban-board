import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Resume, against the real SDK.
 *
 * `nextPhase` keeps `lastSessionId` for the three resumable stops and `reconcile` passes it as
 * `resume`, and until this ran nothing had ever exercised that path against a real session — the
 * fake runtime cannot, because there is no session to continue.
 *
 * Skipped unless `HKB_LIVE_SDK=1`: it spends money and needs the network, and CI must stay free
 * and deterministic. Run it by hand when the runtime changes.
 */
const live = process.env.HKB_LIVE_SDK === '1';

test('a turn cap leaves a session, and the retry continues it rather than starting cold',
  { skip: live ? false : 'set HKB_LIVE_SDK=1 to run against the real SDK' },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-resume-'));
    process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'resume.db')}`;
    const REPO = path.resolve(import.meta.dirname, '..');
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
      cwd: REPO, env: process.env, stdio: 'ignore',
    });

    const { openBoard, closeBoard } = await import('../src/db.ts');
    const { reconcile } = await import('../src/controller.ts');
    const { claudeRuntime } = await import('../src/runtime/claude.ts');
    const db = openBoard();

    try {
      const board = await db.board.upsert({ where: { slug: 'resume' }, update: {}, create: { slug: 'resume' } });
      const job = await db.job.create({
        data: {
          boardId: board.id, name: 'resumable', isolate: false, maxRetries: 2,
          maxTurns: 1, maxBudgetUsd: 1, effort: 'low', timeoutMs: 120_000,
          brief: 'Read package.json, then README.md, then CLAUDE.md, and say how many lines each has.',
        },
      });
      const run = () => reconcile({ runtime: claudeRuntime, cwd: REPO, board: 'resume', readPr: false });

      await run();
      const first = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
      assert.equal(first.attempts[0].outcome, 'max_turns', 'one turn cannot finish three reads');
      assert.ok(first.lastSessionId, 'a resumable stop keeps the session');
      assert.equal(first.phase, 'pending', 'and the Job is queued for another go');

      // Raise the cap so the retry can finish, and let it resume.
      await db.job.update({ where: { id: job.id }, data: { maxTurns: 12 } });
      await run();

      const second = await db.job.findUniqueOrThrow({
        where: { id: job.id }, include: { attempts: { orderBy: { k: 'asc' } } },
      });
      assert.equal(second.attempts.length, 2);
      assert.equal(second.attempts[1].sessionId, first.lastSessionId,
        'the retry continued the same session — resume is not restart');
      assert.equal(second.phase, 'succeeded');
      assert.equal(second.lastSessionId, null, 'a finished Job has nothing left to resume');
    } finally {
      await closeBoard();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
