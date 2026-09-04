// `hkb init` — labels, board.json, skill, hook, doc sections. Idempotent; free path by default.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_BOARD, DEFAULT_PROFILES, HOOK_SETTINGS_VAR, staleHookLaunches, detectRepo, saveBoard, loadBoard, boardFile, ensureLocalDirs, repoRoot, hkbOnPath, registerUserBoard, userBoardsFile, mainWorktree, runGit } from './board.js';
// `openStore` and not a driver: `hkb init` writes labels and imports issues through the same seam
// every verb uses, so the board it has just created decides what those steps mean.
import { openStore, storeKind } from './store/index.js';
import { L, STATUSES, parseSkillVersion, stripFrontmatter, insideRepo, worktreePath, hookEntry, hookSettings, mcpSplitApprovals, toolPosture } from './model.js';

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

// ---------- the slash commands ----------
// `/kanban:specify`, `/kanban:decompose` and `/kanban:operate` are what SKILL.md documents by name, so
// something has to register them. The package's `commands/` is the one source: `.claude-plugin/plugin.json`
// points at it, and init copies it into `.claude/commands/kanban/` for the majority who install hkb from npm
// and never add the plugin. Both spellings produce the *same* name — a plugin namespaces its commands
// by plugin name, a project namespaces them by directory — so the skill can document one invocation
// that is true either way. The bodies delegate back to the SKILL.md section, so the procedure itself
// is still written down exactly once (#92). Nothing here enumerates them: the directory is the list,
// so a fourth command is a file, and `hkb init` installs it with the others (#149).

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

/** `/kanban:decompose, /kanban:operate, /kanban:specify` — what they are called, for the log line. */
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
// All three hooks serve exactly one kind of session — the worker hkb launched — so that is the only
// session that gets them: they ride the `claude` launch line as `--settings '{"hooks":…}'`, built by
// `workerHookSettings` below and spent by `expandLaunch` (src/dispatch.js). `hkb init` writes them
// into a settings file only when asked (`--shared-hooks`), and clears out anything an older init
// left in the per-developer one.
//
// That is the whole of #144, and it is a retraction. A settings file is read by *every* session in
// the repo, and all three hooks are `matcher: "*"`, so an `hkb` that stops resolving there — an nvm
// switch, a cleaned npx cache, a teammate who never installed it — becomes a failed `PreToolUse` on
// every tool call in sessions that have nothing to do with the board. Observed on a real board;
// #85 moved the file and taught `doctor` to see it, but only a per-launch source removes the
// exposure. The launch also gets the machine-specific command for free: it never leaves this
// machine, so `node "<abs path>"` is *correct* there — precisely the case #85 had to rule out for a
// file other people read.
//
// What a settings file is still for, and why the command shapes below all survive:
//
//   `--shared-hooks`      a team that wants the hooks in every session in the repo says so outright,
//                         and the tracked file gets the portable `hkb hook <verb>` — never a path.
//   an hkb inside the repo  when the hkb being run lives UNDER the repo it is setting up (#146 — a
//                         `npm i -D hkb-cli` devDependency, or hkb's own checkout), where it sits is
//                         a property of the *project*, and `$CLAUDE_PROJECT_DIR` is how a project
//                         says so. That command is exact here and correct in every other checkout at
//                         once, so `--shared-hooks` writes it rather than a bare `hkb`. The path is
//                         measured from the root, never composed from the package's name, which a
//                         pnpm store or a nested install would get wrong; and it guards its own file,
//                         because a worker's fresh worktree has no `node_modules` until `npm ci` and
//                         a hook that is not installed yet must be silent, not loud.
//
// Copilot (`.github/hooks/kanban.json`) and Codex (`.codex/hooks.json`) keep their files: neither
// harness has a per-launch settings source to move them onto (docs/harnesses.md).

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
 * `.claude/worktrees/kb-<n>-<k>`, a fresh checkout whose `node_modules` does not exist until it runs
 * `npm ci`, and `$CLAUDE_PROJECT_DIR` there is the worktree. All three hooks are inert without KB_TASK
 * anyway, so the honest behaviour before the install is silence; by the time the Stop hook has
 * anything to say, `npm ci` has run.
 */
export function guardedHookCommand(rel, verb) {
  return `f="${PROJECT_DIR}/${rel}"; [ -f "$f" ] || exit 0; exec node "$f" hook ${verb}`;
}

/**
 * The hook command for an hkb the repo carries, written into a harness file that has no
 * `$CLAUDE_PROJECT_DIR` of its own — Codex's `-C <worktree>` and Copilot's dispatcher-made checkout
 * are both the hook's cwd, so the plain relative path resolves there without a variable. No
 * `[ -f … ] || exit 0` guard: whether either harness runs `command` through a shell is undocumented,
 * and the guard's `f="…"; …` syntax is only valid there — as a bare argv it would try to exec a
 * program literally named `f="…";`. The one form that is correct either way is the plain one; the
 * cost is a hard failure, rather than a silent exit 0, in the narrow window before a fresh worktree
 * has run `npm ci`.
 */
export function relativeHookCommand(rel, verb) {
  return `node "${rel}" hook ${verb}`;
}

/**
 * Substitute `$CLAUDE_PROJECT_DIR` for the repo it stands for, so doctor can look for the file.
 * The variable's own text is POSIX-separated because it goes into a `/bin/sh` command line; what
 * comes out here is a path this process is about to `stat`, so it is normalised to the platform's
 * separators — on Windows the two halves would otherwise disagree.
 */
export function resolveHookPath(target, root) {
  const s = String(target ?? '');
  if (!/\$\{?CLAUDE_PROJECT_DIR\}?/.test(s)) return s; // a plain binary has nothing to resolve
  return path.normalize(s.replace(PROJECT_DIR_RE, () => String(root ?? '')));
}

/**
 * The command a hook should run.
 * @param verb one of the values in CLAUDE_HOOKS
 * @param shared true when the command goes in a tracked file — then it is the plain binary, because
 *   an absolute path is a lie on any machine but this one
 * @param root the repo root, for a Claude Code hook: only there is `$CLAUDE_PROJECT_DIR` set, so
 *   only there can the repo's own hkb be named — pass nothing for a harness that reads its own hook file
 * @param binRel `projectBinRel`'s answer, when the caller already has it (or a test supplies it)
 * @param cwd true for a harness whose hook already runs from the project root and has no
 *   `$CLAUDE_PROJECT_DIR` to name it by (Codex, Copilot) — the repo's own hkb is then named relative
 *   to that cwd, unguarded (`relativeHookCommand`), rather than through the variable
 */
