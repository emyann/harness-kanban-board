// The launch's own allow-list, and hkb's own guard, are two layers deciding one thing — what a
// worker may run. Under `--permission-mode dontAsk` the launch DENIES rather than prompts, so the
// stricter layer wins outright and any gap between them is a worker fighting the allow-list (#138).
// These tests pin the agreement: every shipped allow-list is a superset of `SAFE_BUILTINS`, in the
// pattern form the harness actually matches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_PROFILES, DEFAULT_BOARD, loadBoard, makeContext } from '../src/board.js';
import { SAFE_BUILTINS, EFFORT_LEVELS, TOOL_POSTURES, toolPosture, modelArgs, allowedCommandsFrom, harnessCommands, uncoveredBuiltins } from '../src/model.js';
import { actionsFiles, ACTIONS_PROFILE, init } from '../src/init.js';
import { parseArgs } from '../src/cli.js';
import { checkWorkerPermissions, workflowAllowedTools, PERMS_CHECK, checkPermissionMode, promptingProfiles, MODE_CHECK } from '../src/doctor.js';
import { FakeGh } from './fake-gh.js';

const claude = () => DEFAULT_PROFILES.claude.allowed_tools;
const copilot = () => DEFAULT_PROFILES['copilot-cli'].allowed_tools;
const WORKER = path.join('.github', 'workflows', 'kanban-worker-claude.yml');

function collect() {
  const results = [];
  return {
    results,
    sink: {
      ok: (name, detail) => results.push({ name, ok: true, detail }),
      warn: (name, detail, fix) => results.push({ name, ok: null, detail, fix }),
    },
  };
}
const ctxFor = (root, profiles) => ({ root, cfg: { ...DEFAULT_BOARD, repo: 'o/r', profiles } });
/** A scratch root the check can name in its fix text, removed when the test ends. */
function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-perms-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// ---------- the shipped lists ----------

test('CLAUDE_TOOLS is a superset of SAFE_BUILTINS', () => {
  assert.deepEqual(uncoveredBuiltins(claude()), []);
  for (const b of SAFE_BUILTINS) assert.ok(claude().includes(`Bash(${b} *)`), `missing Bash(${b} *)`);
});

test('COPILOT_TOOLS is a superset of SAFE_BUILTINS', () => {
  assert.deepEqual(uncoveredBuiltins(copilot()), []);
  for (const b of SAFE_BUILTINS) assert.ok(copilot().includes(`shell(${b}:*)`), `missing shell(${b}:*)`);
});

// The suffix is load-bearing, not cosmetic: measured against Claude Code 2.1.251, `Bash(export)`
// denies `export FOO=1; echo ok` and `Bash(export *)` allows it — and still covers the bare word.
// A bare entry would satisfy "is a superset" while leaving every real invocation denied.
test('every builtin is allow-listed in the argument-taking form', () => {
  for (const b of SAFE_BUILTINS) assert.ok(!claude().includes(`Bash(${b})`), `Bash(${b}) is the bare form — it denies \`${b} <args>\``);
});

// A track runner fans a wave out to one isolated subagent per node, and `Agent` is the whole unlock:
// under `dontAsk` an unlisted tool is DENIED, not prompted. It stays off every other profile because a
// cold node worker is one session doing one node — one that could fan out would spawn children nothing
// on the board has claimed, inside the one worktree its own attempt owns (#129).
test('only the track profile may spawn subagents', () => {
  assert.ok(DEFAULT_PROFILES['claude-track'].allowed_tools.includes('Agent'), 'a track runner cannot orchestrate without it');
  for (const [name, p] of Object.entries(DEFAULT_PROFILES)) {
    if (name === 'claude-track') continue;
    assert.ok(!(p.allowed_tools || []).includes('Agent'), `${name} must not be able to spawn subagents`);
  }
  assert.ok(!claude().includes('Agent'), 'CLAUDE_TOOLS itself stays single-agent');
  for (const tool of claude()) assert.ok(DEFAULT_PROFILES['claude-track'].allowed_tools.includes(tool), `claude-track lost ${tool}`);
});

