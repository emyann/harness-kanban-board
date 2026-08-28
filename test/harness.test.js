// `hkb init --harness copilot|codex`: the files each harness gets generated, the launch templates
// that use them, and the stop-hook payload every harness feeds to `hkb hook stop`. Plus the two
// hooks the default harness gets, which settings file they land in, and what init says it wrote.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  harnessFiles, installHarness, installClaudeHooks, hookSummary, CLAUDE_HOOKS, resolveProfiles, boardProfiles,
  HARNESSES, HARNESS_PROFILE, packageSkillDir, HOOK_SETTINGS, NPX_COMMAND, hkbCommandForHook, hookPlacement,
  hookCommandNeeds, isHkbHookCommand, isPortableHookCommand, isEphemeralPath, findClaudeHooks, actionsFiles,
  projectBinRel, guardedHookCommand, resolveHookPath, PROJECT_DIR,
} from '../src/init.js';
import { parseArgs } from '../src/cli.js';
import { DEFAULT_BOARD, DEFAULT_PROFILES, CLAUDE_DENY, ensureWorktree } from '../src/board.js';
import { expandLaunch, spawnWorker, tick } from '../src/dispatch.js';
import { checkHarnesses, checkHooks } from '../src/doctor.js';
import { stripFrontmatter, worktreePath, isLocalInstall, stripNodeModulesBin } from '../src/model.js';
import { FakeGh, kbIssue } from './fake-gh.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const AGENT = path.join('.github', 'agents', 'kanban-worker.agent.md');
const HOOKS = path.join('.github', 'hooks', 'kanban.json');
const CODEX_HOOKS = path.join('.codex', 'hooks.json');
const CODEX_NOTES = path.join('.codex', 'README.md');

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
  assert.ok(agent.includes('hkb finish $KB_TASK'), 'the terminal verb must survive the splice');
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

test('a fresh board gets only the profiles that were resolved, not all six defaults', () => {
  assert.deepEqual(Object.keys(boardProfiles(null, ['claude'])), ['claude'], 'a bare init is Claude-only');
  assert.deepEqual(Object.keys(boardProfiles(null, resolveProfiles({ profiles: 'claude,codex' }).profiles)), ['claude', 'codex']);
  assert.deepEqual(Object.keys(boardProfiles(null, resolveProfiles({ harness: 'copilot' }).profiles)), ['copilot-cli']);
  // and each one is the built-in of that name, deep-copied so board.json can be edited freely
  const p = boardProfiles(null, ['claude']).claude;
  assert.deepEqual(p, DEFAULT_PROFILES.claude);
  p.allowed_tools.push('Bash(rm *)');
  assert.ok(!DEFAULT_PROFILES.claude.allowed_tools.includes('Bash(rm *)'), 'the default was not mutated');
});

test('a second init only adds: a hand-added profile and hand-edited settings survive', () => {
  const existing = { claude: { max_in_progress: 7 }, homegrown: { launch: ['my-agent'] } };
  const after = boardProfiles(existing, ['claude', 'codex']);
  assert.deepEqual(Object.keys(after), ['claude', 'homegrown', 'codex']);
  assert.equal(after.claude.max_in_progress, 7, 'an existing profile is left exactly as it was');
  assert.deepEqual(after.homegrown.launch, ['my-agent'], 'never delete a profile the operator added');
  assert.deepEqual(existing, { claude: { max_in_progress: 7 }, homegrown: { launch: ['my-agent'] } }, 'pure');
});

test('a profile with no built-in gets a stub, and says so once', () => {
  const unknown = [];
  const out = boardProfiles(null, ['claude', 'aider'], (p) => unknown.push(p));
  assert.deepEqual(unknown, ['aider']);
  assert.deepEqual(out.aider, { max_in_progress: 1, launch: null });
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
  assert.ok(allowed.includes('shell(hkb:*)') && allowed.includes('shell(git:*)') && allowed.includes('shell(gh:*)'));
  assert.ok(!allowed.some((a) => /shell\([^)]* \*\)/.test(a))); // no space-star spellings
  assert.ok(allowed.includes('--no-ask-user') === false); // flag lives in launch, not the tool list
  assert.ok(allowed.includes('write'));
  const denied = argv.filter((_, i) => argv[i - 1] === '--deny-tool');
  assert.ok(denied.some((d) => /git push --force/.test(d)), 'force-push must be denied at launch');
  assert.deepEqual(argv.slice(-2), ['--model', 'gpt-5']);
});

// ---------- what the launch refuses, on every profile that spawns Claude Code ----------
//
// hkb's PreToolUse guard has denied `hkb dispatch` since #23, but it is KB_TASK-gated and so inert
// on `claude --bg` — the default profile. The launch line is the layer that is live everywhere, so
// what a worker must never run has to be said there (#143).

test('every Claude launch denies the dispatcher, and says dontAsk so a denial is not a prompt', () => {
  for (const name of ['claude', 'claude-track', 'claude-p']) {
    const p = DEFAULT_PROFILES[name];
    const argv = expandLaunch(p.launch, { n: 7, k: 1, title: 't', prompt: 'do the thing' }, p);
    const after = argv.slice(argv.indexOf('--disallowedTools') + 1);
    const denied = after.slice(0, after.findIndex((a) => a.startsWith('--')));
    assert.ok(denied.includes('Bash(hkb dispatch*)'), `${name} does not deny the dispatcher: ${denied.join(' ')}`);
    assert.ok(denied.some((d) => /git push --force/.test(d)), `${name} stopped denying force-push`);
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk', `${name} would prompt, and nobody is there to answer`);
    assert.deepEqual(denied, CLAUDE_DENY, `${name} carries its own deny list instead of the shared one`);
  }
});

