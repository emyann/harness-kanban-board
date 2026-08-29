#!/usr/bin/env node
// Pack hkb the way npm will, install that tarball into an empty directory, and run the CLI from where
// it landed — including `hkb init` in a scratch repo, offline. `npm test` proves the source is correct;
// this proves the *tarball* is — that `files` in package.json still ships everything the CLI reads at
// runtime, and that `npx hkb-cli` works for someone who has none of this repository.
//
// It is the pre-publish half of the pair. The post-publish half lives in .github/workflows/release.yml,
// which does the same thing against the copy npm actually served. This one runs on every push, so a
// tarball regression is caught long before a tag exists.
//
//   node scripts/smoke-pack.mjs                  pack, install, verify, clean up
//   node scripts/smoke-pack.mjs --keep           leave the temp install behind, and print where
//   node scripts/smoke-pack.mjs --verify-only D  skip pack+install; verify the package root at D
//
// Zero dependencies, like everything else here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pkgName = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;

const REPO = fileURLToPath(new URL('..', import.meta.url));

// Every one of these is read at runtime from the installed package, so a `files` entry that goes
// missing must fail here rather than on a stranger's first `npx hkb-cli init`. The comment on each is the
// code that reads it.
const MUST_SHIP = [
  ['bin/hkb.js', 'the bin npm links as `hkb`'],
  ['src/cli.js', 'the CLI itself'],
  ['package.json', '`hkb version` reads its own version out of it'],
  ['skills/kanban/SKILL.md', '`hkb init` copies the skill from here (src/init.js packageSkillDir)'],
  ['skills/kanban/references/protocol.md', 'the skill links to it; a half-copied skill is worse than none'],
  ['skills/kanban/schema/terminal.json', 'the Codex profile names it in --output-schema'],
  ['commands/specify.md', '`/kanban:specify`, which SKILL.md documents by name: the plugin registers commands/, `hkb init` copies it'],
  ['commands/decompose.md', '`/kanban:decompose`, likewise — an unshipped command file is an unknown command in someone else\'s session (#92)'],
  ['templates/doc-section.md', 'the CLAUDE.md/AGENTS.md section `hkb init` splices in'],
  ['templates/actions/kanban-dispatch.yml', '`hkb init --with-actions`'],
  ['templates/copilot/kanban-worker.agent.md', '`hkb init --harness copilot`'],
  ['templates/codex/hooks.json', '`hkb init --harness codex`'],
  ['templates/mcp/mcp.json', '`hkb init --mcp`'],
  ['hooks/hooks.json', 'the Stop hook, referenced by .claude-plugin/plugin.json'],
  ['.claude-plugin/plugin.json', 'what makes the package installable as a Claude Code plugin'],
  ['web/index.html', '`hkb serve` reads it (src/serve.js PAGE_FILE)'],
  ['README.md', ''],
  ['LICENSE', ''],
];

// The other half of an allowlist working: if `files` were deleted altogether, npm would ship the whole
// repository and every check above would still pass.
const MUST_NOT_SHIP = ['test', 'docs', '.kanban', '.github', '.agents', 'CLAUDE.md', 'AGENTS.md'];

// What `hkb init` copies out of the package, as `[written path, packaged source, whole|section]`.
// The list above proves those files are *in* the tarball; this one proves the installed CLI actually
// reads them from there and puts them in a stranger's repo — a `files` entry can also go missing in a
// way that leaves the file present but unreadable from where the code looks for it.
// Where `hkb init` puts the Claude Code hooks: the per-developer file by default, never the tracked
// one (src/init.js HOOK_SETTINGS). Spelled out rather than imported — this script runs against the
// *installed* package, and must not read the source it is checking.
const LOCAL_SETTINGS = '.claude/settings.local.json';
const SHARED_SETTINGS = '.claude/settings.json';

const FROM_PACKAGE = [
  ['.agents/skills/kanban/SKILL.md', 'skills/kanban/SKILL.md', 'whole'],
  ['.agents/skills/kanban/references/protocol.md', 'skills/kanban/references/protocol.md', 'whole'],
  ['.claude/commands/kanban/specify.md', 'commands/specify.md', 'whole'],
  ['.claude/commands/kanban/decompose.md', 'commands/decompose.md', 'whole'],
  ['CLAUDE.md', 'templates/doc-section.md', 'section'],
  ['AGENTS.md', 'templates/doc-section.md', 'section'],
];

