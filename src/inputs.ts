import fs from 'node:fs';
import path from 'node:path';

/**
 * `inputs` — the read side, and the half ADR-008 never had.
 *
 * ADR-008 gave a Job three ways to hand something over. It gave it **one** way to receive anything:
 * `job.brief`, a string authored at file time and composed only with the protocol, the results
 * contract and the artifacts contract (`src/brief.ts`). Everything else a run knows, it goes and
 * finds — in a worktree it was handed whole.
 *
 * `docs/workflow-study.md` §7 is where this stops being symmetry for its own sake. Artic compiles a
 * workflow into steps that declare the artifacts they read *and* write, and its measured gains come
 * from **the read side** — a reported −63% input tokens and +56 percentage points of
 * repeated-execution consistency. The study's conclusion is the one that matters here: declared
 * inputs *"are not primarily for ordering, they are for **context restriction**"*.
 *
 * ## The thing this is deliberately not
 *
 * The obvious source is another Job's output — `--input plan=#42.plan`. **That is `Job.after` with a
 * payload, and `Job.after` was rejected rather than deferred** (study §2, on four independent counts:
 * it is a `Link` table with arity 1; no core Kubernetes object depends on a sibling of its own kind;
 * the Job controller would have to write another Job's status, which `src/controller.ts` forbids
 * itself in writing; and `after: succeeded` gates on a phase this codebase documents as carrying no
 * judgement). So no source here waits for anything. Both of them read state that is already there,
 * which is the same discipline the controller itself runs on.
 *
 * ## Why the restriction is real rather than hoped for
 *
 * Injecting context does not restrict anything on its own — a worker with `Read` can still go and
 * find whatever it likes, and the study's own layer table puts prompt text at layer 6, *"guarantees
 * nothing; measured guaranteeing nothing twice"*. What makes this the read side and not a
 * convenience is that it **composes with a guard that can refuse**: a Job declared with its inputs
 * and `--allow-tool` narrowed to exclude `Read`, `Glob` and `Grep` sees exactly what it was given and
 * cannot reach further, because `src/admission.ts` denies the rest at layer 2 — *"the only layer that
 * held when `permissionMode` did not"*. Neither half is the feature. The pair is.
 */

/** One declared input: a name the prompt labels it with, and where its content comes from. */
/**
 * One declared input, in the shape Kubernetes gives a container's `env`: a `name`, and then either
 * a literal **`value`** or a **`valueFrom`** naming where to fetch one.
 *
 * The first cut of this was `{ name, source: "file:prisma/schema.prisma" }` — structured on the
 * outside and stringly-typed on the inside. It works for three sources and stops working at the
 * first source that needs a *second field*, which is not far off: `board` will want a filter,
 * `file` may want a revision, a secret would need a key. A scheme prefix grows a query language
 * inside a string, hand-parsed, with its own escaping. `valueFrom` being an object is exactly how
 * k8s declined that, and the CLI keeps `--input name=file:path` as sugar over it.
 */
export type InputSpec =
  | { name: string; value: string }
  | { name: string; valueFrom: ValueFrom };

/** Where a value comes from. Exactly one key, the way `valueFrom` holds exactly one `*Ref`. */
export type ValueFrom =
  | { file: { path: string } }
  /** Empty today; a filter is the field it will grow, which is the whole reason it is an object. */
  | { board: Record<string, never> }
  | { jobRef: { field: JobField } };

/**
 * What a Job may read about **itself** — the downward API, and `fieldRef` is the model.
 *
 * A Pod can read `metadata.name`, `metadata.namespace`, `spec.nodeName`, `status.podIP`. A worker
 * could read none of these about itself: it learned its branch from prose in the sandbox contract
 * and nothing else, so a brief wanting the attempt number had to hardcode one, which is wrong on
 * attempt 2.
 *
 * `slot` is the field that earns this. It is the only fact that answers *"which of the concurrent
 * workers am I"* — `id` is unique but unbounded, and a run that needs a port, a display number or a
 * database name needs a small integer bounded by how many runs there can be at once. Kubernetes
 * gives every Pod its own IP and the question does not arise; hkb's workers share one machine.
 *
 * `base` is the field ADR-017 earns. When the pull request left the core, the one fact it took with
 * it was where the review opens — `BaseAdvice.prBase`, computed by the controller and written into
 * prose nobody could reach. A step's content has to be able to say *"open it against your base"* and
 * mean the ref the checkout was actually cut from, which is what this reads: `origin/main`, or
 * `origin/kb-33-1` for a chain step. Content, not core, and the same value either way.
 */
