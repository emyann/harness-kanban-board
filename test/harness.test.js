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
  harnessFiles, installHarness, harnessHookCommand, installClaudeHooks, hookSummary, CLAUDE_HOOKS, resolveProfiles, boardProfiles,
  HARNESSES, HARNESS_PROFILE, packageSkillDir, HOOK_SETTINGS, NPX_COMMAND, hkbCommandForHook, workerHookSettings,
  hookCommandNeeds, isHkbHookCommand, isPortableHookCommand, isEphemeralPath, findClaudeHooks, actionsFiles,
  projectBinRel, guardedHookCommand, relativeHookCommand, resolveHookPath, hkbHooks, PROJECT_DIR,
} from '../src/init.js';
import { parseArgs } from '../src/cli.js';
import { DEFAULT_BOARD, DEFAULT_PROFILES, CLAUDE_DENY, HOOK_SETTINGS_VAR, ensureWorktree } from '../src/board.js';
import { expandLaunch, spawnWorker, tick } from '../src/dispatch.js';
import { checkHarnesses, checkHooks, checkMcp, staleHookLaunches, STALE_HOOK_CHECK, LAUNCH_HOOK_CHECK } from '../src/doctor.js';
import { stripFrontmatter, worktreePath, insideRepo, stripNodeModulesBin, hookSettings, hookEntry } from '../src/model.js';
import { mcpLaunch, installMcp, MCP_FILE, MCP_KEY } from '../src/mcp.js';
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

// The runner's workflow is a TRACKED, generated file, so — unlike a local launch — it may not carry
// a command that only resolves on the machine that ran `hkb init --with-actions`. The runner puts
// `hkb` on PATH itself, so the portable form is both correct there and identical in every diff.
test('the generated Actions worker carries the hooks, in a form no machine owns', () => {
  const yml = actionsFiles().find((f) => /worker-claude/.test(f.rel)).contents;
  const m = /--settings '([^']*)'/.exec(yml);
  assert.ok(m, '--settings went missing from the worker workflow');
  assert.ok(!m[1].includes("'"), 'the JSON is wrapped in single quotes for the runner shell, so it may not contain one');
  const hooks = JSON.parse(m[1]).hooks;
  for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
    assert.deepEqual(hooks[event], [hookEntry(`hkb hook ${verb}`)], `${event}: a runner installs hkb on PATH; a path here would name somebody's laptop`);
  }
  assert.equal(yml.split("--settings '").length - 1, 1, 'exactly one, on the claude step');
  // KB_TASK is what makes them live at all, and unlike `claude --bg` a runner really has it
  assert.match(yml, /KB_TASK: \$\{\{ inputs\.task \}\}/);
  assert.match(yml, /KB_PROFILE: claude-action/);
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

// The pin `effort` replaces (#182): a board that just wants `--effort medium` on the claude launch no
// longer needs a frozen copy of it, because the field renders through the same `{model_args}` token
// `--model` already used.
test('a claude profile with no pinned launch renders --effort through {model_args}', () => {
  const profile = { ...DEFAULT_PROFILES.claude, effort: 'medium' };
  const argv = expandLaunch(profile.launch, { n: 1, k: 1, title: 't', prompt: 'do the thing', effort: profile.effort }, profile);
  assert.deepEqual(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2), ['--effort', 'medium']);
});

