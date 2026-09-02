// Projects v2 mirror — opt-in, strictly one-way.
//
// Labels stay canonical; the linked Project is a read surface. Every write here mirrors a
// `kb:status:*` label that already exists on the issue, so a drag in the Project UI changes
// nothing on the board and is repaired from the labels on the next tick.
//
// Cost when it is on: one GraphQL read of the project's items per tick, plus one mutation per
// status transition (two the first time an issue is added to the project). Off by default.
import { graphql, ghAuthStatus } from './gh.js';
import { L, STATUSES, statusOf } from './model.js';

export const STATUS_FIELD_NAME = 'Status';
export const SCOPE_FIX = 'gh auth refresh -s project';

const MAX_ADDS_PER_TICK = 25; // a fresh link must not spend a whole tick's rate limit adding items
const MAX_ITEM_PAGES = 10; // 1000 items; a board that big has other problems

// Projects v2 single-select option colours (ProjectV2SingleSelectFieldOptionColor).
const OPTION_COLORS = {
  triage: 'PINK', todo: 'GRAY', ready: 'GREEN', running: 'YELLOW',
  blocked: 'RED', review: 'PURPLE', done: 'BLUE', archived: 'GRAY',
};

// Names a Project may already use for a kb status, so an existing board keeps its columns
// instead of collecting a second set next to them. Order is preference order.
const OPTION_ALIASES = {
  todo: ['to do', 'backlog'],
  running: ['in progress'],
  review: ['in review'],
  done: ['completed'],
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const usage = (msg) => { const e = new Error(msg); e.exitCode = 2; return e; };

/** The option name hkb creates for a status: `running` → `Running`. */
export const optionName = (status) => String(status).charAt(0).toUpperCase() + String(status).slice(1);

/** The option this status maps to, by exact name then by alias. Pure. */
export function matchOption(status, options) {
  const wanted = [status, ...(OPTION_ALIASES[status] || [])].map(norm);
  for (const w of wanted) {
    const hit = (options || []).find((o) => norm(o?.name) === w);
    if (hit) return hit;
  }
  return null;
}

/** `{ status: optionId }` for every kb status the field can express. Pure. */
export function optionMap(options) {
  const map = {};
  for (const s of STATUSES) {
    const o = matchOption(s, options);
    if (o?.id) map[s] = o.id;
  }
  return map;
}

/** kb statuses the Status field has no option for. Pure. */
export function missingStatuses(options) {
  return STATUSES.filter((s) => !matchOption(s, options));
}

/** The option list to send to GitHub: everything the field already has, then the missing kb statuses. Pure.
 *  Append-only — hkb never drops an option a human made, so no item loses its value. */
export function optionInputs(existing, missing) {
  const kept = (existing || []).map((o) => ({
    name: String(o.name),
    color: o.color || OPTION_COLORS[norm(o.name)] || 'GRAY',
    description: o.description || '',
  }));
  const added = (missing || []).map((s) => ({ name: optionName(s), color: OPTION_COLORS[s] || 'GRAY', description: `hkb ${L.status(s)}` }));
  return [...kept, ...added];
}

/** `--project <number|new|url>` → `{ kind, number, owner }`. Pure; throws usage errors. */
export function parseProjectSpec(spec) {
  const s = String(spec ?? '').trim();
  if (!s || s === 'true') throw usage('--project takes a project number or "new": `hkb init --project 3` or `hkb init --project new`');
  if (/^new$/i.test(s)) return { kind: 'new', number: null, owner: null };
  const url = /\/(?:users|orgs|organizations)\/([^/]+)\/projects\/(\d+)/.exec(s);
  if (url) return { kind: 'number', number: Number(url[2]), owner: url[1] };
  const n = Number(s.replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) throw usage(`--project: "${s}" is not a project number, a project URL, or "new"`);
  return { kind: 'number', number: n, owner: null };
}

/** True when board.json carries a usable mirror config. Pure. */
export function isMirrorConfigured(cfg) {
  const p = cfg?.project;
  return !!(p && p.id && p.status_field_id && p.options && Object.keys(p.options).length);
}

// ---------- error shapes ----------

/**
 * Turn any Projects failure into `{ kind, message, fix }`. Pure — the mirror never throws at the
 * dispatcher, so this is what the tick, `hkb doctor` and `hkb init` all print.
 */
export function projectError(err) {
  const msg = String(err?.message || err || 'unknown error');
  if (/required scopes|read:project|write:project|not accessible by (personal access token|integration)/i.test(msg)) {
    return { kind: 'scope', message: 'the gh token cannot write Projects v2 (missing the "project" scope)', fix: SCOPE_FIX };
  }
  if (err?.kind === 'notfound' || /could not resolve to a (projectv2|node|projectv2item)/i.test(msg) || /^project not found/i.test(msg)) {
    return { kind: 'missing', message: 'the linked Project no longer exists (deleted, or moved to another owner)', fix: 'remove "project" from .kanban/board.json, or re-link with `hkb init --project <number|new>`' };
  }
  return { kind: 'error', message: msg, fix: null };
}

/** Token scopes as `gh auth status` reports them, or null when it does not report any. Pure. */
export function parseTokenScopes(text) {
  const m = /token scopes:\s*(.*)/i.exec(text || '');
  if (!m) return null; // fine-grained PAT, GITHUB_TOKEN, or a gh too old to say
  const scopes = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  return scopes;
}

/** true / false / null ("gh did not say"). Moving a card needs write, so `project`, not `read:project`. Pure. */
export function hasProjectScope(scopes) {
  if (scopes === null || scopes === undefined) return null;
  return scopes.includes('project');
}

// ---------- the plan (pure) ----------

/**
 * What the mirror must write this tick. Pure, so the whole decision is unit-tested.
 *
 * @param items  `[{ id, number, optionId, optionName, labels }]` — the project's items, issues only
 * @param tasks  `[{ number, nodeId, status }]` — the open board, labels already canonical
 * @param options `{ status: optionId }` from board.json
 * @param {object} [opts]
 * @param [opts.extra] `{ number: status }` — statuses this tick set on issues that left the open board
 * @param [opts.boardLabel]
 * @param {number} [opts.maxAdds] how many adds this tick may make only items carrying this label are touched; anything else in the Project is left alone
 */
export function planSync(items, tasks, options = {}, { extra = {}, boardLabel = null, maxAdds = MAX_ADDS_PER_TICK } = {}) {
  const desired = new Map();
  for (const [n, s] of Object.entries(extra || {})) if (s) desired.set(Number(n), s);
  for (const t of tasks || []) if (t?.number && t.status) desired.set(t.number, t.status);

  const inProject = new Set();
  const updates = [];
  const unmapped = [];
  for (const it of items || []) {
    if (!it || typeof it.number !== 'number') continue; // draft items and PRs are not ours
    const onBoard = !boardLabel || (it.labels || []).includes(boardLabel);
    const want = desired.get(it.number) ?? (onBoard ? statusOf(it.labels) : null);
    inProject.add(it.number);
    if (!want) continue; // not an hkb task: the Project may hold whatever else it likes
    const optionId = options[want];
    if (!optionId) { unmapped.push({ number: it.number, status: want }); continue; }
    if (it.optionId === optionId) continue; // already right — no write
    updates.push({ item: it.id, number: it.number, from: it.optionName || null, to: want, optionId });
  }

  const absent = (tasks || []).filter((t) => t?.nodeId && t.status && !inProject.has(t.number));
  const adds = absent.slice(0, maxAdds).map((t) => ({ number: t.number, content: t.nodeId, to: t.status, optionId: options[t.status] || null }));
  for (const a of adds) if (!a.optionId) unmapped.push({ number: a.number, status: a.to });
  return { updates, adds, deferred: absent.length - adds.length, unmapped };
}

// ---------- GraphQL ----------

const FIELD_FRAGMENT = `... on ProjectV2SingleSelectField { id name options { id name color description } }`;
const PROJECT_FIELDS = `id number title url`;

async function repoAndOwner(ctx) {
  const data = await graphql(
    'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id owner { __typename id login } } }',
    { owner: ctx.repo.owner, name: ctx.repo.repo },
  );
  const repo = data?.repository;
  if (!repo) throw new Error(`repository ${ctx.repo.nameWithOwner} not found`);
  return { repoId: repo.id, ownerId: repo.owner.id, ownerLogin: repo.owner.login, ownerType: repo.owner.__typename };
}

/** A Projects v2 board is owned by a user or an organization, never by the repository. */
async function findProject(ownerLogin, number) {
  const project = `projectV2(number: $number) { ${PROJECT_FIELDS} field(name: $field) { ${FIELD_FRAGMENT} } }`;
  const q = `query($owner: String!, $number: Int!, $field: String!) {
    repositoryOwner(login: $owner) {
      ... on User { ${project} }
      ... on Organization { ${project} }
    }
  }`;
  const data = await graphql(q, { owner: ownerLogin, number, field: STATUS_FIELD_NAME });
  return toProject(data?.repositoryOwner?.projectV2);
}

/** Shared shape for a project read. `field` is null unless it is the single-select we can drive. */
function toProject(p) {
  if (!p?.id) return null;
  return { id: p.id, number: p.number, title: p.title, url: p.url, field: p.field?.id ? p.field : null, fieldExists: p.field !== null && p.field !== undefined };
}

async function createProject(owner, title) {
  const q = `mutation($owner: ID!, $title: String!, $repo: ID!, $field: String!) {
    createProjectV2(input: {ownerId: $owner, title: $title, repositoryId: $repo}) {
      projectV2 { ${PROJECT_FIELDS} field(name: $field) { ${FIELD_FRAGMENT} } }
    }
  }`;
  const data = await graphql(q, { owner: owner.ownerId, title, repo: owner.repoId, field: STATUS_FIELD_NAME });
  const p = toProject(data?.createProjectV2?.projectV2);
  if (!p) throw new Error('createProjectV2 returned no project');
  return p;
}

async function createStatusField(projectId) {
  const q = `mutation($project: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
    createProjectV2Field(input: {projectId: $project, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: $options}) {
      projectV2Field { ${FIELD_FRAGMENT} }
    }
  }`;
  const data = await graphql(q, { project: projectId, name: STATUS_FIELD_NAME, options: optionInputs([], STATUSES) });
  const f = data?.createProjectV2Field?.projectV2Field;
  if (!f?.id) throw new Error(`could not create the "${STATUS_FIELD_NAME}" single-select field`);
  return f;
}

async function addStatusOptions(field, missing) {
  const q = `mutation($field: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
    updateProjectV2Field(input: {fieldId: $field, singleSelectOptions: $options}) {
      projectV2Field { ${FIELD_FRAGMENT} }
    }
  }`;
  const data = await graphql(q, { field: field.id, options: optionInputs(field.options, missing) });
  const f = data?.updateProjectV2Field?.projectV2Field;
  if (!f?.id) throw new Error(`could not add Status options (${missing.join(', ')})`);
  return f;
}

/** The project's items, issues only. `null` when the project is gone. */
export async function fetchItems(project) {
  const q = `query($id: ID!, $field: String!, $cursor: String) {
    node(id: $id) {
      ... on ProjectV2 {
        items(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            fieldValueByName(name: $field) { ... on ProjectV2ItemFieldSingleSelectValue { optionId name } }
            content { __typename ... on Issue { number labels(first: 40) { nodes { name } } } }
          }
        }
      }
    }
  }`;
  const out = [];
  let cursor = null;
  for (let page = 0; page < MAX_ITEM_PAGES; page++) {
    const data = await graphql(q, { id: project.id, field: project.status_field_name || STATUS_FIELD_NAME, cursor });
    const node = data?.node;
    if (!node) return null; // deleted project, or one this token cannot see
    for (const n of node.items?.nodes || []) {
      if (n?.content?.__typename !== 'Issue') continue;
      out.push({
        id: n.id,
        number: n.content.number,
        optionId: n.fieldValueByName?.optionId || null,
        optionName: n.fieldValueByName?.name || null,
        labels: (n.content.labels?.nodes || []).map((l) => l.name),
      });
    }
    if (!node.items?.pageInfo?.hasNextPage) break;
    cursor = node.items.pageInfo.endCursor;
  }
  return out;
}

async function addItem(project, contentId) {
  // Idempotent: an issue already in the project comes back with its existing item id.
  const data = await graphql(
    'mutation($project: ID!, $content: ID!) { addProjectV2ItemById(input: {projectId: $project, contentId: $content}) { item { id } } }',
    { project: project.id, content: contentId },
  );
  const id = data?.addProjectV2ItemById?.item?.id;
  if (!id) throw new Error('addProjectV2ItemById returned no item');
  return id;
}

async function setItemStatus(project, itemId, optionId) {
  await graphql(
    `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: {projectId: $project, itemId: $item, fieldId: $field, value: {singleSelectOptionId: $option}}) {
        projectV2Item { id }
      }
    }`,
    { project: project.id, item: itemId, field: project.status_field_id, option: optionId },
  );
}

/** One cheap read for `hkb doctor`: the project and its Status options, or null when it is gone. */
export async function probeProject(project) {
  const q = `query($id: ID!, $field: String!) {
    node(id: $id) { ... on ProjectV2 { ${PROJECT_FIELDS} field(name: $field) { ${FIELD_FRAGMENT} } } }
  }`;
  const data = await graphql(q, { id: project.id, field: project.status_field_name || STATUS_FIELD_NAME });
  const p = data?.node;
  if (!p?.id) return null;
  const options = p.field?.options || [];
  return { number: p.number, title: p.title, url: p.url, field: p.field?.id || null, options, missing: p.field ? missingStatuses(options) : STATUSES.slice() };
}

// ---------- `hkb init --project <number|new>` ----------

/**
 * Link (or create) a Projects v2 board and return the block board.json stores.
 * Idempotent: re-running finds the same project and writes nothing when the options already fit.
 */
export async function linkProject(ctx, spec, log = /** @type {(...a: any[]) => void} */ (() => {})) {
  const want = parseProjectSpec(spec);
  const scopes = parseTokenScopes(ghAuthStatus().text);
  if (hasProjectScope(scopes) === false) {
    throw usage(`Projects v2 needs the "project" scope; this token has ${scopes.join(', ') || 'none'} — run \`${SCOPE_FIX}\`, then this command again`);
  }
  try {
    const owner = await repoAndOwner(ctx);
    const ownerLogin = want.owner || owner.ownerLogin;
    const project = want.kind === 'new'
      ? await createProject(owner, `${ctx.repo.repo} · hkb ${ctx.board}`)
      : await findProject(ownerLogin, want.number);
    if (!project) {
      throw usage(`${ownerLogin} has no Projects v2 board #${want.number}. Create one at https://github.com/${owner.ownerType === 'Organization' ? 'orgs/' + ownerLogin : 'users/' + ownerLogin}/projects, or run \`hkb init --project new\`.`);
    }
    if (want.kind === 'new') log(`created project #${project.number} "${project.title}" ${project.url}`);

    let field = project.field;
    if (!field) {
      if (project.fieldExists) throw usage(`project #${project.number} "${project.title}" has a "${STATUS_FIELD_NAME}" field that is not a single-select — rename it in the Project, or link another project`);
      field = await createStatusField(project.id);
      log(`created the "${STATUS_FIELD_NAME}" single-select field with ${STATUSES.length} kb statuses`);
    } else {
      const missing = missingStatuses(field.options);
      if (missing.length) {
        field = await addStatusOptions(field, missing);
        log(`added Status options: ${missing.map(optionName).join(', ')} (existing options kept)`);
      }
    }
    const options = optionMap(field.options);
    const unmapped = STATUSES.filter((s) => !options[s]);
    if (unmapped.length) log(`! no Status option for ${unmapped.join(', ')} — tasks in those statuses will not move in the Project`);

    log(`project mirror: #${project.number} "${project.title}" ${project.url}`);
    log('  one-way: labels stay canonical, drags in the Project UI are repaired on the next tick');
    log('  cost: one GraphQL read per tick + one write per status transition (two on an issue\'s first touch)');
    return {
      number: project.number,
      id: project.id,
      title: project.title,
      url: project.url,
      owner: ownerLogin,
      status_field_id: field.id,
      status_field_name: field.name || STATUS_FIELD_NAME,
      options,
    };
  } catch (e) {
    if (e?.exitCode === 2) throw e;
    const x = projectError(e);
    const err = new Error(`project mirror: ${x.message}${x.fix ? ` → ${x.fix}` : ''}`);
    err.exitCode = 2;
    throw err;
  }
}

// ---------- the dispatcher's sync ----------

/** Log a message at most once an hour per key, so a broken mirror does not spam a 60-second loop. */
function throttled(state, key, log, message, everyMs = 3600_000) {
  state.project = state.project || {};
  const at = state.project[key];
  if (at && Date.now() - new Date(at).getTime() < everyMs) return false;
  state.project[key] = new Date().toISOString();
  log(message);
  return true;
}

/**
 * Mirror the board's labels onto the linked Project. Called at the end of the tick, after every
 * transition it made (`setStatus` mutates the task objects in place, so `tasks` is current).
 * Never throws: a Project that was deleted, or a token that lost the scope, costs the mirror and
 * nothing else. Returns a `--json`-stable summary.
 */
export async function syncProject(ctx, tasks, { dryRun = false, extra = {}, state = {}, log = /** @type {(...a: any[]) => void} */ (() => {}) } = {}) {
  const p = ctx.cfg?.project;
  if (!isMirrorConfigured(ctx.cfg)) return { skipped: 'not configured' };
  let items;
  try {
    items = await fetchItems(p);
  } catch (e) {
    const x = projectError(e);
    throttled(state, 'read_error', log, `project mirror: ${x.message}${x.fix ? ` → ${x.fix}` : ''}`);
    return { skipped: x.kind, error: x.message, fix: x.fix };
  }
  if (items === null) {
    const x = projectError({ message: 'project not found' });
    throttled(state, 'missing', log, `project mirror: ${x.message} → ${x.fix}`);
    return { skipped: 'missing', error: x.message, fix: x.fix };
  }
  const plan = planSync(items, tasks, p.options, { extra, boardLabel: L.board(ctx.board) });
  const summary = { project: p.number, items: items.length, updated: [], added: [], deferred: plan.deferred, unmapped: plan.unmapped, errors: [] };
  if (plan.unmapped.length) {
    const statuses = [...new Set(plan.unmapped.map((u) => u.status))];
    throttled(state, 'unmapped', log, `project mirror: no Status option for ${statuses.join(', ')} — run \`hkb init --project ${p.number}\` to add them`);
  }
  if (dryRun) {
    for (const u of plan.updates) log(`#${u.number}: [dry-run] project ${u.from || '(none)'} → ${optionName(u.to)}`);
    for (const a of plan.adds) log(`#${a.number}: [dry-run] add to project #${p.number} → ${optionName(a.to)}`);
    summary.updated = plan.updates.map((u) => ({ number: u.number, from: u.from, to: u.to, dry: true }));
    summary.added = plan.adds.map((a) => ({ number: a.number, to: a.to, dry: true }));
    return summary;
  }

  for (const u of plan.updates) {
    try {
      await setItemStatus(p, u.item, u.optionId);
      summary.updated.push({ number: u.number, from: u.from, to: u.to });
      log(`#${u.number}: project ${u.from || '(none)'} → ${optionName(u.to)}`);
    } catch (e) {
      const x = projectError(e);
      summary.errors.push({ number: u.number, error: x.message, fix: x.fix });
      throttled(state, `write_${x.kind}`, log, `project mirror: ${x.message}${x.fix ? ` → ${x.fix}` : ''}`);
      if (x.kind !== 'error') return summary; // scope or deleted project: the rest would fail the same way
    }
  }
  for (const a of plan.adds) {
    if (!a.optionId) continue; // no option for that status; adding the item would tell the user nothing
    try {
      const item = await addItem(p, a.content);
      await setItemStatus(p, item, a.optionId);
      summary.added.push({ number: a.number, to: a.to });
      log(`#${a.number}: added to project #${p.number} → ${optionName(a.to)}`);
    } catch (e) {
      const x = projectError(e);
      summary.errors.push({ number: a.number, error: x.message, fix: x.fix });
      throttled(state, `write_${x.kind}`, log, `project mirror: ${x.message}${x.fix ? ` → ${x.fix}` : ''}`);
      if (x.kind !== 'error') return summary;
    }
  }
  if (plan.deferred > 0) log(`project mirror: ${plan.deferred} more issue(s) to add, next tick (cap ${MAX_ADDS_PER_TICK}/tick)`);
  return summary;
}

// ---------- `hkb doctor` ----------

/**
 * Scope + liveness of the mirror. Silent when no project is linked — the feature is off by default.
 * Never throws; a missing project is a finding, not a crash.
 */
export async function checkProject(ctx, { ok, bad, warn }) {
  const p = ctx.cfg?.project;
  if (!p) return;
  if (!isMirrorConfigured(ctx.cfg)) {
    bad('project mirror', 'board.json has "project" but no id / status field / options', 'hkb init --project <number|new>');
    return;
  }
  const scopes = parseTokenScopes(ghAuthStatus().text);
  const has = hasProjectScope(scopes);
  if (has === false) {
    // Every project query would fail the same way; one finding with the fix is the whole story.
    bad('project mirror', `#${p.number} needs the "project" scope; this token has ${scopes.join(', ') || 'none'}`, SCOPE_FIX);
    return;
  }
  if (has === null) warn('project scope', 'gh did not report token scopes (fine-grained PAT?) — Projects writes may still fail', SCOPE_FIX);
  else ok('project scope', 'project (Projects v2 writes allowed)');

  try {
    const probe = await probeProject(p);
    if (!probe) {
      const x = projectError({ message: 'project not found' });
      bad('project mirror', `#${p.number} is gone — the dispatcher skips the mirror, the board keeps working`, x.fix);
      return;
    }
    if (!probe.field) bad('project mirror', `#${probe.number} "${probe.title}" has no "${p.status_field_name || STATUS_FIELD_NAME}" single-select field`, `hkb init --project ${probe.number}`);
    else if (probe.missing.length) warn('project mirror', `#${probe.number} "${probe.title}" — Status has no option for ${probe.missing.join(', ')}`, `hkb init --project ${probe.number}`);
    else ok('project mirror', `#${probe.number} "${probe.title}" · one-way from labels · ${probe.url}`);
  } catch (e) {
    const x = projectError(e);
    bad('project mirror', x.message, x.fix);
  }
}
