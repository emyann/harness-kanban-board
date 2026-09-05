import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { Runtime, WorkerOutcome, WorkerSpec } from '../src/runtime/index.ts';

// A scratch database per run, migrated the same way production is.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-ctl-'));
process.env.HKB_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
const REPO = path.resolve(import.meta.dirname, '..');
execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
  cwd: REPO, env: process.env, stdio: 'ignore',
});

const { openBoard, closeBoard } = await import('../src/db.ts');
const { reconcile, reconcileToRest, nextPhase, withDeclaredOutputs } = await import('../src/controller.ts');
const { fakeRuntime } = await import('../src/runtime/fake.ts');
const { admissionCallback } = await import('../src/admission.ts');

const db = openBoard();
const board = await db.board.upsert({ where: { slug: 'test' }, update: {}, create: { slug: 'test' } });
const cwd = REPO;

const mkJob = (name: string, extra: Record<string, unknown> = {}) =>
  db.job.create({ data: { boardId: board.id, name, brief: `do ${name}`, ...extra } });

test.after(async () => { await closeBoard(); fs.rmSync(dir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- the pure decision

test('nextPhase: a completed run succeeds and is not resumable', () => {
  const d = nextPhase({ status: 'completed' } as never, 1, 2);
  assert.equal(d.phase, 'succeeded');
  assert.equal(d.resumable, false);
});

test('nextPhase: a turn cap is resumable and retries while budget remains', () => {
  const d = nextPhase({ status: 'max_turns' } as never, 1, 2);
  assert.equal(d.phase, 'pending');
  assert.equal(d.outcome, 'max_turns');
  assert.equal(d.resumable, true, 'a turn cap left a session worth continuing');
});

test('nextPhase: maxRetries 2 means three attempts, then failed', () => {
  assert.equal(nextPhase({ status: 'crashed' } as never, 1, 2).phase, 'pending');
  assert.equal(nextPhase({ status: 'crashed' } as never, 2, 2).phase, 'pending');
  assert.equal(nextPhase({ status: 'crashed' } as never, 3, 2).phase, 'failed', 'out of retries');
});

test('nextPhase: a wall-clock timeout is OUR stop, and it is resumable', () => {
  const d = nextPhase({ status: 'timeout' } as never, 1, 2);
  assert.equal(d.outcome, 'timed_out');
  assert.equal(d.phase, 'pending');
  assert.equal(d.resumable, true, 'the clock ran out, not the work — the session is worth continuing');
});

test('nextPhase: a refusal never retries — the same brief gets the same answer', () => {
  const d = nextPhase({ status: 'refused' } as never, 1, 5);
  assert.equal(d.phase, 'failed');
  assert.equal(d.resumable, false);
});

test('nextPhase: a runtime that threw is a crash, not a success', () => {
  assert.equal(nextPhase(null, 1, 2).outcome, 'crashed');
});

// ---------------------------------------------------------------- the loop

test('a pending job runs, succeeds, and records the session pointer', async () => {
  const job = await mkJob('happy');
  const r = await reconcile({ runtime: fakeRuntime(), cwd });
  assert.deepEqual(r.succeeded, [job.id]);

  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'succeeded');
  assert.equal(after.attempts.length, 1);
  assert.ok(after.attempts[0].sessionId, 'the session id is the one SDK fact we keep');
  assert.equal(after.finishedAt !== null, true);
});

test('the lease is released when the attempt ends', async () => {
  const job = await mkJob('lease-released');
  await reconcile({ runtime: fakeRuntime(), cwd });
  assert.equal(await db.lease.findUnique({ where: { jobId: job.id } }), null);
});

test('a failing job retries up to maxRetries, then fails', async () => {
  const job = await mkJob('flaky', { maxRetries: 2 });
  await reconcileToRest({ runtime: fakeRuntime({ failTasks: [job.id] }), cwd });
  const after = await db.job.findUniqueOrThrow({ where: { id: job.id }, include: { attempts: true } });
  assert.equal(after.phase, 'failed');
  assert.equal(after.attempts.length, 3, '1 initial + 2 retries');
});

test('known contention is refused by the gate before any claim is attempted', async () => {
  const job = await mkJob('contended');
  // somebody else got there first and still holds it; maxConcurrent is 1
  await db.lease.create({
    data: { jobId: job.id, holder: 'other-host', token: 't', expiresAt: new Date(Date.now() + 600_000) },
  });
  const r = await reconcile({ runtime: fakeRuntime(), cwd, board: 'test' });
  assert.match(r.refused ?? '', /concurrent slots/, 'the cheap check catches it first');
  assert.ok(!r.claimed.includes(job.id));
  assert.equal((await db.attempt.count({ where: { jobId: job.id } })), 0, 'and runs nothing');
  await db.lease.delete({ where: { jobId: job.id } });
});

test('a genuine race is lost at the compare-and-swap, not at the gate', async () => {
  // Room to spare, so the gate admits — and the lease insert is then the only thing standing
  // between two processes and a double run. This is the path the gate cannot cover: two hosts
  // that both read "one slot free" in the same instant.
  const board = await db.board.findFirstOrThrow({ where: { slug: 'test' } });
  await db.board.update({ where: { id: board.id }, data: { maxConcurrent: 5 } });
  const job = await mkJob('raced');
  await db.lease.create({
    data: { jobId: job.id, holder: 'won-the-race', token: 't', expiresAt: new Date(Date.now() + 600_000) },
  });

  const r = await reconcile({ runtime: fakeRuntime(), cwd, board: 'test' });
  assert.equal(r.refused, null, 'the gate had no objection');
  assert.ok(r.skipped.includes(job.id), 'the loser skips rather than throwing');
  assert.equal((await db.attempt.count({ where: { jobId: job.id } })), 0, 'and runs nothing');

  await db.lease.delete({ where: { jobId: job.id } });
  await db.board.update({ where: { id: board.id }, data: { maxConcurrent: 1 } });
});

test('an expired lease is reclaimed and its orphaned attempt is marked lost', async () => {
  const job = await mkJob('abandoned');
  await db.job.update({ where: { id: job.id }, data: { phase: 'running' } });
  await db.attempt.create({ data: { jobId: job.id, k: 1, host: 'dead-host' } });
  await db.lease.create({
    data: { jobId: job.id, holder: 'dead-host', token: 't', expiresAt: new Date(Date.now() - 1000) },
  });

  const r = await reconcile({ runtime: fakeRuntime(), cwd });
  assert.ok(r.reclaimed.includes(job.id));
  const orphan = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } });
  assert.equal(orphan.outcome, 'lost', 'nobody ever reported it');
  assert.ok(orphan.endedAt);
});

