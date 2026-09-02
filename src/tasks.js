// Issue <-> task mapping: reading the board, labels, comments, dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { rest, graphql, GhError } from './gh.js';
import { api, kanbanDir } from './board.js';
import {
  L, LABEL_COLORS, STATUSES, parseBodyBlock, serializeBodyBlock, statusOf, agentOf, boardOf,
  parseRunComment, serializeRunComment, parseResultComment, RESULT_MARKER, emptyRun, pickRunComment,
  taskBranchRe,
} from './model.js';

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
 * This is the path that feeds them in, so it is where their shape is settled: a list of non-empty
 * names, trimmed, deduplicated, order kept. Anything else in the list — a number, an object, a blank
 * string — is not a name any profile can grant, so it is removed here rather than travelling to the
 * launch to be dropped there with a confusing reason.
 *
 * A key that is not a list at all is left exactly as written. It narrows nothing (`effectiveTools`
 * only reads arrays), and coercing it would be a guess at what the author meant on the one axis
 * where guessing widens someone's permissions; `hkb doctor`'s `card grants` check reports it instead.
 * An empty list stays empty — "this task gets none of them" is a legitimate narrowing, and the
 * strictest one a card can ask for.
 */
export function normalizeCardGrants(kb) {
  for (const key of ['tools', 'mcp']) {
    if (!Array.isArray(kb?.[key])) continue;
    const names = kb[key].filter((n) => typeof n === 'string' && n.trim()).map((n) => n.trim());
    kb[key] = [...new Set(names)];
  }
  return kb;
}

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

/**
 * Every open PR on the repo, keyed by head branch — one paginated REST read. `closedByPullRequestsReferences`
 * is hkb's only source for a task's PRs, and it answers a narrower question than hkb asks of it: it
 * requires the PR to target the default branch, and #234 found at least one PR that met that bar and
 * still came back empty. hkb generates the branch names it puts a card's work on itself
 * (`taskBranchRe`), so a board-wide listing of open PRs, matched by head, is a fallback that costs one
 * request whatever the board's size rather than one per unlinked card.
 */
export async function openPrsByHead(ctx) {
  const out = new Map();
  for (let page = 1; page <= 10; page++) {
    const batch = await rest('GET', api(ctx, `/pulls?state=open&per_page=100&page=${page}`));
    for (const p of batch || []) {
      const head = p.head?.ref;
      if (!head) continue;
      out.set(head, {
        number: p.number,
        nodeId: p.node_id,
        state: 'OPEN',
        isDraft: !!p.draft,
        url: p.html_url,
        headRefName: head,
        baseRefName: p.base?.ref || null,
        merged: false,
        autoMergeEnabled: !!p.auto_merge,
      });
    }
    if (!batch || batch.length < 100) break;
  }
  return out;
}

/**
 * A task with no PR from GraphQL, matched against a board-wide open-PR listing by head branch. Pure
 * given the listing: never overrides a PR GitHub already linked, and never looks two tasks up in one
 * call, so a card that legitimately has no PR still reports none.
 */
export function branchFallbackPrs(task, openByHead) {
  if ((task.prs || []).length) return task.prs;
  const re = taskBranchRe(task.number);
  const found = [];
  for (const [head, pr] of openByHead) if (re.test(head)) found.push(pr);
  return found;
}

/**
 * `mergeable`/`mergeStateStatus` for a batch of PR numbers, one GraphQL request whatever the count.
 * REST's list-PRs endpoint (what `openPrsByHead` reads) carries neither field, and a track's
 * children are exactly the PRs `closedByPullRequestsReferences` never surfaces either (it only
 * links a PR into the default branch) — so this is the one place hkb asks GitHub outright whether
 * two children conflict on their way into the track branch (`trackConflictPass`, src/dispatch.js).
 */