test('the generated Actions worker carries the same deny list as a local launch', () => {
  const yml = actionsFiles().find((f) => /worker-claude/.test(f.rel)).contents;
  const m = /--disallowedTools "([^"]*)"/.exec(yml);
  assert.ok(m, '--disallowedTools went missing from the worker workflow');
  assert.deepEqual(m[1].split(','), CLAUDE_DENY);
  assert.ok(CLAUDE_DENY.includes('Bash(hkb dispatch*)'));
});

test('Copilot gets no dispatch deny — its pattern language is unverified for it (told in the prompt instead)', () => {
  const p = DEFAULT_PROFILES['copilot-cli'];
  const argv = expandLaunch(p.launch, { prompt: 'x' }, p);
  const denied = argv.filter((_, i) => argv[i - 1] === '--deny-tool');
  assert.ok(!denied.some((d) => /dispatch/.test(d)), 'a deny that matches nothing reads as protection there is none of');
  const skill = fs.readFileSync(path.join(packageSkillDir(), 'SKILL.md'), 'utf8');
  assert.match(skill, /Never run `hkb dispatch`/, 'then the prompt is the only place that says it');
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

// ---------- codex ----------

test('harnessFiles(codex) produces the Stop hook and the notes, and no agent file', () => {
  assert.deepEqual(harnessFiles('codex').map((f) => f.rel), [CODEX_HOOKS, CODEX_NOTES]);
});

test('the generated codex hook config fires hkb on Stop', () => {
  const hooks = JSON.parse(fileMap('codex')[CODEX_HOOKS]);
  assert.deepEqual(Object.keys(hooks.hooks), ['Stop'], 'no other event should be claimed');
  const [entry] = hooks.hooks.Stop[0].hooks;
  assert.deepEqual(entry, { type: 'command', command: 'hkb hook stop', timeout: 30 });
});

test('every harness substitutes the hook command, so a repo without hkb on PATH still works', () => {
  const command = 'node "/opt/hkb/bin/hkb.js" hook stop';
  for (const h of HARNESSES) {
    const json = harnessFiles(h, { command }).find((f) => f.rel.endsWith('.json'));
    const commands = Object.values(JSON.parse(json.contents).hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((e) => e.command)));
    assert.deepEqual(commands, [command], `${h}: one hook, running exactly the command init was given, quotes intact`);
  }
});

test('the codex notes name this repo by absolute path, TOML-escaped', () => {
  const notes = fileMap('codex', { root: 'C:\\Users\\me\\repo' })[CODEX_NOTES];
  assert.match(notes, /^\[projects\."C:\\\\Users\\\\me\\\\repo"\]$/m, 'a Windows path must not smuggle escapes into the TOML');
  assert.match(notes, /^trust_level = "trusted"$/m);
  assert.ok(!notes.includes('{{'), 'placeholder left unsubstituted');
});

test('the codex notes carry the one-time trust steps and no MCP server', () => {
  const notes = fileMap('codex')[CODEX_NOTES];
  assert.match(notes, /`\/hooks`/, 'the TUI route to trusting the project hooks');
  assert.match(notes, /trust_level = "trusted"/, 'the config route');
  assert.match(notes, /network_access = true/, 'without it a worker cannot push, open a PR or heartbeat');
  assert.match(notes, /writable_roots = \[/, 'a worktree commits into the main repo, outside the sandbox');
  assert.ok(!/^\[mcp_servers/m.test(notes), 'hkb workers call the CLI directly — there is no MCP table to generate');
});

test('installHarness(codex) writes both files, then reports nothing to do', () => {
  const root = scratch();
  assert.deepEqual(installHarness(root, 'codex'), [CODEX_HOOKS, CODEX_NOTES]);
  assert.deepEqual(installHarness(root, 'codex'), [], 'idempotent: a second init rewrites nothing');
  const notes = fs.readFileSync(path.join(root, CODEX_NOTES), 'utf8');
  assert.ok(notes.includes(`[projects."${root}"]`), 'installHarness passes the real repo root, not the placeholder');
});

test('`hkb init --harness codex` sets up for Codex instead of the claude default', () => {
  const { flags } = parseArgs(['init', '--harness', 'codex']);
  assert.deepEqual(resolveProfiles(flags), { harnesses: ['codex'], profiles: ['codex'] });
  assert.deepEqual(resolveProfiles({ harness: 'copilot,codex' }).profiles, ['copilot-cli', 'codex']);
});

test('the codex profile runs `codex exec` in a dispatcher-made worktree, sandboxed to it', () => {
  const p = DEFAULT_PROFILES.codex;
  assert.equal(p.workspace, 'worktree', 'Codex has no worktree flag; the dispatcher makes one');
  assert.equal(p.mode, 'process');
  const argv = expandLaunch(p.launch, { worktree: '/w/kb-4-2', prompt: 'do the thing', model: 'gpt-5-codex' }, p);
  assert.deepEqual(argv, [
    'codex', 'exec', '-C', '/w/kb-4-2',
    '--sandbox', 'workspace-write',
    '--output-schema', '.agents/skills/kanban/schema/terminal.json',
    '--model', 'gpt-5-codex', 'do the thing',
  ]);
  assert.deepEqual(expandLaunch(p.launch, { worktree: '/w', prompt: 'p' }, p).slice(-1), ['p'], 'no model: the prompt stays last');
});

test('the schema the codex launch names is committed, where a worktree will find it', () => {
  const i = DEFAULT_PROFILES.codex.launch.indexOf('--output-schema');
  const schema = DEFAULT_PROFILES.codex.launch[i + 1];
  assert.ok(fs.existsSync(path.join(REPO, schema)), `${schema} must exist — codex exec refuses to start without it`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(REPO, schema), 'utf8')).required, ['task', 'verb', 'summary']);
  // in this repo .agents/skills/kanban is a committed symlink to skills/kanban; elsewhere init
  // copies the skill in. Either way the path has to come with the checkout the worker gets.
  const tracked = spawnSync('git', ['ls-files', '.agents/skills/kanban'], { cwd: REPO, encoding: 'utf8' });
  assert.ok(tracked.stdout.trim(), 'the skill has to be committed, or the worker\'s worktree will not have it');
});

test('doctor reports a configured harness only, and names the init that fixes it', () => {
  const root = scratch();
  const rows = [];
  const sink = { ok: (name, detail) => rows.push({ name, ok: true, detail }), warn: (name, detail, fix) => rows.push({ name, ok: null, detail, fix }) };
  const ctx = { root, cfg: { profiles: { claude: {} } } };
  checkHarnesses(ctx, sink);
  assert.deepEqual(rows, [], 'no harness profile, nothing to say');

  ctx.cfg.profiles.codex = DEFAULT_PROFILES.codex;
  checkHarnesses(ctx, sink);
  assert.equal(rows[0].ok, null);
  assert.match(rows[0].detail, /missing \.codex[/\\]hooks\.json, \.codex[/\\]README\.md/);
  assert.equal(rows[0].fix, 'hkb init --harness codex');

  installHarness(root, 'codex');
  rows.length = 0;
  checkHarnesses(ctx, sink);
  assert.equal(rows[0].ok, true, 'generated → clean');
  assert.match(rows[0].detail, /one-time trust/);
});

test('the dispatcher hands codex the worktree it is about to create, as an absolute path', async (t) => {
  const gh = new FakeGh();
  const root = fs.realpathSync(scratch());
  const ctx = {
    root,
    cfg: { ...DEFAULT_BOARD, repo: gh.nameWithOwner, profiles: { codex: DEFAULT_PROFILES.codex } },
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {}, requireBoard() { return this; },
  };
  const restore = gh.install();
  t.after(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });
  gh.addIssue(kbIssue({ number: 12, status: 'ready', agent: 'codex' }));
  const { fetchBoard } = await import('../src/tasks.js');
  const [task] = await fetchBoard(ctx);

  const { argv } = await spawnWorker(ctx, task, 'codex', 3, { dryRun: true });

  assert.equal(argv[argv.indexOf('-C') + 1], path.join(root, worktreePath('kb-12-3')));
  assert.ok(argv[argv.length - 1].includes('#12'), 'the last argument is the task context');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'worktrees')), 'a dry run creates nothing');
});

