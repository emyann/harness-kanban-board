#!/usr/bin/env node
/**
 * wiki-flow-check.mjs — the verification ladder for flow pages.
 *
 * Computes a flow page's tier (never committed — ADR-002) by running each tier
 * in order and capping the tier at the first failure. Pure vendored stdlib
 * (node + git): runs on a BARE CHECKOUT, OFFLINE, no plugin (ADR-006). Full
 * design + the extractor contract: docs/wiki/references/flow.md.
 *
 * Tiers (RESEARCH-FLOWS §5.2), each strictly stronger than the last:
 *   structural     — meta well-formed; edges/branches reference declared steps;
 *                    enums valid; two-anchor kinds carry two anchors; the single
 *                    FLOW-RENDER region EQUALS render(meta) and no mermaid lives
 *                    outside it (exclusive regenerate-and-diff).
 *   anchored       — every step anchor resolves at its recorded blob SHA and the
 *                    anchor_match occurs in that exact blob.
 *   edge-cited     — DIRECTIONAL: every `verified` edge cites the call site
 *                    INSIDE the from-step's own code (call_anchor_path equals the
 *                    from-step anchor_path), within a bounded span, and that span
 *                    contains BOTH call_match and the callee_token — proving the
 *                    from→to hop is real, not merely that bytes exist. Branch
 *                    citations are verified at the same grade.
 *   branch-audited — single-exit steps whose code shows branch keywords but carry
 *                    no branch entry → warning (heuristic, never fails).
 *   set-validated  — USER SPACE (ADR-007): a registered extractor rebuilds the
 *                    step/edge/branch set from code; absence DEGRADES the tier,
 *                    never fails. asserts_complete is a hard fail only when an
 *                    extractor actually ran.
 *
 *   node wiki-flow-check.mjs <flow-page.md> [...] [--json]
 *
 * Exit 0 if every page reaches at least `anchored` with no errors; 1 on any
 * malformed page / structural / anchor / citation failure. Warnings never fail.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import {
  splitFrontmatter, parseFlowMeta,
  FLOW_EDGE_KINDS, FLOW_TWO_ANCHOR_KINDS, FLOW_EVIDENCE, FLOW_TRIGGER_KINDS, FLOW_BRANCH_KINDS,
  listOfMaps,
} from './lib.mjs';
import { renderBlock, extractRegion, flowId, REGION_START, REGION_END } from './wiki-flow-render.mjs';

const MAX_SPAN = 40; // a verified edge's call-site span may not exceed this many lines

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const files = argv.filter((a) => !a.startsWith('--'));
if (files.length === 0) { console.error('usage: wiki-flow-check.mjs <flow-page.md> [...] [--json]'); process.exit(2); }

const REPO_ROOT = (() => {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { console.error('flow-check: not inside a git repository'); process.exit(2); }
})();

function git(args) { return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function abs(p) { return p && (p.startsWith('/') ? p : `${REPO_ROOT}/${p}`); }

// Memoize git/fs by distinct file — keeps spawns proportional to files, not to
// step/edge count (the ADR-006 <1s budget driver). We never cat-file a blob:
// the recorded SHA is a fingerprint to detect drift, and when it MATCHES the
// working tree the working tree IS that content — so we read the file directly,
// which (unlike `git cat-file`) also works for uncommitted edits while authoring.
const _sha = new Map(), _wt = new Map();
function blobSha(p) { if (_sha.has(p)) return _sha.get(p); let v = null; try { v = git(['hash-object', p]).trim(); } catch { v = null; } _sha.set(p, v); return v; }
function readWt(p) { if (_wt.has(p)) return _wt.get(p); let v = null; try { v = readFileSync(abs(p), 'utf8'); } catch { v = null; } _wt.set(p, v); return v; }

const BRANCH_LEX = ['if ', 'else', 'switch', 'case ', 'catch', 'try ', 'throw ', '? ', ' || ', ' && '];
const TIERS = ['malformed', 'structural', 'anchored', 'edge-cited', 'branch-audited', 'set-validated'];
function capTier(a, b) { return TIERS[Math.min(TIERS.indexOf(a), TIERS.indexOf(b))]; }
const short = (s) => (s ? String(s).slice(0, 7) : '(none)');
const trunc = (s) => (String(s).length > 50 ? String(s).slice(0, 50) + '…' : String(s));

/** 1-based inclusive line slice; returns {text, count} or null. */
function sliceLines(text, range) {
  const lines = text.split('\n');
  const m = String(range).match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return null;
  const a = Number(m[1]); const b = m[2] ? Number(m[2]) : a;
  if (a < 1 || b < a || a > lines.length) return null;
  const slice = lines.slice(a - 1, Math.min(b, lines.length));
  return { text: slice.join('\n'), count: slice.length };
}

