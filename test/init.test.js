// `hkb init` — the cold-start path, driven end to end against a temp git repo and the fake gh.
//
// A stranger's first command used to be the least-tested path in the project: the suite covered
// init's helpers one by one and nothing called `init()` itself, so all three bugs the first outside
// adoption found lived in the *composition* — which profiles a fresh board is seeded with (#72),
// which hooks get written versus reported (#73), what the shipped ignore list contains (#74). Each
// of those has a test below that fails if it is reintroduced.
//
// The transport is `test/fake-gh.js`, installed inside `src/gh.js`, so nothing here spawns `gh` or
// touches the network; `--repo owner/name` is what lets init skip `detectRepo`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { init, resolveStore, ensureGitignore, GITIGNORE_LINES, CLAUDE_HOOKS, HOOK_SETTINGS, agentsSkillDir, packageSkillDir, readSkillVersion, commandFiles, commandNames } from '../src/init.js';
import { parseArgs } from '../src/cli.js';
import { makeContext, DEFAULT_PROFILES, HOOK_SETTINGS_VAR, userBoardsFile } from '../src/board.js';
import { checkHooks, LAUNCH_HOOK_CHECK } from '../src/doctor.js';
import { L, STATUSES } from '../src/model.js';
import { FakeGh } from './fake-gh.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-init-'));
const lines = (root) => fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n');

// Every init below registers the checkout it set up in the user-level board list (#100), so the whole
// file runs under a temp `KB_CONFIG_HOME` — including the tests that spawn the real CLI. Nothing here
// may touch the `~/.config/hkb/boards.json` of whoever is running the suite.
const ORIGINAL_CONFIG_HOME = process.env.KB_CONFIG_HOME;
const CONFIG_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-init-config-'));
process.env.KB_CONFIG_HOME = CONFIG_ROOT;
after(() => {
  if (ORIGINAL_CONFIG_HOME === undefined) delete process.env.KB_CONFIG_HOME;
  else process.env.KB_CONFIG_HOME = ORIGINAL_CONFIG_HOME;
});

/** A config home of its own, so one test's board list can never be another's. */
const configHome = () => fs.mkdtempSync(path.join(CONFIG_ROOT, 'home-'));

// ---------- the .gitignore block, on its own ----------
// The list of ignored paths is the same lesson twice: once in this repo's own `.gitignore`, once in
// the one every adopter gets. `.kanban/dispatch.pid` was added here and never shipped, so an adopter
// who ran `hkb dispatch --loop` and then `git add -A` committed a pidfile carrying their host and
// pid. The subset test below is what keeps the two in step.

test('every path hkb writes locally is ignored — the pidfile included', () => {
  const root = scratch();
  assert.equal(ensureGitignore(root), true);
  const written = lines(root);
  for (const w of GITIGNORE_LINES) assert.ok(written.includes(w), `${w} missing from the generated .gitignore`);
  assert.ok(written.includes('.kanban/dispatch.pid'), 'the dispatcher pidfile must be ignored');
  assert.ok(written.includes(HOOK_SETTINGS.local), 'the hooks name this machine, so their file must never be committable (#85)');
  assert.ok(!written.includes('.kanban/board.json'), 'board.json is tracked on purpose');
  assert.ok(!written.includes(HOOK_SETTINGS.shared), '--shared-hooks writes a tracked file on purpose');
});

test('a repo that already has the lines is left untouched', () => {
  const root = scratch();
  ensureGitignore(root);
  const before = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.equal(ensureGitignore(root), false, 'nothing to add');
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), before);
});

test('an existing .gitignore keeps its own lines and gains only what it lacks', () => {
  const root = scratch();
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n.kanban/logs/\n');
  assert.equal(ensureGitignore(root), true);
  const written = lines(root);
  assert.ok(written.includes('node_modules/'), 'the repo\'s own entries survive');
  assert.equal(written.filter((l) => l === '.kanban/logs/').length, 1, 'no duplicate for a line already there');
  assert.ok(written.includes('.kanban/dispatch.pid'));
});

test('CRLF and indented entries still count as present', () => {
  const root = scratch();
  fs.writeFileSync(path.join(root, '.gitignore'), GITIGNORE_LINES.join('\r\n') + '\r\n');
  assert.equal(ensureGitignore(root), false, 'a Windows checkout must not re-append the whole block');
});

test("this repo's .gitignore is a superset — a lesson learned here ships to adopters", () => {
  const own = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  for (const w of GITIGNORE_LINES) {
    assert.ok(own.includes(w), `${w} is shipped by \`hkb init\` but not ignored in hkb's own repo`);
  }
  const drift = own.filter((l) => l.startsWith('.kanban/') && l !== '.kanban/board.json' && !GITIGNORE_LINES.includes(l));
  assert.deepEqual(drift, [], 'hkb ignores a .kanban/ path locally that `hkb init` does not ship');
});

// ---------- the whole command, driven ----------