// #114: a task's kb.skills tells the worker to invoke `Skill` — every Claude launch profile has to
// grant it, or the field asks for a tool `dontAsk` is guaranteed to deny.
test('every Claude launch profile grants the Skill tool', () => {
  for (const [name, p] of Object.entries(DEFAULT_PROFILES)) {
    if ((p.launch || [])[0] !== 'claude') continue;
    assert.ok((p.allowed_tools || []).includes('Skill'), `${name} cannot use a task's kb.skills without it`);
  }
});

test('the hand-spliced Bash(true) is gone — true comes from SAFE_BUILTINS now', () => {
  assert.ok(!claude().includes('Bash(true)'));
  assert.ok(claude().includes('Bash(true *)'));
});

test('every profile that has an allow-list covers the builtins; Codex opts out with null', () => {
  for (const [name, p] of Object.entries(DEFAULT_PROFILES)) {
    if (name === 'codex') { assert.equal(p.allowed_tools, null, 'codex has no per-command allow-list — the sandbox is the policy'); continue; }
    assert.deepEqual(uncoveredBuiltins(p.allowed_tools), [], `profile ${name}`);
  }
});

test('no allow-list repeats a pattern — echo and printf are on both source lists', () => {
  for (const list of [claude(), copilot()]) assert.equal(new Set(list).size, list.length);
});

test("hkb's own guard and the launch agree on what a worker may run", () => {
  // allowedCommandsFrom is what the PreToolUse hook enforces; nothing it permits may be denied upstream
  const guard = allowedCommandsFrom(claude());
  for (const b of SAFE_BUILTINS) assert.ok(guard.has(b) && harnessCommands(claude()).has(b), b);
});

test('the file editing tools survive the rebuild', () => {
  for (const t of ['Edit', 'Write', 'Read', 'Glob', 'Grep']) assert.ok(claude().includes(t), t);
  assert.ok(copilot().includes('write'));
});

// ---------- reading a list back ----------

test('harnessCommands names the command in either harness spelling, and skips non-shell tools', () => {
  assert.deepEqual([...harnessCommands(['Bash(git *)', 'shell(npm:*)', 'Bash(true)', 'Edit', 'write'])], ['git', 'npm', 'true']);
});

test('harnessCommands reads a multiword prefix as its command', () => {
  assert.deepEqual([...harnessCommands(['Bash(gh issue view *)'])], ['gh']);
});

test('uncoveredBuiltins reports what is missing, in SAFE_BUILTINS order', () => {
  const partial = SAFE_BUILTINS.filter((b) => b !== 'cd' && b !== 'export').map((b) => `Bash(${b} *)`);
  assert.deepEqual(uncoveredBuiltins(partial), ['cd', 'export']);
});

test('uncoveredBuiltins says nothing about a profile with no allow-list at all', () => {
  assert.deepEqual(uncoveredBuiltins(null), []);
  assert.deepEqual(uncoveredBuiltins(undefined), []);
});

// ---------- the generated workflow, which freezes a copy of the list ----------

test('the generated worker workflow bakes in a list that covers the builtins', () => {
  const yml = actionsFiles().find((f) => f.rel === WORKER).contents;
  const baked = workflowAllowedTools(yml);
  assert.deepEqual(baked, DEFAULT_PROFILES[ACTIONS_PROFILE].allowed_tools);
  assert.deepEqual(uncoveredBuiltins(baked), []);
});

test('workflowAllowedTools returns null when there is no such flag', () => {
  assert.equal(workflowAllowedTools('name: nothing to see\n'), null);
  assert.equal(workflowAllowedTools(null), null);
});

// ---------- doctor: the migration path for boards carrying a frozen list ----------

