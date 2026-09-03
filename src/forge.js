// The forge: pull requests, branch protection, merges — everything hkb asks GitHub that is *not*
// board state. The board lives behind `src/store/` (`openStore`) and is a branch in this repository
// (docs/local-first.md §6); this file is deliberately outside that seam, because a local board still
// opens its work as pull requests on a forge (§6.4, "The pull-request half is **not** the store").
//
// **The two are joined by the head branch name and nothing else.** `fillPrs` is that join: the store
// answers with the card, this file answers with the pull request, and `taskBranchRe` (src/model.js)
// is the one definition of "this card's branch".
import { GhError, isOffline, graphql, rest, restRaw } from './gh.js';
import { api } from './board.js';
import { taskBranchRe, trackBranchName, trackBranchRoot } from './model.js';

// `GhError` and `isOffline` are the transport's vocabulary and stay in `src/gh.js`: a caller that
// classifies a failure has nothing to do with pull requests, and a board whose store is local still
// has to tell an offline write from a refused one.

// ---------- the repository's own branches ----------
// Not board state either: `baseSha` is the head every track branch is created at, and
// `kb/track-<root>` is a branch on the forge. They live here rather than in a store, so
// `src/dispatch.js`, `src/doctor.js` and `src/gc.js` reach them without importing a driver.

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


/**
 * Every open PR on the repo, keyed by head branch — one paginated REST read. `closedByPullRequestsReferences`
 * is hkb's only source for a task's PRs, and it answers a narrower question than hkb asks of it: it
 * requires the PR to target the default branch, and #234 found at least one PR that met that bar and
 * still came back empty. hkb generates the branch names it puts a card's work on itself
 * (`taskBranchRe`), so a board-wide listing of open PRs, matched by head, is a fallback that costs one
 * request whatever the board's size rather than one per unlinked card.
 */
export async function openPrsByHead(ctx) {
  return prsByHead(ctx, { state: 'open' });
}

/**
 * The listing itself. `state` is GitHub's: `open` (the guard's question) or `all` — the sweep's,
 * because "is this checkout's work landed" is answered by a PR that is *closed*, and a listing of
 * open ones can only say "not here", which is also what a card with no PR at all looks like.
 *
 * An `all` listing is ordered newest-updated first so a head branch that has carried more than one
 * pull request resolves to the one that moved last.
 * @param {any} ctx
 * @param {{state?: 'open'|'all'}} [opts]
 */
export async function prsByHead(ctx, { state = 'open' } = {}) {
  const out = new Map();
  const sort = state === 'all' ? '&sort=updated&direction=desc' : '';
  for (let page = 1; page <= 10; page++) {
    const batch = await rest('GET', api(ctx, `/pulls?state=${state}&per_page=100&page=${page}${sort}`));
    for (const p of batch || []) {
      const head = p.head?.ref;
      if (!head || out.has(head)) continue;
      const merged = !!(p.merged_at || p.merged);
      out.set(head, {
        number: p.number,
        nodeId: p.node_id,
        state: p.state === 'open' ? 'OPEN' : merged ? 'MERGED' : 'CLOSED',
        isDraft: !!p.draft,
        url: p.html_url,
        headRefName: head,
        baseRefName: p.base?.ref || null,
        merged,
        mergedAt: p.merged_at || null,
        autoMergeEnabled: !!p.auto_merge,
      });
    }
    if (!batch || batch.length < 100) break;
  }
  return out;
}

/**
 * Every *merged* PR on the repo, keyed by head branch — the reconcile pass's input.
 *
 * One page of the closed-PR listing, newest-updated first: a PR that merged since the last tick is
 * by definition freshly updated, so it sits at the top. One request per tick whatever the board's
 * size, and the tick only asks when something is in flight (`shouldReconcile`, src/dispatch.js).
 * A PR that merged and then sat untouched while a hundred others closed behind it falls off the
 * page — the card is then moved by `hkb merge` or by hand, and `hkb doctor` still names it.
 */
export async function mergedPrsByHead(ctx) {
  const out = new Map();
  const batch = await rest('GET', api(ctx, '/pulls?state=closed&sort=updated&direction=desc&per_page=100'));
  for (const p of batch || []) {
    const head = p.head?.ref;
    if (!head || !(p.merged_at || p.merged)) continue;
    if (out.has(head)) continue; // newest-updated wins; an older PR on the same branch is history
    out.set(head, {
      number: p.number,
      nodeId: p.node_id,
      state: 'MERGED',
      isDraft: false,
      url: p.html_url,
      headRefName: head,
      baseRefName: p.base?.ref || null,
      merged: true,
      mergedAt: p.merged_at || null,
      autoMergeEnabled: false,
    });
  }
  return out;
}

/**
 * A task with no PR of its own, matched against a board-wide PR listing by head branch. Pure given
 * the listing: never overrides a PR the caller already has, and never looks two tasks up in one
 * call, so a card that legitimately has no PR still reports none.
 *
 * **The branch name is the link.** hkb's board has no issue for a pull request to be linked to, so
 * `kb-<n>-<k>` (and the `worktree-`, `kb/<n>` and `kb/track-<n>` spellings hkb also creates) is what
 * ties one to its card, here and in the reconcile pass. `taskBranchRe` is the one definition of that
 * name.
 */
