// "Your hkb is old": the once-a-day npm check, in doctor and in the dispatcher loop.
//
// Nothing here reaches the network — `setRegistryFetch` stands in for the one GET, the way
// `setTransport` stands in for `gh` — and nothing reads the process clock or its timezone: every
// instant is written out and the stamping cases are replayed in several zones, because a daily
// stamp that follows the local calendar makes two hosts on one board probe twice and skip a day.
//
// The case this file exists for is at the bottom: a stale CLI ships a stale *packaged* skill, so
// the skill check goes green while the install is months behind. That green is the bug.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VERSION_CHECK, versionFinding, versionCheckEnabled, upgradeCommand,
  dailyLatest, checkVersion, versionNotice, checkSkill,
} from '../src/doctor.js';
import { latestVersion, setRegistryFetch, REGISTRY, PACKAGE } from '../src/registry.js';
import { packageVersion, packageSkillDir } from '../src/init.js';
import { DEFAULT_BOARD } from '../src/board.js';
import { loop } from '../src/dispatch.js';
import { main } from '../src/cli.js';
import { FakeGh, kbIssue } from './fake-gh.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.parse('2026-08-26T12:00:00Z');
const INSTALLED = packageVersion();
/** Two versions nothing will ever publish, so the comparisons stay true after every release. */
const NEWER = '99.9.9';
const OLDER = '0.0.1';
const UPGRADE = 'npm i -g hkb-cli@latest && hkb init';

const ZONES = ['UTC', 'America/New_York', 'Asia/Kolkata', 'Pacific/Kiritimati'];
async function inEachZone(fn) {
  const before = process.env.TZ;
  try {
    for (const tz of ZONES) { process.env.TZ = tz; await fn(tz); }
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
}

const roots = [];
after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
function tmpRoot({ board = true, cfg = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-update-'));
  roots.push(root);
  if (board) {
    fs.mkdirSync(path.join(root, '.kanban'), { recursive: true });
    fs.writeFileSync(path.join(root, '.kanban', 'board.json'), JSON.stringify({ ...DEFAULT_BOARD, repo: 'acme/board', ...cfg }));
  }
  return root;
}
const stateOf = (root) => JSON.parse(fs.readFileSync(path.join(root, '.kanban', 'state.json'), 'utf8'));
const hasState = (root) => fs.existsSync(path.join(root, '.kanban', 'state.json'));
/** A context of the shape every caller here needs: a checkout root and the board's config. */
const ctxOf = (root, cfg = { ...DEFAULT_BOARD }) => ({ root, cfg });

/** The registry GET, stubbed. Records every call so a test can assert there was none. */
function registry({ latest = NEWER, fail = null, body = undefined } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, ...opts });
    if (fail) throw fail;
    return body === undefined ? { 'dist-tags': { latest }, name: PACKAGE } : body;
  };
  fn.calls = calls;
  return fn;
}
/** Install a stubbed registry for one test. */
function withRegistry(t, opts) {
  const fn = registry(opts);
  t.after(setRegistryFetch(fn));
  return fn;
}

function sink() {
  const results = [];
  return {
    results,
    ok: (name, detail) => results.push({ name, ok: true, detail }),
    bad: (name, detail, fix) => results.push({ name, ok: false, detail, fix }),
    warn: (name, detail, fix) => results.push({ name, ok: null, detail, fix }),
  };
}

// ---------- the registry read ----------

test('one GET of the package document, and dist-tags.latest is all it takes from it', async (t) => {
  const r = withRegistry(t, { latest: '1.2.3' });
  assert.equal(await latestVersion(), '1.2.3');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, `${REGISTRY}/${PACKAGE}`);
  assert.ok(r.calls[0].timeout > 0, 'nothing waits on npm without a bound');
});

test('a registry that answers something else is no answer at all, never a wrong one', async (t) => {
  withRegistry(t, { body: { name: PACKAGE, versions: {} } });
  await assert.rejects(() => latestVersion(), /dist-tags\.latest/);
});

// ---------- the finding ----------

test('behind npm is a warning that names both versions and the upgrade', () => {
  const f = versionFinding('0.1.4', '0.2.0');
  assert.deepEqual(f, { name: VERSION_CHECK, ok: null, detail: '0.1.4 installed, npm has 0.2.0', fix: UPGRADE });
});

