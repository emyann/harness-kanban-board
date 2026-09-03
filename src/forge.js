// The forge: pull requests, branch protection, merges — everything hkb asks GitHub that is *not*
// board state. The board half lives behind `src/store/` (`openStore`), and a non-GitHub store
// (docs/local-first.md §6) replaces it wholesale; this file is deliberately left out of that seam
// because a local board still opens its pull requests on a forge (§6.4, "The pull-request half is
// **not** the store").
//
// Every body here was moved as it was — from `src/tasks.js` (the PR reads and mutations) and from
// `src/lifecycle.js` (`prNodeId`, `isGithubUser`, `finishPr`) — and still calls `src/gh.js`.
import { GhError, isOffline, graphql, rest } from './gh.js';
import { api } from './board.js';
import { taskBranchRe } from './model.js';

// `GhError` and `isOffline` are the transport's vocabulary, and the callers that classify a failure
// (`src/lifecycle.js`'s outbox, `src/dispatch.js`'s reclaim clock) are not transport callers
// themselves. They read them from here so `src/gh.js` keeps the short import list §11 counts.
export { GhError, isOffline };

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
