// The hook's first question — *which attempt is this session?* — when the answer is contested, and
// hkb's own PreToolUse policy end to end through the CLI.
//
// A `claude --bg` launch that finds no session daemon starts one, and that daemon keeps the launch
// environment for its whole life. On 2026-08-28 that put `KB_TASK=146 KB_ATTEMPT=1 KB_PROFILE=claude
// KB_ROOT=…` into every session the new daemon hosted, including an operator conversation older than
// the card: its Stop hook stamped that conversation onto #146's attempt row, and hkb's worker
// permission policy was enforced on the operator's own shell (#150).
//
// Two halves, tested here: the environment is scrubbed at the source (test/dispatch.test.js), and a
// hook that finds `KB_TASK` in an environment its checkout contradicts stands aside.
//
// The PreToolUse contract this file also pins is deliberately lopsided: the hook may DENY, and
// otherwise it says nothing at all. Worker policy is the launch line (`--permission-mode dontAsk
// --allowedTools … --disallowedTools …`), and a hook `allow` overrides Claude Code's own checks — so
// an allow here would let a `claude-p` worker run what the identical `claude --bg` worker beside it
// is refused. Silence keeps this layer subtractive (#143). Those tests run as a subprocess because
// the hook reads fd 0 and answers on stdout, which is the whole interface: a test that called the
// function would not be testing the thing Claude Code talks to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { attemptIdentity, worksInWorktree, scrubKbEnv, kbVarsIn, KB_ENV_VARS, worktreePath } from '../src/model.js';
import { whichAttempt, stopHook, preToolHook, sessionForAttempt } from '../src/hook.js';
import { checkEnvLeak, daemonsWithKbEnv, ENV_LEAK_CHECK } from '../src/doctor.js';
import { DEFAULT_BOARD, DEFAULT_PROFILES } from '../src/board.js';
import { loadRun } from '../src/tasks.js';
import { FakeGh, kbIssue, runWith } from './fake-gh.js';

const PROFILES = {
  claude: DEFAULT_PROFILES.claude,               // mode: claude-bg — its worker is in kb-<n>-<k>
  'claude-p': DEFAULT_PROFILES['claude-p'],      // mode: process — its environment dies with it
  'claude-action': DEFAULT_PROFILES['claude-action'], // mode: trigger — the worker is an Actions checkout
  codex: DEFAULT_PROFILES.codex,                 // workspace: worktree — the dispatcher makes the checkout
};
const ROOT = '/repo';
const wtPath = (n, k) => `${ROOT}/${worktreePath(`kb-${n}-${k}`)}`;
const bg = { env: { KB_TASK: '146', KB_ATTEMPT: '1', KB_PROFILE: 'claude', KB_ROOT: ROOT }, profile: PROFILES.claude, rootPath: ROOT };

// ---------- the rule, pure ----------

test('attemptIdentity: the environment and the checkout agree — nothing changes', () => {
  assert.deepEqual(attemptIdentity({ ...bg, here: 'kb-146-1', herePath: wtPath(146, 1) }), { n: '146', k: '1', source: 'env' });
  // no KB_ATTEMPT: the checkout supplies it, as it always has
  assert.deepEqual(attemptIdentity({ env: { KB_TASK: '146' }, here: 'kb-146-3', herePath: wtPath(146, 3), rootPath: ROOT, profile: PROFILES.claude }),
    { n: '146', k: '3', source: 'env' });
  // no environment at all: the checkout is the whole answer (#125)
  assert.deepEqual(attemptIdentity({ here: 'kb-18-2' }), { n: '18', k: '2', source: 'worktree' });
  assert.equal(attemptIdentity({ here: 'harness-kanban-board' }), null);
  assert.equal(attemptIdentity({}), null);
});