test('current, and ahead of the registry, are both facts rather than problems', () => {
  assert.deepEqual(versionFinding('0.2.0', '0.2.0'), { name: VERSION_CHECK, ok: true, detail: '0.2.0 (latest)' });
  // a git checkout, or a release in flight: the tree is newer than what npm has, and that is fine
  assert.deepEqual(versionFinding('0.3.0', '0.2.0'), { name: VERSION_CHECK, ok: true, detail: '0.3.0 (npm has 0.2.0)' });
});

test('no answer says the version and stops — offline is not a failure', () => {
  assert.deepEqual(versionFinding('0.1.4', null), { name: VERSION_CHECK, ok: true, detail: '0.1.4' });
  const off = versionFinding('0.1.4', null, { off: true });
  assert.equal(off.ok, true);
  assert.match(off.detail, /^0\.1\.4 — daily update check off/);
});

test('a version pair that cannot be compared warns about nothing and hides nothing', () => {
  // "0.1.4-rc.1" vs a tag npm could carry: not orderable, so it is reported, not judged
  assert.deepEqual(versionFinding('0.1.4', 'canary'), { name: VERSION_CHECK, ok: true, detail: '0.1.4 (npm has canary)' });
});

test('there is no `hkb update`: the fix is the two commands, spelled for how this hkb was installed', () => {
  assert.equal(upgradeCommand('/usr/local/lib/node_modules/hkb-cli/'), UPGRADE);
  assert.equal(upgradeCommand('/home/dev/.npm/_npx/2f3a/node_modules/hkb-cli/'), 'npx -y hkb-cli@latest init');
  // the second command is not decoration: a new CLI ships a new skill, and init is what copies it
  assert.match(UPGRADE, /hkb init$/);
});

test('the opt-out is one key in board.json, and only an explicit false turns it off', () => {
  assert.equal(versionCheckEnabled(null), true, 'a checkout with no board.json still gets told');
  assert.equal(versionCheckEnabled({}), true);
  assert.equal(versionCheckEnabled({ version_check: true }), true);
  assert.equal(versionCheckEnabled({ version_check: false }), false);
  assert.equal(DEFAULT_BOARD.version_check, true, 'on by default: a pinned install opts out, nobody opts in');
});

// ---------- once a day, and never twice ----------

test('the first run of the day probes and stamps; the rest of the day is free', async (t) => {
  const root = tmpRoot();
  const r = withRegistry(t, { latest: NEWER });

  const first = await dailyLatest(ctxOf(root), { now: NOW });
  assert.deepEqual({ latest: first.latest, checked: first.checked }, { latest: NEWER, checked: true });
  assert.equal(r.calls.length, 1);
  assert.equal(stateOf(root).version_check_day, '2026-08-26');
  assert.equal(stateOf(root).version_latest, NEWER, 'the answer is stamped too, not just the day');

  const again = await dailyLatest(ctxOf(root), { now: NOW + HOUR });
  assert.equal(r.calls.length, 1, 'same day: no second call');
  assert.deepEqual({ latest: again.latest, checked: again.checked }, { latest: NEWER, checked: false },
    'and the stamped answer is still available to report');

  await dailyLatest(ctxOf(root), { now: NOW + DAY });
  assert.equal(r.calls.length, 2, 'next day: it asks again');
  assert.equal(stateOf(root).version_check_day, '2026-08-27');
});

test('a registry that cannot be reached is silent and stamps nothing, so the next run retries', async (t) => {
  const root = tmpRoot();
  const r = withRegistry(t, { fail: Object.assign(new Error('getaddrinfo ENOTFOUND registry.npmjs.org'), { code: 'ENOTFOUND' }) });

  const out = await dailyLatest(ctxOf(root), { now: NOW });
  assert.deepEqual(out, { latest: null, checked: false, off: false });
  assert.equal(hasState(root), false, 'nothing stamped');
  await dailyLatest(ctxOf(root), { now: NOW + HOUR });
  assert.equal(r.calls.length, 2, 'it tries again rather than waiting out the day it never checked');
});

test('the day stamp is a UTC day, so two hosts in two zones still probe once between them', async (t) => {
  withRegistry(t, { latest: NEWER });
  await inEachZone(async (tz) => {
    const root = tmpRoot();
    await dailyLatest(ctxOf(root), { now: Date.parse('2026-08-26T02:30:00Z') });
    assert.equal(stateOf(root).version_check_day, '2026-08-26', tz);
  });
});