const NWO = 'acme/board'; // what FakeGh answers for; init takes it from --repo, so detectRepo never runs
const BOARD_FILE = path.join('.kanban', 'board.json');
// Since #144 a plain `hkb init` writes NO settings file: the hooks ride the worker launch, and
// `--shared-hooks` is the only way to put them where every session in the repo reads them.
// what a re-run must leave byte-identical
const FOOTPRINT = [BOARD_FILE, '.gitignore', 'CLAUDE.md', 'AGENTS.md', path.join('.agents', 'skills', 'kanban', 'SKILL.md'),
  ...commandFiles().map((f) => f.rel)];

function gitRepo() {
  const root = fs.realpathSync(scratch()); // macOS /var → /private/var; git reports the real path
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0, `git ${args.join(' ')}`);
  git('init', '-q', '-b', 'main');
  return root;
}

/** Every file in `dir`, relative and sorted — for "the copy is the package, whole". */
const tree = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? tree(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]))
  .sort();

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const board = (root) => JSON.parse(read(root, BOARD_FILE));
const snapshot = (root) => Object.fromEntries(FOOTPRINT.map((rel) => [rel, read(root, rel)]));
/** The names of the labels init actually created, in the order it asked for them. */
const created = (gh) => gh.requestsMatching('POST', '/labels').map((c) => c.body.name);

/**
 * Run the real `init()` the way the CLI does — real arg parsing, real context, fake transport — in a
 * temp git repo, with a config home of its own. Returns the repo, the fake (so a test can look at
 * what was sent), the log lines, and the board list init registered into. Pass a previous result back
 * to re-run in the same repo, against the same list.
 */
async function runInit(extra = [], { root = gitRepo(), gh = new FakeGh(), config = configHome() } = {}) {
  const cwd = process.cwd();
  const restore = gh.install();
  const printed = [];
  process.chdir(root);
  process.env.KB_CONFIG_HOME = config;
  const boards = userBoardsFile();
  try {
    const { flags } = parseArgs(['init', '--repo', NWO, ...extra]);
    const code = await init(makeContext(flags), flags, (s) => printed.push(s));
    return { root, gh, printed, code, config, boards };
  } finally {
    process.chdir(cwd);
    process.env.KB_CONFIG_HOME = CONFIG_ROOT;
    restore();
  }
}

test('a fresh board is seeded with exactly the profiles asked for (#72)', async () => {
  const bare = await runInit();
  assert.equal(bare.code, 0);
  assert.deepEqual(Object.keys(board(bare.root).profiles), ['claude'], 'a bare init means claude, not all six built-ins');

  const narrowed = await runInit(['--profiles', 'claude-p']);
  assert.deepEqual(Object.keys(board(narrowed.root).profiles), ['claude-p'], '--profiles has to be able to narrow, not only widen');

  const two = await runInit(['--profiles', 'claude,claude-track']);
  assert.deepEqual(Object.keys(board(two.root).profiles), ['claude', 'claude-track']);
  assert.deepEqual(board(two.root).profiles.claude, DEFAULT_PROFILES.claude, 'a seeded profile is the built-in, verbatim');

  const harness = await runInit(['--harness', 'codex']);
  assert.deepEqual(Object.keys(board(harness.root).profiles), ['codex'], 'a harness brings its own profile and replaces the default');
  assert.ok(fs.existsSync(path.join(harness.root, '.codex', 'hooks.json')), 'and its generated files');
});

// The label step goes through `openStore` like every other board write (#325), and on the one store
// hkb has there is nothing to create: a card's status is a column on the card. What #72 pinned — the
// *set* init would ask for, and that it asks for nothing else — is now that it sends nothing at all.
test('init writes no labels, and nothing else reaches the forge either (#72)', async () => {
  const { root, gh, printed } = await runInit();

  assert.deepEqual(created(gh), [], 'a card\'s status is a column, so there are no labels to create');
  assert.ok(printed.some((l) => l.startsWith('no kb:* labels to create')), printed.join('\n'));
  assert.deepEqual(gh.writeRequests(), [], 'init writes nothing to the forge at all');
  assert.equal(board(root).repo, NWO);
  assert.equal(board(root).board, 'default');
  assert.equal(board(root).default_branch, 'main');
});

// The whole of #144, end to end: a repo `hkb init` has just set up must cost a session that is not
// a worker's *nothing*. No hook in either settings file means no shell, no node and no failure per
// tool call in every other session in that repo — which is what an `hkb` that stopped resolving
// (an nvm switch, a cleaned npx cache) had been doing.
test('init writes no hook into either settings file, and says where they run instead (#144)', async () => {
  const { root, printed } = await runInit();

  for (const rel of Object.values(HOOK_SETTINGS)) {
    assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} is read by every session in this repo, and hkb's hooks serve only a worker`);
  }
  const said = printed.find((l) => l.includes('ride the worker launch'));
  assert.ok(said, `init must say where the hooks are, not go quiet about them:\n${printed.join('\n')}`);
  for (const event of Object.keys(CLAUDE_HOOKS)) assert.ok(said.includes(event), `${event} goes unnamed in: "${said}"`);
  assert.ok(printed.some((l) => l.includes('--shared-hooks')), 'and name the flag that does put them in the tracked file');
});

