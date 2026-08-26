// An in-memory GitHub, installed as the `src/gh.js` transport so a test never spawns `gh`.
// It models exactly what the protocol needs: issues (labels, comments, dependencies, closing
// PRs), git refs with create-if-absent semantics, and a GraphQL resolver for the queries
// `src/tasks.js` sends. Anything hkb asks for that is not modelled fails loudly with 501 —
// a silent 404 would be swallowed by the callers that treat "not found" as "already gone".
//
//   const gh = new FakeGh();
//   gh.addIssue(kbIssue({ number: 7, status: 'ready', agent: 'claude' }));
//   const restore = gh.install();
//
// Doubles as the conformance suite for a future non-GitHub backend.
import { GhError, classify, setTransport } from '../src/gh.js';
import { DEFAULT_KB, L, emptyRun, parseRunComment, pickRunComment, serializeBodyBlock, serializeRunComment, statusOf } from '../src/model.js';

export class FakeGh {
  constructor({ owner = 'acme', repo = 'board', defaultBranch = 'main', baseSha = 'f'.repeat(40), caps = {} } = {}) {
    this.owner = owner;
    this.repo = repo;
    this.nameWithOwner = `${owner}/${repo}`;
    this.defaultBranch = defaultBranch;
    this.caps = { blockedByGql: true, closedByPrs: true, ...caps };
    this.issues = new Map(); // number -> issue record
    this.refs = new Map(); // full ref name -> sha
    this.repoLabels = new Set();
    this.calls = []; // every request, in order
    this.failures = []; // injected errors, see fail()
    this.nextCommentId = 1000;
    this.commits = new Map(); // sha -> {date} — what a ref-CAS heartbeat leaves behind
    this.refs.set(`refs/heads/${defaultBranch}`, baseSha);
    this.transport = this.transport.bind(this);
  }

  /** Install as the gh transport. Returns the restore function from setTransport. */
  install() { return setTransport(this.transport); }

  // ---------- seeding ----------

  addIssue(spec = {}) {
    const number = spec.number ?? (Math.max(0, ...this.issues.keys()) + 1);
    const issue = {
      number,
      id: spec.id || `I_kwFake${number}`,
      databaseId: spec.databaseId ?? 5_000_000 + number,
      title: spec.title || `issue ${number}`,
      body: spec.body || '',
      state: String(spec.state || 'OPEN').toUpperCase(),
      stateReason: spec.stateReason ? String(spec.stateReason).toUpperCase() : null,
      labels: [...(spec.labels || [])],
      comments: [],
      blockedBy: [...(spec.blockedBy || [])], // issue numbers, or literal {number,state,...}
      prs: [...(spec.prs || [])],
      events: [...(spec.events || [])],
      createdAt: spec.createdAt || `2026-08-26T00:00:${String(number % 60).padStart(2, '0')}Z`,
      updatedAt: spec.updatedAt || spec.createdAt || '2026-08-26T01:00:00Z',
      url: `https://github.com/${this.nameWithOwner}/issues/${number}`,
    };
    for (const l of issue.labels) this.repoLabels.add(l);
    this.issues.set(number, issue);
    for (const body of spec.comments || []) this.addComment(number, body);
    return issue;
  }

  addComment(number, body) {
    const issue = this.#issue(number);
    const c = {
      id: this.nextCommentId++,
      body,
      user: { login: 'hkb' },
      created_at: '2026-08-26T01:00:00Z',
      updated_at: '2026-08-26T01:00:00Z',
      html_url: `${issue.url}#issuecomment-${this.nextCommentId}`,
    };
    issue.comments.push(c);
    return c;
  }

  /**
   * A worker's CAS heartbeat: point the lock ref at a commit dated `at`. The dispatcher reads that
   * date back through `GET git/commits/<sha>`; a ref whose commit was never added has no date,
   * which is exactly how a lock created by `POST git/refs` at the branch head behaves.
   */
  beat(n, k, at, sha = null) {
    const commit = sha || `beat${n}${k}${new Date(at).getTime().toString(16)}`.padEnd(40, '0').slice(0, 40);
    this.refs.set(`refs/kb/locks/${n}/${k}`, commit);
    this.commits.set(commit, { date: new Date(at).toISOString() });
    return commit;
  }

  /**
   * Make matching calls fail. `where` is `{ method, path }`; `path` may be a substring
   * or a RegExp, `method` may be omitted to match any. Consumed `times` times (default 1).
   */
  fail(where, { status = 500, kind, message = 'injected failure', times = 1 } = {}) {
    this.failures.push({ where, status, kind, message, times });
    return this;
  }

  // ---------- assertions ----------

