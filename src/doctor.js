// `hkb doctor [--api]` — check everything before the first dispatch; never guess.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ghAuthStatus, rest, restRaw, graphql, GhError, API_VERSION } from './gh.js';
import { boardFile, api, readState, writeState, processState, DEFAULT_PROFILES, HOOK_SETTINGS_VAR, staleHookLaunches } from './board.js';
import { detectCaps, branchProtection, fetchBoard, fetchClosedRecent, loadRun, openPrsByHead, issueDatabaseId } from './tasks.js';
import { L, STATUSES, SAFE_BUILTINS, agentsOf, compareVersions, mergePolicy, mergeGate, mergeGateFix, uncoveredBuiltins, kbVarsIn, pathOverlapGuard, unfinishedChildren, branchTaskNumber } from './model.js';
import { resolvedIdentity } from './hook.js';
import { classifyClaimError, casHeartbeat, dropBeatChain, remoteName, listTrackBranches } from './lock.js';
import { agentsSkillDir, packageSkillDir, packageVersion, readSkillVersion, commandFiles, commandNames, harnessFiles, harnessHookCommand, actionsFiles, HARNESS_PROFILE, findClaudeHooks, hookCommandNeeds, hkbCommandForHook, isEphemeralPath, projectBinRel, resolveHookPath, PROJECT_DIR, HOOK_SETTINGS, PKG_ROOT } from './init.js';
import { latestVersion } from './registry.js';
import { checkProject } from './projects.js';
// mcp.js is imported dynamically inside checkMcp, not here: it imports cli.js, which imports this
// file, and a static import here would make that a cycle.

function has(cmd) { return spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0; }
function version(cmd, args = ['--version']) { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null; }

/**
 * `.agents/skills/kanban` is either a link to the in-repo source (hkb's own repo — cannot go stale)
 * or a copy of the packaged skill, which can. board.json remembers what init installed; the copy's
 * own SKILL.md wins when it has a version, because that is what an agent will actually read.
 */
export function checkSkill(ctx, { ok, warn }) {
  const dir = agentsSkillDir(ctx.root);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return warn('skill', 'not installed', 'hkb init');
  let link = null;
  try { if (fs.lstatSync(dir).isSymbolicLink()) link = fs.readlinkSync(dir); } catch { /* treat as a copy */ }
  if (link) return ok('skill', `.agents/skills/kanban → ${link} (linked, always current)`);

  const installed = readSkillVersion(dir) || ctx.cfg?.skill_version || null;
  const packaged = readSkillVersion(packageSkillDir());
  const cmp = compareVersions(installed, packaged);
  if (cmp !== null && cmp < 0) return warn('skill', `.agents/skills/kanban is v${installed}, hkb ships v${packaged}`, 'hkb init');
  if (installed && packaged && cmp === null) return warn('skill', `.agents/skills/kanban v${installed} vs packaged v${packaged} — not comparable`, 'hkb init');
  ok('skill', `.agents/skills/kanban${installed ? ` v${installed}` : ''}`);
}

/**
 * SKILL.md documents `/kanban:specify`, `/kanban:decompose` and `/kanban:operate` by name, so a repo
 * where they are not registered has a skill that instructs an invocation the harness will reject (#92).
 * The set is whatever `commands/` holds — nothing here enumerates it. They come from
 * the plugin, or from `.claude/commands/kanban/` — which is init's job and the only one doctor can
 * check from here, so a miss is a warning naming the command that writes them.
 */
export function checkCommands(ctx, { ok, warn }) {
  const files = commandFiles();
  if (!files.length) return warn('claude commands', 'this hkb has no commands/ directory to install from', 'npm i -g hkb-cli@latest');
  const missing = files.filter((f) => !fs.existsSync(path.join(ctx.root, f.rel)));
  if (missing.length) return warn('claude commands', `${missing.map((f) => `/kanban:${path.basename(f.rel, '.md')}`).join(', ')} not registered — the skill documents them`, 'hkb init');
  ok('claude commands', `.claude/commands/kanban (${commandNames().join(', ')})`);
}

/** What each harness's generated files buy you, for the one-liner doctor prints. */
const HARNESS_NOTE = {
  copilot: 'agentStop nudge',
  codex: 'Stop nudge — needs the one-time trust in .codex/README.md',
};

/**
 * A harness whose profile is configured but whose generated files are missing is a board that
 * dispatches and then enforces nothing. The file list comes from the generator itself, so this can
 * never drift from what `hkb init --harness <name>` writes.
 *
 * When the files are there, the command inside them gets the same resolve check `checkHooks` does for
 * Claude's settings (#166): a `node <rel>` naming a file that is not there — this repo's own hkb has
 * moved, or the devDependency has not been `npm install`ed yet — fails every Stop nudge outright,
 * because unlike Claude's guarded form there is no exit-0 fallback in a file with no shell guaranteed.
 */
export function checkHarnesses(ctx, { ok, warn, bad = warn }, { onPath = has, exists = (p) => fs.existsSync(p) } = {}) {
  for (const [harness, profile] of Object.entries(HARNESS_PROFILE)) {
    if (!ctx.cfg.profiles?.[profile]) continue;
    const files = harnessFiles(harness).map((f) => f.rel);
    const missing = files.filter((f) => !fs.existsSync(path.join(ctx.root, f)));
    if (missing.length) { warn(`${harness} harness`, `missing ${missing.join(', ')}`, `hkb init --harness ${harness}`); continue; }
    ok(`${harness} harness`, `${files.join(' · ')} (${HARNESS_NOTE[harness] || 'stop nudge'})`);

    const command = harnessHookCommand(ctx.root, harness);
    if (!command) continue;
    const need = hookCommandNeeds(command);
    if (need.kind !== 'file') { onPath(need.target) || warn(`${harness} hook command`, `\`${need.target}\` is not on PATH here`, `npm i -g hkb-cli — or npm i -D hkb-cli && hkb init --harness ${harness}, which then names the copy the repo carries (re-running init alone writes a bare hkb again)`); continue; }
    if (isEphemeralPath(need.target)) { bad(`${harness} hook command`, `${command} — the npx cache is not a durable path, so this stops working the moment it is cleaned`, `npm i -g hkb-cli, then hkb init --harness ${harness}`); continue; }
    const target = path.isAbsolute(need.target) ? need.target : path.join(ctx.root, need.target);
    exists(target)
      ? ok(`${harness} hook command`, `${need.target} → ${target}`)
      : bad(`${harness} hook command`, `${need.target} is not there — this repo's hkb has moved, or this checkout has not run \`npm install\` yet`, 'npm install (or hkb init --harness ' + harness + ' if that does not fix it)');
  }
}

/**
 * `.mcp.json`'s `kanban` server, same resolve check as `checkHarnesses`/`checkHooks` (#166): a
 * project-relative `node <rel>` naming a file that is not there, or a bare `hkb` that is not on PATH.
 * Silent when the file does not exist, or does not carry hkb's own server — MCP is opt-in
 * (`hkb init --mcp`), so having neither is not a state to warn about.
 */
export async function checkMcp(ctx, { ok, warn, bad = warn }, { onPath = has, exists = (p) => fs.existsSync(p) } = {}) {
  const { MCP_FILE, MCP_KEY } = await import('./mcp.js');
  const file = path.join(ctx.root, MCP_FILE);
  if (!fs.existsSync(file)) return;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return warn(MCP_FILE, `not valid JSON (${e.message})`, 'hkb init --mcp'); }
  const entry = doc?.mcpServers?.[MCP_KEY];
  if (!entry) return;
  const isNode = path.basename(String(entry.command || '')).replace(/\.exe$/i, '') === 'node';
  const rel = isNode ? entry.args?.[0] : null;
  if (isNode && rel && !path.isAbsolute(rel)) {
    if (isEphemeralPath(rel)) return bad(MCP_FILE, `${rel} — the npx cache is not a durable path, so this stops working the moment it is cleaned`, 'npm i -g hkb-cli, then hkb init --mcp');
    const target = path.join(ctx.root, rel);
    return exists(target)
      ? ok(MCP_FILE, `${MCP_KEY} → node ${rel}`)
      : bad(MCP_FILE, `${rel} is not there — this repo's hkb has moved, or this checkout has not run \`npm install\` yet`, 'npm install');
  }
  if (!isNode && entry.command === 'hkb') {
    return onPath('hkb')
      ? ok(MCP_FILE, `${MCP_KEY} → hkb`)
      : bad(MCP_FILE, '`hkb` is not on PATH here', 'npm i -g hkb-cli — or npm i -D hkb-cli && hkb init --mcp, which then names the copy the repo carries (re-running init alone writes a bare hkb again)');
  }
  // `hkb init --mcp` never writes anything else — a bare `hkb` or a project-relative `node <rel>` are
  // the only shapes it can produce (#166). Whatever else is here was hand-edited, or is left over from
  // an older hkb: nothing further to check without knowing what it is meant to resolve against.
  ok(MCP_FILE, `${MCP_KEY} → ${entry.command}`);
}

/**
 * Everything else here checks whether the board *could* run. This one asks whether it *is*: a
 * perfectly configured board with no dispatcher is the commonest reason nothing is moving, and it
 * used to be the one thing doctor could not tell you. One `ok`/`warn` line off the pid file — no
 * board read, no network, nothing that could make `hkb doctor` slower or more expensive.
 *
 * A warning, never a failure: a board driven by hand, by Actions or by cron is a legitimate board,
 * and `hkb doctor` must not call it broken.
 */