test('a hook an older init left in the per-developer file is taken back out (#144)', async () => {
  const root = gitRepo();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, HOOK_SETTINGS.local), JSON.stringify({
    model: 'opus',
    hooks: {
      Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'make lint' }, { type: 'command', command: 'hkb hook stop', timeout: 30 }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'hkb hook pretool', timeout: 30 }] }],
    },
  }, null, 2));

  const { printed } = await runInit([], { root });

  const after = JSON.parse(read(root, HOOK_SETTINGS.local));
  assert.equal(after.model, 'opus', 'the rest of the file is the operator\'s');
  assert.deepEqual(after.hooks.Stop[0].hooks.map((h) => h.command), ['make lint'], 'and so is their own hook in the same group');
  assert.equal(after.hooks.PreToolUse, undefined, 'ours is gone, and an empty event with it');
  assert.ok(printed.some((l) => /removed the Stop and PreToolUse hooks hkb left/.test(l)), `init must say it took them out:\n${printed.join('\n')}`);
});

// #254: a repo whose `.mcp.json` server is granted on the board but approved only in the
// gitignored per-developer file is a board whose workers will silently get no MCP. `hkb init` is the
// moment a human is present and thinking about setup, so it says so — the same diagnosis `hkb doctor`
// gives later, at the moment it can still be fixed before the first worker runs.
test('init reports a server approved only in settings.local.json, naming the line and the file to move it to (#254)', async () => {
  const root = gitRepo();
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { 'react-aria': { command: 'npx', args: ['react-aria-mcp'] } } }));
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, HOOK_SETTINGS.local), JSON.stringify({ enabledMcpjsonServers: ['react-aria'] }));

  await runInit(['--profiles', 'claude'], { root });
  // the default `claude` profile only ever ships `Skill`/`Bash`/etc — a repo has to opt a server into
  // allowed_tools itself, so the fixture edits board.json the way a human granting `react-aria` would.
  const boardPath = path.join(root, BOARD_FILE);
  const cfg = JSON.parse(read(root, BOARD_FILE));
  cfg.profiles.claude.allowed_tools = [...(cfg.profiles.claude.allowed_tools || []), 'mcp__react-aria__*'];
  fs.writeFileSync(boardPath, JSON.stringify(cfg, null, 2));

  const again = await runInit(['--profiles', 'claude'], { root });
  const note = again.printed.find((l) => l.includes('react-aria'));
  assert.ok(note, `init must name the split:\n${again.printed.join('\n')}`);
  assert.match(note, /"react-aria" in "enabledMcpjsonServers".*only in .*settings\.local\.json/);
  assert.match(note, /Move .* into .*settings\.json/);
});

test('init says nothing about mcp approval when there is nothing to diagnose (no .mcp.json, or already tracked)', async () => {
  const { printed } = await runInit();
  assert.ok(!printed.some((l) => l.includes('enabledMcpjsonServers')), 'no .mcp.json at all: nothing to report');
});

test('--shared-hooks writes the tracked file, with a command that is true on every machine (#85)', async () => {
  const { root, printed } = await runInit(['--shared-hooks']);

  assert.equal(fs.existsSync(path.join(root, HOOK_SETTINGS.local)), false, 'one file, or every nudge fires twice');
  const hooks = JSON.parse(read(root, HOOK_SETTINGS.shared)).hooks;
  for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
    assert.equal(hooks[event][0].hooks[0].command, `hkb hook ${verb}`, 'a tracked file gets the portable form, never a path');
  }
  assert.ok(printed.some((l) => l.includes(HOOK_SETTINGS.shared)));
});

/** A PATH with the handful of binaries init shells out to, and definitely no `hkb` — the machine the bug needs. */
function pathWithoutHkb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-nopath-'));
  for (const bin of ['sh', 'git', 'node']) {
    const found = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
    if (found.status !== 0) return null;
    fs.symlinkSync(found.stdout.trim(), path.join(dir, bin));
  }
  return dir;
}