test('{model_args} renders --model then --effort, either or both dropped when unset', () => {
  assert.deepEqual(expandLaunch(['{model_args}'], {}, {}), []);
  assert.deepEqual(expandLaunch(['{model_args}'], { model: 'opus' }, {}), ['--model', 'opus']);
  assert.deepEqual(expandLaunch(['{model_args}'], { effort: 'high' }, {}), ['--effort', 'high']);
  assert.deepEqual(expandLaunch(['{model_args}'], { model: 'opus', effort: 'high' }, {}), ['--model', 'opus', '--effort', 'high']);
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

// The wiring `expandLaunch`'s own `{model_args}` unit tests never exercise: `spawnWorker` is where a
// profile's `effort` field actually becomes the token on argv (dispatch.js `effort: profile.effort ||
// ''`), and nothing here pinned it — dropping that one field passed 815/815 (#188).
test('spawnWorker renders a profile\'s effort onto argv through {model_args}', async (t) => {
  const gh = new FakeGh();
  const root = fs.realpathSync(scratch());
  const profile = { ...DEFAULT_PROFILES.claude, effort: 'high' };
  const ctx = {
    root,
    cfg: { ...DEFAULT_BOARD, repo: gh.nameWithOwner, profiles: { claude: profile } },
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {}, requireBoard() { return this; },
  };
  const restore = gh.install();
  t.after(() => { restore(); fs.rmSync(root, { recursive: true, force: true }); });
  gh.addIssue(kbIssue({ number: 13, status: 'ready', agent: 'claude' }));
  const { fetchBoard } = await import('../src/tasks.js');
  const [task] = await fetchBoard(ctx);

  const { argv } = await spawnWorker(ctx, task, 'claude', 1, { dryRun: true });

  assert.deepEqual(argv.slice(argv.indexOf('--effort'), argv.indexOf('--effort') + 2), ['--effort', 'high']);
});

test('this repo ships the codex templates the generator reads', () => {
  for (const f of ['hooks.json', 'notes.md']) {
    assert.ok(fs.existsSync(path.join(REPO, 'templates', 'codex', f)), `templates/codex/${f}`);
  }
});

// ---------- claude, the default harness: the hooks init writes into a settings file ----------
// Unlike the generated harness files, a Claude settings file is read by every OTHER session in that
// repo, and hkb's hooks serve exactly one session: the worker it launched. So since #144 they ride
// the launch (`--settings`), init writes no settings file unless `--shared-hooks` asks for one, and
// what an older init left in the per-developer file is taken back out. What a settings file still
// gets, when it is asked for, is only ever a command that means the same thing on every machine
// (#85) — a plain `hkb`, or the repo's own through `$CLAUDE_PROJECT_DIR` (#146).

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

test('installClaudeHooks writes no settings file at all by default (#144)', () => {
  const root = scratch();
  const r = installClaudeHooks(root, () => {});
  assert.equal(r.file, null, 'the launch carries them; a settings file is read by every session in the repo');
  assert.deepEqual([r.added, r.cleared], [[], []]);
  for (const rel of [LOCAL, SHARED]) assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} must not even be created`);
});

test('an older init\'s hooks are removed from the per-developer file, and only ours', () => {
  const root = scratch();
  writeSettings(root, LOCAL, {
    model: 'opus',
    hooks: {
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'make lint' }, { type: 'command', command: 'hkb hook stop', timeout: 30 }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "/opt/hkb/bin/hkb.js" hook pretool', timeout: 30 }] }],
    },
  });

  const r = installClaudeHooks(root, () => {});

  assert.deepEqual([r.file, r.cleared], [null, ['Stop', 'PreToolUse']], 'both come out, whatever command they were running');
  const s = readSettings(root);
  assert.equal(s.model, 'opus', 'settings that are not ours must survive');
  assert.deepEqual(commandsOf(s.hooks.Stop), ['make lint'], "and so must the operator's own hook in the same group");
  assert.equal(s.hooks.PreToolUse, undefined, 'a group left holding nothing goes with it');
  assert.match(hookSummary(r), /removed the Stop and PreToolUse hooks hkb left in .*settings\.local\.json/);
  assert.deepEqual(installClaudeHooks(root, () => {}).cleared, [], 'idempotent: nothing left to take out');
});

test('the tracked file is never emptied out from under a team that chose it', () => {
  const root = scratch();
  writeSettings(root, SHARED, withHkbHooks('hkb'));

  const r = installClaudeHooks(root, () => {});

  assert.equal(r.file, null, 'a plain init still writes nothing');
  assert.deepEqual(commandsOf(readSettings(root, SHARED).hooks.Stop), ['hkb hook stop'], 'hooks a human committed are a choice hkb does not overrule');
});

test('--shared-hooks writes the tracked file, and only ever a plain `hkb`', () => {
  const root = scratch();
  const r = installClaudeHooks(root, () => {}, { shared: true });
  assert.equal(r.file, SHARED);
  assert.deepEqual(r.added, ['Stop', 'PreToolUse', 'SubagentStop']);
  assert.equal(fs.existsSync(path.join(root, LOCAL)), false);
  for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
    assert.equal(commandsOf(readSettings(root, SHARED).hooks[event])[0], `hkb hook ${verb}`, 'a tracked file cannot name this machine');
  }
});

test('--shared-hooks writes the tracked file and clears the per-developer one', () => {
  const root = scratch();
  writeSettings(root, LOCAL, withHkbHooks('node "/home/someone/checkout/hkb-cli/bin/hkb.js"'));

  const r = installClaudeHooks(root, () => {}, { shared: true });

  assert.equal(r.file, SHARED);
  assert.deepEqual([r.added, r.cleared], [['Stop', 'PreToolUse', 'SubagentStop'], ['Stop', 'PreToolUse', 'SubagentStop']]);
  assert.equal(readSettings(root, LOCAL).hooks, undefined, 'one file, or every nudge fires twice');
  assert.deepEqual(Object.keys(readSettings(root, SHARED).hooks), ['Stop', 'PreToolUse', 'SubagentStop']);
});

test('a path in the tracked file is rewritten, never left for a teammate to trip over (#85)', () => {
  const root = scratch();
  writeSettings(root, SHARED, { model: 'opus', ...withHkbHooks('node "/home/someone/.npm/_npx/9f/node_modules/hkb-cli/bin/hkb.js"') });

  const r = installClaudeHooks(root, () => {}, { shared: true });

  assert.deepEqual([r.added, r.repaired], [[], ['Stop', 'PreToolUse', 'SubagentStop']]);
  const shared = readSettings(root, SHARED);
  assert.equal(shared.model, 'opus', 'the rest of the tracked file is untouched');
  assert.deepEqual(commandsOf(shared.hooks.Stop), ['hkb hook stop'], 'a tracked file gets the portable form or nothing');
  assert.ok(!JSON.stringify(shared).includes('_npx'), 'the npx cache is never named again');
});

test('a portable command already in the tracked file is left byte-identical', () => {
  const root = scratch();
  writeSettings(root, SHARED, withHkbHooks('hkb'));

  const r = installClaudeHooks(root, () => {}, { shared: true });

  assert.deepEqual([r.added, r.repaired], [[], []], 'it already means the same thing on every machine');
  assert.deepEqual(commandsOf(readSettings(root, SHARED).hooks.Stop), ['hkb hook stop']);
});

test('installClaudeHooks leaves the rest of the settings file alone', () => {
  const root = scratch();
  writeSettings(root, SHARED, {
    model: 'opus',
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'make lint' }] }] },
  });

  assert.deepEqual(installClaudeHooks(root, () => {}, { shared: true }).added, ['Stop', 'PreToolUse', 'SubagentStop']);

  const s = readSettings(root, SHARED);
  assert.equal(s.model, 'opus', 'settings that are not ours must survive');
  assert.deepEqual(commandsOf(s.hooks.Stop).filter((c) => c === 'make lint'), ['make lint'], 'so must the operator\'s own hook');
  assert.equal(commandsOf(s.hooks.Stop).length, 2);
});

test("a group carrying the operator's hook beside ours keeps theirs when ours is cleared out", () => {
  const root = scratch();
  writeSettings(root, LOCAL, {
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'make lint' }, { type: 'command', command: 'node "/tmp/hkb/bin/hkb.js" hook stop' }] }] },
  });

  installClaudeHooks(root, () => {});

  assert.deepEqual(commandsOf(readSettings(root, LOCAL).hooks.Stop), ['make lint'], 'we only ever remove our own');
});

test('installClaudeHooks reports a settings file it cannot parse rather than overwriting it', () => {
  const root = scratch();
  writeSettings(root, SHARED, '{ not json');
  const said = [];

  assert.equal(installClaudeHooks(root, (s) => said.push(s), { shared: true }), null);

  assert.equal(fs.readFileSync(path.join(root, SHARED), 'utf8'), '{ not json', 'the file is the operator\'s, not ours to rewrite');
  assert.match(said.join('\n'), /not valid JSON/);
});

test('an unparseable per-developer file is called out, because it may still hold the hooks', () => {
  const root = scratch();
  writeSettings(root, LOCAL, '{ not json');
  const said = [];

  const r = installClaudeHooks(root, (s) => said.push(s), {});

  assert.deepEqual([r.file, r.cleared], [null, []], 'nothing hkb can clean up, and nothing it will overwrite');
  assert.equal(fs.readFileSync(path.join(root, LOCAL), 'utf8'), '{ not json');
  assert.match(said.join('\n'), /settings\.local\.json is not valid JSON.*every session in this repo/s);
});

test('init says where the hooks run, what it wrote and what it took away', () => {
  const launch = hookSummary({});
  assert.match(launch, /^Stop and PreToolUse and SubagentStop hooks ride the worker launch \(`claude --settings`\) — no session but a worker's ever sees them/);
  assert.match(hookSummary({ cleared: ['Stop'] }), /removed the Stop hook hkb left in \.claude\/settings\.local\.json, which fired in every session in this repo/);
  const shared = hookSummary({ file: SHARED, added: ['Stop', 'PreToolUse'] });
  assert.match(shared, /^added Stop and PreToolUse hooks to \.claude\/settings\.json/);
  assert.match(hookSummary({ file: SHARED, added: ['PreToolUse'] }), /^added PreToolUse hook to \.claude\/settings\.json; Stop and SubagentStop hooks already there/);
  assert.match(hookSummary({ file: SHARED }), /^Stop and PreToolUse and SubagentStop hooks already present in \.claude\/settings\.json/);
  assert.match(hookSummary({ file: SHARED, repaired: ['Stop'] }), /rewrote the Stop hook command, which did not resolve for everyone that file serves/);
  // #146 review: on a repo that carries its own hkb, the plain `$CLAUDE_PROJECT_DIR` form already
  // resolved for everyone — what the rewrite adds is the guard, and saying otherwise was false.
  assert.match(hookSummary({ file: SHARED, repaired: ['Stop'], binRel: 'bin/hkb.js' }), /rewrote the Stop hook command to name this repo's own hkb, guarded/);
  for (const line of [launch, shared, hookSummary({ file: SHARED, added: ['PreToolUse'] })]) {
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
  // A durable PKG_ROOT wins over a bare `hkb` even when one is on PATH (#171 — the hook runs under
  // the session daemon's own PATH, not the dispatcher's, so PATH agreeing right now proves nothing).
  assert.equal(hkbCommandForHook('stop', { onPath: true, pkgRoot: durable }), `node "${path.join(durable, 'bin', 'hkb.js')}" hook stop`);
  assert.equal(hkbCommandForHook('stop', { shared: true, onPath: false, pkgRoot: durable }), 'hkb hook stop', 'a shared file gets the portable form or nothing');
  assert.equal(hkbCommandForHook('stop', { shared: true, onPath: true, pkgRoot: durable }), 'hkb hook stop', 'and neither does an onPath one');
});

// ---------- the third install shape: an hkb the repo itself carries (#146) ----------
// The one command that is exact *and* the same on every machine, so it is the one that may go in the
// tracked file with nobody asking for it. Two installs land there — a `npm i -D hkb-cli`
// devDependency and hkb's own checkout — and the command is built the same way for both: the
// remainder is *measured* from the repo root, never composed out of the package's name.

const BIN = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).bin.hkb;
const DEP_REL = `node_modules/hkb-cli/${BIN}`;

test('an hkb under the repo is found by path, and the remainder is measured', () => {
  assert.equal(insideRepo('/repo', '/repo/node_modules/hkb-cli'), 'node_modules/hkb-cli');
  assert.equal(insideRepo('/repo/', '/repo/node_modules/.pnpm/hkb-cli@0.1.4/node_modules/hkb-cli'), 'node_modules/.pnpm/hkb-cli@0.1.4/node_modules/hkb-cli', 'pnpm resolves through its store; composing `node_modules/<name>` would name a file that is not there');
  assert.equal(insideRepo('C:\\repo', 'C:\\repo\\node_modules\\hkb-cli'), 'node_modules/hkb-cli', 'both separators in, POSIX out — it is going into a /bin/sh command line');
  assert.equal(insideRepo('/repo', '/repo'), '', 'hkb\'s own checkout: the repo IS the package, and that is the case #146 was filed from');
  assert.equal(insideRepo('/repo', '/usr/lib/node_modules/hkb-cli'), null, 'a global install is nobody\'s project');
  assert.equal(insideRepo('/repo', '/repo2/node_modules/hkb-cli'), null, 'a prefix of the path is not the path');
  assert.equal(insideRepo('', '/repo/node_modules/hkb-cli'), null);
});

test('`hkb` found only in node_modules/.bin is not on PATH for a hook', () => {
  const PATH = ['/repo/node_modules/.bin', '/usr/bin', '/repo/node_modules/.bin/', '/home/x/_npxtools/bin'].join(':');
  assert.equal(stripNodeModulesBin(PATH), '/usr/bin:/home/x/_npxtools/bin', 'npx and npm run put one there; a hook\'s /bin/sh never does');
  assert.equal(stripNodeModulesBin('C:\\repo\\node_modules\\.bin;C:\\bin', ';'), 'C:\\bin');
  assert.equal(stripNodeModulesBin(''), '');
  assert.equal(stripNodeModulesBin('/usr/bin:/usr/local/bin'), '/usr/bin:/usr/local/bin', 'everything else survives untouched');
});

test('projectBinRel measures the path to the running hkb, and refuses two of them', () => {
  assert.equal(projectBinRel('/repo', { pkgRoot: '/repo/node_modules/hkb-cli' }), DEP_REL);
  assert.equal(projectBinRel('/repo', { pkgRoot: '/repo' }), BIN, 'a checkout of hkb carries its own bin at the root');
  assert.equal(projectBinRel('/repo', { pkgRoot: '/repo/node_modules/.pnpm/hkb-cli@0.1.4/node_modules/hkb-cli' }), `node_modules/.pnpm/hkb-cli@0.1.4/node_modules/hkb-cli/${BIN}`);
  assert.equal(projectBinRel('/repo', { pkgRoot: '/elsewhere/node_modules/hkb-cli' }), null);
  assert.equal(projectBinRel(null, { pkgRoot: '/repo/node_modules/hkb-cli' }), null, 'no repo, no $CLAUDE_PROJECT_DIR to be relative to');
  assert.equal(projectBinRel('/repo', { pkgRoot: '/repo/.npm/_npx/9f/node_modules/hkb-cli' }), null, 'an npx cache is not durable wherever it sits');
  assert.equal(projectBinRel('/repo', { pkgRoot: `/repo/${worktreePath('kb-1-1')}` }), null, 'a worker checkout is gitignored and gone with the attempt — never a path for the tracked file');
  assert.equal(BIN, 'bin/hkb.js', 'move the bin in package.json and every command above follows');
});

test('an hkb inside the repo gets the guarded $CLAUDE_PROJECT_DIR form, in either settings file', () => {
  const opts = { root: '/repo', pkgRoot: '/repo/node_modules/hkb-cli' };
  const stop = hkbCommandForHook('stop', opts);
  assert.equal(stop, `f="${PROJECT_DIR}/${DEP_REL}"; [ -f "$f" ] || exit 0; exec node "$f" hook stop`);
  assert.equal(hkbCommandForHook('pretool', opts), guardedHookCommand(DEP_REL, 'pretool'));
  assert.equal(hkbCommandForHook('stop', { ...opts, shared: true }), stop, 'the tracked file gets it too — that is the point');
  assert.equal(hkbCommandForHook('stop', { ...opts, onPath: true }), stop, 'the version the repo pinned wins over whatever is on PATH');
  assert.ok(!stop.includes('/repo'), 'it must not name the machine it was written on');
  assert.ok(isHkbHookCommand(stop, 'stop') && !isHkbHookCommand(stop, 'pretool'));
  assert.ok(isPortableHookCommand(stop), 'it means the same thing in every checkout');
  assert.equal(hkbCommandForHook('stop', { root: '/repo', pkgRoot: '/repo' }), guardedHookCommand(BIN, 'stop'), 'and a checkout of hkb names its own bin the same way');
});

test('the guarded command runs the repo\'s own hkb, and is silent before there is one', () => {
  const root = scratch();
  const bin = path.join(root, ...DEP_REL.split('/'));
  const command = guardedHookCommand(DEP_REL, 'stop');
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
  const need = hookCommandNeeds(guardedHookCommand(DEP_REL, 'stop'));
  assert.deepEqual(need, { kind: 'file', target: `${PROJECT_DIR}/${DEP_REL}`, guarded: true }, 'the assignment is expanded, so doctor gets a path and not `$f`');
  assert.equal(resolveHookPath(need.target, '/home/someone/repo'), `/home/someone/repo/${DEP_REL}`);
  assert.equal(resolveHookPath(need.target, '/a$&b'), `/a$&b/${DEP_REL}`, 'a root is a string, never a replacement pattern');
  assert.equal(resolveHookPath('hkb', '/repo'), 'hkb', 'nothing to resolve in a plain binary');
  assert.equal(hookCommandNeeds(`f="${PROJECT_DIR}/${DEP_REL}"; [ -f "$f" ] || exit 0; exec node "\${f}" hook stop`).target, `${PROJECT_DIR}/${DEP_REL}`, '${f} is the same variable');
});

// hkb's own repo IS the self-checkout case — the repo is the package. Since #144 the invariant it
// has to hold is the *absence* of the file: hkb may not ship a hook that fires in every session of
// every contributor's checkout, least of all a bare `hkb` that resolves on nobody's machine in
// particular. The command shapes below are still exercised, through `--shared-hooks`.
test('hkb\'s own repo ships no hook in either settings file (#144)', () => {
  for (const rel of [LOCAL, SHARED]) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) continue;
    assert.deepEqual(hkbHooks(JSON.parse(fs.readFileSync(abs, 'utf8'))), [],
      `${rel} in hkb's own repo configures hkb's hooks — they would run in every session every contributor opens here`);
  }
});

test('--shared-hooks on a repo that carries its own hkb writes the guarded form (#146)', () => {
  const root = scratch();
  const r = installClaudeHooks(root, () => {}, { shared: true, binRel: BIN });

  assert.equal(r.file, SHARED);
  assert.equal(r.binRel, BIN);
  assert.deepEqual(r.added, ['Stop', 'PreToolUse', 'SubagentStop']);
  assert.equal(fs.existsSync(path.join(root, LOCAL)), false, 'nothing is left in the per-developer file');

  for (const h of hkbHooks(readSettings(root, SHARED))) {
    const need = hookCommandNeeds(h.command);
    assert.equal(h.command, guardedHookCommand(BIN, CLAUDE_HOOKS[h.event]), `${h.event}: the checkout names its own bin, never this machine`);
    assert.deepEqual([need.target, need.guarded], [`${PROJECT_DIR}/${BIN}`, true], `${h.event}: doctor reads a path out of it, and knows it checks for itself`);
    assert.ok(isPortableHookCommand(h.command) && h.portable, `${h.event}: which is what makes the tracked file the right place for it`);
    assert.ok(fs.existsSync(resolveHookPath(need.target, REPO)), `${h.event}: and in this checkout that resolves to a file that is really there`);
  }

  const before = fs.readFileSync(path.join(root, SHARED), 'utf8');
  const again = installClaudeHooks(root, () => {}, { shared: true, binRel: BIN });
  assert.deepEqual([again.added, again.repaired], [[], []], 'idempotent');
  assert.equal(fs.readFileSync(path.join(root, SHARED), 'utf8'), before, 'byte-identical — a re-run may not churn a tracked file');
});

test('--shared-hooks writes the repo\'s own hkb, guarded, for a devDependency too', () => {
  const root = scratch();
  const r = installClaudeHooks(root, () => {}, { shared: true, binRel: DEP_REL });

  assert.deepEqual([r.file, r.binRel, r.added], [SHARED, DEP_REL, ['Stop', 'PreToolUse', 'SubagentStop']]);
  for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
    assert.equal(commandsOf(readSettings(root, SHARED).hooks[event])[0], guardedHookCommand(DEP_REL, verb));
  }
});

test('a bare `hkb` in the tracked file is rewritten once the repo installs its own', () => {
  const root = scratch();
  writeSettings(root, SHARED, withHkbHooks('hkb'));

  const r = installClaudeHooks(root, () => {}, { shared: true, binRel: DEP_REL });

  assert.deepEqual([r.added, r.repaired], [[], ['Stop', 'PreToolUse', 'SubagentStop']], '`hkb` on PATH is a fact about a machine; the pinned copy is a fact about the repo');
  assert.equal(commandsOf(readSettings(root, SHARED).hooks.Stop)[0], guardedHookCommand(DEP_REL, 'stop'));
});

// #146 review, item 1: the plain `node "$CLAUDE_PROJECT_DIR/<bin>"` form is already portable and
// already resolves for everyone the tracked file serves. It is still rewritten — a worker's fresh
// worktree has no `node_modules` until `npm ci`, and only the guarded form is silent there — but
// what init SAYS about it has to be the guard, not a resolution failure that never happened.
test('a portable but unguarded command is rewritten for the guard, and reported as that', () => {
  const root = scratch();
  const plain = `node "${PROJECT_DIR}/${DEP_REL}"`;
  writeSettings(root, SHARED, withHkbHooks(plain));
  assert.ok(isPortableHookCommand(`${plain} hook stop`), 'the premise: it resolves in every checkout as it stands');

  const r = installClaudeHooks(root, () => {}, { shared: true, binRel: DEP_REL });

  assert.deepEqual([r.added, r.repaired], [[], ['Stop', 'PreToolUse', 'SubagentStop']]);
  assert.equal(commandsOf(readSettings(root, SHARED).hooks.Stop)[0], guardedHookCommand(DEP_REL, 'stop'));
  const said = hookSummary(r);
  assert.match(said, /rewrote the Stop and PreToolUse and SubagentStop hooks command to name this repo's own hkb, guarded/);
  assert.ok(!said.includes('did not resolve'), `it did resolve — doctor passes it one line earlier: ${said}`);
});

test('a teammate running their own global hkb leaves the committed command alone', () => {
  const root = scratch();
  const committed = guardedHookCommand(DEP_REL, 'stop');
  writeSettings(root, SHARED, withHkbHooks(`f="${PROJECT_DIR}/${DEP_REL}"; [ -f "$f" ] || exit 0; exec node "$f"`));

  const r = installClaudeHooks(root, () => {}, { shared: true, binRel: null }); // their hkb is on PATH, not in this repo

  assert.deepEqual([r.file, r.added, r.repaired], [SHARED, [], []], 'the tracked command is portable, and they did not write it');
  assert.equal(commandsOf(readSettings(root, SHARED).hooks.Stop)[0], committed);
  assert.equal(fs.existsSync(path.join(root, LOCAL)), false, 'and no second copy to fire every nudge twice');
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

// ---------- the launch line: what a worker's session actually gets ----------
// The value is built without launching anything, which is the point of keeping it pure: the JSON a
// worker will be handed is asserted here, and `expandLaunch` only has to spend it.

test('hookSettings is the same shape a settings file gets, as one JSON string', () => {
  const json = hookSettings(CLAUDE_HOOKS, (verb) => `hkb hook ${verb}`);
  const parsed = JSON.parse(json);
  assert.deepEqual(Object.keys(parsed), ['hooks'], 'nothing but hooks: --settings is merged over the session, not a replacement for it');
  assert.deepEqual(Object.keys(parsed.hooks), ['Stop', 'PreToolUse', 'SubagentStop']);
  for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
    assert.deepEqual(parsed.hooks[event], [hookEntry(`hkb hook ${verb}`)], `${event} must match what installClaudeHooks writes`);
    assert.equal(parsed.hooks[event][0].hooks[0].timeout, 30);
    assert.equal(parsed.hooks[event][0].matcher, '*');
  }
  assert.ok(json.startsWith('{'), 'Claude Code reads a value starting with { as inline JSON and anything else as a path');
  assert.equal(hookSettings({}, () => 'x'), '', 'nothing to declare means no flag at all, not an empty --settings');
  assert.equal(hookSettings(CLAUDE_HOOKS, () => ''), '', 'and neither does a command that could not be built');
});

test('workerHookSettings names the hkb that is running, never a project-relative one', () => {
  // This checkout's PKG_ROOT is durable, so it is named absolutely even with a bare `hkb` on PATH
  // (#171): the hook runs under the session daemon's own environment, which keeps its own PATH
  // (#150), so a bare command re-resolves there rather than against the PATH this process observed.
  const onPath = JSON.parse(workerHookSettings({ onPath: true }));
  assert.match(onPath.hooks.Stop[0].hooks[0].command, /^node ".*bin[/\\]hkb\.js" hook stop$/);

  // The launch never leaves this machine, so an absolute path is CORRECT here — exactly the case a
  // tracked settings file had to rule out (#85).
  const local = JSON.parse(workerHookSettings({ onPath: false }));
  assert.match(local.hooks.PreToolUse[0].hooks[0].command, /^node ".*bin[/\\]hkb\.js" hook pretool$/);
  assert.ok(!JSON.stringify(local).includes(PROJECT_DIR),
    'a worker\'s $CLAUDE_PROJECT_DIR is its fresh worktree, with no node_modules until `npm ci` — the guarded form would be silent for exactly the part of an attempt that most needs the hooks');
  assert.ok(fs.existsSync(/^node "([^"]+)"/.exec(local.hooks.Stop[0].hooks[0].command)[1]), 'and the hkb that ran the dispatcher is installed by definition');
});

test('every Claude launch carries the hooks, and nothing else does', () => {
  for (const name of ['claude', 'claude-track', 'claude-p']) {
    assert.ok(DEFAULT_PROFILES[name].launch.includes(HOOK_SETTINGS_VAR), `${name} must hand its worker hkb's hooks`);
  }
  for (const name of ['claude-action', 'copilot-cli', 'codex']) {
    assert.ok(!DEFAULT_PROFILES[name].launch.includes(HOOK_SETTINGS_VAR), `${name} does not spawn Claude Code here`);
  }
});

