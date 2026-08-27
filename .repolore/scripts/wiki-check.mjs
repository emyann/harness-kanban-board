#!/usr/bin/env node
/**
 * wiki-check.mjs — staleness detector for the LLM-maintained wiki.
 *
 * Each wiki page lists, in its frontmatter, the source files it `covers` and
 * the git blob SHA each had when the page was written. This script re-hashes
 * those files and compares: any mismatch means the source moved on and the
 * page is stale.
 *
 *   node wiki-check.mjs                    # report
 *   node wiki-check.mjs --json             # machine-readable
 *   node wiki-check.mjs --quiet            # print nothing if all fresh
 *   node wiki-check.mjs --wiki-root <dir>  # override wiki location
 *
 * Status is COMPUTED, never written: no frontmatter field, no state file.
 * Recomputing takes well under a second; committing volatile check-state
 * only creates dirty trees and merge conflicts. The reader-visible freshness
 * signal is `generated_at_commit` / `last_refreshed`, written at refresh time
 * by wiki-stamp.mjs.
 *
 * Exit code: 0 if every page is fresh/unmanaged, 1 if any page is stale or
 * malformed. Hooks and reminders should ignore the exit code (report, never
 * block); CI may choose to consume it.
 */
import { readFileSync } from 'node:fs';
import { relative, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  repoRoot, findWikiRoot, walkPages, splitFrontmatter, parseCovers, blobSha,
  loadConfig, configScalar, parsePagePlan,
} from './lib.mjs';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const QUIET = argv.includes('--quiet');

const root = repoRoot();
const wikiRoot = findWikiRoot(root, argv);
const { raw } = loadConfig(wikiRoot);
const pageBudget = Number(configScalar(raw, 'wiki', 'page_budget') ?? 50);

const results = [];
const legacyPages = [];
const flowPages = [];
for (const file of walkPages(wikiRoot)) {
  const rel = relative(root, file);
  const parts = splitFrontmatter(readFileSync(file, 'utf8'));
  if (!parts) { results.push({ page: rel, status: 'malformed' }); continue; }
  // Flow pages additionally get their verification ladder checked below.
  if (/^flow_schema:/m.test(parts.fm)) flowPages.push(file);
  // Legacy tooling-owned fields (decisions/ legitimately use `status:` for
  // their lifecycle — proposed/accepted/superseded — so only flag the old
  // computed freshness values).
  if (/^status:\s*(fresh|stale|unmanaged)\s*$/m.test(parts.fm) || /^last_checked:/m.test(parts.fm)) legacyPages.push(rel);

  const covers = parseCovers(parts.fm);
  if (covers.length === 0) { results.push({ page: rel, status: 'unmanaged' }); continue; }

  const stale = [];
  for (const c of covers) {
    if (!c.sha) { stale.push({ path: c.path, reason: 'no sha recorded — run wiki-stamp.mjs after refreshing' }); continue; }
    const actual = blobSha(root, c.path);
    if (actual === null) stale.push({ path: c.path, reason: 'covered file deleted or moved' });
    else if (actual !== c.sha) stale.push({ path: c.path, reason: 'covered file changed' });
  }
  results.push({ page: rel, status: stale.length ? 'stale' : 'fresh', stale });
}

const stale = results.filter((r) => r.status === 'stale');
const malformed = results.filter((r) => r.status === 'malformed');
const unmanaged = results.filter((r) => r.status === 'unmanaged');
const overBudget = results.length > pageBudget;

// Flow pages: run the verification ladder (structural→branch-audited, plus any
// user-space set-validated extractor). Errors here fail the check like a stale
// page; tiers/warnings are informational.
let flows = [];
if (flowPages.length) {
  const flowCheck = join(dirname(fileURLToPath(import.meta.url)), 'wiki-flow-check.mjs');
  try {
    const out = execFileSync('node', [flowCheck, ...flowPages, '--json'], { encoding: 'utf8' });
    flows = JSON.parse(out);
  } catch (e) {
    if (e.stdout) { try { flows = JSON.parse(e.stdout); } catch { /* leave empty */ } }
  }
  flows = flows.map((f) => ({ ...f, page: relative(root, f.file) }));
}
const flowFailed = flows.filter((f) => f.errors && f.errors.length);
const clean = stale.length === 0 && malformed.length === 0 && flowFailed.length === 0;

