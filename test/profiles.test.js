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
import { DEFAULT_PROFILES, DEFAULT_BOARD } from '../src/board.js';
import { SAFE_BUILTINS, allowedCommandsFrom, harnessCommands, uncoveredBuiltins } from '../src/model.js';
import { actionsFiles, ACTIONS_PROFILE } from '../src/init.js';
import { checkWorkerPermissions, workflowAllowedTools, PERMS_CHECK } from '../src/doctor.js';

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

test('doctor warns about a board.json profile pinning a pre-#138 allow-list', () => {
  const { results, sink } = collect();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-perms-'));
  const stale = ['Bash(git *)', 'Bash(npm *)', 'Bash(true)', 'Edit'];
  checkWorkerPermissions(ctxFor(root, { claude: { ...DEFAULT_PROFILES.claude, allowed_tools: stale } }), sink, { exists: () => false });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, null);
  assert.equal(results[0].name, 'profile claude permissions');
  assert.match(results[0].detail, /omits cd, pwd, false, echo \+11 more/); // `true` is the one it did cover
  assert.match(results[0].fix, /drop "allowed_tools" from the claude profile/);
});

test('doctor warns about the generated workflow when its baked list is stale', () => {
  const { results, sink } = collect();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-perms-'));
  const old = '            --allowedTools "Bash(git *),Bash(true),Edit"\n';
  checkWorkerPermissions(ctxFor(root, {}), sink, { exists: () => true, read: () => old });
  assert.equal(results.length, 1);
  assert.equal(results[0].name, 'actions worker permissions');
  assert.equal(results[0].fix, 'hkb init --with-actions');
});

test('doctor is content with the lists hkb ships today', () => {
  const { results, sink } = collect();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-perms-'));
  const yml = actionsFiles().find((f) => f.rel === WORKER).contents;
  checkWorkerPermissions(ctxFor(root, DEFAULT_PROFILES), sink, { exists: () => true, read: () => yml });
  assert.deepEqual(results.map((r) => r.ok), [true]);
  assert.equal(results[0].name, PERMS_CHECK);
  assert.match(results[0].detail, new RegExp(`cover the ${SAFE_BUILTINS.length} shell builtins`));
});

test('doctor says nothing on a board whose only profile has no allow-list', () => {
  const { results, sink } = collect();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-perms-'));
  assert.equal(checkWorkerPermissions(ctxFor(root, { codex: DEFAULT_PROFILES.codex }), sink, { exists: () => false }), null);
  assert.deepEqual(results, []);
});

test('an unreadable workflow is checkActions\' problem, not this check\'s', () => {
  const { results, sink } = collect();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-perms-'));
  checkWorkerPermissions(ctxFor(root, {}), sink, { exists: () => true, read: () => { throw new Error('EACCES'); } });
  assert.deepEqual(results, []);
});