export const JOB_FIELDS = ['id', 'name', 'board', 'attempt', 'slot', 'branch', 'base', 'worktree', 'repo'] as const;
export type JobField = (typeof JOB_FIELDS)[number];

/** What an input actually resolved to, for the prompt and for the Attempt's catalogue. */
export type ResolvedInput = { name: string; source: string; text: string };

export type ResolvedInputs = {
  resolved: ResolvedInput[];
  /** Declared and unresolvable. These fail the attempt BEFORE the run — see `src/controller.ts`. */
  missing: { name: string; source: string; why: string }[];
};

/**
 * The cap, per input, in bytes.
 *
 * Larger than a result's 4 KB because this is a whole file rather than a value, and much smaller
 * than no cap at all because **an input is paid for on every request of the run**, not once: it sits
 * in the prompt, and compaction is what happens to prompts that do not fit. A cap that let a Job
 * inject a megabyte would spend the budget the feature exists to save.
 */
export const INPUT_MAX_BYTES = 64 * 1024;

/** How many Jobs a `board` input describes. A ceiling on rows as well as bytes, so the shape of the
 * rendering does not depend on how busy the board happens to be. */
export const BOARD_INPUT_ROWS = 50;

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** One line naming where an input came from — the prompt label, `hkb show`, and the catalogue. */
export function describeSource(spec: InputSpec): string {
  if ('value' in spec) return 'value';
  const vf = spec.valueFrom;
  if ('file' in vf) return `file:${vf.file.path}`;
  if ('jobRef' in vf) return `self:${vf.jobRef.field}`;
  return 'board';
}

const refusal = (why: string): Error & { exitCode: number } => {
  const e = new Error(
    `${why} An input is \`name=source\`, where source is \`file:<repo-relative-path>\`, \`board\`,`
    + ` \`self:<${JOB_FIELDS.join('|')}>\` or \`value:<literal>\` — as in \`--input schema=file:prisma/schema.prisma\`.`,
  ) as Error & { exitCode: number };
  e.exitCode = 2;
  return e;
};

/**
 * `name=source` from the command line, checked and widened into the union — or a refusal.
 *
 * Checked at file time, before a worktree exists, for the reason every other declaration is: this
 * one names a file the board will read with the operator's authority and put in front of a model, so
 * a source that was never legal must not become state.
 */
export function checkInputSpec(raw: string): InputSpec {
  const text = String(raw ?? '').trim();
  const refuse = (why: string): never => { throw refusal(why); };
  if (!text) refuse('an input is empty.');
  const eq = text.indexOf('=');
  if (eq < 1) refuse(`the input ${JSON.stringify(raw)} has no name — write \`name=source\`.`);
  const name = text.slice(0, eq).trim();
  const source = text.slice(eq + 1).trim();
  if (!NAME.test(name)) {
    refuse(`the input name ${JSON.stringify(name)} is not a plain identifier, so it cannot label a block in the prompt.`);
  }
  if (!source) refuse(`the input \`${name}\` names no source.`);

  if (source === 'board') return { name, valueFrom: { board: {} } };

  if (source.startsWith('self:')) {
    const field = source.slice(5).trim() as JobField;
    if (!(JOB_FIELDS as readonly string[]).includes(field)) {
      refuse(`the input \`${name}\` reads \`self:${field}\`, which is not a field a Job has. Fields: ${JOB_FIELDS.join(', ')}.`);
    }
    return { name, valueFrom: { jobRef: { field } } };
  }

  // A literal, supplied by whoever filed the Job rather than fetched by the board. This is the
  // **push** half, and without it the fetched sources only cover what hkb can go and find: a caller
  // with a payload — a webhook, a button, a controller applying a proposal — had nowhere to put it
  // but string-formatted into the brief.
  if (source.startsWith('value:')) {
    const body = source.slice(6);
    if (!body.trim()) refuse(`the input \`${name}\` is \`value:\` with nothing after it.`);
    if (Buffer.byteLength(body) > INPUT_MAX_BYTES) {
      refuse(`the input \`${name}\` is ${Buffer.byteLength(body)} bytes, over the ${INPUT_MAX_BYTES}-byte input cap.`);
    }
    return { name, value: body };
  }

  if (source.startsWith('file:')) {
    checkInputPath(source.slice(5), refuse);
    return { name, valueFrom: { file: { path: normalizeInputPath(source.slice(5)) } } };
  }

  // Named explicitly rather than falling through to "unknown source", because the source everyone
  // reaches for first is the one that does not exist and is not going to.
  if (/^#?\d+\./.test(source) || source.startsWith('job:') || source.startsWith('result:')) {
    refuse(
      `the input \`${name}\` reads another Job's output, and hkb has no such source. An input that waits for a`
      + ' sibling Job is an ordering edge, and ordering between workloads belongs to a kind whose controller'
      + ' creates them (ADR-007 decision 5) — it was rejected as a field, not deferred.'
      + ' `self:<field>` reads this Job, which is a different thing and is allowed.',
    );
  }
  return refuse(`the input \`${name}\` names the unknown source ${JSON.stringify(source)}.`);
}