// Page-plan reconciliation: surface the backlog (planned, not yet written)
// and flag plan↔reality drift. Informational — never changes the exit code.
const plan = parsePagePlan(raw);
const pageSlugs = new Set(walkPages(wikiRoot).map((f) => relative(wikiRoot, f).replace(/\.md$/, '')));
const planSlugs = new Set(plan.map((p) => p.slug));
const backlog = plan.filter((p) => !pageSlugs.has(p.slug) && p.status !== 'seeded');
const written = plan.filter((p) => pageSlugs.has(p.slug)).length;
const planDrift = [
  ...plan.filter((p) => p.status === 'seeded' && !pageSlugs.has(p.slug))
    .map((p) => `${p.slug} — status: seeded but no page file exists`),
  ...plan.filter((p) => p.status === 'planned' && pageSlugs.has(p.slug))
    .map((p) => `${p.slug} — page exists but the plan still says planned (flip to seeded)`),
  ...[...pageSlugs].filter((s) => !planSlugs.has(s))
    .map((s) => `${s} — page exists but is missing from the page plan (add it to pages: in wiki.config.yml)`),
];

if (JSON_OUT) {
  console.log(JSON.stringify({
    pages: results,
    counts: { total: results.length, fresh: results.length - stale.length - malformed.length - unmanaged.length, stale: stale.length, malformed: malformed.length, unmanaged: unmanaged.length },
    page_budget: pageBudget,
    over_budget: overBudget,
    legacy_fields: legacyPages,
    plan: { total: plan.length, written, backlog: backlog.map((p) => p.slug), drift: planDrift },
    flows: flows.map((f) => ({ page: f.page, tier: f.tier, errors: f.errors, warnings: f.warnings })),
  }, null, 2));
  process.exit(clean ? 0 : 1);
}

if (!(QUIET && clean && !overBudget && legacyPages.length === 0 && planDrift.length === 0)) {
  console.log(`\nWiki freshness — ${results.length} page(s) checked\n`);
  for (const r of stale) {
    console.log(`  STALE      ${r.page}`);
    for (const s of r.stale) console.log(`             - ${s.path}  (${s.reason})`);
  }
  for (const r of malformed) console.log(`  MALFORMED  ${r.page}  (missing/broken frontmatter)`);
  for (const r of unmanaged) console.log(`  UNMANAGED  ${r.page}  (no \`covers:\` — staleness cannot be tracked)`);
  if (clean && unmanaged.length === 0) console.log('  All pages fresh.');
  else if (clean) console.log(`\n  ${results.length - unmanaged.length} fresh, ${unmanaged.length} unmanaged.`);
  else console.log(`\n  ${stale.length} stale, ${malformed.length} malformed — run the repolore refresh workflow (/repolore:refresh in Claude Code; see AGENTS.md).`);
  if (overBudget) console.log(`\n  ⚠ ${results.length} pages exceeds the soft page budget (${pageBudget}). Consider merging or archiving — a curated wiki beats a sprawling one. (Tune wiki.page_budget in wiki.config.yml.)`);
  if (legacyPages.length) console.log(`\n  ⚠ ${legacyPages.length} page(s) carry legacy \`status:\`/\`last_checked:\` fields. Status is computed now — delete those lines.`);
  if (planDrift.length) {
    console.log(`\n  ⚠ page plan drift (pages: in wiki.config.yml disagrees with reality):`);
    for (const d of planDrift) console.log(`     - ${d}`);
  }
  if (flows.length) {
    console.log(`\n  Flows — ${flows.length} page(s), verification ladder:`);
    for (const f of flows) {
      const mark = (f.errors && f.errors.length) ? 'FAIL' : 'ok  ';
      console.log(`     ${mark} ${f.page} — tier: ${f.tier}`);
      for (const e of (f.errors || [])) console.log(`          ERROR  ${e}`);
      for (const w of (f.warnings || [])) console.log(`          warn   ${w}`);
    }
  }
  if (!QUIET && backlog.length) {
    console.log(`\n  Plan: ${written}/${plan.length} written — ${backlog.length} page(s) waiting to be drafted:`);
    for (const p of backlog) console.log(`     - ${p.slug}${p.summary ? `  (${p.summary})` : ''}`);
    console.log(`     Draft on demand: "draft \`${backlog[0].slug}\` from the wiki plan".`);
  }
  console.log('');
}

process.exit(clean ? 0 : 1);