test('expandLaunch spends the placeholder as a flag pair, or drops it', () => {
  const p = DEFAULT_PROFILES['claude-p'];
  const json = hookSettings(CLAUDE_HOOKS, (verb) => `hkb hook ${verb}`);
  const argv = expandLaunch(p.launch, { prompt: 'x', hook_settings: json }, p);
  const at = argv.indexOf('--settings');
  assert.ok(at > 0, `--settings missing from: ${argv.join(' ')}`);
  assert.equal(argv[at + 1], json, 'one argument, unsplit — it is one JSON value');
  assert.ok(!argv.includes(HOOK_SETTINGS_VAR), 'the placeholder itself must never reach the command line');

  const none = expandLaunch(p.launch, { prompt: 'x' }, p);
  assert.ok(!none.includes('--settings'), 'a flag with no value is a parse error waiting to happen, not a default');
  assert.ok(!none.includes(HOOK_SETTINGS_VAR), 'and the placeholder still goes');
});

test('expandLaunch refuses {hook_settings} embedded in a larger token', () => {
  const p = DEFAULT_PROFILES['claude-p'];
  // `--settings={hook_settings}` would render a bare `--settings=` when there is nothing to run —
  // a flag Claude Code still has to parse, and silently wrong rather than caught at launch time.
  const template = ['claude', `--settings=${HOOK_SETTINGS_VAR}`];
  assert.throws(() => expandLaunch(template, { prompt: 'x' }, p), /embeds \{hook_settings\}/);
  try { expandLaunch(template, { prompt: 'x' }, p); } catch (e) { assert.equal(e.exitCode, 2); }
});