test('run from the npx cache, init names a command that outlives it — and never the cache path (#85)', async () => {
  // The trap this closes: `npx hkb-cli init` on a machine with no global install used to write
  // PKG_ROOT — inside the cache — into a *tracked* settings file. Wrong for every teammate, and gone
  // for the installer too the next time npm cleans that cache. Since #144 there is no settings file
  // to get it wrong in, and the same rule governs the launch line instead. So run the real CLI from
  // a package root that looks exactly like one, on a PATH with no `hkb` on it.
  const cache = path.join(fs.realpathSync(scratch()), '_npx', '9f3c1a', 'node_modules', 'hkb-cli');
  fs.mkdirSync(cache, { recursive: true });
  // a copy, not a link: node resolves a symlinked module to its real path, and PKG_ROOT with it
  for (const entry of ['bin', 'src', 'skills', 'templates', 'package.json']) fs.cpSync(path.join(REPO, entry), path.join(cache, entry), { recursive: true });
  let bin;
  try { bin = pathWithoutHkb(); } catch { return; } // a filesystem that refuses symlinks
  if (!bin) return;
  const root = gitRepo();
  const env = { ...process.env, PATH: bin, KB_TASK: '', KB_CONFIG_HOME: configHome() };
  const r = spawnSync(process.execPath, [path.join(cache, 'bin', 'hkb.js'), 'init', '--repo', NWO, '--no-labels'], { cwd: root, encoding: 'utf8', env });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);

  for (const rel of Object.values(HOOK_SETTINGS)) {
    assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} must not be written at all — and least of all with a cache path in it`);
  }
  // The launch is what carries the hooks, so it is the answer that has to survive the cache. Asked
  // for from the same package root, on the same PATH the CLI just ran on.
  const settings = spawnSync(process.execPath, ['-e',
    `import(${JSON.stringify(pathToFileURL(path.join(cache, 'src', 'init.js')).href)}).then((m) => process.stdout.write(m.workerHookSettings()))`,
  ], { cwd: root, encoding: 'utf8', env });
  assert.equal(settings.status, 0, settings.stderr);
  assert.ok(!settings.stdout.includes('_npx'), 'the npx cache stops existing the moment it is cleaned; nothing generated may name it');
  const hooks = JSON.parse(settings.stdout).hooks;
  assert.equal(hooks.Stop[0].hooks[0].command, 'npx -y hkb-cli hook stop', 'with no hkb on PATH and no durable checkout, npx is the only command that still runs tomorrow');
  assert.ok(`${r.stdout}${r.stderr}`.includes('npm i -g hkb-cli'), `and init says how to get a faster one:\n${r.stdout}${r.stderr}`);
});

test('the shipped ignore list reaches the adopter, pidfile included (#74)', async () => {
  const { root } = await runInit();
  const written = lines(root).map((l) => l.trim());
  for (const w of GITIGNORE_LINES) assert.ok(written.includes(w), `${w} missing from the .gitignore \`hkb init\` wrote`);
  assert.ok(written.includes('.kanban/dispatch.pid'), 'a pidfile carrying host and pid must never be committable by accident');
  assert.ok(!written.includes('.kanban/board.json'), 'board.json is tracked on purpose');
});

test('the skill is copied out of the package, whole, and the harness link points at it', async () => {
  const { root, printed } = await runInit();
  const installed = agentsSkillDir(root);

  assert.ok(!fs.lstatSync(installed).isSymbolicLink(), 'an adopter gets a copy: a link would point into a package they may uninstall');
  assert.deepEqual(tree(installed), tree(packageSkillDir()), 'the whole packaged skill, file for file');
  assert.equal(read(installed, 'SKILL.md'), fs.readFileSync(path.join(packageSkillDir(), 'SKILL.md'), 'utf8'));
  const version = readSkillVersion(packageSkillDir());
  assert.ok(version, 'the packaged SKILL.md must carry metadata.version, or doctor cannot spot a stale copy');
  assert.equal(board(root).skill_version, version, 'board.json remembers which version was copied');
  assert.ok(printed.some((l) => l.includes(`.agents/skills/kanban v${version}`)));

  const claudeSkill = path.join(root, '.claude', 'skills', 'kanban');
  assert.ok(fs.existsSync(path.join(claudeSkill, 'SKILL.md')), '.claude/skills/kanban must resolve to the installed skill');
  if (fs.lstatSync(claudeSkill).isSymbolicLink()) {
    assert.equal(fs.readlinkSync(claudeSkill), path.join('..', '..', '.agents', 'skills', 'kanban'));
  }
});

// ---------- the slash commands SKILL.md names (#92) ----------
// The skill's frontmatter and three of its section titles advertise `/kanban:specify`,
// `/kanban:decompose` and `/kanban:operate`. For a year nothing registered them, so an adopter who
// typed one got "Unknown command". Two tests hold the line: init has to write them, and every
// `/kanban:*` the skill mentions has to be one of the files that ship.

test('`hkb init` registers the slash commands the skill documents (#92)', async () => {
  const { root, printed } = await runInit();
  const packaged = commandFiles();

  assert.ok(packaged.length, 'the package must carry commands/, or there is nothing to register');
  assert.deepEqual(tree(path.join(root, '.claude', 'commands', 'kanban')), ['decompose.md', 'groom.md', 'operate.md', 'specify.md'],
    'the directory name is the namespace: .claude/commands/kanban/decompose.md is /kanban:decompose');
  for (const f of packaged) assert.equal(read(root, f.rel), f.contents, `${f.rel} must be the packaged command, verbatim`);
  assert.ok(printed.some((l) => l.includes('.claude/commands/kanban')), 'init has to say it installed them');
});

test('every /kanban:* the skill advertises is a command that exists (#92)', async () => {
  const { root } = await runInit();
  const names = commandNames();
  assert.deepEqual(names, ['/kanban:decompose', '/kanban:groom', '/kanban:operate', '/kanban:specify']);

  const skill = read(root, path.join('.agents', 'skills', 'kanban', 'SKILL.md'));
  const advertised = [...new Set([...skill.matchAll(/\/kanban:[a-z][a-z-]*/g)].map((m) => m[0]))].sort();
  assert.deepEqual(advertised, names,
    'the skill must name exactly the commands that ship — a name with no file is an "Unknown command" in someone else\'s session');

  // and each command sends the reader to the section of the same name, so the procedure has one home
  for (const f of commandFiles()) {
    const name = `/kanban:${path.basename(f.rel, '.md')}`;
    assert.ok(f.contents.includes(name), `${f.rel} must point at the ${name} section of SKILL.md`);
    assert.ok(skill.includes(`## ${name} `), `SKILL.md must still have a "## ${name}" section for ${f.rel} to delegate to`);
  }
});