/**
 * @param {string} [verb]
 * @param {{shared?: boolean, onPath?: boolean, pkgRoot?: string, root?: string|null, binRel?: string|null, cwd?: boolean}} [opts]
 */
export function hkbCommandForHook(verb = 'stop', { shared = false, onPath, pkgRoot = PKG_ROOT, root = null, binRel, cwd = false } = {}) {
  const suffix = ` hook ${verb}`;
  // An hkb the repo carries is the one that runs, wherever the command is going: it is the one form
  // that is exact here and correct everywhere else.
  const rel = binRel === undefined ? projectBinRel(root, { pkgRoot }) : binRel;
  if (rel) return cwd ? relativeHookCommand(rel, verb) : guardedHookCommand(rel, verb);
  if (shared) return `hkb${suffix}`;
  // A launch line names this machine's own hkb whenever that is durable: a bare `hkb` would re-resolve
  // under the session daemon's own PATH, not the dispatcher's (#150) — so PATH agreeing right now is no
  // guarantee it still will when the hook actually fires. Bare `hkb` is left only for the one case that
  // cannot be named absolutely: hkb itself running out of an npx cache.
  const bin = path.join(pkgRoot, 'bin', 'hkb.js');
  if (!isEphemeralPath(bin)) return `node "${bin}"${suffix}`;
  if (onPath ?? hkbOnPath()) return `hkb${suffix}`;
  return `${NPX_COMMAND}${suffix}`;
}

/**
 * The hooks `hkb init` writes, as `event → hkb hook <verb>`. All three are inert outside a worker
 * session, and they are gated differently on purpose (`src/hook.js`, docs/harnesses.md): `Stop`
 * stands aside unless KB_TASK is set *or* it is sitting in a `kb-<n>-<k>` checkout, which is the
 * only thing a `claude --bg` session can be identified by; `PreToolUse` takes KB_TASK only, because
 * a checkout name says which task a session is and never which profile's allow-list to apply — so
 * it is live on the process-mode profiles (`claude-p`) and stands aside on `claude --bg`. `SubagentStop`
 * is gated the same as `Stop` — it records that a subagent `PreToolUse` started has ended, so `Stop`
 * on a track root can tell "waiting on a wave" from "forgot the verb" (#163). All three are `matcher: "*"`
 * entries, and since #144 the only session that gets them is the one hkb launched.
 */
export const CLAUDE_HOOKS = { Stop: 'stop', PreToolUse: 'pretool', SubagentStop: 'subagentstop' };
const HOOK_NOTE = 'inert outside a worker session; Stop nudges for the terminal verb (standing aside while a subagent is still running), PreToolUse denies (never allows) and takes KB_TASK only, so it is live on claude-p and stands aside on claude --bg, and SubagentStop just records that a subagent ended';

/**
 * The `--settings` value every Claude worker launch carries: hkb's hooks, running the hkb that
 * is here. `expandLaunch` (src/dispatch.js) spends it on `{hook_settings}`, and `hkb doctor` asks the
 * same question of the same command, so what it checks is what a worker will actually run.
 *
 * The command may name this machine — `node "/abs/path/bin/hkb.js"` — because a launch line is
 * spent here and nowhere else. `.kanban/board.json` holds the placeholder, never this string, so
 * the tracked board stays true on every machine that reads it.
 *
 * `binRel: null`, deliberately: the `$CLAUDE_PROJECT_DIR` form exists to be right on machines this
 * one has never seen, and a launch never leaves this machine. Here it would only cost — a worker's
 * `$CLAUDE_PROJECT_DIR` is its fresh worktree, which has no `node_modules` until `npm ci`, so the
 * hooks would be silent for exactly the early part of an attempt where a card can be finished
 * without them. The hkb that ran the dispatcher is installed by definition; name that one.
 * @returns the JSON string, or '' when there is no command to run (the launch then drops the flag)
 */
/** @param {{onPath?: boolean}} [opts] */
export function workerHookSettings({ onPath } = {}) {
  const on = onPath ?? hkbOnPath();
  return hookSettings(CLAUDE_HOOKS, (verb) => hkbCommandForHook(verb, { binRel: null, onPath: on }));
}

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

/**
 * One line saying what init did about the hooks: where they run from now, anything it wrote into a
 * settings file, and anything it took back out of one.
 */
export function hookSummary({ file = null, added = [], repaired = [], cleared = [], binRel = null } = {}) {
  const all = Object.keys(CLAUDE_HOOKS);
  const names = (xs) => `${xs.join(' and ')} hook${xs.length > 1 ? 's' : ''}`;
  const kept = all.filter((e) => !added.includes(e));
  const what = file
    ? (added.length
      ? `added ${names(added)} to ${file}${kept.length ? `; ${names(kept)} already there` : ''}`
      : `${names(all)} already present in ${file}`)
    : `${names(all)} ride the worker launch (\`claude --settings\`) — no session but a worker's ever sees them`;
  // The rewrite is not a repair when what was there already resolved for everyone: on a repo that
  // carries its own hkb the plain `node "$CLAUDE_PROJECT_DIR/<bin>"` form is portable and correct,
  // and it is only the missing-file guard that a worker's fresh worktree needs (#146 review).
  const fixed = repaired.length
    ? `; rewrote the ${names(repaired)} command${binRel ? ' to name this repo\'s own hkb, guarded' : ', which did not resolve for everyone that file serves'}`
    : '';
  const gone = cleared.length ? `; removed the ${names(cleared)} hkb left in ${HOOK_SETTINGS.local}, which fired in every session in this repo` : '';
  return `${what}${fixed}${gone} (${HOOK_NOTE})`;
}

