#!/usr/bin/env node
/**
 * wiki-flow-refresh.mjs — diff-scoped refresh for flow pages.
 *
 * When a covered blob moves, wiki-flow-check fails EVERY citation anchored to
 * that file with "moved — re-verify", regardless of whether the cited span
 * actually changed: the checker's signal is per-file, but the claim structure
 * is per-span. This tool computes the per-citation worklist the refresh
 * procedure prescribes (references/flow.md §Maintain): it diffs each recorded
 * blob against the working tree (git diff — both stdlib, ADR-003/006) and
 * classifies every citation:
 *
 *   current    recorded sha matches the working tree — nothing to do
 *   untouched  cited span byte-identical at the same lines → safe: re-record sha
 *   shifted    cited span byte-identical but moved ±N lines → safe: rewrite
 *              lines + re-record sha
 *   touched    the diff intersects the cited span → RE-VERIFY (worklist)
 *   gone       a match string no longer occurs in the file → RE-RESEARCH (worklist)
 *   unknown    recorded blob unavailable (never committed) or no sha → RE-VERIFY
 *
 *   node wiki-flow-refresh.mjs <flow-page.md> [...]            # plan only
 *   node wiki-flow-refresh.mjs <flow-page.md> [...] --apply    # fix the safe classes
 *   node wiki-flow-refresh.mjs ... --json                      # machine-readable
 *
 * --apply rewrites ONLY the provably-safe classes (the cited bytes are
 * identical to what the author originally verified — re-recording is
 * bookkeeping, like update.mjs's manifestFixed, not blessing new content) and
 * re-renders the FLOW-RENDER region (line numbers appear in the tables).
 * touched/gone/unknown citations are left at their old sha ON PURPOSE: after
 * an apply, wiki-flow-check fails on exactly the citations that still need a
 * human — the checker becomes the live worklist. `covers:` is never touched —
 * page-level freshness stays wiki-stamp's blessing, run AFTER the re-verify.
 *
 * Honesty line: this proves BYTE-level safety only. A semantic change whose
 * diff dodges every cited span (or that keeps the matched substring alive)
 * is invisible here — that drift class belongs to the audit workflow.
 *
 * Exit 0 when nothing needs a human; 1 while touched/gone/unknown items
 * remain; 2 on fatal errors.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { splitFrontmatter, parseFlowMeta, stripQuotes } from './lib.mjs';
import { renderBlock, rewriteRegion, flowId, writeSidecar } from './wiki-flow-render.mjs';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const JSON_OUT = argv.includes('--json');
const files = argv.filter((a) => !a.startsWith('--'));
if (files.length === 0) { console.error('usage: wiki-flow-refresh.mjs <flow-page.md> [...] [--apply] [--json]'); process.exit(2); }

const REPO_ROOT = (() => {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { console.error('flow-refresh: not inside a git repository'); process.exit(2); }
})();
function git(args, opts = {}) { return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }); }
const abs = (p) => (p.startsWith('/') ? p : `${REPO_ROOT}/${p}`);
const trunc = (s) => (String(s).length > 50 ? String(s).slice(0, 50) + '…' : String(s));

// The four citation shapes a flow item can carry (field names from the schema).
const PREFIXES = [
  { pathKey: 'anchor_path', shaKey: 'anchor_sha', linesKey: null, matchKeys: ['anchor_match'], label: (it) => `step ${it.id ?? '?'}` },
  { pathKey: 'call_anchor_path', shaKey: 'call_anchor_sha', linesKey: 'call_anchor_lines', matchKeys: ['call_match', 'callee_token'], label: (it) => `edge ${it.from}->${it.to}` },
  { pathKey: 'handler_path', shaKey: 'handler_sha', linesKey: 'handler_lines', matchKeys: ['handler_match'], label: (it) => `edge ${it.from}->${it.to} handler` },
  { pathKey: 'cite_path', shaKey: 'cite_sha', linesKey: 'cite_lines', matchKeys: ['cite_match'], label: (it) => `branch ${it.at}->${it.to}` },
];

// ---- per-file memoization (spawns proportional to files, not citations) ----
const _wt = new Map();      // path -> { sha, lines } of the working tree (or null)
const _old = new Map();     // path@sha -> { lines } of the recorded blob (or null)
const _hunks = new Map();   // path@sha -> parsed hunks old-blob → working-tree
let _tmp = null;

function workingTree(p) {
  if (_wt.has(p)) return _wt.get(p);
  let v = null;
  try { v = { sha: git(['hash-object', p]).trim(), lines: readFileSync(abs(p), 'utf8').split('\n') }; } catch { v = null; }
  _wt.set(p, v); return v;
}
function recordedBlob(p, sha) {
  const k = `${p}@${sha}`;
  if (_old.has(k)) return _old.get(k);
  let v = null;
  try { v = { lines: git(['cat-file', 'blob', sha]).split('\n') }; } catch { v = null; }
  _old.set(k, v); return v;
}

/** Hunks of `git diff -U0` between the recorded blob and the working tree. */
function hunksFor(p, sha) {
  const k = `${p}@${sha}`;
  if (_hunks.has(k)) return _hunks.get(k);
  if (!_tmp) _tmp = mkdtempSync(join(tmpdir(), 'flowrefresh-'));
  const oldFile = join(_tmp, 'old');
  writeFileSync(oldFile, recordedBlob(p, sha).lines.join('\n'));
  let out = '';
  try { out = git(['diff', '--no-index', '--no-color', '-U0', oldFile, abs(p)]); }
  catch (e) { if (e.status === 1 && e.stdout) out = e.stdout; else { _hunks.set(k, null); return null; } }
  const hunks = [];
  for (const m of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    hunks.push({
      oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]),
    });
  }
  _hunks.set(k, hunks); return hunks;
}