test('the plugin registers the same commands, and they ship (#92)', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(REPO, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.name, 'kanban', 'the plugin name is the command namespace: /<plugin>:<command>');
  assert.equal(plugin.commands, './commands', 'without this key the plugin registers no commands at all');
  const flat = fs.readdirSync(path.join(REPO, 'commands'), { withFileTypes: true });
  assert.ok(flat.every((e) => e.isFile()), 'the plugin dir must be flat — a subdirectory would make it /kanban:<dir>:<name>');
  assert.deepEqual(flat.map((e) => e.name).sort(), ['decompose.md', 'groom.md', 'operate.md', 'specify.md']);

  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('commands'), 'commands/ must be in "files", or `hkb init` copies from a directory npm did not ship');
});

test('the CLAUDE.md / AGENTS.md section is the packaged one, spliced between markers', async () => {
  const root = gitRepo();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# their repo\n\ntheir own instructions\n');
  await runInit([], { root });

  const section = fs.readFileSync(path.join(REPO, 'templates', 'doc-section.md'), 'utf8').trim();
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    assert.ok(read(root, f).includes(`<!-- hkb:start -->\n${section}\n<!-- hkb:end -->`), `${f} must carry the packaged section verbatim`);
  }
  assert.match(read(root, 'CLAUDE.md'), /^# their repo\n\ntheir own instructions\n/, 'whatever was already there stays, above the block');
});

test('a second init changes nothing on disk and creates no labels', async () => {
  const first = await runInit();
  const before = snapshot(first.root);
  const posts = created(first.gh).length;

  const { printed } = await runInit([], first);

  assert.deepEqual(snapshot(first.root), before, 'a re-run must be a no-op: no duplicate section, no re-copied skill, no churn');
  assert.equal(created(first.gh).length, posts, 'the labels already exist — creating them again is a write nobody asked for');
  // A new board is `local`, and there it is not that the labels are already there — there are none,
  // and the board does not use any. "labels already present" was false in both halves; the line says
  // what is actually true, and still says it (silence would read as a step that did not run).
  assert.ok(printed.some((l) => l.startsWith('no kb:* labels to create')), printed);
  for (const rel of Object.values(HOOK_SETTINGS)) assert.equal(fs.existsSync(path.join(first.root, rel)), false, `${rel}: a re-run must not start writing one either`);
  assert.equal(lines(first.root).filter((l) => l.trim() === '.kanban/dispatch.pid').length, 1, 'no duplicate ignore line');
  assert.equal(read(first.root, 'CLAUDE.md').match(/<!-- hkb:start -->/g).length, 1, 'no second section');
});

test('a re-run is additive: a profile added by hand survives and gets its label', async () => {
  const first = await runInit();
  const cfg = board(first.root);
  cfg.profiles.codex = { ...DEFAULT_PROFILES.codex, max_in_progress: 3 }; // the operator's own edit
  fs.writeFileSync(path.join(first.root, BOARD_FILE), JSON.stringify(cfg, null, 2) + '\n');

  await runInit(['--profiles', 'claude'], first);

  const after = board(first.root);
  assert.deepEqual(Object.keys(after.profiles), ['claude', 'codex'], 're-running init must never silently delete work');
  assert.equal(after.profiles.codex.max_in_progress, 3, "and never overwrite the operator's edit");
});

// ---------- repairing a claude launch pinned before the hooks moved onto it (#144, #188) ----------
// `boardProfiles` only ever ADDS profiles (#72); an existing one, pinned stale, used to come back
// out of `loadBoard`'s deep-merge unchanged — expanded with "effort": null and every other field the
// current default carries, but with the same missing `{hook_settings}` and not one word said about
// it. This is doctor's own `launch hooks` fix, actually applied by `hkb init` instead of only reported.

test('a pinned claude launch missing {hook_settings} is repaired, and init says what it inserted', async () => {
  const first = await runInit();
  const cfg = board(first.root);
  const stale = DEFAULT_PROFILES.claude.launch.filter((el) => el !== HOOK_SETTINGS_VAR);
  cfg.profiles.claude.launch = stale; // frozen the way an older `init` would have left it
  fs.writeFileSync(path.join(first.root, BOARD_FILE), JSON.stringify(cfg, null, 2) + '\n');

  const { printed } = await runInit([], first);

  const after = board(first.root);
  assert.deepEqual(after.profiles.claude.launch, DEFAULT_PROFILES.claude.launch, 'inserted right after the --disallowedTools group, reconstructing the default exactly');
  assert.ok(printed.some((l) => l === 'profile "claude": inserted "{hook_settings}" after --disallowedTools in the claude launch'),
    `init must name the repair, not do it in silence:\n${printed.join('\n')}`);

  const { results, sink } = (() => {
    const results = [];
    return { results, sink: { ok: (name, detail) => results.push({ name, ok: true, detail }), warn: (name, detail, fix) => results.push({ name, ok: null, detail, fix }) } };
  })();
  checkHooks({ root: first.root, cfg: after }, sink, { onPath: () => true, exists: () => true, binRel: null });
  assert.equal(results.find((r) => r.name === LAUNCH_HOOK_CHECK), undefined, 'doctor must be clean after the repair');

  // and a second run is silent about it — there is nothing left to fix
  const again = await runInit([], first);
  assert.ok(!again.printed.some((l) => l.includes('inserted "{hook_settings}"')), 'idempotent: nothing stale, nothing to say');
});

