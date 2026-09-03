// The GitHub store: issues are cards, labels are status, comments are the run record and the
// results, git refs are the claims. Every body below was **moved, not rewritten** — from
// `src/tasks.js` (issue <-> task mapping, labels, comments, dependencies) and from `src/lock.js`
// (ref claims and the CAS heartbeat). `src/tasks.js` and `src/lock.js` are now re-export shims over
// this file, so no caller changed when the seam went in.
//
// `openGithubStore(ctx)` at the bottom is the §6.4 `Store` interface (docs/local-first.md) over the
// same functions: the names the local tiers implement in parallel. The pull-request half is *not*
// here — it is `src/forge.js`, and a local store keeps using it unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { rest, restRaw, graphql, GhError } from '../gh.js';
import {
  api, kanbanDir, loadBoard, saveBoard, storeRoot,
  runGit, gitSays, GIT_SHA_RE, normalizeCardGrants,
} from '../board.js';
import {
  L, LABEL_COLORS, STATUSES, parseBodyBlock, serializeBodyBlock, statusOf, agentOf, boardOf,
  parseRunComment, serializeRunComment, parseResultComment, RESULT_MARKER, emptyRun, pickRunComment,
  lockRef, lockRefPath, classifyLeasePush, trackBranchName, trackBranchRoot, RUN_MARKER
} from '../model.js';
import { openPrsByHead, branchFallbackPrs } from '../forge.js';

// ---------- capability detection (cached per repo in .kanban/cache.json) ----------

export async function detectCaps(ctx, { force = false } = {}) {
  const file = path.join(kanbanDir(ctx.root), 'cache.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none */ }
  if (!force && cache.caps && Date.now() - (cache.at || 0) < 7 * 86400_000) { ctx.caps = cache.caps; return ctx.caps; }
  const data = await graphql('query { __type(name: "Issue") { fields { name } } }');
  const fields = new Set((data?.__type?.fields || []).map((f) => f.name));
  ctx.caps = {
    blockedByGql: fields.has('blockedBy'),
    closedByPrs: fields.has('closedByPullRequestsReferences'),
  };
  try { fs.mkdirSync(kanbanDir(ctx.root), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ at: Date.now(), caps: ctx.caps }, null, 2)); } catch { /* ignore */ }
  return ctx.caps;
}

// ---------- reading ----------

const ISSUE_FIELDS = (caps) => `
  number id databaseId title body state stateReason updatedAt createdAt url
  labels(first: 40) { nodes { name } }
  ${caps.blockedByGql ? 'blockedBy(first: 50) { totalCount nodes { number state stateReason title } }' : ''}
  ${caps.closedByPrs ? 'closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { id number state isDraft url headRefName baseRefName merged autoMergeRequest { enabledAt mergeMethod } } }' : ''}
`;

/**
 * The card-level grant keys, as `effectiveTools` will read them.
 *
 * `kb.tools` (tool patterns) and `kb.mcp` (MCP server names) are the two keys a card narrows its
 * profile's grant with — subsets only, enforced in `effectiveTools` (src/model.js) and nowhere else.
 * The shape they are settled into is `normalizeCardGrants` (src/board.js), which lives there rather
 * than here because the local store reads cards too: `src/store/git.js` had a private copy of this
 * function, and two stores that normalized grants differently would be a permissions bug.
 *
 * Re-exported because `src/tasks.js` re-exports it from this module and `hkb doctor` reads it there.
 */
export { normalizeCardGrants };

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
    prs: (node.closedByPullRequestsReferences?.nodes || []).map((p) => ({ number: p.number, nodeId: p.id, state: p.state, isDraft: p.isDraft, url: p.url, headRefName: p.headRefName, baseRefName: p.baseRefName || null, merged: p.merged, autoMergeEnabled: !!p.autoMergeRequest })),
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
 * What a board's `blockedBy` lists actually mean, recorded on the array `fetchBoard` returns.
 *
 *   source  'graphql' (they rode the board query), 'rest' (one call per card), or null
 *   filled  were they looked up at all
 *   scope   'all' every card · 'open' every open card · 'waiting' only todo/blocked · 'none'
 *
 * A caller that cannot tell these apart reports "no blockers" for a card nobody asked about —
 * a silently wrong answer, which is the one failure mode the values forbid.
 */