test('the stamp joins the state the dispatcher already keeps, and never replaces it', async (t) => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, '.kanban', 'state.json'), JSON.stringify({ spawn_day: '2026-08-26', spawned_today: 3, token_expiry_day: '2026-08-26' }));
  withRegistry(t, { latest: NEWER });
  await dailyLatest(ctxOf(root), { now: NOW });
  assert.deepEqual(stateOf(root), {
    spawn_day: '2026-08-26', spawned_today: 3, token_expiry_day: '2026-08-26',
    version_check_day: '2026-08-26', version_latest: NEWER,
  });
});

test('a checkout that was never `hkb init`ed is not given a .kanban directory by this check', async (t) => {
  const root = tmpRoot({ board: false });
  withRegistry(t, { latest: NEWER });
  const out = await dailyLatest({ root, cfg: null }, { now: NOW });
  assert.equal(out.latest, NEWER, 'it still answers');
  assert.equal(fs.existsSync(path.join(root, '.kanban')), false, 'but it leaves nothing behind');
});

test('"version_check": false asks npm nothing, ever', async (t) => {
  const root = tmpRoot();
  const r = withRegistry(t, { latest: NEWER });
  const out = await dailyLatest(ctxOf(root, { ...DEFAULT_BOARD, version_check: false }), { now: NOW });
  assert.deepEqual(out, { latest: null, checked: false, off: true });
  assert.equal(r.calls.length, 0);
  assert.equal(hasState(root), false);
});

// ---------- doctor ----------

test('doctor names the installed version, what npm has, and the two commands', async (t) => {
  const root = tmpRoot();
  withRegistry(t, { latest: NEWER });
  const s = sink();
  await checkVersion(ctxOf(root), s, { now: NOW });
  assert.deepEqual(s.results, [{ name: VERSION_CHECK, ok: null, detail: `${INSTALLED} installed, npm has ${NEWER}`, fix: UPGRADE }]);
});

test('a current install gets one green line, and the second doctor of the day costs no call', async (t) => {
  const root = tmpRoot();
  const r = withRegistry(t, { latest: INSTALLED });
  const first = sink();
  await checkVersion(ctxOf(root), first, { now: NOW });
  assert.deepEqual(first.results, [{ name: VERSION_CHECK, ok: true, detail: `${INSTALLED} (latest)` }]);

  const second = sink();
  await checkVersion(ctxOf(root), second, { now: NOW + HOUR });
  assert.equal(r.calls.length, 1, 'the stamped answer is what the second run reports');
  assert.deepEqual(second.results, first.results);
});

test('doctor on a pinned board says the version once, and does not warn about a deliberate choice', async (t) => {
  const root = tmpRoot();
  const r = withRegistry(t, { latest: NEWER });
  const s = sink();
  await checkVersion(ctxOf(root, { ...DEFAULT_BOARD, version_check: false }), s, { now: NOW });
  assert.equal(r.calls.length, 0);
  assert.equal(s.results[0].ok, true);
  assert.match(s.results[0].detail, new RegExp(`^${INSTALLED} — daily update check off`));
});

test('doctor offline says the version and nothing else — exactly what it did before this check existed', async (t) => {
  const root = tmpRoot();
  withRegistry(t, { fail: new Error('offline') });
  const s = sink();
  await checkVersion(ctxOf(root), s, { now: NOW });
  assert.deepEqual(s.results, [{ name: VERSION_CHECK, ok: true, detail: INSTALLED }]);
});

// ---------- the dispatcher loop ----------

/** The loop's notice with the clock injected, the way the token one is tested. */
async function notice(root, { now = NOW, cfg = { ...DEFAULT_BOARD } } = {}) {
  const lines = [];
  const finding = await versionNotice({ root, cfg }, (s) => lines.push(s), { now });
  return { finding, lines };
}

test('the loop is told once a day, and only when there is something to say', async (t) => {
  const root = tmpRoot();
  const r = withRegistry(t, { latest: NEWER });

  const first = await notice(root);
  assert.equal(first.lines.length, 1);
  assert.equal(first.lines[0], `${VERSION_CHECK}: ${INSTALLED} installed, npm has ${NEWER} → ${UPGRADE}`);

  assert.deepEqual((await notice(root, { now: NOW + HOUR })).lines, [], 'the rest of the day is quiet');
  assert.equal(r.calls.length, 1);
  assert.equal((await notice(root, { now: NOW + DAY })).lines.length, 1, 'and it says it again tomorrow');
});

