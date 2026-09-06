import fs from 'node:fs';

import { artifactPaths } from './artifacts.ts';
/**
 * `proposals` — the half of ADR-011 that was decided and left to build.
 *
 * ADR-011 settled the shape: **a workload never writes to the board.** It declares a proposal as an
 * output, and the controller validates it and applies it once an approval is recorded. Two things
 * had to exist first and now do — an uncapped channel that does not land in the repository
 * (`src/artifacts.ts`) and a read side that can hand a run the board's own state
 * (`src/inputs.ts`). This module is the third thing: **the validator**.
 *
 * ## What a validator is for, when the thing on the other side is a model
 *
 * Not parsing. The refusals are the feature. A worker writes a file; whatever is in that file was
 * chosen by a model and reviewed by nobody, so every field this accepts is a field a model gets to
 * decide. That is the whole argument for the allowlist below being three keys long rather than the
 * Job spec's twenty: `name`, `brief`, and a `maxBudgetUsd` that may only ever go **down**.
 *
 * Everything else — `isolate`, `allowedTools`, `pluginPaths`, `gate`, `exports`, `inputs`, and
 * `proposes` itself — is refused by not being in the list, and the proposed Job inherits its board's
 * defaults instead. Three of those are guards (ADR-012's grant, the admission gate's tool surface,
 * ADR-008's isolation), and a proposal that could set them would be a worker widening its own
 * successor's permissions. `proposes` is refused for the extra reason that a proposal which can
 * propose a proposer is a loop with no human in it.
 *
 * Adding a key here later is cheap and reversible. Shipping an open shape and narrowing it later is
 * neither, because by then something depends on the field.
 *
 * ## What this module deliberately does not do
 *
 * **Idempotency is not here.** ADR-011 decision 4 keys a created Job by `(jobId, attempt, index)`,
 * and that key is a unique constraint in the schema — so a re-applied proposal fails its second
 * `create` and is skipped, rather than being deduplicated by logic that has to be right. The same
 * reasoning as `Lease.slot`: the constraint is the allocator.
 *
 * **Approval is not here either.** Nothing this returns may be applied on its own; the controller
 * applies it only against an `approved` event (decision 5), and the CLI never creates the rows.
 */

/**
 * The file a proposing Job writes, inside its artifact directory.
 *
 * A fixed name rather than a declared one: the artifact channel carries whatever a Job declares,
 * but the *controller* has to know which file to parse, and "the one called `proposal.json`" is a
 * contract both ends can hold without another spec column to disagree about.
 */
export const PROPOSAL_ARTIFACT = 'proposal.json';

/**
 * The cap on the proposal file, in bytes.
 *
 * The artifact channel is uncapped on purpose — that is why the proposal rides it rather than
 * `results` (`src/results.ts:24-31`). This cap is a different thing: not storage, but **what a human
 * can read before saying yes**. A 4 MB proposal is not reviewable, and an approval nobody could have
 * read is the failure mode this whole record exists to avoid.
 */
export const PROPOSAL_MAX_BYTES = 64 * 1024;

/** How many Jobs one proposal may create. Same reason as the byte cap: a reviewable number. */
export const PROPOSAL_MAX_JOBS = 20;

/** Caps on the two fields a proposal actually sets. A name is a line; a brief is a page or two. */
export const PROPOSED_NAME_MAX = 200;
export const PROPOSED_BRIEF_MAX = 20_000;

/** One Job a proposal asks for. The whole surface — see the allowlist argument above. */
export type ProposedJob = { name: string; brief: string; maxBudgetUsd?: number };

/** The keys a proposal may set, in the order `hkb show` prints them. */
const JOB_KEYS = ['name', 'brief', 'maxBudgetUsd'] as const;