test('this repo ships the codex templates the generator reads', () => {
  for (const f of ['hooks.json', 'notes.md']) {
    assert.ok(fs.existsSync(path.join(REPO, 'templates', 'codex', f)), `templates/codex/${f}`);
  }
});

// ---------- claude, the default harness: the hooks init writes into a settings file ----------
// Unlike the generated harness files, these go into a file every other session in that repo reads.
// The tracked `.claude/settings.json` is read on machines that are not this one, and no command hkb
// can write means the same thing there (#85) — so the default is the gitignored
// `.claude/settings.local.json`, `--shared-hooks` opts into the tracked file with the one portable
// form, and either way: touch nothing else, land in exactly one file, and name everything written.

const LOCAL = HOOK_SETTINGS.local, SHARED = HOOK_SETTINGS.shared;
const readSettings = (root, rel = LOCAL) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const writeSettings = (root, rel, value) => {
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, rel), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};
const commandsOf = (groups) => groups.flatMap((g) => g.hooks.map((h) => h.command));
const hookGroups = (verb, command) => [{ matcher: '*', hooks: [{ type: 'command', command: `${command} hook ${verb}`, timeout: 30 }] }];
/** A settings object with hkb's two hooks running `command hook <verb>`. */
const withHkbHooks = (command) => ({ hooks: Object.fromEntries(Object.entries(CLAUDE_HOOKS).map(([e, v]) => [e, hookGroups(v, command)])) });

test('installClaudeHooks writes both hooks into the local, gitignored settings file', () => {
  const root = scratch();
  const r = installClaudeHooks(root, () => {});
  assert.equal(r.file, LOCAL, 'a machine-specific command must not land in the tracked file');
  assert.deepEqual(r.added, ['Stop', 'PreToolUse']);
  assert.equal(fs.existsSync(path.join(root, SHARED)), false, 'nothing is written to the shared file by default');

  const s = readSettings(root);
  assert.deepEqual(Object.keys(s.hooks), ['Stop', 'PreToolUse'], 'no other event should be claimed');
  for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
    assert.equal(s.hooks[event].length, 1);
    const [group] = s.hooks[event];
    assert.equal(group.matcher, '*');
    assert.deepEqual(group.hooks.map((h) => h.type), ['command']);
    assert.equal(group.hooks[0].timeout, 30);
    assert.match(group.hooks[0].command, new RegExp(`hkb.* hook ${verb}$`), `${event} must run \`hkb hook ${verb}\``);
  }
  assert.deepEqual(installClaudeHooks(root, () => {}).added, [], 'idempotent: a second init adds nothing');
});