export function checkDispatcher(ctx, { ok, warn }) {
  const st = processState(ctx.root, 'dispatch');
  if (st.running) return ok('dispatcher', `running pid ${st.pid} · log ${st.log}`);
  if (st.stale) return warn('dispatcher', 'no dispatcher running — .kanban/dispatch.pid predates this boot and names nothing of ours', 'hkb up');
  if (st.exit !== null) return warn('dispatcher', `no dispatcher running — the last one exited (${st.exit}) at ${st.exited_at}`, 'hkb up');
  warn('dispatcher', 'no dispatcher running', 'hkb up');
}

/**
 * A `trigger` profile is a launch that only asks Actions to do the work — so the workflow it names
 * has to exist, and it only ever runs from the default branch. Nothing here can check the secrets:
 * `gh secret list` needs admin, and their absence is reported by the workflow itself.
 */
export function checkActions(ctx, { ok, warn }) {
  const triggers = Object.entries(ctx.cfg?.profiles || {}).filter(([, p]) => p?.mode === 'trigger');
  if (!triggers.length) return;
  const files = actionsFiles().map((f) => f.rel);
  const missing = files.filter((f) => !fs.existsSync(path.join(ctx.root, f)));
  if (missing.length) return warn('actions workflows', `missing ${missing.join(', ')}`, 'hkb init --with-actions');
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', ...files], { cwd: ctx.root, encoding: 'utf8' }).status === 0;
  tracked
    ? ok('actions workflows', `${files.join(' · ')} (profiles ${triggers.map(([n]) => n).join(', ')})`)
    : warn('actions workflows', `${files.join(' · ')} are not committed — Actions only runs workflows on the default branch`, 'git add .github/workflows && commit, then push');
}

export const PERMS_CHECK = 'worker permissions';
/**
 * The one generated file that freezes an allow-list, named by the generator so it cannot drift.
 * Rendered on first use, not at import: `actionsFiles()` fills both workflow templates, and every
 * `hkb` invocation — `list`, `show`, a hook firing on every tool call — paid for that.
 */
let workerWorkflowFile = null;
const WORKER_WORKFLOW_FILE = () => (workerWorkflowFile ??= actionsFiles().map((f) => f.rel).find((f) => /worker-claude/.test(f)));

/** The `--allowedTools "…"` list baked into the generated worker workflow; null when it has none. */
export function workflowAllowedTools(contents) {
  const m = /--allowedTools\s+"([^"]*)"/.exec(String(contents || ''));
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : null;
}

const nameSome = (list, n = 4) => list.slice(0, n).join(', ') + (list.length > n ? ` +${list.length - n} more` : '');

/**
 * Two layers decide what a worker may run — hkb's PreToolUse guard and the launch's own
 * `--allowedTools` — and under `--permission-mode dontAsk` the launch DENIES rather than prompts, so
 * the stricter one wins outright. hkb ships a list that covers `SAFE_BUILTINS`; what this catches is
 * a *frozen copy* of an older one, which no default change can reach: a profile that pins
 * `allowed_tools` in board.json, and the `--allowedTools` line `hkb init --with-actions` bakes into
 * the generated worker workflow. Both keep denying `cd`, `export`, `command`, `env` — commands hkb's
 * own policy calls safe — until someone regenerates them (#138).
 *
 * Local files only, so it runs before the first API call. Silent on a board with no allow-list at
 * all (a Codex-only board: its sandbox is the whole policy, so there is nothing to fall behind).
 */
export function checkWorkerPermissions(ctx, { ok, warn }, { read = (p) => fs.readFileSync(p, 'utf8'), exists = (p) => fs.existsSync(p) } = {}) {
  const lists = [];
  const board = path.relative(ctx.root, boardFile(ctx.root));
  for (const [name, p] of Object.entries(ctx.cfg?.profiles || {})) {
    if (!p?.allowed_tools) continue;
    const missing = uncoveredBuiltins(p.allowed_tools);
    lists.push({
      where: `the ${name} profile in ${board}`,
      missing,
      // Only a profile hkb also ships a default for can be fixed by deletion: `loadBoard` deep-merges
      // a board.json profile over `DEFAULT_PROFILES[name]`, so dropping the key there falls back to
      // hkb's list. A custom-named profile has nothing behind it — dropping the key makes
      // `{allowed_tools}` expand to nothing and `--allowedTools` swallow the next flag, so the only
      // fix is to write the missing patterns in.
      fix: DEFAULT_PROFILES[name]
        ? `drop "allowed_tools" from the ${name} profile in ${board} to take hkb's own list`
        : `add ${nameSome(missing.map((c) => `Bash(${c} *)`), 3)} to "allowed_tools" on the ${name} profile in ${board} — it is not one of hkb's own profiles, so there is no default to fall back to`,
    });
  }
  const file = path.join(ctx.root, WORKER_WORKFLOW_FILE());
  if (exists(file)) {
    let baked = null;
    try { baked = workflowAllowedTools(read(file)); } catch { /* unreadable: checkActions owns that */ }
    if (baked) lists.push({ where: `the generated ${WORKER_WORKFLOW_FILE()}`, missing: uncoveredBuiltins(baked), fix: 'hkb init --with-actions' });
  }
  if (!lists.length) return null;
  const stale = lists.filter((l) => l.missing.length);
  // one check name whatever the answer: a `--json` consumer keys on it, and a name that changed
  // between ok and warn meant the warning could only be found by reading the prose
  for (const s of stale) {
    warn(PERMS_CHECK, `${s.where} omits ${nameSome(s.missing)} — hkb's own guard permits them, but a \`dontAsk\` launch denies rather than prompts, so a worker is refused what hkb calls safe`, s.fix);
  }
  if (!stale.length) ok(PERMS_CHECK, `${lists.length} allow-list${lists.length === 1 ? '' : 's'} cover the ${SAFE_BUILTINS.length} shell builtins hkb calls safe`);
  return lists;
}

/** The profiles whose launch line carries hkb's hooks (`--settings`). Pure. */
export function hookLaunchProfiles(cfg) {
  return Object.entries(cfg?.profiles || {}).filter(([, p]) => (p?.launch || []).includes(HOOK_SETTINGS_VAR)).map(([n]) => n);
}

// `staleHookLaunches` moved to board.js (#188): `hkb init` needs the same question to repair what
// doctor only reports. Re-exported here so nothing that already imports it from doctor.js breaks.
export { staleHookLaunches } from './board.js';

export const STALE_HOOK_CHECK = 'hooks in settings';
export const LAUNCH_HOOK_CHECK = 'launch hooks';

/**
 * The Stop/PreToolUse hooks: where a worker gets them, and whether what they run can actually run
 * *here*. Since #144 the answer is the launch line — `claude --settings '{"hooks":…}'`, built by
 * `workerHookSettings` — so that is the command this asks about, and it is asked once for the whole
 * board rather than once per settings file. A command that does not resolve costs a worker its Stop
 * nudge and its session id, so it is a failure with the install in the fix, not a warning. The
 * lookups are arguments so the check is testable without touching PATH.
 *
 * A settings file is still checked when it holds hkb hooks, because two kinds of repo have them:
 * one that asked (`--shared-hooks`), and one an older init left them in. Either way they fire in
 * *every* session in that repo — which is the exposure #144 removed — so the per-developer file,
 * which init now clears out, is reported as something to run init over, and the tracked file as the
 * choice it is, with the duplicate a worker now gets named.
 *
 * Three things follow from a repo that carries its own hkb (#146). `$CLAUDE_PROJECT_DIR` is resolved
 * to the repo before the file is looked for, and reported, so the pass names what it found rather
 * than the variable. A command naming a binary instead of that copy is a failure however well it
 * happens to work on this machine: it is in the file everyone reads, and everyone else has only what
 * their checkout gave them. And a guarded command whose file is missing is normally just an install
 * that has not happened yet — except when the repo's hkb is somewhere else entirely, which is a
 * committed path that has moved (a version-stamped pnpm store, say) and a hook silent forever.
 */