function tagBlockers(tasks, meta) {
  // non-enumerable: JSON.stringify, Object.keys and every spread of the board stay an array of tasks
  Object.defineProperty(tasks, 'blockers', { value: Object.freeze(meta), enumerable: false, configurable: true });
  return tasks;
}

/** The blocker provenance of a board `fetchBoard` returned. Safe on any array. */
export function blockersOf(board) {
  return board?.blockers || { source: null, filled: false, scope: 'none' };
}

/**
 * Is this task's `blockedBy` a real answer, or was it simply never looked up? An empty list on a
 * card outside the fill-in's scope means "unknown", never "no blockers".
 */
export function blockersKnown(board, task) {
  const { scope } = blockersOf(board);
  if (scope === 'all') return true;
  if (scope === 'open') return String(task?.state || 'OPEN').toUpperCase() === 'OPEN';
  if (scope === 'waiting') return task?.status === 'todo' || task?.status === 'blocked';
  return false;
}

/**
 * Every task on the board, one query per page.
 *
 * `blockers` says how much the caller needs on a repo *without* the GraphQL `blockedBy` field,
 * where each list costs one REST call:
 *   true   the tick's lanes only — todo and blocked, the cards a promote decision reads
 *   'all'  every open card, for a caller (`hkb groom`) that reports on all of them
 *   false  none, for a caller that only reads labels (doctor) and must not pay a board's worth
 * On a repo that *has* the field all three are the same single query and cost nothing extra.
 * Either way the result carries `blockers` — see `blockersOf` / `blockersKnown`.
 */
/**
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
  await fillPrFallback(ctx, tasks);
  if (ctx.caps.blockedByGql) return tagBlockers(tasks, { source: 'graphql', filled: true, scope: 'all' });
  if (!blockers) return tagBlockers(tasks, { source: null, filled: false, scope: 'none' });
  const wanted = blockers === 'all'
    ? (t) => String(t.state).toUpperCase() === 'OPEN'
    : (t) => t.status === 'todo' || t.status === 'blocked';
  for (const t of tasks) if (wanted(t)) await fillBlockedByRest(ctx, t);
  return tagBlockers(tasks, { source: 'rest', filled: true, scope: blockers === 'all' ? 'open' : 'waiting' });
}

/**
 * The head-branch fallback (`branchFallbackPrs`), applied board-wide: one `openPrsByHead` read when
 * at least one task came back with no PR from GraphQL, none at all otherwise. One request per tick,
 * never one per card — the cost the fallback is allowed to spend (#234).
 */
async function fillPrFallback(ctx, tasks) {
  if (!tasks.some((t) => !(t.prs || []).length)) return;
  const openByHead = await openPrsByHead(ctx);
  for (const t of tasks) t.prs = branchFallbackPrs(t, openByHead);
}

