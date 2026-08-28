// `hkb doctor [--api]` — check everything before the first dispatch; never guess.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ghAuthStatus, rest, restRaw, graphql, GhError, API_VERSION } from './gh.js';
import { boardFile, api, readState, writeState, DEFAULT_PROFILES } from './board.js';
import { detectCaps, branchProtection, fetchBoard, fetchClosedRecent, loadRun } from './tasks.js';
import { L, STATUSES, SAFE_BUILTINS, agentsOf, compareVersions, mergePolicy, mergeGate, mergeGateFix, uncoveredBuiltins } from './model.js';
import { classifyClaimError, casHeartbeat, dropBeatChain, remoteName } from './lock.js';
import { agentsSkillDir, packageSkillDir, packageVersion, readSkillVersion, commandFiles, commandNames, harnessFiles, actionsFiles, HARNESS_PROFILE, findClaudeHooks, hookCommandNeeds, isEphemeralPath, localInstallRel, resolveHookPath, PROJECT_DIR, HOOK_SETTINGS, PKG_ROOT } from './init.js';
import { latestVersion } from './registry.js';
import { checkProject } from './projects.js';

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
 * SKILL.md documents `/kanban:specify` and `/kanban:decompose` by name, so a repo where they are not
 * registered has a skill that instructs an invocation the harness will reject (#92). They come from
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
 */
export function checkHarnesses(ctx, { ok, warn }) {
  for (const [harness, profile] of Object.entries(HARNESS_PROFILE)) {
    if (!ctx.cfg.profiles?.[profile]) continue;
    const files = harnessFiles(harness).map((f) => f.rel);
    const missing = files.filter((f) => !fs.existsSync(path.join(ctx.root, f)));
    missing.length
      ? warn(`${harness} harness`, `missing ${missing.join(', ')}`, `hkb init --harness ${harness}`)
      : ok(`${harness} harness`, `${files.join(' · ')} (${HARNESS_NOTE[harness] || 'stop nudge'})`);
  }
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

/**
 * The Stop/PreToolUse hooks: which settings file holds them, and whether what they run can actually
 * run *here*. A hook command that does not resolve fails on every tool call in every session in the
 * repo — noise the reader did not write and cannot explain — and a hook that only half-exists is
 * worse than none, so this is a failure with the install in the fix, not a warning (#85). The lookups
 * are arguments so the check is testable without touching PATH.
 *
 * Two things follow from a repo that installed hkb itself (#146). `$CLAUDE_PROJECT_DIR` is resolved
 * to the repo before the file is looked for, and reported, so the pass names what it found rather
 * than the variable. And a command naming a binary instead of that install is a failure however well
 * it happens to work on this machine: it is in the file everyone reads, and everyone else has only
 * what `npm install` gave them.
 */
export function checkHooks(ctx, { ok, warn, bad }, { onPath = has, exists = (p) => fs.existsSync(p), localRel = localInstallRel(ctx.root) } = {}) {
  const { hooks, unreadable } = findClaudeHooks(ctx.root);
  for (const u of unreadable) warn('hooks settings', `${u.file} is not valid JSON (${u.error})`, 'fix the JSON, then hkb init');
  if (!hooks.some((h) => h.event === 'Stop')) {
    return warn('stop hook', `not configured in ${HOOK_SETTINGS.local} or ${HOOK_SETTINGS.shared} — workers that exit without a terminal verb are only caught by the dispatcher`, 'hkb init');
  }
  const files = [...new Set(hooks.map((h) => h.file))];
  files.length > 1
    ? warn('stop hook', `configured in both ${files.join(' and ')} — every nudge fires twice`, "delete hkb's hooks from one of them, then hkb init")
    : ok('stop hook', files[0]);
  // one finding per thing that has to exist, not per hook: both commands normally need the same binary
  const byTarget = new Map();
  for (const h of hooks) {
    const need = hookCommandNeeds(h.command);
    const key = `${need.kind}:${need.target}`;
    if (!byTarget.has(key)) byTarget.set(key, { need, commands: new Set(), where: new Set() });
    byTarget.get(key).commands.add(h.command);
    byTarget.get(key).where.add(h.file);
  }
  for (const { need, commands, where } of byTarget.values()) {
    const what = [...commands].join(' · ');
    const target = resolveHookPath(need.target, ctx.root);
    // A guarded command is a whole line of shell twice over; what the reader needs from a pass is the
    // file it resolved to, which is exactly what this group is keyed by.
    const found = target === need.target ? what : `${need.target} → ${target}`;
    if (isEphemeralPath(need.target)) {
      bad('hook command', `${what} — the npx cache is not a durable path, so this stops working the moment it is cleaned`, 'npm i -g hkb-cli, then hkb init');
    } else if (localRel && need.kind === 'bin') {
      bad('hook command',
        `${what} in ${[...where].join(' and ')} — this repo installs hkb itself (${localRel}), and \`${need.target}\` is whatever each machine happens to have, or nothing`,
        `hkb init — it rewrites the command as ${PROJECT_DIR}/${localRel}, which every checkout resolves`);
    } else if (need.kind === 'file' ? exists(target) : onPath(need.target)) {
      ok('hook command', found);
    } else if (need.kind === 'file' && need.guarded) {
      warn('hook command', `${target} is not installed here — the hook exits 0 in silence until it is`, 'npm install');
    } else {
      bad('hook command',
        `${what} — ${need.kind === 'file' ? `${target} is not there` : `\`${need.target}\` is not on PATH here`}; the hook fails on every tool call in this repo`,
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
 * changes nothing, so it has nothing to report.
 */
export async function checkMergePolicy(ctx, { ok, bad }) {
  const policy = mergePolicy(ctx.cfg);
  if (policy.error) return bad(MERGE_CHECK, policy.error, `fix "dispatch": {"merge": {...}} in ${path.relative(ctx.root, boardFile(ctx.root))}`);
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

/**
 * The one board read the card checks share. Returns `{tasks}` or `{error}` so each check reports
 * the failure in its own words rather than one of them swallowing it for the others.
 */
export async function boardOnce(ctx, fetch = fetchBoard) {
  try { return { tasks: await fetch(ctx, { blockers: false }) }; } catch (e) { return { error: e.message }; }
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
 */
export function policyLayers(cfg, { preTool = false } = {}) {
  return Object.entries(cfg?.profiles || {}).map(([name, p]) => {
    // order matters: a `trigger` launch is `gh workflow run`, but what it starts may well be Claude
    // Code — the reason its policy is elsewhere is the run, not the binary this host would spawn.
    if (p?.mode === 'trigger') return { profile: name, live: false, why: 'the triggered run brings its own settings' };
    if (p?.mode === 'claude-bg') return { profile: name, live: false, why: 'a `claude --bg` session never receives KB_TASK' };
    if ((p?.launch || [])[0] !== 'claude') return { profile: name, live: false, why: 'not Claude Code' };
    if (!preTool) return { profile: name, live: false, why: 'no PreToolUse hook is configured here' };
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
 */
export function promptingProfiles(cfg) {
  return Object.entries(cfg?.profiles || {})
    .filter(([, p]) => (p?.launch || [])[0] === 'claude')
    .filter(([, p]) => {
      const i = p.launch.indexOf('--permission-mode');
      return i < 0 || p.launch[i + 1] !== 'dontAsk';
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
  checkHarnesses(ctx, { ok, warn });
  checkActions(ctx, { ok, warn });
  const claudeSkill = path.join(ctx.root, '.claude', 'skills', 'kanban');
  fs.existsSync(claudeSkill) ? ok('claude skill link', '.claude/skills/kanban') : warn('claude skill link', 'missing', 'hkb init');
  checkCommands(ctx, { ok, warn });
  checkHooks(ctx, { ok, warn, bad });
  // which layer answers a denial, and whether a frozen copy of that layer has fallen behind:
  // local files only, so both run on a checkout with no repo behind it
  checkPolicyLayer(ctx, { ok });
  checkPermissionMode(ctx, { warn });
  checkWorkerPermissions(ctx, { ok, warn });

  if (!ctx.repo) return report(results, ctx, log);

  // labels
  try {
    const labels = new Set();
    for (let page = 1; page <= 3; page++) { const b = await rest('GET', api(ctx, `/labels?per_page=100&page=${page}`)); for (const l of b || []) labels.add(l.name); if (!b || b.length < 100) break; }
    const missing = [...STATUSES.map(L.status), L.board(ctx.board), L.needsHuman].filter((l) => !labels.has(l));
    missing.length ? bad('labels', `missing ${missing.join(', ')}`, 'hkb init') : ok('labels', `${[...labels].filter((l) => l.startsWith('kb:')).length} kb:* labels`);
  } catch (e) { bad('labels', e.message); }

  // the cards: a card on two profiles dispatches as neither the one you set nor the one you see,
  // and a background profile that has stopped recording sessions is a board nothing can price
  const board = await boardOnce(ctx);
  await checkAgentLabels(ctx, { ok, warn }, { board });
  await checkSessions(ctx, { ok, warn }, { board });

  // rate limit, token class, token expiry — one call
  await checkToken({ ok, warn, bad });

  // API capabilities
  try {
    const caps = await detectCaps(ctx, { force: true });
    caps.blockedByGql ? ok('GraphQL Issue.blockedBy', 'available (one query per tick)') : warn('GraphQL Issue.blockedBy', 'not in schema — falling back to REST dependencies per task', 'check docs; run doctor again later');
    caps.closedByPrs ? ok('GraphQL closedByPullRequestsReferences', 'available (active_pr guard)') : warn('GraphQL closedByPullRequestsReferences', 'not in schema — active_pr guard disabled');
  } catch (e) { bad('GraphQL', e.message); }

  // the last step — silent unless the board asked GitHub to take it (`merge.mode: "auto"`)
  await checkMergePolicy(ctx, { ok, bad });

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
  log(bad ? `\n${bad} problem(s). Fix them before \`hkb dispatch\`.` : '\nAll good. `hkb dispatch --loop 60` when ready.');
  return bad ? 1 : 0;
}

export { GhError, graphql };
