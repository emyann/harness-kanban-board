#!/usr/bin/env node
/**
 * wiki-index.mjs — generates the wiki's index.md from page frontmatter.
 *
 * index.md is a GENERATED artifact: one llms.txt-shaped line per page
 * (`- [title](./path.md): summary`), grouped by category. Page summaries live
 * in exactly one place — the page's own frontmatter — and the index is
 * recreated from them, which kills the "update the page AND the index AND the
 * manifest" triple-bookkeeping failure mode.
 *
 *   node wiki-index.mjs                    # (re)write index.md
 *   node wiki-index.mjs --check            # exit 1 if index.md is out of date
 *   node wiki-index.mjs --wiki-root <dir>  # override wiki location
 *
 * The category order comes from `categories:` in wiki.config.yml when
 * present, else the default taxonomy order; unknown categories are appended
 * alphabetically. A page's category is its `category:` frontmatter field,
 * falling back to its top-level directory.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  repoRoot, findWikiRoot, walkPages, splitFrontmatter, fmScalar,
  loadConfig, configScalar, configList, parsePagePlan, DEFAULT_CATEGORIES,
} from './lib.mjs';

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');

const root = repoRoot();
const wikiRoot = findWikiRoot(root, argv);
const { raw } = loadConfig(wikiRoot);
const wikiTitle = configScalar(raw, 'wiki', 'title') ?? 'Project';
const categoryOrder = (() => {
  const fromConfig = configList(raw, 'categories');
  return fromConfig.length ? fromConfig : DEFAULT_CATEGORIES;
})();

const entries = [];
const warnings = [];
for (const file of walkPages(wikiRoot)) {
  const relPath = relative(wikiRoot, file);
  const parts = splitFrontmatter(readFileSync(file, 'utf8'));
  if (!parts) { warnings.push(`${relPath}: malformed frontmatter — excluded from index`); continue; }
  const title = fmScalar(parts.fm, 'title') ?? relPath.replace(/\.md$/, '');
  const summary = fmScalar(parts.fm, 'summary');
  if (!summary) warnings.push(`${relPath}: no summary in frontmatter`);
  const category = fmScalar(parts.fm, 'category') ?? (relPath.includes('/') ? relPath.split('/')[0] : '(uncategorised)');
  entries.push({ relPath, title, summary: summary ?? '(no summary)', category });
}

const byCategory = new Map();
for (const e of entries) {
  if (!byCategory.has(e.category)) byCategory.set(e.category, []);
  byCategory.get(e.category).push(e);
}
const extraCategories = [...byCategory.keys()].filter((c) => !categoryOrder.includes(c)).sort();
const ordered = [...categoryOrder, ...extraCategories].filter((c) => byCategory.has(c));

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const scriptsDir = relative(root, new URL('.', import.meta.url).pathname).replace(/\/$/, '');

const lines = [
  `# ${wikiTitle} — wiki index`,
  '',
  `> GENERATED FILE — do not edit by hand. Regenerate with \`node ${scriptsDir}/wiki-index.mjs\`.`,
  '> One line per page, taken verbatim from each page\'s frontmatter `title`/`summary`.',
  '> Schema and authoring rules: [AGENTS.md](./AGENTS.md).',
  '',
];
for (const cat of ordered) {
  lines.push(`## ${cap(cat)}`, '');
  for (const e of byCategory.get(cat).sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    lines.push(`- [${e.title}](./${e.relPath}): ${e.summary}`);
  }
  lines.push('');
}

// The backlog: page-plan entries with no page file yet. Surfacing them here
// makes "what is waiting to be drafted" visible at the wiki's front door.
const pageSlugs = new Set(entries.map((e) => e.relPath.replace(/\.md$/, '')));
const backlog = parsePagePlan(raw).filter((p) => !pageSlugs.has(p.slug));
if (backlog.length) {
  lines.push('## Planned (not yet written)', '');
  for (const p of backlog.sort((a, b) => a.slug.localeCompare(b.slug))) {
    lines.push(`- ${p.slug}: ${p.summary || '(no summary in the page plan)'}`);
  }
  lines.push('', '> Backlog from the page plan (`pages:` in `wiki.config.yml`) — draft on demand: "draft `<slug>` from the wiki plan".', '');
}
const content = lines.join('\n');

const indexFile = join(wikiRoot, 'index.md');

if (CHECK) {
  const current = existsSync(indexFile) ? readFileSync(indexFile, 'utf8') : null;
  if (current === content) {
    console.log(`index.md is up to date (${entries.length} pages).`);
    process.exit(0);
  }
  console.log(current === null
    ? 'index.md is missing — run wiki-index.mjs to generate it.'
    : 'index.md is out of date — regenerate with wiki-index.mjs.');
  process.exit(1);
}

writeFileSync(indexFile, content);
console.log(`wrote ${relative(root, indexFile)} (${entries.length} pages, ${ordered.length} categories${backlog.length ? `, ${backlog.length} planned` : ''}).`);
for (const w of warnings) console.log(`  ⚠ ${w}`);
process.exit(0);