test('doctor warns about a board.json profile pinning a pre-#138 allow-list', (t) => {
  const { results, sink } = collect();
  const stale = ['Bash(git *)', 'Bash(npm *)', 'Bash(true)', 'Edit'];
  checkWorkerPermissions(ctxFor(scratch(t), { claude: { ...DEFAULT_PROFILES.claude, allowed_tools: stale } }), sink, { exists: () => false });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, null);
  // one name whatever the answer, so a --json consumer can key on it; the profile is in the detail
  assert.equal(results[0].name, PERMS_CHECK);
  assert.match(results[0].detail, /^the claude profile in \.kanban\/board\.json omits/);
  assert.match(results[0].detail, /omits cd, pwd, false, echo \+11 more/); // `true` is the one it did cover
  assert.match(results[0].fix, /drop "allowed_tools" from the claude profile/);
});

test('a profile hkb ships no default for is told to add the patterns, not to drop the key', (t) => {
  const { results, sink } = collect();
  const stale = ['Bash(git *)', 'Bash(npm *)'];
  // loadBoard deep-merges over DEFAULT_PROFILES[name]; a custom name has nothing behind it, so
  // dropping `allowed_tools` expands `{allowed_tools}` to nothing and --allowedTools eats --disallowedTools
  checkWorkerPermissions(ctxFor(scratch(t), { 'claude-big': { ...DEFAULT_PROFILES.claude, allowed_tools: stale } }), sink, { exists: () => false });
  assert.equal(results.length, 1);
  assert.match(results[0].fix, /^add Bash\(cd \*\), Bash\(pwd \*\), Bash\(true \*\)/);
  assert.match(results[0].fix, /to "allowed_tools" on the claude-big profile/);
  assert.match(results[0].fix, /no default to fall back to/);
  assert.ok(!/drop "allowed_tools"/.test(results[0].fix), 'the advice that empties the flag');
});

test('doctor warns about the generated workflow when its baked list is stale', (t) => {
  const { results, sink } = collect();
  const old = '            --allowedTools "Bash(git *),Bash(true),Edit"\n';
  checkWorkerPermissions(ctxFor(scratch(t), {}), sink, { exists: () => true, read: () => old });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, PERMS_CHECK);
  assert.match(results[0].detail, /^the generated \.github[\\/]workflows[\\/]kanban-worker-claude\.yml omits/);
  assert.equal(results[0].fix, 'hkb init --with-actions');
});

test('doctor is content with the lists hkb ships today', (t) => {
  const { results, sink } = collect();
  const yml = actionsFiles().find((f) => f.rel === WORKER).contents;
  checkWorkerPermissions(ctxFor(scratch(t), DEFAULT_PROFILES), sink, { exists: () => true, read: () => yml });
  assert.deepEqual(results.map((r) => r.ok), [true]);
  assert.equal(results[0].name, PERMS_CHECK);
  assert.match(results[0].detail, new RegExp(`cover the ${SAFE_BUILTINS.length} shell builtins`));
});

test('doctor says nothing on a board whose only profile has no allow-list', (t) => {
  const { results, sink } = collect();
  assert.equal(checkWorkerPermissions(ctxFor(scratch(t), { codex: DEFAULT_PROFILES.codex }), sink, { exists: () => false }), null);
  assert.deepEqual(results, []);
});

test('an unreadable workflow is checkActions\' problem, not this check\'s', (t) => {
  const { results, sink } = collect();
  checkWorkerPermissions(ctxFor(scratch(t), {}), sink, { exists: () => true, read: () => { throw new Error('EACCES'); } });
  assert.deepEqual(results, []);
});

// ---------- doctor: a launch that can still prompt ----------

test('doctor warns about a Claude launch with no `--permission-mode dontAsk`', (t) => {
  const { results, sink } = collect();
  const asks = { ...DEFAULT_PROFILES.claude, launch: DEFAULT_PROFILES.claude.launch.filter((a) => a !== '--permission-mode' && a !== 'dontAsk') };
  const acceptEdits = { ...DEFAULT_PROFILES['claude-p'], launch: DEFAULT_PROFILES['claude-p'].launch.map((a) => a === 'dontAsk' ? 'acceptEdits' : a) };
  assert.deepEqual(promptingProfiles({ profiles: { claude: asks, 'claude-p': acceptEdits } }), ['claude', 'claude-p']);
  checkPermissionMode(ctxFor(scratch(t), { claude: asks, 'claude-p': acceptEdits }), sink);
  assert.equal(results.length, 1, 'one warning for the board, not one per profile');
  assert.equal(results[0].name, MODE_CHECK);
  assert.match(results[0].detail, /^claude, claude-p launch without/);
  assert.match(results[0].detail, /a prompt in a background worker blocks the attempt/);
  assert.match(results[0].fix, /add "--permission-mode", "dontAsk" to the launch/);
});