test('a pin that only ever added --model/--effort is dropped, not repaired in place', async () => {
  const first = await runInit();
  const cfg = board(first.root);
  const pinned = DEFAULT_PROFILES.claude.launch
    .filter((el) => el !== HOOK_SETTINGS_VAR && el !== '{model_args}');
  pinned.splice(pinned.indexOf('{prompt}'), 0, '--model', 'opus', '--effort', 'high');
  cfg.profiles.claude.launch = pinned;
  fs.writeFileSync(path.join(first.root, BOARD_FILE), JSON.stringify(cfg, null, 2) + '\n');

  const { printed } = await runInit([], first);

  const after = board(first.root);
  assert.equal(after.profiles.claude.launch, undefined, 'the pin added nothing hkb\'s own default does not, so it is dropped back to it');
  assert.equal(after.profiles.claude.model, 'opus');
  assert.equal(after.profiles.claude.effort, 'high');
  assert.ok(printed.some((l) => l.startsWith('profile "claude": the pinned claude launch added nothing but --model opus and --effort high')),
    `init must say what it moved, not silently switch launches:\n${printed.join('\n')}`);
});

test('--no-labels writes every local file and sends nothing', async () => {
  const { root, gh, printed } = await runInit(['--no-labels']);

  assert.deepEqual(gh.requests, [], 'the offline path must not reach the transport at all');
  for (const rel of FOOTPRINT) assert.ok(fs.existsSync(path.join(root, rel)), `${rel} is local — --no-labels must still write it`);
  assert.ok(printed.some((l) => l.includes('--no-labels') && l.includes(NWO)), 'and say which labels it did not create, and where');
  assert.ok(printed.some((l) => l.includes('hkb init') && l.includes('without --no-labels')), 'and what to run to finish the job');
});

// ---------- the user-level board list (#98/#100) ----------
// `hkb serve` shows the checkouts named in `~/.config/hkb/boards.json`, and for a while the only way
// onto that page was to hand-edit that file — the one step of adoption a repo could not tell you
// about. init now does it, and the tests below hold the three properties that make doing it without
// asking defensible: it is idempotent, it says so out loud, and it can never fail an otherwise good
// init. Every one of them runs under a config home of its own (`runInit`).

const boardList = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('a fresh init puts the checkout on the user board list, and says where (#98)', async () => {
  const { root, boards, printed } = await runInit();

  assert.deepEqual(boardList(boards), { version: 1, boards: [root] },
    'exactly one entry, the checkout that was just set up, in the shape the README documents');
  const said = printed.find((l) => l.startsWith('registered this checkout in '));
  assert.ok(said, `init wrote a file outside the repo and must say so:\n${printed.join('\n')}`);
  assert.ok(said.includes(boards), `and name it: "${said}"`);
  assert.ok(said.includes('hkb serve'), `and say what it is for: "${said}"`);
});

test('a second init in the same checkout adds nothing and says it is already listed', async () => {
  const first = await runInit();
  const before = fs.readFileSync(first.boards, 'utf8');
  const mtime = fs.statSync(first.boards).mtimeMs;

  const { printed } = await runInit([], first);

  assert.equal(fs.readFileSync(first.boards, 'utf8'), before, 'one entry per checkout, however often init runs');
  assert.equal(fs.statSync(first.boards).mtimeMs, mtime, 'and a list that did not grow is not even rewritten');
  const said = printed.find((l) => l.startsWith('already listed in '));
  assert.ok(said, `the disclosure is not optional on the second run either:\n${printed.join('\n')}`);
  assert.ok(said.includes(first.boards) && said.includes('hkb serve'), `"${said}"`);
});

