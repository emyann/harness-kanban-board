// The reap step: which background agents a tick stops. The decision is pure, so it is unit-tested
// first; then a whole tick runs against the in-memory GitHub (test/fake-gh.js) with `claude` itself
// stubbed on PATH — `claude agents --json` lists the jobs the test wants and `claude stop <id>`
// records what the dispatcher killed, so the assertion is on real `claude stop` calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tick, reapDecision } from '../src/dispatch.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { FakeGh, kbIssue, runWith } from './fake-gh.js';

const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

// ---------- the decision ----------

const job = (extra = {}) => ({ id: 'j1', pid: 4242, task: 7, ...extra });
const card = (status) => ({ number: 7, status });
const onPrompt = { state: 'blocked', status: 'waiting' }; // verified shape of a permission prompt
const finishedTurn = { state: 'done', status: 'idle' };

test('a closed task ends its agent, whatever the agent says it is doing', () => {
  assert.match(reapDecision(job(onPrompt), null), /closed/);
  assert.match(reapDecision(job({ state: 'working' }), null), /closed/);
  assert.match(reapDecision(job(finishedTurn), null), /closed/);
});

test('a done or archived card ends its agent too — nobody will answer that prompt', () => {
  assert.match(reapDecision(job(onPrompt), card('done')), /done/);
  assert.match(reapDecision(job({ status: 'busy' }), card('archived')), /archived/);
});

test('a running card keeps its agent: blocked means "on a prompt", not "dead"', () => {
  assert.equal(reapDecision(job(onPrompt), card('running')), null);
  assert.equal(reapDecision(job({ state: 'working' }), card('running')), null);
  // even a finished-looking job: the reclaim step owns a running card and calls it protocol_violation
  assert.equal(reapDecision(job(finishedTurn), card('running')), null);
});

test('on any other live status only a working agent is spared', () => {
  assert.equal(reapDecision(job({ state: 'working' }), card('review')), null);
  assert.equal(reapDecision(job({ status: 'busy' }), card('ready')), null);
  assert.match(reapDecision(job(onPrompt), card('ready')), /not working/);
  assert.match(reapDecision(job(onPrompt), card('review')), /review/);
  assert.match(reapDecision(job(finishedTurn), card('blocked')), /blocked/);
});

test('a job with no pid is already gone: nothing to stop', () => {
  assert.equal(reapDecision(job({ pid: null, ...onPrompt }), null), null);
  assert.equal(reapDecision(null, null), null);
});

// ---------- a whole tick ----------

const bgJob = ({ id, task, cwd = null, ...state }) => ({
  kind: 'background', id, pid: 1000 + task, name: `kb #${task} · task ${task}`,
  cwd: cwd || `/repo/.claude/worktrees/kb-${task}-1`, ...state,
});

/**
 * Put a `claude` on PATH that answers the two calls src/jobs.js makes: `agents --json` prints the
 * given listing, `stop <id>` records the id (and fails for the ids in `failStop`, so the "could not
 * stop" path is exercised too).
 */