// The whole reason `board.json` holds a token and not the JSON: that file is TRACKED, and the
// command inside names whichever hkb *this* machine has.
test('the launch template a board commits never carries a machine-specific path', () => {
  for (const p of Object.values(DEFAULT_PROFILES)) {
    for (const el of p.launch) {
      assert.ok(!/hkb\.js|_npx|hooks/.test(el), `a committed launch element names this machine: ${el}`);
    }
  }
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

test('doctor warns about every settings file that still has hkb hooks in it (#144)', () => {
  const root = scratch();
  writeSettings(root, LOCAL, withHkbHooks('hkb'));
  writeSettings(root, SHARED, withHkbHooks('hkb'));
  const { results, sink } = findings();

  checkHooks({ root }, sink, { onPath: () => true, exists: () => true });

  const said = results.filter((r) => r.name === STALE_HOOK_CHECK);
  assert.deepEqual(said.map((r) => r.ok), [null, null], 'a hook a human may have chosen is a warning, not a failure');
  for (const r of said) assert.match(r.detail, /run in every session in this repo/);
  assert.match(said.find((r) => r.detail.includes(LOCAL)).fix, /^hkb init/, 'init takes the per-developer copy out on its own');
  assert.match(said.find((r) => r.detail.includes(SHARED)).fix, /delete hkb's hooks from .*settings\.json unless every session/, 'the tracked one is a choice, so it is the operator who deletes it');
});

test('doctor says so when nothing anywhere configures the stop hook', () => {
  const { results, sink } = findings();
  checkHooks({ root: scratch() }, sink, { onPath: () => true, exists: () => true });
  const missing = finding(results, 'stop hook');
  assert.equal(missing.ok, null);
  assert.match(missing.detail, /no launch on this board carries it and it is not in .*settings\.local\.json or .*settings\.json/);
  assert.equal(finding(results, 'hook command'), undefined, 'nothing to resolve when nothing is configured');
});

// #163: an older board configured before SubagentStop existed still has a Stop hook, so it passes
// that check — but its Stop hook cannot tell a track root waiting on its wave from one that forgot
// the verb, and doctor has to say so the same way it says a missing Stop hook.
test('doctor warns when SubagentStop is missing on a board that only carries Stop and PreToolUse (#163)', () => {
  const root = scratch();
  writeSettings(root, SHARED, {
    hooks: {
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'hkb hook stop', timeout: 30 }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'hkb hook pretool', timeout: 30 }] }],
    },
  });
  const { results, sink } = findings();

  checkHooks({ root }, sink, { onPath: () => true, exists: () => true });

  assert.equal(finding(results, 'stop hook').ok, true, 'Stop is still configured, so that check still passes on its own');
  const missing = finding(results, 'subagent-stop hook');
  assert.equal(missing.ok, null);
  assert.match(missing.detail, /a track root that fans a wave out to subagents gets nudged for the terminal verb while they are still running/);
  assert.match(missing.fix, /^hkb init/);
});