test('--shared-hooks writes the tracked file, and only ever a plain `hkb`', () => {
  const root = scratch();
  const r = installClaudeHooks(root, () => {}, { shared: true });
  assert.equal(r.file, SHARED);
  assert.deepEqual(r.added, ['Stop', 'PreToolUse']);
  assert.equal(fs.existsSync(path.join(root, LOCAL)), false);
  for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
    assert.equal(commandsOf(readSettings(root, SHARED).hooks[event])[0], `hkb hook ${verb}`, 'a tracked file cannot name this machine');
  }
});

test('the hooks live in exactly one file — a second copy fires every nudge twice', () => {
  const root = scratch();
  installClaudeHooks(root, () => {});
  const moved = installClaudeHooks(root, () => {}, { shared: true });
  assert.equal(moved.file, SHARED);
  assert.equal(moved.movedFrom, LOCAL);
  assert.deepEqual(readSettings(root, LOCAL).hooks, undefined, "hkb's hooks are gone from the file it left");
  assert.deepEqual(Object.keys(readSettings(root, SHARED).hooks), ['Stop', 'PreToolUse']);
});

test('hooks already in the tracked file with a portable command are left where they are', () => {
  const root = scratch();
  writeSettings(root, SHARED, withHkbHooks('hkb'));

  const r = installClaudeHooks(root, () => {});

  assert.equal(r.file, SHARED, 'a portable command in the shared file is a choice, not the bug');
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.repaired, []);
  assert.equal(fs.existsSync(path.join(root, LOCAL)), false);
});

test('hooks in the tracked file that name a path are moved into the local one (#85)', () => {
  const root = scratch();
  writeSettings(root, SHARED, { model: 'opus', ...withHkbHooks('node "/home/someone/.npm/_npx/9f/node_modules/hkb-cli/bin/hkb.js"') });

  const r = installClaudeHooks(root, () => {});

  assert.equal(r.file, LOCAL);
  assert.equal(r.movedFrom, SHARED);
  assert.deepEqual(r.added, ['Stop', 'PreToolUse']);
  const shared = readSettings(root, SHARED);
  assert.equal(shared.model, 'opus', 'the rest of the tracked file is untouched');
  assert.equal(shared.hooks, undefined, 'and the path that was only ever right on one machine is gone');
  assert.ok(!JSON.stringify(readSettings(root, LOCAL)).includes('_npx'), 'the npx cache is never named again');
});

test('an npx-cache path in the local file is repaired in place', () => {
  const root = scratch();
  writeSettings(root, LOCAL, withHkbHooks('node "/home/someone/.npm/_npx/9f/node_modules/hkb-cli/bin/hkb.js"'));

  const r = installClaudeHooks(root, () => {});

  assert.equal(r.file, LOCAL);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.repaired, ['Stop', 'PreToolUse'], 'a cache path stopped being a path when the cache went');
  assert.ok(!JSON.stringify(readSettings(root, LOCAL)).includes('_npx'));
});

test('a hand-written local command survives a re-run', () => {
  const root = scratch();
  writeSettings(root, LOCAL, withHkbHooks('/opt/tools/hkb'));

  const r = installClaudeHooks(root, () => {});

  assert.deepEqual([r.added, r.repaired], [[], []], 'the local file is the operator\'s machine, and their command runs on it');
  assert.equal(commandsOf(readSettings(root, LOCAL).hooks.Stop)[0], '/opt/tools/hkb hook stop');
});

test('installClaudeHooks leaves the rest of the settings file alone', () => {
  const root = scratch();
  writeSettings(root, LOCAL, {
    model: 'opus',
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'make lint' }] }] },
  });

  assert.deepEqual(installClaudeHooks(root, () => {}).added, ['Stop', 'PreToolUse']);

  const s = readSettings(root);
  assert.equal(s.model, 'opus', 'settings that are not ours must survive');
  assert.deepEqual(commandsOf(s.hooks.Stop).filter((c) => c === 'make lint'), ['make lint'], 'so must the operator\'s own hook');
  assert.equal(commandsOf(s.hooks.Stop).length, 2);
});

test("a group carrying the operator's hook beside ours keeps theirs when ours moves out", () => {
  const root = scratch();
  writeSettings(root, SHARED, {
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'make lint' }, { type: 'command', command: 'node "/tmp/hkb/bin/hkb.js" hook stop' }] }] },
  });

  installClaudeHooks(root, () => {});

  assert.deepEqual(commandsOf(readSettings(root, SHARED).hooks.Stop), ['make lint'], 'we only ever remove our own');
});

test('installClaudeHooks reports a settings file it cannot parse rather than overwriting it', () => {
  const root = scratch();
  writeSettings(root, LOCAL, '{ not json');
  const said = [];

  assert.equal(installClaudeHooks(root, (s) => said.push(s)), null);

  assert.equal(fs.readFileSync(path.join(root, LOCAL), 'utf8'), '{ not json', 'the file is the operator\'s, not ours to rewrite');
  assert.match(said.join('\n'), /not valid JSON/);
});

test('an unparseable *other* file is called out, because it may hold a second copy of the hooks', () => {
  const root = scratch();
  writeSettings(root, SHARED, '{ not json');
  const said = [];

  const r = installClaudeHooks(root, (s) => said.push(s), {});

  assert.equal(r.file, LOCAL, 'the file we can read still gets the hooks');
  assert.match(said.join('\n'), /settings\.json is not valid JSON.*fires twice/s);
});

