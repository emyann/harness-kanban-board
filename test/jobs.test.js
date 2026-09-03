// Background-agent jobs: reading the listing, and what the dispatcher records off it. The whole-tick
// test at the bottom runs against the in-memory GitHub (test/fake-gh.js) with `claude` stubbed on
// PATH, the way test/reap.test.js does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseBackgroundedId, classifyJob, jobName, KB_JOB_NAME_RE } from '../src/model.js';
import { matchJobByWorktree, jobSessionUpdate } from '../src/jobs.js';
import { tick } from '../src/dispatch.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { FakeGh } from './fake-gh.js';
import { FakeStore, kbIssue, runWith } from './fake-store.js';

const ago = (seconds) => new Date(Date.now() - seconds * 1000).toISOString();

test('parseBackgroundedId reads the id from claude --bg output, ANSI included', () => {
  const out = 'backgrounded · \x1b[36m57dcb260\x1b[39m · kb #13 · Terminal verbs\n\x1b[2m  claude agents  list sessions\x1b[22m\n';
  assert.equal(parseBackgroundedId(out), '57dcb260');
  assert.equal(parseBackgroundedId('nothing here'), null);
  assert.equal(parseBackgroundedId(''), null);
});

test('classifyJob: working/busy/blocked/waiting → running; done/stopped → protocol_violation; missing → crashed', () => {
  assert.equal(classifyJob({ state: 'working' }), 'running');
  assert.equal(classifyJob({ status: 'busy' }), 'running');
  assert.equal(classifyJob({ state: 'blocked', status: 'waiting', pid: 1 }), 'running'); // permission prompt — alive
  assert.equal(classifyJob({ status: 'waiting' }), 'running');
  assert.equal(classifyJob({ state: 'done', status: 'idle', pid: 123 }), 'protocol_violation');
  assert.equal(classifyJob({ state: 'stopped' }), 'protocol_violation');
  assert.equal(classifyJob(null), 'crashed');
});

