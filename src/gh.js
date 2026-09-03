// Thin wrapper over the `gh` CLI. One code path for REST and GraphQL, with
// error classification so callers can tell "held" from "unknown" from "offline".
//
// Every API call goes through a transport. The default one shells out to `gh`;
// `setTransport(fn)` swaps in another — that is how `test/fake-gh.js` stands in an
// in-memory GitHub without spawning anything. A transport is called with
//   { kind: 'rest',    method, path, body, headers } → the parsed REST payload
//   { kind: 'graphql', query, variables }            → the GraphQL `data`
//   { kind: 'rest', raw: true, ... }                 → { __response, status, headers, data }
// and returns that value (or a promise of it), or throws a GhError. A transport that does not
// model responses may answer a raw request with the payload alone; `restRaw` treats that as a 200.
// `ghCmd`/`ghAuthStatus` stay on `gh` itself: repo detection and `hkb doctor`, never board state.
import { spawnSync } from 'node:child_process';

export const API_VERSION = '2026-03-10';

export class GhError extends Error {
  constructor(message, { status = 0, kind = 'unknown', body = '', path = '' } = {}) {
    super(message);
    this.name = 'GhError';
    this.status = status;
    this.kind = kind; // auth | ratelimit | network | notfound | conflict | validation | server | unknown
    this.body = body;
    this.path = path;
  }
}

export function classify(status, text) {
  const t = (text || '').toLowerCase();
  // GitHub's GraphQL 404 idiom ("Could not resolve to an Issue with the number of 999999.")
  // must not fall into the DNS-failure branch below — it means the node doesn't exist, not
  // that the network is down.
  if (!status && /could not resolve to (a|an) \w/.test(t)) return 'notfound';
  if (/dial tcp|no such host|connection refused|network is unreachable|timeout|tls handshake|could not resolve host|could not resolve hostname|error connecting|\beof\b/.test(t) && !status) return 'network';
  if (status === 401) return 'auth';
  if (status === 403 && /rate limit|secondary|abuse/.test(t)) return 'ratelimit';
  if (status === 429) return 'ratelimit';
  if (status === 403) return 'auth';
  if (status === 404) return 'notfound';
  if (status === 409) return 'conflict';
  if (status === 422) return 'validation';
  if (status >= 500) return 'server';
  if (!status && /not logged in|auth login|authentication/.test(t)) return 'auth';
  return 'unknown';
}

/** @param {string[]} args
 * @param {{input?: string}} [opts]
 */
function runGh(args, { input } = {}) {
  const res = spawnSync('gh', args, {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
  });
  if (res.error) {
    if (res.error.code === 'ENOENT') throw new GhError('`gh` is not installed or not on PATH (https://cli.github.com)', { kind: 'unknown' });
    throw new GhError(res.error.message, { kind: 'network' });
  }
  return res;
}

