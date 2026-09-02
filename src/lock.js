// Claims live in git refs: the only atomic create-if-absent primitive GitHub offers.
//   claim   = POST git/refs {ref: refs/kb/locks/<n>/<k>}  → 201 claimed · 409/"already exists" held · anything else unknown
//   check   = GET  git/ref/kb/locks/<n>/<k>              → 404 means LOCK_LOST (dispatcher reclaimed)
//   beat    = git push <new>:<ref> --force-with-lease=<ref>:<expected>  → rejected means LOCK_LOST
//   release = DELETE git/refs/kb/locks/<n>/<k>
import { spawnSync } from 'node:child_process';
import { rest, restRaw, GhError } from './gh.js';
import { api } from './board.js';
import { lockRef, lockRefPath, classifyLeasePush, trackBranchName, trackBranchRoot } from './model.js';

/** One conditional read of a branch head. A 304 means "still `known`" and costs no rate limit. */
async function readHead(ctx, branch, known) {
  const etag = known && known.branch === branch ? known.etag : null;
  const r = await restRaw('GET', api(ctx, `/git/ref/heads/${branch}`), { headers: etag ? { 'If-None-Match': etag } : {} });
  if (r.status === 304) {
    if (known?.sha) return { branch, sha: known.sha, etag: known.etag };
    throw new GhError(`GET git/ref/heads/${branch} answered 304 with nothing cached`, { status: 304, kind: 'unknown' });
  }
  // a prefix match returns an array (the branch itself does not exist) — same fix as a 404
  const sha = Array.isArray(r.data) ? null : r.data?.object?.sha;
  if (!sha) throw new GhError(`GET git/ref/heads/${branch} returned no sha`, { status: r.status || 404, kind: 'notfound' });
  return { branch, sha, etag: r.headers?.etag || null };
}

/**
 * The default branch head every claim is created at — **not** a process-lifetime cache.
 * `staleBaseSha(ctx)` marks the cached value for revalidation (the dispatcher does it once per
 * tick), and the next call re-reads the ref with `If-None-Match`: a quiet repo answers 304, which
 * is free, and a moved branch is picked up within the tick. A sha can never outlive one tick, so a
 * process cannot go on POSTing claims at a sha GitHub has forgotten (the #61 outage).
 */
export async function baseSha(ctx) {
  const known = ctx._cache.base || null;
  if (known?.sha && known.fresh) return known.sha;
  const branch = ctx.cfg?.default_branch || 'main';
  let head;
  try {
    head = await readHead(ctx, branch, known);
  } catch (e) {
    if (!(e instanceof GhError && e.kind === 'notfound')) throw e;
    const repo = await rest('GET', api(ctx));
    head = await readHead(ctx, repo.default_branch, known);
  }
  ctx._cache.base = { ...head, fresh: true };
  return head.sha;
}

/** Mark the cached base sha for revalidation. The etag survives, so the re-read is usually a 304. */
export function staleBaseSha(ctx) {
  if (ctx?._cache?.base) ctx._cache.base.fresh = false;
}

/** Classify a failed ref-create. Exported for tests. */
export function classifyClaimError(err) {
  if (!(err instanceof GhError)) return 'unknown';
  if (err.status === 409) return 'held';
  if (err.status === 422 && /already exists/i.test(err.message + err.body)) return 'held';
  return 'unknown'; // 422 (spam/validation), 403, 429, 5xx, network: never conclude "held"
}

/**
 * @returns {Promise<{result: 'claimed'|'held'|'unknown', ref: string, sha: string|null, error?: Error|null}>}
 *   `result` is the outcome, with `error` carried only for 'unknown'. `sha` starts the beat chain.
 */
export async function claim(ctx, n, k) {
  let sha;
  try {
    sha = await baseSha(ctx);
  } catch (e) {
    // A base sha we cannot resolve is the same news as a POST we cannot classify: nothing is known
    // about the lock. Returning it as `unknown` rather than throwing keeps the caller's back-off —
    // and the dispatcher's self-heal ladder — in charge of a claim that will not resolve.
    return { result: 'unknown', ref: lockRef(n, k), sha: null, error: e };
  }
  try {
    await rest('POST', api(ctx, '/git/refs'), { body: { ref: lockRef(n, k), sha } });
    return { result: 'claimed', ref: lockRef(n, k), sha };
  } catch (e) {
    const result = classifyClaimError(e);
    return { result, ref: lockRef(n, k), sha: null, error: result === 'unknown' ? e : null };
  }
}

/**
 * Create a track's integration branch from the default branch, idempotently, and return its name.
 * A track root can be claimed more than once for the same subgraph — a runner that crashed before
 * its attempt ever recorded `ended_at` leaves `trackAlreadyAttempted` false, so the next claim tries
 * again — and the branch must be *reused*, not recreated: children already based work on it. Reusing
 * on "already exists" is exactly the claim protocol's own "held" outcome, just for a ref nothing
 * locks — so the classifier is shared. Any other failure (auth, rate limit, network) is left to
 * throw: the caller treats it the same as a spawn that never started.
 */
export async function ensureTrackBranch(ctx, rootNumber) {
  const name = trackBranchName(rootNumber);
  const sha = await baseSha(ctx);
  try {
    await rest('POST', api(ctx, '/git/refs'), { body: { ref: `refs/heads/${name}`, sha } });
  } catch (e) {
    if (!(e instanceof GhError) || classifyClaimError(e) !== 'held') throw e;
  }
  return name;
}

/** Does this track branch still exist? Doctor's own read — never cached, never assumed. */
export async function trackBranchSha(ctx, rootNumber) {
  try {
    const r = await rest('GET', api(ctx, `/git/ref/heads/${trackBranchName(rootNumber)}`));
    return Array.isArray(r) ? null : r?.object?.sha || null;
  } catch (e) {
    if (e instanceof GhError && e.kind === 'notfound') return null;
    throw e;
  }
}

/** Delete a track's integration branch. Never throws on "already gone" — deletion is idempotent too. */
export async function deleteTrackBranch(ctx, rootNumber) {
  try {
    await rest('DELETE', api(ctx, `/git/refs/heads/${trackBranchName(rootNumber)}`));
    return true;
  } catch (e) {
    if (e instanceof GhError && (e.kind === 'notfound' || (e.kind === 'validation' && /does not exist/i.test(e.message)))) return false;
    throw e;
  }
}

/**
 * Every track branch on the repo (`kb/track-<root>`), by root number — one paginated read via
 * `git/matching-refs`, however many tracks the board has ever run. What `hkb doctor` cross-checks
 * against the board to find one with no live runner (`checkTrackBranches`, src/doctor.js).
 */
export async function listTrackBranches(ctx) {
  const rows = await rest('GET', api(ctx, '/git/matching-refs/heads/kb/track-'));
  const out = [];
  for (const row of rows || []) {
    const name = String(row.ref || '').replace(/^refs\/heads\//, '');
    const root = trackBranchRoot(name);
    if (root) out.push({ branch: name, root, sha: row.object?.sha || null });
  }
  return out;
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
  /** @type {(detail: string) => {result:'ok'|'lost'|'unavailable', sha:string|null, expected:string, detail:string}} */
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