test('reconcile is idempotent: a second pass on a settled board does nothing', async () => {
  await mkJob('settle-me');
  await reconcileToRest({ runtime: fakeRuntime(), cwd });
  const r = await reconcile({ runtime: fakeRuntime(), cwd });
  assert.deepEqual(r.claimed, []);
  assert.deepEqual(r.reclaimed, []);
});

// ---------------------------------------------------------------- declared outputs (ADR-008)

test('withDeclaredOutputs: a completed run that skipped a declared output does not succeed', () => {
  const d = withDeclaredOutputs({ phase: 'succeeded', outcome: 'completed', resumable: false }, ['gone'], 1, 2);
  assert.equal(d.phase, 'pending', 'a retry remains');
  assert.equal(d.outcome, 'missing_output');
  assert.equal(withDeclaredOutputs({ phase: 'succeeded', outcome: 'completed', resumable: false }, ['gone'], 3, 2).phase,
    'failed', 'and out of retries it is a failure, not a success');
});

test('withDeclaredOutputs: nothing missing changes nothing', () => {
  const ok = { phase: 'succeeded', outcome: 'completed', resumable: false } as const;
  assert.deepEqual(withDeclaredOutputs(ok, [], 1, 2), ok);
});

test('withDeclaredOutputs: a session that already failed keeps its own account of why', () => {
  const capped = { phase: 'pending', outcome: 'max_turns', resumable: true } as const;
  assert.deepEqual(withDeclaredOutputs(capped, ['gone'], 1, 2), capped,
    '"it ran out of turns" beats "it did not write the file", and it is the resumable one');
});

