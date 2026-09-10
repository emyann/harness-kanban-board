import type { openBoard } from './db.ts';
import { checkExportPath, checkRef } from './worktree.ts';
import { checkResultName } from './results.ts';
import { checkArtifactName } from './artifacts.ts';
import { parseLabels } from './labels.ts';
import { checkPluginPath } from './plugins.ts';
import { checkInputSpec, renderBrief, type InputSpec } from './inputs.ts';
import { readTemplate, placeholders, type Template } from './templates.ts';
import { EFFORTS, resolveSpec, jsonCheck } from './spec.ts';
import { checkFlag, given, givenList, num, seconds, usage, type Flagged } from './flags.ts';

/**
 * Filing a Job — the other half of ADR-015's failing test.
 *
 * `src/transitions.ts` moved every human-driven *phase change* out of `switch (verb)`; its own
 * docstring names what was left behind, and ADR-015's postscript says it out loud: *"what still
 * fails the test above is **creating** a Job: `hkb new` holds `db.job.create` inside the switch
 * behind ~190 lines of argument parsing."* This is that. Nothing here is new behaviour — the
 * refusals, their exact wording, the precedence rules, the event and the printed shape are the ones
 * the verb already had, and `hkb new` is now parse → `createJob` → print.
 *
 * ## The input is a flag-shaped record, and that is deliberate
 *
 * `spec` is keyed by **`hkb new`'s flags without the dashes** — `max-budget`, `allow-tool`,
 * `plugin-dir`. That is not the CLI leaking through; it is the vocabulary this project already
 * committed to three times over. A workflow file's frontmatter keys are those names
 * (`src/templates.ts`), `hkb job set` takes the same ones (`src/job-spec.ts`), and `hkb --help`
 * documents all of them at once and so cannot drift from any.
 *
 * It also has a load-bearing consequence for the one rule below that is easy to get wrong. A
 * workflow fills what the caller did not say, and the fill happens **before** any value is
 * converted — so a `max-budget` from a file and a `--max-budget` from a line go through the same
 * parse, the same refusal and the same message. Converting first and merging after would be two
 * code paths for one vocabulary, which is exactly how a workflow ends up accepting something no
 * operator could type.
 *
 * A second consumer therefore posts `{ name, brief, 'max-budget': '2' }` — the same object a
 * workflow is, which is the same object a command line is.
 *
 * ## What stayed in the CLI
 *
 * Reading argv, and reading a brief off stdin. `--brief -` blocks until EOF, so the brief arrives
 * here as a **producer** and is called at the one point that knows the guards have passed — the
 * shape and the reason `queueJob` and `setJobSpec` already use.
 */

type Db = ReturnType<typeof openBoard>;

/** Which board a Job is filed on, and the repository a workflow is read from. */
export type FilingScope = { slug: string; repoPath: string | null };

/**
 * The brief, as a string or as a **producer** of one.
 *
 * A producer because reading one can block: `hkb new --brief -` waits for EOF on stdin, and reading
 * it before the workflow has been found turns a `--from` typo from an instant refusal into a
 * process that never returns. It is called below, after the refusals that cost nothing.
 */
export type Brief = string | (() => Promise<string>);

/**
 * What `hkb new` is given, under the names it takes them by.
 *
 * `unknown` per value rather than a typed field per flag, because that is what honestly arrives:
 * `parseArgs` with `strict: false` yields `string | boolean | array`, a workflow yields
 * `string | string[] | boolean`, and the whole job of the converters below is to turn one of those
 * into the value the flag means, or to refuse by name. A field typed `number` here would be a claim
 * nobody had checked yet.
 */
export type FilingSpec = Record<string, Flagged | Brief>;

/**
 * Exactly what `hkb new --json` prints. A second consumer that renders this renders what the CLI
 * renders, which is the property ADR-015 is asking for.
 */