export function branchFallbackPrs(task, openByHead) {
  if ((task.prs || []).length) return task.prs;
  const re = taskBranchRe(task.number);
  const found = [];
  for (const [head, pr] of openByHead) if (re.test(head)) found.push(pr);
  return found;
}

/**
 * Fill `prs` on cards the **store** cannot answer for — one open-PR listing, board-wide, applied by
 * head branch. Board state and pull requests are two different systems now (docs/local-first.md
 * §6.4): the store knows the card, the forge knows the PR, and this is the join. Every read that
 * goes on to judge a card by its PR — the tick's `active_pr` guard, the terminal verbs, `hkb show`,
 * the web board — calls it on what the store handed back.
 *
 * One request per tick, never one per card (#234). The *promise* is memoized on `ctx._cache`, not
 * its value, because `hkb create "x" --blocked-by 1,2,3` reads four cards with `Promise.all` and a
 * value memo would still issue one listing each; a failed one is forgotten so the next read retries
 * rather than replaying the error. The dispatcher drops the memo at the top of every tick
 * (`dropPrCaches`), so a loop never judges a card on last tick's listing.
 *
 * `state: 'all'` is for the caller that has to see a PR after it merged — `hkb gc`, deciding whether
 * a subagent's checkout is scrap. It is memoized in its own slot, so a tick that wants both pays for
 * one of each rather than one of whichever came first.
 *
 * @template {any} T
 * @param {any} ctx
 * @param {T} tasks  one task or an array of them — returned as given, filled in place
 * @param {{state?: 'open'|'all'}} [opts]
 * @returns {Promise<T>}
 */
export async function fillPrs(ctx, tasks, { state = 'open' } = {}) {
  const list = (Array.isArray(tasks) ? tasks : [tasks]).filter(Boolean);
  if (!list.some((t) => !(t.prs || []).length)) return tasks;
  const slot = state === 'all' ? 'prsByHeadAll' : 'prsByHead';
  if (!ctx._cache[slot]) ctx._cache[slot] = prsByHead(ctx, { state });
  const pending = ctx._cache[slot];
  let openByHead;
  try {
    openByHead = await pending;
  } catch (e) {
    if (ctx._cache[slot] === pending) delete ctx._cache[slot];
    throw e;
  }
  for (const t of list) t.prs = branchFallbackPrs(t, openByHead);
  return tasks;
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

/** The PR's node id: from the board read when the GraphQL field is there, else one REST lookup. */
export async function prNodeId(ctx, pr) {
  if (pr.nodeId) return pr.nodeId;
  const p = await rest('GET', api(ctx, `/pulls/${pr.number}`));
  return p?.node_id || null;
}

/** True when the profile name is also a GitHub user login — profiles like `claude` are not. */
export async function isGithubUser(ctx, login) {
  try {
    const u = await rest('GET', `users/${encodeURIComponent(login)}`);
    return u?.type === 'User';
  } catch (e) {
    if (e instanceof GhError && e.kind === 'notfound') return false;
    throw e;
  }
}

/**
 * Leave the PR mergeable: take it out of draft, and (request-review) put the reviewer on it.
 * Never throws — the attempt is already closed by the time this runs, so trouble here is
 * reported on the result object and on stderr, not raised.
 */
/**
 * @param {any} ctx
 * @param {any} decision
 * @param {{reviewer?: string}} [opts]
 */
export async function finishPr(ctx, decision, { reviewer } = {}) {
  const pr = decision.pr;
  const out = { pr: pr?.number ?? null, pr_head: pr?.headRefName ?? null, pr_ready: pr ? !pr.isDraft : null };
  if (!pr) return out;
  if (decision.markReady) {
    try {
      const id = await prNodeId(ctx, pr);
      if (!id) throw new Error('could not resolve its node id');
      await graphql('mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { number isDraft } } }', { id });
      pr.isDraft = false;
      out.pr_ready = true;
    } catch (e) {
      out.pr_ready = false;
      out.pr_error = `PR #${pr.number} is still a draft: ${e.message}. Run \`gh pr ready ${pr.number}\` before merging.`;
      process.stderr.write(`hkb: ${out.pr_error}\n`);
    }
  }
  if (reviewer) {
    try {
      if (await isGithubUser(ctx, reviewer)) {
        await rest('POST', api(ctx, `/pulls/${pr.number}/requested_reviewers`), { body: { reviewers: [String(reviewer)] } });
        out.reviewer_requested = String(reviewer);
      } else {
        out.reviewer_note = `"${reviewer}" is not a GitHub user — no reviewer requested on PR #${pr.number}`;
      }
    } catch (e) {
      out.reviewer_note = `could not request ${reviewer} on PR #${pr.number}: ${e.message}`;
      process.stderr.write(`hkb: ${out.reviewer_note}\n`);
    }
  }
  return out;
}