/** Resolve a (path, sha, lines) citation to its span at the recorded blob. */
function resolveSpan(label, p, sha, lines, errors) {
  const wt = blobSha(p);
  if (wt === null) { errors.push(`${label}: ${p} does not exist`); return null; }
  if (sha && wt !== sha) { errors.push(`${label}: ${p} moved (recorded ${short(sha)} != now ${short(wt)}) — re-verify and re-stamp`); return null; }
  const blob = readWt(p); // wt === sha (or no sha) ⇒ the working tree is the recorded content
  if (blob === null) { errors.push(`${label}: ${p} not readable`); return null; }
  if (lines == null) return { text: blob, count: blob.split('\n').length, blob };
  const span = sliceLines(blob, lines);
  if (span === null) { errors.push(`${label}: lines ${lines} out of range in ${p}`); return null; }
  return { ...span, blob };
}

function loadValidators() {
  const cfgPath = join(REPO_ROOT, 'docs', 'wiki', 'wiki.config.yml');
  // wikiRoot may differ; fall back to scanning known location. Best-effort.
  let raw = '';
  for (const c of [cfgPath, join(REPO_ROOT, 'wiki.config.yml')]) { if (existsSync(c)) { raw = readFileSync(c, 'utf8'); break; } }
  if (!raw) {
    // discover via manifest if present
    try { const mf = JSON.parse(readFileSync(join(REPO_ROOT, '.repolore', 'manifest.json'), 'utf8')); const c = join(REPO_ROOT, mf.wikiRoot, 'wiki.config.yml'); if (existsSync(c)) raw = readFileSync(c, 'utf8'); } catch { /* none */ }
  }
  return raw ? listOfMaps(raw, 'validators') : [];
}