/** Repo-relative, and none of the three ways out. The same fence `checkExportPath` puts on a path. */
function checkInputPath(rel: string, refuse: (why: string) => never): void {
  const p = String(rel ?? '').trim();
  if (!p) refuse('a `file:` input names no path.');
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) {
    refuse(`the input path ${JSON.stringify(p)} is absolute. An input is read relative to the board's repository.`);
  }
  const norm = path.normalize(p).replace(/[\\/]+$/, '');
  if (!norm || norm === '.') refuse(`the input path ${JSON.stringify(p)} names the whole repository rather than a file.`);
  if (/^\.\.([\\/]|$)/.test(norm)) {
    refuse(`the input path ${JSON.stringify(p)} escapes the repository — a declaration is not a licence to read anywhere.`);
  }
  if (norm === '.hkb' || norm.startsWith(`.hkb${path.sep}`)) {
    refuse(`the input path ${JSON.stringify(p)} is inside .hkb/ — the board's own directory, which is not a Job's to read.`);
  }
}

const normalizeInputPath = (rel: string): string =>
  path.normalize(String(rel).trim()).replace(/[\\/]+$/, '').split(path.sep).join('/');

/**
 * The specs a Job declared, off the `Json?` column — validated, never trusted.
 *
 * Hand-written rather than schema-validated, and that is a judgement worth stating: `zod` is in the
 * tree but only transitively (the Agent SDK pulls it), so using it means **declaring** a 7.9 MB
 * dependency, which this project's rules say needs a reason in a decision record and a showing that
 * it replaces more code than it adds. It would replace the twenty lines below and none of the
 * refusal messages above, which are the part that took the work — and `declaredResults`,
 * `declaredArtifacts` and `pluginList` are all already this shape. Consistency and no new dependency
 * beat twenty lines.
 */
export function declaredInputs(value: unknown): InputSpec[] {
  if (!Array.isArray(value)) return [];
  const out: InputSpec[] = [];
  for (const v of value) {
    // The CLI's own string form, so a hand-written row stays usable. Anything it refuses is skipped
    // rather than thrown: one malformed row is not a reason to fail somebody else's attempt.
    if (typeof v === 'string') { try { out.push(checkInputSpec(v)); } catch { /* not ours to fail on */ } continue; }
    if (!v || typeof v !== 'object') continue;
    const row = v as { name?: unknown; value?: unknown; valueFrom?: unknown; source?: unknown };
    if (typeof row.name !== 'string' || !NAME.test(row.name)) continue;
    if (typeof row.value === 'string') { out.push({ name: row.name, value: row.value }); continue; }
    // The pre-union shape, so a board written by the previous build still reads. One line, and it
    // costs less than a migration over a column nothing outside this file interprets.
    if (typeof row.source === 'string') {
      try { out.push(checkInputSpec(`${row.name}=${row.source}`)); } catch { /* skip */ }
      continue;
    }
    const vf = row.valueFrom;
    if (!vf || typeof vf !== 'object') continue;
    const f = vf as { file?: unknown; board?: unknown; jobRef?: unknown };
    if (f.file && typeof f.file === 'object' && typeof (f.file as { path?: unknown }).path === 'string') {
      out.push({ name: row.name, valueFrom: { file: { path: (f.file as { path: string }).path } } });
    } else if (f.board && typeof f.board === 'object') {
      out.push({ name: row.name, valueFrom: { board: {} } });
    } else if (f.jobRef && typeof f.jobRef === 'object'
      && (JOB_FIELDS as readonly string[]).includes(String((f.jobRef as { field?: unknown }).field))) {
      out.push({ name: row.name, valueFrom: { jobRef: { field: (f.jobRef as { field: JobField }).field } } });
    }
  }
  return out;
}