test('init names both hooks it wrote, where they went, and what the second one is for', () => {
  const fresh = hookSummary(['Stop', 'PreToolUse']);
  assert.match(fresh, /^added Stop and PreToolUse hooks to \.claude\/settings\.local\.json/);
  assert.match(hookSummary([]), /^Stop and PreToolUse hooks already present in \.claude\/settings\.local\.json/);
  assert.match(hookSummary(['PreToolUse']), /^added PreToolUse hook to \.claude\/settings\.local\.json; Stop hook already there/);
  assert.match(hookSummary(['Stop', 'PreToolUse'], { file: SHARED }), /to \.claude\/settings\.json/);
  assert.match(hookSummary([], { movedFrom: SHARED }), /moved out of \.claude\/settings\.json, which is shared/);
  assert.match(hookSummary([], { repaired: ['Stop'] }), /rewrote the Stop hook command/);
  for (const line of [fresh, hookSummary([]), hookSummary(['PreToolUse'])]) {
    for (const event of Object.keys(CLAUDE_HOOKS)) assert.ok(line.includes(event), `${event} goes unnamed in: ${line}`);
    assert.match(line, /inert outside a worker session/, 'an operator reading this has to know both are no-ops in their own sessions');
    // the two gates differ, and a note that says otherwise is how #143 found the docs stale
    assert.match(line, /PreToolUse denies \(never allows\) and takes KB_TASK only/, 'and what the second one is');
    assert.match(line, /stands aside on claude --bg/, 'the profile it is NOT live on is the default one');
  }
});

// ---------- the command itself: what may be written, and where ----------

test('hkbCommandForHook never names an npx cache, whatever the local PATH says (#85)', () => {
  const npxRoot = path.join(os.homedir(), '.npm', '_npx', '9f3c', 'node_modules', 'hkb-cli');
  assert.equal(hkbCommandForHook('stop', { onPath: false, pkgRoot: npxRoot }), `${NPX_COMMAND} hook stop`);
  assert.equal(hkbCommandForHook('pretool', { onPath: true, pkgRoot: npxRoot }), 'hkb hook pretool');
  assert.equal(hkbCommandForHook('stop', { shared: true, onPath: false, pkgRoot: npxRoot }), 'hkb hook stop');
  assert.ok(!hkbCommandForHook('stop', { onPath: false, pkgRoot: npxRoot }).includes('_npx'));
});

test('a durable install is still named absolutely, and a tracked file never is', () => {
  const durable = path.join(path.sep, 'usr', 'lib', 'node_modules', 'hkb-cli');
  assert.equal(hkbCommandForHook('stop', { onPath: false, pkgRoot: durable }), `node "${path.join(durable, 'bin', 'hkb.js')}" hook stop`);
  assert.equal(hkbCommandForHook('stop', { shared: true, onPath: false, pkgRoot: durable }), 'hkb hook stop', 'a shared file gets the portable form or nothing');
});

// ---------- the third install shape: `npm i -D hkb-cli` (#146) ----------
// The one command that is exact *and* the same on every machine, so it is the one that may go in the
// tracked file with nobody asking for it.

const LOCAL_REL = `node_modules/${packageInfo().name}/${packageInfo().bin}`;

test('a package installed under the repo is detected by path, never by PATH', () => {
  assert.ok(isLocalInstall('/repo/node_modules/hkb-cli', '/repo'));
  assert.ok(isLocalInstall('/repo/node_modules/.pnpm/hkb-cli@0.1.4/node_modules/hkb-cli', '/repo/'), 'pnpm resolves through its store, and that is still inside the repo');
  assert.ok(isLocalInstall('C:\\repo\\node_modules\\hkb-cli', 'C:\\repo'), 'both separators');
  assert.ok(!isLocalInstall('/usr/lib/node_modules/hkb-cli', '/repo'), 'a global install is not this repo\'s');
  assert.ok(!isLocalInstall('/home/x/.npm/_npx/9f/node_modules/hkb-cli', '/repo'));
  assert.ok(!isLocalInstall('/repo2/node_modules/hkb-cli', '/repo'), 'a prefix of the path is not the path');
  assert.ok(!isLocalInstall('/repo', '/repo'), 'the checkout itself is not an install of itself');
  assert.ok(!isLocalInstall('/repo/node_modules/hkb-cli', ''));
});

test('`hkb` found only in node_modules/.bin is not on PATH for a hook', () => {
  const PATH = ['/repo/node_modules/.bin', '/usr/bin', '/repo/node_modules/.bin/', '/home/x/_npxtools/bin'].join(':');
  assert.equal(stripNodeModulesBin(PATH), '/usr/bin:/home/x/_npxtools/bin', 'npx and npm run put one there; a hook\'s /bin/sh never does');
  assert.equal(stripNodeModulesBin('C:\\repo\\node_modules\\.bin;C:\\bin', ';'), 'C:\\bin');
  assert.equal(stripNodeModulesBin(''), '');
  assert.equal(stripNodeModulesBin('/usr/bin:/usr/local/bin'), '/usr/bin:/usr/local/bin', 'everything else survives untouched');
});

test('localInstallRel names the package, never a literal, and only inside the repo', () => {
  assert.equal(localInstallRel('/repo', { pkgRoot: '/repo/node_modules/hkb-cli' }), LOCAL_REL);
  assert.equal(localInstallRel('/repo', { pkgRoot: '/elsewhere/node_modules/hkb-cli' }), null);
  assert.equal(localInstallRel(null, { pkgRoot: '/repo/node_modules/hkb-cli' }), null, 'no repo, no $CLAUDE_PROJECT_DIR to be relative to');
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.equal(LOCAL_REL, `node_modules/${pkg.name}/${pkg.bin.hkb}`, 'rename the package or move the bin and this follows');
});

