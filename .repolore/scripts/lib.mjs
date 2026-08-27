/**
 * lib.mjs — shared helpers for the repolore check scripts.
 *
 * Stdlib-only (node + git): these files are vendored into target repos and
 * must never require an npm install. They parse exactly the controlled
 * schema documented in the wiki's AGENTS.md — not arbitrary YAML.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, isAbsolute, resolve, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Special wiki files that are never pages (any level). */
export const SKIP_FILES = new Set([
  'index.md', 'AGENTS.md', 'CLAUDE.md', 'README.md', 'GLOSSARY.md', 'log.md',
  'FINDINGS.md',
]);
/** Directories inside the wiki that never hold pages. */
export const SKIP_DIRS = new Set(['_templates', '_audit']);

/** Default category order for the generated index; `categories:` in wiki.config.yml overrides. */
export const DEFAULT_CATEGORIES = [
  'architecture', 'concepts', 'features', 'flows', 'decisions', 'gotchas', 'howto',
];

/** The vendored tooling set — what bootstrap copies into target repos and
 *  update refreshes. Order matters to no one; completeness does. */
export const VENDORED_SCRIPTS = [
  'lib.mjs', 'wiki-check.mjs', 'wiki-coverage.mjs', 'wiki-stamp.mjs', 'wiki-index.mjs',
  'wiki-hook.mjs', 'wiki-install-hook.mjs', 'wiki-flow-render.mjs', 'wiki-flow-check.mjs',
  'wiki-flow-refresh.mjs',
];

export function fail(msg) {
  console.error(`repolore: ${msg}`);
  process.exit(2);
}

/**
 * Today as YYYY-MM-DD in LOCAL time — the one date source for everything
 * user-visible (stamps, journals, manifests). UTC slicing flips the date for
 * evening users west of Greenwich, making the journal disagree with the stamp.
 */
export function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function git(cwd, args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function repoRoot() {
  try {
    return git(process.cwd(), ['rev-parse', '--show-toplevel']);
  } catch {
    fail('not inside a git repository');
  }
}

/**
 * Locate the wiki root. Precedence: --wiki-root flag, REPOLORE_ROOT env var,
 * the `wikiRoot` field of .repolore/manifest.json at the repo root.
 */
export function findWikiRoot(root, argv) {
  const i = argv.indexOf('--wiki-root');
  let dir = null;
  if (i !== -1 && argv[i + 1]) dir = argv[i + 1];
  else if (process.env.REPOLORE_ROOT) dir = process.env.REPOLORE_ROOT;
  else {
    const manifest = join(root, '.repolore', 'manifest.json');
    if (existsSync(manifest)) {
      try { dir = JSON.parse(readFileSync(manifest, 'utf8')).wikiRoot; } catch { /* unreadable → fall through */ }
    }
  }
  if (!dir) fail('cannot locate the wiki — pass --wiki-root <dir>, set REPOLORE_ROOT, or run repolore init (it writes .repolore/manifest.json)');
  const abs = isAbsolute(dir) ? dir : resolve(root, dir);
  if (!existsSync(abs)) fail(`wiki root does not exist: ${abs}`);
  return abs;
}

/** git blob SHA of a working-tree file, or null if it is gone. */
export function blobSha(root, path) {
  try {
    return git(root, ['hash-object', path]);
  } catch {
    return null;
  }
}

/** Recursively collect wiki page files (.md, excluding special files/dirs). */
export function walkPages(wikiRoot) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name));
      } else if (e.name.endsWith('.md') && !SKIP_FILES.has(e.name)) {
        out.push(join(dir, e.name));
      }
    }
  };
  walk(wikiRoot);
  return out.sort();
}

/** Split a `---`-delimited YAML frontmatter block off the top of a document. */
export function splitFrontmatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end === -1) return null;
  return { fm: text.slice(4, end + 1), body: text.slice(end + 4) };
}

