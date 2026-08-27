#!/usr/bin/env node
/**
 * wiki-install-hook.mjs — install (or remove) the post-commit wiki nudge.
 *
 *   node .repolore/scripts/wiki-install-hook.mjs              # install
 *   node .repolore/scripts/wiki-install-hook.mjs --uninstall  # remove
 *
 * Chaining-safe by construction:
 *   - respects `core.hooksPath` when set (husky, .githooks, …) — installs
 *     into the hooks directory the repo actually uses
 *   - appends a clearly marked block to an existing post-commit hook rather
 *     than replacing it; creates the file (executable) when absent
 *   - idempotent: re-running install never duplicates the block;
 *     --uninstall removes exactly the block and nothing else
 *
 * The installed block guards on node's presence and swallows every failure —
 * the nudge must never block a commit (see wiki-hook.mjs).
 *
 * Hooks are not cloned with repos: each contributor runs this once. The
 * pointer block and init/update reports carry the one-liner.
 *
 * Exit code: 0 on success/no-op, 2 on error.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { repoRoot, git, fail } from './lib.mjs';

const argv = process.argv.slice(2);
const UNINSTALL = argv.includes('--uninstall');

const BEGIN = '# >>> repolore wiki nudge (non-blocking) >>>';
const END = '# <<< repolore wiki nudge <<<';

const root = repoRoot();

const manifestPath = join(root, '.repolore', 'manifest.json');
if (!existsSync(manifestPath)) fail('no .repolore/manifest.json — initialize the wiki first');
const { scriptsDir } = JSON.parse(readFileSync(manifestPath, 'utf8'));

// The hooks dir the repo ACTUALLY uses: core.hooksPath when set, else .git/hooks.
let hooksDir;
let viaHooksPath = null;
try {
  viaHooksPath = git(root, ['config', 'core.hooksPath']);
} catch { /* unset */ }
if (viaHooksPath) {
  hooksDir = isAbsolute(viaHooksPath) ? viaHooksPath : join(root, viaHooksPath);
} else {
  const gitDir = git(root, ['rev-parse', '--git-dir']);
  hooksDir = join(isAbsolute(gitDir) ? gitDir : join(root, gitDir), 'hooks');
}
const hookFile = join(hooksDir, 'post-commit');

const block = [
  BEGIN,
  `command -v node >/dev/null 2>&1 && node "${scriptsDir}/wiki-hook.mjs" || true`,
  END,
].join('\n');

const current = existsSync(hookFile) ? readFileSync(hookFile, 'utf8') : null;

if (UNINSTALL) {
  if (current === null || !current.includes(BEGIN)) {
    console.log('repolore: no wiki nudge installed — nothing to remove.');
    process.exit(0);
  }
  const cleaned = current
    .split('\n')
    .reduce((acc, line) => {
      if (line === BEGIN) acc.skipping = true;
      else if (line === END) acc.skipping = false;
      else if (!acc.skipping) acc.lines.push(line);
      return acc;
    }, { lines: [], skipping: false })
    .lines.join('\n')
    .replace(/\n{3,}$/, '\n');
  writeFileSync(hookFile, cleaned);
  console.log(`repolore: wiki nudge removed from ${hookFile}`);
  process.exit(0);
}

if (current !== null && current.includes(BEGIN)) {
  console.log(`repolore: wiki nudge already installed in ${hookFile} — nothing to do.`);
  process.exit(0);
}

mkdirSync(hooksDir, { recursive: true });
if (current === null) {
  writeFileSync(hookFile, `#!/bin/sh\n${block}\n`);
} else {
  const sep = current.endsWith('\n') ? '' : '\n';
  writeFileSync(hookFile, `${current}${sep}${block}\n`);
}
chmodSync(hookFile, 0o755);

console.log(`repolore: post-commit wiki nudge installed → ${hookFile}${viaHooksPath ? '  (via core.hooksPath)' : ''}`);
console.log('  Non-blocking: prints only when pages go stale or new page-worthy files lack a page.');
console.log('  Remove anytime: node ' + join(scriptsDir, 'wiki-install-hook.mjs') + ' --uninstall');
process.exit(0);