test('attemptIdentity: a leaked environment is dropped, and says so once', () => {
  // the incident: the operator's session, at the board root, wearing #146's identity
  const atRoot = attemptIdentity({ ...bg, here: 'harness-kanban-board', herePath: ROOT });
  assert.equal(atRoot.n, undefined, 'no identity at all: this session is nobody');
  assert.match(atRoot.leak, /^KB_TASK=146 in the environment but this is not its worktree \(this is the board root\); ignoring$/);
  // another worker's checkout: the checkout wins, because it is the one thing that cannot be inherited
  const other = attemptIdentity({ ...bg, here: 'kb-150-1', herePath: wtPath(150, 1) });
  assert.deepEqual({ n: other.n, k: other.k, source: other.source }, { n: '150', k: '1', source: 'worktree' });
  assert.match(other.leak, /kb-150-1 is #150 attempt 1/);
  // same task, another attempt — a retry launched while the daemon still held the first one
  assert.equal(attemptIdentity({ ...bg, here: 'kb-146-2', herePath: wtPath(146, 2) }).k, '2');
});

test('attemptIdentity: a cwd that is neither the board root nor a kb-<n>-<k> checkout is also a leak', () => {
  // a review worktree (not kb-<n>-<k>): a poisoned daemon reached beyond the board root, and the
  // basename alone would have looked like "nothing here contradicts it" before #150 B1
  const review = attemptIdentity({ ...bg, here: 'review-152', herePath: `${ROOT}/review-152` });
  assert.equal(review.n, undefined);
  assert.match(review.leak, /^KB_TASK=146 in the environment but this is not its worktree \(review-152 is not a kb-<n>-<k> worktree\); ignoring$/);
  // a foreign repo entirely: same poisoned daemon, a session hosted for an unrelated project
  const foreign = attemptIdentity({ ...bg, here: 'pipao-v2', herePath: '/home/u/pipao-v2' });
  assert.equal(foreign.n, undefined);
  assert.match(foreign.leak, /pipao-v2 is not a kb-<n>-<k> worktree/);
});

test('attemptIdentity: a same-named checkout under the wrong KB_ROOT is a leak too (#150 B1)', () => {
  // the basename matches this task and attempt exactly, but the real cwd is not under this
  // environment's KB_ROOT — a same-numbered worktree in an unrelated board, reached because a
  // daemon poisoned by one board's KB_ROOT went on to host a session for a different repo entirely.
  // The checkout still answers (this cwd really is *a* kb-146-1, just not this KB_ROOT's) — but as
  // `source: 'worktree'` with a leak note, never `'env'`, so the worker policy stands aside (the
  // probe this closes: source used to come back `'env'` here, with the policy live)
  const wrongRepo = attemptIdentity({ ...bg, here: 'kb-146-1', herePath: '/other-repo/.claude/worktrees/kb-146-1' });
  assert.deepEqual({ n: wrongRepo.n, k: wrongRepo.k, source: wrongRepo.source }, { n: '146', k: '1', source: 'worktree' });
  assert.match(wrongRepo.leak, /^KB_TASK=146 in the environment but this is not its worktree \(kb-146-1 is not under KB_ROOT \(\/repo\)\); ignoring$/);
  // KB_ROOT unset entirely: agreement can never be proven, so even a plausible-looking checkout leaks
  const noRoot = attemptIdentity({ env: { KB_TASK: '146', KB_ATTEMPT: '1', KB_PROFILE: 'claude' }, here: 'kb-146-1', herePath: wtPath(146, 1), rootPath: null, profile: PROFILES.claude });
  assert.equal(noRoot.source, 'worktree');
  assert.match(noRoot.leak, /KB_ROOT is not set/);
});

test('attemptIdentity: judged only where hkb knows where the worker sits', () => {
  const at = (profile, extra = {}) => attemptIdentity({ ...bg, profile, here: 'somewhere-else', herePath: `${ROOT}/somewhere-else`, ...extra });
  // an Actions worker: KB_TASK set by the workflow, cwd the runner's checkout, no KB_ROOT to compare
  assert.deepEqual(at(PROFILES['claude-action']), { n: '146', k: '1', source: 'env' });
  // `claude -p`: a child process whose environment dies with it, so it can never be a leak source
  assert.deepEqual(at(PROFILES['claude-p']), { n: '146', k: '1', source: 'env' });
  assert.deepEqual(at(null), { n: '146', k: '1', source: 'env' }, 'an unknown profile is never second-guessed');
  // a directory that is nobody's worktree is not evidence *for* the environment either — only a
  // checkout naming this task and attempt, rooted where the launch put it, agrees with it (#150 B1)
  const somewhereElse = at(PROFILES.claude);
  assert.equal(somewhereElse.n, undefined, 'a directory that is not this attempt\'s worktree is a leak too');
  assert.match(somewhereElse.leak, /somewhere-else is not a kb-<n>-<k> worktree/);
  assert.equal(worksInWorktree(PROFILES.claude), true);
  assert.equal(worksInWorktree(PROFILES.codex), true, 'the dispatcher hands it the checkout as its cwd');
  assert.equal(worksInWorktree(PROFILES['claude-p']), false);
  assert.equal(worksInWorktree(PROFILES['claude-action']), false);
  assert.equal(worksInWorktree(null), false);
});

test('scrubKbEnv: every KB_* key, and nothing else', () => {
  const env = scrubKbEnv({ PATH: '/usr/bin', HOME: '/home/u', KB_TASK: '146', KB_ROOT: '/repo', KB_CONFIG_HOME: '/c', KEEP: 'me' });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/u', KEEP: 'me' });
  assert.deepEqual(scrubKbEnv(null), {});
  for (const k of KB_ENV_VARS) assert.equal(scrubKbEnv({ [k]: 'x' })[k], undefined, k);
});

test('kbVarsIn: the KB_* names in a /proc environ dump', () => {
  assert.deepEqual(kbVarsIn(['PATH=/usr/bin', 'KB_TASK=146', 'KB_PROFILE=claude', 'KB_TASK=146'].join('\0')),
    ['KB_TASK', 'KB_PROFILE']);
  assert.deepEqual(kbVarsIn(''), []);
  assert.deepEqual(kbVarsIn(null), []);
  assert.deepEqual(kbVarsIn('NOT_KB_TASK=1\0kb_task=1'), [], 'the prefix is exact');
});

// ---------- and through the hook ----------

/**
 * An operator's session: the board root, with a worker's environment leaked into it by the session
 * daemon. #7 is running with an open attempt, so every behaviour the leak used to reach — the nudge,
 * the session stamp, the permission policy — has something to do if it fires.
 */
function leakHarness({ cwd = 'root', task = '7', attempt = '1', profile = 'claude' } = {}) {
  const gh = new FakeGh();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-leak-'));
  const root = cwd === 'root' ? dir : path.join(dir, '.claude', 'worktrees', cwd);
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  gh.addIssue(kbIssue({ number: 7, status: 'running', agent: 'claude', run: runWith([{ attempt: 1, host: 'h', bg: true, wt: 'kb-7-1', started_at: '2026-08-28T09:00:00Z' }]) }));

  const cfg = { ...DEFAULT_BOARD, repo: gh.nameWithOwner, profiles: PROFILES };
  const ctx = { root, cfg, repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner }, board: 'default', host: 'h', json: false, caps: {}, _cache: {}, requireBoard() { return this; } };
  const restore = gh.install();
  const saved = { ...process.env };
  for (const k of KB_ENV_VARS) delete process.env[k];
  Object.assign(process.env, { KB_TASK: task, KB_ATTEMPT: attempt, KB_PROFILE: profile, KB_ROOT: dir, CLAUDE_CODE_SESSION_ID: 'an-operator-session' });
  const err = [];
  const out = [];
  const write = { err: process.stderr.write, out: process.stdout.write };
  process.stderr.write = (s) => { err.push(String(s)); return true; };
  process.stdout.write = (s) => { out.push(String(s)); return true; };
  return {
    gh, ctx, root, boardRoot: dir, err: () => err.join(''), out: () => out.join(''),
    writes: () => gh.calls.filter((c) => ['POST', 'PATCH', 'DELETE'].includes(c.method)).length,
    attempt: async (n, k) => (await loadRun(ctx, n)).run.attempts.find((a) => a.attempt === k),
    cleanup: () => {
      process.stderr.write = write.err; process.stdout.write = write.out;
      restore();
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('stop hook: a leaked KB_TASK at the board root is not an identity — no nudge, no stamp, one line', async () => {
  const h = leakHarness({ task: '146' }); // a task this board root is not the worktree of
  try {
    let read = 0;
    const answer = await stopHook(h.ctx, { readStdin: () => { read++; return JSON.stringify({ session_id: 'an-operator-session' }); } });

    assert.equal(answer, 0);
    assert.equal(read, 0, 'it returns before stdin, exactly as for a session that is not a worker');
    assert.equal(h.out(), '', 'no nudge: the operator is not the one who owes a terminal verb');
    assert.equal(h.writes(), 0, 'and nothing on the board was touched');
    assert.match(h.err(), /^hkb hook: KB_TASK=146 in the environment but this is not its worktree \(this is the board root\); ignoring\n$/);
  } finally { h.cleanup(); }
});

test('stop hook: the same session, in the checkout the environment names, is a worker as before', async () => {
  const h = leakHarness({ cwd: 'kb-7-1', task: '7' });
  try {
    await stopHook(h.ctx, { readStdin: () => JSON.stringify({ session_id: 'sid-7', transcript_path: '/t/sid-7.jsonl' }) });

    assert.equal((await h.attempt(7, 1)).session_id, 'sid-7', 'a real worker still records its session');
    assert.equal(JSON.parse(h.out()).decision, 'block', 'and is still nudged for the terminal verb');
    assert.equal(h.err(), '');
  } finally { h.cleanup(); }
});

test('pre-tool hook: a leaked environment decides nothing (the worker allowlist is not the operator\'s)', async () => {
  const h = leakHarness({ task: '146' });
  try {
    // the denial that gave the leak away: an operator's own diagnostic loop, refused by a worker's allowlist
    assert.equal(await preToolHook(h.ctx), 0);
    assert.equal(h.out(), '', 'no permissionDecision at all — Claude Code asks the operator, as it should');
  } finally { h.cleanup(); }
});

test('pre-tool hook: a real worker is still policed', async () => {
  const h = leakHarness({ cwd: 'kb-7-1', task: '7' });
  try {
    const stdin = fs.readFileSync;
    fs.readFileSync = (fd, enc) => (fd === 0 ? JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'hkb dispatch' } }) : stdin(fd, enc));
    try { await preToolHook(h.ctx); } finally { fs.readFileSync = stdin; }
    const answer = JSON.parse(h.out()).hookSpecificOutput;
    assert.equal(answer.permissionDecision, 'deny');
    assert.match(answer.permissionDecisionReason, /workers never start or stop the dispatcher/);
  } finally { h.cleanup(); }
});