/**
 * The most recently updated *closed* issues on the board — the reconcile input.
 * One query, no paging: an issue closed by a merged PR is by definition freshly updated,
 * so it sits at the top of UPDATED_AT desc. Blockers are not filled in (reconcile never reads them).
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

export async function getTask(ctx, number) {
  await detectCaps(ctx);
  const q = `query($owner: String!, $repo: String!, $n: Int!) {
    repository(owner: $owner, name: $repo) { issue(number: $n) { ${ISSUE_FIELDS(ctx.caps)} } }
  }`;
  let data;
  try {
    data = await graphql(q, { owner: ctx.repo.owner, repo: ctx.repo.repo, n: Number(number) });
  } catch (e) {
    if (e instanceof GhError && e.kind === 'notfound' && /could not resolve to (a|an) issue/i.test(e.message)) {
      const err = new Error(`issue #${number} not found in ${ctx.repo.nameWithOwner}`);
      err.exitCode = 2;
      throw err;
    }
    throw e;
  }
  const node = data.repository.issue;
  if (!node) { const e = new Error(`issue #${number} not found in ${ctx.repo.nameWithOwner}`); e.exitCode = 2; throw e; }
  const task = toTask(node);
  if (!ctx.caps.blockedByGql) await fillBlockedByRest(ctx, task);
  await fillPrFallback(ctx, [task]);
  return task;
}

export function assertOnBoard(ctx, task) {
  if (task.board !== ctx.board) {
    const e = new Error(`issue #${task.number} is not on board "${ctx.board}" (labels: ${task.labels.join(', ') || 'none'}). Use --board or \`hkb adopt ${task.number}\`.`);
    e.exitCode = 2;
    throw e;
  }
}

// ---------- comments ----------

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

export async function findRunComment(ctx, number) {
  const comments = await listComments(ctx, number);
  const picked = pickRunComment(comments);
  if (!picked.chosen) return null;
  return { id: picked.chosen.id, run: parseRunComment(picked.chosen.body) || emptyRun(), duplicates: picked.duplicates.map((c) => c.id) };
}

/** The run record: `{ id, run, duplicates }`. Mutated in place by saveRun so a create is followed by updates, never a second create. */
export async function loadRun(ctx, number) {
  const found = await findRunComment(ctx, number);
  return found ? found : { id: null, run: emptyRun(), duplicates: [] };
}

export async function saveRun(ctx, number, rec) {
  const body = serializeRunComment(rec.run);
  delete ctx._cache[`comments:${number}`];
  if (rec.id) return rest('PATCH', api(ctx, `/issues/comments/${rec.id}`), { body: { body } });
  const created = await rest('POST', api(ctx, `/issues/${number}/comments`), { body: { body } });
  rec.id = created.id;
  return created;
}

export async function deleteComment(ctx, number, commentId) {
  delete ctx._cache[`comments:${number}`];
  try { await rest('DELETE', api(ctx, `/issues/comments/${commentId}`)); return true; } catch (e) {
    if (e instanceof GhError && e.kind === 'notfound') return false;
    throw e;
  }
}

export async function latestResult(ctx, number) {
  const comments = await listComments(ctx, number);
  const results = comments.filter((x) => x.body && x.body.startsWith(RESULT_MARKER));
  if (!results.length) return null;
  const last = results[results.length - 1];
  return { ...parseResultComment(last.body), at: last.created_at, url: last.html_url };
}

export async function addComment(ctx, number, body) {
  delete ctx._cache[`comments:${number}`];
  return rest('POST', api(ctx, `/issues/${number}/comments`), { body: { body } });
}

/** `## Parent task results` — what Hermes puts in worker context. */
export async function parentResults(ctx, task) {
  const out = [];
  for (const b of task.blockedBy || []) {
    const r = await latestResult(ctx, b.number);
    out.push({ number: b.number, title: b.title, state: b.state, result: r });
  }
  return out;
}

// ---------- labels & status ----------

export async function ensureLabels(ctx, names) {
  const existing = new Set();
  for (let page = 1; page <= 3; page++) {
    const batch = await rest('GET', api(ctx, `/labels?per_page=100&page=${page}`));
    for (const l of batch || []) existing.add(l.name);
    if (!batch || batch.length < 100) break;
  }
  const created = [];
  for (const name of names) {
    if (existing.has(name)) continue;
    const color = LABEL_COLORS[name] || (name.startsWith('kb:agent:') ? '1d76db' : name.startsWith('kb:board:') ? 'ededed' : 'ededed');
    try {
      await rest('POST', api(ctx, '/labels'), { body: { name, color, description: 'hkb' } });
      created.push(name);
    } catch (e) {
      if (!(e instanceof GhError && e.kind === 'validation')) throw e; // already exists → fine
    }
  }
  return created;
}