/**
 * A real repository for the export path, because every interesting part of it is git's or the
 * filesystem's: the worktree is cut for real, the worker writes for real, and the worktree is torn
 * down for real. A double would agree with whatever the code did.
 */
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-exp-repo-'));
const g = (args: string[], at = repo) => spawnSync('git', args, { cwd: at, encoding: 'utf8' });
g(['init', '-q', '-b', 'main']);
g(['config', 'user.email', 'exp@test']);
g(['config', 'user.name', 'exp']);
fs.writeFileSync(path.join(repo, 'README.md'), '# base\n');
g(['add', '-A']);
g(['commit', '-qm', 'base']);
const exportBoard = await db.board.create({ data: { slug: 'exporting', repoPath: repo } });
test.after(() => fs.rmSync(repo, { recursive: true, force: true }));

/** A worker that writes the files it is given into its own checkout, and nothing else. */
const writes = (files: Record<string, string>): Runtime => ({
  name: 'writer',
  async run(spec: WorkerSpec): Promise<WorkerOutcome> {
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(spec.cwd, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
    return {
      status: 'completed', ok: true, sessionId: `w-${spec.taskId}`, text: 'done',
      costUsd: 0, turns: 1, durationMs: 0, stopReason: 'end_turn', denials: 0, error: null,
    };
  },
});

const wtDir = (jobId: number, k: number) => path.join(repo, '.kanban', 'worktrees', `kb-${jobId}-${k}`);

test('a declared export lands in the board repository, and the worktree is then removed', async () => {
  const job = await db.job.create({
    data: {
      boardId: exportBoard.id, name: 'exporter', brief: 'write the report',
      exports: JSON.stringify(['out/report.json']),
    },
  });

  const r = await reconcile({
    runtime: writes({ 'out/report.json': '{"ok":true}' }), board: 'exporting', readPr: false,
  });
  assert.deepEqual(r.succeeded, [job.id], 'it produced what it declared');

  assert.equal(fs.readFileSync(path.join(repo, 'out', 'report.json'), 'utf8'), '{"ok":true}',
    'the artifact is in the execroot, not stranded in a sandbox');
  assert.equal(fs.existsSync(wtDir(job.id, 1)), false,
    'and the sandbox is gone — the 6.1 GB Phase 5 left came from refusing this');

  const a = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } });
  assert.equal(a.outcome, 'completed');
  assert.deepEqual(JSON.parse(a.exported ?? 'null'), ['out/report.json'],
    'the worktree is gone, so nothing else can say where this file came from');
});

test('a declared export the worker did not produce fails the attempt', async () => {
  const job = await db.job.create({
    data: {
      boardId: exportBoard.id, name: 'forgetful', brief: 'write the report', maxRetries: 0,
      exports: JSON.stringify(['out/promised.json']),
    },
  });

  const r = await reconcile({
    runtime: writes({ 'something-else.txt': 'not what was asked for' }),
    board: 'exporting', readPr: false,
  });
  assert.deepEqual(r.failed, [job.id], 'a session that ended is not a job that was done');
  assert.deepEqual(r.succeeded, []);

  const a = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } });
  assert.equal(a.outcome, 'missing_output');
  assert.match(a.reason ?? '', /was not produced/, 'and the row says which path');
  assert.equal(a.exported, null);
  assert.equal(fs.existsSync(path.join(repo, 'something-else.txt')), false,
    'an undeclared output is litter — it does not come out with the declared ones');
});

