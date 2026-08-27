// `hkb doctor [--api]` — check everything before the first dispatch; never guess.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ghAuthStatus, rest, restRaw, graphql, GhError, API_VERSION } from './gh.js';
import { boardFile, api, readState, writeState } from './board.js';
import { detectCaps } from './tasks.js';
import { L, STATUSES, compareVersions } from './model.js';
import { classifyClaimError, casHeartbeat, dropBeatChain, remoteName } from './lock.js';
import { agentsSkillDir, packageSkillDir, readSkillVersion, harnessFiles, actionsFiles, HARNESS_PROFILE } from './init.js';
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
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ctx.root, '.claude', 'settings.json'), 'utf8'));
    const hook = (s.hooks?.Stop || []).some((h) => JSON.stringify(h).includes('hook stop'));
    hook ? ok('stop hook', '.claude/settings.json') : warn('stop hook', 'not configured — workers that exit without a terminal verb are only caught by the dispatcher', 'hkb init');
  } catch { warn('stop hook', '.claude/settings.json missing/unreadable', 'hkb init'); }

  if (!ctx.repo) return report(results, ctx, log);

  // labels
  try {
    const labels = new Set();
    for (let page = 1; page <= 3; page++) { const b = await rest('GET', api(ctx, `/labels?per_page=100&page=${page}`)); for (const l of b || []) labels.add(l.name); if (!b || b.length < 100) break; }
    const missing = [...STATUSES.map(L.status), L.board(ctx.board), L.needsHuman].filter((l) => !labels.has(l));
    missing.length ? bad('labels', `missing ${missing.join(', ')}`, 'hkb init') : ok('labels', `${[...labels].filter((l) => l.startsWith('kb:')).length} kb:* labels`);
  } catch (e) { bad('labels', e.message); }

  // rate limit, token class, token expiry — one call
  await checkToken({ ok, warn, bad });

  // API capabilities
  try {
    const caps = await detectCaps(ctx, { force: true });
    caps.blockedByGql ? ok('GraphQL Issue.blockedBy', 'available (one query per tick)') : warn('GraphQL Issue.blockedBy', 'not in schema — falling back to REST dependencies per task', 'check docs; run doctor again later');
    caps.closedByPrs ? ok('GraphQL closedByPullRequestsReferences', 'available (active_pr guard)') : warn('GraphQL closedByPullRequestsReferences', 'not in schema — active_pr guard disabled');
  } catch (e) { bad('GraphQL', e.message); }

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