export type FiledRow = {
  id: number;
  name: string;
  phase: string;
  board: string;
  exports: string[];
  results: string[];
  artifacts: string[];
  inputs: InputSpec[];
  labels: Record<string, string>;
  proposes: string | null;
  check: { value: string | null; source: string };
  from: string | null;
  standingSteps: string | null;
};

/**
 * The filing, and the two workflows that shaped it.
 *
 * `row` is the printed shape and the templates are beside it rather than inside it, because a
 * caller printing for a human wants the workflow's one-line `description` and `--json` has never
 * carried it. Widening the row to hold them would change a published shape to save a field.
 */
export type Filed = {
  row: FiledRow;
  /** `--from`: the workflow this Job IS. Null when it was filed by hand. */
  from: Template | null;
  /** The board's default workflow, whose body a worker is given on top of the brief (ADR-017). */
  standingSteps: Template | null;
};

/**
 * File a Job.
 *
 * The order of what follows is itself a decision and is unchanged: a workflow is read before
 * anything is created, the fills happen before anything is converted, every declaration is checked
 * before the row exists, and the Event is written with the row.
 */
export async function createJob(
  db: Db,
  scope: FilingScope,
  spec: FilingSpec,
  opts: { by: string },
): Promise<Filed> {
  // A copy, because the fills below write into it. A caller's object is theirs.
  const values: Record<string, unknown> = { ...spec };
  const { slug } = scope;

  // A workflow is read BEFORE anything else happens — before the board is upserted, before a
  // name is settled — because a `--from` that is not there must fail naming the path it looked
  // for, with nothing created. It resolves against the board's REPOSITORY, never the cwd and
  // never a worktree: the same fence as a guide and a plugin grant (`src/templates.ts`).
  const tpl = values.from !== undefined ? readTemplate(scope.repoPath, given(values.from, '--from')) : null;
  // The BOARD's default workflow — how work on this board finishes (ADR-017 decision 1).
  //
  // Only when nobody said `--from`. With one, that workflow governs entirely: composing the two
  // would mean a workflow author could not write a step that finishes differently from the
  // board, and "the more specific thing wins" is the precedence rule everywhere else here.
  //
  // Not for a `--propose` Job either, and for the reason `withWorktree` exists in
  // `src/brief.ts`: a proposing Job's whole output is one JSON file, so a brief that also ends
  // in "commit it and open a pull request" is not an instruction a worker can follow. Measured
  // once already, on the protocol this replaces.
  //
  // Read from the BOARD row rather than from `scope`, because the row is where the default is,
  // and the board may not exist yet — filing the first Job in a repository creates it, and a
  // board that does not exist has no default to apply.
  let dflt: Template | null = null;
  if (!tpl && !values.propose && !values['no-isolate']) {
    const known = await db.board.findUnique({ where: { slug }, select: { defaultWorkflow: true } });
    const wanted = known?.defaultWorkflow?.trim();
    if (wanted) {
      // Refused HERE, by name, with nothing created — the same rule `--from` follows. A board
      // pointing at a workflow that is not in the repository is a mistake the operator can fix
      // in one command, and discovering it at claim time would mean a Job that is missing the
      // steps everything else on the board got.
      try {
        dflt = readTemplate(scope.repoPath, wanted);
      } catch (e) {
        throw usage(
          `board ${slug} files every Job with the workflow \`${wanted}\`, and ${(e as Error).message}`
          + ` Add the file, or point the board somewhere else: \`hkb boards set ${slug} --workflow <name>|none\`.`,
        );
      }
      // A default workflow's body is appended to somebody else's brief, so there is nothing for
      // a placeholder to be filled from — `--input` on the line belongs to the Job's own brief.
      // Refused rather than passed through, because the literal text `{{page}}` in a worker's
      // instructions is the one outcome nobody would have chosen.
      const want = placeholders(dflt.brief);
      if (want.length) {
        throw usage(
          `the workflow \`${dflt.name}\` is board ${slug}'s default, and its body refers to `
          + `${want.map((n) => `\`{{${n}}}\``).join(', ')} — standing steps are appended to every brief filed here, `
          + 'so there is nothing to fill them from. Write the steps without placeholders, or use it with '
          + `\`hkb new --from ${dflt.name}\`, where the Job can declare the inputs.`,
        );
      }
    }
  }
  // Whether the caller SAID `check`, read before the workflow fills the gaps below — after
  // the fill, `values.check` no longer says which of the two it came from.
  const checkTyped = values.check !== undefined;
  if (tpl) {
    // The whole precedence rule, and it is `src/spec.ts`'s grain: **the more specific value
    // wins**, so a flag the operator typed outranks the file. Written as "fill what is absent"
    // rather than as a merge, so a list flag REPLACES the workflow's list instead of appending
    // to it — a `--allow-tool` that could only widen a workflow's surface would be a grant
    // nobody could narrow.
    for (const [k, v] of Object.entries(tpl.spec)) {
      if (values[k] === undefined) values[k] = v;
    }
  }
  // The board's default fills the same gaps the same way — the line wins, then the file, then
  // the board's own `default*` columns, which `src/spec.ts` resolves later against whatever is
  // still null. Only the BODY composes differently (see `withStandingSteps`); the spec half is
  // `--from`'s rule exactly, because a default that could not be overridden on the line would be
  // a ceiling, and a ceiling is a different kind of fact.
  if (dflt) {
    for (const [k, v] of Object.entries(dflt.spec)) {
      if (values[k] === undefined) values[k] = v;
    }
  }
  // A workflow names itself, so `hkb new --from draft-wiki-page` is a whole command. A name
  // typed on the line still wins — it is the more specific value, exactly as a flag is.
  const name = (typeof values.name === 'string' ? values.name.trim() : '') || tpl?.name || '';
  if (!name) throw usage('hkb new <name> — a Job needs a name');
  // A triage item is a note, and a note that demanded a brief would not get written down. The
  // name IS the brief until somebody decides what the work is, which is what `hkb queue` is for.
  const triage = !!values.triage;
  const wrote = values.brief as Brief | undefined;
  const wroteBrief = wrote !== undefined;
  // The workflow's body is the brief; a supplied one still overrides it, on the same rule as every
  // other key. Ordered before the triage fallback so `--from` on a triage item is still briefed.
  // The producer is called HERE and nowhere earlier: everything above can refuse without reading a
  // byte of stdin.
  const brief = tpl && !wroteBrief ? tpl.brief
    : triage && !wroteBrief ? name
    : typeof wrote === 'function' ? await wrote()
    : typeof wrote === 'string' ? wrote
    : throwNoBrief();
  const board = await db.board.upsert({
    where: { slug },
    update: {},
    // A board created by filing work in a repository is pointed at that repository. Without it
    // a machine-level daemon would have nowhere to cut the worktree.
    create: { slug, repoPath: scope.repoPath },
  });
  // Every one of these goes through `given`/`givenList` rather than a cast, and that is the
  // whole of closing the bare-flag idiom: a bare `--model` was stored as the boolean `true` and
  // a bare `--export` as the path `true`, because `parseArgs` under `strict: false` makes a
  // valueless option a boolean and a valueless REPEATABLE one a `[true]`. One flag at a time was
  // how this got fixed for `--check` and missed everywhere else.
  const model = values.model !== undefined ? (given(values.model, '--model') || null) : null;
  const effort = values.effort !== undefined ? given(values.effort, '--effort') : undefined;
  if (effort && !(EFFORTS as readonly string[]).includes(effort)) {
    throw usage(`--effort must be one of ${EFFORTS.join('|')}, got ${effort}`);
  }
  // Checked here, at admission, rather than when the copy runs: an export path that escapes the
  // worktree is an illegal request, and an illegal request should never become state. The same
  // check runs again at copy time, because a row can arrive by other routes than this one.
  const exports = givenList(values.export, '--export').map(checkExportPath);
  // Checked at file time, before a worktree exists — a name that cannot be a filename or a JSON
  // key is a fault in the spec, and finding it here costs nothing while finding it later costs
  // a run.
  const results = givenList(values.result, '--result').map(checkResultName);
  // Same reasoning one medium over: a name that cannot be a single path segment is a fault in
  // the spec, and finding it here costs nothing while finding it after a run costs the run.
  const artifacts = givenList(values.artifact, '--artifact').map(checkArtifactName);
  // The same fence again, for the same reason: a label that is not `key=value` in plain tokens
  // is a fault in the spec, and a Job filed under a group nobody can name or select is worse
  // than a refusal — it is a Job that is quietly not in the group its filer thinks it is in.
  const labels = parseLabels(givenList(values.label, '--label'));
  // Checked at file time for the same reason an export path is: a grant is resolved into an
  // absolute path with no agent in the loop, so a path that was never legal must not become
  // state. Null when the flag was absent, so the board's grant can answer; an EMPTY list is
  // only reachable through `--plugin-dir ""` and means "grant this Job nothing".
  const pluginPaths = values['plugin-dir'] !== undefined
    ? givenList(values['plugin-dir'], '--plugin-dir').filter(Boolean).map(checkPluginPath)
    : null;
  // Checked at file time like every other declaration, and for the sharpest version of the same
  // reason: this one names a file the BOARD will read with the operator's authority and put in
  // front of a model. A source that was never legal must not become state.
  let inputs = givenList(values.input, '--input').map(checkInputSpec);
  // A workflow's placeholders, asked about here because `renderBrief` deliberately will not.
  // Interpolation is opt-in — a Job that declares no input is left alone, so that a brief written
  // before the feature existed still means what it says — and that opt-in is exactly wrong for a
  // workflow, whose author opted in by writing `{{page}}`. Without this the Job would be filed
  // with the literal text in its instructions and nothing would ever say so.
  if (tpl && !inputs.length) {
    const want = placeholders(brief);
    if (want.length) {
      throw usage(
        `the workflow \`${tpl.name}\` needs ${want.map((n) => `\`{{${n}}}\``).join(', ')}, and this Job declares no inputs`
        + ` — pass ${want.map((n) => `--input ${n}=value:…`).join(' ')}. Only \`value:\` inputs interpolate, because the`
        + ' brief is instruction and a fetched source reaches the run as data.',
      );
    }
  }
  // The brief is rendered HERE, against the `value:` inputs only, so what the board stores is
  // what the run is given — `hkb show` and the prompt cannot disagree. It applies to whichever
  // way the brief arrived: `--brief`, `--brief-file` or stdin all land in one string above.
  const supplied = new Map(
    inputs.filter((i): i is { name: string; value: string } => 'value' in i).map((i) => [i.name, i.value]),
  );
  const rendered = renderBrief(brief, supplied, new Set(inputs.map((i) => i.name)));
  // A value that went into the brief does not also arrive as a data block. Dropping it here
  // rather than remembering it keeps the run path with one rule: everything in `inputs` is
  // rendered, and nothing is rendered twice.
  inputs = inputs.filter((i) => !rendered.used.has(i.name));
  // The standing steps are NOT composed here, and that is the correction ADR-017's review forced.
  // What the board's default workflow contributes at file time is its FRONTMATTER — the spec
  // fields filled above — and nothing else. Its body reaches the worker at claim time, from the
  // board as it is then (`src/controller.ts`), for three reasons this cannot fix on its own:
  // `hkb queue <id> "…"` replaces a brief wholesale and would drop steps baked into it,
  // a `--no-isolate` Job has no branch for them to talk about, and they belong AFTER the sandbox
  // contract rather than before it. The refusals above still run here, where the operator is
  // standing: a board pointing at a workflow that is not in the repository is worth catching
  // before the Job exists, not on the pass that would have run it.
  const briefText = rendered.text;
  // A repo-relative path, checked at file time like every other declaration and for the same
  // reason as an input's: it names a file the BOARD will read with the operator's authority and
  // put in front of a model, so a path that was never legal must not become state. Undefined
  // when the flag is absent, so the board's grant answers.
  const guide = values.guide !== undefined ? (given(values.guide, '--guide') || null) : undefined;
  if (guide) checkExportPath(guide);
  // The completion check, stored verbatim. NOT validated beyond the two shapes that could never
  // have been meant, and that is the whole design: the controller reads 0 / not-0 and knows
  // nothing about what the command does (ADR-016 §3), so anything else hkb refused here would be
  // hkb having an opinion about a shell line it does not run and cannot parse. Undefined when
  // the flag is absent, so the board's default answers.
  const check = values.check !== undefined ? checkFlag(values.check) : undefined;
  let gate = values.gate !== undefined ? given(values.gate, '--gate') : undefined;
  // A PROPOSING Job has nothing to check. It changes nothing in the tree — its whole output is
  // `proposal.json`, read by the controller and applied only after a person approves it — so
  // there is no behaviour for a command to judge and no state for it to judge in. Worse than
  // useless: a failed check outranks the gate in `nextPhase`, so a red one (and on a proposing
  // Job every one is red, because the tree is unchanged) sent the Job round the retry loop
  // instead of suspending. Measured at the shipped defaults: three attempts, the same proposal
  // stored three times, and not one Job ever filed. The controller refuses to run it either;
  // this is the half that says so before the money is spent.
  if (values.propose && values.check !== undefined) {
    throw usage(
      'a proposing Job has nothing to check — its output is the proposal, not a change to the '
      + 'tree, so there is nothing for a command to judge. Drop the check '
      + (tpl?.spec.check !== undefined && !checkTyped
        ? `(\`check:\` in workflow ${tpl.name})`
        : '(--check)')
      + ', or drop --propose and file the work itself.',
    );
  }
  if (values.gate !== undefined && !gate) throw usage('--gate needs the question a human is being asked, as in --gate "does this migration look right?"');
  const rawBase = typeof values.base === 'string' ? values.base.trim() : undefined;
  if (values.base !== undefined && !rawBase) throw usage('--base needs the ref to branch from, as in --base origin/kb-33-1 — leave it out for the repository\'s default branch');
  // Checked here rather than only where git is called: a ref reaches git as a bare argv token,
  // so one beginning with a dash is an option (`--upload-pack=…` runs a command). See `validRef`.
  const base = rawBase === undefined ? undefined : checkRef(rawBase, '--base');
  // Two flags that mean opposite things, typed together: --no-isolate runs in the current
  // checkout, so there is no branch to cut from a base and nothing would ever read it. Refused
  // rather than ignored — a spec field that is stored, printed and never honoured is the silent
  // failure this project's fifth value forbids.
  //
  // A base arriving from the BOARD's default is deliberately NOT refused here. It is not a
  // contradiction the filer wrote, and refusing would make one `--no-isolate` Job unfileable on
  // such a board — there is no per-Job clear to escape with, and there cannot easily be one:
  // `pick` in `src/spec.ts` reads a null column as *unset*, so a cleared value falls straight
  // through to the board default again. That gap is shared by every board-defaulted field. What
  // is fixed instead is the visible half: `hkb show` does not present a base to a Job that
  // cannot use one.
  if (base && values['no-isolate']) {
    throw usage('--base and --no-isolate contradict each other: --no-isolate runs in the current checkout, so there is no branch to cut from a base. Drop one.');
  }
  // A proposing Job is a gated Job, and not by convention: ADR-011 applies nothing without an
  // approval, so a proposal with no approver would be a proposal nothing ever reads. The
  // operator's own question wins if they asked one; this is only the default, and the controller
  // replaces it with the count once a proposal has actually been validated.
  const proposes = values.propose ? 'jobs' : null;
  if (proposes && !gate) gate = 'a proposal to review';
  // Null when the flag was absent, so the board's default can answer. An EMPTY list is only
  // reachable through `--allow-tools ""`, and it means what it says: no tools at all.
  const allowedTools = values['allow-tool'] !== undefined
    ? givenList(values['allow-tool'], '--allow-tool').filter(Boolean)
    // `given`, never `String(...)`: a bare `--allow-tools` came back as the boolean `true` and
    // was filed as a tool surface of exactly one tool, named `true` — a Job allowed to call
    // nothing, which is the one narrowing that looks identical to a working one until it runs.
    : values['allow-tools'] !== undefined
      ? given(values['allow-tools'], '--allow-tools').split(',').map((t) => t.trim()).filter(Boolean)
      : null;
  const job = await db.job.create({
    data: {
      boardId: board.id, name, brief: briefText,
      // Null rather than `[]` for a Job that declares nothing: "produces no file" and "produced
      // none of the files it promised" are different facts, and only the second is a failure.
      ...(exports.length ? { exports } : {}),
      ...(results.length ? { results } : {}),
      ...(artifacts.length ? { artifacts } : {}),
      ...(inputs.length ? { inputs } : {}),
      // Null rather than `{}` for an unlabelled Job, on the same rule as every other Json?
      // column here: the absence of a value is what "nobody said" looks like.
      ...(Object.keys(labels).length ? { labels } : {}),
      ...(gate ? { gate } : {}),
      ...(guide !== undefined ? { guide } : {}),
      ...(check !== undefined ? { check } : {}),
      // The ref this Job branches from, or nothing. NOT resolved here: `hkb new` may be filing
      // the second step of a chain before the first has pushed the branch it names, and a
      // check at file time would refuse the one workflow the field exists for. It is checked
      // when the checkout is made, where a missing ref fails the Job by name (`src/controller.ts`).
      ...(base ? { base } : {}),
      ...(triage ? { phase: 'triage' as const } : {}),
      proposes,
      model,
      effort: effort ?? null,
      isolate: !values['no-isolate'],
      allowedTools,
      pluginPaths,
      // Null, not a number, when the flag was not given. A Job that recorded 20 turns because
      // nobody said otherwise would outrank its board's default for ever — "unset" staying
      // legible is the whole reason these columns are nullable. See `src/spec.ts`.
      maxTurns: num(values['max-turns'], '--max-turns') ?? null,
      maxBudgetUsd: num(values['max-budget'], '--max-budget') ?? null,
      maxRetries: num(values['max-retries'], '--max-retries') ?? null,
      attemptDeadlineSeconds: seconds(values['attempt-deadline'], '--attempt-deadline'),
      activeDeadlineSeconds: seconds(values.deadline, '--deadline'),
    },
  });
  await db.event.create({
    data: { kind: 'created', jobId: job.id, boardId: board.id, actor: opts.by, payload: { name, ...(triage ? { phase: 'triage' } : {}) } },
  });
  // RESOLVED, not the Job's own column. `check ?? null` printed nothing for a Job that
  // inherits the board's — which is the configuration the README recommends, and precisely the
  // "an attempt can fail on a command nobody printed" surprise this echo exists to prevent. The
  // board row is already in hand, so this costs nothing and reads like `hkb show`.
  const filedCheck = resolveSpec(job, board).check;
  return {
    row: {
      id: job.id, name: job.name, phase: job.phase, board: slug,
      exports, results, artifacts, inputs, labels, proposes,
      check: jsonCheck(filedCheck, proposes),
      from: tpl?.name ?? null,
      standingSteps: dflt?.name ?? null,
    },
    from: tpl,
    standingSteps: dflt,
  };
}

/**
 * The refusal when nothing said what the work is.
 *
 * Its own function only so that the brief's precedence above stays one expression: the ladder is
 * the rule, and an `if` chain around it hid which case was the fallback.
 */
function throwNoBrief(): never {
  throw usage('a Job needs a brief — pass --brief "…", --brief-file <path>, or --brief - to read stdin');
}