export function checkHooks(ctx, { ok, warn, bad }, { onPath = has, exists = (p) => fs.existsSync(p), binRel = projectBinRel(ctx.root) } = {}) {
  const { hooks, unreadable } = findClaudeHooks(ctx.root);
  for (const u of unreadable) warn('hooks settings', `${u.file} is not valid JSON (${u.error})`, 'fix the JSON, then hkb init');
  // Before anything else, because a board in this state has no hooks at all and the checks below
  // would find nothing to report — which is exactly how it would stay quiet.
  for (const name of staleHookLaunches(ctx.cfg)) {
    warn(LAUNCH_HOOK_CHECK,
      `the ${name} launch in ${path.relative(ctx.root, boardFile(ctx.root))} predates the hooks moving onto it, so its workers get no Stop nudge and record no session id`,
      DEFAULT_PROFILES[name]
        ? `insert "${HOOK_SETTINGS_VAR}" into the ${name} profile's launch, right after its "--disallowedTools" group — or drop "launch" from that profile instead if the pin adds nothing but --model/--effort, which are profile fields now`
        : `add "${HOOK_SETTINGS_VAR}" to that launch — it is not one of hkb's own profiles, so there is no default to fall back to`);
  }
  const launched = hookLaunchProfiles(ctx.cfg);
  // one finding per thing that has to exist, not per hook: both commands normally need the same binary
  const byTarget = new Map();
  const consider = (command, where) => {
    const need = hookCommandNeeds(command);
    const key = `${need.kind}:${need.target}`;
    if (!byTarget.has(key)) byTarget.set(key, { need, commands: new Set(), where: new Set() });
    byTarget.get(key).commands.add(command);
    byTarget.get(key).where.add(where);
  };
  if (launched.length) {
    // the command a worker will really run — `workerHookSettings` builds the launch's copy the same
    // way, `binRel: null` included: a launch names the hkb running here, never a project-relative one
    consider(hkbCommandForHook('stop', { binRel: null, onPath: onPath('hkb') }), `the ${launched.join(', ')} launch`);
    ok('stop hook', `on the ${launched.join(', ')} launch (--settings), so no other session in this repo runs it`);
  } else if (!hooks.some((h) => h.event === 'Stop')) {
    return warn('stop hook', `no launch on this board carries it and it is not in ${HOOK_SETTINGS.local} or ${HOOK_SETTINGS.shared} — workers that exit without a terminal verb are only caught by the dispatcher`, 'hkb init');
  } else {
    ok('stop hook', [...new Set(hooks.map((h) => h.file))].join(' and '));
  }
  // Same question, for `SubagentStop` (#163): without it a track root's Stop hook cannot tell "a
  // wave of subagents is still out" from "forgot the verb", and nudges falsely while one is running.
  if (launched.length) {
    consider(hkbCommandForHook('subagentstop', { binRel: null, onPath: onPath('hkb') }), `the ${launched.join(', ')} launch`);
    ok('subagent-stop hook', `on the ${launched.join(', ')} launch (--settings), so no other session in this repo runs it`);
  } else if (!hooks.some((h) => h.event === 'SubagentStop')) {
    warn('subagent-stop hook',
      `no launch on this board carries it and it is not in ${HOOK_SETTINGS.local} or ${HOOK_SETTINGS.shared} — a track root that fans a wave out to subagents gets nudged for the terminal verb while they are still running`,
      'hkb init');
  } else {
    ok('subagent-stop hook', [...new Set(hooks.filter((h) => h.event === 'SubagentStop').map((h) => h.file))].join(' and '));
  }
  for (const file of [...new Set(hooks.map((h) => h.file))]) {
    warn(STALE_HOOK_CHECK,
      `${file} configures hkb's hooks, so they run in every session in this repo${launched.length ? ' — and a worker runs them twice, once from there and once from its launch' : ''}`,
      file === HOOK_SETTINGS.local
        ? 'hkb init — it removes them from the per-developer file'
        : `delete hkb's hooks from ${file} unless every session in this repo should have them (that is what \`hkb init --shared-hooks\` writes)`);
  }
  for (const h of hooks) consider(h.command, h.file);
  for (const { need, commands, where } of byTarget.values()) {
    const what = [...commands].join(' · ');
    const target = resolveHookPath(need.target, ctx.root);
    // A guarded command is a whole line of shell twice over; what the reader needs from a pass is the
    // file it resolved to, which is exactly what this group is keyed by.
    const found = target === need.target ? what : `${need.target} → ${target}`;
    if (isEphemeralPath(need.target)) {
      bad('hook command', `${what} — the npx cache is not a durable path, so this stops working the moment it is cleaned`, 'npm i -g hkb-cli, then hkb init');
    } else if (binRel && need.kind === 'bin') {
      bad('hook command',
        `${what} in ${[...where].join(' and ')} — this repo carries hkb itself (${binRel}), and \`${need.target}\` is whatever each machine happens to have, or nothing`,
        `hkb init — it rewrites the command as ${PROJECT_DIR}/${binRel}, which every checkout resolves`);
    } else if (need.kind === 'file' ? exists(target) : onPath(need.target)) {
      ok('hook command', found);
    } else if (need.kind === 'file' && need.guarded) {
      // Silent-until-installed is the honest reading only while the command still names where hkb
      // would land. If the repo's own hkb is at a different path, the committed one has gone stale
      // and no amount of installing brings it back — init is what rewrites it.
      const moved = binRel && need.target !== `${PROJECT_DIR}/${binRel}`;
      moved
        ? bad('hook command', `${what} — ${target} is not there, and this repo's hkb is ${binRel}; the hook has been exiting 0 in silence`, `hkb init — it rewrites the command as ${PROJECT_DIR}/${binRel}`)
        : warn('hook command', `${target} is not installed here — the hook exits 0 in silence until it is`, 'npm install');
    } else {
      // Where the failure lands is where the command came from: a settings file reaches every
      // session in the repo, a launch line reaches only the workers hkb starts.
      const inFile = [...where].some((w) => w === HOOK_SETTINGS.local || w === HOOK_SETTINGS.shared);
      bad('hook command',
        `${what} in ${[...where].join(' and ')} — ${need.kind === 'file' ? `${target} is not there` : `\`${need.target}\` is not on PATH here`}; the hook fails on every tool call ${inFile ? 'in every session in this repo' : 'a worker makes'}`,
        need.target === 'hkb' ? 'npm i -g hkb-cli (or: hkb init, which writes a command that resolves here)' : 'hkb init');
    }
  }
}

export const MERGE_CHECK = 'merge policy';

/**
 * `dispatch.merge.mode: "auto"` hands the last step to GitHub's auto-merge — which, on a branch
 * with nothing to wait for, merges the PR the moment it opens. That is not a warning: it is the
 * whole difference between "the operator's rote click, automated" and "agent-authored code on the
 * default branch, unreviewed and untested". So the combination is a hard failure with a named fix,
 * and this check is what makes the feature safe to ship. Silent on a `manual` board — the default
 * changes nothing, so it has nothing to report. `"operator"` is a delegation a human made in
 * conversation, not a default anyone can reach by accident, so it always prints — mode and the
 * condition `hkb merge` enforces — so the delegation is visible to whoever reads `hkb doctor` next,
 * not just to the session that received it (#189).
 */
export async function checkMergePolicy(ctx, { ok, bad }) {
  const policy = mergePolicy(ctx.cfg);
  if (policy.error) return bad(MERGE_CHECK, policy.error, `fix "dispatch": {"merge": {...}} in ${path.relative(ctx.root, boardFile(ctx.root))}`);
  if (policy.mode === 'operator') {
    const conditions = [];
    if (policy.require.review_comment) conditions.push('a review on the card (a named reviewer, or hkb merge --summary naming what was checked)');
    if (policy.require.checks) conditions.push('the PR\'s own checks green');
    const condition = conditions.length ? conditions.join(' and ') : 'nothing — require.checks and require.review_comment are both off';
    return ok(MERGE_CHECK, `operator (${policy.method}) — hkb merge <n> merges once ${condition}; otherwise it hands the PR back, same as manual`);
  }
  if (policy.mode !== 'auto') return null;
  const branch = ctx.cfg.default_branch || 'main';
  let protection, gate;
  try {
    protection = await branchProtection(ctx, branch);
    gate = mergeGate(protection, branch);
  } catch (e) {
    gate = { ok: false, detail: `${branch}'s protection could not be read: ${e.message}`, fix: mergeGateFix(branch) };
  }
  if (!gate.ok) return bad(MERGE_CHECK, `merge.mode is "auto" but ${gate.detail}`, gate.fix);
  // The mode is only worth having if the repository allows auto-merge at all; without it every
  // enable fails, once per card, with GitHub's own wording and nothing to do about it here.
  try {
    const repo = await rest('GET', api(ctx));
    if (repo && repo.allow_auto_merge === false) {
      return bad(MERGE_CHECK, `merge.mode is "auto" but ${ctx.cfg.repo} does not allow auto-merge, so every enable would fail`, 'Settings → General → Pull Requests → Allow auto-merge');
    }
  } catch { /* the gate above is the check that matters; this one is a courtesy */ }
  // Confirmed, not assumed: auto-merge waits for whatever the branch *requires*. A reviewer that
  // `hkb request-review --reviewer <user>` puts on the PR is a request, not a requirement — only
  // required approving reviews hold the merge, so say which of the two this branch has.
  const reviewNote = protection?.requiredReviews > 0
    ? ' — a `request-review --reviewer <user>` is held until they approve'
    : ' — nothing waits for a human: `request-review --reviewer <user>` requests a review, it does not require one';
  return ok(MERGE_CHECK, `auto (${policy.method}) — ${gate.detail}, and GitHub holds the merge until they pass${reviewNote}`);
}

export const PATH_OVERLAP_CHECK = 'path_overlap guard';

/**
 * The effective `path_overlap` mode and why — a board's own answer to "why did #184 wait on #182"
 * before anyone has to read a tick log for it (#185). Never a failure: every mode is a legitimate
 * choice, this just says which one is live and where it came from, and flags an unreadable value.
 */
export function checkPathOverlapGuard(ctx, { ok, bad }) {
  const g = pathOverlapGuard(ctx.cfg);
  if (g.error) return bad(PATH_OVERLAP_CHECK, g.error, `fix "dispatch": {"guards": {"path_overlap": "off"|"running"|"unmerged"}} in ${path.relative(ctx.root, boardFile(ctx.root))}`);
  return ok(PATH_OVERLAP_CHECK, `${g.mode} (${g.source})`);
}

// ---------- the cards themselves ----------

export const AGENT_LABEL_CHECK = 'task agent labels';

/**
 * A card wearing two `kb:agent:*` labels runs as whichever one GitHub lists first, whatever the
 * last `hkb adopt` said it would run as (#113). `adopt` no longer leaves one behind, but the boards
 * piloted before it did still carry them, and the only symptom is the card quietly dispatching on
 * the old profile — a track root that reads `claude-track` on the issue page and is dispatched
 * node-by-node as `claude`. So this names them, with the command that repairs each one.
 *
 * Labels are all it reads, so it asks for the board without the blocker fill-in: one query, no
 * per-task REST even on a repo whose GraphQL has no `blockedBy`. `fetch` is an argument for tests.
 */
export async function checkAgentLabels(ctx, { ok, warn }, { fetch = fetchBoard, board = null } = {}) {
  const b = board || await boardOnce(ctx, fetch);
  if (b.error) return warn(AGENT_LABEL_CHECK, `could not read the board: ${b.error}`);
  const tasks = b.tasks;
  const doubled = tasks.map((t) => ({ number: t.number, agents: agentsOf(t.labels) })).filter((t) => t.agents.length > 1);
  if (!doubled.length) return ok(AGENT_LABEL_CHECK, `${plural(tasks.length, 'open task')}, at most one kb:agent:* each`);
  const detail = doubled.map((t) => `#${t.number} (${t.agents.join(' + ')} → runs as ${t.agents[0]})`).join(' · ');
  const fix = `hkb adopt ${doubled.map((t) => t.number).join(' ')} --agent <the profile it should run on> — adopt sets that one and takes the others off`;
  warn(AGENT_LABEL_CHECK, `${plural(doubled.length, 'task')} on two profiles at once: ${detail}`, fix);
}

export const ORPHANED_PR_CHECK = 'orphaned PRs';

/**
 * "Your board has lost track of work" — the check #234 was written for. An open PR whose head is a
 * branch hkb itself would have created for one of its cards (`taskBranchRe`/`branchTaskNumber`),
 * where the card no longer has any way to see it.
 *
 * `fetchBoard`/`getTask` now apply the same head-branch match as a live fallback for every *open*
 * card (`fillPrFallback`, src/tasks.js), so an orphan on a card still open self-heals the moment
 * anything reads it. What that fallback cannot reach is a card already closed — `fetchBoard`'s
 * default read is open issues only, so a card that went to *done* (or *archived*) with the bug this
 * task fixes never gets revisited, and its PR would sit there, unreferenced, forever. That is exactly
 * #227 and #228: closed as done, work unmerged, nothing left to chase it. One read for every open PR
 * on hkb's own branches, then one issue lookup per match (usually a handful) to see which are closed.
 */
export async function checkOrphanedPrs(ctx, { ok, warn }, { openByHead = openPrsByHead, issue = issueDatabaseId } = {}) {
  const byHead = await openByHead(ctx);
  const candidates = [];
  for (const [head, pr] of byHead) {
    const n = branchTaskNumber(head);
    if (n) candidates.push({ n, pr });
  }
  if (!candidates.length) return ok(ORPHANED_PR_CHECK, 'no open PR sits on a branch hkb would have made for one of its own cards');
  const orphans = [];
  for (const { n, pr } of candidates) {
    let row;
    try { row = await issue(ctx, n); } catch { continue; } // unreadable — not this check's failure to report
    if (String(row.state).toUpperCase() !== 'CLOSED') continue; // open: the live fallback already covers it
    orphans.push({ n, pr: pr.number, reason: row.state_reason || 'closed', url: pr.url });
  }
  if (!orphans.length) return ok(ORPHANED_PR_CHECK, `${plural(candidates.length, 'open PR')} on hkb's own branches, all on cards still open`);
  const detail = orphans.map((o) => `#${o.n} (${o.reason}) ← PR #${o.pr}`).join(' · ');
  warn(ORPHANED_PR_CHECK,
    `${plural(orphans.length, 'card')} closed with an open PR still sitting on its branch, unreferenced: ${detail}`,
    'reopen the card (hkb request-changes "…", or hkb adopt + hkb unblock) so a worker picks the PR back up, or merge the PR by hand and leave the card closed');
  return orphans;
}

export const TRACK_BRANCH_CHECK = 'track branches';

/**
 * A track's own integration branch (`kb/track-<root>` — `trackBranchName`/`ensureTrackBranch`) with
 * no live runner behind it: an orphaned branch is the same class of bug as an orphaned PR — work, or
 * the husk of an abandoned attempt, sitting where nothing on the board can find its way back to it.
 * "Live" means its root's most recent track attempt (the one that created *this* branch — a root can
 * be retried, and a retry after the branch already exists reuses it, `ensureTrackBranch`) has not
 * ended. A root that no longer exists on the board, or whose last such attempt ended (whatever the
 * outcome — the branch survives a `finish` just as much as a `block`, since deleting it is `hkb gc`'s
 * job, not the runner's), is exactly the branch this check is for.
 *
 * One `git/matching-refs` read for every track branch the repo has ever made, then one run-record
 * read per branch — there are rarely more than a handful of tracks alive on a board at once.
 */
export async function checkTrackBranches(ctx, { ok, warn }, { branches = listTrackBranches, run = loadRun } = {}) {
  const rows = await branches(ctx);
  if (!rows.length) return ok(TRACK_BRANCH_CHECK, 'no track branches on the repo');
  const orphans = [];
  for (const { branch, root } of rows) {
    let rec;
    try { rec = await run(ctx, root); } catch (e) { orphans.push({ branch, root, reason: `#${root} could not be read: ${e.message}` }); continue; }
    const attempts = (rec.run?.attempts || []).filter((a) => a.track && a.track_branch === branch);
    const last = attempts[attempts.length - 1];
    if (!last) { orphans.push({ branch, root, reason: 'no track attempt on the board ever recorded this branch' }); continue; }
    if (last.ended_at) orphans.push({ branch, root, reason: `its last track attempt (#${root} attempt ${last.attempt}) ended: ${last.outcome || 'no outcome recorded'}` });
  }
  if (!orphans.length) return ok(TRACK_BRANCH_CHECK, `${plural(rows.length, 'track branch')}, every one with a live attempt`);
  const detail = orphans.map((o) => `${o.branch} (${o.reason})`).join(' · ');
  warn(TRACK_BRANCH_CHECK,
    `${plural(orphans.length, 'track branch')} with no live runner: ${detail}`,
    'merge or discard the work on it, then delete the branch (git push origin --delete <branch>) — hkb gc does this once its root is done or archived');
  return orphans;
}

export const TRACK_PROFILE_CHECK = 'track profile';

/**
 * Can this board run a track at all? A card with unfinished children is a track by default
 * (`isTrackRoot`) — one session orchestrating the whole subgraph — but only if some profile in
 * board.json carries `"track": true`. Without one every decomposed goal falls back to node
 * dispatch: correct, just slower and with the context re-derived between every dependent pair.
 *
 * Configured boards pay nothing: the second board read (this one needs blockers, which the shared
 * one deliberately skips) only happens when there is no track profile to find and the answer might
 * therefore be actionable.
 */
export async function checkTrackProfile(ctx, { ok, warn }, { fetch = fetchBoard } = {}) {
  const tracks = Object.entries(ctx.cfg?.profiles || {}).filter(([, p]) => p?.track).map(([n]) => n);
  if (tracks.length) return ok(TRACK_PROFILE_CHECK, `${tracks.join(', ')} — a card with unfinished children runs as one session`);
  let tasks;
  try { tasks = await fetch(ctx); } catch (e) { return warn(TRACK_PROFILE_CHECK, `no profile runs tracks, and the board would not read: ${e.message}`); }
  const roots = tasks.filter((t) => unfinishedChildren(t).length);
  if (!roots.length) return ok(TRACK_PROFILE_CHECK, 'no profile runs tracks, and nothing on the board has unfinished children');
  warn(TRACK_PROFILE_CHECK,
    `${plural(roots.length, 'card')} with unfinished children (${nameSome(roots.map((t) => `#${t.number}`), 3)}) and no profile with "track": true — every one of them runs node by node`,
    'hkb init --profiles claude-track — it adds the track profile to board.json; nothing else has to change');
}

/**
 * The one board read the card checks share. Returns `{tasks}` or `{error}` so each check reports
 * the failure in its own words rather than one of them swallowing it for the others.
 */
export async function boardOnce(ctx, fetch = fetchBoard) {
  try { return { tasks: await fetch(ctx, { blockers: false }) }; } catch (e) { return { error: e.message }; }
}

export const GROOM_BLOCKERS_CHECK = 'groom blockers';

/**
 * What a groom costs on this repo. `hkb groom` reports on every open card, so it asks
 * `fetchBoard` for `blockers: 'all'` — and where GraphQL has no `Issue.blockedBy` that is one
 * REST call per open card rather than the tick's todo/blocked handful. Nobody should discover
 * that by running it on a board of two hundred; the price is named here, next to the capability.
 */
export function checkGroomBlockers(ctx, { ok, warn }, { caps, board = null } = {}) {
  if (caps?.blockedByGql) return ok(GROOM_BLOCKERS_CHECK, 'blockers ride the board query — hkb groom costs no extra request');
  const open = board && !board.error ? board.tasks.length : null;
  const cost = open === null ? 'one REST call per open card' : `${plural(open, 'REST call')} — one per open card`;
  warn(GROOM_BLOCKERS_CHECK, `no GraphQL Issue.blockedBy, so hkb groom fills blockers itself: ${cost}`,
    'nothing to fix — expect the run to be slower than a tick on a large board');
}

export const TASK_SKILLS_CHECK = 'task skills';

/**
 * A card's `kb.skills` (src/context.js) tells its worker to invoke the `Skill` tool — but only a
 * Claude Code launch has that tool, and it only runs rather than being denied under `dontAsk` when
 * the profile's `allowed_tools` names it (#114). hkb's own default profiles carry `Skill` now
 * (`CLAUDE_TOOLS`, src/board.js), so this catches what the default cannot reach: a profile pinned
 * in board.json before the fix, or a custom-named one that never had it — on a card that actually
 * sets the field, so a board that never uses `kb.skills` has nothing to warn about.
 *
 * Non-Claude launches (Codex, Copilot) are skipped: `Skill` names a Claude Code tool, and their own
 * `allowed_tools` lists mean something else entirely.
 */
export async function checkTaskSkills(ctx, { ok, warn }, { fetch = fetchBoard, board = null } = {}) {
  const b = board || await boardOnce(ctx, fetch);
  if (b.error) return warn(TASK_SKILLS_CHECK, `could not read the board: ${b.error}`);
  const withSkills = b.tasks.filter((t) => t.kb.skills?.length);
  if (!withSkills.length) return null;
  const missing = withSkills.filter((t) => {
    const p = ctx.cfg?.profiles?.[t.agent];
    if (!p || (p.launch || [])[0] !== 'claude') return false;
    return Array.isArray(p.allowed_tools) && !p.allowed_tools.includes('Skill');
  });
  if (!missing.length) return ok(TASK_SKILLS_CHECK, `${plural(withSkills.length, 'task')} set kb.skills, and every profile they run on allows the Skill tool`);
  const detail = missing.map((t) => `#${t.number} (${t.agent})`).join(' · ');
  const profiles = [...new Set(missing.map((t) => t.agent))];
  warn(TASK_SKILLS_CHECK,
    `${plural(missing.length, 'task')} set kb.skills but run on a profile whose allowed_tools denies Skill, and dontAsk denies rather than prompts: ${detail}`,
    `add "Skill" to "allowed_tools" on the ${profiles.join(', ')} profile${profiles.length === 1 ? '' : 's'} in ${path.relative(ctx.root, boardFile(ctx.root))}`);
  return missing;
}

// ---------- can this board be priced? ----------
//
// The hole this check exists for was found weeks late, by a spend report that was empty. A
// `claude --bg` worker never receives the launch environment, so for a long time nothing on the
// default profile recorded *which session* had done the work: no `session_id` on the attempt row,
// no price in `hkb stats`, no `claude --resume` in `hkb show`. Two mechanisms fill it in now — the
// terminal verb reads the job record (#135), and the dispatcher reads it again one tick after the
// launch for the attempts that never file a verb (#132) — and both are silent when they fail,
// because a session id is a bonus that must never be the reason a verb or a tick fails. So the
// board itself is the only honest witness, and this is the check that asks it.

/** Outcomes a worker's own terminal verb writes — rows where the session is always knowable. */
export const VERB_OUTCOMES = ['completed', 'blocked', 'review_requested'];
/** Outcomes the dispatcher writes off with no verb from the worker at all. */
export const NO_VERB_OUTCOMES = ['crashed', 'timed_out', 'protocol_violation'];
/**
 * How many run records the check reads before answering from what it has. Attempts live in one
 * `<!-- kb-run -->` comment per card, so evidence costs one REST call each; the sample is
 * newest-first and stops the moment every background profile has shown a session, so a board that
 * is recording normally pays for one.
 */
export const SESSION_SAMPLE = 10;

/** The name a board that would not read is reported under; every other finding names its profile. */
export const SESSION_CHECK = 'worker sessions';
/** One finding per background profile — the operator needs to know *which* one stopped recording. */
export const sessionCheckName = (profile) => `profile ${profile} sessions`;
export const SESSION_FIX = 'npm i -g hkb-cli@latest && hkb init (an hkb older than the recording only stamps what a verb reports) — if it is already current the harness is not stamping: a `claude --bg` worker reads its own identity from the job record $CLAUDE_JOB_DIR names, so check that variable is set inside a worker session';

/**
 * What a set of run records says about one profile's sessions. Pure, so the wording below can be
 * tested without a board.
 *
 * Only the two outcome families above are evidence. `spawn_failed`, `reclaimed` and `gave_up` are
 * excluded because no worker session ever ran, so nothing could have stamped them and a board of
 * those would otherwise warn about a hole that is not one; so are `synthetic` rows, which the
 * dispatcher and a reviewer write under their own names rather than a profile's.
 */
export function sessionTally(runs, profile) {
  const rows = [];
  for (const run of runs) {
    for (const a of run?.attempts || []) {
      if (a.profile !== profile || a.synthetic || !a.ended_at) continue;
      if (VERB_OUTCOMES.includes(a.outcome)) rows.push({ verb: true, session: !!a.session_id });
      else if (NO_VERB_OUTCOMES.includes(a.outcome)) rows.push({ verb: false, session: !!a.session_id });
    }
  }
  const count = (f) => rows.filter(f).length;
  return {
    ended: rows.length,
    withSession: count((r) => r.session),
    verb: count((r) => r.verb),
    verbWithSession: count((r) => r.verb && r.session),
    off: count((r) => !r.verb),
    offWithSession: count((r) => !r.verb && r.session),
  };
}

/**
 * The finding for one profile's tally. `null` when the profile has never ended an attempt here —
 * a board that has not run it yet has nothing to be wrong about, and doctor stays quiet.
 *
 * Nothing recorded at all is the warning, because that is the state that hid for weeks: it means
 * every attempt this profile has ever run is unpriceable and unreopenable, and it names both ways
 * that happens. Anything recorded is an `ok` that still says how much of each kind carries one —
 * verb-ended and written-off are two different mechanisms, and an operator reading a blank column
 * should be told which one to look at rather than left to guess.
 */
export function sessionFinding(profile, t, read = 0, priced = true) {
  const name = sessionCheckName(profile);
  if (!t.ended) return null;
  if (!t.withSession) {
    return {
      name,
      ok: null,
      detail: `none of the ${plural(t.ended, 'ended attempt')} on this board carries a session id (${plural(read, 'run record')} read) — nothing this profile ran can be priced by \`hkb stats\` or reopened with \`claude --resume\``,
      fix: SESSION_FIX,
    };
  }
  const bits = [];
  if (t.verb) bits.push(`${t.verbWithSession}/${t.verb} that filed a terminal verb`);
  if (t.off) bits.push(`${t.offWithSession}/${t.off} written off without one`);
  const note = t.off > t.offWithSession
    ? ' — the dispatcher names those from the background job record one tick after the launch, so only rows older than that stay blank'
    : '';
  // Recording and pricing are two halves, and a board can have the first without the second: a
  // `claude --bg` attempt reports no cost of its own, so its transcript is priced through
  // `stats.rates` or not at all (`estimateCost`, src/stats.js). Without that table the sessions this
  // check just confirmed buy turns and tokens and never a number — which reads as "spend visibility
  // is working" right up until someone asks what the board cost. Say it here, where the operator is
  // already looking at the recording, rather than only in the report that comes up empty.
  const unpriced = priced ? '' : ' · no `stats.rates` in .kanban/board.json, so those transcripts give `hkb stats` turns and tokens but never a cost';
  return { name, ok: true, detail: `session recorded on ${bits.join(' · ')}${note}${unpriced}` };
}

/**
 * Per background profile: does anything this board recorded name the session that did the work?
 *
 * Only `claude-bg` profiles are asked. Every other mode runs the harness as a child of the launch,
 * so `KB_TASK` arrives and the ordinary paths apply; the background daemon is the one place where
 * the whole chain was inert, and the one worth a standing check.
 *
 * Reads the open board (shared with `checkAgentLabels` when doctor hands it over) plus one query
 * for recently-closed cards — a completed attempt lives on a closed issue, so an open-only sample
 * would look at a board's least representative rows — then at most `SESSION_SAMPLE` run comments,
 * newest first. Every collaborator is an argument so the whole thing is testable from a fixture.
 */
export async function checkSessions(ctx, { ok, warn }, { board = null, fetch = fetchBoard, closed = fetchClosedRecent, load = loadRun, limit = SESSION_SAMPLE } = {}) {
  const profiles = Object.entries(ctx.cfg?.profiles || {}).filter(([, p]) => p?.mode === 'claude-bg').map(([n]) => n);
  if (!profiles.length) return [];
  const b = board || await boardOnce(ctx, fetch);
  if (b.error) { warn(SESSION_CHECK, `could not read the board: ${b.error}`); return []; }
  let recent = [];
  try { recent = await closed(ctx); } catch { /* the open board on its own still answers */ }
  const seen = new Map();
  for (const t of [...b.tasks, ...recent]) if (!seen.has(t.number)) seen.set(t.number, t);
  const newest = [...seen.values()].sort((x, y) => String(y.updatedAt || '').localeCompare(String(x.updatedAt || '')) || y.number - x.number);

  const runs = [];
  let read = 0;
  for (const t of newest) {
    if (read >= limit) break;
    if (profiles.every((p) => sessionTally(runs, p).withSession)) break; // answered; more reads cannot change it
    try { runs.push((await load(ctx, t.number)).run); read++; } catch { /* one unreadable comment is not the end of the check */ }
  }
  const found = [];
  for (const p of profiles) {
    const f = sessionFinding(p, sessionTally(runs, p), read, !!ctx.cfg?.stats?.rates);
    if (!f) continue;
    (f.ok ? ok : warn)(f.name, f.detail, f.fix);
    found.push(f);
  }
  return found;
}

// ---------- which layer is actually enforcing ----------

export const POLICY_CHECK = 'permission policy';

/**
 * Which layer decides what a worker on each profile may run. Pure.
 *
 * hkb's `PreToolUse` policy is a Claude Code hook gated on `KB_TASK`, and there are three ways a
 * profile never gets it: the launch is not Claude Code at all (Copilot, Codex — they read their own
 * hook files and enforce with their own flags), the launch is `claude --bg` (the session daemon was
 * started long before, with an environment of its own, so `KB_TASK` never arrives — the Stop hook
 * recovers by reading the `kb-<n>-<k>` checkout name, but a checkout says which *task* a session is,
 * never which profile, and hkb's policy with no profile would deny a worker `npm test`), or the
 * launch only triggers a run elsewhere, which configures itself. In all three the launch's own
 * `--allowedTools`/`--allow-tool`/`--sandbox` flags are the whole policy — which is a real answer,
 * not a hole, and the point of saying it is that an operator debugging a denial knows where to look.
 *
 * "Configured here" is now mostly a per-profile question, not a repo-wide one (#144): a launch that
 * carries `{hook_settings}` brings the hook with it. The repo-wide `preTool` stays as the second
 * answer, for a board whose hooks are in a settings file — `--shared-hooks`, or an older init.
 * Note what riding the launch does NOT change: a `claude --bg` session still never receives
 * `KB_TASK`, so the hook is installed there and still stands aside. That gate is #125's, untouched.
 */
export function policyLayers(cfg, { preTool = false } = {}) {
  return Object.entries(cfg?.profiles || {}).map(([name, p]) => {
    // order matters: a `trigger` launch is `gh workflow run`, but what it starts may well be Claude
    // Code — the reason its policy is elsewhere is the run, not the binary this host would spawn.
    if (p?.mode === 'trigger') return { profile: name, live: false, why: 'the triggered run brings its own settings' };
    if (p?.mode === 'claude-bg') return { profile: name, live: false, why: 'a `claude --bg` session never receives KB_TASK' };
    if ((p?.launch || [])[0] !== 'claude') return { profile: name, live: false, why: 'not Claude Code' };
    if (!(preTool || (p.launch || []).includes(HOOK_SETTINGS_VAR))) return { profile: name, live: false, why: 'no PreToolUse hook is configured here' };
    return { profile: name, live: true, why: null };
  });
}

export const MODE_CHECK = 'permission mode';

/**
 * A worker launch that can still *prompt*. Pure.
 *
 * `--permission-mode dontAsk` is what turns Claude Code's allow-list into a policy instead of a
 * questionnaire: without it a tool call outside the list opens a prompt, and there is nobody in a
 * background worker to answer one. The attempt does not fail — it hangs, silently, until
 * `max_runtime` reclaims it, which reads as a slow harness rather than a missing flag.
 *
 * Only launches that spawn Claude Code itself are asked: `claude-action` runs `gh workflow run`, and
 * the flags of the run it triggers live in the workflow file, not here.
 *
 * `dontAsk` is not the only flag that turns a prompt into a policy: `--permission-mode
 * bypassPermissions` and the older `--dangerously-skip-permissions` both skip the prompt too (#159),
 * and flagging either here would tell an operator to add a flag that is already doing the job.
 */
export function promptingProfiles(cfg) {
  const SAFE_MODES = new Set(['dontAsk', 'bypassPermissions']);
  return Object.entries(cfg?.profiles || {})
    .filter(([, p]) => (p?.launch || [])[0] === 'claude')
    .filter(([, p]) => {
      if ((p.launch || []).includes('--dangerously-skip-permissions')) return false;
      const i = p.launch.indexOf('--permission-mode');
      return i < 0 || !SAFE_MODES.has(p.launch[i + 1]);
    })
    .map(([name]) => name);
}

/** Silent when every Claude launch says `dontAsk` — there is nothing an operator has to act on. */
export function checkPermissionMode(ctx, { warn }) {
  const prompting = promptingProfiles(ctx.cfg);
  if (!prompting.length) return null;
  warn(MODE_CHECK, `${prompting.join(', ')} launch${prompting.length === 1 ? 'es' : ''} without \`--permission-mode dontAsk\` — a prompt in a background worker blocks the attempt: nobody answers it and it hangs until max_runtime reclaims the task`,
    `add "--permission-mode", "dontAsk" to the launch in ${path.relative(ctx.root, boardFile(ctx.root))}`);
  return prompting;
}

/** One line, so the operator never has to work out which layer answered a denial. */
export function checkPolicyLayer(ctx, { ok }, { find = findClaudeHooks } = {}) {
  const layers = policyLayers(ctx.cfg, { preTool: find(ctx.root).hooks.some((h) => h.event === 'PreToolUse') });
  if (!layers.length) return null;
  const live = layers.filter((l) => l.live).map((l) => l.profile);
  // group the inert ones by reason, so five profiles that are inert for one reason read as one clause
  const byWhy = new Map();
  for (const l of layers.filter((x) => !x.live)) byWhy.set(l.why, [...(byWhy.get(l.why) || []), l.profile]);
  const inert = [...byWhy].map(([why, names]) => `${names.join(', ')} (${why})`);
  const detail = [
    live.length ? `hkb's PreToolUse policy enforces on ${live.join(', ')}` : "hkb's PreToolUse policy enforces on no profile here",
    inert.length ? `the launch's own flags are the whole policy on ${inert.join(' · ')}` : null,
  ].filter(Boolean).join(' — ');
  ok(POLICY_CHECK, detail);
  return layers;
}

// ---------- a worker's environment where no worker is ----------

export const ENV_LEAK_CHECK = 'worker environment';

/**
 * Linux only, and only asked once something already looks wrong: which processes on this host hold
 * `KB_*` in their environment while claiming to be a Claude Code session daemon. `/proc/<pid>/environ`
 * is readable for our own processes and nobody else's, which is exactly the set we care about.
 * Never throws — an unreadable `/proc` simply means the warning names no pid.
 */
export function daemonsWithKbEnv({ proc = '/proc', match = /claude/ } = {}) {
  const out = [];
  let pids = [];
  try { pids = fs.readdirSync(proc).filter((d) => /^\d+$/.test(d)); } catch { return out; }
  for (const pid of pids) {
    try {
      const cmd = fs.readFileSync(path.join(proc, pid, 'cmdline'), 'utf8').split('\0').join(' ');
      if (!match.test(cmd) || !/\bdaemon\b/.test(cmd)) continue;
      const vars = kbVarsIn(fs.readFileSync(path.join(proc, pid, 'environ'), 'utf8'));
      if (vars.length) out.push({ pid: Number(pid), vars, cmd: cmd.trim().slice(0, 120) });
    } catch { /* gone, or another user's: not ours to report */ }
  }
  return out;
}

/**
 * Is doctor itself running with a worker's identity it has no business having?
 *
 * The shape this catches is one incident, exactly (#150): a `claude --bg` launch found no session
 * daemon, started one, and that daemon kept `KB_TASK=146 KB_PROFILE=claude KB_ROOT=…` for its whole
 * life — so every session it hosted, including conversations that predated the card, believed it was
 * that worker. The Stop hook stamped the wrong session onto the attempt, and the worker permission
 * policy was enforced on the operator's shell. hkb no longer launches that way (`scrubKbEnv`), but a
 * daemon already poisoned stays poisoned until it is restarted, and nothing else on this host will
 * tell the operator that. The verdict is `attemptIdentity`'s, so doctor says exactly what the hooks
 * in the same environment will do.
 */
export function checkEnvLeak(ctx, { warn }, { env = process.env, cwd = process.cwd(), daemons = daemonsWithKbEnv } = {}) {
  if (!env.KB_TASK) return null;
  const { id, herePath, rootPath } = resolvedIdentity(cwd, { env, profiles: ctx.cfg?.profiles });
  if (!id?.leak) return null;
  const found = process.platform === 'linux' ? daemons() : [];
  const pids = found.map((d) => d.pid);
  const some = pids.slice(0, 3).join(', ') + (pids.length > 3 ? ` (+${pids.length - 3} more)` : '');
  const named = found.length
    ? ` The daemon${found.length > 1 ? 's' : ''} holding ${found[0].vars.join(' ')}: pid ${some}.`
    : '';
  const finding = {
    name: ENV_LEAK_CHECK,
    ok: null,
    detail: `this shell thinks it is a worker for #${env.KB_TASK}${env.KB_PROFILE ? ` on profile ${env.KB_PROFILE}` : ''}, but ${rootPath && herePath === rootPath ? 'it is the board root' : `${path.basename(herePath)} is not that task's worktree`} — a \`claude --bg\` launch probably started the Claude Code session daemon with that environment, and every session it hosts inherits it.${named} hkb stands aside where it can see the contradiction (no nudge, no session stamp, no permission policy here), but nothing else does`,
    fix: `let the sessions it hosts finish, then end the daemon${found.length ? ` (pid ${some})` : ''} — the next \`claude --bg\` starts a clean one. hkb's own launches no longer pass KB_* to a background agent, so a dispatcher on this version cannot poison the replacement`,
  };
  warn(finding.name, finding.detail, finding.fix);
  return finding;
}

// ---------- KB_TOKEN expiry ----------

/**
 * GitHub sends this on every response to a request made with a fine-grained PAT, and on nothing
 * else — an OAuth login or a classic token has no expiry to report, so the check stays silent.
 */
export const TOKEN_EXPIRY_HEADER = 'github-authentication-token-expiration';
export const TOKEN_CHECK = 'token expiry';
/** The checks worth an Actions annotation: buried in a run log is the same as never having run. */
const ANNOTATED = new Set([TOKEN_CHECK]);
export const TOKEN_FIX = 'mint a new fine-grained PAT and: gh secret set KB_TOKEN';
/** A week is enough notice to mint a PAT without the board stalling; below it, say so every time. */
export const TOKEN_WARN_DAYS = 7;
const DAY = 86_400_000;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/**
 * Both of these slice an ISO string on purpose — never `toLocale*`. An expiry is one instant for
 * everyone who shares the token, so the same PAT has to warn about the same day whether the reader
 * is a runner in UTC, a laptop in EDT or the loop's log; and the once-a-day probe below has to be
 * the same day for all of them, or a board dispatching from two hosts probes twice.
 */
const formatUtc = (iso) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (String(k).toLowerCase() === want) return v;
  return null;
}

