// An in-memory GitHub, installed as the `src/gh.js` transport so a test never spawns `gh`.
//
// **It is not a board any more.** The board is `test/fake-store.js` (the `Store` interface), and
// what is left here is the two things hkb still asks GitHub for:
//
//   1. **The forge** (`src/forge.js`) — pull requests, branch protection, rulesets, auto-merge,
//      merges, the repository's own branches. Every board opens its work here, whatever its cards
//      are kept in, and a PR is tied to its card by *head branch* (`kb-<n>-<k>`), never by an issue.
//   2. **The bridge's read half** (`src/bridge/github-issues.js`) — the issue queries, comments and
//      `refs/kb/locks/*` refs `hkb init --import` reads once when it migrates a board that is still
//      on GitHub Issues onto the `kb-board` branch. Read-only, and only that migration uses it.
//
// Anything hkb asks for that is not modelled fails loudly with 501 — a silent 404 would be swallowed
// by the callers that treat "not found" as "already gone".
//
//   const gh = new FakeGh();
//   gh.addPull({ number: 3, head: 'kb-7-1' });
//   const restore = gh.install();
import { GhError, classify, setTransport } from '../src/gh.js';
import { DEFAULT_KB, L, RUN_MARKER, emptyRun, serializeBodyBlock } from '../src/model.js';

/**
 * The card record both in-memory boards keep, from one `kbIssue({...})` spec.
 *
 * One copy on purpose. `test/fake-store.js` began as a transcription of these two builders and had
 * already drifted — a dropped `updated_at`, and an `html_url` off by one because the template read
 * `nextCommentId` after the `++`. A double that answers a seeded card differently from the other
 * double makes the two suites disagree about what a board looks like, which is the whole failure
 * mode both of them exist to prevent.
 *
 * @param {any} spec         a `kbIssue()` spec
 * @param {{number: number, url: string}} at  the number the caller allocated, and the card's URL
 */
export function issueRecord(spec = {}, { number, url }) {
  return {
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
    run: spec.run ?? null,
    createdAt: spec.createdAt || `2026-08-26T00:00:${String(number % 60).padStart(2, '0')}Z`,
    updatedAt: spec.updatedAt || spec.createdAt || '2026-08-26T01:00:00Z',
    url,
  };
}

/** One comment on `url`, with the id the caller allocated — the same shape on both doubles. */
export function commentRecord({ id, body, url }) {
  return {
    id,
    body,
    user: { login: 'hkb' },
    created_at: '2026-08-26T01:00:00Z',
    updated_at: '2026-08-26T01:00:00Z',
    html_url: `${url}#issuecomment-${id}`,
  };
}

const fmt = (ts) => (ts ? String(ts).replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '');

/**
 * A run record rendered as the `<!-- kb-run -->` comment the GitHub protocol kept it in.
 *
 * A **fixture builder**, and the only thing in the repository that writes one: nothing in `src/`
 * does any more (docs/local-first.md §7). It lives here so the migration's tests — and `hkb watch`,
 * which still parses a comment it polls — have a way to seed the shape they read.
 */
export function runComment(run) {
  const rows = (run.attempts || []).map((a) =>
    `| ${a.attempt} | ${a.profile || ''} | ${a.host || ''} | ${fmt(a.started_at)} | ${fmt(a.ended_at) || '—'} | ${a.outcome || 'active'} | ${(a.summary || a.reason || '').split('\n')[0].slice(0, 120)} |`);
  return [
    RUN_MARKER,
    '**hkb run record** — maintained by `hkb`; do not edit by hand.',
    '',
    `failures: ${run.failures} · attempts: ${(run.attempts || []).length}${run.last_error ? ` · last error: ${String(run.last_error).slice(0, 200)}` : ''}`,
    '',
    '| # | profile | host | started | ended | outcome | note |',
    '|---|---|---|---|---|---|---|',
    ...(rows.length ? rows : ['| — | | | | | | |']),
    '',
    '```json',
    JSON.stringify(run, null, 2),
    '```',
  ].join('\n');
}