/** Does this hunk change bytes inside old-coordinate span [s,e]? A pure
 *  insertion (oldCount 0) inserts AFTER oldStart, so it pierces the span only
 *  when it lands strictly between the span's lines. */
function touches(h, s, e) {
  if (h.oldCount === 0) return h.oldStart >= s && h.oldStart < e;
  return !(h.oldStart + h.oldCount - 1 < s || h.oldStart > e);
}
/** Map an old line (outside every hunk) to its working-tree line. */
function mapLine(hunks, line) {
  let delta = 0;
  for (const h of hunks) {
    if (h.oldCount === 0) { if (h.oldStart < line) delta += h.newCount; }
    else if (h.oldStart + h.oldCount - 1 < line) delta += h.newCount - h.oldCount;
  }
  return line + delta;
}
const rangeStr = (a, b) => (a === b ? String(a) : `${a}-${b}`);

/** Classify one citation. Returns {class, detail?, newRange?}. */
function classify(c) {
  if (!c.sha || !/^[0-9a-f]{40}$/.test(c.sha)) return { class: 'unknown', detail: 'no recorded sha — re-verify and stamp' };
  const wt = workingTree(c.path);
  if (!wt) return { class: 'gone', detail: 'file no longer exists' };
  if (wt.sha === c.sha) return { class: 'current' };
  const old = recordedBlob(c.path, c.sha);
  if (!old) return { class: 'unknown', detail: 'recorded blob not in the object store (never committed?) — re-verify' };

  const newText = wt.lines.join('\n');
  const missing = c.matches.filter((m) => !newText.includes(m));
  if (missing.length) return { class: 'gone', detail: `match no longer in file: "${trunc(missing[0])}"` };

  // resolve the span in old coordinates
  let s, e;
  if (c.lines != null) {
    const m = String(c.lines).match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return { class: 'unknown', detail: `unparseable lines "${c.lines}"` };
    s = Number(m[1]); e = m[2] ? Number(m[2]) : s;
    if (s < 1 || e < s || e > old.lines.length) return { class: 'touched', detail: 'recorded range out of the recorded blob — re-verify' };
  } else {
    const idx = old.lines.findIndex((l) => l.includes(c.matches[0]));
    if (idx === -1) return { class: 'touched', detail: 'match absent from the recorded blob — re-verify the record' };
    s = e = idx + 1;
  }

  const hunks = hunksFor(c.path, c.sha);
  if (hunks === null) return { class: 'unknown', detail: 'diff failed — re-verify' };
  for (const h of hunks) {
    if (touches(h, s, e)) return { class: 'touched', detail: `the diff intersects the cited span (${c.path}:${rangeStr(s, e)})` };
  }
  const ns = mapLine(hunks, s); const ne = mapLine(hunks, e);
  const oldSpan = old.lines.slice(s - 1, e).join('\n');
  const newSpan = wt.lines.slice(ns - 1, ne).join('\n');
  if (oldSpan !== newSpan || c.matches.some((m) => !newSpan.includes(m))) {
    return { class: 'touched', detail: 'mapped span differs from the recorded span — re-verify' };
  }
  if (ns === s) return { class: 'untouched' };
  return { class: 'shifted', newRange: rangeStr(ns, ne), detail: `${rangeStr(s, e)} → ${rangeStr(ns, ne)}` };
}

