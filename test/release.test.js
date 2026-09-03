// `.github/workflows/release.yml`: the tag → npm publish path, and the clean-room `npx hkb-cli@<version>`
// job that is the only proof the published artifact actually runs.
//
// Unlike the kanban workflows this one is not generated from `templates/actions/`, so there is no
// generator to test — the committed file is the artefact. It is checked two ways: structurally
// (parsed, not regexed) and, for the two steps that carry real logic, by running their shell with a
// stubbed PATH so the gate and the retry loop are exercised rather than described.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseYaml } from './yaml.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const REL = path.join('.github', 'workflows', 'release.yml');
const TEXT = fs.readFileSync(path.join(REPO, REL), 'utf8');
const DOC = parseYaml(TEXT);
const TEST_YML = parseYaml(fs.readFileSync(path.join(REPO, '.github', 'workflows', 'test.yml'), 'utf8'));

const step = (job, name) => DOC.jobs[job].steps.find((s) => s.id === name || s.name === name || s.uses === name);
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-release-'));

/**
 * Run one step's `run:` the way Actions does (`bash -e`), in a scratch cwd, with `$GITHUB_OUTPUT`
 * wired up and `bin` written onto the front of PATH as executable stubs.
 */
function runStep(script, { env = {}, bin = {}, files = {} } = {}) {
  const dir = scratch();
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  for (const [name, body] of Object.entries(bin)) {
    fs.writeFileSync(path.join(binDir, name), body);
    fs.chmodSync(path.join(binDir, name), 0o755);
  }
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  const outFile = path.join(dir, 'github_output');
  fs.writeFileSync(outFile, '');
  const r = spawnSync('bash', ['-e', '-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, GITHUB_OUTPUT: outFile, ...env },
  });
  const outputs = Object.fromEntries(
    fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, outputs };
}

// ---------- the trigger ----------

test('release.yml is valid YAML with nothing left unsubstituted', () => {
  assert.doesNotThrow(() => parseYaml(TEXT));
  assert.ok(!/\{\{\w+\}\}/.test(TEXT), 'a template placeholder survived into the workflow');
});

test('a release is a `v*` tag and nothing else — no cron, no manual publish', () => {
  assert.deepEqual(DOC.on, { push: { tags: ['v*'] } });
});

test('two publishes of one tag never overlap, and one in flight is never cancelled', () => {
  assert.equal(DOC.concurrency['cancel-in-progress'], false);
  assert.match(DOC.concurrency.group, /github\.ref/);
});

// ---------- the gates ----------

test('the publish job runs the same suite test.yml does, under both timezones', () => {
  const runs = DOC.jobs.publish.steps.filter((s) => s.run && !s.id);
  assert.deepEqual(runs.map((s) => s.run), ['npm run lint', 'npm test', 'npm test', 'npm run smoke']);
  assert.deepEqual(runs.slice(1, 3).map((s) => s.env.TZ), ['UTC', 'America/New_York']);
});

test('the tarball is packed and run before it is published, not after', () => {
  // This workflow re-runs the suite itself rather than depending on test.yml, so it has to re-run
  // the smoke too — otherwise the smoke gates pushes and pull requests but never a release.
  const smoke = TEST_YML.jobs.smoke;
  assert.ok(smoke, 'test.yml must still carry the smoke job this one mirrors');
  assert.ok(smoke.steps.some((s) => s.run === 'node scripts/smoke-pack.mjs'));
  const ids = DOC.jobs.publish.steps.map((s) => s.id || s.run || s.uses);
  assert.ok(ids.indexOf('npm run smoke') < ids.indexOf('publish'));
});

test('every gate stands before the publish step, never after it', () => {
  const ids = DOC.jobs.publish.steps.map((s) => s.id || s.run || s.uses);
  assert.ok(ids.indexOf('gate') < ids.indexOf('publish'));
  assert.ok(ids.indexOf('npm test') < ids.indexOf('publish'));
  assert.ok(ids.indexOf('runner') < ids.indexOf('publish'));
  assert.ok(ids.indexOf('preflight') < ids.indexOf('publish'));
});

test('a tag that matches package.json passes the gate and names the version downstream', () => {
  const r = runStep(step('publish', 'gate').run, {
    env: { GITHUB_REF_NAME: 'v1.4.0' },
    files: { 'package.json': JSON.stringify({ name: 'hkb', version: '1.4.0' }) },
  });
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(r.outputs, { version: '1.4.0' });
});

test('a tag that disagrees with package.json refuses to publish, and says both numbers', () => {
  const r = runStep(step('publish', 'gate').run, {
    env: { GITHUB_REF_NAME: 'v2.0.0' },
    files: { 'package.json': JSON.stringify({ name: 'hkb', version: '1.4.0' }) },
  });
  assert.equal(r.status, 1);
  assert.match(r.out, /::error::/);
  assert.match(r.out, /2\.0\.0/);
  assert.match(r.out, /1\.4\.0/);
  assert.match(r.out, /git push --delete origin v2\.0\.0/, 'the error must name the fix, not just the fault');
  assert.deepEqual(r.outputs, {}, 'a refused gate publishes no version');
});

