// Thin wrapper over the `gh` CLI. One code path for REST and GraphQL, with
// error classification so callers can tell "held" from "unknown" from "offline".
//
// Every API call goes through a transport. The default one shells out to `gh`;
// `setTransport(fn)` swaps in another — that is how `test/fake-gh.js` stands in an
// in-memory GitHub without spawning anything. A transport is called with
//   { kind: 'rest',    method, path, body, headers } → the parsed REST payload
//   { kind: 'graphql', query, variables }            → the GraphQL `data`
// and returns that value (or a promise of it), or throws a GhError.
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
  if (/dial tcp|no such host|connection refused|network is unreachable|timeout|tls handshake|could not resolve|error connecting|eof/.test(t) && !status) return 'network';
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
  err.graphqlErrors = parsed?.errors || [];
  throw err;
}

/** The default transport: today's `spawnSync('gh', ...)`. */
export function defaultTransport(req) {
  return req.kind === 'graphql' ? graphqlViaGh(req) : restViaGh(req);
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
