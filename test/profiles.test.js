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
import { DEFAULT_PROFILES, DEFAULT_BOARD, loadBoard, removedProfile, makeContext } from '../src/board.js';
import { SAFE_BUILTINS, EFFORT_LEVELS, TOOL_POSTURES, CAPABILITIES, toolPosture, capabilityCommand, modelArgs, allowedCommandsFrom, harnessCommands, uncoveredBuiltins } from '../src/model.js';
import { init } from '../src/init.js';
import { parseArgs } from '../src/cli.js';
import { checkWorkerPermissions, PERMS_CHECK, checkPermissionMode, promptingProfiles, MODE_CHECK } from '../src/doctor.js';
import { FakeGh } from './fake-gh.js';

const claude = () => DEFAULT_PROFILES.claude.allowed_tools;
const copilot = () => DEFAULT_PROFILES['copilot-cli'].allowed_tools;

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

// ---------- doctor: the migration path for boards carrying a frozen list ----------

test('doctor warns about a board.json profile pinning a pre-#138 allow-list', (t) => {
  const { results, sink } = collect();
  const stale = ['Bash(git *)', 'Bash(npm *)', 'Bash(true)', 'Edit'];
  checkWorkerPermissions(ctxFor(scratch(t), { claude: { ...DEFAULT_PROFILES.claude, allowed_tools: stale } }), sink);
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
  checkWorkerPermissions(ctxFor(scratch(t), { 'claude-big': { ...DEFAULT_PROFILES.claude, allowed_tools: stale } }), sink);
  assert.equal(results.length, 1);
  assert.match(results[0].fix, /^add Bash\(cd \*\), Bash\(pwd \*\), Bash\(true \*\)/);
  assert.match(results[0].fix, /to "allowed_tools" on the claude-big profile/);
  assert.match(results[0].fix, /no default to fall back to/);
  assert.ok(!/drop "allowed_tools"/.test(results[0].fix), 'the advice that empties the flag');
});

test('doctor is content with the lists hkb ships today', (t) => {
  const { results, sink } = collect();
  checkWorkerPermissions(ctxFor(scratch(t), DEFAULT_PROFILES), sink);
  assert.deepEqual(results.map((r) => r.ok), [true]);
  assert.equal(results[0].name, PERMS_CHECK);
  assert.match(results[0].detail, new RegExp(`cover the ${SAFE_BUILTINS.length} shell builtins`));
});

test('doctor says nothing on a board whose only profile has no allow-list', (t) => {
  const { results, sink } = collect();
  assert.equal(checkWorkerPermissions(ctxFor(scratch(t), { codex: DEFAULT_PROFILES.codex }), sink), null);
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
  // a non-Claude launch: `--permission-mode` is not its flag, and its sandbox is its own policy
  assert.deepEqual(promptingProfiles({ profiles: { codex: DEFAULT_PROFILES.codex } }), []);
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

// #290: the Actions runner is gone, and with it `mode: "trigger"`. A board.json that still names it
// would otherwise claim a card and then run `gh workflow run` as an ordinary worker process. It is
// DROPPED rather than refused: a throw from loadBoard reaches every command through makeContextAt,
// including the two that repair a board (`hkb init`, `hkb doctor`) and a worker's own terminal verbs.
test('loadBoard drops a profile that still names the removed trigger mode, and records why', (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles: { claude: {}, mine: { mode: 'trigger', launch: ['gh', 'workflow', 'run'] } } }));
  const cfg = loadBoard(root);
  assert.equal(cfg.profiles.mine, undefined, 'the profile is not loadable');
  assert.ok(cfg.profiles.claude, 'every other profile still loads');
  assert.deepEqual(cfg.removed_profiles.map((r) => r.name), ['mine']);
  assert.match(cfg.removed_profiles[0].why, /ADR-006/);
});

// The shape an operator actually writes to tweak a built-in carries no `mode` at all — this repo's
// own board.json said `"claude-action": {}` — so the sweep is keyed on the NAME as well.
test('loadBoard drops a removed profile named as a bare override, which carries no mode to match on', (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles: { claude: {}, 'claude-action': {} } }));
  const cfg = loadBoard(root);
  assert.equal(cfg.profiles['claude-action'], undefined);
  assert.deepEqual(cfg.removed_profiles.map((r) => r.name), ['claude-action']);
});

test('removedProfile: by name, by mode, and null for everything else', () => {
  assert.match(removedProfile('claude-action', {}), /ADR-006/);
  assert.match(removedProfile('mine', { mode: 'trigger' }), /ADR-006/);
  assert.equal(removedProfile('claude', DEFAULT_PROFILES.claude), null);
  assert.equal(removedProfile('mine', null), null);
});