test('a loop on a current install, offline, or pinned never says a word', async (t) => {
  const current = withRegistry(t, { latest: INSTALLED });
  assert.deepEqual((await notice(tmpRoot())).lines, []);
  assert.equal(current.calls.length, 1, 'it did ask — it just had nothing to report');

  const older = withRegistry(t, { latest: OLDER });
  assert.deepEqual((await notice(tmpRoot())).lines, [], 'ahead of npm is not a warning either');
  assert.equal(older.calls.length, 1);

  withRegistry(t, { fail: new Error('offline') });
  const off = tmpRoot();
  assert.deepEqual((await notice(off)).lines, []);
  assert.equal(hasState(off), false);

  const pinned = withRegistry(t, { latest: NEWER });
  assert.deepEqual((await notice(tmpRoot(), { cfg: { ...DEFAULT_BOARD, version_check: false } })).lines, []);
  assert.equal(pinned.calls.length, 0);
});

test('a dispatcher loop says it on its first tick of the day and on no other tick', async (t) => {
  const gh = new FakeGh();
  gh.addIssue(kbIssue({ number: 1, title: 'a card nobody claims', status: 'todo' }));
  t.after(gh.install());
  const r = withRegistry(t, { latest: NEWER });
  const root = tmpRoot();
  const ctx = {
    root,
    cfg: { ...DEFAULT_BOARD, repo: gh.nameWithOwner, profiles: {} },
    repo: { owner: gh.owner, repo: gh.repo, nameWithOwner: gh.nameWithOwner },
    board: 'default', host: 'test-host', json: false, caps: {}, _cache: {}, requireBoard() { return this; },
  };

  const lines = [];
  const enough = new Error('two ticks is the test');
  let waits = 0;
  const sleeper = async () => { if (++waits >= 3) throw enough; };
  await assert.rejects(() => loop(ctx, { interval: 60, max: Infinity, log: (s) => lines.push(s), sleeper }), (e) => e === enough);

  assert.equal(lines.filter((l) => l.startsWith('tick:')).length, 3, 'three ticks ran');
  const said = lines.filter((l) => l.startsWith(`${VERSION_CHECK}:`));
  assert.deepEqual(said, [`${VERSION_CHECK}: ${INSTALLED} installed, npm has ${NEWER} → ${UPGRADE}`]);
  assert.equal(r.calls.length, 1, 'one registry call for the whole day, whatever the interval');
  assert.equal(stateOf(root).version_check_day, new Date(Date.now()).toISOString().slice(0, 10));
});

// ---------- never on the hot path ----------

test('an ordinary command asks npm nothing: `hkb list` makes no registry call', async (t) => {
  const gh = new FakeGh();
  gh.addIssue(kbIssue({ number: 1, title: 'ready to go', status: 'ready', agent: 'claude' }));
  t.after(gh.install());
  const r = withRegistry(t, { latest: NEWER });
  const root = tmpRoot();
  const cwd = process.cwd();
  const write = process.stdout.write.bind(process.stdout);
  let printed = '';
  process.stdout.write = (s) => { printed += s; return true; };
  process.chdir(root);
  t.after(() => { process.stdout.write = write; process.chdir(cwd); });

  await main(['list']);

  assert.match(printed, /ready to go/, 'the command did run');
  assert.equal(r.calls.length, 0, 'and it did not make anyone wait on npm to run it');
  assert.equal(hasState(root), false);
});

// ---------- the compound case this card exists for ----------

test('a stale CLI whose packaged skill matches the installed one still produces a notice', async (t) => {
  // The false green: `checkSkill` compares the installed copy against the *packaged* one, and an
  // hkb from six months ago packages a six-month-old skill — so the two agree, the skill line is
  // green, and nothing at all says the install is behind. That is the bug this check closes.
  const root = tmpRoot();
  const dir = path.join(root, '.agents', 'skills', 'kanban');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(packageSkillDir(), 'SKILL.md'), path.join(dir, 'SKILL.md'));
  withRegistry(t, { latest: NEWER });

  const s = sink();
  const ctx = ctxOf(root);
  checkSkill(ctx, s);
  await checkVersion(ctx, s, { now: NOW });

  assert.deepEqual(s.results.map((f) => [f.name, f.ok]), [['skill', true], [VERSION_CHECK, null]],
    'the skill check is green and the version check is not — without the second, doctor says "All good"');
  assert.equal(s.results[1].fix, UPGRADE, 'and the fix re-copies the skill as well as replacing the CLI');
});
