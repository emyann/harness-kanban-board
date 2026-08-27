// `hkb init --with-actions`: the two generated workflows, the `claude-action` profile whose launch
// only *fires* one of them, and what the dispatcher does with an attempt that runs somewhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { actionsFiles, installActions, triggerProfiles, resolveProfiles, hkbInstallForActions, ACTIONS_PROFILE, WORKER_WORKFLOW } from '../src/init.js';
import { DEFAULT_BOARD, DEFAULT_PROFILES, loadBoard, readState, writeState } from '../src/board.js';
import { expandLaunch, tick } from '../src/dispatch.js';
import { checkActions } from '../src/doctor.js';
import { parseArgs } from '../src/cli.js';
import { parseYaml } from './yaml.js';
import { FakeGh, kbIssue } from './fake-gh.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const DISPATCH = path.join('.github', 'workflows', 'kanban-dispatch.yml');
const WORKER = path.join('.github', 'workflows', 'kanban-worker-claude.yml');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-actions-'));
const fileMap = (opts) => Object.fromEntries(actionsFiles(opts).map((f) => [f.rel, f.contents]));
const docs = (opts) => Object.fromEntries(actionsFiles(opts).map((f) => [f.rel, parseYaml(f.contents)]));
const step = (doc, job, name) => doc.jobs[job].steps.find((s) => s.name === name || s.id === name || s.uses === name);

function ctxFor(gh, root, profiles) {
  return {
    root,
    cfg: { ...DEFAULT_BOARD, repo: gh.nameWithOwner, profiles },
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {}, requireBoard() { return this; },
  };
}

// ---------- the files ----------

test('actionsFiles produces exactly the dispatcher and the worker workflow', () => {
  assert.deepEqual(actionsFiles().map((f) => f.rel), [DISPATCH, WORKER]);
});

test('both workflows are valid YAML, with nothing left unsubstituted', () => {
  for (const [rel, text] of Object.entries(fileMap({ board: 'ops', install: 'npm i -g hkb-cli', profiles: ['claude-action'] }))) {
    assert.doesNotThrow(() => parseYaml(text), `${rel} does not parse`);
    assert.ok(!/\{\{\w+\}\}/.test(text), `${rel} has an unsubstituted placeholder`);
  }
});

test('the dispatcher is event-driven, with the cron as a sweeper only', () => {
  const on = docs()[DISPATCH].on;
  assert.deepEqual(on, {
    issues: { types: ['closed', 'reopened', 'labeled', 'unlabeled'] },
    pull_request: { types: ['closed'] },
    pull_request_review: { types: ['submitted', 'dismissed'] },
    workflow_run: { workflows: [WORKER_WORKFLOW], types: ['completed'] },
    workflow_dispatch: null,
    schedule: [{ cron: '*/15 * * * *' }],
  });
  // the sweep is the fallback, so the events above must outnumber it — a cron-only dispatcher is
  // the 15-75 minute latency the README promises never to make the primary path
  assert.ok(Object.keys(on).length > 2);
});

test('the dispatcher watches the worker workflow by the name the worker declares', () => {
  const d = docs();
  assert.deepEqual(d[DISPATCH].on.workflow_run.workflows, [d[WORKER].name]);
});

test('one tick at a time per board, and a tick in flight is never cancelled', () => {
  assert.deepEqual(docs({ board: 'ops' })[DISPATCH].concurrency, { group: 'kb-dispatch-ops', 'cancel-in-progress': false });
});

test('the tick is `hkb dispatch --max 1`, on this board, restricted to the profiles a runner can launch', () => {
  const doc = docs({ board: 'ops', profiles: ['claude-action', 'claude-managed'] })[DISPATCH];
  const s = step(doc, 'dispatch', 'hkb dispatch');
  assert.equal(s.run, 'hkb dispatch --max 1 --board ops --profiles claude-action,claude-managed');
  assert.equal(s.env.GH_TOKEN, '${{ secrets.KB_TOKEN }}');
  assert.match(s.if, /preflight/, 'the tick must not run without a token');
});

test('a repo with no KB_TOKEN yet is told what to do, once, instead of failing every event', () => {
  const doc = docs()[DISPATCH];
  const pre = step(doc, 'dispatch', 'preflight');
  assert.equal(pre.env.KB_TOKEN, '${{ secrets.KB_TOKEN }}');
  assert.match(pre.run, /::notice::/);
  assert.match(pre.run, /gh secret set KB_TOKEN/);
  assert.match(pre.run, /ready=(true|false)/);
});