export async function prMergeStates(ctx, numbers) {
  const nums = [...new Set((numbers || []).map(Number))].filter(Boolean);
  if (!nums.length) return new Map();
  const fields = nums.map((n) => `pr${n}: pullRequest(number: ${n}) { number mergeable mergeStateStatus }`).join('\n');
  const q = `query($owner:String!,$repo:String!) { repository(owner:$owner, name:$repo) { ${fields} } }`;
  const data = await graphql(q, { owner: ctx.repo.owner, repo: ctx.repo.repo });
  const out = new Map();
  for (const n of nums) {
    const pr = data?.repository?.[`pr${n}`];
    if (pr) out.set(n, { mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus });
  }
  return out;
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

// ---------- pull requests: the last step ----------

/**
 * Ask GitHub to merge this PR itself once its own gates are green. hkb never merges: this hands the
 * last step to GitHub's auto-merge and walks away — there is no timer, no retry and nothing to
 * reconcile, because a PR whose checks fail simply never merges. The PR's node id is the one the
 * board query already returned. Enabling twice is not an error, but the caller does not need to:
 * `autoMergeEnabled` on the next board read says it is already on.
 */
export async function enableAutoMerge(ctx, pr, mergeMethod) {
  const q = `mutation($id: ID!, $method: PullRequestMergeMethod!) {
    enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $method}) {
      pullRequest { number autoMergeRequest { enabledAt mergeMethod } }
    }
  }`;
  const data = await graphql(q, { id: pr.nodeId, method: mergeMethod });
  const out = data?.enablePullRequestAutoMerge?.pullRequest || null;
  if (out) pr.autoMergeEnabled = true;
  return out;
}

/**
 * The PR's own check state — `SUCCESS`, `FAILURE`, `PENDING`, `ERROR`, `EXPECTED`, or `null` when
 * the PR has no checks configured at all. This is what `dispatch.merge.require.checks` asks
 * `hkb merge` to read before it will merge a card's PR under `mode: "operator"`: not the branch's
 * required checks (that is `branchProtection`/`mergeGate`, for `"auto"`), but this PR's own commit.
 */
export async function prChecksState(ctx, number) {
  const q = `query($owner: String!, $repo: String!, $n: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $n) { commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
    }
  }`;
  const data = await graphql(q, { owner: ctx.repo.owner, repo: ctx.repo.repo, n: Number(number) });
  return data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null;
}

/**
 * `hkb merge`'s one mutation: land the PR itself. Deliberately `gh api`'s `mergePullRequest`, not
 * the `gh pr merge` subcommand — every GitHub-ism behind a `gh api` call, never a `gh pr`/`gh
 * issue` subcommand, is a house rule (CLAUDE.md), and it is also what keeps the mutation testable
 * against the fake-gh double instead of a real `gh` binary.
 */
export async function mergePullRequest(ctx, pr, mergeMethod) {
  const q = `mutation($id: ID!, $method: PullRequestMergeMethod!) {
    mergePullRequest(input: {pullRequestId: $id, mergeMethod: $method}) { pullRequest { number merged } }
  }`;
  const data = await graphql(q, { id: pr.nodeId, method: mergeMethod });
  return data?.mergePullRequest?.pullRequest || null;
}

/** One ruleset rule's contribution to the gate; unknown types add nothing. */
function fromRule(rule, out) {
  const p = rule?.parameters || {};
  if (rule?.type === 'required_status_checks') for (const c of p.required_status_checks || []) { if (c?.context) out.requiredChecks.push(c.context); }
  if (rule?.type === 'pull_request') out.requiredReviews = Math.max(out.requiredReviews, Number(p.required_approving_review_count ?? 0) || 0);
}

/**
 * What has to go green before a PR can land on `branch` — the input to `mergeGate()`.
 * Two mechanisms answer that question and a repo may use either, so both are asked, cheapest
 * first: classic branch protection (`/branches/<b>/protection`, admin-only, 404 when there is
 * none) and rulesets (`/rules/branches/<b>`, readable by anyone, and the only one that survives a
 * token without admin). `known: false` means neither could be read — never "unprotected".
 */
export async function branchProtection(ctx, branch) {
  const out = { branch, known: false, protected: false, requiredChecks: [], requiredReviews: 0, why: null };
  try {
    const p = await rest('GET', api(ctx, `/branches/${encodeURIComponent(branch)}/protection`));
    const rsc = p?.required_status_checks;
    out.known = true;
    out.protected = true;
    out.requiredChecks = rsc ? (rsc.checks?.map((c) => c.context).filter(Boolean) ?? rsc.contexts ?? []) : [];
    out.requiredReviews = Number(p?.required_pull_request_reviews?.required_approving_review_count ?? 0) || 0;
    return out;
  } catch (e) {
    if (!(e instanceof GhError) || !['notfound', 'auth'].includes(e.kind)) throw e;
    // 404: no *classic* protection — a ruleset may still cover the branch. 403: this token cannot
    // read classic protection at all, so a silent ruleset is the only evidence left.
    out.protected = e.kind === 'notfound' ? false : out.protected;
    out.known = e.kind === 'notfound';
    if (e.kind === 'auth') out.why = 'the token cannot read branch protection — it needs repo admin';
  }
  try {
    const rules = await rest('GET', api(ctx, `/rules/branches/${encodeURIComponent(branch)}`));
    for (const r of rules || []) fromRule(r, out);
    if (out.requiredChecks.length || out.requiredReviews || (rules || []).length) { out.known = true; out.protected = true; out.why = null; }
  } catch (e) {
    if (!(e instanceof GhError) || !['notfound', 'auth'].includes(e.kind)) throw e;
    if (!out.known) out.why = out.why || `the rules for ${branch} could not be read (${e.kind})`;
  }
  return out;
}
