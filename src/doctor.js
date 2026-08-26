// `hkb doctor [--api]` — check everything before the first dispatch; never guess.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ghAuthStatus, rest, graphql, GhError, API_VERSION } from './gh.js';
import { boardFile, api } from './board.js';
import { detectCaps } from './tasks.js';
import { L, STATUSES, compareVersions } from './model.js';
import { classifyClaimError, casHeartbeat, dropBeatChain, remoteName } from './lock.js';
import { agentsSkillDir, packageSkillDir, readSkillVersion } from './init.js';
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
  }
  checkSkill(ctx, { ok, warn });
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

  // rate limit
  try {
    const rl = await rest('GET', 'rate_limit');
    const core = rl.resources?.core, gql = rl.resources?.graphql;
    ok('rate limit', `REST ${core?.remaining}/${core?.limit} · GraphQL ${gql?.remaining}/${gql?.limit} (resets ${new Date(core?.reset * 1000).toLocaleTimeString()})`);
    if (core?.limit && core.limit < 5000) warn('token type', `REST limit ${core.limit}/h — a fine-grained PAT or user token gives 5000/h`);
  } catch (e) { warn('rate limit', e.message); }

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