/** What a validated proposal holds: the rows to create, and what had to be bent to accept them. */
export type Proposal = { jobs: ProposedJob[]; clamped: string[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Read a proposal, or say exactly why not.
 *
 * Returns `{ why }` rather than throwing, because the caller is the controller: a refusal here is an
 * attempt that failed with a reason an operator reads, not an exception that unwinds a reconcile
 * pass. Every message names the offending path (`jobs[2].isolate`) — a model that gets one back on a
 * retry can act on it, and so can the human reading `hkb show`.
 *
 * `ceiling` is the proposing Job's own resolved budget cap, or null for a board with none. A
 * proposal may ask for less; asking for more is clamped rather than refused, because the number is
 * advisory in a way the other fields are not — the board's gate charges the resolved cap regardless
 * (`src/limits.ts`), so a raised number would buy the proposer nothing and only mislead a reader.
 */
export function checkProposal(text: string, ceiling: number | null = null): Proposal | { why: string } {
  const bytes = Buffer.byteLength(text);
  if (bytes > PROPOSAL_MAX_BYTES) {
    return { why: `the proposal is ${bytes} bytes, over the ${PROPOSAL_MAX_BYTES}-byte cap — a proposal is something a human reads before approving it, so it has to stay readable` };
  }
  if (!text.trim()) return { why: 'the proposal file is empty' };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { why: `the proposal is not valid JSON: ${(e as Error).message}` };
  }
  if (!isObject(raw)) return { why: 'the proposal must be a JSON object with a `jobs` array, not ' + (Array.isArray(raw) ? 'an array' : typeof raw) };

  const unknown = Object.keys(raw).filter((k) => k !== 'jobs');
  if (unknown.length) {
    return { why: `the proposal sets ${unknown.map((k) => `\`${k}\``).join(', ')}, which nothing reads — the only key is \`jobs\`` };
  }
  if (!Array.isArray(raw.jobs)) return { why: 'the proposal has no `jobs` array' };
  if (!raw.jobs.length) return { why: 'the proposal is an empty list — a run with nothing to propose should say so in a result, not file an empty proposal' };
  if (raw.jobs.length > PROPOSAL_MAX_JOBS) {
    return { why: `the proposal asks for ${raw.jobs.length} Jobs, over the limit of ${PROPOSAL_MAX_JOBS} — that is more than a person can review in one pass, which is the only moment anybody looks` };
  }

  const jobs: ProposedJob[] = [];
  const clamped: string[] = [];
  for (const [i, entry] of raw.jobs.entries()) {
    const at = `jobs[${i}]`;
    if (!isObject(entry)) return { why: `${at} is ${Array.isArray(entry) ? 'an array' : typeof entry}, not an object` };

    const extra = Object.keys(entry).filter((k) => !(JOB_KEYS as readonly string[]).includes(k));
    if (extra.length) {
      // Named rather than dropped. A silently ignored `isolate: false` would let a proposal read as
      // though it had been honoured, and the difference only shows up in what the Job then does.
      return { why: `${at} sets ${extra.map((k) => `\`${k}\``).join(', ')}, which a proposal may not — a proposed Job may set ${JOB_KEYS.map((k) => `\`${k}\``).join(', ')} and inherits everything else from its board` };
    }

    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name) return { why: `${at} has no \`name\` — every Job on the board is read as a one-line list first` };
    if (name.length > PROPOSED_NAME_MAX) return { why: `${at}.name is ${name.length} characters, over ${PROPOSED_NAME_MAX} — a name is a line, and the detail belongs in the brief` };

    const brief = typeof entry.brief === 'string' ? entry.brief.trim() : '';
    if (!brief) return { why: `${at} has no \`brief\` — a Job with no instruction is a row nobody can run` };
    if (brief.length > PROPOSED_BRIEF_MAX) return { why: `${at}.brief is ${brief.length} characters, over ${PROPOSED_BRIEF_MAX}` };

    const job: ProposedJob = { name, brief };
    if (entry.maxBudgetUsd !== undefined) {
      const n = entry.maxBudgetUsd;
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) {
        return { why: `${at}.maxBudgetUsd is ${JSON.stringify(n)} — it has to be a positive number of dollars` };
      }
      if (ceiling !== null && n > ceiling) {
        job.maxBudgetUsd = ceiling;
        clamped.push(`${at}.maxBudgetUsd asked for $${n.toFixed(2)} and was clamped to $${ceiling.toFixed(2)}`);
      } else {
        job.maxBudgetUsd = n;
      }
    }
    jobs.push(job);
  }
  return { jobs, clamped };
}

/**
 * Read a stored proposal back off the Attempt row. Defensive: the column is `Json?` and the row may
 * predate any given shape of it.
 */
export function storedProposal(value: unknown): Proposal | null {
  if (!isObject(value) || !Array.isArray(value.jobs)) return null;
  const jobs = value.jobs.filter((j): j is ProposedJob =>
    isObject(j) && typeof j.name === 'string' && typeof j.brief === 'string');
  if (!jobs.length) return null;
  return { jobs, clamped: Array.isArray(value.clamped) ? value.clamped.filter((c): c is string => typeof c === 'string') : [] };
}

/** What the gate asks a human, for a Job that proposed `n` Jobs. `Job.suspendedFor` holds this. */
export function proposalGate(n: number): string {
  return `${n} Job${n === 1 ? '' : 's'} proposed — approve to file ${n === 1 ? 'it' : 'them'}`;
}

/** One line per proposed Job, for `hkb show`. The approver reads this before saying yes. */
export function describeProposal(p: Proposal): string[] {
  return p.jobs.map((j, i) => {
    const budget = j.maxBudgetUsd === undefined ? '' : `  [$${j.maxBudgetUsd.toFixed(2)}]`;
    // One line of the brief, because the list is the thing being reviewed and a full brief per row
    // would bury it. `hkb show --json` carries all of it for anyone who wants the rest.
    const first = j.brief.split('\n').find((l) => l.trim()) ?? '';
    const head = first.length > 96 ? `${first.slice(0, 95)}…` : first;
    return `[${i}] ${j.name}${budget}\n      ${head}`;
  });
}

/**
 * Read an attempt's proposal off disk and validate it. The one I/O function here, kept thin so the
 * deciding half above stays pure and can be tested against every refusal.
 *
 * A file that is not there returns the empty-file refusal rather than throwing: the declared-artifact
 * check has already failed the attempt by the time this could happen, and a controller that threw on
 * a missing file would turn one Job's bad output into a failed reconcile pass.
 */
export function readProposal(jobId: number, k: number, ceiling: number | null): Proposal | { why: string } {
  const file = artifactPaths(jobId, k, [PROPOSAL_ARTIFACT])[PROPOSAL_ARTIFACT];
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { why: `there is no \`${PROPOSAL_ARTIFACT}\` in this attempt's artifact directory` };
  }
  return checkProposal(text, ceiling);
}