function parseStatus(stderr, stdout) {
  const m = /HTTP (\d{3})/.exec(stderr) || /HTTP (\d{3})/.exec(stdout);
  return m ? Number(m[1]) : 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- transport ----------

/** One REST call through `gh api`. Returns parsed JSON (or null on an empty body). */
function restViaGh({ method, path, body, headers = {} }) {
  const args = ['api', '-X', method, path, '-H', `X-GitHub-Api-Version: ${API_VERSION}`, '-H', 'Accept: application/vnd.github+json'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  let input;
  if (body !== undefined) {
    args.push('--input', '-');
    input = JSON.stringify(body);
  }
  const res = runGh(args, { input });
  if (res.status === 0) {
    const out = res.stdout.trim();
    if (!out) return null;
    try { return JSON.parse(out); } catch { return out; }
  }
  const status = parseStatus(res.stderr, res.stdout);
  const kind = classify(status, res.stderr + res.stdout);
  const msg = (res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ');
  throw new GhError(`${method} ${path} failed (${status || kind}): ${msg}`, { status, kind, body: res.stdout, path });
}

/** One GraphQL call through `gh api graphql --input`. Returns `data`. */
function graphqlViaGh({ query, variables = {} }) {
  const res = runGh(['api', 'graphql', '-H', `X-GitHub-Api-Version: ${API_VERSION}`, '--input', '-'], { input: JSON.stringify({ query, variables }) });
  let parsed = null;
  try { parsed = JSON.parse(res.stdout); } catch { /* not json */ }
  if (res.status === 0 && parsed && !parsed.errors) return parsed.data;
  const status = parseStatus(res.stderr, res.stdout);
  const text = res.stderr + (parsed?.errors ? JSON.stringify(parsed.errors) : res.stdout);
  let kind = classify(status, text);
  if (/RATE_LIMITED/.test(text)) kind = 'ratelimit';
  const msg = parsed?.errors ? parsed.errors.map((e) => e.message).join('; ') : res.stderr.trim().split('\n').slice(-2).join(' ');
  const err = new GhError(`GraphQL failed (${status || kind}): ${msg}`, { status, kind, body: res.stdout, path: 'graphql' });
  /** @type {any} */ (err).graphqlErrors = parsed?.errors || [];
  throw err;
}

/**
 * Split `gh api -i` output into the status line, the headers (keys lower-cased) and the body.
 * `gh` writes the head even when the request failed, so this is also how a 304 is recognised.
 */
export function parseIncluded(out) {
  const text = String(out || '');
  const at = text.search(/\r?\n\r?\n/);
  const head = at === -1 ? text : text.slice(0, at);
  const body = at === -1 ? '' : text.slice(at).replace(/^\r?\n\r?\n/, '');
  const lines = head.split(/\r?\n/);
  const headers = {};
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return { status: Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(lines[0] || '')?.[1] || 0), headers, body };
}

/** One REST call through `gh api -i`, keeping the status and headers. A 304 is a value, not an error. */
function rawViaGh({ method, path, body, headers = {} }) {
  const args = ['api', '-i', '-X', method, path, '-H', `X-GitHub-Api-Version: ${API_VERSION}`, '-H', 'Accept: application/vnd.github+json'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  let input;
  if (body !== undefined) {
    args.push('--input', '-');
    input = JSON.stringify(body);
  }
  const res = runGh(args, { input });
  const r = parseIncluded(res.stdout);
  if (r.status === 304) return { __response: true, status: 304, headers: r.headers, data: null };
  if (res.status === 0) {
    const text = r.body.trim();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { __response: true, status: r.status || 200, headers: r.headers, data };
  }
  const status = r.status || parseStatus(res.stderr, res.stdout);
  const kind = classify(status, res.stderr + r.body);
  const msg = (res.stderr || r.body).trim().split('\n').slice(-3).join(' ');
  throw new GhError(`${method} ${path} failed (${status || kind}): ${msg}`, { status, kind, body: r.body, path });
}

/** The default transport: today's `spawnSync('gh', ...)`. */
export function defaultTransport(req) {
  if (req.kind === 'graphql') return graphqlViaGh(req);
  return req.raw ? rawViaGh(req) : restViaGh(req);
}

let transport = defaultTransport;

/**
 * Swap the transport. `setTransport()` / `setTransport(null)` restores the default.
 * @returns {() => void} restores whatever was installed before this call.
 */
export function setTransport(fn) {
  const previous = transport;
  transport = fn || defaultTransport;
  return () => { transport = previous; };
}

/**
 * REST call. Returns the parsed payload (or null on an empty body).
 * Throws GhError with .kind on failure. Rate limits are retried twice with backoff.
 * @param {string} method
 * @param {string} path
 * @param {{ body?: any, headers?: Record<string, string>, retries?: number }} [opts]
 */
export async function rest(method, path, { body, headers = {}, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await transport({ kind: 'rest', method, path, body, headers });
    } catch (e) {
      if (!(e instanceof GhError) || e.kind !== 'ratelimit' || attempt >= retries) throw e;
      const wait = 30_000 * (attempt + 1);
      process.stderr.write(`hkb: rate limited on ${method} ${path}; pausing ${wait / 1000}s\n`);
      await sleep(wait);
    }
  }
}

/**
 * A REST call that keeps the response envelope: `{ status, headers, data }`.
 * Pass `headers: { 'If-None-Match': etag }` and a 304 comes back as a status, not a throw —
 * that is how `hkb watch` polls without spending rate limit (GitHub does not charge a 304).
 * @param {string} method
 * @param {string} path
 * @param {{ body?: any, headers?: Record<string, string>, retries?: number }} [opts]
 */
export async function restRaw(method, path, { body, headers = {}, retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await transport({ kind: 'rest', method, path, body, headers, raw: true });
      if (r && typeof r === 'object' && r.__response) return { status: r.status, headers: r.headers || {}, data: r.data };
      return { status: 200, headers: {}, data: r }; // a transport that does not model responses
    } catch (e) {
      if (!(e instanceof GhError) || e.kind !== 'ratelimit' || attempt >= retries) throw e;
      const wait = 30_000 * (attempt + 1);
      process.stderr.write(`hkb: rate limited on ${method} ${path}; pausing ${wait / 1000}s\n`);
      await sleep(wait);
    }
  }
}

/** GraphQL call. Returns `data`. */
export async function graphql(query, variables = {}, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await transport({ kind: 'graphql', query, variables });
    } catch (e) {
      if (!(e instanceof GhError) || e.kind !== 'ratelimit' || attempt >= retries) throw e;
      const wait = 30_000 * (attempt + 1);
      process.stderr.write(`hkb: GraphQL rate limited; pausing ${wait / 1000}s\n`);
      await sleep(wait);
    }
  }
}

/** Run an arbitrary gh subcommand, returning stdout. Throws GhError on non-zero exit. */
/**
 * @param {string[]} args
 * @param {{input?: string, allowFail?: boolean}} [opts]
 */
export function ghCmd(args, { input, allowFail = false } = {}) {
  const res = runGh(args, { input });
  if (res.status !== 0 && !allowFail) {
    const status = parseStatus(res.stderr, res.stdout);
    throw new GhError(`gh ${args.join(' ')} failed: ${res.stderr.trim() || res.stdout.trim()}`, { status, kind: classify(status, res.stderr + res.stdout) });
  }
  return res.stdout;
}

export function ghAuthStatus() {
  const res = runGh(['auth', 'status']);
  return { ok: res.status === 0, text: (res.stderr + res.stdout).trim() };
}

export function isOffline(err) {
  return err instanceof GhError && err.kind === 'network';
}