/**
 * One Job, as a `board` input sees it. Deliberately the fields `hkb ls` already computes.
 *
 * This is ADR-010 decision 5's *"board arithmetic"* — which Jobs have sat pending, which succeeded
 * and produced nothing, which keep capping on budget. **LLM-free, and one board read**, which is
 * what lets a Job reason about the board without a second model deciding what the board says.
 */
export type BoardRow = {
  id: number;
  name: string;
  phase: string;
  attempts: number;
  lastOutcome: string | null;
  producedNothing: boolean;
};

/**
 * Render the board as a table a model can read and a human can check.
 *
 * Pure, so the projection is testable without a database — the same reason `pickPr` and `gateClaim`
 * are pure. A rendering that drifts from what `hkb ls` shows is a rendering nobody can verify.
 */
export function renderBoard(rows: BoardRow[]): string {
  if (!rows.length) return 'This board has no other Jobs.';
  const shown = rows.slice(0, BOARD_INPUT_ROWS);
  const w = Math.max(...shown.map((r) => r.phase.length));
  const lines = shown.map((r) =>
    `#${String(r.id).padEnd(5)} ${r.phase.padEnd(w)} ${String(r.attempts).padStart(2)}x  ${r.name}`
    + (r.lastOutcome ? `  [${r.lastOutcome}]` : '')
    + (r.producedNothing ? '  — produced nothing' : ''));
  // Said, not silently dropped: a truncated list a reader believes is complete is worse than a short
  // one that says so, and this one is being handed to something that cannot go and check.
  if (rows.length > shown.length) lines.push(`… and ${rows.length - shown.length} more, not shown.`);
  return lines.join('\n');
}

/**
 * Read one `file:` input, or say why not.
 *
 * The realpath containment check is the half a syntax rule cannot make, and it is the same question
 * `refuseOutside` asks of an export: a repository can contain a symlink, and `docs/notes -> /etc`
 * passes every string test above.
 */
export function readFileInput(repoPath: string, rel: string): { text: string } | { why: string } {
  const found = resolveInRepo(repoPath, rel);
  if ('why' in found) return found;
  if (found.bytes > INPUT_MAX_BYTES) {
    return { why: `${rel} is ${found.bytes} bytes, over the ${INPUT_MAX_BYTES}-byte input cap — an input is paid for on every request of the run, so this one belongs in the worktree the run can read` };
  }
  return { text: fs.readFileSync(found.path, 'utf8') };
}

/**
 * Find a file inside the board's repository, or say why not. **The containment check, without a
 * size rule** — because the rule differs by what the file is for, and so does the advice that comes
 * with breaking it: an oversized input belongs in the worktree, an oversized guide belongs shorter.
 * Sharing the cap along with the fence made a guide inherit both the input's number and its counsel
 * (`src/guide.ts`).
 */
export function resolveInRepo(repoPath: string, rel: string): { path: string; bytes: number } | { why: string } {
  let root: string;
  try {
    root = fs.realpathSync(repoPath);
  } catch {
    return { why: `the board's repository ${repoPath} is not there` };
  }
  const abs = path.resolve(root, rel);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    return { why: `no such file in the repository: ${rel}` };
  }
  if (!real.startsWith(root + path.sep)) return { why: `${rel} resolves outside the repository` };
  const st = fs.statSync(real);
  if (!st.isFile()) return { why: `${rel} is not a file` };
  return { path: real, bytes: st.size };
}

