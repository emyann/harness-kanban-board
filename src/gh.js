// Thin wrapper over the `gh` CLI. One code path for REST and GraphQL, with
// error classification so callers can tell "held" from "unknown" from "offline".
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

/**
 * REST call via `gh api`. Returns parsed JSON (or null on empty body).
 * Throws GhError with .kind on failure. Rate limits are retried twice with backoff.
 */
export async function rest(method, path, { body, headers = {}, retries = 2 } = {}) {
  const args = ['api', '-X', method, path, '-H', `X-GitHub-Api-Version: ${API_VERSION}`, '-H', 'Accept: application/vnd.github+json'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  let input;
  if (body !== undefined) {
    args.push('--input', '-');
    input = JSON.stringify(body);
  }
  for (let attempt = 0; ; attempt++) {
    const res = runGh(args, { input });
    if (res.status === 0) {
      const out = res.stdout.trim();
      if (!out) return null;
      try { return JSON.parse(out); } catch { return out; }
    }
    const status = parseStatus(res.stderr, res.stdout);
    const kind = classify(status, res.stderr + res.stdout);
    if (kind === 'ratelimit' && attempt < retries) {
      const wait = 30_000 * (attempt + 1);
      process.stderr.write(`hkb: rate limited on ${method} ${path}; pausing ${wait / 1000}s\n`);
      await sleep(wait);
      continue;
    }
    const msg = (res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ');
    throw new GhError(`${method} ${path} failed (${status || kind}): ${msg}`, { status, kind, body: res.stdout, path });
  }
}

/** GraphQL call via `gh api graphql --input`. Returns `data`. */
export async function graphql(query, variables = {}, { retries = 2 } = {}) {
  const args = ['api', 'graphql', '-H', `X-GitHub-Api-Version: ${API_VERSION}`, '--input', '-'];
  const input = JSON.stringify({ query, variables });
  for (let attempt = 0; ; attempt++) {
    const res = runGh(args, { input });
    let parsed = null;
    try { parsed = JSON.parse(res.stdout); } catch { /* not json */ }
    if (res.status === 0 && parsed && !parsed.errors) return parsed.data;
    const status = parseStatus(res.stderr, res.stdout);
    const text = res.stderr + (parsed?.errors ? JSON.stringify(parsed.errors) : res.stdout);
    let kind = classify(status, text);
    if (/RATE_LIMITED/.test(text)) kind = 'ratelimit';
    if (kind === 'ratelimit' && attempt < retries) {
      const wait = 30_000 * (attempt + 1);
      process.stderr.write(`hkb: GraphQL rate limited; pausing ${wait / 1000}s\n`);
      await sleep(wait);
      continue;
    }
    const msg = parsed?.errors ? parsed.errors.map((e) => e.message).join('; ') : res.stderr.trim().split('\n').slice(-2).join(' ');
    const err = new GhError(`GraphQL failed (${status || kind}): ${msg}`, { status, kind, body: res.stdout, path: 'graphql' });
    err.graphqlErrors = parsed?.errors || [];
    throw err;
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