function stubClaude(root, jobs, failStop = []) {
  const bin = path.join(root, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  const listing = path.join(bin, 'agents.json');
  const stopped = path.join(bin, 'stopped.txt');
  const nostop = path.join(bin, 'nostop.txt');
  fs.writeFileSync(listing, JSON.stringify(jobs));
  fs.writeFileSync(stopped, '');
  fs.writeFileSync(nostop, failStop.map((id) => `${id}\n`).join(''));
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'case "$1" in',
    `  agents) cat ${JSON.stringify(listing)} ;;`,
    `  stop) grep -qx "$2" ${JSON.stringify(nostop)} && exit 1; echo "$2" >> ${JSON.stringify(stopped)} ;;`,
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prev}`;
  return {
    stopped: () => fs.readFileSync(stopped, 'utf8').split('\n').filter(Boolean).sort(),
    restore: () => { process.env.PATH = prev; },
  };
}

function harness({ jobs = [], failStop = [], host = 'test-host' } = {}) {
  const gh = new FakeGh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-reap-'));
  const cfg = {
    ...DEFAULT_BOARD,
    repo: gh.nameWithOwner,
    board: 'default',
    // a `claude-bg` profile is what makes the tick list jobs at all; nothing is ever spawned here
    profiles: { claude: { mode: 'claude-bg', max_in_progress: 2, model: null, allowed_tools: [], launch: ['true'] } },
  };
  const ctx = {
    root,
    cfg,
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default',
    host,
    json: false,
    caps: {},
    _cache: {},
    requireBoard() { return this; },
  };
  const restore = gh.install();
  const claude = stubClaude(root, jobs, failStop);
  const logs = [];
  return {
    gh,
    ctx,
    stopped: claude.stopped,
    log: () => logs.join('\n'),
    // max: 0 — no slot, so this tick reclaims and reaps but claims nothing
    tick: (opts = {}) => tick(ctx, { max: 0, log: (m) => logs.push(m), ...opts }),
    cleanup: () => { restore(); claude.restore(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

test('a tick stops the agents of closed and finished tasks — blocked or not — and only those', async (t) => {
  const h = harness({
    jobs: [
      bgJob({ id: 'j7', task: 7, ...onPrompt }), //  merged and closed: the 15-hour zombie (#17, #21)
      bgJob({ id: 'j8', task: 8, ...onPrompt }), //  done, issue still open
      bgJob({ id: 'j9', task: 9, ...onPrompt }), //  running: a live worker on a permission prompt
      bgJob({ id: 'j10', task: 10, state: 'working', status: 'busy' }), // review: still writing its last turn
      bgJob({ id: 'j11', task: 11, ...onPrompt }), // ready: nobody is coming to answer it
      bgJob({ id: 'j12', task: 12, pid: null, ...finishedTurn }), // already exited
    ],
  });
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 7, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude' }));
  h.gh.addIssue(kbIssue({ number: 8, status: 'done', agent: 'claude' }));
  h.gh.addIssue(kbIssue({ number: 9, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 }, run: runWith([{ attempt: 1, host: 'test-host', started_at: ago(120), heartbeat_at: ago(30), bg: true, job: 'j9' }]) }));
  h.gh.addIssue(kbIssue({ number: 10, status: 'review', agent: 'claude' }));
  h.gh.addIssue(kbIssue({ number: 11, status: 'ready', agent: 'claude' }));
  h.gh.addIssue(kbIssue({ number: 12, status: 'done', agent: 'claude' }));

  const s = await h.tick();

  assert.deepEqual(h.stopped(), ['j11', 'j7', 'j8']);
  assert.deepEqual(s.reaped.map((r) => r.number).sort((a, b) => a - b), [7, 8, 11]);
  assert.deepEqual(s.reclaimed, []); // the live worker was not reclaimed either
  assert.equal(h.gh.statusOf(9), 'running');
  assert.match(h.log(), /#7: stopped background agent j7 — its task is closed/);
  assert.match(h.log(), /#8: stopped background agent j8 — its task is done/);
});

test('a stop that fails is reported, not counted, and left for the next tick', async (t) => {
  const h = harness({ jobs: [bgJob({ id: 'j7', task: 7, ...onPrompt })], failStop: ['j7'] });
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 7, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude' }));

  const s = await h.tick();

  assert.deepEqual(s.reaped, []);
  assert.deepEqual(h.stopped(), []);
  assert.match(h.log(), /#7: could not stop background agent j7 .* retrying next tick/);
});

test('a dry run never stops anything', async (t) => {
  const h = harness({ jobs: [bgJob({ id: 'j7', task: 7, ...onPrompt })] });
  t.after(h.cleanup);
  h.gh.addIssue(kbIssue({ number: 7, status: 'done', state: 'CLOSED', stateReason: 'COMPLETED', agent: 'claude' }));

  const s = await h.tick({ dryRun: true });

  assert.deepEqual(s.reaped, []);
  assert.deepEqual(h.stopped(), []);
});
