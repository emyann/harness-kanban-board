// Issue <-> task mapping: reading the board, labels, comments, dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { rest, graphql, GhError } from './gh.js';
import { api, kanbanDir } from './board.js';
import {
  L, LABEL_COLORS, STATUSES, parseBodyBlock, serializeBodyBlock, statusOf, agentOf, boardOf,
  parseRunComment, serializeRunComment, parseResultComment, RESULT_MARKER, emptyRun, pickRunComment,
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
  ${caps.closedByPrs ? 'closedByPullRequestsReferences(first: 5, includeClosedPrs: true) { nodes { number state isDraft url headRefName merged } }' : ''}
`;

function toTask(node) {
  const labels = (node.labels?.nodes || []).map((l) => l.name);
  const { kb, rest: bodyText } = parseBodyBlock(node.body);
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
    prs: (node.closedByPullRequestsReferences?.nodes || []).map((p) => ({ number: p.number, state: p.state, isDraft: p.isDraft, url: p.url, headRefName: p.headRefName, merged: p.merged })),
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

export async function fetchBoard(ctx, { includeClosed = false } = {}) {
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
  if (!ctx.caps.blockedByGql) for (const t of tasks) if (t.status === 'todo' || t.status === 'blocked') await fillBlockedByRest(ctx, t);
  return tasks;
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
  const data = await graphql(q, { owner: ctx.repo.owner, repo: ctx.repo.repo, n: Number(number) });
  const node = data.repository.issue;
  if (!node) { const e = new Error(`issue #${number} not found in ${ctx.repo.nameWithOwner}`); e.exitCode = 2; throw e; }
  const task = toTask(node);
  if (!ctx.caps.blockedByGql) await fillBlockedByRest(ctx, task);
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