test('the templates carry secret *references* and never a secret', () => {
  for (const [rel, text] of Object.entries(fileMap())) {
    const named = [...text.matchAll(/^\s*(KB_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY|claude_code_oauth_token|anthropic_api_key)[ \t]*:[ \t]*(.*)$/gm)];
    assert.ok(named.length, `${rel}: expected at least one secret reference`);
    for (const m of named) assert.match(m[2], /^\$\{\{ secrets\.[A-Z_]+ \}\}$/, `${rel}: ${m[1]} must come from a secret expression, got ${m[2]}`);
  }
});

// ---------- the worker workflow ----------

test('the worker is one attempt, started by the dispatcher with task/attempt/board', () => {
  const doc = docs({ board: 'ops' })[WORKER];
  assert.deepEqual(Object.keys(doc.on), ['workflow_dispatch'], 'nothing but the dispatcher may start a worker');
  const inputs = doc.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ['task', 'attempt', 'board']);
  assert.equal(inputs.task.required, true);
  assert.equal(inputs.attempt.required, true);
  assert.equal(inputs.board.default, 'ops');
  const env = doc.jobs.work.env;
  assert.equal(env.KB_TASK, '${{ inputs.task }}');
  assert.equal(env.KB_ATTEMPT, '${{ inputs.attempt }}');
  assert.equal(env.KB_BOARD, '${{ inputs.board }}');
  assert.equal(env.KB_PROFILE, ACTIONS_PROFILE);
  assert.equal(doc.jobs.work['timeout-minutes'], 60);
  assert.equal(docs({ timeoutMinutes: 25 })[WORKER].jobs.work['timeout-minutes'], 25);
});

test('the worker prompt is `hkb context`, passed as data and never through a shell', () => {
  const doc = docs()[WORKER];
  const brief = step(doc, 'work', 'brief');
  assert.match(brief.run, /hkb context "\$KB_TASK"/, 'the brief is the same text a local worker gets');
  assert.match(brief.run, /\$GITHUB_OUTPUT/);
  assert.match(brief.run, /urandom/, 'issue text must not be able to forge the output delimiter');
  const action = step(doc, 'work', 'anthropics/claude-code-action@v1');
  assert.equal(action.with.prompt, '${{ steps.brief.outputs.prompt }}');
  assert.ok(!/\$\{\{ steps\./.test(brief.run), 'no step output may be interpolated into a run: block');
});

test('the worker runs with the same allowlist as a local Claude worker, force-push denied', () => {
  const action = step(docs()[WORKER], 'work', 'anthropics/claude-code-action@v1');
  const tools = /--allowedTools "([^"]*)"/.exec(action.with.claude_args)[1].split(',');
  assert.deepEqual(tools, DEFAULT_PROFILES[ACTIONS_PROFILE].allowed_tools);
  assert.ok(tools.includes('Bash(hkb *)') && tools.includes('Bash(gh pr *)'));
  assert.match(action.with.claude_args, /--disallowedTools "Bash\(git push --force\*\),Bash\(git push -f\*\)"/);
  assert.match(action.with.claude_args, /--max-turns 80/);
  assert.equal(action.env.GH_TOKEN, '${{ secrets.KB_TOKEN }}', 'hkb and gh inside the worker write with KB_TOKEN');
});

test('the worker ends the attempt itself — there is no Stop hook on a runner', () => {
  const doc = docs()[WORKER];
  const last = doc.jobs.work.steps[doc.jobs.work.steps.length - 1];
  assert.equal(last.if, 'always()');
  assert.match(last.run, /hkb status "\$KB_TASK"/);
  assert.match(last.run, /hkb block "\$KB_TASK" .* --kind transient/);
});

test('the worker checks out full history — the heartbeat is a CAS on a real ref', () => {
  const doc = docs()[WORKER];
  const checkout = step(doc, 'work', 'actions/checkout@v7');
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(doc.permissions.contents, 'write');
});

// ---------- the profile ----------