test('a terminal verb run with a leaked environment stamps nobody', () => {
  const h = leakHarness({ task: '146' });
  try {
    assert.equal(sessionForAttempt(h.boardRoot, 146, 1, { attempt: 1 }, { profiles: PROFILES }), null);
    // and `whichAttempt` answers the same way for every caller
    assert.equal(whichAttempt(h.boardRoot, { profiles: PROFILES, warn: null }), null);
    assert.deepEqual(whichAttempt(path.join(h.boardRoot, '.claude', 'worktrees', 'kb-146-1'), { profiles: PROFILES, warn: null }),
      { n: '146', k: '1', source: 'env' });
  } finally { h.cleanup(); }
});

// ---------- what doctor says about the shell it is running in ----------

const doctorCtx = { root: '/repo', cfg: { ...DEFAULT_BOARD, profiles: PROFILES } };
const findings = () => { const out = []; return { out, warn: (name, detail, fix) => out.push({ name, detail, fix }) }; };

test('doctor: a shell wearing a worker identity that is not its own is a warning with the pid', () => {
  const f = findings();
  const daemon = (pid) => ({ pid, vars: ['KB_TASK', 'KB_PROFILE'], cmd: 'claude daemon run --origin transient' });
  const found = checkEnvLeak(doctorCtx, f, {
    env: { KB_TASK: '146', KB_ATTEMPT: '1', KB_PROFILE: 'claude', KB_ROOT: '/repo' },
    cwd: '/repo',
    daemons: () => [22486, 22524, 23056, 43172].map(daemon),
  });

  assert.equal(found.name, ENV_LEAK_CHECK);
  assert.match(found.detail, /thinks it is a worker for #146 on profile claude/);
  assert.match(found.detail, /claude --bg. launch probably started the Claude Code session daemon/);
  if (process.platform === 'linux') {
    // a host that has been dispatching for a while has several: name a few, count the rest
    assert.match(found.detail, /The daemons holding KB_TASK KB_PROFILE: pid 22486, 22524, 23056 \(\+1 more\)\./);
    assert.match(found.fix, /then end the daemon \(pid 22486, 22524, 23056 \(\+1 more\)\)/);
  }
  assert.match(found.fix, /let the sessions it hosts finish/);
  assert.equal(f.out.length, 1, 'one warning, with the fix attached');
});

test('doctor: an ordinary shell and a real worker both have nothing to report', () => {
  const f = findings();
  const nope = () => [];
  assert.equal(checkEnvLeak(doctorCtx, f, { env: {}, cwd: '/repo', daemons: nope }), null);
  assert.equal(checkEnvLeak(doctorCtx, f, {
    env: { KB_TASK: '146', KB_ATTEMPT: '1', KB_PROFILE: 'claude', KB_ROOT: '/repo' },
    cwd: '/repo/.claude/worktrees/kb-146-1', daemons: nope,
  }), null, 'the worker itself is exactly where it says it is');
  assert.equal(checkEnvLeak(doctorCtx, f, {
    env: { KB_TASK: '146', KB_ATTEMPT: '1', KB_PROFILE: 'claude-action' }, cwd: '/runner/work/repo', daemons: nope,
  }), null, 'an Actions worker is nobody\'s worktree and never was');
  assert.deepEqual(f.out, []);
});

test('doctor: a review worktree or a foreign repo carrying a leaked KB_TASK is also reported', () => {
  const f = findings();
  const nope = () => [];
  const review = checkEnvLeak(doctorCtx, f, {
    env: { KB_TASK: '146', KB_ATTEMPT: '1', KB_PROFILE: 'claude', KB_ROOT: '/repo' },
    cwd: '/repo/.claude/worktrees/review-152', daemons: nope,
  });
  assert.match(review.detail, /review-152 is not that task's worktree/);
  const foreign = checkEnvLeak(doctorCtx, f, {
    env: { KB_TASK: '146', KB_ATTEMPT: '1', KB_PROFILE: 'claude', KB_ROOT: '/repo' },
    cwd: '/home/u/projects/pipao-v2', daemons: nope,
  });
  assert.match(foreign.detail, /pipao-v2 is not that task's worktree/);
  assert.equal(f.out.length, 2);
});

test('doctor: a same-numbered kb-<n>-<k> checkout under an unrelated KB_ROOT is reported too (#150 B1)', () => {
  // the probe that found the gap: the checkout's basename matches, but it sits under a KB_ROOT this
  // environment never claimed — a daemon poisoned by one board's KB_ROOT hosting a session for another
  const f = findings();
  const found = checkEnvLeak(doctorCtx, f, {
    env: { KB_TASK: '146', KB_ATTEMPT: '1', KB_PROFILE: 'claude', KB_ROOT: '/nonexistent' },
    cwd: '/repo/.claude/worktrees/kb-146-1', daemons: () => [],
  });
  assert.match(found.detail, /kb-146-1 is not that task's worktree/);
  assert.equal(f.out.length, 1);
});

test('daemonsWithKbEnv: a session daemon holding KB_* is named; anything else is not', () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-proc-'));
  const fake = (pid, cmdline, environ) => {
    fs.mkdirSync(path.join(proc, String(pid)), { recursive: true });
    fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), cmdline.join('\0'));
    fs.writeFileSync(path.join(proc, String(pid), 'environ'), environ.join('\0'));
  };
  try {
    fake(22486, ['claude', 'daemon', 'run', '--origin', 'transient'], ['PATH=/usr/bin', 'KB_TASK=146', 'KB_PROFILE=claude']);
    fake(22487, ['claude', 'daemon', 'run'], ['PATH=/usr/bin']); // a clean daemon: nothing to say
    fake(22488, ['node', 'server.js'], ['KB_TASK=146']); // not a daemon
    fs.writeFileSync(path.join(proc, 'uptime'), 'not a pid');

    const found = daemonsWithKbEnv({ proc });

    assert.deepEqual(found.map((d) => d.pid), [22486]);
    assert.deepEqual(found[0].vars, ['KB_TASK', 'KB_PROFILE']);
    assert.equal(daemonsWithKbEnv({ proc: path.join(proc, 'nope') }).length, 0, 'no /proc is not an error');
  } finally { fs.rmSync(proc, { recursive: true, force: true }); }
});

// ---------- hkb hook pretool, end to end through the CLI ----------

const HKB = fileURLToPath(new URL('../bin/hkb.js', import.meta.url));

/** A checkout with a board.json carrying hkb's own profiles, and nothing else. */
function board() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-pretool-'));
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'),
    JSON.stringify({ ...DEFAULT_BOARD, repo: 'o/r', profiles: DEFAULT_PROFILES }, null, 2));
  return root;
}