/**
 * What a response head says about the token that fetched it.
 * GitHub writes `2026-09-25 12:00:00 UTC`; ISO 8601 is accepted too, and anything else — or no
 * header at all — is `null`, which every caller treats as "not a fine-grained PAT, say nothing".
 */
export function tokenExpiry(headers, now = Date.now()) {
  const raw = headerValue(headers, TOKEN_EXPIRY_HEADER);
  if (!raw || !String(raw).trim()) return null;
  const at = new Date(String(raw).trim());
  if (Number.isNaN(at.getTime())) return null;
  const ms = at.getTime() - now;
  const days = Math.floor(ms / DAY);
  return { at: at.toISOString(), ms, days, level: ms <= 0 ? 'expired' : days < TOKEN_WARN_DAYS ? 'warn' : 'ok' };
}

/** The doctor finding for an expiry: ok outside the warn window, a warning inside it, a failure past it. */
export function expiryFinding(e) {
  const when = formatUtc(e.at);
  if (e.level === 'expired') {
    const ago = Math.max(0, Math.floor(-e.ms / DAY));
    return { name: TOKEN_CHECK, ok: false, detail: `the token expired ${when} (${ago ? `${plural(ago, 'day')} ago` : 'today'})`, fix: TOKEN_FIX };
  }
  const left = e.days >= 1 ? `${plural(e.days, 'day')} left` : 'less than a day left';
  if (e.level === 'warn') return { name: TOKEN_CHECK, ok: null, detail: `expires ${when} (${left})`, fix: TOKEN_FIX };
  return { name: TOKEN_CHECK, ok: true, detail: `fine-grained PAT, expires ${when} (${left})` };
}