test('the version output is the package version, not the tag text', () => {
  // `v1.4.0` and `1.4.0` are the same release; what npm publishes is package.json's number.
  assert.match(step('publish', 'gate').run, /GITHUB_REF_NAME#v/);
  assert.match(DOC.jobs.publish.outputs.version, /steps\.gate\.outputs\.version/);
});

// ---------- trusted publishing ----------

/** `npm --version` answers $NPM_VERSION; `npm install -g` is a no-op. `node -p` answers $NODE_VERSION. */
const npmStub = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "\${NPM_VERSION}"; fi
exit 0
`;
const nodeStub = '#!/usr/bin/env bash\necho "${NODE_VERSION}"\n';

const runRunner = (node, npm) =>
  runStep(step('publish', 'runner').run, {
    env: { NODE_VERSION: node, NPM_VERSION: npm },
    bin: { npm: npmStub, node: nodeStub },
  });

test('the runner is held to the versions trusted publishing needs, not the ones it happens to have', () => {
  // Node 22 bundles npm 10, so the step upgrades npm first — and then checks, because an npm that
  // stayed on 10 fails at publish time as "need auth", pointing at a token that no longer exists.
  assert.match(step('publish', 'runner').run, /npm install -g npm@latest/);

  const ok = runRunner('22.20.0', '11.6.0');
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, /node 22\.20\.0, npm 11\.6\.0/);
});

test('an old node or an old npm fails the release, and the error names the floor', () => {
  const oldNode = runRunner('22.13.0', '11.6.0');
  assert.equal(oldNode.status, 1);
  assert.match(oldNode.out, /::error::/);
  assert.match(oldNode.out, /22\.14\.0/);

  const oldNpm = runRunner('22.20.0', '10.9.3');
  assert.equal(oldNpm.status, 1);
  assert.match(oldNpm.out, /::error::/);
  assert.match(oldNpm.out, /11\.5\.1/);

  // 11.5.10 > 11.5.1 and 11.10.0 > 11.9.0: the comparison is by version, not by string.
  assert.equal(runRunner('22.20.0', '11.5.10').status, 0);
});

test('only the repository npm trusts publishes; a fork is told why, and stays green', () => {
  const pre = step('publish', 'preflight');
  const pkg = { 'package.json': JSON.stringify({ repository: { url: 'git+https://github.com/emyann/harness-kanban-board.git' } }) };

  const home = runStep(pre.run, { env: { GITHUB_REPOSITORY: 'emyann/harness-kanban-board' }, files: pkg });
  assert.equal(home.status, 0, home.out);
  assert.deepEqual(home.outputs, { ready: 'true' });

  const fork = runStep(pre.run, { env: { GITHUB_REPOSITORY: 'stranger/harness-kanban-board' }, files: pkg });
  assert.equal(fork.status, 0, 'a fork is a notice, not a red build — its tag and tests are still a signal');
  assert.match(fork.out, /::notice::/);
  assert.match(fork.out, /trusted publisher/);
  assert.match(fork.out, /stranger\/harness-kanban-board/, 'the notice must name the repository that ran, not just the one that may publish');
  assert.deepEqual(fork.outputs, { ready: 'false' });
});

test("the preflight reads the repository off package.json, so it is named once", () => {
  // If `repository.url` ever stops being a GitHub URL, the preflight silently stops matching and
  // every release turns into a notice. Check it against this repo's real package.json.
  const url = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).repository.url;
  assert.match(url.replace(/^.*github\.com[:/]/, '').replace(/\.git$/, ''), /^[\w.-]+\/[\w.-]+$/);
});

test('the publish step is gated on the preflight, so a fork or a fresh repo cannot publish', () => {
  assert.match(step('publish', 'publish').if, /steps\.preflight\.outputs\.ready == 'true'/);
});

// ---------- the publish ----------

test('the publish is provenance-signed, public, and authenticated by OIDC rather than a secret', () => {
  const pub = step('publish', 'publish');
  assert.match(pub.run, /npm publish --provenance --access public/);
  assert.equal(pub.env, undefined, 'the publish reads no environment: the credential comes from the OIDC exchange');
  assert.equal(DOC.jobs.publish.permissions['id-token'], 'write', 'trusted publishing is an OIDC exchange: without id-token there is no credential and no attestation');
  assert.equal(DOC.jobs.publish.permissions.contents, 'read', 'a release needs to read the repo and nothing more');
});

test('the workflow reads no npm secret at all — there is none to read', () => {
  // Comments may still say the words: the file explains what it stopped doing, and why.
  const code = TEXT.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/NPM_TOKEN|NODE_AUTH_TOKEN/.test(code), 'trusted publishing replaced the token; a live reference to one is a leftover');
  assert.ok(!/secrets\./.test(code), 'a release that needs a secret is a release a fork cannot reason about');
  // `registry-url` exists only to write an .npmrc that reads NODE_AUTH_TOKEN. With no token it would
  // hand npm a half-configured auth line to start the OIDC exchange from.
  assert.equal(step('publish', 'actions/setup-node@v7').with['registry-url'], undefined);
});

// ---------- the clean-room verify ----------

test('the verify job installs from the registry: no checkout, nothing from this repo', () => {
  const uses = DOC.jobs.verify.steps.map((s) => s.uses).filter(Boolean);
  assert.ok(!uses.some((u) => u.startsWith('actions/checkout')), 'a checkout would let the repo, not the tarball, satisfy the test');
  assert.equal(DOC.jobs.verify.needs, 'publish');
  assert.match(DOC.jobs.verify.if, /needs\.publish\.outputs\.published == 'true'/, 'nothing to verify when nothing was published');
  assert.equal(step('verify', 'npx hkb-cli@version').env.VERSION, '${{ needs.publish.outputs.version }}');
});

/** An `npx` that 404s `FAIL_TIMES` times, then prints `NPX_OUTPUT`. Counts its calls in $COUNTER. */
const npxStub = `#!/usr/bin/env bash
n=$(cat "$COUNTER" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$COUNTER"
if [ "$n" -le "\${FAIL_TIMES:-0}" ]; then echo "npm error 404 Not Found - GET hkb" >&2; exit 1; fi
echo "\${NPX_OUTPUT}"
`;
const noSleep = '#!/usr/bin/env bash\nexit 0\n';

function runVerify({ failTimes = 0, output = 'hkb 1.4.0', version = '1.4.0' } = {}) {
  const counter = path.join(scratch(), 'n');
  const r = runStep(step('verify', 'npx hkb-cli@version').run, {
    env: { VERSION: version, FAIL_TIMES: String(failTimes), NPX_OUTPUT: output, COUNTER: counter },
    bin: { npx: npxStub, sleep: noSleep },
  });
  const calls = Number(fs.readFileSync(counter, 'utf8').trim());
  fs.rmSync(path.dirname(counter), { recursive: true, force: true });
  return { ...r, calls };
}

test('verify passes when the published version installs and reports itself', () => {
  const r = runVerify();
  assert.equal(r.status, 0, r.out);
  assert.equal(r.calls, 2, 'both `version` and `help` are run against the published package');
  assert.match(r.out, /runs, and reports 1\.4\.0/);
});

test('verify rides out registry propagation instead of failing on the first 404', () => {
  const r = runVerify({ failTimes: 4 });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /attempt 4\/10/);
  assert.equal(r.calls, 6, '4 failures, then version and help');
});

test('verify gives up loudly, and inside five minutes', () => {
  const r = runVerify({ failTimes: 99 });
  assert.equal(r.status, 1);
  assert.equal(r.calls, 10, 'ten tries, 30s apart — bounded, not a hung job');
  assert.match(r.out, /::error::/);
  assert.match(r.out, /never succeeded in 5 minutes/);
  assert.match(step('verify', 'npx hkb-cli@version').run, /sleep 30/);
  assert.equal(DOC.jobs.verify['timeout-minutes'], 10, 'the job outlives the retry budget, so the give-up is what fails it');
});

test('a package that installs but reports the wrong version is a failure, not a pass', () => {
  const r = runVerify({ output: 'hkb 0.0.9' });
  assert.equal(r.status, 1);
  assert.match(r.out, /::error::/);
  assert.equal(r.calls, 1, 'a wrong answer is final — there is nothing to retry');
});

test('a longer version that merely contains the released one does not pass for it', () => {
  // `hkb 1.4.10` satisfies a substring test for 1.4.1 and must not satisfy this one.
  const r = runVerify({ version: '1.4.1', output: 'hkb 1.4.10' });
  assert.equal(r.status, 1);
  assert.match(r.out, /::error::/);
});

// ---------- the operator's page ----------

test('docs/releasing.md exists, and the one step left to a human is the tag', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'releasing.md'), 'utf8');
  assert.match(doc, /npm version/);
  assert.match(doc, /--follow-tags/);
  assert.ok(!/NPM_TOKEN/.test(doc), 'the token is gone; a doc that still asks for one sends the operator to make a secret nothing reads');
});

test('docs/releasing.md writes down the trusted publisher, which is invisible from the repo', () => {
  // It lives in npmjs.com's settings, so a failing publish has nothing in-tree to read unless this
  // page records what the four fields are set to — and that the filename is part of the identity.
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'releasing.md'), 'utf8');
  assert.match(doc, /[Tt]rusted [Pp]ublisher/);
  assert.match(doc, /release\.yml/);
  assert.match(doc, /harness-kanban-board/);
  assert.match(doc, /11\.5\.1/, 'the npm floor is the thing to check when a publish fails on auth');
});