export class FakeGh {
  constructor({ owner = 'acme', repo = 'board', defaultBranch = 'main', baseSha = 'f'.repeat(40), caps = {}, allowAutoMerge = true } = {}) {
    this.owner = owner;
    this.repo = repo;
    this.nameWithOwner = `${owner}/${repo}`;
    this.defaultBranch = defaultBranch;
    this.allowAutoMerge = allowAutoMerge; // the repo setting `enablePullRequestAutoMerge` needs
    this.caps = { blockedByGql: true, ...caps };
    this.issues = new Map(); // number -> issue record (the bridge's read half only)
    this.refs = new Map(); // full ref name -> sha
    this.requests = []; // every request, in order
    this.failures = []; // injected errors, see fail()
    this.nextCommentId = 1000;
    this.commits = new Map(); // sha -> {date} — what a ref-CAS heartbeat left behind
    this.protection = new Map(); // branch -> classic protection payload, or the string 'forbidden'
    /**
     * Every pull request on the repo, in one list — which is how the forge sees them and how hkb
     * now finds a card's PR: `openPrsByHead`/`mergedPrsByHead` read `GET /pulls` and match the head
     * branch against `kb-<n>-<k>`. There is deliberately no per-issue list: an issue does not own a
     * pull request any more, and a double that kept one would model a link hkb no longer uses.
     */
    this.pulls = [];
    this.rules = new Map(); // branch -> the ruleset rules `GET /rules/branches/<b>` returns
    this.refs.set(`refs/heads/${defaultBranch}`, baseSha);
    this.transport = this.transport.bind(this);
  }

  /** Install as the gh transport. Returns the restore function from setTransport. */
  install() { return setTransport(this.transport); }

  // ---------- seeding ----------

  /**
   * A pull request. `head` is normally one of hkb's own branch names (`kb/<n>`, `kb-<n>-<k>`,
   * `worktree-kb-<n>-<k>`), because that name is the *only* thing that ties it to a card.
   */
  addPull({ number, head, base = this.defaultBranch, draft = false, state = 'open', merged = false, mergedAt = null, nodeId = null, autoMerge = null, mergeable = null, mergeStateStatus = null, checksState = undefined } = {}) {
    const pr = {
      number,
      nodeId: nodeId || `PR_kwFake${number}`,
      head,
      base,
      draft: !!draft,
      state: String(state).toUpperCase() === 'MERGED' ? 'MERGED' : String(state).toUpperCase(),
      merged: !!merged || String(state).toUpperCase() === 'MERGED',
      mergedAt,
      autoMerge,
      mergeable,
      mergeStateStatus,
      checksState,
      url: `https://github.com/${this.nameWithOwner}/pull/${number}`,
    };
    if (pr.merged && !pr.mergedAt) pr.mergedAt = '2026-08-26T03:00:00Z';
    this.pulls.push(pr);
    return pr;
  }

  /**
   * An issue, for the bridge's read half only (`hkb init --import`). A `prs: [...]` on the spec is
   * flattened into the repository's pull requests, defaulting the head branch to `kb/<n>` — the
   * shape those fixtures always meant.
   */
  addIssue(spec = {}) {
    const number = spec.number ?? (Math.max(0, ...this.issues.keys()) + 1);
    const issue = issueRecord(spec, { number, url: `https://github.com/${this.nameWithOwner}/issues/${number}` });
    this.issues.set(number, issue);
    if (issue.run) this.addComment(number, runComment(issue.run));
    for (const body of spec.comments || []) this.addComment(number, body);
    for (const pr of issue.prs) {
      this.addPull({
        number: pr.number,
        head: pr.headRefName || `kb/${number}`,
        base: pr.baseRefName || this.defaultBranch,
        draft: !!pr.isDraft,
        state: pr.state || 'OPEN',
        merged: !!pr.merged,
        nodeId: pr.nodeId || null,
        autoMerge: pr.autoMerge || null,
        mergeable: pr.mergeable ?? null,
        mergeStateStatus: pr.mergeStateStatus ?? null,
        checksState: pr.checksState,
      });
    }
    return issue;
  }

  addComment(number, body) {
    const issue = this.#issue(number);
    const c = commentRecord({ id: this.nextCommentId++, body, url: issue.url });
    issue.comments.push(c);
    return c;
  }

  /**
   * A claim the retired protocol left on the forge: a lock ref pointing at a commit dated `at`.
   * What `hkb init --import` finds and sweeps up (`dropGithubLeftovers`, src/store/local.js).
   */
  beat(n, k, at, sha = null) {
    const commit = sha || `beat${n}${k}${new Date(at).getTime().toString(16)}`.padEnd(40, '0').slice(0, 40);
    this.refs.set(`refs/kb/locks/${n}/${k}`, commit);
    this.commits.set(commit, { date: new Date(at).toISOString() });
    return commit;
  }

