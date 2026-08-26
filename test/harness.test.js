// `hkb init --harness copilot`: the generated Copilot files, the launch template that uses them,
// and the stop-hook payload both harnesses feed to `hkb hook stop`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { harnessFiles, installHarness, resolveProfiles, HARNESSES, HARNESS_PROFILE, packageSkillDir } from '../src/init.js';
import { parseArgs } from '../src/cli.js';
import { DEFAULT_BOARD, DEFAULT_PROFILES, ensureWorktree } from '../src/board.js';
import { expandLaunch, tick } from '../src/dispatch.js';
import { stripFrontmatter, worktreePath } from '../src/model.js';
import { FakeGh, kbIssue } from './fake-gh.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const AGENT = path.join('.github', 'agents', 'kanban-worker.agent.md');
const HOOKS = path.join('.github', 'hooks', 'kanban.json');

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-harness-'));
const fileMap = (name, opts) => Object.fromEntries(harnessFiles(name, opts).map((f) => [f.rel, f.contents]));

test('harnessFiles(copilot) produces exactly the agent and the hook config', () => {
  assert.deepEqual(harnessFiles('copilot').map((f) => f.rel), [AGENT, HOOKS]);
});

test('the generated agent carries the SKILL.md protocol verbatim — one source of truth', () => {
  const agent = fileMap('copilot')[AGENT];
  const body = stripFrontmatter(fs.readFileSync(path.join(packageSkillDir(), 'SKILL.md'), 'utf8')).trimEnd();
  // the only edit is the relative link, which does not resolve from .github/agents/
  const spliced = body.replace(/`references\/protocol\.md`/g, '`.agents/skills/kanban/references/protocol.md`');
  assert.ok(agent.includes(spliced), 'the whole SKILL.md body must be spliced in');
  assert.ok(!agent.includes('{{protocol}}'), 'placeholder left unsubstituted');
  assert.ok(!/`references\/protocol\.md`/.test(agent), 'skill-relative link left pointing nowhere');
  assert.ok(agent.includes('hkb complete $KB_TASK'), 'the terminal verb must survive the splice');
});

test('the generated agent has the front matter Copilot selects it by', () => {
  const agent = fileMap('copilot')[AGENT];
  assert.match(agent, /^---\n/);
  assert.match(agent, /^name: kanban-worker$/m);
  assert.match(agent, /^description: .{20,}/m);
  // the copilot-cli profile asks for this agent by name; the two must not drift apart
  assert.ok(DEFAULT_PROFILES['copilot-cli'].launch.includes('kanban-worker'));
});

test('the generated hook config fires hkb on agentStop', () => {
  const hooks = JSON.parse(fileMap('copilot')[HOOKS]);
  const groups = hooks.hooks.agentStop;
  assert.ok(Array.isArray(groups) && groups.length === 1);
  const [entry] = groups[0].hooks;
  assert.equal(entry.type, 'command');
  assert.equal(entry.command, 'hkb hook stop');
  assert.equal(entry.timeout, 30);
  assert.deepEqual(Object.keys(hooks.hooks), ['agentStop'], 'no other event should be claimed');
});

test('the hook command is substituted, so a repo without hkb on PATH still gets a working hook', () => {
  const hooks = JSON.parse(fileMap('copilot', { command: 'node "/opt/hkb/bin/hkb.js" hook stop' })[HOOKS]);
  assert.equal(hooks.hooks.agentStop[0].hooks[0].command, 'node "/opt/hkb/bin/hkb.js" hook stop');
});

test('an unknown harness names the ones that exist', () => {
  assert.throws(() => harnessFiles('emacs'), (e) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /unknown harness "emacs"\. Known: copilot/);
    return true;
  });
});

test('installHarness writes the files, then reports nothing to do', () => {
  const root = scratch();
  assert.deepEqual(installHarness(root, 'copilot'), [AGENT, HOOKS]);
  assert.ok(fs.existsSync(path.join(root, AGENT)));
  assert.ok(fs.existsSync(path.join(root, HOOKS)));
  assert.deepEqual(installHarness(root, 'copilot'), [], 'idempotent: a second init rewrites nothing');
});

test('installHarness restores a file that drifted, and only that file', () => {
  const root = scratch();
  installHarness(root, 'copilot');
  const hooksBefore = fs.readFileSync(path.join(root, HOOKS), 'utf8');
  fs.writeFileSync(path.join(root, AGENT), 'someone edited the generated agent\n');
  assert.deepEqual(installHarness(root, 'copilot'), [AGENT]);
  assert.ok(fs.readFileSync(path.join(root, AGENT), 'utf8').includes('name: kanban-worker'));
  assert.equal(fs.readFileSync(path.join(root, HOOKS), 'utf8'), hooksBefore);
});

test('`hkb init --harness copilot` sets up for Copilot instead of the claude default', () => {
  const { flags } = parseArgs(['init', '--harness', 'copilot']);
  assert.equal(flags.harness, 'copilot');
  assert.deepEqual(resolveProfiles(flags), { harnesses: ['copilot'], profiles: ['copilot-cli'] });
});

test('naming --profiles keeps them, and the harness still brings its own', () => {
  assert.deepEqual(resolveProfiles({ profiles: 'claude, claude-p', harness: 'copilot' }).profiles, ['claude', 'claude-p', 'copilot-cli']);
  assert.deepEqual(resolveProfiles({ profiles: 'copilot-cli', harness: 'copilot' }).profiles, ['copilot-cli'], 'no duplicate');
  assert.deepEqual(resolveProfiles({}), { harnesses: [], profiles: ['claude'] }, 'no --harness: nothing changes');
  assert.deepEqual(resolveProfiles({ profiles: 'codex' }).profiles, ['codex'], 'a profile with no built-in is still the user\'s call');
});