const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const verifyOnly = argv.includes('--verify-only') ? argv[argv.indexOf('--verify-only') + 1] : null;
if (argv.includes('--verify-only') && !verifyOnly) die('--verify-only needs the path of an installed package root');

// The config home every command below runs against — see cleanEnv().
const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-smoke-config-'));

const failures = [];
const log = (msg) => process.stdout.write(`${msg}\n`);
const ok = (msg) => log(`  ok    ${msg}`);
const bad = (msg, fix) => { failures.push({ msg, fix }); log(`  FAIL  ${msg}`); };

function die(msg) {
  process.stderr.write(`smoke-pack: ${msg}\n`);
  process.exit(1);
}

/** Run a command, capturing everything. Never throws — the caller decides what a failure means. */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input: '', ...opts });
  if (r.error) return { status: 1, out: String(r.error.message) };
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/** `npm pack` into `dir`, returning the tarball path. */
function pack(dir) {
  log('packing');
  const r = run('npm', ['pack', '--pack-destination', dir, '--loglevel', 'error'], { cwd: REPO });
  if (r.status !== 0) die(`npm pack failed:\n${r.out}`);
  const tgz = fs.readdirSync(dir).filter((f) => f.endsWith('.tgz')).map((f) => path.join(dir, f));
  if (tgz.length !== 1) die(`expected exactly one tarball in ${dir}, found ${tgz.length}`);
  log(`  ${path.basename(tgz[0])} (${(fs.statSync(tgz[0]).size / 1024).toFixed(1)} kB)`);
  return tgz[0];
}

/** Install `tgz` into a fresh package in `dir`. Returns { root, bin } of the installed hkb. */
function install(tgz, dir) {
  log('installing the tarball into an empty directory');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'hkb-smoke', version: '0.0.0', private: true }) + '\n');
  const r = run('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--loglevel', 'error', tgz], { cwd: dir });
  if (r.status !== 0) die(`npm install of the tarball failed:\n${r.out}`);
  const root = path.join(dir, 'node_modules', pkgName);
  if (!fs.existsSync(root)) die(`npm install reported success but ${root} does not exist`);
  return { root, bin: path.join(dir, 'node_modules', '.bin', 'hkb') };
}

/** What the tarball contains, checked against what the code reads. */
function checkContents(root) {
  log(`contents of ${root}`);
  for (const [rel, why] of MUST_SHIP) {
    if (fs.existsSync(path.join(root, rel))) ok(rel);
    else bad(`${rel} is missing${why ? ` — ${why}` : ''}`, `add its top-level directory to "files" in package.json, then re-run: node scripts/smoke-pack.mjs`);
  }
  for (const rel of MUST_NOT_SHIP) {
    if (!fs.existsSync(path.join(root, rel))) ok(`${rel} is not shipped`);
    else bad(`${rel} was shipped and should not be`, 'check that "files" in package.json is still an allowlist of the runtime set');
  }
}

/**
 * KB_TASK in particular would make `hook stop` do real work against a real board. KB_CONFIG_HOME is
 * pointed at a throwaway rather than unset: `hkb init` registers the checkout it sets up in the
 * user-level board list (src/init.js step 7), and the scratch repo below is deleted when this script
 * ends — it has no business on the board list of whoever ran this.
 */
function cleanEnv() {
  const env = { ...process.env };
  for (const k of ['KB_TASK', 'KB_ATTEMPT', 'KB_BOARD', 'KB_PROFILE', 'KB_ROOT']) delete env[k];
  env.KB_CONFIG_HOME = configHome;
  return env;
}

/** The CLI, run from where npm put it — not from this checkout. */
function checkRuns(bin, root, cwd) {
  log(`running ${bin}`);
  const env = cleanEnv();
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

  const version = run(bin, ['version'], { cwd, env });
  if (version.status !== 0) bad(`\`hkb version\` exited ${version.status}: ${version.out}`, 'the installed package cannot start — check that bin/hkb.js and src/ both shipped');
  else if (version.out !== `hkb ${expected}`) bad(`\`hkb version\` printed "${version.out}", expected "hkb ${expected}"`, 'the bin and the package.json in the tarball disagree');
  else ok(`hkb version → ${version.out}`);

  const help = run(bin, ['help'], { cwd, env });
  if (help.status !== 0) bad(`\`hkb help\` exited ${help.status}: ${help.out}`, 'the CLI starts but cannot print its help');
  else if (!help.out.includes('dispatch')) bad('`hkb help` printed something that is not the help text', 'check src/cli.js HELP');
  else ok(`hkb help → ${help.out.split('\n').length} lines`);

  // The Stop hook is installed into other people's harnesses, so it must be inert — exit 0, no output
  // — in any session that is not a worker. A hook that errors here breaks every session it is in.
  const hook = run(bin, ['hook', 'stop'], { cwd, env, input: '' });
  if (hook.status !== 0) bad(`\`hkb hook stop\` with no KB_TASK exited ${hook.status}: ${hook.out}`, 'the Stop hook must be inert outside a worker — see src/hook.js');
  else ok('hkb hook stop (no KB_TASK) → exit 0');
}