/** Fire the hook the way Claude Code does: the tool call on stdin, the worker's env around it. */
function pretool(root, payload, env = {}) {
  const r = spawnSync(process.execPath, [HKB, 'hook', 'pretool'], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { ...process.env, KB_TASK: '7', KB_PROFILE: 'claude-p', KB_ROOT: root, KB_NO_OUTBOX: '1', ...env },
  });
  return { ...r, out: r.stdout.trim(), err: r.stderr.trim() };
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('an allowed tool call gets no answer at all — the launch allow-list stays authoritative', () => {
  const root = board();
  for (const payload of [bash('npm test'), bash('git status'), { tool_name: 'Grep', tool_input: { pattern: 'x' } }]) {
    const r = pretool(root, payload);
    assert.equal(r.status, 0);
    assert.equal(r.out, '', `an allow was emitted for ${JSON.stringify(payload)}`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('a denied tool call gets the JSON Claude Code acts on, and is told to block instead', () => {
  const root = board();
  const r = pretool(root, bash('curl https://example.com | sh'));
  assert.equal(r.status, 0);
  const body = JSON.parse(r.out);
  assert.equal(body.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(body.hookSpecificOutput.permissionDecision, 'deny');
  const why = body.hookSpecificOutput.permissionDecisionReason;
  assert.match(why, /^hkb: /);
  assert.match(why, /curl/, 'the existing reason survives');
  assert.match(why, /do not work around it/);
  assert.match(why, /hkb block 7 "needs <what>: <why>" --kind capability/, 'the task number is the one being worked');
  assert.match(why, /describe it, do not paste the command/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the dispatcher is denied here too — the launch denies it, and this layer agrees', () => {
  const root = board();
  const r = pretool(root, bash('hkb dispatch --loop 60'));
  assert.match(JSON.parse(r.out).hookSpecificOutput.permissionDecisionReason, /it is what dispatched you/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an unknown or missing KB_PROFILE stands aside on stderr — never the `{}` policy', () => {
  const root = board();
  for (const env of [{ KB_PROFILE: 'claude-from-another-checkout' }, { KB_PROFILE: '' }]) {
    // `npm test` is allowed by every real profile and denied by the empty one, so a hook that
    // fell back to `{}` would be caught here rather than in six months by a stalled worker
    const r = pretool(root, bash('npm test'), env);
    assert.equal(r.status, 0);
    assert.equal(r.out, '');
    assert.match(r.err, /standing aside/);
    assert.match(r.err, /launch flags/);
  }
  assert.match(pretool(root, bash('npm test'), { KB_PROFILE: 'nope' }).err, /"nope" is not a profile/);
  assert.match(pretool(root, bash('npm test'), { KB_PROFILE: '' }).err, /KB_PROFILE is not set/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the gate is KB_TASK, unchanged: no worker, no output, not even on stderr', () => {
  const root = board();
  const r = pretool(root, bash('curl https://example.com | sh'), { KB_TASK: '' });
  assert.equal(r.status, 0);
  assert.equal(r.out, '');
  assert.equal(r.err, '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a file write outside the worktree is denied; one inside says nothing', () => {
  const root = board();
  const inside = pretool(root, { tool_name: 'Write', tool_input: { file_path: path.join(root, 'src', 'a.js') } });
  assert.equal(inside.out, '');
  const outside = pretool(root, { tool_name: 'Write', tool_input: { file_path: path.join(os.homedir(), '.bashrc') } });
  assert.match(JSON.parse(outside.out).hookSpecificOutput.permissionDecisionReason, /outside the repository/);
  fs.rmSync(root, { recursive: true, force: true });
});