/** Push the expiry finding, if this token has one. Returns what the header said, or null. */
export function checkTokenExpiry(headers, { ok, warn, bad }, now = Date.now()) {
  const e = tokenExpiry(headers, now);
  if (!e) return null;
  const f = expiryFinding(e);
  (f.ok === true ? ok : f.ok === false ? bad : warn)(f.name, f.detail, f.fix);
  return e;
}

/**
 * Rate limit, token class and — for a fine-grained PAT — its expiry, all from one response head.
 * `GET rate_limit` is the probe on purpose: GitHub does not charge it against the limit it reports.
 */
export async function checkToken({ ok, warn, bad }, now = Date.now()) {
  let headers;
  try {
    const r = await restRaw('GET', 'rate_limit');
    headers = r.headers;
    const core = r.data?.resources?.core, gql = r.data?.resources?.graphql;
    ok('rate limit', `REST ${core?.remaining}/${core?.limit} · GraphQL ${gql?.remaining}/${gql?.limit} (resets ${new Date(core?.reset * 1000).toLocaleTimeString()})`);
    if (core?.limit && core.limit < 5000) warn('token type', `REST limit ${core.limit}/h — a fine-grained PAT or user token gives 5000/h`);
  } catch (e) { warn('rate limit', e.message); return null; }
  return checkTokenExpiry(headers, { ok, warn, bad }, now);
}

