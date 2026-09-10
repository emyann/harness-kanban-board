/**
 * `labels` — the grouping key hkb had none of.
 *
 * Kubernetes composes almost entirely through labels: a Deployment finds its Pods, a Service finds
 * its endpoints and an operator finds "everything belonging to this release" through one mechanism —
 * a map of key/value pairs on the object, and a selector over it. hkb had no such mechanism, so
 * *"the Jobs of this workflow"*, *"everything touching the parser"* and *"all my security triage"*
 * were questions the board could not be asked. The nearest thing was
 * `Job(proposedByJobId, proposedByK, proposalIndex)` (`prisma/schema.prisma`) — a hand-rolled owner
 * reference for exactly one case, which groups the Jobs one attempt proposed and nothing else.
 *
 * ## A map, not a list of tags
 *
 * `workflow=release` **and** `step=draft` is the thing that gets wanted, and a flat list cannot say
 * it without inventing a separator inside the tag — at which point the separator is a schema nobody
 * wrote down, and `workflow:release` sorts, prints and matches as one opaque token. So the column is
 * a string→string map, exactly as k8s stores it.
 *
 * ## The selector language is equality, on purpose
 *
 * k8s has `!=`, `in`, `notin`, `exists` and set-based selectors on top of them, and every one of
 * those is a query language to parse, to document, to keep two consumers agreeing on, and to keep
 * working when the store underneath changes. Equality answers the questions above — which is the
 * whole of what was asked for — and it composes: several `--label` requirements are ANDed, the way
 * a k8s equality selector's comma-separated requirements are. Anything richer is a decision of its
 * own, and it can be taken when a question arrives that equality genuinely cannot answer.
 *
 * The other half of that restraint is elsewhere and matters more: **nothing in the controller reads
 * a label.** A selector that scheduled, cascaded or owned would be a second dependency mechanism
 * beside the one ADR-007 deliberately does not have yet.
 */

/**
 * A key and a value are each a **plain token**: a letter or digit at each end, and letters, digits,
 * `-`, `_` and `.` in between, up to 63 characters.
 *
 * That is Kubernetes' own label rule minus the optional DNS prefix on a key, and the shape is
 * chosen for what it refuses rather than what it admits. `=` cannot appear, so `key=value` parses
 * on its first `=` with no escaping and no ambiguity. Whitespace and `,` cannot appear, so a label
 * survives being printed in a one-line listing and read back. A leading or trailing `-`, `_` or `.`
 * cannot appear, so `env=` and `-workflow=x` are typos that get a message instead of becoming a
 * group nobody can see. 63 is k8s' number and it is generous for something a person types.
 *
 * The empty value that k8s permits is refused here: `--label env=` on a command line is a shell
 * variable that did not expand far more often than it is a deliberate marker, and the fix for
 * wanting "just a tag" is to say what it is — `kind=triage` rather than `triage=`.
 */
export const LABEL_TOKEN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,61}[A-Za-z0-9])?$/;

/**
 * How many labels one Job may carry.
 *
 * Not a storage limit — the column is JSON and would hold hundreds. It is the line between a
 * grouping and a payload: a Job carrying forty labels is using the map to store *values*, and
 * `results` is the column for values, capped at 4 KB for the same reason (`src/results.ts`). A cap
 * that refuses at file time is the cheapest way to say so.
 */
export const MAX_LABELS = 16;

function refuse(why: string): never {
  const e = new Error(
    `${why} A label is \`key=value\`, and a key and a value are each a plain token — letters, digits,`
    + ' dash, underscore and dot between them, up to 63 characters — as in `--label workflow=release`.',
  ) as Error & { exitCode: number };
  e.exitCode = 2;
  throw e;
}

/**
 * One `key=value`, checked.
 *
 * Refuses by name, at file time, before anything is created — the same fence `checkResultName` and
 * `checkArtifactName` sit behind, and for the same reason: an illegal request should never become
 * state, and finding it here costs nothing while finding it later costs a run.
 */
export function checkLabel(raw: string): { key: string; value: string } {
  const text = String(raw ?? '').trim();
  if (!text) refuse('a label is empty.');
  const eq = text.indexOf('=');
  if (eq === -1) refuse(`the label ${JSON.stringify(raw)} has no \`=\` in it, so it names no value.`);
  const key = text.slice(0, eq).trim();
  const value = text.slice(eq + 1).trim();
  if (!key) refuse(`the label ${JSON.stringify(raw)} has no key.`);
  if (!value) refuse(`the label \`${key}\` has no value.`);
  if (!LABEL_TOKEN.test(key)) refuse(`the label key ${JSON.stringify(key)} is not a plain token.`);
  if (!LABEL_TOKEN.test(value)) refuse(`the value ${JSON.stringify(value)} of the label \`${key}\` is not a plain token.`);
  return { key, value };
}

/**
 * Several `key=value` arguments, as a map.
 *
 * A repeated key is **refused** rather than resolved last-one-wins: both values are something the
 * operator meant and picking one silently is how a Job ends up in a group nobody chose — the same
 * argument a workflow's repeated frontmatter key gets (`src/templates.ts`). It holds for a selector
 * too, where a repeated key is worse: the requirements are ANDed, so `--label a=1 --label a=2` is a
 * question with no possible answer, and returning an empty list would read as *"nothing matches"*.
 */
export function parseLabels(raws: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of raws) {
    const { key, value } = checkLabel(raw);
    if (key in out) {
      if (out[key] === value) continue;
      refuse(`the label \`${key}\` is given twice, as \`${out[key]}\` and \`${value}\`, and a label has one value.`);
    }
    out[key] = value;
  }
  if (Object.keys(out).length > MAX_LABELS) {
    refuse(`that is ${Object.keys(out).length} labels, over the cap of ${MAX_LABELS} — a label groups a Job, it does not carry its data.`);
  }
  return out;
}

/**
 * The labels on a Job, read back out of its `Json?` column.
 *
 * Defensive in the same way `toolList` and `declaredResults` are (`src/spec.ts`, `src/results.ts`):
 * anything that is not a flat string→string object reads as *no labels*, because a malformed column
 * must not make a selector throw in the middle of a listing. Entries are filtered rather than the
 * whole map dropped, so one bad pair cannot hide the good ones.
 */
export function jobLabels(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && LABEL_TOKEN.test(k) && LABEL_TOKEN.test(v)) out[k] = v;
  }
  return out;
}

/**
 * Does a Job's labels satisfy every requirement in the selector?
 *
 * Equality, ANDed, and an empty selector matches everything — the k8s rule, and the one that makes
 * `hkb ls` with no `--label` the same command it always was. Pure, so the case that matters (the
 * refusal to match) is testable without a board.
 *
 * The filtering happens in this process rather than in the query, and that is a property of the
 * store rather than a preference: Prisma's JSON path filters are PostgreSQL and MySQL only, so
 * SQLite cannot ask the question in SQL. `hkb ls` already reads its board in one query and shapes
 * the rows in memory, so the selector is a `filter` over a read that was happening anyway.
 */
export function selects(labels: Record<string, string>, selector: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(selector)) if (labels[k] !== v) return false;
  return true;
}

/** `a=1, b=2`, key-sorted, for a human line. Sorted so two Jobs with the same labels print alike. */
export function describeLabels(labels: Record<string, string>): string {
  return Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(', ');
}