export async function setStatus(ctx, task, status, { add = [], remove = [] } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`invalid status ${status}`);
  const toRemove = new Set([...task.labels.filter((l) => l.startsWith('kb:status:') && l !== L.status(status)), ...remove]);
  const toAdd = [L.status(status), ...add].filter((l) => !task.labels.includes(l) || l === L.status(status));
  for (const l of toRemove) {
    try { await rest('DELETE', api(ctx, `/issues/${task.number}/labels/${encodeURIComponent(l)}`)); } catch (e) { if (!(e instanceof GhError && e.kind === 'notfound')) throw e; }
  }
  const missing = toAdd.filter((l) => !task.labels.includes(l));
  if (missing.length) await rest('POST', api(ctx, `/issues/${task.number}/labels`), { body: { labels: missing } });
  task.labels = [...task.labels.filter((l) => !toRemove.has(l)), ...missing];
  task.status = status;
  return task;
}

export async function addLabels(ctx, task, labels) {
  const missing = labels.filter((l) => !task.labels.includes(l));
  if (!missing.length) return task;
  await rest('POST', api(ctx, `/issues/${task.number}/labels`), { body: { labels: missing } });
  task.labels.push(...missing);
  return task;
}

/**
 * The task's profile, and only that one. Adding `kb:agent:X` without taking the old one off is a
 * write that reports success and changes nothing (#113): the card ends up with two `kb:agent:*`
 * labels, `agentOf` takes the first, and `hkb adopt <root> --agent claude-track` — the documented
 * way to make a track — left the root dispatching node-by-node as `claude`.
 *
 * Add first, then remove: a half-applied set leaves the card on two profiles, which is what it
 * already was, never on none — a card with no `kb:agent:*` is one the dispatcher has to guess for.
 */
export async function setAgent(ctx, task, profile) {
  const want = L.agent(profile);
  const stale = task.labels.filter((l) => l.startsWith('kb:agent:') && l !== want);
  await addLabels(ctx, task, [want]);
  for (const l of stale) await removeLabel(ctx, task, l);
  task.agent = profile;
  return task;
}

export async function removeLabel(ctx, task, label) {
  if (!task.labels.includes(label)) return task;
  try { await rest('DELETE', api(ctx, `/issues/${task.number}/labels/${encodeURIComponent(label)}`)); } catch (e) { if (!(e instanceof GhError && e.kind === 'notfound')) throw e; }
  task.labels = task.labels.filter((l) => l !== label);
  return task;
}

// ---------- issues ----------

export async function createIssue(ctx, { title, body, labels }) {
  return rest('POST', api(ctx, '/issues'), { body: { title, body, labels } });
}

export async function updateBody(ctx, task, kb, bodyText = task.bodyText) {
  const body = serializeBodyBlock(kb, bodyText);
  await rest('PATCH', api(ctx, `/issues/${task.number}`), { body: { body } });
  task.kb = kb; task.body = body; task.bodyText = bodyText;
  return task;
}

export async function closeIssue(ctx, number, reason = 'completed') {
  return rest('PATCH', api(ctx, `/issues/${number}`), { body: { state: 'closed', state_reason: reason } });
}
export async function reopenIssue(ctx, number) {
  return rest('PATCH', api(ctx, `/issues/${number}`), { body: { state: 'open' } });
}

export async function issueDatabaseId(ctx, number) {
  const t = await rest('GET', api(ctx, `/issues/${number}`));
  return { id: t.id, labels: (t.labels || []).map((l) => l.name), state: t.state, state_reason: t.state_reason, title: t.title, number: t.number };
}

/** child blocked_by parent. Cross-board links are refused by the caller. */
export async function addBlockedBy(ctx, childNumber, parentNumber) {
  const parent = await issueDatabaseId(ctx, parentNumber);
  try {
    return await rest('POST', api(ctx, `/issues/${childNumber}/dependencies/blocked_by`), { body: { issue_id: parent.id } });
  } catch (e) {
    if (e instanceof GhError && e.kind === 'validation' && /already/i.test(e.message)) return null;
    if (e instanceof GhError && e.kind === 'notfound') {
      const err = new GhError(`issue dependencies API not available for ${ctx.repo.nameWithOwner} (404). Run \`hkb doctor --api\`.`, { kind: 'notfound', status: 404 });
      throw err;
    }
    throw e;
  }
}