  /**
   * Classic branch protection on `branch`. `checks` are required status-check contexts and
   * `reviews` the required approving-review count; `admin: false` makes the protection endpoint
   * answer 403, which is how it behaves for a token without repo admin.
   */
  protect(branch, { checks = [], reviews = 0, admin = true } = {}) {
    this.protection.set(branch, admin
      ? {
        required_status_checks: checks.length ? { strict: false, contexts: checks, checks: checks.map((context) => ({ context, app_id: null })) } : null,
        required_pull_request_reviews: reviews ? { required_approving_review_count: reviews } : null,
      }
      : 'forbidden');
    return this;
  }

  /** The newer mechanism: a ruleset covering `branch`, as `GET /rules/branches/<b>` returns it. */
  ruleset(branch, { checks = [], reviews = 0 } = {}) {
    const rules = [];
    if (checks.length) rules.push({ type: 'required_status_checks', parameters: { required_status_checks: checks.map((context) => ({ context })), strict_required_status_checks_policy: false } });
    if (reviews) rules.push({ type: 'pull_request', parameters: { required_approving_review_count: reviews } });
    this.rules.set(branch, rules);
    return this;
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

  /** One pull request as the double keeps it, or null. */
  prOf(number) { return this.pulls.find((p) => p.number === Number(number)) || null; }
  /** The auto-merge request on a PR, as the board query would report it: null until enabled. */
  autoMergeOf(prNumber) { return this.prOf(prNumber)?.autoMerge || null; }
  lockRefs() { return [...this.refs.keys()].filter((r) => r.startsWith('refs/kb/locks/')).sort(); }
  /** Every request whose method and path match — for "and nothing was written" assertions. */
  requestsMatching(method, path) {
    return this.requests.filter((c) => (!method || c.method === method) && (!path || (path instanceof RegExp ? path.test(c.path || '') : String(c.path || '').includes(path))));
  }

  /**
   * Every request that could have changed something on the forge, as `"<method> <path>"` — the half
   * of "and nothing was written" the *store* cannot see. Pull requests are `src/forge.js`, they go
   * through `src/gh.js` whatever the board is kept in, so a read-only path that started PATCHing a
   * PR would leave `store.writes()` empty and still be a write. Assert both.
   */
  writeRequests() {
    return this.requests
      .filter((c) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(String(c.method))
        || (c.kind === 'graphql' && /^\s*mutation\b/.test(String(c.query || ''))))
      .map((c) => (c.kind === 'graphql' ? `mutation ${String(c.query).match(/\b(\w+)\(input:/)?.[1] || ''}`.trim() : `${c.method} ${c.path}`));
  }

  // ---------- transport ----------

  transport(req) {
    this.requests.push({ kind: req.kind, method: req.method || null, path: req.path || null, body: req.body ?? null, query: req.query || null, variables: req.variables || null });
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

  // ---------- REST ----------

  #rest({ method, path, body }) {
    const base = `repos/${this.owner}/${this.repo}`;
    // The one route outside the repository: `isGithubUser` (src/forge.js) asks whether a reviewer
    // name is a login before it requests a review with it.
    let u;
    if ((u = /^users\/(.+)$/.exec(path))) {
      if (method === 'GET') {
        const login = decodeURIComponent(u[1]);
        // Every profile name that is not a login answers 404, the way GitHub does.
        if (/^(claude|codex|copilot)(-|$)/.test(login)) throw this.#error(404, `GET ${path} failed (404): Not Found`);
        return { login, type: 'User' };
      }
    }
    if (path !== base && !path.startsWith(`${base}/`)) throw this.#error(501, `fake-gh: no route for ${method} ${path}`);
    const [p, qs] = path.slice(base.length).replace(/^\//, '').split('?');
    const q = new URLSearchParams(qs || '');
    let m;

    if (p === '') {
      if (method === 'GET') return { name: this.repo, full_name: this.nameWithOwner, default_branch: this.defaultBranch, allow_auto_merge: this.allowAutoMerge };

      // ---------- the forge ----------
    } else if (p === 'pulls') {
      // What `openPrsByHead` and `mergedPrsByHead` (src/forge.js) read: the repository's pull
      // requests, filtered by state. `sort`/`direction` are accepted and ignored — the double keeps
      // insertion order, and a test that cares seeds the order it wants.
      if (method === 'GET') {
        const state = (q.get('state') || 'open').toLowerCase();
        const all = this.pulls
          .filter((pr) => state === 'all' || (state === 'closed' ? pr.state !== 'OPEN' : pr.state === 'OPEN'))
          .map((pr) => this.#pullRest(pr));
        return this.#page(all, q);
      }
    } else if ((m = /^pulls\/(\d+)$/.exec(p))) {
      const pr = this.prOf(m[1]);
      if (method === 'GET') {
        if (!pr) throw this.#error(404, `GET ${path} failed (404): Not Found`);
        return this.#pullRest(pr);
      }
    } else if ((m = /^pulls\/(\d+)\/requested_reviewers$/.exec(p))) {
      const pr = this.prOf(m[1]);
      if (method === 'POST') {
        if (!pr) throw this.#error(404, `POST ${path} failed (404): Not Found`);
        pr.reviewers = [...(pr.reviewers || []), ...(body.reviewers || [])];
        return this.#pullRest(pr);
      }
    } else if ((m = /^branches\/([^/]+)\/protection$/.exec(p))) {
      // classic branch protection: 404 when there is none, 403 without repo admin
      const branch = decodeURIComponent(m[1]);
      if (method === 'GET') {
        const prot = this.protection.get(branch);
        if (!prot) throw this.#error(404, `GET ${path} failed (404): Branch not protected`);
        if (prot === 'forbidden') throw this.#error(403, `GET ${path} failed (403): Must have admin rights to Repository.`);
        return prot;
      }
    } else if ((m = /^rules\/branches\/(.+)$/.exec(p))) {
      // rulesets: readable without admin, and empty rather than 404 when nothing covers the branch
      if (method === 'GET') return this.rules.get(decodeURIComponent(m[1])) || [];

      // ---------- the repository's own branches (base sha, kb/track-<root>) ----------
    } else if (p === 'git/refs') {
      if (method === 'POST') {
        if (!/^refs\/.+/.test(body.ref || '')) throw this.#error(422, `POST ${path} failed (422): Validation Failed: ref must start with "refs/"`);
        if (this.refs.has(body.ref)) throw this.#error(422, `POST ${path} failed (422): Reference already exists`);
        this.refs.set(body.ref, body.sha);
        return { ref: body.ref, object: { sha: body.sha, type: 'commit' } };
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
    } else if ((m = /^git\/commits\/([0-9a-z]+)$/.exec(p))) {
      const commit = this.commits.get(m[1]);
      if (method === 'GET') {
        if (!commit) throw this.#error(404, `GET ${path} failed (404): No commit found for SHA: ${m[1]}`);
        return { sha: m[1], author: { date: commit.date }, committer: { date: commit.date }, message: commit.message || 'hkb heartbeat' };
      }

      // ---------- the bridge's read half (hkb init --import) ----------
    } else if (p === 'issues') {
      if (method === 'GET') {
        const state = (q.get('state') || 'open').toLowerCase();
        const all = [...this.issues.values()]
          .filter((i) => state === 'all' || String(i.state).toLowerCase() === state)
          .map((i) => ({ ...this.#issueRest(i), created_at: i.createdAt ?? i.updatedAt }));
        return this.#page(all, q);
      }
    } else if ((m = /^issues\/(\d+)$/.exec(p))) {
      if (method === 'GET') return this.#issueRest(this.#issue(m[1]));
    } else if ((m = /^issues\/(\d+)\/comments$/.exec(p))) {
      const issue = this.#issue(m[1]);
      // A snapshot, not a live reference: real GitHub hands back a fresh JSON blob per call.
      if (method === 'GET') return this.#page(issue.comments, q).map((c) => ({ ...c }));
    } else if ((m = /^issues\/(\d+)\/dependencies\/blocked_by$/.exec(p))) {
      const issue = this.#issue(m[1]);
      if (method === 'GET') return this.#blockers(issue).map((b) => ({ number: b.number, title: b.title, state: b.state.toLowerCase(), state_reason: b.stateReason ? b.stateReason.toLowerCase() : null }));
    }
    throw this.#error(501, `fake-gh: no route for ${method} ${path}`);
  }

  #page(items, q) {
    const per = Number(q.get('per_page') || 30);
    const page = Number(q.get('page') || 1);
    return items.slice((page - 1) * per, page * per);
  }

  #pullRest(pr) {
    return {
      number: pr.number,
      node_id: pr.nodeId,
      draft: !!pr.draft,
      state: pr.state === 'OPEN' ? 'open' : 'closed',
      merged: !!pr.merged,
      merged_at: pr.merged ? pr.mergedAt : null,
      html_url: pr.url,
      head: { ref: pr.head || null },
      base: { ref: pr.base || this.defaultBranch },
      auto_merge: pr.autoMerge ? {} : null,
    };
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
    return node;
  }

  #graphql({ query, variables = {} }) {
    if (/mergeStateStatus/.test(query)) {
      const repository = {};
      for (const m of query.matchAll(/pr(\d+):\s*pullRequest\(number:\s*\1\)/g)) {
        const n = Number(m[1]);
        const pr = this.prOf(n);
        repository[`pr${n}`] = pr ? { number: n, mergeable: pr.mergeable || 'UNKNOWN', mergeStateStatus: pr.mergeStateStatus || null } : null;
      }
      return { repository };
    }
    if (/mergePullRequest/.test(query)) {
      const pr = this.pulls.find((x) => x.nodeId === variables.id);
      if (!pr) throw this.#error(404, `GraphQL failed (404): Could not resolve to a node with the id ${variables.id}`);
      if (pr.state !== 'OPEN') throw this.#error(422, `GraphQL failed (422): Pull request is ${String(pr.state).toLowerCase()}`);
      pr.state = 'MERGED';
      pr.merged = true;
      pr.mergedAt = pr.mergedAt || '2026-08-26T03:00:00Z';
      return { mergePullRequest: { pullRequest: { number: pr.number, merged: true } } };
    }
    if (/markPullRequestReadyForReview/.test(query)) {
      const pr = this.pulls.find((x) => x.nodeId === variables.id);
      if (!pr) throw this.#error(404, `GraphQL failed (404): Could not resolve to a node with the id ${variables.id}`);
      pr.draft = false;
      return { markPullRequestReadyForReview: { pullRequest: { number: pr.number, isDraft: false } } };
    }
    if (/statusCheckRollup/.test(query)) {
      const pr = this.prOf(variables.n);
      const state = pr && pr.checksState !== undefined ? pr.checksState : null;
      return { repository: { pullRequest: pr ? { commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] } } : null } };
    }
    if (/enablePullRequestAutoMerge/.test(query)) {
      const pr = this.pulls.find((x) => x.nodeId === variables.id);
      if (!pr) throw this.#error(404, `GraphQL failed (404): Could not resolve to a node with the id ${variables.id}`);
      // GitHub refuses both of these, and hkb must never ask: a draft cannot auto-merge, and a
      // merged PR has nothing left to enable.
      if (!this.allowAutoMerge) throw this.#error(422, 'GraphQL failed (422): Auto merge is not allowed for this repository');
      if (pr.draft) throw this.#error(422, 'GraphQL failed (422): Pull request is in draft state');
      if (pr.state !== 'OPEN') throw this.#error(422, `GraphQL failed (422): Pull request is ${pr.state.toLowerCase()}`);
      pr.autoMerge = { enabledAt: '2026-08-26T02:00:00Z', mergeMethod: variables.method };
      return { enablePullRequestAutoMerge: { pullRequest: { number: pr.number, autoMergeRequest: pr.autoMerge } } };
    }
    if (/__type\(name:\s*"Issue"\)/.test(query)) {
      const fields = [{ name: 'number' }, { name: 'title' }, { name: 'labels' }];
      if (this.caps.blockedByGql) fields.push({ name: 'blockedBy' });
      return { __type: { fields } };
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
 * Fixture helper: a card spec in hkb terms (status/agent/board/kb block/run record) rendered into
 * the labels and comments a board issue carries. Both doubles read it — `test/fake-store.js` keeps
 * the run record as a record, `FakeGh` renders it as the comment the GitHub protocol kept it in.
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
    run,
    comments: [...comments],
    ...spec,
  };
}

/** A run record with the given attempts (and whatever else a test wants to set). */
export function runWith(attempts, extra = {}) {
  return { ...emptyRun(), attempts: attempts.map((a) => ({ profile: 'claude', ...a })), ...extra };
}