test('a checkout somebody listed by hand is not listed a second time', async () => {
  const root = gitRepo();
  const config = configHome();
  const file = path.join(config, 'hkb', 'boards.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, boards: [root] }, null, 2) + '\n');

  const { printed } = await runInit([], { root, config });

  assert.deepEqual(boardList(file).boards, [root],
    'init registers the plain path a human writes, so a checkout already on the list gains nothing — not a second card on the same page');
  assert.ok(printed.some((l) => l.startsWith('already listed in ')));
});

test('the offline path registers too — the list is a local write (#98)', async () => {
  const { root, gh, boards, printed } = await runInit(['--no-labels']);

  assert.deepEqual(gh.requests, [], 'registering sends nothing: --no-labels is still the offline path');
  assert.deepEqual(boardList(boards).boards, [root], 'the checkout is on the list with `gh` logged out');
  assert.ok(printed.some((l) => l.startsWith('registered this checkout in ')));
});

test('a board list somebody broke is a warning, not a failed init', async () => {
  const config = configHome();
  const file = path.join(config, 'hkb', 'boards.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const broken = '{ "boards": ["~/code/web",   // half-typed\n';
  fs.writeFileSync(file, broken);

  const { root, printed, code } = await runInit([], { config });

  assert.equal(code, 0, 'the repo is set up; a list outside it cannot take that away');
  assert.equal(fs.readFileSync(file, 'utf8'), broken, 'and a file a human wrote is never clobbered');
  const said = printed.find((l) => l.startsWith('could not add this checkout to '));
  assert.ok(said, `a registration that did not happen must still be said out loud:\n${printed.join('\n')}`);
  assert.ok(printed.some((l) => l.includes(root)), 'and the message names the path to add by hand');
  for (const rel of FOOTPRINT) assert.ok(fs.existsSync(path.join(root, rel)), `${rel}: the rest of init still happened`);
});

test('a config home that cannot be written is a warning, not a failed init', async () => {
  // A plain file where the config directory should be: `mkdir` fails with ENOTDIR, and unlike a
  // chmod it fails that way for root too, so this test means the same thing in a container.
  const config = path.join(CONFIG_ROOT, `blocked-${process.pid}-${Date.now()}`);
  fs.writeFileSync(config, 'not a directory\n');

  const { root, printed, code } = await runInit([], { config });

  assert.equal(code, 0, 'an unwritable config dir must never fail an otherwise good init');
  assert.ok(printed.some((l) => l.startsWith('could not add this checkout to ')), printed.join('\n'));
  assert.ok(fs.existsSync(path.join(root, BOARD_FILE)), 'the board it just set up is on disk');
});

test('`hkb init --json` carries `registered`, and stdout is that object alone', () => {
  // The real binary, not `init()`: `--json` is a promise about stdout, and the human log going to
  // stderr is half of what makes it parseable.
  const root = gitRepo();
  const config = configHome();
  const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'hkb.js'), 'init', '--repo', NWO, '--no-labels', '--json'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, KB_CONFIG_HOME: config, KB_TASK: '' } });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);

  const out = JSON.parse(r.stdout); // the whole of stdout, or this throws
  assert.deepEqual(out.registered, { file: path.join(config, 'hkb', 'boards.json'), added: true },
    'the field is exactly { file, added }');
  assert.deepEqual(boardList(out.registered.file).boards, [root]);
  assert.equal(out.repo, NWO);
  assert.equal(out.board, 'default');
  assert.equal(out.root, root);
  assert.ok(r.stderr.includes('registered this checkout in '), 'and the human still gets the line, on stderr');

  const again = spawnSync(process.execPath, [path.join(REPO, 'bin', 'hkb.js'), 'init', '--repo', NWO, '--no-labels', '--json'],
    { cwd: root, encoding: 'utf8', env: { ...process.env, KB_CONFIG_HOME: config, KB_TASK: '' } });
  assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
  assert.deepEqual(JSON.parse(again.stdout).registered, { file: path.join(config, 'hkb', 'boards.json'), added: false },
    'added says what this run did, not what the list holds');
});

test('--no-labels says no to the one flag that cannot be done offline, before writing anything', async () => {
  const root = gitRepo();
  await assert.rejects(() => runInit(['--no-labels', '--import'], { root }), (e) => {
    assert.equal(e.exitCode, 2, 'a request that cannot be honoured is a usage error');
    assert.match(e.message, /--import reads the GitHub board it migrates from/);
    assert.match(e.message, /Run `hkb init .*--no-labels` now/, 'and the message names both halves of the fix');
    return true;
  });
  assert.equal(fs.existsSync(path.join(root, BOARD_FILE)), false, 'nothing was written on the way out');
});

// ---------- the store (docs/local-first.md §6, ADR-006) ----------
// There is one store: the cards live on the `kb-board` branch in the repo init just ran in, and the
// index beside it. What must hold is that a fresh board gets it, a second init adopts what is there
// rather than recreating it, `--import` migrates a board that is still on GitHub Issues onto it, and
// `--store github` — the flag for a store hkb no longer has — says so rather than being ignored.

const branchTip = (root) => spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/kb-board'], { cwd: root, encoding: 'utf8' }).stdout.trim();

test('a fresh init creates a local board: the branch, the index, and board.json says so', async () => {
  const { root, printed } = await runInit();
  assert.equal(board(root).store, 'local');
  assert.match(branchTip(root), /^[0-9a-f]{40}$/, 'the kb-board branch is there');
  assert.equal(fs.existsSync(path.join(root, '.git', 'hkb', 'index.db')), true, 'and the index beside it');
  assert.ok(printed.some((l) => /^store: local — created the kb-board branch/.test(l)), printed.join('\n'));
  // §6.2: the branch is pushed, and init is where a human is told so.
  assert.ok(printed.some((l) => /^sync: `hkb sync` pushes kb-board/.test(l)), printed.join('\n'));

  const doc = JSON.parse(spawnSync('git', ['show', 'kb-board:board.json'], { cwd: root, encoding: 'utf8' }).stdout);
  assert.equal(doc.slug, 'default');
  assert.equal(doc.next_id, 1);
  assert.equal(typeof doc.host, 'string', 'the branch names its one writer');
});

