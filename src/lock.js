// Claims live in git refs: the only atomic create-if-absent primitive GitHub offers.
//   claim   = POST git/refs {ref: refs/kb/locks/<n>/<k>}  → 201 claimed · 409/"already exists" held · anything else unknown
//   check   = GET  git/ref/kb/locks/<n>/<k>              → 404 means LOCK_LOST (dispatcher reclaimed)
//   release = DELETE git/refs/kb/locks/<n>/<k>
import { rest, GhError } from './gh.js';
import { api } from './board.js';
import { lockRef, lockRefPath } from './model.js';

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

/** @returns {'claimed'|'held'|'unknown'} plus the error for 'unknown' */
export async function claim(ctx, n, k) {
  const sha = await baseSha(ctx);
  try {
    await rest('POST', api(ctx, '/git/refs'), { body: { ref: lockRef(n, k), sha } });
    return { result: 'claimed', ref: lockRef(n, k) };
  } catch (e) {
    const result = classifyClaimError(e);
    return { result, ref: lockRef(n, k), error: result === 'unknown' ? e : null };
  }
}

export async function lockExists(ctx, n, k) {
  try {
    const r = await rest('GET', api(ctx, `/git/ref/${lockRefPath(n, k)}`));
    return !!r && !Array.isArray(r);
  } catch (e) {
    if (e instanceof GhError && e.kind === 'notfound') return false;
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