/**
 * Put hkb's hooks where they belong, and take them out of where they no longer do.
 *
 * By default that is: nowhere on disk. The launch carries them (`workerHookSettings`), so the only
 * write is a *removal* — hkb's own entries in the gitignored `.claude/settings.local.json`, which an
 * older init put there and which fire in every session in the repo for no one's benefit. They are
 * hkb's own by `isHkbHookCommand`, so nothing a human wrote is touched.
 *
 * `--shared-hooks` is the opt-in for a team that does want them in every session: the tracked
 * `.claude/settings.json` gets the portable form — `hkb hook <verb>`, or the repo's own hkb through
 * `$CLAUDE_PROJECT_DIR` when it carries one (#146). Nothing is ever removed from that file: hooks
 * there were somebody's choice, and `hkb doctor` is what points out that a worker now has two copies.
 *
 * @returns {{ file, added, repaired, cleared, command, binRel }|null} paths relative to `root`;
 *   null when the file it had to write could not be parsed — it has already said so through `log`.
 */
export function installClaudeHooks(root, log, { shared: wantShared = false, binRel = projectBinRel(root) } = {}) {
  const parse = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return { ok: true, exists: false, settings: {} };
    try { return { ok: true, exists: true, settings: JSON.parse(fs.readFileSync(abs, 'utf8')) }; }
    catch (e) { return { ok: false, exists: true, error: e.message, settings: null }; }
  };
  const write = (rel, value) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), JSON.stringify(value, null, 2) + '\n');
  };
  const local = parse(HOOK_SETTINGS.local);

  // 1. the per-developer file: hkb's to clean up, always. It is gitignored, so nobody is reviewing
  //    what is in it, and what an older init left there is the exposure this whole change removes.
  const cleared = [];
  if (!local.ok) log(`note: ${HOOK_SETTINGS.local} is not valid JSON (${local.error}) — if it still configures hkb hooks, they fire in every session in this repo`);
  else if (local.exists) {
    for (const h of hkbHooks(local.settings)) if (!cleared.includes(h.event)) cleared.push(h.event);
    if (stripHkbHooks(local.settings)) write(HOOK_SETTINGS.local, local.settings);
  }
  if (!wantShared) return { file: null, added: [], repaired: [], cleared, command: null, binRel };

  // 2. `--shared-hooks`: the tracked file, and only ever a command that means the same thing in
  //    every checkout — a plain `hkb`, or the repo's own hkb named through $CLAUDE_PROJECT_DIR.
  const target = parse(HOOK_SETTINGS.shared);
  if (!target.ok) { log(`skip hooks: ${HOOK_SETTINGS.shared} is not valid JSON (${target.error})`); return null; }
  const settings = target.settings;
  settings.hooks = settings.hooks || {};
  const added = [], repaired = [];
  let stopCommand = null;
  for (const [event, verb] of Object.entries(CLAUDE_HOOKS)) {
    const cmd = hkbCommandForHook(verb, { shared: true, root, binRel });
    const groups = settings.hooks[event] = settings.hooks[event] || [];
    const mine = groups.flatMap((g) => (g?.hooks || []).filter((h) => isHkbHookCommand(h?.command, verb)));
    if (!mine.length) {
      groups.push(hookEntry(cmd));
      added.push(event);
    } else {
      // On a repo that carries its own hkb there is exactly one right answer — the copy it carries,
      // guarded — so anything else there, `hkb` on PATH included, is rewritten to it. Otherwise the
      // bar is portability: a path into somebody's checkout is a lie in a file everyone reads.
      for (const h of mine) {
        if (binRel ? h.command === cmd : isPortableHookCommand(h.command)) continue;
        h.command = cmd;
        if (!repaired.includes(event)) repaired.push(event);
      }
    }
    if (event === 'Stop') stopCommand = mine.length ? mine[0].command : cmd;
  }
  if (added.length || repaired.length) write(HOOK_SETTINGS.shared, settings);
  return { file: HOOK_SETTINGS.shared, added, repaired, cleared, command: stopCommand, binRel };
}

/**
 * hkb's hooks as they are actually configured, from both settings files — what `hkb doctor` checks.
 * @returns {{ hooks: {file: string, event: any, verb: any, command: any, portable: any}[], unreadable: {file: string, error: any}[] }}
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

// Which file — and which event inside it — carries the hook command, so `hkb doctor` can read back
// exactly what `hkb init --harness <name>` wrote without a second template to parse.
const HARNESS_HOOK_FILE = {
  copilot: { rel: path.join('.github', 'hooks', 'kanban.json'), event: 'agentStop' },
  codex: { rel: path.join('.codex', 'hooks.json'), event: 'Stop' },
};

/** The hook command a harness's own generated file currently holds on disk, or null. */
export function harnessHookCommand(root, name) {
  const spec = HARNESS_HOOK_FILE[name];
  if (!spec) return null;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(root, spec.rel), 'utf8'));
    return settings?.hooks?.[spec.event]?.[0]?.hooks?.[0]?.command || null;
  } catch { return null; }
}

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

/**
 * Flags `hkb init` used to take and no longer does. A removed flag is not a typo — the user is
 * asking for something that was deliberately taken away — so the error says what happened and what
 * replaces it, rather than listing the flags that remain and leaving them to guess (#290).
 *
 * Pure and exported so the message is a test, not a promise. Returns null when nothing is wrong.
 */
export const REMOVED_INIT_FLAGS = ['with-actions', 'actions', 'no-actions'];

export function removedInitFlag(flags = {}) {
  // Every spelling of the Actions flag gets the same answer, and only those spellings: a substring
  // test would claim `--transactions` and any later flag whose name merely contains the word.
  const key = REMOVED_INIT_FLAGS.find((k) => Object.hasOwn(flags, k));
  if (!key) return null;
  return `--${key} is gone: hkb no longer generates a GitHub Actions runner. ADR-006 makes the board's store local and single-host, and a dispatcher inside Actions cannot read it. Run \`hkb up\` on the machine that owns the board — that is what keeps it moving now.`;
}

/**
 * Which store this `init` sets the board up on. Pure, so the answer is a test rather than a
 * paragraph in the README.
 *
 * There is one: local (docs/local-first.md §6.1). The cards live at `refs/kb/boards/<slug>` in this
 * repository and the index beside them, so the board works with `gh` logged out, on a plane, and at
 * no API cost. `--store github` is gone with the driver it named (ADR-006) and says so rather than
 * being ignored: a human who types it is asking for a board this hkb cannot make.
 *
 * **`existing` is not decoration.** A board.json that still says `"store": "github"` has its cards
 * on GitHub Issues, and a plain `hkb init` over it would write `"store": "local"` into a git-tracked
 * file and create an empty board ref — the next `hkb list` reports a board with nothing on
 * it while every real card sits, untouched and unreachable, on the forge. Silent data abandonment,
 * from the command a human runs to *fix* things. So it refuses, and names the migration, which is
 * the same answer `storeKind` gives the verbs. `--import` is that migration and is let through.
 * @param {{store?: any, import?: any}} flags
 * @param {{store?: any}|null} [existing]  the board.json already on disk, if there is one
 * @returns {'local'}
 */