test('a second init leaves the branch and the index exactly as they were', async () => {
  const first = await runInit();
  const tip = branchTip(first.root);
  const { printed } = await runInit([], first);
  assert.equal(branchTip(first.root), tip, 'an existing board is adopted, never recreated');
  assert.ok(printed.some((l) => /^store: local — kb-board at/.test(l)), printed.join('\n'));
});

test('a board written before the store key existed is not moved by a re-run', async () => {
  const legacy = await runInit();
  const cfg = board(legacy.root);
  delete cfg.store;
  fs.writeFileSync(path.join(legacy.root, BOARD_FILE), JSON.stringify(cfg, null, 2));

  const again = await runInit([], legacy);

  // The key is NOT written back. Nobody chose it — `resolveStore` read an absent key and answered
  // with the one store there is — and a plain re-init must not turn that into a line in a file the
  // repository tracks. `|| store === 'local'` used to, which put `"store": "local"` into
  // everybody's checkout as a side effect of a routine `hkb init`.
  assert.equal(board(legacy.root).store, undefined, 'an unasked-for answer is not pinned into board.json');
  assert.ok(again.printed.some((l) => /^store: local — kb-board at/.test(l)), again.printed.join('\n'));
});

test('a plain re-init writes no store key into a board.json the repository tracks', async () => {
  // The write `--import` refuses to make without `--force`, made as a side effect of a routine
  // `hkb init`: `pinStore` carried `|| store === 'local'`, and on any older board a re-init put
  // `"store": "local"` into a tracked file — every collaborator's next `git pull`.
  const legacy = await runInit();
  const cfg = board(legacy.root);
  delete cfg.store;
  fs.writeFileSync(path.join(legacy.root, BOARD_FILE), JSON.stringify(cfg, null, 2));
  const git = (...args) => spawnSync('git', args, { cwd: legacy.root, encoding: 'utf8' });
  git('add', BOARD_FILE);
  git('-c', 'user.email=hkb@local', '-c', 'user.name=hkb', 'commit', '-qm', 'board.json');
  const { boardFileTracked } = await import('../src/init.js');
  assert.equal(boardFileTracked(legacy.root), true, 'the file this init must not rewrite');

  await runInit([], legacy);

  assert.equal(board(legacy.root).store, undefined, 'a re-init did not write a key nobody asked for');
  // init rewrites the tracked file for its own reasons (profiles, skill version); what it must not
  // do is put a `store` line into everybody's copy.
  const diff = spawnSync('git', ['diff', '--', BOARD_FILE], { cwd: legacy.root, encoding: 'utf8' }).stdout;
  assert.equal(/^\+.*"store"/m.test(diff), false, `no store key was added to the tracked file:\n${diff}`);
});

test('--store github is refused by name, and names the migration instead', async () => {
  await assert.rejects(() => runInit(['--store', 'github']), (e) => e.exitCode === 2 && /--store github is gone/.test(e.message));
  await assert.rejects(() => runInit(['--store', 'github']), (e) => /hkb init --import/.test(e.message));
  await assert.rejects(() => runInit(['--store', 'sqlite']), (e) => e.exitCode === 2 && /--store takes "local"/.test(e.message));
  await assert.rejects(() => runInit(['--store']), (e) => e.exitCode === 2 && /--store needs a value/.test(e.message));
});

test('--take-over moves the branch to this host, and init says whose it was', async () => {
  const first = await runInit();
  // Somebody else's board: rewrite the owner on the branch the way another laptop's init would have.
  const { openGitTier } = await import('../src/store/git.js');
  openGitTier(first.root, { host: 'someone-elses-laptop' }).takeOver('someone-elses-laptop');

  const seen = await runInit([], first);
  assert.ok(seen.printed.some((l) => /owns this board, so hkb reads it here and refuses to write/.test(l)), seen.printed.join('\n'));

  const taken = await runInit(['--take-over'], first);
  assert.ok(taken.printed.some((l) => /now owns the board — it was "someone-elses-laptop"/.test(l)), taken.printed.join('\n'));
});

// ---------- which store an init sets a board up on ----------

test('resolveStore agrees with storeKind: one store, and a board.json cannot name another', async () => {
  const { storeKind } = await import('../src/store/index.js');

  assert.equal(resolveStore({}), 'local');
  assert.equal(resolveStore({ store: 'local' }), 'local');
  // The same answer `storeKind` gives from the same input, for a board written before the key
  // existed and for one that carries it.
  assert.equal(storeKind({ cfg: {} }), 'local');
  assert.equal(storeKind({ cfg: { store: 'local' } }), 'local');

  // `github` is refused on both sides rather than half-honoured, and both name the way out.
  assert.throws(() => resolveStore({ store: 'github' }), (e) => e.exitCode === 2 && /--store github is gone/.test(e.message));
  assert.throws(() => storeKind({ cfg: { store: 'github' } }), (e) => e.exitCode === 2 && /hkb init --import/.test(e.message));

  assert.throws(() => resolveStore({ store: 'sqlite' }), (e) => e.exitCode === 2 && /--store takes/.test(e.message));
  assert.throws(() => resolveStore({ store: true }), (e) => e.exitCode === 2 && /--store needs a value/.test(e.message));
  assert.throws(() => storeKind({ cfg: { store: 'sqlite' } }), (e) => e.exitCode === 2 && /is not a store/.test(e.message));
});
