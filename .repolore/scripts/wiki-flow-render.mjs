#!/usr/bin/env node
/**
 * wiki-flow-render.mjs — flow-meta → GitHub-safe Mermaid + anchored tables.
 *
 * The emitter IS the validator (RESEARCH-FLOWS §5.4): it writes a conservative
 * subset — `flowchart TD`, plain rectangular nodes, double-quoted labels, no
 * click/href (GitHub strips them). Anchors live ONLY in the tables, never in
 * the diagram. The whole block is written between the FLOW-RENDER markers, so
 * wiki-flow-check.mjs can compare the region by EQUALITY (regenerate-and-diff,
 * like wiki-index --check) and reject any hand-edited diagram.
 *
 *   node wiki-flow-render.mjs <flow-page.md>           # rewrite region + sidecar
 *   node wiki-flow-render.mjs <flow-page.md> --check    # exit 1 if region drifted
 *   node wiki-flow-render.mjs <flow-page.md> --print    # print block to stdout
 *
 * Stdlib-only (node + git), offline.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { splitFrontmatter, parseFlowMeta } from './lib.mjs';

export const REGION_START = '<!-- FLOW-RENDER:START — generated from flow-meta; do not hand-edit (run wiki-flow-render.mjs) -->';
export const REGION_END = '<!-- FLOW-RENDER:END -->';

const EDGE_ARROW = { call: '-->', http: '-->', db: '-->', async: '-.->', queue: '-.->', event: '-.->' };

/** Mermaid-safe label: collapse whitespace, neutralise the closing quote. */
function label(s) {
  return String(s ?? '').replace(/\s+/g, ' ').replace(/"/g, '#quot;').trim();
}
/** Stable Mermaid node id ([A-Za-z0-9_] only). */
function nodeId(id) {
  return 'n_' + String(id).replace(/[^A-Za-z0-9_]/g, '_');
}
/** Markdown inline-code cell that survives a literal backtick in the value. */
function codeCell(s) {
  const v = String(s ?? '');
  if (!v) return '—';
  return v.includes('`') ? `\`\` ${v} \`\`` : `\`${v}\``;
}
/** Escape a table cell's pipes. */
function cell(s) {
  return String(s ?? '—').replace(/\|/g, '\\|');
}

/** Pick the diagram projection from flow_render (default flowchart). */
export function renderMermaid(meta) {
  return meta.render === 'sequence' ? renderSequence(meta) : renderFlowchart(meta);
}

export function renderFlowchart(meta) {
  const out = ['```mermaid', '%% generated from flow-meta — do not hand-edit', 'flowchart TD'];
  for (const s of meta.steps) out.push(`  ${nodeId(s.id)}["${label(s.action || s.id)}"]`);
  for (const e of meta.edges) {
    const arrow = EDGE_ARROW[e.kind] ?? '-->';
    const tag = e.evidence === 'inferred' ? ' (inferred)' : '';
    out.push(`  ${nodeId(e.from)} ${arrow}|"${label((e.kind || 'call') + tag)}"| ${nodeId(e.to)}`);
  }
  for (const b of meta.branches) {
    if (!b.at || !b.to) continue;
    out.push(`  ${nodeId(b.at)} -.->|"${label((b.kind || 'alt') + ': ' + (b.condition || ''))}"| ${nodeId(b.to)}`);
  }
  out.push('```');
  return out.join('\n');
}

const seqId = (actor) => 'p_' + String(actor).replace(/[^A-Za-z0-9_]/g, '_');

/** A sequence-diagram projection of the SAME flow-meta: actors are participants
 *  (first-appearance order), edges are messages between the from/to steps'
 *  actors, branches are dashed messages carrying their condition. Verification
 *  is unchanged — this is a rendering choice, not a different model. */
export function renderSequence(meta) {
  const out = ['```mermaid', '%% generated from flow-meta — do not hand-edit', 'sequenceDiagram'];
  const actorOf = new Map(meta.steps.map((s) => [s.id, s.actor || s.id]));
  const actors = [];
  for (const s of meta.steps) { const a = s.actor || s.id; if (!actors.includes(a)) actors.push(a); }
  for (const a of actors) out.push(`  participant ${seqId(a)} as ${label(a)}`);
  const stepById = new Map(meta.steps.map((s) => [s.id, s]));
  for (const e of meta.edges) {
    const arrow = EDGE_ARROW[e.kind] === '-.->' ? '-->>' : '->>';
    const to = stepById.get(e.to);
    const tag = e.evidence === 'inferred' ? ' (inferred)' : '';
    out.push(`  ${seqId(actorOf.get(e.from))}${arrow}${seqId(actorOf.get(e.to))}: ${label((to && to.action) || e.kind || 'call')}${tag}`);
  }
  for (const b of meta.branches) {
    if (!b.at || !b.to) continue;
    out.push(`  ${seqId(actorOf.get(b.at))}-->>${seqId(actorOf.get(b.to))}: ${label((b.kind || 'alt') + ': ' + (b.condition || ''))}`);
  }
  out.push('```');
  return out.join('\n');
}

export function renderStepTable(meta) {
  const rows = ['| # | Step | Actor | Anchor |', '|---|------|-------|--------|'];
  meta.steps.forEach((s, i) => {
    const anchor = s.anchor_path
      ? `${codeCell(s.anchor_path)}${s.anchor_match ? ` — ${codeCell(s.anchor_match)}` : ''}`
      : '—';
    rows.push(`| ${i + 1} | ${cell(s.id)} — ${cell(s.action)} | ${cell(s.actor)} | ${anchor} |`);
  });
  return rows.join('\n');
}

export function renderEdgeTable(meta) {
  const rows = ['', '**Edges** — each `verified` hop cites the call site in the caller and names the callee:', '',
    '| From → To | Kind | Evidence | Call site | Callee |', '|-----------|------|----------|-----------|--------|'];
  for (const e of meta.edges) {
    const site = e.call_anchor_path
      ? `${codeCell(e.call_anchor_path + (e.call_anchor_lines ? ':' + e.call_anchor_lines : ''))}${e.call_match ? ` — ${codeCell(e.call_match)}` : ''}`
      : '—';
    rows.push(`| ${cell(e.from)} → ${cell(e.to)} | ${cell(e.kind)} | ${cell(e.evidence)} | ${site} | ${codeCell(e.callee_token)} |`);
  }
  return rows.join('\n');
}

export function renderBranchTable(meta) {
  if (!meta.branches.length) return '';
  const rows = ['', '**Branches** — alternative and error paths:', '',
    '| At → To | Kind | Condition | Cited at |', '|---------|------|-----------|----------|'];
  for (const b of meta.branches) {
    const cite = b.cite_path
      ? `${codeCell(b.cite_path + (b.cite_lines ? ':' + b.cite_lines : ''))}${b.cite_match ? ` — ${codeCell(b.cite_match)}` : ''}`
      : '—';
    rows.push(`| ${cell(b.at)} → ${cell(b.to)} | ${cell(b.kind)} | ${cell(b.condition)} | ${cite} |`);
  }
  return rows.join('\n');
}

/** The full generated block (everything between the FLOW-RENDER markers). */
export function renderBlock(meta) {
  return [renderMermaid(meta), '', renderStepTable(meta), renderEdgeTable(meta), renderBranchTable(meta)]
    .filter((s) => s !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/** Replace the FLOW-RENDER region in a page body; returns null if markers absent. */
export function rewriteRegion(text, block) {
  const s = text.indexOf(REGION_START);
  const e = text.indexOf(REGION_END);
  if (s === -1 || e === -1 || e < s) return null;
  return text.slice(0, s) + REGION_START + '\n\n' + block + '\n\n' + text.slice(e);
}

/** Extract the current region content (between markers, trimmed), or null. */
export function extractRegion(text) {
  const s = text.indexOf(REGION_START);
  const e = text.indexOf(REGION_END);
  if (s === -1 || e === -1 || e < s) return null;
  return text.slice(s + REGION_START.length, e).trim();
}

/** Flow id = page filename without .md (used for the sidecar export). */
export function flowId(pagePath) {
  return basename(pagePath).replace(/\.md$/, '');
}

/** Write the lore-builder sidecar: .repolore/flows/<id>.flow-meta.json. */
export function writeSidecar(repoRoot, id, meta) {
  const dir = join(repoRoot, '.repolore', 'flows');
  mkdirSync(dir, { recursive: true });
  const { _parse, ...clean } = meta;
  writeFileSync(join(dir, `${id}.flow-meta.json`), JSON.stringify({ id, ...clean }, null, 2) + '\n');
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) { console.error('usage: wiki-flow-render.mjs <flow-page.md> [--check|--print]'); process.exit(2); }
  const text = readFileSync(file, 'utf8');
  const parts = splitFrontmatter(text);
  if (!parts) { console.error('malformed: no frontmatter'); process.exit(2); }
  const meta = parseFlowMeta(parts.fm);
  const block = renderBlock(meta);

  if (process.argv.includes('--print')) { console.log(block); process.exit(0); }

  if (process.argv.includes('--check')) {
    const cur = extractRegion(text);
    if (cur === null) { console.error('no FLOW-RENDER region — add the markers and run wiki-flow-render.mjs'); process.exit(2); }
    if (cur !== block) { console.error(`flow render drifted: ${file} — re-run wiki-flow-render.mjs`); process.exit(1); }
    process.exit(0);
  }

  const next = rewriteRegion(text, block);
  if (next === null) { console.error('no FLOW-RENDER region in page — add the markers (see _templates/flow.md)'); process.exit(2); }
  writeFileSync(file, next);
  // sidecar export for the lore-builder — repo root is two dirs up from scriptsDir
  try {
    const root = process.cwd();
    writeSidecar(root, flowId(file), meta);
  } catch { /* sidecar is best-effort; the page render is the contract */ }
  console.log(`rendered ${file} (flow-meta → Mermaid + tables; sidecar written)`);
}