test('a local install gets the guarded $CLAUDE_PROJECT_DIR form, in either settings file', () => {
  const opts = { root: '/repo', pkgRoot: '/repo/node_modules/hkb-cli' };
  const stop = hkbCommandForHook('stop', opts);
  assert.equal(stop, `f="${PROJECT_DIR}/${LOCAL_REL}"; [ -f "$f" ] || exit 0; exec node "$f" hook stop`);
  assert.equal(hkbCommandForHook('pretool', opts), guardedHookCommand(LOCAL_REL, 'pretool'));
  assert.equal(hkbCommandForHook('stop', { ...opts, shared: true }), stop, 'the tracked file gets it too — that is the point');
  assert.equal(hkbCommandForHook('stop', { ...opts, onPath: true }), stop, 'the version the repo pinned wins over whatever is on PATH');
  assert.ok(!stop.includes('/repo'), 'it must not name the machine it was written on');
  assert.ok(isHkbHookCommand(stop, 'stop') && !isHkbHookCommand(stop, 'pretool'));
  assert.ok(isPortableHookCommand(stop), 'it means the same thing in every checkout');
});

test('the guarded command runs the local install, and is silent before there is one', () => {
  const root = scratch();
  const bin = path.join(root, ...LOCAL_REL.split('/'));
  const command = guardedHookCommand(LOCAL_REL, 'stop');
  const sh = () => spawnSync('sh', ['-c', command], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root } });

  const before = sh();
  assert.equal(before.status, 0, 'a worktree that has not run `npm ci` yet must not fail every tool call');
  assert.equal(`${before.stdout}${before.stderr}`, '', 'and must say nothing at all');

  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, 'process.stdout.write(`ran ${process.argv.slice(2).join(" ")}`);\n');
  const after = sh();
  assert.equal(after.status, 0, after.stderr);
  assert.equal(after.stdout, 'ran hook stop', 'and the verb reaches the hkb the repo installed');
});

test('hookCommandNeeds reads the guarded form: the file it names, and that it checks for it', () => {
  const need = hookCommandNeeds(guardedHookCommand(LOCAL_REL, 'stop'));
  assert.deepEqual(need, { kind: 'file', target: `${PROJECT_DIR}/${LOCAL_REL}`, guarded: true }, 'the assignment is expanded, so doctor gets a path and not `$f`');
  assert.equal(resolveHookPath(need.target, '/home/someone/repo'), `/home/someone/repo/${LOCAL_REL}`);
  assert.equal(resolveHookPath(need.target, '/a$&b'), `/a$&b/${LOCAL_REL}`, 'a root is a string, never a replacement pattern');
  assert.equal(resolveHookPath('hkb', '/repo'), 'hkb', 'nothing to resolve in a plain binary');
  assert.equal(hookCommandNeeds(`f="${PROJECT_DIR}/${LOCAL_REL}"; [ -f "$f" ] || exit 0; exec node "\${f}" hook stop`).target, `${PROJECT_DIR}/${LOCAL_REL}`, '${f} is the same variable');
});

test('hookPlacement puts a portable command in the tracked file without being asked', () => {
  const guarded = withHkbHooks(`f="${PROJECT_DIR}/${LOCAL_REL}"; [ -f "$f" ] || exit 0; exec node "$f"`);
  assert.deepEqual(hookPlacement({ portable: true }), { file: 'shared', movedFrom: null }, 'no --shared-hooks needed: it resolves for everyone that file serves');
  assert.deepEqual(hookPlacement({ local: withHkbHooks('hkb'), portable: true }), { file: 'shared', movedFrom: 'local' }, 'and the per-developer copy is stale by construction');
  assert.deepEqual(hookPlacement({ shared: guarded, portable: true }), { file: 'shared', movedFrom: null });
  assert.deepEqual(hookPlacement({ shared: guarded }), { file: 'shared', movedFrom: null }, 'read back on a machine with no local install, it is still portable and still stays put');
});

test('installClaudeHooks writes the local-install command into the tracked file', () => {
  const root = scratch();
  const r = installClaudeHooks(root, () => {}, { localRel: LOCAL_REL });

  assert.equal(r.file, SHARED, 'a command that resolves in every checkout belongs where everyone reads it');
  assert.equal(r.local, LOCAL_REL);
  assert.deepEqual(r.added, ['Stop', 'PreToolUse']);
  assert.equal(fs.existsSync(path.join(root, LOCAL)), false, 'nothing is left in the per-developer file');
  for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
    assert.equal(commandsOf(readSettings(root, SHARED).hooks[event])[0], guardedHookCommand(LOCAL_REL, verb));
  }
  assert.deepEqual(installClaudeHooks(root, () => {}, { localRel: LOCAL_REL }).added, [], 'idempotent');
});

test('a bare `hkb` in the tracked file is rewritten once the repo installs its own', () => {
  const root = scratch();
  writeSettings(root, SHARED, withHkbHooks('hkb'));

  const r = installClaudeHooks(root, () => {}, { localRel: LOCAL_REL });

  assert.deepEqual([r.added, r.repaired], [[], ['Stop', 'PreToolUse']], '`hkb` on PATH is a fact about a machine; the pinned copy is a fact about the repo');
  assert.equal(commandsOf(readSettings(root, SHARED).hooks.Stop)[0], guardedHookCommand(LOCAL_REL, 'stop'));
});

