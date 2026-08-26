// The heartbeat, both ways. The lock ref lives in a real bare repo in a temp dir (git is the only
// thing that can tell us whether a lease really held), the issue side is the in-memory GitHub.
// What must be true: a ref-CAS beat costs GitHub nothing, and a rejected lease stops the worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { heartbeat, complete } from '../src/lifecycle.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { localBeatSha, listBeatChains } from '../src/lock.js';
import { FakeGh, kbIssue, runWith } from './fake-gh.js';

const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();
const LOCK = 'refs/kb/locks/7/1';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** A worker's worktree with a real `origin`, a claimed lock ref, and one running attempt. */
function harness({ mode = 'auto', attempt = { }, env = {} } = {}) {
  const gh = new FakeGh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-beat-'));
  const origin = path.join(dir, 'origin.git');
  const root = path.join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'init', '-q', '-b', 'main', root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'hi\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-qm', 'init');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '-q', 'origin', 'main');
  const base = git(root, 'rev-parse', 'HEAD');

  // what the dispatcher's claim does: create the ref, record the sha it starts the chain at
  git(root, 'push', '-q', 'origin', `${base}:${LOCK}`);
  gh.refs.set(LOCK, base);
  const run = runWith([{ attempt: 1, host: 'test-host', started_at: ago(1800), heartbeat_at: ago(1800), lock_sha: base, ...attempt }]);
  gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', run }));

  const cfg = { ...DEFAULT_BOARD, repo: gh.nameWithOwner, profiles: { claude: { ...DEFAULT_BOARD.profiles.claude, heartbeat: mode } } };
  const ctx = { root, cfg, repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner }, board: 'default', host: 'test-host', json: false, caps: {}, _cache: {}, requireBoard() { return this; } };
  const restore = gh.install();
  const saved = { ...process.env };
  Object.assign(process.env, { KB_ATTEMPT: '', KB_PROFILE: 'claude', ...env });

  const remoteSha = () => (git(root, 'ls-remote', 'origin', LOCK).split('\t')[0] || null) || null;
  return {
    gh, ctx, root, origin, base, remoteSha,
    /** the dispatcher reclaimed: the ref is deleted on both sides */
    reclaim: () => { git(root, 'push', '-q', 'origin', '--delete', LOCK); gh.refs.delete(LOCK); },
    /** keep the in-memory GitHub in step with the real remote */
    sync: () => gh.refs.set(LOCK, remoteSha()),
    cleanup: () => { restore(); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('a ref beat advances the lock ref by an empty commit and writes nothing to GitHub', async (t) => {
  const h = harness();
  t.after(h.cleanup);

  const r = await heartbeat(h.ctx, 7);

  assert.equal(r.mode, 'ref');
  assert.equal(r.ref, LOCK);
  assert.equal(r.expected, h.base);
  assert.equal(h.remoteSha(), r.sha, 'the remote ref moved to the new commit');
  assert.equal(git(h.root, 'rev-parse', `${r.sha}^`), h.base, 'the new commit sits on top of the old one');
  assert.equal(git(h.root, 'rev-parse', `${r.sha}^{tree}`), git(h.root, 'rev-parse', `${h.base}^{tree}`), 'and changes nothing');
  assert.equal(localBeatSha(h.root, 7, 1), r.sha, 'the worktree remembers where its chain is');
  // the whole point: no content write, and the run record is untouched
  assert.equal(h.gh.callsMatching('POST', /comments/).length, 0);
  assert.equal(h.gh.callsMatching('PATCH').length, 0);
  assert.ok(Date.now() - new Date(h.gh.runOf(7).attempts[0].heartbeat_at).getTime() > 600_000, 'heartbeat_at in the run record is left alone');
});

test('a warm worker beats with zero GitHub calls at all', async (t) => {
  const h = harness({ env: { KB_ATTEMPT: '1' } });
  t.after(h.cleanup);

  const first = await heartbeat(h.ctx, 7); // bootstraps the chain (reads the task + run record)
  const calls = h.gh.calls.length;
  const second = await heartbeat(h.ctx, 7);

  assert.equal(h.gh.calls.length, calls, 'the warm path talks to git, not to GitHub');
  assert.equal(second.expected, first.sha, 'and chains onto its own last beat');
  assert.equal(h.remoteSha(), second.sha);
});

test('LOCK_LOST: the dispatcher reclaimed the task, so the lease is rejected', async (t) => {
  const h = harness({ env: { KB_ATTEMPT: '1' } });
  t.after(h.cleanup);
  await heartbeat(h.ctx, 7);

  h.reclaim();

  await assert.rejects(() => heartbeat(h.ctx, 7), (e) => {
    assert.equal(e.exitCode, 3);
    assert.match(e.message, /^LOCK_LOST: refs\/kb\/locks\/7\/1 is gone/);
    assert.match(e.message, /do not commit, do not call complete/);
    return true;
  });
  assert.equal(h.remoteSha(), null, 'and the worker did not resurrect the ref');
});

test('LOCK_LOST on the very first beat, before this worktree has a chain', async (t) => {
  const h = harness();
  t.after(h.cleanup);
  h.reclaim();

  await assert.rejects(() => heartbeat(h.ctx, 7), (e) => e.exitCode === 3 && /LOCK_LOST/.test(e.message));
});

test('a lease rejected while GitHub still shows the ref resyncs the chain, it does not stop the worker', async (t) => {
  const h = harness({ env: { KB_ATTEMPT: '1' } });
  t.after(h.cleanup);
  const first = await heartbeat(h.ctx, 7);
  h.sync();
  // the push landed but `update-ref` did not: this worktree's chain is behind the ref it still owns
  git(h.root, 'update-ref', LOCK, h.base);

  const r = await heartbeat(h.ctx, 7);

  assert.equal(r.mode, 'ref');
  assert.equal(r.resynced, true);
  assert.equal(r.expected, first.sha, 'it leased on what GitHub said, not on the stale local chain');
  assert.equal(h.remoteSha(), r.sha);
  assert.equal(h.gh.callsMatching('POST', /comments/).length, 0);
});

test('profile heartbeat "comment": the run record is written and the lock ref never moves', async (t) => {
  const h = harness({ mode: 'comment', env: { KB_ATTEMPT: '1' } });
  t.after(h.cleanup);

  const r = await heartbeat(h.ctx, 7);

  assert.equal(r.mode, 'comment');
  assert.equal(h.remoteSha(), h.base, 'no CAS push');
  assert.ok(new Date(h.gh.runOf(7).attempts[0].heartbeat_at).getTime() > Date.now() - 60_000);
});

test('comment mode still detects a reclaim: the ref is gone → LOCK_LOST', async (t) => {
  const h = harness({ mode: 'comment' });
  t.after(h.cleanup);
  h.reclaim();

  await assert.rejects(() => heartbeat(h.ctx, 7), (e) => e.exitCode === 3 && /LOCK_LOST/.test(e.message));
});

test('git cannot reach the remote: the beat falls back to the run comment, and says so', async (t) => {
  const h = harness({ env: { KB_ATTEMPT: '1' } });
  t.after(h.cleanup);
  git(h.root, 'remote', 'set-url', 'origin', path.join(h.root, 'nope.git'));

  const r = await heartbeat(h.ctx, 7);

  assert.equal(r.mode, 'comment');
  assert.match(r.fallback, /nope\.git|does not appear to be a git repository/i, 'the fallback names what git could not do');
  assert.ok(new Date(h.gh.runOf(7).attempts[0].heartbeat_at).getTime() > Date.now() - 60_000);
});

test('the 10-minute floor still applies to comment beats, and a note always gets through', async (t) => {
  const h = harness({ mode: 'comment', attempt: { heartbeat_at: ago(30) } });
  t.after(h.cleanup);

  const skipped = await heartbeat(h.ctx, 7);
  assert.equal(skipped.skipped, true);
  assert.ok(skipped.next_in_s > 0 && skipped.next_in_s <= 600);

  const noted = await heartbeat(h.ctx, 7, { note: 'still rebasing' });
  assert.equal(noted.skipped, undefined);
  assert.equal(h.gh.runOf(7).attempts[0].note, 'still rebasing');
});

test('a note takes the comment path even for a ref-CAS worker', async (t) => {
  const h = harness({ env: { KB_ATTEMPT: '1' } });
  t.after(h.cleanup);

  const r = await heartbeat(h.ctx, 7, { note: 'compiling' });

  assert.equal(r.mode, 'comment');
  assert.equal(h.remoteSha(), h.base);
  assert.equal(h.gh.runOf(7).attempts[0].note, 'compiling');
});

test('a terminal verb takes the beat chain with it — worktrees share one ref store', async (t) => {
  const h = harness({ env: { KB_ATTEMPT: '1' } });
  t.after(h.cleanup);
  await heartbeat(h.ctx, 7);
  assert.deepEqual(listBeatChains(h.root).map((c) => c.ref), [LOCK]);

  await complete(h.ctx, 7, { summary: 'done' });

  assert.equal(localBeatSha(h.root, 7, 1), null);
  assert.deepEqual(listBeatChains(h.root), []);
  assert.equal(h.gh.statusOf(7), 'done');
});

test('no open attempt is a usage error, not a lock error', async (t) => {
  const h = harness({ attempt: { ended_at: ago(10), outcome: 'completed' } });
  t.after(h.cleanup);

  await assert.rejects(() => heartbeat(h.ctx, 7), (e) => e.exitCode === 2 && /no active attempt/.test(e.message));
});