test('bypassPermissions and --dangerously-skip-permissions skip the prompt too (#159)', () => {
  const bypass = { ...DEFAULT_PROFILES.claude, launch: DEFAULT_PROFILES.claude.launch.map((a) => a === 'dontAsk' ? 'bypassPermissions' : a) };
  const dangerous = { ...DEFAULT_PROFILES['claude-p'], launch: [...DEFAULT_PROFILES['claude-p'].launch.filter((a) => a !== '--permission-mode' && a !== 'dontAsk'), '--dangerously-skip-permissions'] };
  assert.deepEqual(promptingProfiles({ profiles: { claude: bypass, 'claude-p': dangerous } }), [], 'neither leaves a prompt for nobody to answer');
});

test('doctor is silent on the profiles hkb ships, and asks nothing of a non-Claude launch', (t) => {
  const { results, sink } = collect();
  assert.deepEqual(promptingProfiles({ profiles: DEFAULT_PROFILES }), []);
  assert.equal(checkPermissionMode(ctxFor(scratch(t), DEFAULT_PROFILES), sink), null);
  assert.deepEqual(results, [], 'nothing to act on is nothing to print');
  // claude-action runs `gh workflow run`: the flags of the run it triggers live in the workflow file
  assert.deepEqual(promptingProfiles({ profiles: { 'claude-action': DEFAULT_PROFILES['claude-action'], codex: DEFAULT_PROFILES.codex } }), []);
});

// ---------- effort: the other reason a launch used to be pinned (#182) ----------

test('modelArgs renders --model then --effort, either or both dropped when unset', () => {
  assert.deepEqual(modelArgs({}), []);
  assert.deepEqual(modelArgs({ model: 'opus' }), ['--model', 'opus']);
  assert.deepEqual(modelArgs({ effort: 'medium' }), ['--effort', 'medium']);
  assert.deepEqual(modelArgs({ model: 'opus', effort: 'medium' }), ['--model', 'opus', '--effort', 'medium']);
});

test('loadBoard accepts a known effort level on a profile', (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles: { claude: { ...DEFAULT_PROFILES.claude, effort: 'medium' } } }));
  const cfg = loadBoard(root);
  assert.equal(cfg.profiles.claude.effort, 'medium');
});

test('loadBoard rejects an unknown effort level, naming the allowed set', (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles: { claude: { ...DEFAULT_PROFILES.claude, effort: 'urgent' } } }));
  assert.throws(() => loadBoard(root), (e) => {
    assert.match(e.message, /profile "claude" has effort "urgent"/);
    assert.match(e.message, new RegExp(EFFORT_LEVELS.join(', ')));
    assert.equal(e.exitCode, 2);
    return true;
  });
});

// A codex/copilot launch renders `{model_args}` too (#188 — measured: `codex exec --effort high` and
// `copilot ... --effort high` both die on the CLI's own "unknown option"), so an `effort` on either
// profile has to be refused before the first spawn ever discovers it, exactly like an unknown level.
test('loadBoard refuses effort on a harness with no --effort flag, naming the fix', (t) => {
  for (const name of ['codex', 'copilot-cli']) {
    const root = scratch(t);
    fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
    fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles: { [name]: { ...DEFAULT_PROFILES[name], effort: 'high' } } }));
    assert.throws(() => loadBoard(root), (e) => {
      assert.match(e.message, new RegExp(`profile "${name}" sets effort, but its harness \\(${DEFAULT_PROFILES[name].launch[0]}\\) takes no --effort flag; remove it`));
      assert.equal(e.exitCode, 2);
      return true;
    }, name);
  }
});