/**
 * A stranger's first command, run from the installed package in a repo that is not this one.
 *
 * `npm test` drives `init()` against a temp repo and the fake gh (test/init.test.js) — that is the
 * behaviour net. What only the *tarball* can get wrong is where init copies from: a missing `skills/`
 * or `templates/` entry in `files` leaves the CLI reading a path that is not there, and the first
 * person to find out is the adopter. So run the real command here and compare what it wrote against
 * the packaged originals.
 *
 * `--no-labels` is init's documented offline path (`src/init.js`, step 4): with `--repo owner/name`
 * every remaining step is local, so this needs no network, no `gh`, and no repo that exists — and it
 * asserts on a clean exit rather than on where a failure happened to stop.
 */
function checkInitOffline(bin, root) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-smoke-init-'));
  log(`running hkb init --no-labels in ${repo}`);
  try {
    run('git', ['init', '-q', '-b', 'main'], { cwd: repo }); // repoRoot() falls back to cwd if git is absent
    const r = run(bin, ['init', '--repo', 'acme/smoke', '--no-labels'], { cwd: repo, env: cleanEnv() });
    if (r.status !== 0) {
      bad(`\`hkb init --repo acme/smoke --no-labels\` exited ${r.status}: ${r.out}`, 'the installed package cannot do the local half of init — run `node scripts/smoke-pack.mjs --keep` and try it by hand');
      return;
    }
    if (!r.out.includes('--no-labels')) bad('`hkb init --no-labels` did not say it skipped the labels', 'the offline path must name what it did not do — see src/init.js step 4');

    for (const [rel, source, how] of FROM_PACKAGE) {
      const written = path.join(repo, rel);
      const packaged = path.join(root, source);
      if (!fs.existsSync(packaged)) continue; // checkContents already reported the missing file
      if (!fs.existsSync(written)) { bad(`\`hkb init\` did not write ${rel}`, `it is copied from ${source}; check that file shipped and is readable`); continue; }
      const a = fs.readFileSync(written, 'utf8');
      const b = fs.readFileSync(packaged, 'utf8');
      if (how === 'whole' ? a === b : a.includes(b.trim())) ok(`${rel} came from the packaged ${source}`);
      else bad(`${rel} does not match the packaged ${source}`, 'init copied from somewhere else — check packageSkillDir()/PKG_ROOT in src/init.js');
    }

    // and the rest of the local footprint, so a run that exited 0 having written half of it cannot
    // pass the checks above. Every read is guarded: a missing file is a finding, not a stack trace.
    const text = (rel, why) => {
      try { return fs.readFileSync(path.join(repo, rel), 'utf8'); } catch { bad(`\`hkb init\` did not write ${rel}`, why); return null; }
    };
    const cfg = text('.kanban/board.json', 'see src/init.js step 3');
    const parsed = cfg && JSON.parse(cfg);
    if (parsed && parsed.repo === 'acme/smoke' && Object.keys(parsed.profiles || {}).length) ok(`.kanban/board.json (profiles ${Object.keys(parsed.profiles).join(', ')})`);
    else if (parsed) bad(`.kanban/board.json is not what init should have written: ${cfg.slice(0, 120)}`, 'see src/init.js step 3');
    const ignored = text('.gitignore', 'see ensureGitignore in src/init.js');
    const ignoredLines = (ignored || '').split('\n').map((l) => l.trim());
    if (ignored && ignoredLines.includes('.kanban/dispatch.pid')) ok('.gitignore carries the local-state block');
    else if (ignored) bad('the generated .gitignore is missing .kanban/dispatch.pid', 'see GITIGNORE_LINES in src/init.js');
    // The hooks go in the per-developer file, and whatever command they carry has to be one that
    // outlives this install: an `_npx` path is wrong for a teammate and gone once npm cleans the
    // cache (#85). This is where a tarball run can prove it — the source tests cannot see PKG_ROOT
    // land anywhere but this checkout.
    const raw = text(LOCAL_SETTINGS, 'see installClaudeHooks in src/init.js');
    const events = raw ? Object.keys(JSON.parse(raw).hooks || {}).sort().join(', ') : null;
    if (events === 'PreToolUse, Stop') ok(`${LOCAL_SETTINGS} (${events})`);
    else if (raw !== null) bad(`${LOCAL_SETTINGS} got hooks "${events}", expected "PreToolUse, Stop"`, 'see CLAUDE_HOOKS in src/init.js');
    if (raw !== null && !ignoredLines.includes(LOCAL_SETTINGS)) bad(`${LOCAL_SETTINGS} names this machine and is not in the generated .gitignore`, 'see GITIGNORE_LINES in src/init.js');
    if (fs.existsSync(path.join(repo, SHARED_SETTINGS))) bad(`\`hkb init\` wrote the tracked ${SHARED_SETTINGS}`, 'only --shared-hooks may — see hookPlacement in src/init.js');
    else ok(`${SHARED_SETTINGS} was left for --shared-hooks`);
    const npx = [LOCAL_SETTINGS, SHARED_SETTINGS].filter((rel) => (fs.existsSync(path.join(repo, rel)) ? fs.readFileSync(path.join(repo, rel), 'utf8').includes('_npx') : false));
    if (npx.length) bad(`${npx.join(', ')} names the npx cache, which is not a durable path`, 'see hkbCommandForHook in src/init.js');
    else ok('no settings file names the npx cache');

    // The next command an operator runs after init is `hkb up`, and `--status` is the half of it that
    // is safe to run anywhere: pid files only, no board read, no network, nothing started.
    const status = run(bin, ['up', '--status', '--json'], { cwd: repo, env: cleanEnv() });
    let reported = null;
    if (status.status !== 0) bad(`\`hkb up --status --json\` exited ${status.status}: ${status.out}`, 'see src/up.js — status must work on a board that has never been started');
    else { try { reported = JSON.parse(status.out); } catch { bad(`\`hkb up --status --json\` printed something that is not JSON: ${status.out.slice(0, 120)}`, 'every command returns a stable object under --json'); } }
    if (reported) {
      const shape = Object.entries(reported).map(([k, v]) => `${k}:${v.running}`).join(' ');
      if (shape === 'dispatch:false serve:false') ok(`hkb up --status --json → ${shape}`);
      else bad(`\`hkb up --status --json\` reported "${shape}", expected both processes stopped in a fresh repo`, 'see statusReport in src/up.js');
    }
  } finally {
    if (keep) log(`  kept: ${repo}`);
    else fs.rmSync(repo, { recursive: true, force: true });
  }
}