test('a teammate running their own global hkb leaves the committed command alone', () => {
  const root = scratch();
  const committed = guardedHookCommand(LOCAL_REL, 'stop');
  writeSettings(root, SHARED, withHkbHooks(`f="${PROJECT_DIR}/${LOCAL_REL}"; [ -f "$f" ] || exit 0; exec node "$f"`));

  const r = installClaudeHooks(root, () => {}, { localRel: null }); // their hkb is on PATH, not in this repo

  assert.deepEqual([r.file, r.added, r.repaired], [SHARED, [], []], 'the tracked command is portable, and they did not write it');
  assert.equal(commandsOf(readSettings(root, SHARED).hooks.Stop)[0], committed);
  assert.equal(fs.existsSync(path.join(root, LOCAL)), false, 'and no second copy to fire every nudge twice');
});

test('hooks an earlier init left in the per-developer file move to the tracked one', () => {
  const root = scratch();
  writeSettings(root, LOCAL, { model: 'opus', ...withHkbHooks('node "/home/someone/checkout/hkb-cli/bin/hkb.js"') });

  const r = installClaudeHooks(root, (s) => s, { localRel: LOCAL_REL });

  assert.equal(r.movedFrom, LOCAL);
  assert.deepEqual(r.added, ['Stop', 'PreToolUse']);
  assert.equal(readSettings(root, LOCAL).model, 'opus', 'the rest of that file is untouched');
  assert.equal(readSettings(root, LOCAL).hooks, undefined);
  assert.match(hookSummary(r.added, r), /moved out of \.claude\/settings\.local\.json, because this command resolves in every checkout/);
});

test('isEphemeralPath catches an npx cache on either separator', () => {
  assert.ok(isEphemeralPath('/home/x/.npm/_npx/9f/node_modules/hkb-cli'));
  assert.ok(isEphemeralPath('C:\\Users\\x\\AppData\\Local\\npm-cache\\_npx\\9f\\node_modules\\hkb-cli'));
  assert.ok(!isEphemeralPath('/usr/lib/node_modules/hkb-cli'));
  assert.ok(!isEphemeralPath('/home/x/_npxtools/hkb'));
});

test('hookCommandNeeds says what has to exist before a hook can run', () => {
  assert.deepEqual(hookCommandNeeds('hkb hook stop'), { kind: 'bin', target: 'hkb', guarded: false });
  assert.deepEqual(hookCommandNeeds(`${NPX_COMMAND} hook stop`), { kind: 'bin', target: 'npx', guarded: false });
  assert.deepEqual(hookCommandNeeds('node "/opt/hkb cli/bin/hkb.js" hook stop'), { kind: 'file', target: '/opt/hkb cli/bin/hkb.js', guarded: false });
  assert.deepEqual(hookCommandNeeds('/usr/bin/node /opt/hkb/bin/hkb.js hook stop'), { kind: 'file', target: '/opt/hkb/bin/hkb.js', guarded: false });
});

test('every form hkb has ever written is recognised as ours, and nobody else\'s is', () => {
  for (const c of ['hkb hook stop', 'node "/opt/hkb-cli/bin/hkb.js" hook stop', `${NPX_COMMAND} hook stop`, 'node "C:\\p\\hkb-cli\\bin\\hkb.js" hook stop']) {
    assert.ok(isHkbHookCommand(c, 'stop'), c);
    assert.ok(!isHkbHookCommand(c, 'pretool'), `${c} is the stop hook, not the pretool one`);
  }
  assert.ok(!isHkbHookCommand('make lint', 'stop'));
  assert.ok(!isHkbHookCommand('hkb heartbeat 12', 'stop'), 'only the hook verbs are ours to move');
  assert.ok(isPortableHookCommand('hkb hook stop'));
  assert.ok(!isPortableHookCommand('node "/opt/hkb-cli/bin/hkb.js" hook stop'));
  assert.ok(!isPortableHookCommand('/opt/hkb-cli/bin/hkb hook stop'));
});

test('hookPlacement: fresh goes local, portable-shared stays, a path in the tracked file moves', () => {
  const withPath = withHkbHooks('node "/opt/hkb-cli/bin/hkb.js"');
  const portable = withHkbHooks('hkb');
  assert.deepEqual(hookPlacement({}), { file: 'local', movedFrom: null });
  assert.deepEqual(hookPlacement({ shared: portable }), { file: 'shared', movedFrom: null });
  assert.deepEqual(hookPlacement({ shared: withPath }), { file: 'local', movedFrom: 'shared' });
  assert.deepEqual(hookPlacement({ local: withPath, shared: portable }), { file: 'local', movedFrom: 'shared' }, 'never both');
  assert.deepEqual(hookPlacement({ wantShared: true }), { file: 'shared', movedFrom: null });
  assert.deepEqual(hookPlacement({ local: withPath, wantShared: true }), { file: 'shared', movedFrom: 'local' });
});

// ---------- doctor: a hook that cannot resolve here ----------

const findings = () => {
  const results = [];
  return { results, sink: { ok: (name, detail) => results.push({ name, ok: true, detail }), warn: (name, detail, fix) => results.push({ name, ok: null, detail, fix }), bad: (name, detail, fix) => results.push({ name, ok: false, detail, fix }) } };
};
const finding = (results, name) => results.find((r) => r.name === name);

test('doctor fails when the configured hook command cannot be resolved here (#85)', () => {
  const root = scratch();
  writeSettings(root, SHARED, withHkbHooks('hkb'));
  const { results, sink } = findings();

  checkHooks({ root }, sink, { onPath: () => false, exists: () => false });

  assert.equal(finding(results, 'stop hook').detail, SHARED, 'it says which file it read');
  const cmd = finding(results, 'hook command');
  assert.equal(cmd.ok, false, 'a hook that fails on every tool call in the repo is a failure, not a warning');
  assert.match(cmd.detail, /`hkb` is not on PATH here/);
  assert.match(cmd.fix, /npm i -g hkb-cli/);
  assert.equal(results.filter((r) => r.name === 'hook command').length, 1, 'both hooks need the same binary: say it once');
});