/** Top-level scalar field of a frontmatter block, quotes stripped. */
export function fmScalar(fm, key) {
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm'));
  if (!m) return null;
  const v = m[1].replace(/^["']|["']$/g, '');
  return v === '' ? null : v;
}

/** Lines belonging to a top-level `key:` block (until the next top-level key). */
function blockLines(text, key) {
  const ls = text.split('\n');
  const start = ls.findIndex((l) => new RegExp(`^${key}:\\s*$`).test(l));
  if (start === -1) return [];
  const out = [];
  for (let i = start + 1; i < ls.length; i++) {
    if (/^\S/.test(ls[i])) break;
    out.push(ls[i]);
  }
  return out;
}

/** List field: inline `key: [a, b]` or block `key:` + `- a` lines. */
export function fmList(fm, key) {
  const inline = fm.match(new RegExp(`^${key}:[ \\t]*\\[(.*)\\][ \\t]*$`, 'm'));
  if (inline) {
    return inline[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  return blockLines(fm, key)
    .map((l) => l.match(/^\s*-\s*["']?(.+?)["']?\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
}

/** The `covers:` list of `{path, sha}` entries. */
export function parseCovers(fm) {
  const covers = [];
  let cur = null;
  for (const line of blockLines(fm, 'covers')) {
    const pathM = line.match(/^\s*-\s*path:\s*(.+?)\s*$/);
    const shaM = line.match(/^\s*sha:\s*(.+?)\s*$/);
    if (pathM) { cur = { path: pathM[1], sha: null }; covers.push(cur); }
    else if (shaM && cur) { cur.sha = shaM[1]; }
  }
  return covers;
}

// --- flow-meta (flows/ pages) — schema in references/flow.md ----------------
// A flow page carries a structured flow-meta record in its frontmatter, from
// which the Mermaid diagram + step tables are GENERATED (never hand-authored).
// The encoding is line-parseable in exactly the parseCovers shape (lists of
// one-level maps, scalar fields) so the vendored parser stays stdlib-only
// (ADR-003): no nested YAML, no inline maps.

export const FLOW_EDGE_KINDS = new Set(['call', 'async', 'queue', 'http', 'db', 'event']);
export const FLOW_TWO_ANCHOR_KINDS = new Set(['async', 'queue', 'event']);
export const FLOW_EVIDENCE = new Set(['verified', 'inferred']);
export const FLOW_TRIGGER_KINDS = new Set(['http', 'command', 'cron', 'queue', 'event', 'call']);
export const FLOW_BRANCH_KINDS = new Set(['error', 'guard', 'alt', 'normal']);

/** Strip a single matched pair of surrounding quotes (mismatched quotes kept). */
export function stripQuotes(v) {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * A list of one-level maps — `parseCovers` generalised. Each item is a
 * `  - firstKey: value` line plus deeper-indented `key: value` continuation
 * lines, yielding `[{firstKey, ...}, ...]`. This is the SINGLE structural
 * primitive every flow list (steps/edges/branches) is built from, proving one
 * parseCovers-shaped reader covers the whole flow-meta schema.
 */
export function listOfMaps(fm, key) {
  const items = [];
  let cur = null;
  for (const raw of blockLines(fm, key)) {
    if (raw.trim() === '') continue;
    const head = raw.match(/^\s*-\s*([\w-]+):\s*(.*)$/);
    if (head) { cur = {}; cur[head[1]] = stripQuotes(head[2]); items.push(cur); continue; }
    const kv = raw.match(/^\s+([\w-]+):\s*(.*)$/);
    if (kv && cur) cur[kv[1]] = stripQuotes(kv[2]);
  }
  return items;
}

/**
 * Parse a flow page's frontmatter into a typed, TOTAL flow-meta record. Never
 * throws — arrays are always present and unplaceable lines land in `_parse`
 * rather than failing (well-formedness is the structural tier's job in
 * wiki-flow-check.mjs). Underscore keys (`flow_*`) so `fmScalar` matches the
 * literal key with no dotted-regex hazard.
 */
export function parseFlowMeta(fm) {
  const diag = [];
  const meta = {
    schema: fmScalar(fm, 'flow_schema'),
    scenario: fmScalar(fm, 'flow_scenario'),
    trigger_kind: fmScalar(fm, 'flow_trigger_kind'),
    trigger_anchor: fmScalar(fm, 'flow_trigger_anchor'),
    render: fmScalar(fm, 'flow_render'),     // flowchart (default) | sequence
    validator: fmScalar(fm, 'flow_validator'),
    asserts_complete: fmScalar(fm, 'flow_asserts_complete') === 'true',
    steps: listOfMaps(fm, 'flow_steps'),
    edges: listOfMaps(fm, 'flow_edges'),
    branches: listOfMaps(fm, 'flow_branches'),
    _parse: diag,
  };
  meta.steps.forEach((s, i) => { if (!s.id) diag.push(`step[${i}] has no id`); });
  meta.edges.forEach((e, i) => { if (!e.from || !e.to) diag.push(`edge[${i}] missing from/to`); });
  meta.branches.forEach((b, i) => { if (!b.at) diag.push(`branch[${i}] missing at`); });
  return meta;
}

/**
 * The page plan — `pages:` entries of wiki.config.yml as
 * [{slug, summary, status}]. status defaults to 'planned' when absent.
 */
export function parsePagePlan(raw) {
  const entries = [];
  let cur = null;
  for (const line of blockLines(raw, 'pages')) {
    const slugM = line.match(/^\s*-\s*slug:\s*(.+?)\s*$/);
    const sumM = line.match(/^\s*summary:\s*(.+?)\s*$/);
    const statM = line.match(/^\s*status:\s*(.+?)\s*$/);
    if (slugM) { cur = { slug: slugM[1], summary: '', status: 'planned' }; entries.push(cur); }
    else if (sumM && cur) cur.summary = sumM[1].replace(/^["']|["']$/g, '');
    else if (statM && cur) cur.status = statM[1];
  }
  return entries;
}

/** Raw wiki.config.yml text ('' when absent — every consumer has defaults). */
export function loadConfig(wikiRoot) {
  const file = join(wikiRoot, 'wiki.config.yml');
  return { raw: existsSync(file) ? readFileSync(file, 'utf8') : '', file };
}

/** Two-level lists, e.g. `scope:` → `{include: [...], exclude: [...]}`. */
export function configLists(raw, key) {
  const out = {};
  let cur = null;
  for (const line of blockLines(raw, key)) {
    const k = line.match(/^\s{2}([\w-]+):\s*$/);
    if (k) { cur = k[1]; out[cur] = []; continue; }
    const inline = line.match(/^\s{2}([\w-]+):\s*\[(.*)\]\s*$/);
    if (inline) {
      out[inline[1]] = inline[2].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      cur = null;
      continue;
    }
    const item = line.match(/^\s{4}-\s*["']?([^"'\n]+?)["']?\s*$/);
    if (item && cur) out[cur].push(item[1]);
  }
  return out;
}

/** Scalar under a top-level block, e.g. (`wiki`, `page_budget`). Quoted
 *  values are returned verbatim (sans quotes); unquoted values lose any
 *  trailing ` # comment` — YAML semantics our line parser must honor, or
 *  `page_budget: 50  # soft cap` reads as the string "50  # soft cap". */
export function configScalar(raw, key, sub) {
  for (const line of blockLines(raw, key)) {
    const m = line.match(new RegExp(`^\\s{2}${sub}:\\s*(.+?)\\s*$`));
    if (!m) continue;
    const q = m[1].match(/^(["'])(.*?)\1/);
    if (q) return q[2];
    return m[1].replace(/\s+#.*$/, '');
  }
  return null;
}

/** Top-level list, e.g. `categories:` (inline or block form). */
export function configList(raw, key) {
  return fmList(raw, key);
}

// ---------------------------------------------------------------------------
// Scope semantics — shared by wiki-coverage.mjs and the init bootstrap so the
// in-scope file count shown at the init approval gate is the same number the
// coverage baseline reports afterwards.
// ---------------------------------------------------------------------------

/** File extensions treated as source; `coverage.source_extensions` overrides. */
export const DEFAULT_SOURCE_EXT = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.cs', '.py', '.go', '.rs', '.rb', '.java', '.kt', '.swift', '.php',
  '.prisma', '.proto', '.graphql',
];
/** Directory names whose uncovered clusters signal a missing page. */
export const DEFAULT_PAGE_WORTHY = [
  'functions', 'activities', 'transformers', 'routes', 'services', 'operations',
  'extensions', 'controllers', 'handlers', 'commands', 'jobs', 'workers', 'api',
];
/** Directories never walked. */
export const DEFAULT_PRUNE = [
  '.git', '.repolore', 'node_modules', 'dist', 'build', 'out', 'bin', 'obj',
  'target', 'coverage', 'vendor', '.venv', 'venv', '__pycache__', '.turbo', '.next',
];
/** Path patterns excluded as noise (tests, configs, generated typings…). */
export const DEFAULT_NOISE = [
  '\\.(config|setup)\\.[cm]?[jt]sx?$', '\\.d\\.ts$',
  '\\.(test|spec)\\.[cm]?[jt]sx?$', '(^|/)__(tests|mocks)__/', '_test\\.(go|py)$',
  '(^|/)\\.eslint', '\\.stories\\.[jt]sx?$',
];

/**
 * Repo-relative source files matching the wiki scope. `include`/`exclude` are
 * gitignore-ish globs; `tunables` is the parsed `coverage:` block; `wikiRel`
 * (when given) is excluded along with everything under it.
 */
export function collectInScopeSources(root, { include = [], exclude = [], tunables = {}, wikiRel = null } = {}) {
  const sourceExt = new Set(tunables.source_extensions?.length ? tunables.source_extensions : DEFAULT_SOURCE_EXT);
  const pruneDirs = new Set(tunables.prune_dirs?.length ? tunables.prune_dirs : DEFAULT_PRUNE);
  const noise = (tunables.noise_patterns?.length ? tunables.noise_patterns : DEFAULT_NOISE).map((p) => new RegExp(p));
  const includeRes = (include.length ? include : ['**']).map(globToRegex);
  const excludeRes = exclude.map(globToRegex);

  const inScope = (rel) =>
    includeRes.some((r) => r.test(rel)) && !excludeRes.some((r) => r.test(rel)) &&
    !(wikiRel && (rel === wikiRel || rel.startsWith(wikiRel + '/')));
  const isSource = (rel) => {
    const dot = rel.lastIndexOf('.');
    if (dot === -1 || !sourceExt.has(rel.slice(dot))) return false;
    return !noise.some((r) => r.test(rel));
  };

  const acc = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!pruneDirs.has(e.name)) walk(join(dir, e.name));
      } else {
        const rel = relative(root, join(dir, e.name));
        if (isSource(rel) && inScope(rel)) acc.push(rel);
      }
    }
  };
  walk(root);
  return acc;
}

/** Translate a gitignore-ish glob to an anchored RegExp over a repo-relative path. */
export function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } // '**/' = zero or more dirs
        else re += '.*';
      } else {
        re += '[^/]*';
      }
    } else if (c === '/') {
      re += '/';
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}
