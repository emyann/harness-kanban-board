import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBackgroundedId, classifyJob, jobName, KB_JOB_NAME_RE } from '../src/model.js';

test('parseBackgroundedId reads the id from claude --bg output, ANSI included', () => {
  const out = 'backgrounded · \x1b[36m57dcb260\x1b[39m · kb #13 · Terminal verbs\n\x1b[2m  claude agents  list sessions\x1b[22m\n';
  assert.equal(parseBackgroundedId(out), '57dcb260');
  assert.equal(parseBackgroundedId('nothing here'), null);
  assert.equal(parseBackgroundedId(''), null);
});

test('classifyJob: working → running; done/idle/gone → protocol_violation; missing → crashed', () => {
  assert.equal(classifyJob({ state: 'working' }), 'running');
  assert.equal(classifyJob({ status: 'busy' }), 'running');
  assert.equal(classifyJob({ state: 'done', status: 'idle', pid: 123 }), 'protocol_violation');
  assert.equal(classifyJob({ state: 'done' }), 'protocol_violation');
  assert.equal(classifyJob(null), 'crashed');
});

test('matchJobByWorktree matches on cwd basename', async () => {
  const { matchJobByWorktree } = await import('../src/jobs.js');
  const jobs = [
    { id: 'a1', cwd: '/repo/.claude/worktrees/kb-15-1' },
    { id: 'b2', cwd: '/repo' },
  ];
  assert.equal(matchJobByWorktree(jobs, 'kb-15-1').id, 'a1');
  assert.equal(matchJobByWorktree(jobs, 'kb-15-2'), null);
  assert.equal(matchJobByWorktree([], 'kb-1-1'), null);
});

test('job names round-trip through the listing regex', () => {
  const name = jobName({ number: 13, title: 'Terminal verbs must be easy · really' });
  const m = KB_JOB_NAME_RE.exec(name);
  assert.equal(Number(m[1]), 13);
  assert.equal(KB_JOB_NAME_RE.test('kb probe · sleep'), false);
});