test('doctor passes when it resolves, and names the npx cache as its own failure', () => {
  const root = scratch();
  writeSettings(root, LOCAL, withHkbHooks('hkb'));
  const good = findings();
  checkHooks({ root }, good.sink, { onPath: (bin) => bin === 'hkb', exists: () => false });
  assert.equal(finding(good.results, 'hook command').ok, true);
  assert.equal(finding(good.results, 'stop hook').detail, LOCAL);

  writeSettings(root, LOCAL, withHkbHooks('node "/home/x/.npm/_npx/9f/node_modules/hkb-cli/bin/hkb.js"'));
  const stale = findings();
  checkHooks({ root }, stale.sink, { onPath: () => true, exists: () => true });
  const cmd = finding(stale.results, 'hook command');
  assert.equal(cmd.ok, false, 'a path that exists today and not tomorrow is still broken');
  assert.match(cmd.detail, /npx cache is not a durable path/);
});

test('doctor names both copies when the hooks are configured twice, and the absence of any', () => {
  const root = scratch();
  writeSettings(root, LOCAL, withHkbHooks('hkb'));
  writeSettings(root, SHARED, withHkbHooks('hkb'));
  const both = findings();
  checkHooks({ root }, both.sink, { onPath: () => true, exists: () => true });
  assert.match(finding(both.results, 'stop hook').detail, /configured in both .* — every nudge fires twice/);

  const none = findings();
  checkHooks({ root: scratch() }, none.sink, { onPath: () => true, exists: () => true });
  const missing = finding(none.results, 'stop hook');
  assert.equal(missing.ok, null);
  assert.match(missing.detail, /not configured in .*settings\.local\.json or .*settings\.json/);
  assert.equal(finding(none.results, 'hook command'), undefined, 'nothing to resolve when nothing is configured');
});

test('doctor resolves $CLAUDE_PROJECT_DIR before looking, and says what it found (#146)', () => {
  const root = scratch();
  writeSettings(root, SHARED, withHkbHooks(`f="${PROJECT_DIR}/${LOCAL_REL}"; [ -f "$f" ] || exit 0; exec node "$f"`));
  const seen = [];
  const { results, sink } = findings();

  checkHooks({ root }, sink, { onPath: () => false, exists: (p) => (seen.push(p), true), localRel: LOCAL_REL });

  assert.deepEqual(seen, [path.join(root, ...LOCAL_REL.split('/'))], 'the variable is this repo, and doctor is standing in it');
  const cmd = finding(results, 'hook command');
  assert.equal(cmd.ok, true);
  assert.equal(cmd.detail, `${PROJECT_DIR}/${LOCAL_REL} → ${path.join(root, ...LOCAL_REL.split('/'))}`, 'a pass names the file it resolved, not two lines of shell');
});

test('doctor calls a not-yet-installed guarded hook what it is: waiting, not broken', () => {
  const root = scratch();
  writeSettings(root, SHARED, withHkbHooks(`f="${PROJECT_DIR}/${LOCAL_REL}"; [ -f "$f" ] || exit 0; exec node "$f"`));
  const { results, sink } = findings();

  checkHooks({ root }, sink, { onPath: () => false, exists: () => false, localRel: null });

  const cmd = finding(results, 'hook command');
  assert.equal(cmd.ok, null, 'a command that exits 0 in silence fails nothing — a worktree before `npm ci` is the normal case');
  assert.match(cmd.detail, /is not installed here — the hook exits 0 in silence until it is/);
  assert.match(cmd.fix, /npm install/);
});

test('doctor fails a stale bare `hkb` on a repo that installs its own', () => {
  const root = scratch();
  writeSettings(root, SHARED, withHkbHooks('hkb'));
  const { results, sink } = findings();

  checkHooks({ root }, sink, { onPath: () => true, exists: () => true, localRel: LOCAL_REL });

  const cmd = finding(results, 'hook command');
  assert.equal(cmd.ok, false, 'it resolves on this machine and on nobody else\'s — and this file is read by everybody');
  assert.match(cmd.detail, new RegExp(`this repo installs hkb itself \\(${LOCAL_REL.replace(/[/.]/g, '\\$&')}\\)`));
  assert.match(cmd.detail, /\.claude[/\\]settings\.json/, 'it names the file the stale command is in');
  assert.match(cmd.fix, /^hkb init/);
  assert.ok(cmd.fix.includes(`${PROJECT_DIR}/${LOCAL_REL}`), 'and what init will write instead');
});

test('findClaudeHooks reads both files and reports the one it cannot parse', () => {
  const root = scratch();
  writeSettings(root, LOCAL, '{ not json');
  writeSettings(root, SHARED, withHkbHooks('hkb'));

  const { hooks, unreadable } = findClaudeHooks(root);

  assert.deepEqual(unreadable.map((u) => u.file), [LOCAL]);
  assert.deepEqual(hooks.map((h) => `${h.file} ${h.event}`), [`${SHARED} Stop`, `${SHARED} PreToolUse`]);
});

test('`hkb help` lists every hook verb the CLI routes', () => {
  const help = spawnSync(process.execPath, [path.join(REPO, 'bin', 'hkb.js'), 'help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /hook stop\|pretool/);
});