test('init refuses a harness it cannot generate for, before touching the repo', () => {
  assert.throws(() => resolveProfiles({ harness: 'copilot,emacs' }), (e) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /unknown harness "emacs"\. Known: copilot/);
    return true;
  });
});

test('every harness brings a profile that exists as a built-in', () => {
  for (const h of HARNESSES) assert.ok(DEFAULT_PROFILES[HARNESS_PROFILE[h]], `${h} → ${HARNESS_PROFILE[h]}`);
});

test('the copilot-cli profile runs in a dispatcher-made worktree and allow-lists per command', () => {
  const p = DEFAULT_PROFILES['copilot-cli'];
  assert.equal(p.workspace, 'worktree', 'Copilot CLI has no --worktree flag; the dispatcher makes one');
  assert.equal(p.mode, 'process');
  assert.ok(!p.launch.some((el) => /\{n\}|\{k\}/.test(el)), 'the worktree is the cwd, not an argument');

  const argv = expandLaunch(p.launch, { prompt: 'do the thing', model: 'gpt-5' }, p);
  assert.deepEqual(argv.slice(0, 5), ['copilot', '-p', 'do the thing', '--agent', 'kanban-worker']);
  // one --allow-tool per pattern, and the shell(...) spelling Copilot uses
  const allowed = argv.filter((_, i) => argv[i - 1] === '--allow-tool');
  assert.deepEqual(allowed, p.allowed_tools);
  assert.ok(allowed.includes('shell(hkb *)') && allowed.includes('shell(git *)') && allowed.includes('shell(gh pr *)'));
  assert.ok(allowed.includes('write'));
  const denied = argv.filter((_, i) => argv[i - 1] === '--deny-tool');
  assert.ok(denied.some((d) => /git push --force/.test(d)), 'force-push must be denied at launch');
  assert.deepEqual(argv.slice(-2), ['--model', 'gpt-5']);
});

test('expandLaunch leaves --model out when no model is set, in both flag styles', () => {
  const profile = { allowed_tools: ['shell(a)', 'shell(b)'] };
  assert.deepEqual(
    expandLaunch(['x', '--allow-tool={allowed_tools}', '{model_args}'], {}, profile),
    ['x', '--allow-tool', 'shell(a)', '--allow-tool', 'shell(b)'],
  );
  assert.deepEqual(
    expandLaunch(['x', '--allowedTools', '{allowed_tools}'], {}, profile),
    ['x', '--allowedTools', 'shell(a)', 'shell(b)'],
  );
});

// ---------- the worktree the dispatcher makes for a harness that has no flag for it ----------

function gitRepo() {
  const root = fs.realpathSync(scratch()); // macOS /var → /private/var; git reports the real path
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'root');
  return root;
}

test('ensureWorktree makes .claude/worktrees/<name> on its own branch, and reuses it', () => {
  const root = gitRepo();
  const dir = ensureWorktree(root, 'kb-7-1');
  assert.equal(dir, path.join(root, worktreePath('kb-7-1')));
  assert.ok(fs.existsSync(path.join(dir, '.git')));
  const head = spawnSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' });
  assert.equal(head.stdout.trim(), 'kb-7-1');
  assert.equal(ensureWorktree(root, 'kb-7-1'), dir, 'a second call must not fail on the existing worktree');
});

test('ensureWorktree checks out a branch an earlier attempt left behind', () => {
  const root = gitRepo();
  const dir = ensureWorktree(root, 'kb-8-1');
  spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root }); // branch kb-8-1 survives
  assert.equal(spawnSync('git', ['rev-parse', '--verify', 'kb-8-1'], { cwd: root }).status, 0);
  assert.equal(ensureWorktree(root, 'kb-8-1'), dir);
  assert.ok(fs.existsSync(path.join(dir, '.git')));
});

test('ensureWorktree says what failed when git refuses', () => {
  const root = scratch(); // not a git repository
  assert.throws(() => ensureWorktree(root, 'kb-9-1'), (e) => {
    assert.equal(e.exitCode, 2);
    assert.match(e.message, /git worktree add \.claude\/worktrees\/kb-9-1 failed: /);
    return true;
  });
});

test('the tick runs a workspace:worktree profile in the worktree it just created', async (t) => {
  const gh = new FakeGh();
  const root = gitRepo();
  const cfg = {
    ...DEFAULT_BOARD,
    repo: gh.nameWithOwner,
    // the copilot-cli shape, with `true` in place of the real binary
    profiles: { 'copilot-cli': { mode: 'process', workspace: 'worktree', max_in_progress: 1, allowed_tools: [], launch: ['true'] } },
  };
  const ctx = {
    root, cfg, repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {}, requireBoard() { return this; },
  };
  const restore = gh.install();
  t.after(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });
  gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'copilot-cli' }));

  const s = await tick(ctx, {});

  assert.deepEqual(s.claimed.map((c) => c.number), [7]);
  assert.equal(s.claimed[0].wt, 'kb-7-1');
  assert.ok(fs.existsSync(path.join(root, worktreePath('kb-7-1'), '.git')), 'the worker got a checkout of its own');
  const [attempt] = gh.runOf(7).attempts;
  assert.equal(attempt.wt, 'kb-7-1', 'the attempt row records the worktree, for gc and post-mortems');
  assert.equal(attempt.bg, undefined);
});

test('this repo ships the copilot templates the generator reads', () => {
  for (const f of ['kanban-worker.agent.md', 'hooks.json']) {
    assert.ok(fs.existsSync(path.join(REPO, 'templates', 'copilot', f)), `templates/copilot/${f}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('templates'), 'templates/ must be published or --harness breaks on npm installs');
});
