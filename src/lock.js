// Claims live in git refs: the only atomic create-if-absent primitive GitHub offers.
//   claim   = POST git/refs {ref: refs/kb/locks/<n>/<k>}  → 201 claimed · 409/"already exists" held · anything else unknown
//   check   = GET  git/ref/kb/locks/<n>/<k>              → 404 means LOCK_LOST (dispatcher reclaimed)
//   beat    = git push <new>:<ref> --force-with-lease=<ref>:<expected>  → rejected means LOCK_LOST
//   release = DELETE git/refs/kb/locks/<n>/<k>
import { spawnSync } from 'node:child_process';
import { rest, GhError } from './gh.js';
import { api } from './board.js';
import { lockRef, lockRefPath, classifyLeasePush } from './model.js';

export async function baseSha(ctx) {
  if (ctx._cache.baseSha) return ctx._cache.baseSha;
  const branch = ctx.cfg?.default_branch || 'main';
  try {
    const r = await rest('GET', api(ctx, `/git/ref/heads/${branch}`));
    ctx._cache.baseSha = r.object.sha;
  } catch (e) {
    if (!(e instanceof GhError && e.kind === 'notfound')) throw e;
    const repo = await rest('GET', api(ctx));
    const r = await rest('GET', api(ctx, `/git/ref/heads/${repo.default_branch}`));
    ctx._cache.baseSha = r.object.sha;
  }
  return ctx._cache.baseSha;
}

/** Classify a failed ref-create. Exported for tests. */
export function classifyClaimError(err) {
  if (!(err instanceof GhError)) return 'unknown';
  if (err.status === 409) return 'held';
  if (err.status === 422 && /already exists/i.test(err.message + err.body)) return 'held';
  return 'unknown'; // 422 (spam/validation), 403, 429, 5xx, network: never conclude "held"
}

/** @returns {'claimed'|'held'|'unknown'} plus the error for 'unknown'. `sha` starts the beat chain. */
export async function claim(ctx, n, k) {
  const sha = await baseSha(ctx);
  try {
    await rest('POST', api(ctx, '/git/refs'), { body: { ref: lockRef(n, k), sha } });
    return { result: 'claimed', ref: lockRef(n, k), sha };
  } catch (e) {
    const result = classifyClaimError(e);
    return { result, ref: lockRef(n, k), sha: null, error: result === 'unknown' ? e : null };
  }
}

export async function lockExists(ctx, n, k) {
  return (await lockSha(ctx, n, k)) !== null;
}

/** The lock ref's sha as GitHub has it, or null when the ref is gone (= reclaimed). */
export async function lockSha(ctx, n, k) {
  try {
    const r = await rest('GET', api(ctx, `/git/ref/${lockRefPath(n, k)}`));
    // a prefix match returns an array; only an exact hit is our ref
    return !r || Array.isArray(r) ? null : r.object?.sha || null;
  } catch (e) {
    if (e instanceof GhError && e.kind === 'notfound') return null;
    throw e;
  }
}

/**
 * When the lock ref last moved: the committer date of the commit it points at. That is the only
 * trace a ref-CAS heartbeat leaves — the run comment stays untouched. null when unknowable.
 */
export async function lockBeatAt(ctx, sha) {
  if (!sha) return null;
  try {
    const c = await rest('GET', api(ctx, `/git/commits/${sha}`));
    return c?.committer?.date || c?.author?.date || null;
  } catch (e) {
    if (e instanceof GhError && (e.kind === 'notfound' || e.kind === 'validation')) return null;
    throw e;
  }
}

export async function release(ctx, n, k) {
  try {
    await rest('DELETE', api(ctx, `/git/refs/${lockRefPath(n, k)}`));
    return true;
  } catch (e) {
    if (e instanceof GhError && (e.kind === 'notfound' || (e.kind === 'validation' && /does not exist/i.test(e.message)))) return false;
    throw e;
  }
}

// ---------- ref-CAS heartbeat ----------
// The heartbeat is a compare-and-swap on the lock ref, run from the worker's worktree:
//   new = git commit-tree <tree of expected> -p <expected>          (an empty commit, made locally)
//   git push origin <new>:refs/kb/locks/<n>/<k> --force-with-lease=refs/kb/locks/<n>/<k>:<expected>
// The lease is the whole check: it holds only while the ref is exactly where this attempt left it,
// so a dispatcher reclaim (which deletes the ref) rejects the push atomically. Nothing is written
// through the API — the git transport does not spend the REST content budget — and the ref's commit
// date is what the dispatcher reads back instead of `heartbeat_at`.
//
// The expected sha is *this worker's own record*, never a fresh read of the ref: leasing on what
// the ref happens to say right now would happily stomp whoever holds it.

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'hkb', GIT_AUTHOR_EMAIL: 'hkb@local',
  GIT_COMMITTER_NAME: 'hkb', GIT_COMMITTER_EMAIL: 'hkb@local',
  GIT_TERMINAL_PROMPT: '0', // a worker has nobody to answer a credential prompt
};