// ---------- main ----------

let dir = null;
try {
  let root;
  let bin;
  // Whatever the mode, the CLI is run from a directory that is not this checkout — a pass that only
  // holds because the process happened to start in the repo would prove nothing.
  let cwd;
  if (verifyOnly) {
    root = path.resolve(verifyOnly);
    if (!fs.existsSync(path.join(root, 'package.json'))) die(`${root} is not a package root (no package.json)`);
    bin = path.join(root, 'bin', 'hkb.js');
    cwd = os.tmpdir();
    log(`verify-only: ${root}\n`);
  } else {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-smoke-'));
    const tgz = pack(dir);
    ({ root, bin } = install(tgz, dir));
    cwd = dir;
    log('');
  }

  checkContents(root);
  log('');
  checkRuns(bin, root, cwd);
  log('');
  checkInitOffline(bin, root);
  log('');

  if (failures.length) {
    process.stderr.write(`smoke-pack: ${failures.length} check${failures.length === 1 ? '' : 's'} failed\n`);
    for (const f of failures) process.stderr.write(`  - ${f.msg}\n    fix: ${f.fix}\n`);
    process.exit(1);
  }
  log(`smoke-pack: the packed artifact installs, runs, and initialises a repo. ${MUST_SHIP.length + MUST_NOT_SHIP.length} content checks, 3 command checks, ${FROM_PACKAGE.length + 4} init checks.`);
} finally {
  if (!keep) fs.rmSync(configHome, { recursive: true, force: true });
  if (dir && !keep) fs.rmSync(dir, { recursive: true, force: true });
  else if (dir) log(`kept: ${dir}`);
}