/** Walk the frontmatter and collect every citation with its field line indices. */
function collectCitations(fmLines) {
  const citations = [];
  let item = null; // { fields: Map(key -> {value, idx}) }
  const finalize = () => {
    if (!item) return;
    const get = (k) => item.fields.get(k);
    const plain = {}; for (const [k, v] of item.fields) plain[k] = v.value;
    for (const p of PREFIXES) {
      const path = get(p.pathKey);
      if (!path) continue;
      citations.push({
        label: p.label(plain), path: path.value,
        sha: get(p.shaKey)?.value ?? null, shaIdx: get(p.shaKey)?.idx ?? null,
        lines: p.linesKey ? (get(p.linesKey)?.value ?? null) : null,
        linesIdx: p.linesKey ? (get(p.linesKey)?.idx ?? null) : null,
        matches: p.matchKeys.map((k) => get(k)?.value).filter(Boolean),
      });
    }
    item = null;
  };
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (/^\S/.test(line)) { finalize(); continue; }      // top-level key ends any item
    if (/^\s*-\s/.test(line)) { finalize(); item = { fields: new Map() }; }
    if (!item) continue;
    const m = line.match(/^\s*(?:-\s+)?([\w-]+):\s*(.*)$/);
    if (m) item.fields.set(m[1], { value: stripQuotes(m[2]), idx: i });
  }
  finalize();
  return citations;
}

const ORDER = ['gone', 'touched', 'unknown', 'shifted', 'untouched', 'current'];

function refreshPage(file) {
  const text = readFileSync(file, 'utf8');
  const parts = splitFrontmatter(text);
  if (!parts) return { file, error: 'no frontmatter', citations: [] };
  const fmLines = parts.fm.split('\n');
  const citations = collectCitations(fmLines).map((c) => ({ ...c, ...classify(c) }));

  let applied = 0;
  if (APPLY) {
    const setLine = (i, value) => { const j = fmLines[i].indexOf(':'); fmLines[i] = fmLines[i].slice(0, j) + ': ' + value; };
    for (const c of citations) {
      if (c.class !== 'untouched' && c.class !== 'shifted') continue;
      if (c.shaIdx !== null) setLine(c.shaIdx, workingTree(c.path).sha);
      if (c.class === 'shifted' && c.linesIdx !== null) setLine(c.linesIdx, c.newRange);
      applied++;
    }
    if (applied) {
      const fm = fmLines.join('\n');
      const meta = parseFlowMeta(fm);
      let next = `---\n${fm}---${parts.body}`;
      const rerendered = rewriteRegion(next, renderBlock(meta));
      if (rerendered !== null) next = rerendered; // missing region is the structural tier's finding, not ours
      writeFileSync(file, next);
      try { writeSidecar(REPO_ROOT, flowId(file), meta); } catch { /* best-effort */ }
    }
  }
  return { file, citations, applied };
}

const results = files.map(refreshPage);
let attention = 0;
for (const r of results) attention += (r.citations ?? []).filter((c) => ['touched', 'gone', 'unknown'].includes(c.class)).length + (r.error ? 1 : 0);
if (_tmp) rmSync(_tmp, { recursive: true, force: true });

if (JSON_OUT) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    console.log(`\nflow-refresh — ${r.file}${APPLY ? '   (applied)' : '   (plan — nothing written)'}`);
    if (r.error) { console.log(`  ERROR    ${r.error}`); continue; }
    const counts = {};
    for (const c of r.citations) counts[c.class] = (counts[c.class] ?? 0) + 1;
    if ((counts.current ?? 0) === r.citations.length) { console.log('  all citations current — nothing to do'); continue; }
    if (counts.current) console.log(`  current: ${counts.current} citation(s)`);
    const sorted = [...r.citations].sort((a, b) => ORDER.indexOf(a.class) - ORDER.indexOf(b.class));
    for (const c of sorted) {
      if (c.class === 'current') continue;
      const where = `${c.path}${c.lines ? ':' + c.lines : ''}`;
      if (c.class === 'untouched') console.log(`  ${APPLY ? 'FIXED' : 'SAFE '}    ${c.label}  ${where} — span identical${APPLY ? '; sha re-recorded' : ' (sha re-record on --apply)'}`);
      else if (c.class === 'shifted') console.log(`  ${APPLY ? 'FIXED' : 'SAFE '}    ${c.label}  ${where} — shifted ${c.detail}${APPLY ? '; rewritten' : ' (rewrite on --apply)'}`);
      else console.log(`  RE-VERIFY ${c.label}  ${where} — [${c.class}] ${c.detail}`);
    }
    if (APPLY && r.applied) console.log(`  region re-rendered; ${r.applied} citation(s) fixed. Re-verify the items above, then wiki-stamp + wiki-flow-check.`);
  }
  console.log('');
}
process.exit(attention ? 1 : 0);