// The record is about this load, not a field the operator owns: `hkb init` writes back the config it
// loaded, so a serialized `removed_profiles` would reappear in board.json as data nobody set.
test('removed_profiles never reaches board.json', (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles: { claude: {}, 'claude-action': {} } }));
  const cfg = loadBoard(root);
  assert.equal(JSON.parse(JSON.stringify(cfg)).removed_profiles, undefined);
});

// A `null` profile is how a human "removes" one in JSON; before this it reached the validators as a
// TypeError with no file and no fix in it.
test('loadBoard refuses a profile that is not an object, naming the file and the two ways out', (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles: { claude: null } }));
  assert.throws(() => loadBoard(root), (e) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /profile "claude"/);
    assert.match(e.message, /must be an object/);
    return true;
  });
});

test('the built-in profiles carry no trigger mode left to refuse', () => {
  assert.deepEqual(Object.entries(DEFAULT_PROFILES).filter(([, p]) => p.mode === 'trigger').map(([n]) => n), []);
  assert.equal(DEFAULT_PROFILES['claude-action'], undefined);
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

test('loadBoard accepts an mcp list of server names on a profile', (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles: { claude: { ...DEFAULT_PROFILES.claude, mcp: ['react-aria'] } } }));
  assert.deepEqual(loadBoard(root).profiles.claude.mcp, ['react-aria']);
});

// The dangerous shape is not a typo'd *name* — doctor is the place to notice a server nobody has —
// but a wrong *type*: the resolver reads a non-array as "declared nothing", so a board that wrote
// `"mcp": "supabase"` meaning to exclude a production server would silently keep granting it.
for (const bad of [{ mcp: 'supabase' }, { mcp: ['react-aria', ''] }, { mcp: [{ name: 'x' }] }]) {
  test(`loadBoard rejects mcp ${JSON.stringify(bad.mcp)} — it must be an array of server names`, (t) => {
    const root = scratch(t);
    fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
    fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles: { claude: { ...DEFAULT_PROFILES.claude, ...bad } } }));
    assert.throws(() => loadBoard(root), (e) => {
      assert.match(e.message, /profile "claude" has mcp /);
      assert.equal(e.exitCode, 2);
      return true;
    });
  });
}

test('a profile that declares no mcp key still loads, and is the shipped default', (t) => {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles: { claude: { ...DEFAULT_PROFILES.claude } } }));
  assert.equal(loadBoard(root).profiles.claude.mcp, undefined);
});

// ---------- capabilities: an intent from a closed vocabulary, bound to what this harness calls it (#217) ----------
//
// The point of the key is portability: the *intent* (`review`) is hkb's, the *binding* (`/code-review`)
// is the board's. So the vocabulary lives in src/model.js and no command name ever does — and a board
// that has never heard of the key must be indistinguishable from one written before it existed.

/** Write a board.json carrying `profiles` into a scratch root and return the root. */
function boardRoot(t, profiles) {
  const root = scratch(t);
  fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ profiles }));
  return root;
}

test('every CAPABILITIES intent says what it means, and this file names it', async () => {
  const src = fs.readFileSync(new URL('./profiles.test.js', import.meta.url), 'utf8');
  assert.ok(Object.keys(CAPABILITIES).length > 0);
  assert.ok(Object.isFrozen(CAPABILITIES), 'the vocabulary is closed — freezing is what says so');
  for (const [intent, meaning] of Object.entries(CAPABILITIES)) {
    assert.match(intent, /^[a-z][a-z_]*$/, `${intent} is not an intent name`);
    assert.equal(typeof meaning, 'string');
    assert.ok(meaning.trim().split(/\s+/).length >= 5,
      `${intent} has no meaning beside it — an intent nobody can read is an intent nobody can bind`);
    assert.ok(src.includes(`'${intent}'`), `no case in this file names ${intent}`);
  }
});

test('the vocabulary is intents only — hkb never names a harness command itself', () => {
  for (const meaning of Object.values(CAPABILITIES)) {
    assert.ok(!meaning.includes('/'), 'a slash command in the vocabulary is a binding leaking out of a board');
  }
  const shipped = JSON.stringify(DEFAULT_PROFILES);
  assert.ok(!shipped.includes('capabilities'), 'no shipped profile binds anything: absent means today\'s behaviour');
});