/**
 * Render `{{name}}` and `{{name.path}}` in a brief from the Job's `value:` inputs.
 *
 * **Only `value:` inputs, and that is the whole of the trust design.** A brief is the one thing in a
 * Job that carries *authority* — ADR-010 decision 4 turns on an approver's instruction BECOMING the
 * prompt — while `withInputs` tells the worker in as many words to treat inputs as data. If a
 * `file:` source could interpolate, a file in the repository would decide what the agent is
 * instructed to do, which is the concern ADR-011 and ADR-012 are both about. Kubernetes draws the
 * same line for the same reason: `envFrom: configMapRef` deliberately cannot set `command`.
 *
 * A `value:` is different because **the filer supplied it and the filer wrote the placeholder**.
 * The residual risk is real and bounded — a caller's payload reaching the instruction position — and
 * it is per-placeholder and visible in the brief, rather than ambient.
 *
 * Rendered at FILE time, not run time, so the brief stored on the Job is the brief that runs and
 * `hkb show` cannot disagree with the prompt. An unknown placeholder is refused here, where the
 * operator is standing, rather than discovered by a worker.
 */
export function renderBrief(
  brief: string,
  values: Map<string, string>,
  declared: Set<string> = new Set(values.keys()),
): { text: string; used: Set<string> } {
  const used = new Set<string>();
  // Untouched unless the Job declares inputs AT ALL. Every brief written before this existed, and
  // every brief that legitimately talks about `{{ }}`, is unaffected — an opt-in that costs the
  // author nothing to not use.
  //
  // Gated on `declared` rather than on `values`, and that distinction is a bug this had: a Job whose
  // only inputs are `file:` would have skipped rendering entirely, so `{{schema}}` meant as an
  // interpolation would have reached the worker as the literal text `{{schema}}`. Silence is the one
  // answer that is always wrong here — the author has to be told which sources may interpolate.
  if (!declared.size) return { text: brief, used };

  const text = brief.replace(/\{\{\s*([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g, (whole, name: string, dotted: string) => {
    if (!values.has(name)) {
      // Two different mistakes, and an operator can only fix the one they made. `{{schema}}` where
      // `schema` is a `file:` input is a misunderstanding of the trust rule; `{{shcema}}` is a typo.
      const why = declared.has(name)
        ? `the input \`${name}\` is not a \`value:\` — only \`value:\` inputs interpolate, because the brief is`
          + ' instruction and a fetched source reaches the run as data.'
        : `this Job declares no \`value:\` input called \`${name}\`.`
          + ` Values declared: ${[...values.keys()].map((k) => `\`${k}\``).join(', ') || '(none)'}.`
          + ' Only `value:` inputs interpolate — a `file:` or `board:` input reaches the run as data, never as instruction.';
      const e = new Error(`the brief refers to \`${whole}\` and ${why}`) as Error & { exitCode: number };
      e.exitCode = 2;
      throw e;
    }
    used.add(name);
    const raw = values.get(name) as string;
    if (!dotted) return raw;
    // A dotted path only means something over JSON. A plain string with `{{a.b}}` asked for a field
    // of something that has no fields, and saying so beats rendering `undefined` into an instruction.
    let cur: unknown;
    try {
      cur = JSON.parse(raw);
    } catch {
      const e = new Error(
        `the brief refers to \`${whole}\`, but the input \`${name}\` is not JSON, so it has no field to read.`,
      ) as Error & { exitCode: number };
      e.exitCode = 2;
      throw e;
    }
    for (const key of dotted.slice(1).split('.')) {
      if (cur === null || typeof cur !== 'object' || !(key in (cur as Record<string, unknown>))) {
        const e = new Error(
          `the brief refers to \`${whole}\`, and the input \`${name}\` has no \`${key}\`.`,
        ) as Error & { exitCode: number };
        e.exitCode = 2;
        throw e;
      }
      cur = (cur as Record<string, unknown>)[key];
    }
    return typeof cur === 'string' ? cur : JSON.stringify(cur);
  });
  return { text, used };
}

/** What a Job that declared an input the board could not resolve owes the operator. */
export function missingInputs(id: number, missing: { name: string; why: string }[]): string | null {
  if (!missing.length) return null;
  const one = missing.length === 1;
  return `#${id} declared ${one ? 'an input' : 'inputs'} the board could not read — `
    + missing.map((m) => `\`${m.name}\`: ${m.why}`).join('; ')
    + `. The attempt did not start: a run given less than it declared is not the run that was filed.`;
}
