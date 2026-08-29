// `hkb init` — labels, board.json, skill, hook, doc sections. Idempotent; free path by default.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BOARD, DEFAULT_PROFILES, CLAUDE_DENY, detectRepo, saveBoard, loadBoard, boardFile, ensureLocalDirs, repoRoot, hkbOnPath, registerUserBoard, userBoardsFile, mainWorktree } from './board.js';
import { ensureLabels, fetchBoard, addLabels } from './tasks.js';
import { rest } from './gh.js';
import { L, STATUSES, parseSkillVersion, stripFrontmatter, insideRepo, worktreePath } from './model.js';

export const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MARK_START = '<!-- hkb:start -->';
const MARK_END = '<!-- hkb:end -->';

/** The package's own package.json, resolved relative to this file — the same answer from any cwd. */
function packageJson() { return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')); }

/**
 * Single source of truth for the version: the package's own package.json, resolved relative to this
 * file — so it is the same answer from any cwd, with no build step. `hkb version` prints it and the
 * daily registry check compares it (src/doctor.js).
 */
export function packageVersion() { return packageJson().version; }

/**
 * Where this package's entry point sits inside it — `bin/hkb.js`, read out of package.json rather
 * than spelled out, so moving the bin moves every generated command that names it. POSIX-separated:
 * it is only ever appended to a path that goes into a `/bin/sh` command line.
 */
export function packageBinRel() {
  const pkg = packageJson();
  const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin || {})[0];
  return String(bin || 'bin/hkb.js').replace(/^\.?\//, '').replace(/\\/g, '/');
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name), d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// ---------- skill install ----------
// The skill has one source of truth: `skills/kanban` in the package. Other repos get a copy and
// board.json remembers which version, so `hkb doctor` can say when it has fallen behind. The hkb
// repo *is* the package, so a copy there would be a second source of truth — link it instead.

export function agentsSkillDir(root) { return path.join(root, '.agents', 'skills', 'kanban'); }
export function packageSkillDir() { return path.join(PKG_ROOT, 'skills', 'kanban'); }

/** lstat-based existence: unlike fs.existsSync, a dangling symlink counts as present. */
function lexists(p) { try { fs.lstatSync(p); return true; } catch { return false; } }
function isSymlink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

/** `metadata.version` of the skill rooted at `dir`, or null. */
export function readSkillVersion(dir) {
  try { return parseSkillVersion(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')); } catch { return null; }
}

/**
 * True when the repo being initialised is the hkb package itself — a root package.json named "hkb"
 * that actually carries the skill. Some other project may share the name; it must not get a link
 * pointing at nothing.
 */
export function isPackageRepo(root) {
  let name;
  try { name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name; } catch { return false; }
  return name === 'hkb-cli' && fs.existsSync(path.join(root, 'skills', 'kanban', 'SKILL.md'));
}

/**
 * Point `link` at `targetAbs`, relatively, replacing whatever is there — a copy an earlier init left,
 * or a link to somewhere else. Returns 'linked' | 'already-linked', or null when the filesystem
 * refuses symlinks, in which case whatever was installed is still there and the caller falls back to
 * a copy. Staged-then-renamed so an interrupted run never leaves the path missing.
 */
function linkDir(link, targetAbs) {
  const target = path.relative(path.dirname(link), targetAbs);
  if (isSymlink(link) && fs.readlinkSync(link) === target) return 'already-linked';
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const staged = link + '.hkb-new';
  try {
    if (lexists(staged)) fs.rmSync(staged, { recursive: true, force: true });
    fs.symlinkSync(target, staged, 'dir');
  } catch { return null; }
  if (lexists(link)) fs.rmSync(link, { recursive: true, force: true });
  fs.renameSync(staged, link);
  return 'linked';
}

/**
 * Point `.agents/skills/kanban` at the in-repo `skills/kanban`, replacing a copy left by an earlier
 * init. Returns 'linked' | 'already-linked', or null when the filesystem refuses symlinks — in which
 * case whatever was installed is still there, so the caller can fall back to a copy.
 */
export function linkSkill(root) {
  return linkDir(agentsSkillDir(root), path.join(root, 'skills', 'kanban'));
}

/**
 * Copy the packaged skill into `.agents/skills/kanban`, replacing whatever is there — a link, or an
 * older copy whose renamed/removed files would otherwise linger. Returns the installed version.
 */
export function copySkill(root) {
  const dst = agentsSkillDir(root);
  if (lexists(dst)) fs.rmSync(dst, { recursive: true, force: true });
  copyDir(packageSkillDir(), dst);
  return readSkillVersion(dst);
}

// ---------- the planning commands ----------
// `/kanban:specify` and `/kanban:decompose` are what SKILL.md documents by name, so something has to
// register them. The package's `commands/` is the one source: `.claude-plugin/plugin.json` points at
// it, and init copies it into `.claude/commands/kanban/` for the majority who install hkb from npm
// and never add the plugin. Both spellings produce the *same* name — a plugin namespaces its commands
// by plugin name, a project namespaces them by directory — so the skill can document one invocation
// that is true either way. The bodies delegate back to the SKILL.md section, so the procedure itself
// is still written down exactly once (#92).

export function packageCommandsDir() { return path.join(PKG_ROOT, 'commands'); }
export function claudeCommandsDir(root) { return path.join(root, '.claude', 'commands', 'kanban'); }

/** The command files as `[{ rel, contents }]`, rel to a repo root. Reads the package; writes nothing. */
export function commandFiles() {
  const dir = packageCommandsDir();
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { /* not shipped */ }
  return names.map((name) => ({
    rel: path.join('.claude', 'commands', 'kanban', name),
    contents: fs.readFileSync(path.join(dir, name), 'utf8'),
  }));
}

/** `/kanban:specify, /kanban:decompose` — what the commands are actually called, for the log line. */
export function commandNames() {
  return commandFiles().map((f) => `/kanban:${path.basename(f.rel, '.md')}`);
}

/**
 * Install the commands into `.claude/commands/kanban/`. hkb's own repo links instead of copying, for
 * the same reason the skill does: the package *is* the source there, and a copy would be a second one.
 * @returns {{ how: 'linked'|'already-linked'|'copied'|'unchanged', names: string[] }}
 */
export function installCommands(root) {
  const names = commandNames();
  if (isPackageRepo(root)) {
    const how = linkDir(claudeCommandsDir(root), path.join(root, 'commands'));
    if (how) return { how, names };
  }
  const written = writeAll(root, commandFiles());
  return { how: written.length ? 'copied' : 'unchanged', names };
}

function upsertSection(file, section) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = `${MARK_START}\n${section.trim()}\n${MARK_END}`;
  if (text.includes(MARK_START) && text.includes(MARK_END)) {
    text = text.replace(new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`), block);
  } else {
    text = (text.trimEnd() + '\n\n' + block + '\n').replace(/^\n+/, '');
  }
  fs.writeFileSync(file, text);
}

// ---------- the Claude Code hooks ----------
// Two hooks, and the question of which settings file they go in (#85). `.claude/settings.json` is
// tracked and shared, and most commands hkb can write do not mean the same thing in everyone's
// checkout: a bare `hkb` is only on PATH for whoever ran `npm i -g hkb-cli`, and an absolute path
// into this package is wrong for every teammate — under `npx` it is inside the cache, so it stops
// existing for the installer too, the moment that cache is cleaned. A `matcher: "*"` PreToolUse hook
// that cannot resolve fails on *every tool call in every session* in that repo.
// So the default is `.claude/settings.local.json`: per-developer, gitignored, honest about serving
// whoever runs the board rather than the repo. `--shared-hooks` opts into the tracked file, where
// only the portable `hkb hook <verb>` form is ever written and `hkb doctor` is what tells a teammate
// it does not resolve for them.
//
// There is a third case, and it is the one that makes the tracked file honest (#146). When the hkb
// being run lives INSIDE the repo it is setting up, the answer to "where is hkb" is a property of
// the *project*, not of the machine, and Claude Code hands a hook `$CLAUDE_PROJECT_DIR` precisely so
// a project can say so. Two installs land there and the command does not care which: `npm i -D
// hkb-cli`, the version pinned in package.json and the lockfile, at `node_modules/hkb-cli`; and
// hkb's own checkout, where the repo *is* the package. So the rule is not "is it a devDependency"
// but "is it under the root", and the path written is the one measured from there — never one
// composed out of the package's name, which a pnpm store or a nested install would get wrong.
// That command is exact and portable at once, so it goes in the tracked file by default: a
// teammate's `git pull && npm install` is then the whole setup. It guards its own file, because a
// worker's fresh worktree has no `node_modules` until it runs `npm ci` and a hook that is not
// installed yet must be silent, not loud.

/** The two files Claude Code reads hooks from, relative to the repo root. */
export const HOOK_SETTINGS = {
  local: path.join('.claude', 'settings.local.json'),
  shared: path.join('.claude', 'settings.json'),
};

/** How a machine with no `hkb` on PATH and no durable checkout still gets a working hook. */
export const NPX_COMMAND = 'npx -y hkb-cli';

/** The one variable Claude Code guarantees a hook command: this repo, on whatever machine runs it. */
export const PROJECT_DIR = '$CLAUDE_PROJECT_DIR';
const PROJECT_DIR_RE = /\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR/g;
const PROJECT_DIR_HEAD = /^(\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR)[\\/]/;

/**
 * Is this path inside an npx cache? Such a path is not durable — it is wrong for every teammate and
 * gone from this machine as soon as the cache is cleaned — so nothing generated may ever name it.
 */
export function isEphemeralPath(p) { return /(^|[\\/])_npx([\\/]|$)/.test(String(p || '')); }

/**
 * Where the running hkb's entry point sits relative to `root`, when it is inside it — the whole
 * remainder measured, never composed (#146): `bin/hkb.js` for hkb's own checkout,
 * `node_modules/hkb-cli/bin/hkb.js` for a `npm i -D hkb-cli`, and whatever a pnpm store or a nested
 * install actually resolved to. Null when the hkb running this init is somewhere else — a global,
 * an npx cache, another checkout — which is every install shape a project cannot name for itself.
 *
 * Two paths under the root are refused rather than named. An npx cache is never durable wherever it
 * sits. And a `.claude/worktrees/<attempt>` checkout is gitignored and gone with the attempt, so an
 * hkb run out of one must not put that path in a file the whole team reads.
 * POSIX separators on purpose: the result goes into a `/bin/sh` command line, not into `path.join`.
 */
export function projectBinRel(root, { pkgRoot = PKG_ROOT } = {}) {
  const rel = insideRepo(root, pkgRoot);
  if (rel === null || isEphemeralPath(pkgRoot) || rel.startsWith(worktreePath(''))) return null;
  return [rel, packageBinRel()].filter(Boolean).join('/');
}

/**
 * The hook command for an hkb the repo itself carries: name the file once, exit 0 when it is not
 * there, exec it when it is. The guard is not defensive padding — a worker runs in
 * `.claude/worktrees/kb-<n>-<k>`,
 * a fresh checkout whose `node_modules` does not exist until it runs `npm ci`, and `$CLAUDE_PROJECT_DIR`
 * there is the worktree. Both hooks are inert without KB_TASK anyway, so the honest behaviour before
 * the install is silence; by the time the Stop hook has anything to say, `npm ci` has run.
 */
export function guardedHookCommand(rel, verb) {
  return `f="${PROJECT_DIR}/${rel}"; [ -f "$f" ] || exit 0; exec node "$f" hook ${verb}`;
}

/** Substitute `$CLAUDE_PROJECT_DIR` for the repo it stands for, so doctor can look for the file. */
export function resolveHookPath(target, root) {
  return String(target ?? '').replace(PROJECT_DIR_RE, () => String(root ?? ''));
}

/**
 * The command a hook should run.
 * @param verb one of the values in CLAUDE_HOOKS
 * @param shared true when the command goes in a tracked file — then it is the plain binary, because
 *   an absolute path is a lie on any machine but this one
 * @param root the repo root, for a Claude Code hook: only there is `$CLAUDE_PROJECT_DIR` set, so
 *   only there can the repo's own hkb be named — pass nothing for a harness that reads its own hook file
 * @param binRel `projectBinRel`'s answer, when the caller already has it (or a test supplies it)
 */
export function hkbCommandForHook(verb = 'stop', { shared = false, onPath, pkgRoot = PKG_ROOT, root = null, binRel } = {}) {
  const suffix = ` hook ${verb}`;
  // An hkb the repo carries is the one that runs, wherever the command is going: it is the one form
  // that is exact here and correct everywhere else.
  const rel = binRel === undefined ? projectBinRel(root, { pkgRoot }) : binRel;
  if (rel) return guardedHookCommand(rel, verb);
  if (shared) return `hkb${suffix}`;
  if (onPath ?? hkbOnPath()) return `hkb${suffix}`;
  const bin = path.join(pkgRoot, 'bin', 'hkb.js');
  return isEphemeralPath(bin) ? `${NPX_COMMAND}${suffix}` : `node "${bin}"${suffix}`;
}

/**
 * The hooks `hkb init` writes, as `event → hkb hook <verb>`. Both are inert outside a worker
 * session, and they are gated differently on purpose (`src/hook.js`, docs/harnesses.md): `Stop`
 * stands aside unless KB_TASK is set *or* it is sitting in a `kb-<n>-<k>` checkout, which is the
 * only thing a `claude --bg` session can be identified by; `PreToolUse` takes KB_TASK only, because
 * a checkout name says which task a session is and never which profile's allow-list to apply — so
 * it is live on the process-mode profiles (`claude-p`) and stands aside on `claude --bg`. Both go
 * into a `matcher: "*"` entry in a file every other session in the repo reads, so init names both
 * and `hookSummary` says what they do.
 */
export const CLAUDE_HOOKS = { Stop: 'stop', PreToolUse: 'pretool' };
const HOOK_NOTE = 'inert outside a worker session; Stop nudges for the terminal verb, PreToolUse denies (never allows) and takes KB_TASK only, so it is live on claude-p and stands aside on claude --bg';

/**
 * Split a command into its words, honouring the quotes hkb writes around a path and breaking at the
 * `;` that separates one command from the next — a guarded form is three commands on one line.
 */
function tokens(command) {
  return (String(command || '').match(/"[^"]*"|'[^']*'|[^\s;]+/g) || []).map(unquote);
}
/** A word the shell would unquote: the pair has to match, so `f="…"` keeps its own quotes. */
function unquote(word) { return String(word).replace(/^(["'])([\s\S]*)\1$/, '$2'); }

/**
 * What a configured hook command needs before it can run: the file a `node <path>` form names, or the
 * binary the command starts with — plus whether the command checks for that file itself, which is the
 * difference between "broken" and "not installed yet". Pure; `hkb doctor` does the looking.
 *
 * `node` is looked for anywhere in the line rather than only at the front, and `VAR=<path>`
 * assignments are expanded, so a command that names its file once and then tests it (`guardedHookCommand`)
 * is read as needing that file — no shape of hkb's is special-cased here.
 * @returns {{ kind: 'file'|'bin', target: string, guarded: boolean }}
 */
export function hookCommandNeeds(command) {
  const words = tokens(command);
  const vars = {};
  for (const w of words) {
    const assign = /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(w);
    if (assign) vars[assign[1]] = unquote(assign[2]);
  }
  const expand = (s) => String(s).replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => vars[a || b] ?? m);
  // `[ -f "$f" ] || exit 0`: the command answers "is it there" before it runs, so a missing file is
  // a silent no-op rather than an error on every tool call.
  const guarded = /\[\s+-[a-z]\s/.test(String(command || '')) && /\bexit\s+0\b/.test(String(command || ''));
  const at = words.findIndex((w) => path.basename(w).replace(/\.exe$/i, '') === 'node');
  if (at >= 0 && words[at + 1]) return { kind: 'file', target: expand(words[at + 1]), guarded };
  return { kind: 'bin', target: words[0] || '', guarded };
}

/**
 * Does `command` run one of hkb's own hook verbs? Matches every form hkb has ever written — which
 * now includes one where the binary is named inside a `f="…";` assignment rather than as a word, so
 * a `;` closes the name as validly as a space does.
 */
export function isHkbHookCommand(command, verb) {
  const c = String(command || '').trim();
  return /(^|[\s"'/\\])hkb(-cli)?(@\S+?)?(\.js)?["']?([\s;]|$)/.test(c) && new RegExp(`\\bhook\\s+${verb}\\s*$`).test(c);
}

/**
 * A command that means the same thing on every machine: a plain binary, or a file named relative to
 * `$CLAUDE_PROJECT_DIR` — which is this repo wherever it is checked out. Never a path into a checkout.
 */
export function isPortableHookCommand(command) {
  const need = hookCommandNeeds(command);
  if (!need.target || isEphemeralPath(need.target)) return false;
  if (need.kind === 'file') return PROJECT_DIR_HEAD.test(need.target);
  return !path.isAbsolute(need.target);
}

/** Every hkb hook in a parsed settings object, as `{ event, verb, command, portable }`. */
export function hkbHooks(settings) {
  const out = [];
  for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
    for (const group of settings?.hooks?.[event] || []) {
      for (const h of group?.hooks || []) {
        if (!isHkbHookCommand(h?.command, verb)) continue;
        out.push({ event, verb, command: h.command, portable: isPortableHookCommand(h.command) });
      }
    }
  }
  return out;
}

/**
 * Which settings file hkb's hooks belong in, given what each one already holds. Pure: both parsed
 * files come in, so the policy is testable without a repo.
 *
 * A fresh repo gets the local file. Hooks already in the tracked file with a *portable* command mean
 * the same thing on every machine — somebody chose that, so init leaves them there. Hooks in the
 * tracked file naming a path are the bug this exists to fix, and get moved. `--shared-hooks` says
 * "shared" outright. Either way they end up in exactly one file: two copies fire every nudge twice.
 *
 * `portable` is the third case (#146): the command init is about to write is itself portable — the
 * repo's own hkb named through `$CLAUDE_PROJECT_DIR` — so the tracked file is where it belongs and
 * nobody has to ask for it. Any copy in the per-developer file is stale by construction and moves.
 * @param portable true when the command about to be written means the same thing on every machine
 * @returns {{ file: 'local'|'shared', movedFrom: 'local'|'shared'|null }}
 */
export function hookPlacement({ local, shared, wantShared = false, portable = false } = {}) {
  const inLocal = hkbHooks(local), inShared = hkbHooks(shared);
  if (wantShared || portable) return { file: 'shared', movedFrom: inLocal.length ? 'local' : null };
  if (!inLocal.length && inShared.length && inShared.every((h) => h.portable)) return { file: 'shared', movedFrom: null };
  return { file: 'local', movedFrom: inShared.length ? 'shared' : null };
}

/**
 * Remove hkb's own hook entries from a parsed settings object, leaving every other hook — including
 * one the operator added to the same group — exactly as it was. Returns true when it changed.
 */
export function stripHkbHooks(settings) {
  let changed = false;
  for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
    const groups = settings?.hooks?.[event];
    if (!Array.isArray(groups) || !groups.length) continue;
    const kept = [];
    let touched = false;
    for (const g of groups) {
      const hooks = (g?.hooks || []).filter((h) => !isHkbHookCommand(h?.command, verb));
      if (hooks.length === (g?.hooks || []).length) { kept.push(g); continue; }
      touched = true;
      if (hooks.length) kept.push({ ...g, hooks });
    }
    if (!touched) continue;
    changed = true;
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (changed && settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return changed;
}

/** One line naming every hook init wrote and every one it found, and where they live. */
export function hookSummary(added, { file = HOOK_SETTINGS.local, movedFrom = null, repaired = [] } = {}) {
  const all = Object.keys(CLAUDE_HOOKS);
  const names = (xs) => `${xs.join(' and ')} hook${xs.length > 1 ? 's' : ''}`;
  const kept = all.filter((e) => !added.includes(e));
  const what = added.length
    ? `added ${names(added)} to ${file}${kept.length ? `; ${names(kept)} already there` : ''}`
    : `${names(all)} already present in ${file}`;
  const why = movedFrom === HOOK_SETTINGS.shared
    ? ', which is shared and cannot name this machine'
    : ', because this command resolves in every checkout and belongs where everyone reads it';
  const moved = movedFrom ? `; moved out of ${movedFrom}${why}` : '';
  const fixed = repaired.length ? `; rewrote the ${names(repaired)} command, which did not resolve for everyone that file serves` : '';
  return `${what}${moved}${fixed} (${HOOK_NOTE})`;
}

/**
 * Write the hooks in `CLAUDE_HOOKS` into whichever settings file `hookPlacement` picks, leaving
 * everything else in that file alone and removing hkb's hooks from the other one so no nudge fires
 * twice. Returns what it did, or null when the target file could not be parsed — in which case it
 * has already said so through `log`.
 * @returns {{ file, added, repaired, movedFrom, command, binRel }|null} paths relative to `root`
 */
export function installClaudeHooks(root, log, { shared: wantShared = false, binRel = projectBinRel(root) } = {}) {
  const parse = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return { ok: true, settings: {} };
    try { return { ok: true, settings: JSON.parse(fs.readFileSync(abs, 'utf8')) }; }
    catch (e) { return { ok: false, error: e.message, settings: null }; }
  };
  const read = { local: parse(HOOK_SETTINGS.local), shared: parse(HOOK_SETTINGS.shared) };
  const { file, movedFrom } = hookPlacement({ local: read.local.settings, shared: read.shared.settings, wantShared, portable: !!binRel });
  const target = read[file];
  if (!target.ok) { log(`skip hooks: ${HOOK_SETTINGS[file]} is not valid JSON (${target.error})`); return null; }
  const other = read[file === 'local' ? 'shared' : 'local'];
  if (!other.ok) log(`note: ${HOOK_SETTINGS[file === 'local' ? 'shared' : 'local']} is not valid JSON (${other.error}) — if it configures hkb hooks too, every nudge fires twice`);

  const settings = target.settings;
  settings.hooks = settings.hooks || {};
  const added = [], repaired = [];
  let stopCommand = null;
  for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
    const cmd = hkbCommandForHook(verb, { shared: file === 'shared', root, binRel });
    const groups = settings.hooks[event] = settings.hooks[event] || [];
    const mine = groups.flatMap((g) => (g?.hooks || []).filter((h) => isHkbHookCommand(h?.command, verb)));
    if (!mine.length) {
      groups.push({ matcher: '*', hooks: [{ type: 'command', command: cmd, timeout: 30 }] });
      added.push(event);
    } else {
      // A tracked file may hold nothing but a portable command; a local one keeps whatever the
      // operator typed, except an npx-cache path, which stopped being a path when the cache went.
      // On a repo that carries its own hkb there is exactly one right answer — the copy it carries —
      // so anything else there, `hkb` on PATH included, is rewritten to it.
      for (const h of mine) {
        const fine = binRel ? h.command === cmd : (file === 'shared' ? isPortableHookCommand(h.command) : !isEphemeralPath(h.command));
        if (fine) continue;
        h.command = cmd;
        if (!repaired.includes(event)) repaired.push(event);
      }
    }
    if (event === 'Stop') stopCommand = mine.length ? mine[0].command : cmd;
  }
  const write = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), JSON.stringify(value, null, 2) + '\n');
  };
  if (added.length || repaired.length) write(HOOK_SETTINGS[file], settings);
  if (movedFrom && stripHkbHooks(read[movedFrom].settings)) write(HOOK_SETTINGS[movedFrom], read[movedFrom].settings);
  return { file: HOOK_SETTINGS[file], added, repaired, movedFrom: movedFrom ? HOOK_SETTINGS[movedFrom] : null, command: stopCommand, binRel };
}

/**
 * hkb's hooks as they are actually configured, from both settings files — what `hkb doctor` checks.
 * @returns {{ hooks: [{ file, event, verb, command, portable }], unreadable: [{ file, error }] }}
 */
export function findClaudeHooks(root) {
  const hooks = [], unreadable = [];
  for (const rel of [HOOK_SETTINGS.local, HOOK_SETTINGS.shared]) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    let settings;
    try { settings = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { unreadable.push({ file: rel, error: e.message }); continue; }
    for (const h of hkbHooks(settings)) hooks.push({ file: rel, ...h });
  }
  return { hooks, unreadable };
}

// ---------- harness files (`hkb init --harness copilot|codex`) ----------
// Harnesses that cannot read the skill directly need their own agent + hook files. They are
// *generated*, never hand-maintained: the protocol text is spliced out of the packaged SKILL.md so
// it lives in exactly one place, and re-running init overwrites whatever is on disk.

/** Profile a harness brings with it, so `--harness copilot` alone gives a dispatchable board. */
export const HARNESS_PROFILE = { copilot: 'copilot-cli', codex: 'codex' };
export const HARNESSES = Object.keys(HARNESS_PROFILE);

function template(...parts) { return fs.readFileSync(path.join(PKG_ROOT, 'templates', ...parts), 'utf8'); }
/** For a placeholder that sits inside a JSON string literal — the node fallback command has quotes in it. */
function jsonInner(s) { return JSON.stringify(String(s)).slice(1, -1); }
/** For a placeholder inside a TOML basic string — a Windows path is full of backslashes. */
function tomlInner(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

/** The body of the packaged SKILL.md, with its skill-relative links rewritten to repo-relative ones. */
function protocolText() {
  return stripFrontmatter(fs.readFileSync(path.join(packageSkillDir(), 'SKILL.md'), 'utf8'))
    .replace(/`references\/protocol\.md`/g, '`.agents/skills/kanban/references/protocol.md`')
    .trimEnd();
}

// One entry per harness: what it needs on disk, built from `templates/<harness>/`.
const HARNESS_FILES = {
  // Copilot CLI: a custom agent (`copilot --agent kanban-worker`) and an agentStop hook.
  copilot: ({ command }) => [
    { rel: path.join('.github', 'agents', 'kanban-worker.agent.md'), contents: fill(template('copilot', 'kanban-worker.agent.md'), { protocol: protocolText() }) },
    { rel: path.join('.github', 'hooks', 'kanban.json'), contents: fill(template('copilot', 'hooks.json'), { command: jsonInner(command) }) },
  ],
  // Codex CLI: a Stop hook, plus the notes for what only the user can do — the one-time trust and
  // the `~/.codex/config.toml` settings a sandboxed worker needs. No agent file: Codex reads
  // AGENTS.md, which `hkb init` already keeps up to date.
  codex: ({ command, root }) => [
    { rel: path.join('.codex', 'hooks.json'), contents: fill(template('codex', 'hooks.json'), { command: jsonInner(command) }) },
    { rel: path.join('.codex', 'README.md'), contents: fill(template('codex', 'notes.md'), { command, root: tomlInner(root), gitdir: tomlInner(path.join(root, '.git')) }) },
  ],
};

/**
 * The files `hkb init --harness <name>` writes, as `[{ rel, contents }]` — nothing is written here,
 * so tests and `--dry-run` callers can look before anything touches the repo.
 * @param name one of HARNESSES
 * @param command what the generated hook should run (`hkb hook stop`, or the node fallback)
 * @param root absolute path of the repo, for files that must name it (Codex trusts by path)
 */
export function harnessFiles(name, { command = 'hkb hook stop', root = '/path/to/your/repo' } = {}) {
  const build = HARNESS_FILES[name];
  if (!build) {
    const e = new Error(`unknown harness "${name}". Known: ${HARNESSES.join(', ')}`);
    e.exitCode = 2;
    throw e;
  }
  return build({ command, root });
}

// ---------- GitHub Actions (`hkb init --with-actions`) ----------
// Two workflows, generated the same way harness files are: the dispatcher (events, with a 15-minute
// cron as a sweeper) and one worker per attempt (claude-code-action, started by `gh workflow run`).
// Neither contains a secret — only `${{ secrets.* }}` references — and re-running init overwrites
// both, so the templates stay the single source.

export const ACTIONS_PROFILE = 'claude-action';
export const WORKER_WORKFLOW = 'kanban worker (claude)';
const ACTIONS_DIR = path.join('.github', 'workflows');
const NODE_VERSION = '22';

/**
 * How Actions gets `hkb` on PATH. Every repo installs the published package; hkb's own repo installs
 * the checkout it is running, so a change to the CLI is exercised by the workflow that ships it.
 */
export function hkbInstallForActions(root) {
  return isPackageRepo(root) ? 'npm link' : 'npm i -g hkb-cli';
}

/**
 * The two workflow files, as `[{ rel, contents }]`. Pure, like `harnessFiles`.
 * @param board board slug the dispatcher ticks and the worker defaults to
 * @param install shell command that puts `hkb` on PATH in the runner
 * @param profiles profile names the Actions dispatcher may claim — never the laptop-only ones
 * @param timeoutMinutes the worker job's `timeout-minutes`; keep it <= the board's max_runtime
 */
export function actionsFiles({ board = 'default', install = 'npm i -g hkb-cli', profiles = [ACTIONS_PROFILE], timeoutMinutes = 60, maxTurns = 80 } = {}) {
  const vars = {
    board,
    install,
    profiles: profiles.join(','),
    profile: ACTIONS_PROFILE,
    worker_workflow: WORKER_WORKFLOW,
    node_version: NODE_VERSION,
    timeout_minutes: String(timeoutMinutes),
    max_turns: String(maxTurns),
    allowed_tools: (DEFAULT_PROFILES[ACTIONS_PROFILE].allowed_tools || []).join(','),
    // the same deny list the local Claude launches carry, so a runner refuses what a laptop refuses
    disallowed_tools: CLAUDE_DENY.join(','),
  };
  return ['kanban-dispatch.yml', 'kanban-worker-claude.yml'].map((name) => ({
    rel: path.join(ACTIONS_DIR, name),
    contents: fill(template('actions', name), vars),
  }));
}

/** Write the workflows. Returns the relative paths that actually changed. */
export function installActions(root, opts = {}) {
  return writeAll(root, actionsFiles({ install: hkbInstallForActions(root), ...opts }));
}

/**
 * The profiles the Actions dispatcher is allowed to claim — the ones whose launch only *triggers*
 * work somewhere else. Anything a runner cannot start (a local `claude`, `copilot`, `codex`) has to
 * stay off that list, or the tick claims a task and then fails to spawn it.
 */
export function triggerProfiles(cfg) {
  const names = Object.entries(cfg?.profiles || {}).filter(([, p]) => p?.mode === 'trigger').map(([n]) => n);
  return names.length ? names : [ACTIONS_PROFILE];
}

/**
 * What `--profiles` and `--harness` add up to. `--harness copilot` on its own means "set me up for
 * Copilot": it brings its profile with it and replaces the `claude` default rather than adding to
 * it. Naming both keeps both. Pure, so the branching is testable without a repo.
 * @returns {{ harnesses: string[], profiles: string[] }}
 */
export function resolveProfiles(flags = {}) {
  const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
  const harnesses = list(flags.harness);
  for (const h of harnesses) {
    if (HARNESS_PROFILE[h]) continue;
    const e = new Error(`unknown harness "${h}". Known: ${HARNESSES.join(', ')}`);
    e.exitCode = 2;
    throw e;
  }
  const implied = harnesses.map((h) => HARNESS_PROFILE[h]);
  const profiles = flags.profiles ? list(flags.profiles) : (implied.length ? [...implied] : ['claude']);
  for (const p of implied) if (!profiles.includes(p)) profiles.push(p);
  // `--with-actions` *adds*: the point is a board that runs on this machine and keeps going when it
  // closes, so the local profile stays whatever it was.
  if (flags['with-actions'] && !profiles.includes(ACTIONS_PROFILE)) profiles.push(ACTIONS_PROFILE);
  return { harnesses, profiles };
}

/**
 * The `profiles` block a board carries after an init.
 * A FRESH board (`existing` null) gets exactly the resolved list — `--profiles claude` has to be
 * able to *narrow*, not only widen (#72): seeding from all of DEFAULT_PROFILES gave every adopter
 * six profiles, six `kb:agent:*` labels and a doctor that warns forever about harnesses they will
 * never install. Mirrors loadBoard's "keep only what the user declared, each merged over the default
 * of the same name" (board.js).
 * An EXISTING board is only ever added to: a profile the operator wrote by hand, or one an earlier
 * init brought in, stays — re-running init must never silently delete work.
 * @param existing the board's current profiles, or null/undefined on a fresh board
 * @param profiles resolved profile names (`resolveProfiles`)
 * @param onUnknown called with the name of a profile that has no built-in launch template
 */
export function boardProfiles(existing, profiles, onUnknown = () => {}) {
  const out = existing ? { ...existing } : {};
  for (const p of profiles) {
    if (out[p]) continue;
    if (!DEFAULT_PROFILES[p]) onUnknown(p);
    out[p] = DEFAULT_PROFILES[p] ? JSON.parse(JSON.stringify(DEFAULT_PROFILES[p])) : { max_in_progress: 1, launch: null };
  }
  return out;
}

/** Write generated `[{rel, contents}]` under `root`. Returns the relative paths that actually changed. */
function writeAll(root, files) {
  const written = [];
  for (const f of files) {
    const abs = path.join(root, f.rel);
    let current = null;
    try { current = fs.readFileSync(abs, 'utf8'); } catch { /* not there yet */ }
    if (current === f.contents) continue;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.contents);
    written.push(f.rel);
  }
  return written;
}

/** Write a harness's files. Returns the relative paths that actually changed. */
export function installHarness(root, name, { command } = {}) {
  return writeAll(root, harnessFiles(name, { command, root }));
}

// Everything hkb writes under `.kanban/` except `board.json`, which is the one tracked file, plus
// .claude/worktrees/ — worker checkouts, both Claude Code's `--worktree` and the ones the dispatcher
// makes itself for profiles with `workspace: "worktree"` (Copilot CLI) — and .claude/settings.local.json,
// where the hooks go by default: it names this machine's `hkb`, so it must never be committable (#85).
// This repo's own `.gitignore` must be a superset of this list; `test/init.test.js` holds that line,
// so a lesson learned here cannot stay here (`.kanban/dispatch.pid` did, for a while).
export const GITIGNORE_LINES = [
  '.kanban/logs/',
  '.kanban/outbox.jsonl',
  '.kanban/state.json',
  '.kanban/dispatch.pid',
  '.kanban/serve.pid',
  '.kanban/cache.json',
  '.kanban/nudges/',
  '.kanban/sessions/',
  '.claude/worktrees/',
  '.claude/settings.local.json',
];

/** Append whatever `.gitignore` lines are missing. Per-line, so it is idempotent and additive. */
export function ensureGitignore(root) {
  const file = path.join(root, '.gitignore');
  const wanted = GITIGNORE_LINES;
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(text.split('\n').map((l) => l.trim())); // trim: a CRLF file is still idempotent
  const missing = wanted.filter((w) => !have.has(w));
  if (!missing.length) return false;
  text = text.trimEnd() + (text ? '\n' : '') + '# hkb local state\n' + missing.join('\n') + '\n';
  fs.writeFileSync(file, text);
  return true;
}

// ---------- the user-level board list ----------
// `hkb serve` can show several checkouts on one page, and the list of them lives outside every repo,
// in `~/.config/hkb/boards.json`. Until now the only way onto that page was to hand-edit that file —
// a step nobody can guess from inside a repo they have just set up (#98). `hkb init` is the one
// command that knows the answer, so it registers the checkout itself. Two rules make that safe to do
// without asking: it always says so, because the file is outside the repo; and it can never fail the
// init, because the repo is already set up and the list is only a convenience beside it.

/** `/home/you/.config/hkb/boards.json` → `~/.config/hkb/boards.json`: the path as a human writes it. */
function tildePath(p) {
  const home = os.homedir();
  return home && String(p).startsWith(home + path.sep) ? `~${String(p).slice(home.length)}` : String(p);
}

/**
 * Add this checkout to the user-level board list, and say what happened either way.
 *
 * The entry is a bare path, not `path#board`: init has just written the slug into `.kanban/board.json`,
 * and `hkb serve` reads a bare entry's slug from there — so a bare path stays right if the board is
 * renamed later, and, more to the point, it is the spelling the README tells people to write by hand,
 * so registering a checkout somebody already listed adds nothing instead of a second card.
 * @returns {{ file: string, added: boolean }} — the `registered` object of `hkb init --json`
 */
export function registerCheckout(root, log) {
  try {
    const { added, file } = registerUserBoard(root);
    log(added
      ? `registered this checkout in ${tildePath(file)} — \`hkb serve\` will show it`
      : `already listed in ${tildePath(file)} — \`hkb serve\` will show it`);
    return { file, added };
  } catch (e) {
    const file = userBoardsFile();
    log(`could not add this checkout to ${tildePath(file)}: ${e.message}`);
    // The path to type by hand is the one `registerUserBoard` would have written: the main checkout,
    // never the linked worktree an init may have been run from.
    log(`  everything else is set up; fix that file — or add "${mainWorktree(root)}" to its "boards" by hand — and \`hkb serve\` will show this board`);
    return { file, added: false };
  }
}

export async function init(ctx, flags, log) {
  const root = repoRoot();
  const board = flags.board || 'default';
  // `--no-labels` is the offline path (step 4). The other two steps that talk to GitHub cannot be
  // done offline at all, so asking for both is a request that cannot be honoured — say so before
  // anything is written rather than half-doing it.
  for (const f of ['import', 'project']) {
    if (flags['no-labels'] && flags[f]) {
      const e = new Error(`--no-labels is the offline path, and --${f} needs the API. Run \`hkb init --repo owner/name --no-labels\` now, and \`hkb init --${f} ...\` once \`gh\` can reach the repo.`);
      e.exitCode = 2;
      throw e;
    }
  }
  const { harnesses, profiles } = resolveProfiles(flags);
  const existing = loadBoard(root);

  // 1. repo
  const repo = flags.repo ? { nameWithOwner: flags.repo, defaultBranch: 'main' } : detectRepo();
  log(`repo: ${repo.nameWithOwner}`);

  // 2. skill: .agents/skills/kanban (canonical) + .claude/skills/kanban symlink.
  //    In the hkb repo the package *is* the source, so a copy there would be a second source of
  //    truth: link it. Everywhere else, copy and stamp the version so doctor can spot a stale copy.
  const agentsSkill = agentsSkillDir(root);
  const linked = isPackageRepo(root) ? linkSkill(root) : null;
  const skillVersion = linked ? null : copySkill(root);
  log(linked
    ? `linked skill: .agents/skills/kanban → ${fs.readlinkSync(agentsSkill)} (${linked === 'linked' ? 'replaced the copy' : 'unchanged'})`
    : `installed skill: .agents/skills/kanban${skillVersion ? ` v${skillVersion}` : ''}`);
  const claudeSkill = path.join(root, '.claude', 'skills', 'kanban');
  fs.mkdirSync(path.dirname(claudeSkill), { recursive: true });
  if (!lexists(claudeSkill)) {
    try {
      fs.symlinkSync(path.relative(path.dirname(claudeSkill), agentsSkill), claudeSkill, 'dir');
      log('linked .claude/skills/kanban → .agents/skills/kanban');
    } catch {
      copyDir(packageSkillDir(), claudeSkill);
      log('copied .claude/skills/kanban (this filesystem refuses symlinks)');
    }
  }

  // 2b. the two planning commands the skill documents by name. Without these, `/kanban:decompose` is
  //     an unknown command for everyone who installed hkb from npm rather than as a plugin (#92).
  const commands = installCommands(root);
  const named = commands.names.join(', ');
  log(commands.how === 'linked' || commands.how === 'already-linked'
    ? `linked .claude/commands/kanban → ${fs.readlinkSync(claudeCommandsDir(root))} (${named})`
    : `${commands.how === 'copied' ? 'installed' : 'up to date:'} .claude/commands/kanban (${named})`);

  // 3. board.json
  const cfg = existing || JSON.parse(JSON.stringify(DEFAULT_BOARD));
  cfg.repo = repo.nameWithOwner;
  cfg.default_branch = repo.defaultBranch;
  cfg.board = board;
  cfg.skill_version = skillVersion; // null when linked — a link cannot go stale
  cfg.profiles = boardProfiles(existing?.profiles, profiles, (p) => log(`profile "${p}" has no built-in launch template — add one to ${path.relative(root, boardFile(root))}`));
  saveBoard(root, cfg);
  ensureLocalDirs(root);
  log(`${existing ? 'updated' : 'wrote'} .kanban/board.json (board "${board}", profiles ${Object.keys(cfg.profiles).join(', ')})`);
  ctx.cfg = cfg; ctx.repo = { owner: repo.nameWithOwner.split('/')[0], repo: repo.nameWithOwner.split('/')[1], nameWithOwner: repo.nameWithOwner }; ctx.board = board;

  // 3b. optional Projects v2 mirror (opt-in, one-way). Everything above is already saved, so a
  //     failure here — usually a token without the `project` scope — costs only the mirror.
  if (flags.project) {
    const { linkProject } = await import('./projects.js');
    cfg.project = await linkProject(ctx, flags.project, log);
    saveBoard(root, cfg);
  }

  // 4. labels — with `--repo`, the only step here that needs the network. `--no-labels` skips it, so
  //    `hkb init --repo owner/name --no-labels` sets a repo up with `gh` logged out or absent: every
  //    local file is written and nothing is sent. That is the offline path `scripts/smoke-pack.mjs`
  //    runs to prove the *installed tarball* still ships the skill and the templates it copies from.
  const labels = [...STATUSES.map(L.status), L.board(board), L.needsHuman, ...Object.keys(cfg.profiles).map(L.agent)];
  if (flags['no-labels']) {
    log(`skipped the ${labels.length} kb:* labels (--no-labels) — nothing was sent to ${repo.nameWithOwner}`);
  } else {
    const created = await ensureLabels(ctx, labels);
    log(created.length ? `created labels: ${created.join(', ')}` : 'labels already present');
  }

  // 5. Claude hooks + harness files + gitignore + doc sections
  if (flags['no-hook']) log(`skipped the ${Object.keys(CLAUDE_HOOKS).join(' and ')} hooks (--no-hook)`);
  else {
    const hooks = installClaudeHooks(root, log, { shared: !!flags['shared-hooks'] });
    if (hooks) {
      log(hookSummary(hooks.added, hooks));
      if (hooks.binRel) {
        // Two ways to carry your own hkb, and a teammate's setup differs by one command: a
        // devDependency needs `npm install` to put the file there, a checkout of hkb already has it.
        const installed = hooks.binRel.startsWith('node_modules/');
        log(`  the command runs this repo's own ${hooks.binRel} through $CLAUDE_PROJECT_DIR — the same file in every checkout${installed ? ' that has run `npm install`' : ''}, and a silent exit 0 before it. That is why it went in the tracked file: commit it, and a teammate's \`git pull${installed ? ' && npm install' : ''}\` is the whole setup`);
      } else if (hooks.added.length && hooks.file === HOOK_SETTINGS.local) {
        log(`  that file is per-developer and gitignored; \`hkb init --shared-hooks\` writes ${HOOK_SETTINGS.shared} instead — tracked, so the command there is a plain \`hkb\` every teammate has to have on PATH`);
      }
      if (hooks.command?.startsWith(NPX_COMMAND)) {
        log(`  the hook runs \`${NPX_COMMAND}\`: hkb is not on PATH and this package is in the npx cache, which is not a durable path. \`npm i -g hkb-cli\` and re-run init for a faster one`);
      }
    }
  }
  for (const h of harnesses) {
    const written = installHarness(root, h, { command: hkbCommandForHook() });
    log(written.length ? `harness ${h}: wrote ${written.join(', ')}` : `harness ${h}: files already up to date`);
  }
  // 5a. optional GitHub Actions dispatcher + worker. The files are all init writes; the two secrets
  //     and the push to the default branch are the user's, and Actions runs nothing until both.
  if (flags['with-actions']) {
    const written = installActions(root, { board, profiles: triggerProfiles(cfg), timeoutMinutes: Math.round((cfg.dispatch?.max_runtime_default || 3600) / 60) });
    log(written.length ? `actions: wrote ${written.join(', ')}` : 'actions: workflows already up to date');
    log('  then, once — no secret of yours is ever written into a template:');
    log('    gh secret set KB_TOKEN                   # fine-grained PAT, this repo: Issues, Contents, Pull requests, Actions RW');
    log('    claude setup-token && gh secret set CLAUDE_CODE_OAUTH_TOKEN    # or: gh secret set ANTHROPIC_API_KEY');
    log('  and commit both workflows to the default branch — Actions only ever runs the copy that is there.');
  }
  // 5b. optional MCP server config. Only .mcp.json is ours to write — Claude Code and Copilot CLI
  //     read it verbatim; Codex's is user-level and VS Code's belongs to the editor, so those are printed.
  if (flags.mcp) {
    const { installMcp } = await import('./mcp.js');
    const m = installMcp(root);
    log(m.changed ? `wrote .mcp.json (servers: ${m.servers.join(', ')})` : '.mcp.json already has the kanban server');
    for (const s of m.snippets) {
      log('');
      log(`${s.file} — not written for you (${s.note}); paste:`);
      for (const line of s.text.split('\n')) log(`    ${line}`);
    }
  }
  if (ensureGitignore(root)) log('updated .gitignore');
  const section = fs.readFileSync(path.join(PKG_ROOT, 'templates', 'doc-section.md'), 'utf8');
  for (const f of ['CLAUDE.md', 'AGENTS.md']) { upsertSection(path.join(root, f), section); }
  log('upserted hkb section in CLAUDE.md and AGENTS.md');

  // 6. optional import of existing open issues into triage
  if (flags.import) {
    const all = await rest('GET', `repos/${repo.nameWithOwner}/issues?state=open&per_page=100`);
    const onBoard = new Set((await fetchBoard(ctx)).map((t) => t.number));
    let n = 0;
    for (const issue of all || []) {
      if (issue.pull_request || onBoard.has(issue.number)) continue;
      await addLabels(ctx, { number: issue.number, labels: (issue.labels || []).map((l) => l.name) }, [L.board(board), L.status('triage')]);
      n++;
    }
    log(`imported ${n} open issue(s) into triage on board "${board}"`);
  }

  // 7. the cross-repo board list. A local write, so the offline path (`--no-labels`) does it too.
  const registered = registerCheckout(root, log);

  log('');
  log(flags['no-labels']
    ? 'next: `hkb init` again without --no-labels — the labels are all that is left, and everything else here is idempotent'
    : 'next: `hkb doctor` then `hkb dispatch --loop 60` (or `hkb create "title" --agent claude` to add a task)');
  // init's log is the human output and goes to stderr, so `--json` has stdout to itself: what was set
  // up, and the one thing init wrote outside the repo.
  if (ctx.json) process.stdout.write(JSON.stringify({ repo: repo.nameWithOwner, board, root, registered }, null, 2) + '\n');
  return 0;
}
