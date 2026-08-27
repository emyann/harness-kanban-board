#!/usr/bin/env node
/**
 * wiki-coverage.mjs — inverted freshness for the LLM-maintained wiki.
 *
 * wiki-check.mjs answers "did a file a page already lists change?" — it is
 * blind to source files that NO page lists, so a whole feature can ship with
 * no page while every check stays green. This script inverts the question:
 * enumerate the in-scope source files (from the `scope:` block in
 * wiki.config.yml) and report which ones no page `covers`.
 *
 * The wiki is a distillation, so uncovered ≠ broken — but a *cluster* of
 * uncovered files in a "page-worthy" directory (routes/, services/, ...) is
 * the strongest "missing or under-scoped page" signal there is.
 *
 *   node wiki-coverage.mjs                       # full coverage report
 *   node wiki-coverage.mjs --all                 # list every uncovered file
 *   node wiki-coverage.mjs --json                # machine-readable
 *   node wiki-coverage.mjs --since HEAD~1        # only files ADDED since <ref>
 *   node wiki-coverage.mjs --since HEAD~1 --page-worthy --quiet   # the new-page nudge
 *
 * Tunables come from the `coverage:` block of wiki.config.yml
 * (source_extensions, page_worthy_dirs, prune_dirs, noise_patterns);
 * sensible defaults apply when absent.
 *
 * Exit code is always 0 — this is an audit aid, never a gate.
 */
import { readFileSync } from 'node:fs';
import { relative, dirname } from 'node:path';
import {
  repoRoot, findWikiRoot, walkPages, loadConfig, configLists, git,
  collectInScopeSources, DEFAULT_PAGE_WORTHY,
} from './lib.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const SHOW_ALL = has('--all');
const JSON_OUT = has('--json');
const QUIET = has('--quiet');
const PAGE_WORTHY_ONLY = has('--page-worthy');
const sinceIdx = args.indexOf('--since');
const SINCE = sinceIdx !== -1 ? args[sinceIdx + 1] : null;

const root = repoRoot();
const wikiRoot = findWikiRoot(root, args);
const { raw } = loadConfig(wikiRoot);

const scope = configLists(raw, 'scope');
const tunables = configLists(raw, 'coverage');
const pageWorthyDirs = tunables.page_worthy_dirs?.length ? tunables.page_worthy_dirs : DEFAULT_PAGE_WORTHY;

const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const PAGE_WORTHY = new RegExp(`(^|/)(${pageWorthyDirs.map(esc).join('|')})(/|$)`, 'i');

const wikiRel = relative(root, wikiRoot);

/** Every file path listed in any page's `covers:` block. */
function collectCovered() {
  const covered = new Set();
  for (const page of walkPages(wikiRoot)) {
    const text = readFileSync(page, 'utf8');
    for (const m of text.matchAll(/^\s*-\s*path:\s*(.+?)\s*$/gm)) covered.add(m[1]);
  }
  return covered;
}

let sourceFiles = collectInScopeSources(root, {
  include: scope.include ?? [], exclude: scope.exclude ?? [], tunables, wikiRel,
});
const covered = collectCovered();

// Restrict to files added since a ref, when asked (the new-page trigger).
if (SINCE) {
  let added;
  try {
    const out = git(root, ['diff', '--name-only', '--diff-filter=A', SINCE, 'HEAD']);
    added = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    if (!JSON_OUT && !QUIET) console.log(`wiki-coverage: cannot diff against "${SINCE}" — skipping.`);
    process.exit(0);
  }
  sourceFiles = sourceFiles.filter((f) => added.has(f));
}

if (PAGE_WORTHY_ONLY) sourceFiles = sourceFiles.filter((f) => PAGE_WORTHY.test(f));

const uncovered = sourceFiles.filter((f) => !covered.has(f)).sort();
const total = sourceFiles.length;
const coveredCount = total - uncovered.length;
const pct = total ? Math.round((coveredCount / total) * 100) : 100;

// Group uncovered by directory, most-uncovered first.
const byDir = new Map();
for (const f of uncovered) {
  const d = dirname(f);
  if (!byDir.has(d)) byDir.set(d, []);
  byDir.get(d).push(f);
}
const groups = [...byDir.entries()].sort((a, b) => b[1].length - a[1].length);

if (JSON_OUT) {
  console.log(JSON.stringify({
    mode: SINCE ? `since:${SINCE}` : 'full',
    pageWorthyOnly: PAGE_WORTHY_ONLY,
    total, covered: coveredCount, pct, uncovered,
    groups: groups.map(([dir, files]) => ({ dir, count: files.length, files })),
  }, null, 2));
  process.exit(0);
}

// --since trigger output: terse, friendly, only when there is something to say.
if (SINCE) {
  if (uncovered.length === 0) {
    if (!QUIET) console.log(`\nWiki coverage — no newly-added${PAGE_WORTHY_ONLY ? ' page-worthy' : ''} source file since ${SINCE} is missing a page.\n`);
    process.exit(0);
  }
  console.log(`\n📝 Wiki: ${uncovered.length} new${PAGE_WORTHY_ONLY ? ' page-worthy' : ''} source file(s) since ${SINCE} have no wiki page that \`covers\` them:`);
  for (const f of uncovered) console.log(`     - ${f}`);
  console.log(`   If any of these is a new capability, add or extend a page under ${wikiRel}/`);
  console.log(`   (new feature → new page). This is a reminder, not a blocker.\n`);
  process.exit(0);
}

// Full report.
console.log(`\nWiki coverage — in-scope source files no page \`covers\`\n`);
console.log(`  ${coveredCount}/${total} in-scope source files covered by a page (${pct}%)\n`);
if (!scope.include?.length) {
  console.log(`  ⚠ no scope.include globs in wiki.config.yml — scanning the whole repo. Add a scope block to make this meaningful.\n`);
}
if (uncovered.length === 0) {
  console.log('  Every in-scope source file is covered by a page.\n');
  process.exit(0);
}
console.log(`  Uncovered, grouped by directory (most-uncovered first):\n`);
const pageWorthyGroups = groups.filter(([d]) => PAGE_WORTHY.test(d + '/'));
const otherGroups = groups.filter(([d]) => !PAGE_WORTHY.test(d + '/'));
const printGroup = ([dir, files]) => {
  const flag = PAGE_WORTHY.test(dir + '/') ? ' «page-worthy»' : '';
  console.log(`  ${String(files.length).padStart(3)}  ${dir}${flag}`);
  if (SHOW_ALL) {
    for (const f of files) console.log(`         ${f.slice(dir.length + 1)}`);
  } else {
    const names = files.map((f) => f.slice(dir.length + 1));
    const shown = names.slice(0, 6).join(', ');
    console.log(`         ${shown}${names.length > 6 ? `, +${names.length - 6} more` : ''}`);
  }
};
for (const g of pageWorthyGroups) printGroup(g);
if (otherGroups.length) {
  console.log('');
  for (const g of otherGroups) printGroup(g);
}
console.log(`\n  ${uncovered.length} uncovered source file(s). «page-worthy» clusters are the strongest`);
console.log(`  missing-page signals. The wiki distils — not every file needs a page; use`);
console.log(`  this to spot whole areas with none.\n`);
process.exit(0);
