// A strict parser for the YAML subset the generated workflows are written in — block mappings, block
// sequences, flow sequences, quoted and plain scalars, and `|` / `>` block scalars. Test-only: hkb
// itself never reads YAML (see CLAUDE.md), so this lives here rather than in src/, and it exists so
// `templates/actions/*.yml` is checked structurally instead of by regex.
//
// Strict on purpose: anything it does not recognise throws with a line number, so a malformed
// template fails the test rather than being half-parsed. It is NOT a general YAML implementation —
// no anchors, no flow mappings, no multi-document files, no `?` keys — and keys stay strings (real
// YAML 1.1 would turn `on:` into the boolean true).

const isBlank = (raw) => /^\s*(#.*)?$/.test(raw);
const indentOf = (raw) => raw.match(/^ */)[0].length;
const KEY = /^([A-Za-z_][\w.-]*|"[^"]*"):(?:[ \t]+(.*))?$/;

class Reader {
  constructor(text) {
    this.raw = text.split('\n');
    this.i = 0;
    const tab = this.raw.findIndex((l) => /^\t| \t/.test(l));
    if (tab >= 0) throw new Error(`line ${tab + 1}: tab indentation is not YAML`);
  }
  /** The next line that carries content, without consuming it. */
  peek() {
    while (this.i < this.raw.length && isBlank(this.raw[this.i])) this.i++;
    return this.i < this.raw.length ? this.raw[this.i] : null;
  }
  take() { const l = this.peek(); this.i++; return l; }
  where() { return this.i + 1; }
}

/** Strip a trailing `# comment` that is not inside quotes. */
function uncomment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function scalar(text, at) {
  const s = uncomment(text).trim();
  if (s === '') return null;
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) throw new Error(`line ${at}: unterminated flow sequence`);
    const inner = s.slice(1, -1).trim();
    return inner ? inner.split(',').map((x) => scalar(x, at)) : [];
  }
  if ((s.startsWith('"') && s.endsWith('"') && s.length > 1) || (s.startsWith("'") && s.endsWith("'") && s.length > 1)) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

/** `|`, `|-`, `>`, `>-`: every following line indented past `parent`, dedented and folded or not. */
function blockScalar(r, marker, parent) {
  const fold = marker[0] === '>';
  const chomp = marker.includes('-');
  const body = [];
  while (r.i < r.raw.length) {
    const raw = r.raw[r.i];
    if (raw.trim() === '') { body.push(''); r.i++; continue; }
    if (indentOf(raw) <= parent) break;
    body.push(raw);
    r.i++;
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  const pad = Math.min(...body.filter((l) => l !== '').map(indentOf));
  const lines = body.map((l) => (l === '' ? '' : l.slice(pad)));
  let out;
  if (!fold) out = lines.join('\n');
  else {
    // paragraphs (blank-line separated) are folded to one line each
    out = lines.reduce((acc, l) => (l === '' ? acc + '\n' : acc && !acc.endsWith('\n') ? `${acc} ${l}` : acc + l), '');
  }
  return chomp ? out : out + '\n';
}

function parseValue(r, rest, indent) {
  const at = r.where();
  const marker = rest === undefined ? null : /^([|>][-+]?)\s*$/.exec(uncomment(rest).trim())?.[1];
  if (marker) { r.i++; return blockScalar(r, marker, indent); }
  if (rest !== undefined && uncomment(rest).trim() !== '') { r.i++; return scalar(rest, at); }
  // nothing on the line: either a nested block below, or an empty value (`workflow_dispatch:`)
  r.i++;
  const next = r.peek();
  if (next === null || indentOf(next) <= indent) return null;
  return parseNode(r, indentOf(next));
}

function parseNode(r, indent) {
  const first = r.peek();
  if (first === null) return null;
  return /^-(\s|$)/.test(first.slice(indent)) ? parseSequence(r, indent) : parseMapping(r, indent);
}

function parseMapping(r, indent) {
  const out = {};
  for (;;) {
    const line = r.peek();
    if (line === null || indentOf(line) !== indent) break;
    const body = line.slice(indent);
    if (body.startsWith('- ')) break;
    const m = KEY.exec(body);
    if (!m) throw new Error(`line ${r.where()}: not a mapping key: ${body.trim()}`);
    const key = m[1].replace(/^"|"$/g, '');
    if (Object.prototype.hasOwnProperty.call(out, key)) throw new Error(`line ${r.where()}: duplicate key "${key}"`);
    out[key] = parseValue(r, m[2], indent);
  }
  return out;
}

function parseSequence(r, indent) {
  const out = [];
  for (;;) {
    const line = r.peek();
    if (line === null || indentOf(line) !== indent) break;
    const body = line.slice(indent);
    if (!/^-(\s|$)/.test(body)) break;
    const rest = body.slice(1).replace(/^ /, '');
    const at = r.where();
    if (rest.trim() === '') { r.i++; const next = r.peek(); out.push(next && indentOf(next) > indent ? parseNode(r, indentOf(next)) : null); continue; }
    const m = KEY.exec(rest);
    if (!m) { r.i++; out.push(scalar(rest, at)); continue; }
    // `- key: value` — the item is a mapping whose first key sits on the dash line
    const inner = indent + (body.length - rest.length);
    const item = {};
    item[m[1].replace(/^"|"$/g, '')] = parseValue(r, m[2], inner);
    Object.assign(item, parseMapping(r, inner));
    out.push(item);
  }
  return out;
}

/** Parse one YAML document. Throws (with a line number) on anything outside the supported subset. */
export function parseYaml(text) {
  const r = new Reader(text);
  const first = r.peek();
  if (first === null) return null;
  if (indentOf(first) !== 0) throw new Error('line 1: the document must start at column 0');
  const doc = parseNode(r, 0);
  const trailing = r.peek();
  if (trailing !== null) throw new Error(`line ${r.where()}: unexpected content after the document: ${trailing.trim()}`);
  return doc;
}