export function resolveStore(flags = {}, existing = null) {
  const asked = flags.store;
  if (!flags.import && existing?.store !== undefined && existing.store !== 'local') {
    // One message for both bad values, and it is `storeKind`'s: what a board is kept in is decided
    // in one place, and doctor, the verbs and init must not each have their own wording for it.
    storeKind({ cfg: existing });
  }
  if (asked === undefined || asked === 'local') return 'local';
  if (asked === 'github') {
    const e = /** @type {any} */ (new Error('--store github is gone: hkb keeps its board on the `kb-board` branch in this repository (ADR-006). `hkb init --import` migrates a board that is still on GitHub Issues onto it.'));
    e.exitCode = 2;
    throw e;
  }
  const e = /** @type {any} */ (new Error(asked === true
    ? '--store needs a value, and the only one is `--store local` (the kb-board branch in this repo).'
    : `--store takes "local" (the kb-board branch in this repo) — got "${asked}".`));
  e.exitCode = 2;
  throw e;
}

/**
 * Does this `init` have to ask the forge whether the board it is about to create already exists
 * there? Pure, so the four conditions are a test rather than a paragraph.
 *
 * `resolveStore` answers for a board.json that *declares* `"store": "github"`. This is the other
 * shape, and the one that actually exists in the wild: a board.json written before the key did,
 * which declares nothing. `storeKind` resolves an absent key to `local`, so nothing refuses, nothing
 * is written into the tracked file (`pinStore` is false), and `setUpLocalBoard` cheerfully creates
 * an empty `kb-board` branch beside a board with hundreds of cards on it. The next `hkb list` prints
 * an empty board and says nothing — the same silent abandonment `resolveStore` exists to prevent,
 * reached by the one path its guard cannot see.
 *
 * So: an *existing* config, no `store` key, no `--import` (that is the migration), and no local
 * branch yet (once the branch is here the board is local and there is nothing left to strand).
 * A repository with no board.json at all is a fresh adoption and is never probed — that is what
 * keeps `hkb init --repo owner/name --no-labels`, the offline path, working on a new repo.
 * @param {{flags?: any, existing?: any, branchExists?: boolean}} [opts]
 */
export function needsMigrationProbe({ flags = {}, existing = null, branchExists = false } = {}) {
  if (!existing) return false;
  if (existing.store !== undefined) return false;
  if (flags.import) return false;
  if (branchExists) return false;
  return true;
}

/** The name `migrationVerdict` says out loud, so its messages never drift from the file init writes. */
const BOARD_FILE_NAME = '.kanban/board.json';

/**
 * What to do with `countBoardIssues`' answer. Pure: `null` means proceed silently, `{refuse}` is an
 * exit-2 message, `{proceed}` is a line to log and carry on.
 *
 * The asymmetry is deliberate. Creating the branch is the **irreversible** half — an empty board
 * over a real one, with no message — so "could not check" refuses too, and says which of the two
 * sentences it is: a board that is known to be on the forge, and a forge that could not be asked.
 * `--force` is the human's "I know": it proceeds, and names what it is walking away from.
 * @param {{label?: string, reachable?: boolean, count?: number, capped?: boolean, why?: string|null}} probe
 * @param {{board?: string, force?: boolean}} [opts]
 * @returns {{refuse: string}|{proceed: string}|null}
 */
export function migrationVerdict(probe, { board = 'default', force = false } = {}) {
  const label = probe?.label || L.board(board || 'default');
  if (probe?.reachable && !probe.count) return null; // no kb cards on the forge: a fresh repository
  const how = force ? '`--force`: creating the local board anyway' : null;
  if (probe?.reachable) {
    const n = probe.capped ? `at least ${probe.count}` : `${probe.count}`;
    const why = `${BOARD_FILE_NAME} names no store, and this repository still has ${n} \`${label}\` issue(s) on GitHub — its board has not been migrated yet.`;
    if (force) return { proceed: `${why} ${how}; those cards stay on GitHub and hkb will not read them again.` };
    return { refuse: `${why} Creating the \`kb-board\` branch here would leave every one of them unreachable. \`hkb init --import\` moves them onto the local board; \`hkb init --force\` creates an empty one anyway and abandons them.` };
  }
  const why = `${BOARD_FILE_NAME} names no store, so this board may still be on GitHub Issues — and the forge could not be reached to check (${probe?.why || 'unknown error'}).`;
  if (force) return { proceed: `${why} ${how}; if there is a \`${label}\` board on GitHub it stays there.` };
  return { refuse: `${why} Creating the \`kb-board\` branch is the irreversible half, so hkb stops rather than guess. Check with \`gh auth status\`, then \`hkb init\` (or \`hkb init --import\`) — or \`hkb init --force\` to make a local board regardless.` };
}

/**
 * Is `.kanban/board.json` a file this repository tracks?
 *
 * It usually is — the board's config is meant to be shared — and that is exactly why the migration
 * asks. Writing `"store": "local"` into a tracked file is a change to *everybody's* checkout: the
 * next `git pull` moves every collaborator onto a store whose branch only one host can write, and
 * whose verbs still drive GitHub until track C. That is a decision, not a side effect of running
 * `hkb init --import`.
 * @param {string} root
 */