test('the claude-action profile only fires the workflow: no local worker, no pid to watch', () => {
  const p = DEFAULT_PROFILES[ACTIONS_PROFILE];
  assert.equal(p.mode, 'trigger');
  assert.equal(p.workspace, undefined, 'the runner does its own checkout');
  assert.equal(p.launch[0], 'gh');
  assert.ok(p.launch.includes(path.basename(WORKER)), 'the launch must name the workflow init generates');
  assert.ok(!p.launch.includes('{prompt}'), 'the prompt is built on the runner by `hkb context`');
});

test('the launch expands to one `gh workflow run` with the task, attempt and board', () => {
  const p = DEFAULT_PROFILES[ACTIONS_PROFILE];
  assert.deepEqual(expandLaunch(p.launch, { n: 12, k: 3, board: 'ops', repo: 'acme/board' }, p), [
    'gh', 'workflow', 'run', 'kanban-worker-claude.yml', '-R', 'acme/board',
    '-f', 'task=12', '-f', 'attempt=3', '-f', 'board=ops',
  ]);
});

// ---------- install ----------

test('installActions writes both workflows, then reports nothing to do', () => {
  const root = scratch();
  assert.deepEqual(installActions(root), [DISPATCH, WORKER]);
  assert.deepEqual(installActions(root), [], 'idempotent: a second init rewrites nothing');
  fs.writeFileSync(path.join(root, DISPATCH), 'someone edited the generated workflow\n');
  assert.deepEqual(installActions(root), [DISPATCH], 'and only the file that drifted');
});

test('`hkb init --with-actions` adds the Actions profile without taking the local one away', () => {
  const { flags } = parseArgs(['init', '--with-actions']);
  assert.equal(flags['with-actions'], true, '--with-actions takes no value');
  assert.deepEqual(resolveProfiles(flags), { harnesses: [], profiles: ['claude', ACTIONS_PROFILE] });
  assert.deepEqual(resolveProfiles({ harness: 'copilot', 'with-actions': true }).profiles, ['copilot-cli', ACTIONS_PROFILE]);
  assert.deepEqual(resolveProfiles({ profiles: 'claude-action', 'with-actions': true }).profiles, ['claude-action'], 'no duplicate');
});

test('triggerProfiles is what a runner may claim: launches that start work elsewhere', () => {
  assert.deepEqual(triggerProfiles({ profiles: DEFAULT_PROFILES }), [ACTIONS_PROFILE]);
  assert.deepEqual(triggerProfiles({ profiles: { claude: DEFAULT_PROFILES.claude } }), [ACTIONS_PROFILE], 'the default is still the Actions profile, never a local one');
  assert.deepEqual(triggerProfiles({ profiles: { a: { mode: 'trigger' }, b: { mode: 'process' } } }), ['a']);
});

test('hkb reaches the runner as an install command, and its own repo installs the checkout', () => {
  assert.equal(hkbInstallForActions(REPO), 'npm link');
  assert.equal(hkbInstallForActions(scratch()), 'npm i -g hkb-cli');
});

// ---------- the dispatcher ----------

test('a trigger profile claims a remote attempt: no pid, no job, and no reclaim next tick', async (t) => {
  const gh = new FakeGh();
  const root = scratch();
  // `true` stands in for `gh workflow run`: it exits 0 immediately, which is the whole point
  const ctx = ctxFor(gh, root, { [ACTIONS_PROFILE]: { ...DEFAULT_PROFILES[ACTIONS_PROFILE], launch: ['true'] } });
  const restore = gh.install();
  t.after(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });
  gh.addIssue(kbIssue({ number: 5, status: 'ready', agent: ACTIONS_PROFILE }));

  const first = await tick(ctx, {});
  assert.deepEqual(first.claimed.map((c) => c.number), [5]);
  const [a] = gh.runOf(5).attempts;
  assert.equal(a.remote, true);
  assert.equal(a.pid, null);
  assert.equal(a.bg, undefined, 'a remote attempt is not a background agent on this host');
  assert.ok(a.lock_sha, 'the heartbeat chain still starts on the lock ref');

  writeState(root, { ...readState(root), touched: {} }); // past the 90s stale-read guard
  const second = await tick(ctx, {});
  assert.deepEqual(second.reclaimed, [], 'no local process is the normal state for a remote attempt');
  assert.equal(gh.statusOf(5), 'running');
});