// The move itself: what doctor asks about is the command a worker will run, and where it says that
// command comes from is the launch — not a file whose noise filed the card.
test('doctor checks the launch line, and names it (#144)', () => {
  const root = scratch();
  const cfg = { profiles: { claude: DEFAULT_PROFILES.claude, 'claude-p': DEFAULT_PROFILES['claude-p'], codex: DEFAULT_PROFILES.codex } };
  const { results, sink } = findings();

  checkHooks({ root, cfg }, sink, { onPath: () => true, exists: () => true, binRel: null });

  const stop = finding(results, 'stop hook');
  assert.equal(stop.ok, true);
  assert.match(stop.detail, /^on the claude, claude-p launch \(--settings\), so no other session in this repo runs it$/, 'codex reads its own hook file, so it is not on this list');
  assert.equal(finding(results, 'subagent-stop hook').ok, true, 'it rides the same launch as Stop');
  assert.equal(finding(results, 'hook command').ok, true, '`hkb` is on PATH in this fixture, so the launch resolves');
  assert.equal(finding(results, STALE_HOOK_CHECK), undefined, 'and there is no settings file to complain about');
});

test('doctor fails a launch whose hkb is not there, and says whose tool calls it costs', () => {
  const root = scratch();
  const cfg = { profiles: { claude: DEFAULT_PROFILES.claude } };
  const { results, sink } = findings();

  // no hkb on PATH and none carried by the repo: the launch falls back to this package's own bin,
  // which the fixture says is missing
  checkHooks({ root, cfg }, sink, { onPath: () => false, exists: () => false, binRel: null });

  const cmd = finding(results, 'hook command');
  assert.equal(cmd.ok, false);
  assert.match(cmd.detail, /in the claude launch/, 'the launch is where it came from, so the launch is what is named');
  assert.match(cmd.detail, /fails on every tool call a worker makes/, 'and not "every session in this repo" — that is the thing this stopped doing');
});