  labelsOf(number) { return [...this.#issue(number).labels]; }
  statusOf(number) { return statusOf(this.#issue(number).labels); }
  /** The run record hkb would read back from the issue, or null. */
  runOf(number) {
    const picked = pickRunComment(this.#issue(number).comments);
    return picked.chosen ? parseRunComment(picked.chosen.body) : null;
  }
  lockRefs() { return [...this.refs.keys()].filter((r) => r.startsWith('refs/kb/locks/')).sort(); }
  /** Every request whose method and path match — for "and nothing was written" assertions. */
  callsMatching(method, path) {
    return this.calls.filter((c) => (!method || c.method === method) && (!path || (path instanceof RegExp ? path.test(c.path || '') : String(c.path || '').includes(path))));
  }

  // ---------- transport ----------

  transport(req) {
    this.calls.push({ kind: req.kind, method: req.method || null, path: req.path || null, body: req.body ?? null, query: req.query || null, variables: req.variables || null });
    const injected = this.#takeFailure(req);
    if (injected) throw injected;
    return req.kind === 'graphql' ? this.#graphql(req) : this.#rest(req);
  }

  #takeFailure(req) {
    for (const f of this.failures) {
      if (f.times <= 0) continue;
      const w = f.where || {};
      if (w.kind && w.kind !== req.kind) continue;
      if (w.method && w.method !== req.method) continue;
      if (w.path) {
        const p = req.path || '';
        if (w.path instanceof RegExp ? !w.path.test(p) : !p.includes(w.path)) continue;
      }
      f.times--;
      const label = req.kind === 'graphql' ? 'GraphQL' : `${req.method} ${req.path}`;
      return this.#error(f.status, `${label} failed (${f.status}): ${f.message}`, { kind: f.kind, path: req.path });
    }
    return null;
  }

  #error(status, message, { kind, path = '' } = {}) {
    return new GhError(message, { status, kind: kind || classify(status, message), body: message, path });
  }

  #issue(number) {
    const issue = this.issues.get(Number(number));
    if (!issue) throw this.#error(404, `Not Found: issue #${number}`);
    return issue;
  }

  #touch(issue) { issue.updatedAt = new Date().toISOString(); }

  // ---------- REST ----------

  #rest({ method, path, body }) {
    const base = `repos/${this.owner}/${this.repo}`;
    if (path !== base && !path.startsWith(`${base}/`)) throw this.#error(501, `fake-gh: no route for ${method} ${path}`);
    const [p, qs] = path.slice(base.length).replace(/^\//, '').split('?');
    const q = new URLSearchParams(qs || '');
    let m;

    if (p === '') {
      if (method === 'GET') return { name: this.repo, full_name: this.nameWithOwner, default_branch: this.defaultBranch };
    } else if (p === 'labels') {
      if (method === 'GET') return this.#page([...this.repoLabels].map((name) => ({ name })), q);
      if (method === 'POST') {
        if (this.repoLabels.has(body.name)) throw this.#error(422, `POST ${path} failed (422): Validation Failed: already_exists`);
        this.repoLabels.add(body.name);
        return { name: body.name, color: body.color };
      }
    } else if (p === 'issues') {
      if (method === 'POST') return this.#issueRest(this.addIssue({ title: body.title, body: body.body, labels: body.labels }));
    } else if ((m = /^issues\/(\d+)$/.exec(p))) {
      const issue = this.#issue(m[1]);
      if (method === 'GET') return this.#issueRest(issue);
      if (method === 'PATCH') {
        if (body.state) issue.state = String(body.state).toUpperCase();
        if ('state_reason' in body) issue.stateReason = body.state_reason ? String(body.state_reason).toUpperCase() : null;
        if ('body' in body) issue.body = body.body;
        if ('title' in body) issue.title = body.title;
        this.#touch(issue);
        return this.#issueRest(issue);
      }
    } else if ((m = /^issues\/(\d+)\/labels$/.exec(p))) {
      const issue = this.#issue(m[1]);
      if (method === 'POST') {
        for (const l of body.labels || []) { if (!issue.labels.includes(l)) issue.labels.push(l); this.repoLabels.add(l); }
        this.#touch(issue);
        return issue.labels.map((name) => ({ name }));
      }
    } else if ((m = /^issues\/(\d+)\/labels\/(.+)$/.exec(p))) {
      const issue = this.#issue(m[1]);
      const name = decodeURIComponent(m[2]);
      if (method === 'DELETE') {
        if (!issue.labels.includes(name)) throw this.#error(404, `DELETE ${path} failed (404): Label does not exist`);
        issue.labels = issue.labels.filter((l) => l !== name);
        this.#touch(issue);
        return issue.labels.map((n) => ({ name: n }));
      }
    } else if ((m = /^issues\/(\d+)\/comments$/.exec(p))) {
      const issue = this.#issue(m[1]);
      if (method === 'GET') return this.#page(issue.comments, q);
      if (method === 'POST') { this.#touch(issue); return this.addComment(issue.number, body.body); }
    } else if ((m = /^issues\/comments\/(\d+)$/.exec(p))) {
      const id = Number(m[1]);
      const issue = [...this.issues.values()].find((i) => i.comments.some((c) => c.id === id));
      if (!issue) throw this.#error(404, `${method} ${path} failed (404): Not Found`);
      const comment = issue.comments.find((c) => c.id === id);
      if (method === 'GET') return comment;
      if (method === 'PATCH') { comment.body = body.body; this.#touch(issue); return comment; }
      if (method === 'DELETE') { issue.comments = issue.comments.filter((c) => c.id !== id); this.#touch(issue); return null; }
    } else if ((m = /^issues\/(\d+)\/dependencies\/blocked_by$/.exec(p))) {
      const issue = this.#issue(m[1]);
      if (method === 'GET') return this.#blockers(issue).map((b) => ({ number: b.number, title: b.title, state: b.state.toLowerCase(), state_reason: b.stateReason ? b.stateReason.toLowerCase() : null }));
      if (method === 'POST') {
        const parent = [...this.issues.values()].find((i) => i.databaseId === body.issue_id);
        if (!parent) throw this.#error(404, `POST ${path} failed (404): Not Found`);
        if (issue.blockedBy.includes(parent.number)) throw this.#error(422, `POST ${path} failed (422): Validation Failed: dependency already exists`);
        issue.blockedBy.push(parent.number);
        this.#touch(issue);
        return { number: parent.number };
      }
    } else if ((m = /^issues\/(\d+)\/dependencies\/blocked_by\/(\d+)$/.exec(p))) {
      const issue = this.#issue(m[1]);
      const parent = [...this.issues.values()].find((i) => i.databaseId === Number(m[2]));
      if (method === 'DELETE') {
        if (!parent || !issue.blockedBy.includes(parent.number)) throw this.#error(404, `DELETE ${path} failed (404): Not Found`);
        issue.blockedBy = issue.blockedBy.filter((b) => b !== parent.number);
        return null;
      }
    } else if ((m = /^issues\/(\d+)\/events$/.exec(p))) {
      if (method === 'GET') return this.#page(this.#issue(m[1]).events, q);
    } else if (p === 'git/refs') {
      // the only atomic create-if-absent primitive GitHub offers — the whole claim protocol
      if (method === 'POST') {
        if (!/^refs\/.+/.test(body.ref || '')) throw this.#error(422, `POST ${path} failed (422): Validation Failed: ref must start with "refs/"`);
        if (this.refs.has(body.ref)) throw this.#error(422, `POST ${path} failed (422): Reference already exists`);
        this.refs.set(body.ref, body.sha);
        return { ref: body.ref, object: { sha: body.sha, type: 'commit' } };
      }
    } else if ((m = /^git\/commits\/([0-9a-z]+)$/.exec(p))) {
      const commit = this.commits.get(m[1]);
      if (method === 'GET') {
        if (!commit) throw this.#error(404, `GET ${path} failed (404): No commit found for SHA: ${m[1]}`);
        return { sha: m[1], author: { date: commit.date }, committer: { date: commit.date }, message: commit.message || 'hkb heartbeat' };
      }
    } else if ((m = /^git\/ref\/(.+)$/.exec(p))) {
      const ref = `refs/${m[1]}`;
      if (method === 'GET') {
        if (!this.refs.has(ref)) throw this.#error(404, `GET ${path} failed (404): Not Found`);
        return { ref, object: { sha: this.refs.get(ref), type: 'commit' } };
      }
    } else if ((m = /^git\/refs\/(.+)$/.exec(p))) {
      const ref = `refs/${m[1]}`;
      if (method === 'DELETE') {
        if (!this.refs.delete(ref)) throw this.#error(422, `DELETE ${path} failed (422): Reference does not exist`);
        return null;
      }
    } else if ((m = /^git\/matching-refs\/(.*)$/.exec(p))) {
      const prefix = `refs/${m[1]}`;
      if (method === 'GET') return [...this.refs.entries()].filter(([ref]) => ref.startsWith(prefix)).map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
    }
    throw this.#error(501, `fake-gh: no route for ${method} ${path}`);
  }

  #page(items, q) {
    const per = Number(q.get('per_page') || 30);
    const page = Number(q.get('page') || 1);
    return items.slice((page - 1) * per, page * per);
  }

  #issueRest(issue) {
    return {
      number: issue.number,
      id: issue.databaseId, // REST `id` is the database id — what the dependencies API wants
      node_id: issue.id,
      title: issue.title,
      body: issue.body,
      state: issue.state.toLowerCase(),
      state_reason: issue.stateReason ? issue.stateReason.toLowerCase() : null,
      labels: issue.labels.map((name) => ({ name })),
      html_url: issue.url,
      updated_at: issue.updatedAt,
    };
  }

  // ---------- GraphQL ----------

  #blockers(issue) {
    return issue.blockedBy.map((b) => {
      if (b && typeof b === 'object') return { number: b.number, state: String(b.state || 'OPEN').toUpperCase(), stateReason: b.stateReason ? String(b.stateReason).toUpperCase() : null, title: b.title || `issue ${b.number}` };
      const parent = this.issues.get(Number(b));
      if (!parent) throw this.#error(501, `fake-gh: issue #${b} is a blocker of #${issue.number} but was never added`);
      return { number: parent.number, state: parent.state, stateReason: parent.stateReason, title: parent.title };
    });
  }

  #node(issue) {
    const node = {
      number: issue.number,
      id: issue.id,
      databaseId: issue.databaseId,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      stateReason: issue.stateReason,
      updatedAt: issue.updatedAt,
      createdAt: issue.createdAt,
      url: issue.url,
      labels: { nodes: issue.labels.map((name) => ({ name })) },
    };
    if (this.caps.blockedByGql) {
      const nodes = this.#blockers(issue);
      node.blockedBy = { totalCount: nodes.length, nodes };
    }
    if (this.caps.closedByPrs) node.closedByPullRequestsReferences = { nodes: issue.prs.map((pr) => ({ number: pr.number, state: pr.state, isDraft: !!pr.isDraft, url: pr.url || `https://github.com/${this.nameWithOwner}/pull/${pr.number}`, headRefName: pr.headRefName || `kb/${issue.number}`, merged: !!pr.merged })) };
    return node;
  }

  #graphql({ query, variables = {} }) {
    if (/__type\(name:\s*"Issue"\)/.test(query)) {
      const fields = [{ name: 'number' }, { name: 'title' }, { name: 'labels' }];
      if (this.caps.blockedByGql) fields.push({ name: 'blockedBy' });
      if (this.caps.closedByPrs) fields.push({ name: 'closedByPullRequestsReferences' });
      return { __type: { fields } };
    }
    if (/issue\(number:/.test(query)) {
      const issue = this.issues.get(Number(variables.n));
      return { repository: { issue: issue ? this.#node(issue) : null } };
    }
    if (/issues\(/.test(query)) {
      const states = (/states:\s*\[([^\]]*)\]/.exec(query)?.[1] || 'OPEN').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      const wantLabels = variables.labels || [];
      const all = [...this.issues.values()].filter((i) => states.includes(i.state) && wantLabels.every((l) => i.labels.includes(l)));
      if (/field:\s*UPDATED_AT/.test(query)) all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b.number - a.number));
      else all.sort((a, b) => a.number - b.number); // CREATED_AT ASC
      const first = Number(variables.first ?? /issues\(first:\s*(\d+)/.exec(query)?.[1] ?? 100);
      const start = variables.cursor ? Number(variables.cursor) : 0;
      const nodes = all.slice(start, start + first);
      return {
        repository: {
          issues: {
            pageInfo: { hasNextPage: start + nodes.length < all.length, endCursor: String(start + nodes.length) },
            nodes: nodes.map((i) => this.#node(i)),
          },
        },
      };
    }
    throw this.#error(501, `fake-gh: unsupported GraphQL query: ${query.trim().slice(0, 120)}`);
  }
}

/**
 * Fixture helper: an issue spec in hkb terms (status/agent/board/kb block/run record)
 * rendered into the labels and comments a real board issue carries.
 */
export function kbIssue({ number, title, body = 'do the thing', status = 'ready', agent = null, board = 'default', needsHuman = false, kb = {}, run = null, labels = [], comments = [], ...spec } = {}) {
  const all = [...labels, L.board(board)];
  if (status) all.push(L.status(status));
  if (agent) all.push(L.agent(agent));
  if (needsHuman) all.push(L.needsHuman);
  return {
    number,
    title: title || `task ${number}`,
    body: serializeBodyBlock({ ...DEFAULT_KB, ...kb }, body),
    labels: all,
    comments: [...(run ? [serializeRunComment(run)] : []), ...comments],
    ...spec,
  };
}

/** A run record with the given attempts (and whatever else a test wants to set). */
export function runWith(attempts, extra = {}) {
  return { ...emptyRun(), attempts: attempts.map((a) => ({ profile: 'claude', ...a })), ...extra };
}