test('loadBoard leaves claude-action alone: effort is accepted there and ignored, not refused', (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles: { 'claude-action': { ...DEFAULT_PROFILES['claude-action'], effort: 'high' } } }));
  const cfg = loadBoard(root);
  assert.equal(cfg.profiles['claude-action'].effort, 'high', 'accepted at load time; the workflow it triggers does not plumb it through yet');
});

// ---------- tools posture: a profile states inherit or curate, absent meaning today's behaviour (#256) ----------

test('toolPosture: absent is curate — a profile with no "tools" key resolves byte-identically to today', () => {
  assert.equal(toolPosture({}), 'curate');
  assert.equal(toolPosture(DEFAULT_PROFILES.claude), 'curate', 'no shipped profile carries "tools" yet');
  assert.equal(toolPosture(null), 'curate');
  assert.equal(toolPosture(undefined), 'curate');
});

test('toolPosture: "inherit" resolves to itself, anything unrecognised falls back to "curate"', () => {
  assert.equal(toolPosture({ tools: 'inherit' }), 'inherit');
  assert.equal(toolPosture({ tools: 'curate' }), 'curate');
  assert.equal(toolPosture({ tools: 'yolo' }), 'curate', 'loadBoard refuses this before the resolver ever sees it — belt and suspenders');
});

test('loadBoard accepts "tools": "inherit" or "curate" on a profile', (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles: { claude: { ...DEFAULT_PROFILES.claude, tools: 'inherit' } } }));
  assert.equal(loadBoard(root).profiles.claude.tools, 'inherit');
});

test('loadBoard rejects an unknown tools posture, naming both allowed values', (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles: { claude: { ...DEFAULT_PROFILES.claude, tools: 'yolo' } } }));
  assert.throws(() => loadBoard(root), (e) => {
    assert.match(e.message, /profile "claude" has tools "yolo"/);
    assert.match(e.message, new RegExp(TOOL_POSTURES.join(', ')));
    assert.equal(e.exitCode, 2);
    return true;
  });
});

test('loadBoard on a board with no "tools" key at all is unchanged from before this field existed', (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles: { claude: DEFAULT_PROFILES.claude } }));
  const cfg = loadBoard(root);
  assert.equal(cfg.profiles.claude.tools, undefined);
  assert.equal(toolPosture(cfg.profiles.claude), 'curate');
});

// ---------- hkb init: says which posture the board got, and what it means, in one line ----------

const NWO = 'acme/tools-posture';

function gitRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-tools-')));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0, `git ${args.join(' ')}`);
  git('init', '-q', '-b', 'main');
  return root;
}

/** `init()`, exactly as the CLI runs it, against a temp git repo and a config home of its own. */
async function runInit(extra = []) {
  const root = gitRepo();
  const gh = new FakeGh();
  const restore = gh.install();
  const printed = [];
  const cwd = process.cwd();
  const originalConfigHome = process.env.KB_CONFIG_HOME;
  process.chdir(root);
  process.env.KB_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-tools-config-'));
  try {
    const { flags } = parseArgs(['init', '--repo', NWO, '--no-labels', ...extra]);
    const code = await init(makeContext(flags), flags, (s) => printed.push(s));
    return { root, printed, code };
  } finally {
    process.chdir(cwd);
    if (originalConfigHome === undefined) delete process.env.KB_CONFIG_HOME;
    else process.env.KB_CONFIG_HOME = originalConfigHome;
    restore();
  }
}

test('hkb init prints the tool posture it gave the board, and what it means', async () => {
  const { printed, code } = await runInit();
  assert.equal(code, 0);
  const line = printed.find((l) => l.startsWith('tools: '));
  assert.ok(line, `no line named the tool posture; printed:\n${printed.join('\n')}`);
  assert.match(line, /curate/);
  assert.match(line, /inherit/, 'the one line should also say how to get the opposite');
});

test('hkb init writes no "tools" key — a fresh board still resolves it by the silent default', async () => {
  const { root } = await runInit();
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.kanban', 'board.json'), 'utf8'));
  assert.equal(cfg.profiles.claude.tools, undefined);
});