export async function removeBlockedBy(ctx, childNumber, parentNumber) {
  const parent = await issueDatabaseId(ctx, parentNumber);
  try {
    return await rest('DELETE', api(ctx, `/issues/${childNumber}/dependencies/blocked_by/${parent.id}`));
  } catch (e) {
    if (e instanceof GhError && e.kind === 'notfound') return null;
    throw e;
  }
}

export async function issueEvents(ctx, number) {
  return (await rest('GET', api(ctx, `/issues/${number}/events?per_page=100`))) || [];
}

// ---------- claims: git refs ----------
// Claims live in git refs: the only atomic create-if-absent primitive GitHub offers.
//   claim   = POST git/refs {ref: refs/kb/locks/<n>/<k>}  → 201 claimed · 409/"already exists" held · anything else unknown
//   check   = GET  git/ref/kb/locks/<n>/<k>              → 404 means LOCK_LOST (dispatcher reclaimed)
//   beat    = git push <new>:<ref> --force-with-lease=<ref>:<expected>  → rejected means LOCK_LOST
//   release = DELETE git/refs/kb/locks/<n>/<k>

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

// `runGit`, `gitSays` and `GIT_SHA_RE` are `src/board.js`'s: the same three helpers were copied here
// and into `src/store/git.js`, and the copies had drifted (the loud-line regex differed), so one
// failure read differently depending on which store hit it.
const git = runGit;
const short = gitSays;
const SHA_RE = GIT_SHA_RE;

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

// ---------- the §6.4 Store interface ----------

/**
 * The GitHub driver for the `Store` interface (docs/local-first.md §6.4). The method names are the
 * contract the local tiers implement; every body here is a call into the moved functions above, so
 * this wrapper adds no behaviour of its own — the seam is a rename, not a rewrite.
 *
 * `capabilities().events` is false: GitHub has no event log hkb can tail, so `events()` refuses
 * rather than inventing an empty one, and the conformance suite's "every mutating call appends an
 * event" invariant is skipped for this driver.
 */