test('a trigger launch that fails is a spawn failure, and the task goes back to ready', async (t) => {
  const gh = new FakeGh();
  const root = scratch();
  const ctx = ctxFor(gh, root, { [ACTIONS_PROFILE]: { ...DEFAULT_PROFILES[ACTIONS_PROFILE], launch: ['false'] } });
  const restore = gh.install();
  t.after(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });
  gh.addIssue(kbIssue({ number: 6, status: 'ready', agent: ACTIONS_PROFILE }));

  const s = await tick(ctx, {});

  assert.deepEqual(s.spawn_failed.map((x) => x.number), [6]);
  assert.equal(gh.statusOf(6), 'ready');
  assert.equal(gh.runOf(6).attempts[0].outcome, 'spawn_failed');
});

test('--profiles claims only what this host can launch, and sweeps the whole board anyway', async (t) => {
  const gh = new FakeGh();
  const root = scratch();
  const ctx = ctxFor(gh, root, {
    [ACTIONS_PROFILE]: { ...DEFAULT_PROFILES[ACTIONS_PROFILE], launch: ['true'] },
    claude: DEFAULT_PROFILES.claude, // a laptop-only harness the runner must not try to start
  });
  const restore = gh.install();
  t.after(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });
  gh.addIssue(kbIssue({ number: 5, status: 'ready', agent: ACTIONS_PROFILE }));
  gh.addIssue(kbIssue({ number: 6, status: 'ready', agent: 'claude' }));
  gh.addIssue(kbIssue({ number: 7, status: 'todo', agent: 'claude' }));

  const s = await tick(ctx, { profiles: [ACTIONS_PROFILE] });

  assert.deepEqual(s.claimed.map((c) => c.number), [5]);
  assert.deepEqual(s.skipped.filter((x) => x.number === 6).map((x) => x.why), ['profile claude is not dispatched from this host']);
  assert.equal(gh.statusOf(6), 'ready', 'left exactly where the laptop loop will find it');
  assert.deepEqual(s.promoted, [7], 'promotion, reclaim and reconcile still cover the whole board');
});

// ---------- doctor ----------

function gitRepo() {
  const root = fs.realpathSync(scratch());
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0, `git ${args.join(' ')}`);
  git('init', '-q', '-b', 'main');
  return root;
}

test('doctor reports the workflows only when a trigger profile is configured', () => {
  const root = gitRepo();
  const rows = [];
  const sink = { ok: (name, detail) => rows.push({ name, ok: true, detail }), warn: (name, detail, fix) => rows.push({ name, ok: null, detail, fix }) };
  const ctx = { root, cfg: { profiles: { claude: DEFAULT_PROFILES.claude } } };
  checkActions(ctx, sink);
  assert.deepEqual(rows, [], 'no Actions profile, nothing to say');

  ctx.cfg.profiles[ACTIONS_PROFILE] = DEFAULT_PROFILES[ACTIONS_PROFILE];
  checkActions(ctx, sink);
  assert.equal(rows[0].ok, null);
  assert.match(rows[0].detail, /missing .*kanban-dispatch\.yml/);
  assert.equal(rows[0].fix, 'hkb init --with-actions');

  installActions(root);
  rows.length = 0;
  checkActions(ctx, sink);
  assert.equal(rows[0].ok, null, 'generated but uncommitted: Actions runs only what is on the default branch');
  assert.match(rows[0].detail, /not committed/);

  spawnSync('git', ['add', '.github'], { cwd: root });
  rows.length = 0;
  checkActions(ctx, sink);
  assert.equal(rows[0].ok, true);
  assert.match(rows[0].detail, new RegExp(ACTIONS_PROFILE));
});

// ---------- this repo ----------

test('this repo ships the actions templates the generator reads', () => {
  for (const f of ['kanban-dispatch.yml', 'kanban-worker-claude.yml']) {
    assert.ok(fs.existsSync(path.join(REPO, 'templates', 'actions', f)), `templates/actions/${f}`);
  }
});

test('the workflows committed here are exactly what the generator would write', () => {
  const cfg = loadBoard(REPO);
  const expected = actionsFiles({
    board: cfg.board,
    install: hkbInstallForActions(REPO),
    profiles: triggerProfiles(cfg),
    timeoutMinutes: Math.round((cfg.dispatch?.max_runtime_default || 3600) / 60),
  });
  for (const f of expected) {
    assert.equal(fs.readFileSync(path.join(REPO, f.rel), 'utf8'), f.contents, `${f.rel} has drifted from templates/actions — re-run \`hkb init --with-actions\``);
  }
});