test('matchJobByWorktree matches on cwd basename', () => {
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

// ---------- the session a matched job is running ----------
// A terminal verb records the session behind a `claude --bg` worker (#135). The attempts that most
// need one never run a verb — crashed, timed out, protocol_violation — so the dispatcher writes the
// same fields off the job it has already matched, one tick after the launch.

const SID = '901aaf18-1d94-4050-8268-933985d902b8';
const TRANSCRIPT = '/home/u/.claude/projects/-repo--claude-worktrees-kb-7-1/901aaf18.jsonl';

/** `~/.claude/jobs` as `claude --bg` keeps it: a directory per job, holding its state.json. */
function jobsRootWith(records, into = null) {
  const root = into || fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-jobs-'));
  for (const [id, state] of Object.entries(records)) {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    if (state) fs.writeFileSync(path.join(root, id, 'state.json'), JSON.stringify(state));
  }
  return root;
}

test('jobSessionUpdate: nothing matched → nothing; a blank row → the whole identity; a stamped row → untouched', (t) => {
  const root = jobsRootWith({ j7: { state: 'working', sessionId: SID, linkScanPath: TRANSCRIPT } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = { id: 'j7', task: 7, state: 'working' };

  // no job matched this tick: nothing to write, and no record even looked for
  assert.equal(jobSessionUpdate({ attempt: 1, bg: true }, null, root), null);
  // matched, and the row is blank: exactly what the terminal verb would have written
  assert.deepEqual(jobSessionUpdate({ attempt: 1, bg: true }, job, root), { session_id: SID, transcript_path: TRANSCRIPT });
  // matched, and a verb got there first: not one field is touched
  assert.equal(jobSessionUpdate({ attempt: 1, session_id: SID, transcript_path: TRANSCRIPT }, job, root), null);
});

test('jobSessionUpdate: fills blanks, and corrects a row that names another session', (t) => {
  const root = jobsRootWith({
    j7: { sessionId: SID, linkScanPath: TRANSCRIPT },
    j8: { state: 'working' }, // registered, but names nothing yet
    j9: null, // no record on disk at all
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // The row says one session, the job running this attempt says another. The job wins (#150): a
  // stamp on an OPEN attempt came from a Stop hook — which fires in whichever session had KB_TASK
  // in its environment, and a daemon a `claude --bg` launch started hands that to every session it
  // hosts. Both fields go together: a corrected id beside the old transcript is a row nobody can read.
  assert.deepEqual(jobSessionUpdate({ attempt: 1, session_id: 'other-sid' }, { id: 'j7' }, root),
    { session_id: SID, transcript_path: TRANSCRIPT });
  // and when the job can only name the id, the transcript that described the replaced session goes
  assert.deepEqual(jobSessionUpdate({ attempt: 1, session_id: 'other-sid', transcript_path: '/t/other.jsonl' }, { id: 'j8', sessionId: SID }, root),
    { session_id: SID, transcript_path: undefined });
  // the record says nothing yet — the id off `claude agents` still gives `hkb show` a resume line
  assert.deepEqual(jobSessionUpdate({ attempt: 1 }, { id: 'j8', sessionId: SID }, root), { session_id: SID });
  assert.deepEqual(jobSessionUpdate({ attempt: 1 }, { id: 'j9', sessionId: SID }, root), { session_id: SID });
  // and a later tick still fills in the transcript `hkb stats` prices from, once the record has it
  assert.deepEqual(jobSessionUpdate({ attempt: 1, session_id: SID }, { id: 'j7' }, root), { transcript_path: TRANSCRIPT });
  // a job nothing on this host can name
  assert.equal(jobSessionUpdate({ attempt: 1 }, { id: 'j9' }, root), null);
  assert.equal(jobSessionUpdate({ attempt: 1 }, {}, root), null);
});

// ---------- and the same thing through a whole tick ----------

const bgJob = ({ id, task, ...state }) => ({
  kind: 'background', id, pid: 1000 + task, name: `kb #${task} · task ${task}`,
  cwd: `/repo/.claude/worktrees/kb-${task}-1`, ...state,
});

/** A `claude` on PATH that answers the calls src/jobs.js makes: `agents --json` and `stop <id>`. */
function stubClaude(root, jobs) {
  const bin = path.join(root, 'stub-bin');
  fs.mkdirSync(bin, { recursive: true });
  const listing = path.join(bin, 'agents.json');
  fs.writeFileSync(listing, JSON.stringify(jobs));
  fs.writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    'case "$1" in',
    `  agents) cat ${JSON.stringify(listing)} ;;`,
    '  stop) exit 0 ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
}

/**
 * A board with one `claude-bg` profile, a stubbed `claude`, and a HOME whose `.claude/jobs` holds
 * the given records — `jobsDir()` reads $HOME, which is the only way to put a job record where the
 * dispatcher looks for one.
 */
function harness({ jobs = [], records = {} } = {}) {
  const gh = new FakeGh();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-jobsession-'));
  const home = path.join(root, 'home');
  jobsRootWith(records, path.join(home, '.claude', 'jobs'));
  const cfg = {
    ...DEFAULT_BOARD,
    repo: gh.nameWithOwner,
    board: 'default',
    profiles: { claude: { mode: 'claude-bg', max_in_progress: 2, model: null, allowed_tools: [], launch: ['true'] } },
  };
  const ctx = {
    root, cfg, repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {}, requireBoard() { return this; },
  };
  const restore = gh.install();
  const store = new FakeStore();
  const restoreStore = store.install(ctx);
  const savedEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.HOME = home;
  stubClaude(root, jobs);
  const logs = [];
  return {
    gh, store, ctx,
    log: () => logs.join('\n'),
    tick: (opts = {}) => tick(ctx, { max: 0, log: (m) => logs.push(m), ...opts }),
    cleanup: () => {
      restoreStore(); restore();
      Object.assign(process.env, savedEnv);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** #7, running on this host as background job j7 — the job the listing and the records describe. */
function running(extra = {}) {
  return kbIssue({
    number: 7, status: 'running', agent: 'claude', kb: { max_runtime: 86_400 },
    run: runWith([{ attempt: 1, host: 'test-host', bg: true, job: 'j7', wt: 'kb-7-1', started_at: ago(120), heartbeat_at: ago(10), ...extra }]),
  });
}

test('an attempt written off as protocol_violation still names its session and transcript', async (t) => {
  const h = harness({
    jobs: [bgJob({ id: 'j7', task: 7, state: 'done', status: 'idle' })], // finished its turn, filed no verb
    records: { j7: { state: 'done', sessionId: SID, linkScanPath: TRANSCRIPT } },
  });
  t.after(h.cleanup);
  h.store.addIssue(running());
  h.gh.refs.set('refs/kb/locks/7/1', 'f'.repeat(40));

  const s = await h.tick();

  assert.deepEqual(s.reclaimed, [{ number: 7, outcome: 'protocol_violation' }]);
  const a = h.store.runOf(7).attempts[0];
  assert.equal(a.outcome, 'protocol_violation');
  assert.equal(a.session_id, SID, 'the id `hkb show` reopens the post-mortem with');
  assert.equal(a.transcript_path, TRANSCRIPT, 'and the transcript `hkb stats` prices it from');
  assert.match(h.log(), new RegExp(`#7: attempt 1 session ${SID}`));
});

test('a live attempt is named one tick after the launch, and the row is written once', async (t) => {
  const h = harness({
    jobs: [bgJob({ id: 'j7', task: 7, state: 'working', status: 'busy' })],
    records: { j7: { state: 'working', sessionId: SID, linkScanPath: TRANSCRIPT } },
  });
  t.after(h.cleanup);
  h.store.addIssue(running());

  const writes = () => h.store.writes().length;
  await h.tick();

  assert.deepEqual(h.store.runOf(7).attempts[0].session_id, SID);
  assert.equal(h.store.statusOf(7), 'running', 'a working job is not reclaimed for being named');
  const after = writes();
  await h.tick();
  assert.equal(writes(), after, 'the second tick finds nothing left to record');
});

test("a row naming another session is corrected to the job's, and the tick says so", async (t) => {
  // The tick only ever sees an OPEN attempt, and a terminal verb closes the row it stamps — so a
  // session id here came from a Stop hook, which fires in whichever session had KB_TASK in its
  // environment. On 2026-08-28 that was an operator's conversation, hosted by a daemon a
  // `claude --bg` launch had started with #146's environment (#150). The job the tick matched to
  // this attempt by its own checkout is the better witness, so it wins.
  const h = harness({
    jobs: [bgJob({ id: 'j7', task: 7, state: 'working', status: 'busy' })],
    records: { j7: { state: 'working', sessionId: SID, linkScanPath: TRANSCRIPT } },
  });
  t.after(h.cleanup);
  h.store.addIssue(running({ session_id: 'an-operator-session', transcript_path: '/t/operator.jsonl', total_cost_usd: 0.42 }));

  await h.tick();

  const a = h.store.runOf(7).attempts[0];
  assert.equal(a.session_id, SID);
  assert.equal(a.transcript_path, TRANSCRIPT);
  assert.equal(a.total_cost_usd, undefined, "the replaced session's cost went with it — it was never this attempt's");
  assert.match(h.log(), /corrected: the row named session an-operator-session/);
});

test('a dry run reads no job record and writes nothing', async (t) => {
  const h = harness({
    jobs: [bgJob({ id: 'j7', task: 7, state: 'working', status: 'busy' })],
    records: { j7: { state: 'working', sessionId: SID, linkScanPath: TRANSCRIPT } },
  });
  t.after(h.cleanup);
  h.store.addIssue(running());

  await h.tick({ dryRun: true });

  assert.equal(h.store.runOf(7).attempts[0].session_id, undefined);
});
