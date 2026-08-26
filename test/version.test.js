import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readVersion } from '../src/cli.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const bin = fileURLToPath(new URL('../bin/ghk.js', import.meta.url));
// Run from a neutral cwd so the version is resolved relative to the module, not the working directory.
const run = (...args) => execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: '/' });

test('readVersion matches package.json', () => {
  assert.equal(readVersion(), pkg.version);
});

test('ghk version prints the package.json version', () => {
  assert.equal(run('version'), `ghk ${pkg.version}\n`);
});

test('ghk version --json returns { version, node }', () => {
  assert.deepEqual(JSON.parse(run('version', '--json')), { version: pkg.version, node: process.version });
});