const SHA_RE = /^[0-9a-f]{40}$/;
/** The two lines of git output worth putting in an error message. */
function short(s) {
  const lines = String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const loud = lines.filter((l) => /^(fatal|error|remote|!)/i.test(l));
  return (loud.length ? loud : lines).slice(0, 2).join(' ').slice(0, 200);
}

/** Run git in the worktree. Never throws — the caller classifies the output. */
function git(root, args, { timeout = 30_000 } = {}) {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout, env: { ...process.env, ...GIT_ENV } });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  if (res.error) return { status: null, out: `${out}${res.error.message}`, stdout: '' };
  return { status: res.status, out, stdout: (res.stdout || '').trim() };
}

/** Where this worktree thinks its beat chain is: the local mirror of the lock ref. */
export function localBeatSha(root, n, k) {
  const r = git(root, ['rev-parse', '--verify', '--quiet', `${lockRef(n, k)}^{commit}`]);
  return r.status === 0 && SHA_RE.test(r.stdout) ? r.stdout : null;
}

export function remoteName(ctx) { return ctx?.cfg?.remote || 'origin'; }

/**
 * Advance the lock ref by one empty commit, leasing on `expected`.
 * @returns {{result:'ok'|'lost'|'unavailable', sha:string|null, expected:string, detail:string}}
 *   `lost` is returned only for a rejected lease; every other failure is `unavailable`, so an
 *   ambiguous one ends at the authoritative ref read in `lifecycle.js` rather than in a false stop.
 */
export function casHeartbeat(root, n, k, expected, { remote = 'origin', at = new Date() } = {}) {
  const ref = lockRef(n, k);
  const fail = (detail) => ({ result: 'unavailable', sha: null, expected, detail });
  if (!SHA_RE.test(String(expected || ''))) return fail(`no sha to lease on (expected: ${expected ?? 'none'})`);

  let tree = git(root, ['rev-parse', '--verify', '--quiet', `${expected}^{tree}`]);
  if (tree.status !== 0) {
    // the object is not in this clone (first beat after a fresh worktree) — fetch the ref itself
    const f = git(root, ['fetch', '--quiet', remote, `+${ref}:${ref}`], { timeout: 60_000 });
    if (f.status !== 0) return fail(`git fetch ${remote} ${ref}: ${short(f.out) || 'failed'}`);
    tree = git(root, ['rev-parse', '--verify', '--quiet', `${expected}^{tree}`]);
    if (tree.status !== 0) return fail(`${expected.slice(0, 7)} is not in this clone and not on ${remote}/${ref}`);
  }

  const made = git(root, ['commit-tree', tree.stdout, '-p', expected, '-m', `hkb heartbeat #${n} attempt ${k} at ${at.toISOString()}`]);
  if (made.status !== 0 || !SHA_RE.test(made.stdout)) return fail(`git commit-tree: ${short(made.out) || 'failed'}`);

  const push = git(root, ['push', remote, `${made.stdout}:${ref}`, `--force-with-lease=${ref}:${expected}`], { timeout: 60_000 });
  const result = classifyLeasePush(push.status, push.out);
  if (result === 'ok') git(root, ['update-ref', ref, made.stdout]); // remember where the chain is now
  return { result, sha: result === 'ok' ? made.stdout : null, expected, detail: short(push.out) };
}

/** Point this worktree's mirror of the lock ref at `sha` (after GitHub told us where the ref is). */
export function resyncBeatChain(root, n, k, sha) {
  return SHA_RE.test(String(sha || '')) && git(root, ['update-ref', lockRef(n, k), sha]).status === 0;
}

/** Forget the local mirror. Worktrees share one ref store, so a finished attempt must not litter it. */
export function dropBeatChain(root, n, k) {
  return git(root, ['update-ref', '-d', lockRef(n, k)]).status === 0;
}

/** Every local beat-chain mirror in this checkout: [{ref, n, k}]. What `hkb gc` prunes. */
export function listBeatChains(root) {
  const r = git(root, ['for-each-ref', '--format=%(refname)', 'refs/kb/locks/']);
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((ref) => {
    const m = /^refs\/kb\/locks\/(\d+)\/(\d+)$/.exec(ref.trim());
    return m ? { ref: ref.trim(), n: Number(m[1]), k: Number(m[2]) } : null;
  }).filter(Boolean);
}

/** All lock refs in the repo: [{ref, n, k}]. */
export async function listLocks(ctx) {
  let refs = [];
  try { refs = (await rest('GET', api(ctx, '/git/matching-refs/kb/locks/'))) || []; } catch (e) {
    if (e instanceof GhError && e.kind === 'notfound') return [];
    throw e;
  }
  return refs.map((r) => {
    const m = /^refs\/kb\/locks\/(\d+)\/(\d+)$/.exec(r.ref);
    return m ? { ref: r.ref, n: Number(m[1]), k: Number(m[2]), sha: r.object?.sha } : null;
  }).filter(Boolean);
}
