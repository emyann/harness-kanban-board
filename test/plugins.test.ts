import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { checkPluginPath, pluginList, resolvePlugins } = await import('../src/plugins.ts');

/**
 * Plugin grants (ADR-012): how a repository's own skills reach a worker, and the two fences that
 * decide what a grant may name.
 *
 * Every assertion is a refusal or a containment check. The grant is resolved into an absolute path
 * with no agent in the loop and handed to a runtime that will load code from it, so this is the
 * module where a permissive answer is the expensive one.
 */

test('a grant is repo-relative, and every spelling of "somewhere else" is refused', () => {
  assert.equal(checkPluginPath('.claude'), '.claude');
  assert.equal(checkPluginPath(' .claude/ '), '.claude', 'trimmed, and a trailing slash means nothing to a directory');
  assert.equal(checkPluginPath('tools/plugins/mine'), 'tools/plugins/mine');

  for (const bad of ['', '   ', '/etc', '/', '../elsewhere', '..', '.', './', '.git', '.git/hooks', '.hkb', '.hkb/worktrees']) {
    assert.throws(
      () => checkPluginPath(bad),
      (e: Error & { exitCode?: number }) => e.exitCode === 2 && /plugin path/.test(e.message),
      `${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('the repository root is refused with the reason, because it was measured to load nothing', () => {
  assert.throws(() => checkPluginPath('.'), /CONTAINS `skills\/`/,
    'the error names the directory that works, since "it silently loaded nothing" is the failure this prevents');
});

test('pluginList survives whatever is in the Json column', () => {
  assert.deepEqual(pluginList(['.claude']), ['.claude']);
  assert.equal(pluginList(null), null, 'null is "nobody said", which is what lets a board default answer');
  assert.deepEqual(pluginList([]), [], 'an EMPTY list is a value: grant this Job nothing');
  assert.equal(pluginList('.claude'), null, 'a bare string is not a list of grants');
  assert.deepEqual(pluginList([1, '', '  ', ' ok ']), ['ok']);
});

test('a grant resolves against the repository, and one that escapes it is REFUSED', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-plug-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-out-')));
  fs.mkdirSync(path.join(root, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'skills'), { recursive: true });

  assert.deepEqual(resolvePlugins(root, ['.claude']).paths, [path.join(root, '.claude')]);

  // The half a syntax rule cannot make. `escape` passes `checkPluginPath` — it has no `..` in it —
  // and points out of the repository once the link is followed. Without the realpath check, a
  // repository could grant hkb any directory on the machine by committing one symlink.
  fs.symlinkSync(outside, path.join(root, 'escape'));
  const got = resolvePlugins(root, ['escape']);
  assert.deepEqual(got.paths, [], 'a symlink out of the repository grants nothing');
  assert.deepEqual(got.dropped, ['escape']);
});

test('a grant that is a file, or is gone, is dropped rather than fatal', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-plug2-')));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, 'notadir'), 'x');

  const got = resolvePlugins(root, ['.claude', 'notadir', 'never-existed']);
  assert.deepEqual(got.paths, [path.join(root, '.claude')]);
  assert.deepEqual(got.dropped, ['notadir', 'never-existed'],
    'a board outlives the directories it names — a missing grant must not strand the Job');
});

test('no grant is not an empty grant', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hkb-plug3-')));
  assert.deepEqual(resolvePlugins(root, null), { paths: [], dropped: [] });
  assert.deepEqual(resolvePlugins(root, []), { paths: [], dropped: [] });
  // A repository that has gone entirely: everything granted is dropped, nothing is resolved, and
  // the caller still gets a usable answer rather than a throw from inside a reconcile pass.
  assert.deepEqual(resolvePlugins(path.join(root, 'gone'), ['.claude']), { paths: [], dropped: ['.claude'] });
});