// The upgrade path, and the one way this change can go quiet: `loadBoard` lets an array in
// board.json win whole, so a launch an older `init` froze there never gains the flag — and nothing
// is being written into a settings file to make up for it any more.
test('doctor catches a launch frozen in board.json before the hooks moved onto it', () => {
  const root = scratch();
  const stale = DEFAULT_PROFILES.claude.launch.filter((el) => el !== HOOK_SETTINGS_VAR);
  const cfg = { profiles: { claude: { ...DEFAULT_PROFILES.claude, launch: stale }, mine: { launch: [...stale] } } };
  assert.deepEqual(staleHookLaunches(cfg), ['claude', 'mine']);

  const { results, sink } = findings();
  checkHooks({ root, cfg }, sink, { onPath: () => true, exists: () => true, binRel: null });

  const said = results.filter((r) => r.name === LAUNCH_HOOK_CHECK);
  assert.deepEqual(said.map((r) => r.ok), [null, null]);
  assert.match(said[0].detail, /predates the hooks moving onto it, so its workers get no Stop nudge and record no session id/);
  assert.match(said[0].fix, /insert "\{hook_settings\}" into the claude profile's launch/, 'names the surgical fix, not "drop launch"');
  assert.match(said[0].fix, /--model\/--effort, which are profile fields now/, 'and the escape hatch for a pin that only added those');
  assert.match(said[1].fix, /add "\{hook_settings\}" to that launch/, 'a custom name has no default to fall back to');
  assert.deepEqual(staleHookLaunches({ profiles: { claude: DEFAULT_PROFILES.claude, codex: DEFAULT_PROFILES.codex } }), [], 'a current launch and a non-Claude one are both fine');
});

test('doctor resolves $CLAUDE_PROJECT_DIR before looking, and says what it found (#146)', () => {
  const root = scratch();
  writeSettings(root, SHARED, withHkbHooks(`f="${PROJECT_DIR}/${DEP_REL}"; [ -f "$f" ] || exit 0; exec node "$f"`));
  const seen = [];
  const { results, sink } = findings();

  checkHooks({ root }, sink, { onPath: () => false, exists: (p) => (seen.push(p), true), binRel: DEP_REL });

  assert.deepEqual(seen, [path.join(root, ...DEP_REL.split('/'))], 'the variable is this repo, and doctor is standing in it');
  const cmd = finding(results, 'hook command');
  assert.equal(cmd.ok, true);
  assert.equal(cmd.detail, `${PROJECT_DIR}/${DEP_REL} → ${path.join(root, ...DEP_REL.split('/'))}`, 'a pass names the file it resolved, not two lines of shell');
});

test('doctor calls a not-yet-installed guarded hook what it is: waiting, not broken', () => {
  const root = scratch();
  writeSettings(root, SHARED, withHkbHooks(`f="${PROJECT_DIR}/${DEP_REL}"; [ -f "$f" ] || exit 0; exec node "$f"`));
  const { results, sink } = findings();

  checkHooks({ root }, sink, { onPath: () => false, exists: () => false, binRel: null });

  const cmd = finding(results, 'hook command');
  assert.equal(cmd.ok, null, 'a command that exits 0 in silence fails nothing — a worktree before `npm ci` is the normal case');
  assert.match(cmd.detail, /is not installed here — the hook exits 0 in silence until it is/);
  assert.match(cmd.fix, /npm install/);
});

test('doctor fails a stale bare `hkb` on a repo that carries its own', () => {
  const root = scratch();
  writeSettings(root, SHARED, withHkbHooks('hkb'));
  const { results, sink } = findings();

  checkHooks({ root }, sink, { onPath: () => true, exists: () => true, binRel: DEP_REL });

  const cmd = finding(results, 'hook command');
  assert.equal(cmd.ok, false, 'it resolves on this machine and on nobody else\'s — and this file is read by everybody');
  assert.match(cmd.detail, new RegExp(`this repo carries hkb itself \\(${DEP_REL.replace(/[/.]/g, '\\$&')}\\)`));
  assert.match(cmd.detail, /\.claude[/\\]settings\.json/, 'it names the file the stale command is in');
  assert.match(cmd.fix, /^hkb init/);
  assert.ok(cmd.fix.includes(`${PROJECT_DIR}/${DEP_REL}`), 'and what init will write instead');
});

// The same verdict on hkb's own checkout, which is where the noise that filed #146 was first read:
// `bin/hkb.js` is right there, and the committed command still says `hkb`.
test('doctor fails a stale bare `hkb` on a checkout of hkb itself', () => {
  const root = scratch();
  writeSettings(root, SHARED, withHkbHooks('hkb'));
  const { results, sink } = findings();

  checkHooks({ root }, sink, { onPath: () => false, exists: () => true, binRel: BIN });

  const cmd = finding(results, 'hook command');
  assert.equal(cmd.ok, false);
  assert.ok(cmd.fix.includes(`${PROJECT_DIR}/${BIN}`), 'no install to wait for here — init rewrites it and it resolves');
});

// A guarded command whose file is missing reads as "not installed yet" only while it still names
// where hkb would land. Point it somewhere the repo's hkb is not — a pnpm store path that moved with
// a version bump — and silence is the bug, not the state.
test('doctor fails a guarded command that names a path this repo\'s hkb has left', () => {
  const root = scratch();
  const stale = 'node_modules/.pnpm/hkb-cli@0.1.3/node_modules/hkb-cli/bin/hkb.js';
  writeSettings(root, SHARED, withHkbHooks(`f="${PROJECT_DIR}/${stale}"; [ -f "$f" ] || exit 0; exec node "$f"`));
  const { results, sink } = findings();

  checkHooks({ root }, sink, { onPath: () => false, exists: () => false, binRel: DEP_REL });

  const cmd = finding(results, 'hook command');
  assert.equal(cmd.ok, false, 'no amount of `npm install` brings this path back');
  assert.match(cmd.detail, /has been exiting 0 in silence/);
  assert.ok(cmd.fix.includes(`${PROJECT_DIR}/${DEP_REL}`), 'init is what rewrites it');
});

test('findClaudeHooks reads both files and reports the one it cannot parse', () => {
  const root = scratch();
  writeSettings(root, LOCAL, '{ not json');
  writeSettings(root, SHARED, withHkbHooks('hkb'));

  const { hooks, unreadable } = findClaudeHooks(root);

  assert.deepEqual(unreadable.map((u) => u.file), [LOCAL]);
  assert.deepEqual(hooks.map((h) => `${h.file} ${h.event}`), [`${SHARED} Stop`, `${SHARED} PreToolUse`, `${SHARED} SubagentStop`]);
});

test('`hkb help` lists every hook verb the CLI routes', () => {
  const help = spawnSync(process.execPath, [path.join(REPO, 'bin', 'hkb.js'), 'help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /hook stop\|pretool/);
});

// ---------- #166: a repo-carried hkb in the harness files and .mcp.json, not just Claude's hooks ----------
// Neither Codex nor Copilot sets a per-launch $CLAUDE_PROJECT_DIR, but both run their hook's command
// from the project root — so the fix is the same remainder as #146 (projectBinRel), named relative to
// cwd instead of through a variable, and with no `[ -f … ] || exit 0` guard: whether the command runs
// through a shell is undocumented for either harness, and the guard's `f="…";…` is not valid argv.

test('relativeHookCommand is the plain cwd-relative form — no guard, no $CLAUDE_PROJECT_DIR', () => {
  assert.equal(relativeHookCommand(DEP_REL, 'stop'), `node "${DEP_REL}" hook stop`);
  assert.ok(!relativeHookCommand(DEP_REL, 'stop').includes(PROJECT_DIR));
  assert.ok(!relativeHookCommand(DEP_REL, 'stop').includes('[ -f'));
});

test('hkbCommandForHook({ cwd: true }) names a harness-carried hkb relative to its own cwd', () => {
  const opts = { root: '/repo', pkgRoot: '/repo/node_modules/hkb-cli', cwd: true, shared: true };
  assert.equal(hkbCommandForHook('stop', opts), relativeHookCommand(DEP_REL, 'stop'));
  assert.equal(hkbCommandForHook('stop', { root: '/repo', pkgRoot: '/repo', cwd: true, shared: true }), relativeHookCommand(BIN, 'stop'), 'a checkout of hkb names its own bin the same way');
  assert.ok(!hkbCommandForHook('stop', opts).includes('/repo'), 'it must not name the machine it was written on');
  // no hkb inside the repo: the global-install contract holds — bare `hkb`, never an absolute path,
  // because a harness file is always tracked
  assert.equal(hkbCommandForHook('stop', { root: '/repo', pkgRoot: '/elsewhere/node_modules/hkb-cli', cwd: true, shared: true, onPath: false }), 'hkb hook stop');
});

test('installHarness writes no absolute path when the repo carries hkb itself, for both harnesses', () => {
  for (const h of HARNESSES) {
    const root = scratch();
    const command = hkbCommandForHook('stop', { root, pkgRoot: path.join(root, 'node_modules', 'hkb-cli'), cwd: true, shared: true });
    installHarness(root, h, { command });
    const written = harnessHookCommand(root, h);
    assert.equal(written, relativeHookCommand(DEP_REL, 'stop'));
    assert.ok(!written.includes(root), `${h}: ${written} names the machine it was generated on`);
    assert.ok(!/\/home|\/tmp|\\Users\\/.test(written), `${h}: ${written} looks like an absolute machine path`);

    // and it runs, exit 0, from a plain sh in the project root, once the file is there
    fs.mkdirSync(path.join(root, path.dirname(DEP_REL)), { recursive: true });
    fs.writeFileSync(path.join(root, DEP_REL), 'process.exitCode = 0;\n');
    const sh = spawnSync('sh', ['-c', written], { cwd: root, encoding: 'utf8' });
    assert.equal(sh.status, 0, sh.stderr);
  }
});

test('checkHarnesses fails a harness hook command that does not resolve, and passes one that does', () => {
  const root = scratch();
  const command = hkbCommandForHook('stop', { root, pkgRoot: path.join(root, 'node_modules', 'hkb-cli'), cwd: true, shared: true });
  installHarness(root, 'codex', { command });
  const ctx = { root, cfg: { profiles: { codex: DEFAULT_PROFILES.codex } } };
  const { results, sink } = findings();

  checkHarnesses(ctx, sink, { exists: () => false });
  let cmd = finding(results, 'codex hook command');
  assert.equal(cmd.ok, false);
  assert.match(cmd.detail, /is not there/);

  results.length = 0;
  checkHarnesses(ctx, sink, { exists: () => true });
  cmd = finding(results, 'codex hook command');
  assert.equal(cmd.ok, true);
  assert.ok(cmd.detail.includes(DEP_REL));
});

test('mcpLaunch names a repo-carried hkb relative to the project directory, unguarded, no shell', () => {
  const root = '/repo';
  const launch = mcpLaunch({ root, pkgRoot: path.join(root, 'node_modules', 'hkb-cli') });
  assert.deepEqual(launch, { command: 'node', args: [DEP_REL, 'mcp'] });
  assert.ok(!launch.args[0].includes(root), 'must not name the machine it was written on');

  const selfCheckout = mcpLaunch({ root, pkgRoot: root });
  assert.deepEqual(selfCheckout, { command: 'node', args: [BIN, 'mcp'] });

  // no hkb inside the repo: falls back to the plain `hkb` every teammate has to have on PATH, same
  // as the harness files' `shared` case — never an absolute, this-machine-only path (#166 review)
  const elsewhere = mcpLaunch({ root, pkgRoot: '/elsewhere/node_modules/hkb-cli', onPath: false });
  assert.deepEqual(elsewhere, { command: 'hkb', args: ['mcp'] });
});

test('mcpLaunch prefers a repo-carried hkb over PATH, same order as hkbCommandForHook', () => {
  const root = '/repo';
  const launch = mcpLaunch({ onPath: true, root, pkgRoot: path.join(root, 'node_modules', 'hkb-cli') });
  assert.deepEqual(launch, { command: 'node', args: [DEP_REL, 'mcp'] }, 'a repo-carried hkb runs even when hkb is also on PATH');
});

test('mcpLaunch({ shared: false }) is the private, this-machine-only form for a config nothing commits', () => {
  const onPath = mcpLaunch({ onPath: true, shared: false });
  assert.deepEqual(onPath, { command: 'hkb', args: ['mcp'] });
  const fallback = mcpLaunch({ onPath: false, shared: false });
  assert.equal(fallback.command, process.execPath);
  assert.ok(path.isAbsolute(fallback.args[0]));
});

test('installMcp writes no absolute path when the repo carries hkb itself, and the command resolves from the project root', () => {
  const root = scratch();
  const launch = mcpLaunch({ root, pkgRoot: path.join(root, 'node_modules', 'hkb-cli') });
  installMcp(root, launch);

  const doc = JSON.parse(fs.readFileSync(path.join(root, MCP_FILE), 'utf8'));
  const entry = doc.mcpServers[MCP_KEY];
  assert.deepEqual(entry, { type: 'stdio', command: 'node', args: [DEP_REL, 'mcp'] });
  assert.ok(!JSON.stringify(entry).includes(root), '.mcp.json must not name the machine it was written on');

  fs.mkdirSync(path.join(root, path.dirname(DEP_REL)), { recursive: true });
  fs.writeFileSync(path.join(root, DEP_REL), 'process.exitCode = 0;\n');
  const run = spawnSync(entry.command, entry.args, { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});

test('checkMcp fails a .mcp.json entry that does not resolve, and passes one that does', async () => {
  const root = scratch();
  const launch = mcpLaunch({ root, pkgRoot: path.join(root, 'node_modules', 'hkb-cli') });
  installMcp(root, launch);
  const { results, sink } = findings();

  await checkMcp({ root }, sink, { exists: () => false });
  let cmd = finding(results, MCP_FILE);
  assert.equal(cmd.ok, false);
  assert.match(cmd.detail, /is not there/);

  results.length = 0;
  await checkMcp({ root }, sink, { exists: () => true });
  cmd = finding(results, MCP_FILE);
  assert.equal(cmd.ok, true);
  assert.ok(cmd.detail.includes(DEP_REL));

  // nothing configured — silent, not a warning: MCP is opt-in
  const bare = scratch();
  results.length = 0;
  await checkMcp({ root: bare }, sink, {});
  assert.deepEqual(results, []);
});