/**
 * Inside Actions an annotation is the only part of a run an operator sees without opening the log,
 * so a check that needs a human gets one. `%`, CR and LF have to be escaped or the runner truncates
 * the message. Returns null when the check passed, or when we are not in Actions.
 */
export function actionsAnnotation(finding, { inActions = !!process.env.GITHUB_ACTIONS } = {}) {
  if (!inActions || !finding || finding.ok === true) return null;
  const escape = (s) => String(s ?? '').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const level = finding.ok === false ? 'error' : 'warning';
  return `::${level}::${escape(finding.name)}: ${escape(finding.detail)}${finding.fix ? ` → ${escape(finding.fix)}` : ''}`;
}

/**
 * Annotate the findings that need a human. Under `--json` the line goes to stderr so stdout stays
 * parseable; the runner reads both streams. Returns what it wrote, for the caller and for tests.
 */
export function emitAnnotations(results, { json = false, inActions = !!process.env.GITHUB_ACTIONS, out = process.stdout, err = process.stderr } = {}) {
  const lines = [];
  if (!inActions) return lines;
  for (const r of results) {
    const line = ANNOTATED.has(r.name) ? actionsAnnotation(r, { inActions }) : null;
    if (!line) continue;
    lines.push(line);
    (json ? err : out).write(`${line}\n`);
  }
  return lines;
}

