// GitHub Issues, read-only — the one place hkb still speaks the protocol its board used to be
// written in, and the only caller is the migration (`importGithubBoard`, src/store/local.js) plus
// the leftovers it sweeps up afterwards.
//
// **This is not a store.** It has no `openStore` branch, no writes, no claims to take and no run
// record to save; `src/store/github.js` — the driver that had all of that — is gone (ADR-006,
// docs/local-first.md §1 item 9). What survives is exactly what it takes to read a board that is
// still on issues once, so `hkb init --import` can move it onto the `kb-board` branch, and to delete
// the `refs/kb/locks/<n>/<k>` refs that protocol leaves behind on the forge.
//
// It lives under `src/bridge/` because that is where the *bridge* adapter goes when it comes back
// (§8: a human-opened issue becoming a triage card, a card mirrored back onto an issue). This file
// is its read half, arrived early.
import { rest, graphql, GhError } from '../gh.js';
import { api, kanbanDir, runGit, normalizeCardGrants } from '../board.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  L, parseBodyBlock, statusOf, agentOf, boardOf, tagBlockers,
  RUN_MARKER, parseRunComment, emptyRun,
} from '../model.js';

/** Where a claim lived under the GitHub protocol. Defined here and nowhere else: no live code path
 *  writes one any more, and the migration is the last thing that has to know the name. */
export const lockRef = (n, k) => `refs/kb/locks/${n}/${k}`;
const lockRefPath = (n, k) => `kb/locks/${n}/${k}`;

// ---------- capability detection ----------

/**
 * Which GraphQL fields this repository's schema has. Cached per repo in `.kanban/cache.json`, the
 * same file the GitHub store used, so a migration on a checkout that has one spends nothing.
 * @param {any} ctx
 * @param {{force?: boolean}} [opts]
 */
export async function detectCaps(ctx, { force = false } = {}) {
  const file = path.join(kanbanDir(ctx.root), 'cache.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none */ }
  if (!force && cache.caps && Date.now() - (cache.at || 0) < 7 * 86400_000) { ctx.caps = cache.caps; return ctx.caps; }
  const q = 'query { __type(name: "Issue") { fields(includeDeprecated: false) { name } } }';
  const names = new Set(((await graphql(q))?.__type?.fields || []).map((f) => f.name));
  ctx.caps = {
    blockedByGql: names.has('blockedBy'),
    closedByPrs: names.has('closedByPullRequestsReferences'),
  };
  try { fs.mkdirSync(kanbanDir(ctx.root), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ at: Date.now(), caps: ctx.caps }, null, 2)); } catch { /* ignore */ }
  return ctx.caps;
}

// ---------- reading ----------

const ISSUE_FIELDS = (caps) => `
  number id databaseId title body state stateReason updatedAt createdAt url
  labels(first: 40) { nodes { name } }
  ${caps.blockedByGql ? 'blockedBy(first: 50) { totalCount nodes { number state stateReason title } }' : ''}
`;

/** One issue as `src/model.js` reads a card — the same shape every `Store` answers with. */
function toTask(node) {
  const labels = (node.labels?.nodes || []).map((l) => l.name);
  const { kb, rest: bodyText } = parseBodyBlock(node.body);
  normalizeCardGrants(kb);
  return {
    number: node.number,
    nodeId: node.id,
    databaseId: node.databaseId,
    title: node.title,
    body: node.body || '',
    bodyText,
    kb,
    labels,
    status: statusOf(labels),
    agent: agentOf(labels),
    board: boardOf(labels),
    needsHuman: labels.includes(L.needsHuman),
    state: node.state,
    stateReason: node.stateReason,
    updatedAt: node.updatedAt,
    createdAt: node.createdAt,
    url: node.url,
    blockedBy: (node.blockedBy?.nodes || []).map((b) => ({ number: b.number, state: b.state, stateReason: b.stateReason, title: b.title })),
    // Pull requests are the forge's and are joined to a card by head branch (`fillPrs`,
    // src/forge.js). The migration does not read them, so this adapter does not ask for them.
    prs: [],
  };
}

/** Fill blockedBy via REST when the GraphQL field is unavailable. */
async function fillBlockedByRest(ctx, task) {
  try {
    const deps = await rest('GET', api(ctx, `/issues/${task.number}/dependencies/blocked_by?per_page=50`));
    task.blockedBy = (deps || []).map((d) => ({ number: d.number, state: String(d.state).toUpperCase(), stateReason: d.state_reason ? String(d.state_reason).toUpperCase() : null, title: d.title }));
  } catch (e) {
    if (e instanceof GhError && e.kind === 'notfound') task.blockedBy = [];
    else throw e;
  }
}