test('a declared path that escapes the worktree is refused, not copied', async () => {
  // Written straight onto the row: `kb new --export` refuses this at the door, so the only way to
  // get here is past the CLI — and the guard that matters is the one the controller enforces.
  const job = await db.job.create({
    data: {
      boardId: exportBoard.id, name: 'escapee', brief: 'reach outside', maxRetries: 0,
      exports: JSON.stringify(['../../stolen.txt']),
    },
  });

  const r = await reconcile({
    runtime: writes({ '../../stolen.txt': 'reached out of the sandbox' }),
    board: 'exporting', readPr: false,
  });
  assert.deepEqual(r.failed, [job.id]);

  const a = await db.attempt.findUniqueOrThrow({ where: { jobId_k: { jobId: job.id, k: 1 } } });
  assert.equal(a.outcome, 'missing_output');
  assert.match(a.reason ?? '', /escapes the worktree/);
  assert.equal(fs.existsSync(path.join(repo, 'stolen.txt')), false,
    'a declared output is not a licence to write anywhere');
});

// ---------------------------------------------------------------- admission
// The gate is a PreToolUse hook, not canUseTool: `bypassPermissions` and bare `allowedTools`
// entries both shadow canUseTool, and the SDK says so in a warning. Verified against the real
// SDK: a parent that omits isolation gets it injected.

const pre = (tool: string, input: Record<string, unknown>) =>
  ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't1' }) as never;
const spec = (r: Awaited<ReturnType<ReturnType<typeof admissionCallback>>>) =>
  (r as { hookSpecificOutput?: Record<string, unknown> }).hookSpecificOutput ?? {};

test('admission injects isolation onto an Agent spawn that omitted it', async () => {
  const gate = admissionCallback({});
  const o = spec(await gate(pre('Agent', { prompt: 'go', subagent_type: 'worker' })));
  assert.equal(o.permissionDecision, 'allow');
  assert.equal((o.updatedInput as Record<string, unknown>).isolation, 'worktree',
    'not asked for in a prompt — injected');
});

test('admission leaves an already-isolated spawn alone', async () => {
  const gate = admissionCallback({});
  const o = spec(await gate(pre('Agent', { prompt: 'go', isolation: 'worktree' })));
  assert.equal(o.permissionDecision, 'allow');
  assert.equal(o.updatedInput, undefined, 'nothing to change');
});

test('a policy can refuse a spawn, and the model is told why', async () => {
  const gate = admissionCallback({
    admitSpawn: (input) => (String(input.description ?? '').includes('#2') ? '#2 is blocked by #1' : null),
  });
  const denied = spec(await gate(pre('Agent', { description: '#2 do the join' })));
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(String(denied.permissionDecisionReason), /blocked by #1/);

  const allowed = spec(await gate(pre('Agent', { description: '#1 do the root' })));
  assert.equal(allowed.permissionDecision, 'allow');
});

test('the allowlist is enforced by the hook, not by the permission mode', async () => {
  // Measured: a nested session ran `Agent` under permissionMode dontAsk with Agent absent from
  // allowedTools. Hooks run first and are client-side, so this is the layer that actually holds.
  const gate = admissionCallback({ allow: ['Read', 'Bash'] });
  const denied = spec(await gate(pre('Agent', { prompt: 'fan out' })));
  assert.equal(denied.permissionDecision, 'deny');
  assert.match(String(denied.permissionDecisionReason), /tool surface/);
  assert.equal(spec(await gate(pre('Read', { file_path: 'x' }))).permissionDecision, 'allow');
});

test('no allowlist means the hook enforces none — the mode decides', async () => {
  const gate = admissionCallback({});
  assert.equal(spec(await gate(pre('Bash', { command: 'ls' }))).permissionDecision, 'allow');
});

test('admission denies a tool the workload may never use', async () => {
  const gate = admissionCallback({ deny: ['WebFetch'] });
  assert.equal(spec(await gate(pre('WebFetch', {}))).permissionDecision, 'deny');
  assert.equal(spec(await gate(pre('Read', {}))).permissionDecision, 'allow');
});

test('a non-PreToolUse event is not the gate\'s business', async () => {
  const gate = admissionCallback({ deny: ['Read'] });
  const r = await gate({ hook_event_name: 'PostToolUse', tool_name: 'Read' } as never);
  assert.deepEqual(r, {}, 'no opinion, rather than a wrong one');
});