export function boardFileTracked(root) {
  const rel = path.relative(root, boardFile(root)).split(path.sep).join('/');
  return runGit(root, ['ls-files', '--error-unmatch', '--', rel]).status === 0;
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
export function boardProfiles(existing, profiles, onUnknown = /** @type {(p: string) => void} */ (() => {})) {
  const out = existing ? { ...existing } : {};
  for (const p of profiles) {
    if (out[p]) continue;
    if (!DEFAULT_PROFILES[p]) onUnknown(p);
    out[p] = DEFAULT_PROFILES[p] ? JSON.parse(JSON.stringify(DEFAULT_PROFILES[p])) : { max_in_progress: 1, launch: null };
  }
  return out;
}

/** Pull `--model <v>` / `--effort <v>` pairs out of a launch array; `rest` is everything else, in order. */
function extractModelEffort(launch) {
  const rest = [];
  let model = null;
  let effort = null;
  for (let i = 0; i < launch.length; i++) {
    if (launch[i] === '--model' && i + 1 < launch.length) { model = launch[++i]; continue; }
    if (launch[i] === '--effort' && i + 1 < launch.length) { effort = launch[++i]; continue; }
    rest.push(launch[i]);
  }
  return { rest, model, effort };
}

/**
 * Repair a claude launch frozen before the hooks moved onto it (#144, `staleHookLaunches`) — what
 * `hkb doctor`'s `launch hooks` fix text says to do, actually done, so an init over a stale board
 * never re-writes the same broken pin in silence. Two shapes, matched to that fix text:
 *  - the pin adds real flags beyond hkb's own default: insert `{hook_settings}` right after the
 *    `--disallowedTools` group (the surgical repair).
 *  - the pin's only difference from the current default is literal `--model`/`--effort` values (the
 *    reason launches used to be pinned at all, #182): drop `launch` back to the default and move
 *    those values into the profile's own `model`/`effort` fields instead.
 * A custom-named profile (no `DEFAULT_PROFILES` entry) always takes the first shape — there is no
 * default behind it to compare against or fall back to.
 * Mutates `cfg.profiles` in place. Logs one line per profile it touches; silent when there is nothing
 * stale (`staleHookLaunches` returns none).
 */
export function repairLaunchHooks(cfg, log) {
  for (const name of staleHookLaunches(cfg)) {
    const p = cfg.profiles[name];
    const base = DEFAULT_PROFILES[name]?.launch;
    const { rest, model, effort } = extractModelEffort(p.launch);
    const baseRest = base?.filter((el) => el !== HOOK_SETTINGS_VAR && el !== '{model_args}');
    if (baseRest && JSON.stringify(rest) === JSON.stringify(baseRest)) {
      delete p.launch;
      const moved = [];
      if (model != null && p.model == null) { p.model = model; moved.push(`--model ${model}`); }
      if (effort != null && p.effort == null) { p.effort = effort; moved.push(`--effort ${effort}`); }
      log(`profile "${name}": the pinned claude launch added nothing but ${moved.join(' and ')} over the default — dropped "launch" and moved that into the profile's fields`);
      continue;
    }
    const idx = p.launch.indexOf('--disallowedTools');
    if (idx === -1) { log(`profile "${name}": its claude launch has no "--disallowedTools" to anchor on — add "${HOOK_SETTINGS_VAR}" to it by hand`); continue; }
    let i = idx + 1;
    while (i < p.launch.length && !String(p.launch[i]).startsWith('--') && !String(p.launch[i]).startsWith('{')) i++;
    p.launch = [...p.launch.slice(0, i), HOOK_SETTINGS_VAR, ...p.launch.slice(i)];
    log(`profile "${name}": inserted "${HOOK_SETTINGS_VAR}" after --disallowedTools in the claude launch`);
  }
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
/**
 * @param {string} root
 * @param {string} name
 * @param {{command?: string}} [opts]
 */
export function installHarness(root, name, { command } = {}) {
  return writeAll(root, harnessFiles(name, { command, root }));
}

// Everything hkb writes under `.kanban/` except `board.json`, which is the one tracked file, plus
// .claude/worktrees/ — worker checkouts, both Claude Code's `--worktree` and the ones the dispatcher
// makes itself for profiles with `workspace: "worktree"` (Copilot CLI) — and .claude/settings.local.json,
// which is per-developer by definition (#85). hkb no longer writes hooks there (#144), and takes out any an
// older init left, but the line stays: everything else in that file is still one machine's, and a repo that
// began before #144 has one to un-commit rather than to start committing.
// This repo's own `.gitignore` must be a superset of this list; `test/init.test.js` holds that line,
// so a lesson learned here cannot stay here (`.kanban/dispatch.pid` did, for a while).
export const GITIGNORE_LINES = [
  '.kanban/logs/',
  '.kanban/outbox.jsonl',
  '.kanban/state.json',
  '.kanban/dispatch.pid',
  '.kanban/serve.pid',
  '.kanban/serve.url',
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

// The one universal conflict a `docs/wiki/` (see docs/wiki/AGENTS.md) makes impossible outright:
// every worker that touches it appends to `log.md`, so two open PRs both touching it never disagree
// about anything but *order* — union is the correct merge, not a conflict to land through a
// continuation attempt (#185). Harmless on a repo with no `docs/wiki/`: a gitattributes pattern for a
// path that does not exist yet costs nothing, and starts working the moment the wiki does.
export const GITATTRIBUTES_LINES = ['docs/wiki/log.md merge=union'];

/** Append whatever `.gitattributes` lines are missing. Per-line, so it is idempotent and additive. */
export function ensureGitAttributes(root) {
  const file = path.join(root, '.gitattributes');
  const wanted = GITATTRIBUTES_LINES;
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const have = new Set(text.split('\n').map((l) => l.trim()));
  const missing = wanted.filter((w) => !have.has(w));
  if (!missing.length) return false;
  text = text.trimEnd() + (text ? '\n' : '') + missing.join('\n') + '\n';
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

/**
 * The probe `needsMigrationProbe` decides on, run and acted upon. Nothing here writes: it is the
 * last thing between a plain `hkb init` and a board ref created over a board that is still on the
 * forge, so it runs before step 2 touches a file.
 *
 * `ctx.repo` is not set until step 3, and this needs it — so the probe gets one built from the repo
 * step 1 just resolved rather than mutating the context out of order.
 *
 * "Is there already a board here" is `findLocalBoardRef`, not a `rev-parse` of `BOARD_REF`: this
 * board may be `--board beta`, whose ref is not the default one, and a board still sitting on
 * `refs/heads/kb-board` is a board — probing the forge and refusing on account of it would tell an
 * operator to migrate cards they migrated already.
 */
async function refuseUnmigratedBoard(ctx, flags, { root, existing, repo, board }, log) {
  const { findLocalBoardRef } = await import('./store/local.js');
  const branchExists = !!findLocalBoardRef({ ...ctx, board, root });
  if (!needsMigrationProbe({ flags, existing, branchExists })) return;
  const [owner, name] = String(repo.nameWithOwner).split('/');
  const { countBoardIssues } = await import('./bridge/github-issues.js');
  const probe = await countBoardIssues({ ...ctx, board, repo: { owner, repo: name, nameWithOwner: repo.nameWithOwner } }, board);
  const verdict = migrationVerdict(probe, { board, force: !!flags.force });
  if (!verdict) return;
  if ('proceed' in verdict) { log(`store: ${verdict.proceed}`); return; }
  const e = /** @type {any} */ (new Error(verdict.refuse));
  e.exitCode = 2;
  throw e;
}

/**
 * Create (or adopt) the local board: the board's ref, the index beside it, and the two things
 * a human has to be told about a board with one writer — that the branch is pushed, and which host
 * owns it.
 *
 * `--import` runs *first* when there is no branch yet, because the migration creates it: importing
 * onto a board that already exists is refused rather than merged (`importGithubBoard`).
 * @returns {Promise<any>} the migration summary, or null when nothing was imported
 */
async function setUpLocalBoard(ctx, flags, log) {
  const { openLocalStore, importGithubBoard, ensureFetchRefspec, boardFetchRefspec } = await import('./store/local.js');
  const store = openLocalStore(ctx, { reconcile: false });
  const existed = !!store.git.tip();
  let migration = null;
  if (flags.import) {
    if (existed) log(`--import skipped: ${store.ref} already exists here, and a second import would overwrite a board that has since been worked. \`git log --oneline ${store.ref}\` shows what is on it`);
    // `--force` carries through: it is the human's "I know, do it anyway" for both refusals this
    // command can raise — a board with a live claim on it, and a host that still looks alive.
    else migration = await importGithubBoard(ctx, { store, log, force: !!flags.force });
  }
  const made = store.git.init(ctx.board, store.host, { settings: {} });
  const loaded = store.open();
  log(made.created
    ? `store: local — created the board at ${store.ref} (host "${store.host}") and ${path.relative(store.root(), store.index.file)}`
    : `store: local — ${store.ref} at ${String(store.git.tip()).slice(0, 7)}, owned by host "${made.board?.host ?? 'nobody'}"${loaded.loaded ? ` (indexed ${loaded.counts?.tasks ?? 0} card(s))` : ''}`);

  // The board is deliberately outside `refs/heads`, so it is not in `git branch` and not in any
  // branch picker — and, for the same reason, not carried by a clone's `+refs/heads/*` refspec. This
  // is the line that buys it back for every ordinary `git fetch` in this checkout. Appended, never
  // replacing (`ensureFetchRefspec`), and repeated `hkb init` runs add nothing.
  const spec = ensureFetchRefspec(store.root(), store.remote);
  if (spec.added) log(`store: added \`${spec.refspec}\` to remote.${store.remote}.fetch, so a plain \`git fetch\` carries the board (it is not on a branch, so nothing else would)`);
  else if (spec.why === 'no-remote') log(`store: no git remote "${store.remote}" here yet — add one and run \`hkb sync\`, which writes \`${boardFetchRefspec(store.remote)}\` into .git/config so a plain \`git fetch\` carries the board`);
  else if (spec.why !== 'present') log(`store: could not write \`${spec.refspec}\` into remote.${store.remote}.fetch (${spec.why}) — add it by hand, or a plain \`git fetch\` will not bring this board back`);

  if (flags['take-over']) {
    const t = store.takeOver({ force: !!flags.force });
    log(t.changed ? `store: this host ("${t.host}") now owns the board — it was "${t.was}"` : `store: this host already owns the board`);
  } else if (!store.owns()) {
    log(`store: host "${store.owner()}" owns this board, so hkb reads it here and refuses to write. \`hkb init --take-over\` moves it to "${store.host}"`);
  }

  // What a local board can and cannot do, said out loud rather than discovered. The verbs now reach
  // board state through `openStore()` (#325), so `hkb create`, `hkb list`, `hkb claim` and the rest
  // read and write the ref — but a *pull request* is still the forge's (docs/local-first.md
  // §6.4), and the two commands that only ever ask the forge say so instead of spending a request.
  log('store: the cards are here — `hkb create`, `hkb list`, `hkb claim` and the rest read and write'
    + ` ${store.ref}, with no GitHub behind them. Pull requests are still the forge's, so`
    + ' `hkb merge` and the PR half of `hkb doctor` need a repo and a logged-in `gh`.');

  log(store.pushDisabled()
    ? `sync: settings.sync.push is false on the board, so \`hkb sync\` never *pushes* ${store.ref} — it still fetches ${store.trackingRef} and fast-forwards onto it, which is how this checkout reads what another host published. Set it to true to back the board up on ${store.remote}`
    : `sync: \`hkb sync\` pushes ${store.ref} to ${store.remote} and fast-forwards from it, and the loop does it after a tick that wrote (at most once a minute, silent offline). \`"sync": {"push": false}\` in the board's board.json turns the push half off`);
  store.close();
  return migration;
}

export async function init(ctx, flags, log) {
  const root = repoRoot();
  const board = flags.board || 'default';
  // Before anything is written: a flag that no longer exists is a request that cannot be honoured,
  // and half an init is worse than none.
  const removed = removedInitFlag(flags);
  if (removed) {
    const e = new Error(removed);
    e.exitCode = 2;
    throw e;
  }
  // `--no-labels` is the offline path (step 4). `--import` reads the GitHub board it is migrating
  // *from*, so it cannot be done offline at all — say so before anything is written rather than
  // half-doing it.
  if (flags['no-labels'] && flags.import) {
    const e = new Error('--no-labels is the offline path, and --import reads the GitHub board it migrates from. Run `hkb init --repo owner/name --no-labels` now, and `hkb init --import` once `gh` can reach the repo.');
    e.exitCode = 2;
    throw e;
  }
  const { harnesses, profiles } = resolveProfiles(flags);
  const existing = loadBoard(root);
  const store = resolveStore(flags, existing);
  // The migration writes `"store": "local"` into a file the repository usually tracks, and that is a
  // change to *everybody's* checkout — one whose branch has a single writing host. Refused before
  // anything is written rather than discovered by a collaborator on their next pull.
  if (flags.import && existing && existing.store !== 'local' && !flags.force && boardFileTracked(root)) {
    const e = /** @type {any} */ (new Error(
      `${path.relative(root, boardFile(root))} is tracked by git, and \`hkb init --import\` would write "store": "local" into it — `
      + 'every collaborator who pulls that would switch to a board on a ref in their own clone, which has one writing host. '
      + 'Migrate deliberately: `hkb init --import --force` writes it.',
    ));
    e.exitCode = 2;
    throw e;
  }

  // 1. repo
  const repo = flags.repo ? { nameWithOwner: flags.repo, defaultBranch: 'main' } : detectRepo();
  log(`repo: ${repo.nameWithOwner}`);

  // 1b. the other unmigrated board: the one that declares nothing. `resolveStore` above refused a
  //     board.json that says `"store": "github"`; a board.json written before that key existed says
  //     nothing at all, resolves to `local`, and would have had an empty `kb-board` branch created
  //     beside every card it still holds on the forge. Ask the forge before creating anything.
  await refuseUnmigratedBoard(ctx, flags, { root, existing, repo, board }, log);

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

  // 2b. every slash command the skill documents by name. Without these, `/kanban:decompose` is
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
  // The store key is written when it is a **decision**, never as a side effect: the human's own
  // `--store`, a fresh board (whose default *is* the decision), a board that already carries the
  // key, and `--import`, which is a human asking for the migration. A plain `hkb init` over an older
  // board writes nothing — putting `"store": "local"` into a git-tracked board.json is the very
  // write `--import` refuses without `--force` three screens above. And a board that carries
  // `"store": "github"` never reaches here at all: `resolveStore` refused it, because rewriting
  // that key is not a pin but an abandonment of every card the old board holds.
  //
  // And it is written **after** the board itself exists, not before: `--import` can still refuse
  // (a card claimed by a running worker, a branch already there), and a board.json that says
  // `local` over a migration that did not happen points every verb at a branch with nothing on it.
  const pinStore = flags.store !== undefined || !existing || existing.store !== undefined || !!flags.import;
  const writeStoreKey = () => {
    if (!pinStore || cfg.store === store) return;
    cfg.store = store; // `openStore` reads this and nothing else decides (docs/local-first.md §6.4)
    saveBoard(root, cfg);
  };
  cfg.profiles = boardProfiles(existing?.profiles, profiles, (p) => log(`profile "${p}" has no built-in launch template — add one to ${path.relative(root, boardFile(root))}`));
  repairLaunchHooks(cfg, log);
  saveBoard(root, cfg);
  ensureLocalDirs(root);
  log(`${existing ? 'updated' : 'wrote'} .kanban/board.json (board "${board}", profiles ${Object.keys(cfg.profiles).join(', ')})`);
  // `loadBoard` dropped any profile this hkb no longer has, so saving the config it returned is the
  // repair — say which, because the operator's cards may still carry that agent label.
  for (const r of existing?.removed_profiles || []) {
    log(`dropped profile "${r.name}" — ${r.why}. Any card still labelled \`kb:agent:${r.name}\` needs \`hkb adopt <n> --agent claude --status <lane>\``);
  }

  // The tool posture (#256). Say it out loud, because defaulting it quietly is the bug this field
  // exists to fix — and read it back off the board rather than assuming, so an `init` over a board
  // that already set "tools": "inherit" is told what it actually has, not what a fresh board gets.
  const inheriting = Object.entries(cfg.profiles).filter(([, p]) => toolPosture(p) === 'inherit').map(([n]) => n);
  log(inheriting.length
    ? `tools: inherit on ${inheriting.join(', ')} (the launching session's own tools), curate elsewhere; drop the key from a profile for curate`
    : 'tools: curate (default) — a worker gets exactly its profile\'s allowed_tools, nothing else; set "tools": "inherit" on a profile in board.json for the opposite');
  ctx.cfg = cfg; ctx.repo = { owner: repo.nameWithOwner.split('/')[0], repo: repo.nameWithOwner.split('/')[1], nameWithOwner: repo.nameWithOwner }; ctx.board = board;

  // 3c. the board itself: a branch in this repository and an index beside it (§6.1). Idempotent —
  //     an existing branch is left exactly as it is, host included; moving that is `--take-over`,
  //     which is a decision and not a side effect of running init again.
  const migration = await setUpLocalBoard(ctx, flags, log);
  writeStoreKey();
  // The tiers memoize the tree per context, and this init has just created the branch under them.
  { const { forgetStore } = await import('./store/index.js'); await forgetStore(ctx); }

  // 4. labels — with `--repo`, the only step here that needs the network. `--no-labels` skips it, so
  //    `hkb init --repo owner/name --no-labels` sets a repo up with `gh` logged out or absent: every
  //    local file is written and nothing is sent. That is the offline path `scripts/smoke-pack.mjs`
  //    runs to prove the *installed tarball* still ships the skill and the templates it copies from.
  const labels = [...STATUSES.map(L.status), L.board(board), L.needsHuman, L.noTrack, ...Object.keys(cfg.profiles).map(L.agent)];
  if (flags['no-labels']) {
    log(`skipped the ${labels.length} kb:* labels (--no-labels) — nothing was sent to ${repo.nameWithOwner}`);
  } else {
    // Through the seam, so a board whose labels are columns is not asked to create any: the local
    // driver answers `[]` and this step costs nothing rather than writing kb:* labels onto a
    // repository the board does not live in.
    const created = await (await openStore(ctx)).ensureLabels(labels);
    // `[]` means "nothing needed creating", and on this store that is because a card's status is a
    // column on the card and there are no labels to create at all — so "labels already present"
    // would be false in both halves on a board that has none and uses none.
    if (created.length) log(`created labels: ${created.join(', ')}`);
    else log('no kb:* labels to create — a card\'s status is a field on the card, not a label on an issue');
  }

  // 5. Claude hooks + harness files + gitignore + doc sections
  if (flags['no-hook']) log(`skipped the ${Object.keys(CLAUDE_HOOKS).join(' and ')} hooks (--no-hook)`);
  else {
    const hooks = installClaudeHooks(root, log, { shared: !!flags['shared-hooks'] });
    if (hooks) {
      log(hookSummary(hooks));
      if (!hooks.file) {
        log(`  nothing was written to ${HOOK_SETTINGS.local} or ${HOOK_SETTINGS.shared}: hkb's hooks only ever serve the worker hkb launched, and a settings file is read by every session in this repo — one that could not find \`hkb\` used to fail a tool call in all of them. \`hkb init --shared-hooks\` still puts them in the tracked file if you want them everywhere`);
      } else if (hooks.binRel) {
        // Two ways to carry your own hkb, and a teammate's setup differs by one command: a
        // devDependency needs `npm install` to put the file there, a checkout of hkb already has it.
        const installed = hooks.binRel.startsWith('node_modules/');
        log(`  the command runs this repo's own ${hooks.binRel} through $CLAUDE_PROJECT_DIR — the same file in every checkout${installed ? ' that has run `npm install`' : ''}, and a silent exit 0 before it. Commit ${HOOK_SETTINGS.shared} and a teammate's \`git pull${installed ? ' && npm install' : ''}\` is the whole setup`);
      } else {
        log(`  ${HOOK_SETTINGS.shared} is tracked, so the command there is a plain \`hkb\` every teammate has to have on PATH. It fires in every session in this repo — that is what --shared-hooks is for — and a worker gets it twice, since the launch carries its own copy`);
      }
      // What the launch will actually run, resolved the way it will be resolved at spawn time. The
      // npx form is the one worth a word: it is correct — the cache path never is — but it re-checks
      // the registry on every hook fire, which is a wait on every stop.
      const launch = hkbCommandForHook('stop', { binRel: null });
      if (launch.startsWith(NPX_COMMAND)) {
        log(`  the launch will run \`${NPX_COMMAND} hook stop\`: hkb is not on PATH and this package is in the npx cache, which is not a durable path. \`npm i -g hkb-cli\` for a faster one`);
      }
      if (hooks.command?.startsWith(NPX_COMMAND)) {
        log(`  the hook in ${hooks.file} runs \`${NPX_COMMAND}\`, which is not a durable path. \`npm i -g hkb-cli\` and re-run init`);
      }
    }
  }
  for (const h of harnesses) {
    // `cwd: true` and `shared: true`: this file is tracked and read from a project root that has no
    // $CLAUDE_PROJECT_DIR of its own, so the command is either this repo's own hkb, relative and
    // unguarded, or the plain `hkb` every teammate has to have on PATH — never a path into this
    // machine's checkout (#166).
    const binRel = projectBinRel(root);
    const written = installHarness(root, h, { command: hkbCommandForHook('stop', { root, cwd: true, shared: true, binRel }) });
    log(written.length ? `harness ${h}: wrote ${written.join(', ')}` : `harness ${h}: files already up to date`);
    if (written.length && binRel) {
      const installed = binRel.startsWith('node_modules/');
      log(`  the command runs this repo's own ${binRel} from the project root the ${h} hook already runs in${installed ? ' — a teammate needs \`npm install\` too' : ''}`);
    }
  }
  // 5a. optional MCP server config. Only .mcp.json is ours to write — Claude Code and Copilot CLI
  //     read it verbatim; Codex's is user-level and VS Code's belongs to the editor, so those are printed.
  if (flags.mcp) {
    const { installMcp, mcpLaunch } = await import('./mcp.js');
    const launch = mcpLaunch({ root });
    const m = installMcp(root, launch);
    log(m.changed ? `wrote .mcp.json (servers: ${m.servers.join(', ')})` : '.mcp.json already has the kanban server');
    if (launch.command === 'node' && !path.isAbsolute(launch.args[0] || '')) {
      const installed = launch.args[0].startsWith('node_modules/');
      log(`  the command runs this repo's own ${launch.args[0]} — resolves on every machine that has this checkout${installed ? ' and has run `npm install`' : ''}, from the project directory Claude Code and VS Code launch MCP servers in`);
    }
    for (const s of m.snippets) {
      log('');
      log(`${s.file} — not written for you (${s.note}); paste:`);
      for (const line of s.text.split('\n')) log(`    ${line}`);
    }
  }
  // 5c. #254: a repo whose `.mcp.json` servers are granted in a profile's allowed_tools but approved
  //     only in the gitignored `.claude/settings.local.json` is a board whose workers will silently
  //     get no MCP — every worktree carries tracked files only, and that approval is not one of them.
  //     Say so now, while a human is here thinking about setup, rather than leaving it to doctor.
  {
    const mcpFile = path.join(root, '.mcp.json');
    if (fs.existsSync(mcpFile)) {
      let doc = null;
      try { doc = JSON.parse(fs.readFileSync(mcpFile, 'utf8')); } catch { /* not this step's failure to report */ }
      const servers = Object.keys(doc?.mcpServers || {});
      const readJson = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch { return null; } };
      const split = servers.length ? mcpSplitApprovals(servers, cfg.profiles, { shared: readJson(HOOK_SETTINGS.shared), local: readJson(HOOK_SETTINGS.local) }) : [];
      for (const { server, line } of split) {
        log(`note: ${server} is defined in .mcp.json and granted in allowed_tools, but ${line} is only in ${HOOK_SETTINGS.local} — a worker's worktree never receives that file, so ${server} will never load there. Move ${line} into ${HOOK_SETTINGS.shared} instead.`);
      }
    }
  }
  if (ensureGitignore(root)) log('updated .gitignore');
  if (ensureGitAttributes(root)) log('updated .gitattributes (docs/wiki/log.md merge=union — the append-only log never conflicts)');
  const section = fs.readFileSync(path.join(PKG_ROOT, 'templates', 'doc-section.md'), 'utf8');
  for (const f of ['CLAUDE.md', 'AGENTS.md']) { upsertSection(path.join(root, f), section); }
  log('upserted hkb section in CLAUDE.md and AGENTS.md');

  // 7. the cross-repo board list. A local write, so the offline path (`--no-labels`) does it too.
  const registered = registerCheckout(root, log);

  log('');
  log(flags['no-labels']
    ? 'next: `hkb init` again without --no-labels — the labels are all that is left, and everything else here is idempotent'
    : 'next: `hkb doctor` then `hkb dispatch --loop 60` (or `hkb create "title" --agent claude` to add a task)');
  // init's log is the human output and goes to stderr, so `--json` has stdout to itself: what was set
  // up, and the one thing init wrote outside the repo.
  if (ctx.json) process.stdout.write(JSON.stringify({ repo: repo.nameWithOwner, board, root, registered, store, imported: migration }, null, 2) + '\n');
  return 0;
}