/**
 * Every card on the board, one query per page. `blockers` is the same three-valued option the
 * `Store` interface has, and the migration always asks for `'all'` — §6.2's branch has no way to
 * say "nobody read this", so `cardRecord` refuses to guess.
 * @param {any} ctx
 * @param {{includeClosed?: boolean, blockers?: boolean|'all'}} [opts]
 */
export async function fetchBoard(ctx, { includeClosed = false, blockers = true } = {}) {
  await detectCaps(ctx);
  const states = includeClosed ? '[OPEN, CLOSED]' : '[OPEN]';
  const q = `query($owner: String!, $repo: String!, $labels: [String!], $cursor: String) {
    repository(owner: $owner, name: $repo) {
      issues(first: 100, states: ${states}, labels: $labels, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
        pageInfo { hasNextPage endCursor }
        nodes { ${ISSUE_FIELDS(ctx.caps)} }
      }
    }
  }`;
  const tasks = [];
  let cursor = null;
  for (;;) {
    const data = await graphql(q, { owner: ctx.repo.owner, repo: ctx.repo.repo, labels: [L.board(ctx.board)], cursor });
    const conn = data.repository.issues;
    for (const n of conn.nodes) tasks.push(toTask(n));
    if (!conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  if (ctx.caps.blockedByGql) return tagBlockers(tasks, { source: 'graphql', filled: true, scope: 'all' });
  if (!blockers) return tagBlockers(tasks, { source: null, filled: false, scope: 'none' });
  const wanted = blockers === 'all'
    ? (t) => String(t.state).toUpperCase() === 'OPEN'
    : (t) => t.status === 'todo' || t.status === 'blocked';
  for (const t of tasks) if (wanted(t)) await fillBlockedByRest(ctx, t);
  return tagBlockers(tasks, { source: 'rest', filled: true, scope: blockers === 'all' ? 'open' : 'waiting' });
}

/**
 * The most recently updated *closed* cards on the board. One query, no paging: the migration takes
 * a window, not a history, and names its own ceiling when the page comes back full.
 * @param {any} ctx
 * @param {{first?: number}} [opts]
 */
export async function fetchClosedRecent(ctx, { first = 50 } = {}) {
  await detectCaps(ctx);
  const q = `query($owner: String!, $repo: String!, $labels: [String!], $first: Int!) {
    repository(owner: $owner, name: $repo) {
      issues(first: $first, states: [CLOSED], labels: $labels, orderBy: {field: UPDATED_AT, direction: DESC}) {
        nodes { ${ISSUE_FIELDS(ctx.caps)} }
      }
    }
  }`;
  const data = await graphql(q, { owner: ctx.repo.owner, repo: ctx.repo.repo, labels: [L.board(ctx.board)], first });
  return (data.repository.issues.nodes || []).map(toTask);
}

/**
 * Every comment on an issue, memoized on the context: the run record, the results and the notes all
 * come out of one read, which is what keeps the migration to one comments request per card.
 * @param {any} ctx
 * @param {number} number
 */
export async function listComments(ctx, number) {
  const key = `comments:${number}`;
  if (ctx._cache[key]) return ctx._cache[key];
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await rest('GET', api(ctx, `/issues/${number}/comments?per_page=100&page=${page}`));
    out.push(...(batch || []));
    if (!batch || batch.length < 100) break;
  }
  ctx._cache[key] = out;
  return out;
}

/**
 * The authoritative run comment when an issue has several — a create that raced another create.
 * Newest wins: it is the one the dispatcher wrote last. Here rather than in `src/model.js` because
 * a run record is a *file* on the branch now and cannot have duplicates; only a board still on
 * issues can, and this is the only thing that reads one.
 */
function pickRunComment(comments) {
  const runs = (comments || []).filter((c) => c && typeof c.body === 'string' && c.body.startsWith(RUN_MARKER));
  if (!runs.length) return { chosen: null, duplicates: [] };
  return { chosen: runs[runs.length - 1], duplicates: runs.slice(0, -1) };
}

/**
 * One card's run record as the GitHub protocol kept it: the `<!-- kb-run -->` comment.
 * `{run, id, duplicates}`, the shape the migration reads.
 * @param {any} ctx
 * @param {number} number
 */
export async function loadRun(ctx, number) {
  const picked = pickRunComment(await listComments(ctx, number));
  if (!picked.chosen) return { id: null, run: emptyRun(), duplicates: [] };
  return { id: picked.chosen.id, run: parseRunComment(picked.chosen.body) || emptyRun(), duplicates: picked.duplicates.map((c) => c.id) };
}

/**
 * The board as a read-only `Store`-shaped object, for a caller that wants `listTasks`/
 * `listClosedRecent` and nothing else. Everything a store can *write* is deliberately absent: a
 * migration reads GitHub and writes the branch, never the other way round.
 * @param {any} ctx
 */
export function openGithubIssues(ctx) {
  return {
    kind: 'github-issues',
    ctx,
    /** @param {{states?: string[], blockers?: boolean|'all'}} [opts] */
    listTasks({ states = ['OPEN'], blockers = true } = {}) {
      const want = states.map((x) => String(x).toUpperCase());
      for (const x of want) {
        if (x === 'OPEN' || x === 'CLOSED') continue;
        const e = /** @type {any} */ (new Error(`listTasks: unknown state "${x}" — a board knows OPEN and CLOSED`));
        e.exitCode = 2;
        throw e;
      }
      if (!want.includes('OPEN')) return fetchClosedRecent(ctx);
      return fetchBoard(ctx, { includeClosed: want.includes('CLOSED'), blockers });
    },
    listClosedRecent: (opts = {}) => fetchClosedRecent(ctx, opts),
    loadRun: (n) => loadRun(ctx, n),
  };
}

/** One page is all this probe asks for. A board with more than this is still "a board". */
export const BOARD_PROBE_PAGE = 100;

/**
 * Does this repository still hold a board on GitHub Issues?
 *
 * One REST list — `GET /issues?labels=kb:board:<slug>&state=all` — and deliberately not
 * `fetchBoard`: the caller is `hkb init`, which is about to create the `kb-board` branch and only
 * needs to know whether doing so would leave cards stranded. It never throws: an unreachable forge
 * (offline, `gh` logged out, a repo that does not exist) is an *answer* — "could not check" — and
 * the decision about what to do with that belongs to the caller, not here (`migrationVerdict`,
 * src/init.js).
 *
 * `pull_request` rows are dropped: `/issues` returns pull requests too, and a PR carrying a board
 * label is not a card.
 * @param {any} ctx
 * @param {string} [board] the board slug, as `kb:board:<slug>`
 * @returns {Promise<{label: string, reachable: boolean, count: number, capped: boolean, why: string|null}>}
 */
export async function countBoardIssues(ctx, board = 'default') {
  const label = L.board(board || 'default');
  const q = `?state=all&per_page=${BOARD_PROBE_PAGE}&labels=${encodeURIComponent(label)}`;
  try {
    const rows = await rest('GET', api(ctx, `/issues${q}`));
    const cards = (Array.isArray(rows) ? rows : []).filter((r) => !r?.pull_request);
    return { label, reachable: true, count: cards.length, capped: cards.length >= BOARD_PROBE_PAGE, why: null };
  } catch (e) {
    return { label, reachable: false, count: 0, capped: false, why: (e && /** @type {any} */ (e).message) || String(e) };
  }
}

// ---------- the claims the old protocol left on the forge ----------

/** All lock refs in the repo: `[{ref, n, k, sha}]`. */
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

/**
 * When a lock ref last moved: the committer date of the commit it points at. That was the only
 * trace a ref-CAS heartbeat left, and it is how the migration tells a dead claim from a worker
 * still holding one. null when unknowable.
 * @param {any} ctx
 * @param {string|null} sha
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

/** Delete one lock ref. False — never a throw — when it was already gone. */
export async function release(ctx, n, k) {
  try {
    await rest('DELETE', api(ctx, `/git/refs/${lockRefPath(n, k)}`));
    return true;
  } catch (e) {
    if (e instanceof GhError && (e.kind === 'notfound' || (e.kind === 'validation' && /does not exist/i.test(e.message)))) return false;
    throw e;
  }
}

/** Every local beat-chain mirror in this checkout: `[{ref, n, k}]`. */
export function listBeatChains(root) {
  const r = runGit(root, ['for-each-ref', '--format=%(refname)', 'refs/kb/locks/']);
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((ref) => {
    const m = /^refs\/kb\/locks\/(\d+)\/(\d+)$/.exec(ref.trim());
    return m ? { ref: ref.trim(), n: Number(m[1]), k: Number(m[2]) } : null;
  }).filter(Boolean);
}

/** Forget one local mirror. Worktrees share a ref store, so a migration must not litter it. */
export function dropBeatChain(root, n, k) {
  return runGit(root, ['update-ref', '-d', lockRef(n, k)]).status === 0;
}