export function openGithubStore(ctx) {
  const store = {
    kind: 'github',
    ctx,
    /** The store's root — the common git dir's parent, never the linked worktree. */
    root: () => storeRoot(ctx),
    capabilities: () => ({ events: false }),

    // ---- board ----
    board() {
      // `ctx.cfg` is whatever this process loaded, which inside a linked worktree is that worktree's
      // file; `setBoard` writes the store's own. Read the same place both ways or a read-modify-write
      // through the interface drops what the other file held.
      const cfg = loadBoard(storeRoot(ctx)) || ctx.cfg || {};
      return {
        slug: ctx.board,
        host: cfg.host ?? null,
        paused_at: cfg.paused_at ?? null,
        paused_by: cfg.paused_by ?? null,
        settings: cfg,
      };
    },
    setBoard(patch = {}) {
      const root = storeRoot(ctx);
      const cfg = { ...(loadBoard(root) || {}), ...patch };
      saveBoard(root, cfg);
      ctx.cfg = cfg;
      return store.board();
    },

    // ---- tasks ----
    /** @param {{states?: string[], blockers?: boolean|'all'}} [opts] */
    listTasks({ states = ['OPEN'], blockers = true } = {}) {
      const want = states.map((x) => String(x).toUpperCase());
      for (const x of want) {
        if (x === 'OPEN' || x === 'CLOSED') continue;
        const e = new Error(`listTasks: unknown state "${x}" — a store knows OPEN and CLOSED`);
        e.exitCode = 2;
        throw e;
      }
      // Closed-only is the reconcile question ("what did GitHub close behind us"), and GitHub answers
      // it as a recent page rather than the whole history — collapsing it into the open board query
      // would have returned every OPEN card to a caller that asked for none of them.
      if (!want.includes('OPEN')) return fetchClosedRecent(ctx);
      return fetchBoard(ctx, { includeClosed: want.includes('CLOSED'), blockers });
    },
    listClosedRecent: (opts = {}) => fetchClosedRecent(ctx, opts),
    getTask: (n) => getTask(ctx, n),
    /** @param {{title: string, body?: string, kb?: any, status?: string, agent?: string|null}} spec */
    async createTask({ title, body = '', kb = {}, status = 'triage', agent = null }) {
      const labels = [L.board(ctx.board), L.status(status)];
      if (agent) labels.push(L.agent(agent));
      await ensureLabels(ctx, labels);
      const issue = await createIssue(ctx, { title, body: serializeBodyBlock(kb, body), labels });
      return getTask(ctx, issue.number);
    },
    /**
     * Replace the prose, keep the machine block. A raw PATCH of the whole body drops the
     * `<!-- kb: {...} -->` line, and every field in it — priority, paths, scheduled_at, max_retries —
     * silently reverts to the defaults on the next read. The read is what makes that impossible.
     */
    async updateBody(n, body) {
      const task = await getTask(ctx, n);
      // the module-level writer, which serializes `kb` back in front of the prose
      await updateBody(ctx, task, task.kb, body);
      return task;
    },
    setStatus: (task, status, opts = {}) => setStatus(ctx, task, status, opts),
    setAgent: (task, agent) => setAgent(ctx, task, agent),
    addLabels: (task, names) => addLabels(ctx, task, names),
    removeLabel: (task, name) => removeLabel(ctx, task, name),
    closeTask: (n, reason = 'completed') => closeIssue(ctx, n, reason),
    reopenTask: (n) => reopenIssue(ctx, n),
    addBlockedBy: (child, parent) => addBlockedBy(ctx, child, parent),
    removeBlockedBy: (child, parent) => removeBlockedBy(ctx, child, parent),

    // ---- runs, results, notes ----
    loadRun: (n) => loadRun(ctx, n),
    saveRun: (n, runRec) => saveRun(ctx, n, runRec),
    latestResult: (n) => latestResult(ctx, n),
    parentResults: (task) => parentResults(ctx, task),
    addNote: (n, text) => addComment(ctx, n, text),
    async listNotes(n) {
      const comments = await listComments(ctx, n);
      // hkb's own run record and result comments live in the same list; every other reader here tells
      // them apart by their marker, and a note is what a *person* wrote.
      return comments
        .filter((c) => !String(c.body || '').includes(RUN_MARKER) && !String(c.body || '').includes(RESULT_MARKER))
        .map((c) => ({ id: c.id, at: c.created_at, actor: c.user?.login || null, text: c.body || '' }));
    },

    // ---- claims ----
    async claim(n, k) {
      const r = await claim(ctx, n, k);
      return { result: r.result, token: r.sha, ref: r.ref, error: r.error ?? null };
    },
    release: (n, k) => release(ctx, n, k),
    async listLocks() {
      const rows = await listLocks(ctx);
      // `beat_at` is one commit read per lock, and a tick only needs it for a lock that already looks
      // stale — so the listing carries the token instead, and `lockBeatAt(n, k, token)` spends the read.
      return rows.map((r) => ({ n: r.n, k: r.k, token: r.sha ?? null, beat_at: null, ref: r.ref }));
    },
    /** `token` is the sha `listLocks` already returned: pass it and this costs one read, not two. */
    lockBeatAt: async (n, k, token = null) => lockBeatAt(ctx, token || await lockSha(ctx, n, k)),
    /** The worker side: one CAS on the lock ref, leased on the attempt's own `expected` sha. */
    heartbeat(n, k, expected, opts = {}) {
      // `{ result, token }`, never the bare result: the lease is on where this worker left the ref, so
      // a caller that beats twice needs the sha this beat wrote. Returning only the verdict made the
      // second beat lease on the first one's `expected` and read back as LOCK_LOST.
      const r = casHeartbeat(ctx.root, n, k, expected, { remote: remoteName(ctx), ...opts });
      return { result: r.result, token: r.sha ?? null };
    },

    // ---- events ----
    async events() {
      const e = new Error('the GitHub store has no event log (capabilities().events is false). Move the board to the local store — see docs/local-first.md §6.');
      e.exitCode = 2;
      throw e;
    },
  };
  return store;
}
