import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillVersion, compareVersions } from '../src/model.js';
import { agentsSkillDir, isPackageRepo, linkSkill, copySkill, readSkillVersion, packageSkillDir, claudeCommandsDir, commandNames, installCommands } from '../src/init.js';
import { checkSkill, checkCommands } from '../src/doctor.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));

/** Run doctor's skill check against a root and return the single {name, ok, detail, fix} it reports. */
function skillCheck(root, cfg = {}) {
  const out = [];
  checkSkill({ root, cfg }, {
    ok: (name, detail) => out.push({ name, ok: true, detail }),
    warn: (name, detail, fix) => out.push({ name, ok: null, detail, fix }),
  });
  assert.equal(out.length, 1);
  return out[0];
}

function installCopy(root, version) {
  const dir = agentsSkillDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: kanban\nmetadata:\n  version: ${version}\n---\nbody\n`);
  return dir;
}

function tmpRepo(pkgName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-skill-'));
  if (pkgName) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: pkgName }));
  fs.mkdirSync(path.join(root, 'skills', 'kanban'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'kanban', 'SKILL.md'), '---\nname: kanban\nmetadata:\n  version: 9.9.9\n---\nlocal\n');
  return root;
}

test('parseSkillVersion reads metadata.version from front matter', () => {
  assert.equal(parseSkillVersion('---\nname: k\nmetadata:\n  author: hkb\n  version: 0.1.0\nallowed-tools: x\n---\nbody'), '0.1.0');
  assert.equal(parseSkillVersion('---\nmetadata:\n  version: "1.2.3"\n---\n'), '1.2.3');
  assert.equal(parseSkillVersion("---\nmetadata:\n  version: '1.2.3' # note\n---\n"), '1.2.3');
});

test('parseSkillVersion: no front matter, no metadata, version outside metadata → null', () => {
  assert.equal(parseSkillVersion('# just a doc'), null);
  assert.equal(parseSkillVersion('---\nname: k\n---\nbody'), null);
  assert.equal(parseSkillVersion('---\nmetadata:\n  author: hkb\nversion: 2.0.0\n---\n'), null); // dedent ends the mapping
  assert.equal(parseSkillVersion(null), null);
});

test('parseSkillVersion reads the shipped SKILL.md', () => {
  assert.match(readSkillVersion(packageSkillDir()), /^\d+\.\d+\.\d+$/);
});

test('compareVersions orders dotted numbers and refuses the rest', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.1.0', '0.2.0'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1', '1.0.0'), 0);
  assert.equal(compareVersions('v1.2.0', '1.3.0'), -1);
  assert.equal(compareVersions('1.2.0-rc.1', '1.2.0'), 0); // pre-release suffixes are ignored, not ranked
  assert.equal(compareVersions('nightly', '1.0.0'), null);
  assert.equal(compareVersions(null, '1.0.0'), null);
});

test('isPackageRepo is true only for a root package.json named hkb that ships the skill', () => {
  assert.equal(isPackageRepo(REPO), true);
  assert.equal(isPackageRepo(tmpRepo('some-app')), false);
  assert.equal(isPackageRepo(tmpRepo(null)), false);

  const impostor = tmpRepo('hkb');
  fs.rmSync(path.join(impostor, 'skills'), { recursive: true });
  assert.equal(isPackageRepo(impostor), false, 'no skills/kanban to link to — must fall back to a copy');
});

test('linkSkill replaces a stale copy with a relative symlink and is idempotent', () => {
  const root = tmpRepo('hkb');
  const link = agentsSkillDir(root);
  fs.mkdirSync(link, { recursive: true });
  fs.writeFileSync(path.join(link, 'SKILL.md'), 'stale copy\n');
  fs.writeFileSync(path.join(link, 'gone-in-the-source.md'), 'x\n');

  assert.equal(linkSkill(root), 'linked');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), path.join('..', '..', 'skills', 'kanban'));
  assert.equal(fs.readFileSync(path.join(link, 'SKILL.md'), 'utf8').trim().endsWith('local'), true);
  assert.equal(fs.existsSync(path.join(link, 'gone-in-the-source.md')), false);

  assert.equal(linkSkill(root), 'already-linked');
  assert.equal(fs.readlinkSync(link), path.join('..', '..', 'skills', 'kanban'));
});

test('copySkill replaces a link with a real copy and returns the installed version', () => {
  const root = tmpRepo('some-app');
  linkSkill(root); // pretend an earlier init linked it
  const version = copySkill(root);
  const dir = agentsSkillDir(root);
  assert.equal(fs.lstatSync(dir).isSymbolicLink(), false);
  assert.equal(version, readSkillVersion(packageSkillDir()));
  assert.equal(fs.existsSync(path.join(dir, 'references', 'protocol.md')), true);
});

test('copySkill drops files the new version no longer ships', () => {
  const root = tmpRepo('some-app');
  const dir = agentsSkillDir(root);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'ghk'), '#!/bin/sh\n'); // the pre-rename shim
  copySkill(root);
  assert.equal(fs.existsSync(path.join(dir, 'scripts', 'ghk')), false);
  assert.equal(fs.existsSync(path.join(dir, 'scripts', 'hkb')), true);
});

test('doctor warns when the installed copy is older than the packaged skill', () => {
  const root = tmpRepo('some-app');
  installCopy(root, '0.0.9');
  const r = skillCheck(root, { skill_version: '0.0.9' });
  assert.equal(r.ok, null);
  assert.match(r.detail, /is v0\.0\.9, hkb ships v/);
  assert.equal(r.fix, 'hkb init');
});

test('doctor is quiet for an up-to-date copy, and for one newer than the package', () => {
  const current = readSkillVersion(packageSkillDir());
  const up = tmpRepo('some-app');
  installCopy(up, current);
  assert.equal(skillCheck(up, { skill_version: current }).ok, true);

  const ahead = tmpRepo('some-app');
  installCopy(ahead, '99.0.0');
  assert.equal(skillCheck(ahead).ok, true); // a newer copy is the user's business, not a fault
});

test('doctor falls back to board.json when the copy has no version, and flags a missing skill', () => {
  const root = tmpRepo('some-app');
  const dir = agentsSkillDir(root);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# no front matter\n');
  assert.match(skillCheck(root, { skill_version: '0.0.1' }).detail, /is v0\.0\.1, hkb ships v/);

  const bare = tmpRepo('some-app');
  const missing = skillCheck(bare);
  assert.equal(missing.ok, null);
  assert.equal(missing.detail, 'not installed');
});

test('doctor reports a linked skill as always current, whatever board.json says', () => {
  const root = tmpRepo('hkb');
  linkSkill(root);
  const r = skillCheck(root, { skill_version: '0.0.1' });
  assert.equal(r.ok, true);
  assert.match(r.detail, /linked, always current/);
});

// ---------- the planning commands the skill documents (#92) ----------
// Same install rule as the skill, one level down: hkb's own repo links, everybody else gets a copy —
// and doctor is what tells a repo that the slash commands SKILL.md names are not registered there.

/** doctor's command check against a root, as the single {name, ok, detail, fix} it reports. */
function commandCheck(root) {
  const out = [];
  checkCommands({ root }, {
    ok: (name, detail) => out.push({ name, ok: true, detail }),
    warn: (name, detail, fix) => out.push({ name, ok: null, detail, fix }),
  });
  assert.equal(out.length, 1);
  return out[0];
}

test('installCommands copies into .claude/commands/kanban, and is idempotent', () => {
  const root = tmpRepo('some-app');
  const first = installCommands(root);
  assert.equal(first.how, 'copied');
  assert.deepEqual(first.names, commandNames());
  assert.equal(fs.lstatSync(claudeCommandsDir(root)).isSymbolicLink(), false, 'an adopter gets a copy: a link would point into a package they may uninstall');
  assert.equal(installCommands(root).how, 'unchanged', 'a re-run must not rewrite files that already match');
});

test('doctor warns when the commands the skill documents are not registered (#92)', () => {
  const root = tmpRepo('some-app');
  const missing = commandCheck(root);
  assert.equal(missing.ok, null);
  assert.equal(missing.detail, '/kanban:decompose, /kanban:specify not registered — the skill documents them');
  assert.equal(missing.fix, 'hkb init');

  installCommands(root);
  assert.equal(commandCheck(root).ok, true);
});

test('this repo self-hosts its commands too: .claude/commands/kanban links to commands/ (#92)', () => {
  const dir = claudeCommandsDir(REPO);
  assert.equal(fs.lstatSync(dir).isSymbolicLink(), true, 'a copy in the package repo would be a second source of truth');
  assert.equal(fs.readlinkSync(dir), path.join('..', '..', 'commands'));
  assert.equal(commandCheck(REPO).ok, true, 'the commands have to be registered in the repo that documents them');
});

test('this repo self-hosts: .agents/skills/kanban is a link to skills/kanban', () => {
  const dir = agentsSkillDir(REPO);
  assert.equal(fs.lstatSync(dir).isSymbolicLink(), true, '.agents/skills/kanban must be a symlink, not a copy');
  assert.equal(fs.readlinkSync(dir), path.join('..', '..', 'skills', 'kanban'));
  assert.equal(
    fs.readFileSync(path.join(dir, 'references', 'protocol.md'), 'utf8'),
    fs.readFileSync(path.join(REPO, 'skills', 'kanban', 'references', 'protocol.md'), 'utf8'),
  );
});