test('loadBoard accepts a capabilities map of known intents', (t) => {
  const bound = { review: '/code-review', goal: '/goal', specify: '/kanban:specify' };
  const cfg = loadBoard(boardRoot(t, { claude: { ...DEFAULT_PROFILES.claude, capabilities: bound } }));
  assert.deepEqual(cfg.profiles.claude.capabilities, bound);
  assert.equal(capabilityCommand(cfg.profiles.claude, 'review'), '/code-review');
});

test('loadBoard rejects an unknown intent, naming the vocabulary', (t) => {
  const root = boardRoot(t, { claude: { ...DEFAULT_PROFILES.claude, capabilities: { reveiw: '/code-review' } } });
  assert.throws(() => loadBoard(root), (e) => {
    assert.match(e.message, /profile "claude"/);
    assert.match(e.message, /unknown capability "reveiw"/);
    assert.match(e.message, new RegExp(Object.keys(CAPABILITIES).join(', ')));
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

/**
 * `init()`, exactly as the CLI runs it, against a temp git repo and a config home of its own.
 * Pass `into` to re-init a root a previous call made — the second `init` over an existing
 * board.json is a different code path from the first, and the posture line has to survive it.
 */
async function runInit(extra = [], into = null) {
  const root = into || gitRepo();
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

// The line's whole job is to name the posture this board has, so it must read the board, not a
// constant: an `init` over a profile that already says "inherit" and hears "curate (default)" is
// worse than silence, because it is the one place a human is told what their workers may reach for.
test('the posture line names the profile that inherits, on a board that already set one', async (t) => {
  const { root } = await runInit();
  const file = path.join(root, '.kanban', 'board.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.profiles.claude.tools = 'inherit';
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  const { printed } = await runInit([], root);
  const line = printed.find((l) => l.startsWith('tools: '));
  assert.match(line, /inherit on .*claude/, 'names the profile, not the default');
  assert.doesNotMatch(line, /curate \(default\)/);
});

test('hkb init writes no "tools" key — a fresh board still resolves it by the silent default', async () => {
  const { root } = await runInit();
  const cfg = JSON.parse(fs.readFileSync(path.join(root, '.kanban', 'board.json'), 'utf8'));
  assert.equal(cfg.profiles.claude.tools, undefined);
});

test('loadBoard rejects a capabilities map that is not a map, or a binding that names no command', (t) => {
  const bad = [
    [['review'], /must be an object mapping an intent/],
    ['/code-review', /must be an object mapping an intent/],
    [{ review: '' }, /capability "review" must name this harness's command/],
    [{ review: 42 }, /capability "review" must name this harness's command/],
  ];
  for (const [capabilities, re] of bad) {
    const root = boardRoot(t, { claude: { ...DEFAULT_PROFILES.claude, capabilities } });
    assert.throws(() => loadBoard(root), (e) => {
      assert.match(e.message, re);
      assert.equal(e.exitCode, 2);
      return true;
    }, JSON.stringify(capabilities));
  }
});

// The whole promise of the feature: a Copilot or Codex board that never heard of `capabilities` is
// not merely "still working" — it loads to exactly the same object it did before the key existed.
test('a board with no capabilities key loads byte-identically to today', (t) => {
  const cfg = loadBoard(boardRoot(t, { claude: DEFAULT_PROFILES.claude, codex: DEFAULT_PROFILES.codex }));
  assert.deepEqual(cfg.profiles.claude, DEFAULT_PROFILES.claude);
  assert.deepEqual(cfg.profiles.codex, DEFAULT_PROFILES.codex);
  assert.ok(!JSON.stringify(cfg).includes('capabilities'), 'nothing is defaulted in — absent stays absent');
  for (const p of Object.values(cfg.profiles)) assert.equal(capabilityCommand(p, 'review'), null);
});

test('capabilityCommand: bound wins, unbound is null and never a throw', () => {
  const p = { capabilities: { review: '/code-review', goal: '  ' } };
  assert.equal(capabilityCommand(p, 'review'), '/code-review');
  assert.equal(capabilityCommand(p, 'goal'), null, 'a blank binding binds nothing');
  assert.equal(capabilityCommand(p, 'specify'), null, 'an unmapped intent falls back to the prose brief');
  assert.equal(capabilityCommand(p, 'nonsense'), null, 'an intent outside the vocabulary is a caller bug, not a crash');
  for (const notAProfile of [null, undefined, {}, { capabilities: null }, { capabilities: ['review'] }]) {
    assert.equal(capabilityCommand(notAProfile, 'review'), null);
  }
  assert.equal(capabilityCommand({ capabilities: { toString: '/nope' } }, 'toString'), null, 'inherited keys bind nothing');
});