/**
 * The dispatcher's copy of the check: at most one probe a day, on a call GitHub does not charge,
 * so a loop that runs for weeks still warns the operator a week before KB_TOKEN lapses. Safe to
 * call every tick; call it *outside* `tick()` — it read-modify-writes `.kanban/state.json`.
 * A failed probe stamps nothing, so the next tick tries again.
 */
export async function tokenExpiryNotice(ctx, log, { now = Date.now(), inActions = !!process.env.GITHUB_ACTIONS, out = process.stdout } = {}) {
  const day = utcDay(now);
  const state = readState(ctx.root);
  if (state.token_expiry_day === day) return null;
  let expiry;
  try {
    expiry = tokenExpiry((await restRaw('GET', 'rate_limit')).headers, now);
  } catch { return null; }
  state.token_expiry_day = day;
  try { writeState(ctx.root, state); } catch { /* read-only checkout: it just checks again next tick */ }
  if (!expiry || expiry.level === 'ok') return expiry;
  const f = expiryFinding(expiry);
  // The annotation bypasses `log`: the runner only reads a workflow command that starts the line,
  // and the loop's log prefixes every line with a timestamp. Which branch runs is an *argument*,
  // not something read off the ambient environment — otherwise this function behaves one way in the
  // test suite and another way when that suite runs on Actions, which is exactly how #48 escaped.
  const line = actionsAnnotation(f, { inActions });
  if (line) out.write(`${line}\n`);
  else log(`${f.name}: ${f.detail} → ${f.fix}`);
  return expiry;
}

// ---------- is the hkb running this old? ----------

/**
 * hkb has no push channel and should not have one: it is a CLI over `gh`, with no service and
 * nothing that phones home, so updates are pull-only. Pull-only works only if something tells you
 * there is something to pull — this is that something, and it is deliberately small: one registry
 * GET a day, in the two places with an audience for it (`hkb doctor` and the dispatcher loop),
 * never on the hot path of an ordinary command.
 *
 * It also re-arms `checkSkill`. That check compares the *installed* skill against the *packaged*
 * one, so an hkb from six months ago ships a six-month-old skill, the two match, and doctor reports
 * `✓ skill` on a board that is months behind. Without a word about the CLI itself, the one check
 * that exists is silently disarmed by the one that did not.
 */
export const VERSION_CHECK = 'hkb version';

/**
 * The upgrade, and deliberately *not* an `hkb update`. hkb cannot know how it was installed — a
 * global npm, an npx cache, a pnpm or volta shim, a git checkout — so a self-install would guess,
 * and guessing wrong breaks the tool doing the guessing (wrong prefix, sudo, a package directory
 * replaced under the process running out of it). The second command is not overhead either: a new
 * CLI ships a new skill, and `hkb init` is what copies it into this checkout. Two honest commands
 * beat one that gambles.
 */
export function upgradeCommand(pkgRoot = PKG_ROOT) {
  return isEphemeralPath(pkgRoot) ? 'npx -y hkb-cli@latest init' : 'npm i -g hkb-cli@latest && hkb init';
}

/** Is this board allowed to ask npm? False on a deliberately pinned install (board.json). */
export function versionCheckEnabled(cfg) { return cfg?.version_check !== false; }

/**
 * The finding for one version pair. No `latest` — offline, rate-limited, or the check turned off —
 * is not a warning and never a failure: it says the version and stops, exactly as an install with
 * no check at all would. Being *ahead* of the registry (a git checkout, a release in flight) is
 * reported as the fact it is, not as a problem.
 */
export function versionFinding(installed, latest, { fix = upgradeCommand(), off = false } = {}) {
  if (!latest) return { name: VERSION_CHECK, ok: true, detail: `${installed}${off ? ' — daily update check off ("version_check": false)' : ''}` };
  const cmp = compareVersions(installed, latest);
  if (cmp !== null && cmp < 0) return { name: VERSION_CHECK, ok: null, detail: `${installed} installed, npm has ${latest}`, fix };
  return { name: VERSION_CHECK, ok: true, detail: `${installed}${cmp === 0 ? ' (latest)' : ` (npm has ${latest})`}` };
}

/**
 * At most one registry GET a day per checkout, stamped in `.kanban/state.json` beside the token
 * probe's stamp — same shape (read state, compare a `*_day`, stamp only on success so a failure
 * retries next time), separate key. The *answer* is stamped too, not just the day, so the second
 * doctor of the day still names the latest version without a second call.
 *
 * A checkout with no board.json is probed but never stamped: this must not be what creates
 * `.kanban/` in a repo that has not been `hkb init`ed.
 * @returns {Promise<{latest: string|null, checked: boolean, off: boolean}>} `checked` is "the probe
 *   ran just now", which is what makes the loop's line once-a-day rather than once-a-tick.
 */
export async function dailyLatest(ctx, { now = Date.now() } = {}) {
  if (!versionCheckEnabled(ctx.cfg)) return { latest: null, checked: false, off: true };
  const day = utcDay(now);
  const state = readState(ctx.root);
  if (state.version_check_day === day) return { latest: state.version_latest ?? null, checked: false, off: false };
  let latest;
  try { latest = await latestVersion(); } catch { return { latest: null, checked: false, off: false }; }
  if (ctx.cfg) {
    state.version_check_day = day;
    state.version_latest = latest;
    try { writeState(ctx.root, state); } catch { /* read-only checkout: it just checks again next run */ }
  }
  return { latest, checked: true, off: false };
}

/**
 * doctor's line: the installed version every run, and what npm has whenever the day's one probe
 * had an answer — from the stamp, so a second `hkb doctor` the same day costs nothing.
 */
export async function checkVersion(ctx, { ok, warn }, opts = {}) {
  const { latest, off } = await dailyLatest(ctx, opts);
  const f = versionFinding(packageVersion(), latest, { off });
  (f.ok === true ? ok : warn)(f.name, f.detail, f.fix);
  return f;
}

/**
 * The dispatcher's copy: one line a day, and only when there is something to say. A loop that has
 * been up for weeks is exactly the install most likely to be stale, and its operator is not running
 * doctor. Safe to call every tick; call it *outside* `tick()` — it read-modify-writes
 * `.kanban/state.json` — and it never throws, so a tick can never be lost to it.
 */