function runExtractor(entry, meta, warnings, errors, assertsComplete) {
  // entry: {flow, cmd, kind}. Dispatch the user-space extractor; degrade on any
  // failure (ADR-007), never fail unless asserts_complete AND it ran cleanly.
  let out;
  try {
    out = execFileSync('sh', ['-c', entry.cmd], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
  } catch (e) {
    warnings.push(`set-validated: extractor for "${entry.flow}" failed to run (${trunc(e.message)}) — degraded to branch-audited`);
    return false;
  }
  let rebuilt;
  try { rebuilt = JSON.parse(out); } catch {
    warnings.push(`set-validated: extractor "${entry.flow}" did not emit valid JSON {steps,edges,branches} — degraded`);
    return false;
  }
  const metaSteps = new Set(meta.steps.map((s) => s.id));
  const codeSteps = new Set((rebuilt.steps || []).map((s) => (typeof s === 'string' ? s : s.id)));
  const omitted = [...codeSteps].filter((s) => !metaSteps.has(s));
  const extra = [...metaSteps].filter((s) => !codeSteps.has(s));
  // branches by at->to identity (the breakers' lesson: compare at/to/condition)
  const key = (b) => `${b.at}->${b.to}`;
  const metaBr = new Set(meta.branches.map(key));
  const codeBr = new Set((rebuilt.branches || []).map(key));
  const omittedBr = [...codeBr].filter((b) => !metaBr.has(b));

  if (omitted.length === 0 && extra.length === 0 && omittedBr.length === 0) {
    return true; // sets reconcile → set-validated
  }
  const detail = [
    omitted.length ? `steps in code but not the flow: ${omitted.join(', ')}` : '',
    omittedBr.length ? `branches in code but not the flow: ${omittedBr.join(', ')}` : '',
    extra.length ? `flow steps not found in code: ${extra.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  if (assertsComplete) {
    errors.push(`set-validated: flow_asserts_complete is true and the extractor found a mismatch — ${detail}`);
  } else {
    warnings.push(`set-validated: extractor found a mismatch (flow does not assert completeness) — ${detail}`);
  }
  return false;
}

function checkPage(file) {
  const errors = [], warnings = [];
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return { file, tier: 'malformed', errors: ['file not readable'], warnings }; }
  const parts = splitFrontmatter(text);
  if (!parts) return { file, tier: 'malformed', errors: ['no frontmatter'], warnings };
  const m = parseFlowMeta(parts.fm);
  let tier = 'structural';

  // ---- structural ----------------------------------------------------------
  if (m.schema !== 'flow-meta/v1') errors.push(`flow_schema must be flow-meta/v1 (got ${m.schema})`);
  if (!m.scenario) errors.push('flow_scenario is required');
  if (m.trigger_kind && !FLOW_TRIGGER_KINDS.has(m.trigger_kind)) errors.push(`flow_trigger_kind invalid: ${m.trigger_kind}`);
  if (m.steps.length === 0) errors.push('flow_steps is empty');
  for (const d of m._parse) errors.push(`malformed list item: ${d}`);

  const stepIds = new Set(m.steps.map((s) => s.id).filter(Boolean));
  const dup = m.steps.map((s) => s.id).filter((id, i, a) => id && a.indexOf(id) !== i);
  if (dup.length) errors.push(`duplicate step id(s): ${[...new Set(dup)].join(', ')}`);
  for (const e of m.edges) {
    if (!stepIds.has(e.from)) errors.push(`edge ${e.from}->${e.to}: from "${e.from}" is not a declared step`);
    if (!stepIds.has(e.to)) errors.push(`edge ${e.from}->${e.to}: to "${e.to}" is not a declared step`);
    if (e.kind && !FLOW_EDGE_KINDS.has(e.kind)) errors.push(`edge ${e.from}->${e.to}: kind "${e.kind}" not in ${[...FLOW_EDGE_KINDS].join('|')}`);
    if (e.evidence && !FLOW_EVIDENCE.has(e.evidence)) errors.push(`edge ${e.from}->${e.to}: evidence "${e.evidence}" not verified|inferred`);
    if (FLOW_TWO_ANCHOR_KINDS.has(e.kind) && e.evidence === 'verified' && !(e.call_anchor_path && e.handler_path)) {
      errors.push(`edge ${e.from}->${e.to}: kind "${e.kind}" needs two anchors (call_anchor_* emit site + handler_* registration)`);
    }
  }
  for (const b of m.branches) {
    if (!stepIds.has(b.at)) errors.push(`branch at "${b.at}": not a declared step`);
    if (b.to && !stepIds.has(b.to)) errors.push(`branch ${b.at}->${b.to}: target not a declared step`);
    if (b.kind && !FLOW_BRANCH_KINDS.has(b.kind)) warnings.push(`branch ${b.at}->${b.to}: kind "${b.kind}" not in ${[...FLOW_BRANCH_KINDS].join('|')}`);
  }

  // exclusive regenerate-and-diff: the one FLOW-RENDER region must EQUAL render
  const region = extractRegion(text);
  if (region === null) errors.push('no FLOW-RENDER region — add the markers and run wiki-flow-render.mjs');
  else if (region !== renderBlock(m)) errors.push('FLOW-RENDER region drifted from flow-meta — re-run wiki-flow-render.mjs (regenerate-and-diff)');
  const fenceCount = (text.match(/```mermaid/g) || []).length;
  const startCount = (text.split(REGION_START).length - 1);
  if (startCount > 1) errors.push('more than one FLOW-RENDER region — there must be exactly one');
  if (fenceCount > 1) errors.push('a ```mermaid block lives outside the FLOW-RENDER region — the diagram must be generated, not hand-authored');

  if (errors.length) return { file, tier: 'malformed', errors, warnings };

  // ---- anchored ------------------------------------------------------------
  for (const s of m.steps) {
    if (!s.anchor_path) continue; // narration-only step is allowed
    const span = resolveSpan(`step ${s.id}`, s.anchor_path, s.anchor_sha, null, errors);
    if (span && s.anchor_match && !span.text.includes(s.anchor_match)) {
      errors.push(`step ${s.id}: anchor_match not found in ${s.anchor_path}@${short(s.anchor_sha)}: "${trunc(s.anchor_match)}"`);
    }
  }
  if (errors.length) return { file, tier, errors, warnings };
  tier = 'anchored';

  // ---- edge-cited (DIRECTIONAL) --------------------------------------------
  const stepById = new Map(m.steps.map((s) => [s.id, s]));
  for (const e of m.edges) {
    if (e.evidence !== 'verified') continue;
    const sf = stepById.get(e.from);
    if (!e.call_anchor_path || !e.call_anchor_lines || !e.call_match || !e.callee_token) {
      errors.push(`verified edge ${e.from}->${e.to}: needs call_anchor_path/call_anchor_lines/call_match/callee_token (mark inferred if the hop can't be cited directionally)`);
      continue;
    }
    if (!sf || !sf.anchor_path) {
      errors.push(`verified edge ${e.from}->${e.to}: from-step must be code-anchored for a directional citation (or mark the edge inferred)`);
      continue;
    }
    if (e.call_anchor_path !== sf.anchor_path) {
      errors.push(`verified edge ${e.from}->${e.to}: call site must live in the caller's own code (call_anchor_path ${e.call_anchor_path} != from-step anchor_path ${sf.anchor_path}); mark inferred if the call is elsewhere`);
      continue;
    }
    const span = resolveSpan(`edge ${e.from}->${e.to}`, e.call_anchor_path, e.call_anchor_sha, e.call_anchor_lines, errors);
    if (!span) continue;
    if (span.count > MAX_SPAN) { errors.push(`edge ${e.from}->${e.to}: call_anchor_lines spans ${span.count} lines (> ${MAX_SPAN}) — narrow to the call site`); continue; }
    if (!span.text.includes(e.call_match)) { errors.push(`edge ${e.from}->${e.to}: call_match not in ${e.call_anchor_path}:${e.call_anchor_lines}: "${trunc(e.call_match)}"`); continue; }
    if (!span.text.includes(e.callee_token)) { errors.push(`edge ${e.from}->${e.to}: callee_token "${e.callee_token}" not in the cited call site — the citation does not prove this hop`); continue; }
    if (FLOW_TWO_ANCHOR_KINDS.has(e.kind)) {
      const hspan = resolveSpan(`edge ${e.from}->${e.to} handler`, e.handler_path, e.handler_sha, e.handler_lines, errors);
      if (hspan && e.handler_match && !hspan.text.includes(e.handler_match)) {
        errors.push(`edge ${e.from}->${e.to}: handler_match not in ${e.handler_path}:${e.handler_lines}`);
      }
    }
  }
  // branch citations at edge-cited grade
  for (const b of m.branches) {
    if (!b.cite_path) { warnings.push(`branch ${b.at}->${b.to}: uncited (add cite_path/cite_lines/cite_match to verify the fork)`); continue; }
    const span = resolveSpan(`branch ${b.at}->${b.to}`, b.cite_path, b.cite_sha, b.cite_lines, errors);
    if (span && b.cite_match && !span.text.includes(b.cite_match)) {
      errors.push(`branch ${b.at}->${b.to}: cite_match not in ${b.cite_path}:${b.cite_lines}: "${trunc(b.cite_match)}"`);
    }
  }
  if (errors.length) return { file, tier, errors, warnings };
  tier = 'edge-cited';

  // ---- verified-ratio TIER CAP (RESEARCH-FLOWS §6.2) -----------------------
  // A wall of `inferred` (or one surgically-placed inferred edge) dodges the
  // edge-cited grade. If < 50% of edges are verified, the page CANNOT exceed
  // structural — a cap, not a cosmetic warning.
  if (m.edges.length > 0) {
    const verified = m.edges.filter((e) => e.evidence === 'verified').length;
    const ratio = verified / m.edges.length;
    if (ratio < 0.5) {
      warnings.push(`evidence floor: ${verified}/${m.edges.length} edges verified (${Math.round(ratio * 100)}%) < 50% — tier capped at structural`);
      tier = capTier(tier, 'structural');
    }
  }

  // ---- branch-audited (heuristic, never fails) -----------------------------
  const branchAt = new Set(m.branches.map((b) => b.at));
  for (const s of m.steps) {
    const out = m.edges.filter((e) => e.from === s.id);
    if (out.length !== 1 || branchAt.has(s.id)) continue;
    const hits = new Set(); let where = null;
    const scan = (loc, t) => { const h = BRANCH_LEX.filter((kw) => t.includes(kw)); h.forEach((x) => hits.add(x.trim())); if (h.length && !where) where = loc; };
    const e = out[0];
    if (e.evidence === 'verified' && e.call_anchor_path && !/\.(md|txt|rst)$/.test(e.call_anchor_path)) {
      const sp = resolveSpan('', e.call_anchor_path, e.call_anchor_sha, e.call_anchor_lines, []);
      if (sp) scan(`${e.call_anchor_path}:${e.call_anchor_lines}`, sp.text);
    }
    if (s.anchor_path && s.anchor_match && !/\.(md|txt|rst)$/.test(s.anchor_path)) {
      const blob = readWt(s.anchor_path);
      if (blob) { const ls = blob.split('\n'); const i = ls.findIndex((l) => l.includes(s.anchor_match)); if (i !== -1) scan(`${s.anchor_path}~${i + 1}`, ls.slice(Math.max(0, i - 1), i + 6).join('\n')); }
    }
    const hard = [...hits].some((h) => ['catch', 'throw', 'return'].includes(h));
    if (hits.size >= 2 || (hard && hits.size >= 1)) {
      warnings.push(`branch-audit: step ${s.id} has one outgoing edge and no branch entry, but branch keywords [${[...hits].join(', ')}] appear near its anchor (${where}) — possible OMITTED BRANCH`);
    }
  }
  if (tier === 'edge-cited') tier = 'branch-audited';

  // ---- set-validated (USER SPACE — ADR-007) --------------------------------
  const validators = loadValidators();
  const entry = validators.find((v) => v.flow === flowId(file) && (!v.kind || v.kind === 'set-equality'));
  if (entry) {
    const ok = runExtractor(entry, m, warnings, errors, m.asserts_complete);
    if (errors.length) return { file, tier, errors, warnings };
    if (ok && tier === 'branch-audited') tier = 'set-validated';
  } else if (m.asserts_complete) {
    warnings.push('flow_asserts_complete: true but no extractor is registered (wiki.config.yml validators:) — completeness claim is UNBACKED; tier capped at branch-audited');
  }

  return { file, tier, errors, warnings };
}

const results = files.map(checkPage);
const anyFail = results.some((r) => r.errors.length > 0);
if (JSON_OUT) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    const ok = r.errors.length === 0;
    console.log(`\n${ok ? 'PASS' : 'FAIL'}  ${r.file}`);
    console.log(`  tier: ${r.tier}${ok ? '' : ' (capped by failure)'}`);
    for (const e of r.errors) console.log(`  ERROR    ${e}`);
    for (const w of r.warnings) console.log(`  warn     ${w}`);
  }
  console.log('');
}
process.exit(anyFail ? 1 : 0);