export async function versionNotice(ctx, log, opts = {}) {
  let latest, checked;
  try { ({ latest, checked } = await dailyLatest(ctx, opts)); } catch { return null; }
  if (!checked || !latest) return null; // already probed today, no registry, or the check is off
  const f = versionFinding(packageVersion(), latest);
  if (f.ok !== null) return null; // current, or ahead of the registry
  log(`${f.name}: ${f.detail} → ${f.fix}`);
  return f;
}

export async function doctor(ctx, flags, log) {
  const results = [];
  const ok = (name, detail) => results.push({ name, ok: true, detail });
  const bad = (name, detail, fix) => results.push({ name, ok: false, detail, fix });
  const warn = (name, detail, fix) => results.push({ name, ok: null, detail, fix });

  // tools
  has('gh') ? ok('gh', version('gh')) : bad('gh', 'not found', 'install https://cli.github.com');
  const auth = ghAuthStatus();
  auth.ok ? ok('gh auth', auth.text.split('\n').find((l) => /Logged in/.test(l))?.trim() || 'logged in') : bad('gh auth', auth.text.split('\n')[0], 'gh auth login');
  ok('node', process.version);
  // The tool checking the tools: at most one registry GET a day, and silent about it when offline.
  await checkVersion(ctx, { ok, warn });
  if (ctx.cfg?.profiles?.claude) (has('claude') ? ok('claude', version('claude')) : bad('claude', 'not on PATH', 'install Claude Code or remove the claude profile'));
  if (ctx.cfg?.profiles?.['copilot-cli']) (has('copilot') ? ok('copilot', 'found') : warn('copilot', 'not on PATH', 'gh extension / Copilot CLI install'));
  if (ctx.cfg?.profiles?.codex) (has('codex') ? ok('codex', version('codex')) : warn('codex', 'not on PATH', 'npm i -g @openai/codex'));

  // board
  if (!ctx.cfg) { bad('board.json', 'missing', 'hkb init'); return report(results, ctx, log); }
  ok('board.json', `${path.relative(ctx.root, boardFile(ctx.root))} · repo ${ctx.cfg.repo} · board "${ctx.board}"`);
  for (const [name, p] of Object.entries(ctx.cfg.profiles)) {
    if (!p.launch) warn(`profile ${name}`, 'no launch template — tasks assigned to it will never be dispatched from this host', 'add "launch" in board.json');
    else ok(`profile ${name}`, `${p.launch[0]} · max_in_progress ${p.max_in_progress ?? '∞'}`);
    // a launch that hands the harness a schema by path (`codex exec --output-schema <file>`) fails
    // on every attempt if that file is not in the checkout the worker gets
    const i = (p.launch || []).indexOf('--output-schema');
    const schema = i > 0 ? p.launch[i + 1] : null;
    if (schema) {
      fs.existsSync(path.join(ctx.root, schema))
        ? ok(`profile ${name} output schema`, schema)
        : bad(`profile ${name} output schema`, `${schema} is missing — every attempt would fail to start`, 'hkb init, and commit the file so worktrees have it');
    }
  }
  checkSkill(ctx, { ok, warn });
  checkHarnesses(ctx, { ok, warn, bad });
  checkActions(ctx, { ok, warn });
  const claudeSkill = path.join(ctx.root, '.claude', 'skills', 'kanban');
  fs.existsSync(claudeSkill) ? ok('claude skill link', '.claude/skills/kanban') : warn('claude skill link', 'missing', 'hkb init');
  checkCommands(ctx, { ok, warn });
  checkHooks(ctx, { ok, warn, bad });
  await checkMcp(ctx, { ok, warn, bad });
  checkDispatcher(ctx, { ok, warn });
  // which layer answers a denial, and whether a frozen copy of that layer has fallen behind:
  // local files only, so both run on a checkout with no repo behind it
  checkPolicyLayer(ctx, { ok });
  checkPermissionMode(ctx, { warn });
  checkWorkerPermissions(ctx, { ok, warn });
  // and whether this shell is carrying a worker's identity it should not have (#150)
  checkEnvLeak(ctx, { warn });

  if (!ctx.repo) return report(results, ctx, log);

  // labels
  try {
    const labels = new Set();
    for (let page = 1; page <= 3; page++) { const b = await rest('GET', api(ctx, `/labels?per_page=100&page=${page}`)); for (const l of b || []) labels.add(l.name); if (!b || b.length < 100) break; }
    const missing = [...STATUSES.map(L.status), L.board(ctx.board), L.needsHuman, L.noTrack].filter((l) => !labels.has(l));
    missing.length ? bad('labels', `missing ${missing.join(', ')}`, 'hkb init') : ok('labels', `${[...labels].filter((l) => l.startsWith('kb:')).length} kb:* labels`);
  } catch (e) { bad('labels', e.message); }

  // the cards: a card on two profiles dispatches as neither the one you set nor the one you see,
  // and a background profile that has stopped recording sessions is a board nothing can price
  const board = await boardOnce(ctx);
  await checkAgentLabels(ctx, { ok, warn }, { board });
  await checkTrackProfile(ctx, { ok, warn });
  await checkTaskSkills(ctx, { ok, warn }, { board });
  await checkSessions(ctx, { ok, warn }, { board });
  await checkOrphanedPrs(ctx, { ok, warn });
  await checkTrackBranches(ctx, { ok, warn });

  // rate limit, token class, token expiry — one call
  await checkToken({ ok, warn, bad });

  // API capabilities
  try {
    const caps = await detectCaps(ctx, { force: true });
    caps.blockedByGql ? ok('GraphQL Issue.blockedBy', 'available (one query per tick)') : warn('GraphQL Issue.blockedBy', 'not in schema — falling back to REST dependencies per task', 'check docs; run doctor again later');
    caps.closedByPrs ? ok('GraphQL closedByPullRequestsReferences', 'available (active_pr guard)') : warn('GraphQL closedByPullRequestsReferences', 'not in schema — active_pr guard disabled');
    checkGroomBlockers(ctx, { ok, warn }, { caps, board });
  } catch (e) { bad('GraphQL', e.message); }

  // the last step — silent unless the board asked GitHub to take it (`merge.mode: "auto"`)
  await checkMergePolicy(ctx, { ok, bad });

  checkPathOverlapGuard(ctx, { ok, bad });

  // Projects v2 mirror — silent unless board.json links a project (the feature is off by default)
  await checkProject(ctx, { ok, bad, warn });

  if (flags.api) {
    // dependencies REST endpoint
    try {
      const issues = await rest('GET', api(ctx, '/issues?state=all&per_page=1'));
      if (issues?.length) {
        await rest('GET', api(ctx, `/issues/${issues[0].number}/dependencies/blocked_by?per_page=1`));
        ok('REST issue dependencies', `GET .../dependencies/blocked_by works (API version ${API_VERSION})`);
      } else warn('REST issue dependencies', 'no issues to probe');
    } catch (e) { bad('REST issue dependencies', `${e.kind} ${e.message}`, 'dependencies may need a newer API version or are unavailable for this repo'); }
    // lock ref probe: create, duplicate-create, lease-push (the worker's heartbeat), delete
    const k = Date.now();
    const probe = `refs/kb/locks/probe/${k}`;
    try {
      const head = await rest('GET', api(ctx, `/git/ref/heads/${ctx.cfg.default_branch || 'main'}`));
      await rest('POST', api(ctx, '/git/refs'), { body: { ref: probe, sha: head.object.sha } });
      let dup = 'no error (!)';
      try { await rest('POST', api(ctx, '/git/refs'), { body: { ref: probe, sha: head.object.sha } }); } catch (e) { dup = `${e.status} → ${classifyClaimError(e)}`; }
      const beat = casHeartbeat(ctx.root, 'probe', k, head.object.sha, { remote: remoteName(ctx) });
      dropBeatChain(ctx.root, 'probe', k);
      await rest('DELETE', api(ctx, `/git/refs/${probe.replace(/^refs\//, '')}`));
      dup.endsWith('held') ? ok('lock ref CAS', `create 201 · duplicate ${dup} · delete ok`) : bad('lock ref CAS', `duplicate create returned ${dup}`, 'report this: claim classification must be adjusted');
      if (beat.result === 'ok') ok('heartbeat lease', `git push --force-with-lease on ${probe} → ${beat.sha.slice(0, 7)}`);
      else warn('heartbeat lease', `${beat.result}: ${beat.detail}`, `workers on this host will heartbeat by writing the run comment instead — set "heartbeat": "comment" on the profile to make that the plan, or give ${remoteName(ctx)} push access to refs/kb/*`);
    } catch (e) { bad('lock ref CAS', `${e.kind} ${e.message}`, 'token needs Contents: write'); }
  } else {
    warn('API probes', 'skipped', 'hkb doctor --api (creates and deletes one probe ref)');
  }
  return report(results, ctx, log);
}

function report(results, ctx, log) {
  emitAnnotations(results, { json: !!ctx.json });
  if (ctx.json) { log(JSON.stringify(results, null, 2)); return results.some((r) => r.ok === false) ? 1 : 0; }
  for (const r of results) {
    const mark = r.ok === true ? '✓' : r.ok === false ? '✗' : '!';
    log(`${mark} ${r.name.padEnd(36)} ${r.detail || ''}${r.fix && r.ok !== true ? `  → ${r.fix}` : ''}`);
  }
  const bad = results.filter((r) => r.ok === false).length;
  // "`hkb up` when ready" three lines under "dispatcher running pid 3843" reads as advice from a tool
  // that did not read its own output. A board that is already up gets told what is already true.
  const up = results.find((r) => r.name === 'dispatcher')?.ok === true;
  log(bad ? `\n${bad} problem(s). Fix them before \`hkb dispatch\`.`
    : up ? '\nAll good, and the dispatcher is up. `hkb up --status` says what is running.'
      : '\nAll good. `hkb up` when ready (`hkb up --serve` for the board too).');
  return bad ? 1 : 0;
}

export { GhError, graphql };
