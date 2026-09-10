import fs from 'node:fs';
import path from 'node:path';

import { resolveInRepo } from './inputs.ts';

/**
 * `templates` — a workflow is a file, and the file is the format ADR-015 calls machinery.
 *
 * ADR-015 decision 3: **the template format is machinery; a workflow written in it is content.**
 * That is the seam that makes "bring your own software factory" mean something — authoring a
 * workflow needs no hkb release and no hkb knowledge beyond this file's grammar, because a workflow
 * is data in the repository rather than code in the package. Decision 4 is the other half, and it
 * is the one with teeth: **hkb's own workflows come through the same door.** There is no
 * `templates/` inside the package and no privileged name; `.hkb/workflows/draft-wiki-page.md` in
 * this repository is read by exactly the code below that reads yours.
 *
 * ## The keys are the flags
 *
 * `max-budget` is `--max-budget`. `allow-tool` is `--allow-tool`. `input` is `--input`. One
 * vocabulary, so anything filable by hand is nameable in a file and the docs for one are the docs
 * for both — and, more usefully, so `hkb --help` is the reference for the format and cannot drift
 * from it. The alternative was a second set of names ("budget", "tools", "model") that would have
 * had to be learned, documented and kept in sync with the flags they stand for.
 *
 * A key that is not a flag is **refused by name**, the way `src/proposals.ts` refuses an unknown
 * proposal key rather than dropping it. A silently ignored `timeout:` reads to its author as though
 * it had been honoured, and the only place that shows up is in what the Job then does.
 *
 * ## Expanded at file time, not read at run time
 *
 * A template is applied by `hkb new --from <name>` and then it is *gone*: the Job on the board holds
 * the values, and nothing in the controller, the runtime or `hkb show` knows a file was involved.
 * That is deliberate and it is the same discipline `renderBrief` follows — what the board stores is
 * what the run is given, so editing a workflow file cannot retroactively change a Job that was filed
 * from it, and `hkb show` cannot disagree with the prompt.
 *
 * ## Hand-parsed, and the grammar is two lines long
 *
 * `key: value` and `key: [a, b]`. That is all of it. No YAML dependency — CLAUDE.md forbids one and
 * the habit it protects is the point — and `.repolore/scripts/lib.mjs` does the same job in this
 * repository for the same reason, with the same shape. The grammar has to stay small enough that a
 * person and a model can both write one without a schema in front of them, which rules out block
 * lists, nesting and anchors: every one of those is a thing an author can get subtly wrong and a
 * parser can get subtly right.
 *
 * ## Where, and why it is not negotiable
 *
 * `.hkb/workflows/` under **`Board.repoPath`**, never the worktree — the same fence as a guide
 * (`src/guide.ts`) and a plugin grant, through the same `resolveInRepo`. A worker that could author
 * the workflow its own successor is filed from would be choosing that successor's model, budget and
 * tool surface. A human merge is the boundary.
 */

/** Where workflows live, relative to the board's repository. */
export const WORKFLOW_DIR = '.hkb/workflows';

/**
 * The cap on one workflow file.
 *
 * The body becomes a brief, which is paid for on every request of every attempt — the same argument
 * as an input's cap, and the same number. A workflow that does not fit is a workflow that is trying
 * to be the repository's documentation, and `--guide` is the flag for that.
 */
export const TEMPLATE_MAX_BYTES = 64 * 1024;

type Kind = 'string' | 'list' | 'boolean';

/**
 * Every key a workflow may set, and the shape its value takes. **The names are `hkb new`'s flags,
 * without the dashes** — that is the whole rule, and this table exists only to say which of them
 * take a list and which take a boolean.
 *
 * `--json` is absent because it is output, not spec. `--board` is absent for a sharper reason: which
 * board work is filed on is the operator's answer, not the workflow's, and a file that could redirect
 * a Job onto another board would be choosing its budget and its repository too.
 */
export const TEMPLATE_KEYS: Record<string, Kind> = {
  model: 'string',
  effort: 'string',
  gate: 'string',
  guide: 'string',
  // The ref a step branches from — the key that lets a workflow file express a chain at all, since
  // a coding Job's output is a branch and this is what a later step points at.
  // The command a step must pass (ADR-016 §3). A workflow is the natural home for it — "this kind
  // of work is done when the suite is green" is a property of the workflow, not of one Job — and it
  // is safe here for the reason this file's header gives: a workflow is read from `Board.repoPath`
  // and never from a worktree, so a worker cannot author what judges its own next attempt.
  check: 'string',
  'max-turns': 'string',
  'max-budget': 'string',
  'max-retries': 'string',
  // Both deadlines, in seconds. A workflow is the natural home for "this kind of work needs an
  // hour": the number is a property of the shape of the work, not of one Job.
  'attempt-deadline': 'string',
  deadline: 'string',
  'no-isolate': 'boolean',
  triage: 'boolean',
  propose: 'boolean',
  'allow-tool': 'list',
  'allow-tools': 'string',
  'plugin-dir': 'list',
  label: 'list',
  input: 'list',
  export: 'list',
  result: 'list',
  artifact: 'list',
};

/**
 * The two keys that are not flags, and are allowed anyway: the workflow's own identity.
 *
 * `name` must match the filename, so a copied file that was never renamed says so instead of being
 * filed under a name nobody meant. `description` is the one line a person reads when choosing
 * between workflows, and `hkb new --from` prints it back.
 */
export const META_KEYS = ['name', 'description'] as const;

/**
 * Keys refused with a reason of their own, because each is a mistake somebody will actually make and
 * "unknown key" would be a worse answer than the truth.
 */
const REFUSED: Record<string, string> = {
  brief: 'the BODY of the file is the brief — everything after the closing `---`',
  'brief-file': 'the body of the file is the brief — a workflow does not point at another file for it',
  board: 'which board work is filed on is the operator\'s choice, not the workflow\'s — pass `--board` to `hkb new`',
  from: 'a workflow does not include another workflow',
  json: '`--json` is output, not spec',
};

function refuse(why: string): never {
  const e = new Error(why) as Error & { exitCode: number };
  e.exitCode = 2;
  throw e;
}

/** What a parsed workflow is: its identity, the flags it sets, and the brief. */
export type Template = {
  /** The workflow's name — the filename's stem, and what `--from` was given. */
  name: string;
  description: string | null;
  /** Flag name (no dashes) to the value `parseArgs` would have produced for it. */
  spec: Record<string, string | string[] | boolean>;
  /** The body: the brief, verbatim, trimmed. */
  brief: string;
  /** Repo-relative, for messages. */
  file: string;
};

/**
 * `--from <name>` to a repo-relative path, or a refusal.
 *
 * A trailing `.md` is accepted because an author who tab-completed the file will type it, and being
 * told "no such workflow" for the file they are looking at is the kind of friction this project
 * treats as a bug. Everything else is refused *before* a path is built: `--from ../../etc/passwd`
 * never reaches the filesystem, and the containment check in `resolveInRepo` is the second fence
 * rather than the only one.
 */
export function workflowPath(name: string, flag = '--from'): string {
  const stem = String(name ?? '').trim().replace(/\.md$/, '');
  // The flag is a parameter because there are two of them. `hkb boards set --workflow " "` reached
  // here and was told to "write `--from <name>`" — a refusal naming a flag the operator had not
  // typed, about a verb that does not have it.
  if (!stem) refuse(`${flag} names no workflow — write \`${flag} <name>\`, for a file at \`${WORKFLOW_DIR}/<name>.md\``);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(stem)) {
    refuse(
      `\`${stem}\` is not a workflow name — a name is letters, digits, \`-\` and \`_\`, and it names one file`
      + ` directly in ${WORKFLOW_DIR}/. Workflows are not nested, so a name has no slashes and no dots in it.`,
    );
  }
  return `${WORKFLOW_DIR}/${stem}.md`;
}

/** What else is there, for the refusal when a workflow is not. Best effort: a listing is a courtesy. */
function available(repoPath: string): string[] {
  try {
    return fs.readdirSync(path.join(repoPath, WORKFLOW_DIR))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Split the frontmatter off the top of a workflow.
 *
 * The opening `---` is required rather than optional: a file with no frontmatter is a brief with no
 * spec, which is a thing `--brief-file` already does better, and accepting it would mean the format
 * has two shapes to explain.
 */
function split(text: string, file: string): { fm: string[]; body: string } {
  const lines = text.replace(/^﻿/, '').split('\n');
  if (lines[0].trim() !== '---') {
    refuse(
      `${file} does not begin with a \`---\` line. A workflow is frontmatter then body: the keys between two`
      + ' `---` lines are the spec — they are `hkb new`\'s flags without the dashes — and everything after the'
      + ' second one is the brief.',
    );
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) refuse(`${file} opens a \`---\` frontmatter block and never closes it — the second \`---\` is what ends the spec and begins the brief.`);
  return { fm: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
}

/** `"a"` / `'a'` → `a`. A matched pair only; a lone quote is part of the value. */
function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

/**
 * Read and check one workflow, or say exactly why not — before anything is created.
 *
 * Throws rather than returning `{ why }`, unlike `readGuide` and `readFileInput`, and the difference
 * is who is standing there: those two are read by the controller mid-pass, where an exception would
 * unwind somebody else's reconcile. This one is read by `hkb new`, with an operator at a terminal, and
 * a usage error with a message that names the fix is exactly the right answer.
 */
export function readTemplate(repoPath: string | null, name: string): Template {
  const file = workflowPath(name);
  const stem = path.basename(file, '.md');
  if (!repoPath) {
    refuse(
      `a workflow is read from the board's repository, and this board has none — \`hkb boards add <slug> --repo <path>\``
      + ' points one at a checkout, or run `hkb new` from inside the repository the workflow lives in.',
    );
  }

  const found = resolveInRepo(repoPath as string, file);
  if ('why' in found) {
    const others = available(repoPath as string).filter((w) => w !== stem);
    refuse(
      `there is no workflow \`${stem}\` in this repository: ${found.why} (looked for ${path.join(repoPath as string, file)}).`
      + (others.length
        ? ` This repository has ${others.map((w) => `\`${w}\``).join(', ')}.`
        : ` Nothing is in ${WORKFLOW_DIR}/ yet — a workflow is a markdown file whose frontmatter keys are \`hkb new\`'s`
          + ' flags without the dashes, and whose body is the brief.'),
    );
  }
  if (found.bytes > TEMPLATE_MAX_BYTES) {
    refuse(
      `${file} is ${found.bytes} bytes, over the ${TEMPLATE_MAX_BYTES}-byte cap — a workflow's body becomes a brief,`
      + ' and a brief is paid for on every request of every attempt. Standing rules a whole repository shares belong in'
      + ' its contributor guide, which `guide:` names.',
    );
  }

  const { fm, body } = split(fs.readFileSync(found.path, 'utf8'), file);
  const spec: Record<string, string | string[] | boolean> = {};
  const seen = new Set<string>();
  let description: string | null = null;

  for (const [i, raw] of fm.entries()) {
    const line = raw.trim();
    // Blank lines group a long spec; `#` is the comment character every reader already expects.
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!m) {
      refuse(
        `${file}, line ${i + 2}: \`${line}\` is not \`key: value\`. The whole grammar is \`key: value\` and`
        + ' `key: [a, b]` — there are no block lists, no nesting and no continuation lines, so a value that runs long'
        + ' stays on one line.',
      );
    }
    const key = m[1];
    const rest = m[2].trim();

    // A repeated key is refused rather than last-one-wins: the two values are both something the
    // author meant, and picking one silently is how a workflow ends up running on a model nobody
    // chose. Repetition is how the *flags* say "another item"; here a list says it in brackets.
    if (seen.has(key)) refuse(`${file}, line ${i + 2}: \`${key}\` is set twice, and a spec that says two things says nothing. A list is \`${key}: [a, b]\` on one line.`);
    seen.add(key);

    if (key === 'name') {
      // Checked rather than used. The file's location is what `--from` resolved, so a `name:` that
      // disagrees is a copied workflow nobody renamed — and the value it would have set is the one
      // thing here that is already known.
      if (unquote(rest) !== stem) {
        refuse(`${file} says \`name: ${unquote(rest)}\` but the file is \`${stem}.md\` — \`--from\` finds a workflow by its filename, so rename one to match the other.`);
      }
      continue;
    }
    if (key === 'description') {
      if (!rest) refuse(`${file}, line ${i + 2}: \`description\` has no value — it is the one line a person reads when choosing a workflow.`);
      description = unquote(rest);
      continue;
    }
    if (key in REFUSED) {
      refuse(`${file}, line ${i + 2}: a workflow may not set \`${key}\` — ${REFUSED[key]}.`);
    }
    const kind = TEMPLATE_KEYS[key];
    if (!kind) {
      refuse(
        `${file}, line ${i + 2}: \`${key}\` is not a key a workflow has. A workflow's keys are \`hkb new\`'s flags`
        + ` without the dashes: ${Object.keys(TEMPLATE_KEYS).sort().join(', ')} — plus \`name\` and \`description\`.`
        + ' Run `hkb --help` for what each one does; it is the same reference for both.',
      );
    }
    if (!rest) refuse(`${file}, line ${i + 2}: \`${key}\` has no value. Delete the line rather than leaving it blank — an empty key is not the same as an absent one.`);

    // A list is `[a, b]` — EXCEPT where a scalar key's value is a shell `[ … ]` test.
    //
    // `check: [ -f dist/index.js ]` is the POSIX spelling of `test -f dist/index.js`, and the
    // generic bracket rule read it as a list and refused it with a suggested fix —
    // `check: -f dist/index.js` — that would have filed a command exiting 127. The two forms are
    // told apart by the spaces `[` requires to be a command at all: `[a, b]` is a list and `[ x ]`
    // is an argument list ending in `]`.
    //
    // **And by the comma**, which is the narrowing this needed. `kind !== 'list'` is thirteen scalar
    // keys, not one, and inner spaces are how a person writes a list they expect to be read as one:
    // `model: [ opus, sonnet ]` was filed as the literal thirteen-character model name, and
    // `check: [ a, b ]` as a command exiting 2 on every attempt — an exemption meant for one shape
    // silently swallowing every mistake in that shape's neighbourhood. A shell `[ … ]` test is one
    // command with one argument list and no commas in it; a list is exactly the thing with commas.
    // What is left over — `[ a, b ]` genuinely meant as a shell test — is reachable by quoting.
    //
    // **And by the key.** The comma caught the multi-item shape and not the single one: `model:
    // [ opus ]`, `guide: [ CLAUDE.md ]`, `gate: [ looks right? ]` were still filed as those literal
    // strings where `main` refused each with a fix. `check` is the one key whose value is a shell
    // line; every other scalar takes a name, a ref, a path or a sentence, and none of those starts
    // with `[ `.
    const shellTest = key === 'check' && rest.startsWith('[ ') && rest.endsWith(' ]') && !rest.includes(',');
    const isList = rest.startsWith('[') && rest.endsWith(']') && !shellTest;
    const items = isList
      ? rest.slice(1, -1).split(',').map((s) => unquote(s)).filter(Boolean)
      : [unquote(rest)];

    if (kind === 'list') {
      // A bare scalar is one item. `allow-tool: Read` is what an author writes when there is one, and
      // making them type brackets for it would be a schema showing through.
      if (!items.length) refuse(`${file}, line ${i + 2}: \`${key}: []\` is an empty list. Delete the line — the absence of a key is how a workflow says nothing about it.`);
      spec[key] = items;
    } else if (isList) {
      // The quoted form is named as well as the bare one, because for a shell line the bare
      // suggestion is wrong: `check: [a,b]` really is a list mistake, but a value that only LOOKS
      // like one is fixed by quoting it, not by stripping the brackets that are part of it. And it
      // is named as something that WORKS rather than as a hope: the bracket test above runs on the
      // raw `rest`, before `unquote`, so a quoted value never reaches it at all.
      refuse(
        `${file}, line ${i + 2}: \`${key}\` takes one value, not a list — \`${key}: ${items[0] ?? 'value'}\`.`
        + ` If the brackets are part of the value, quote the whole thing and it is taken verbatim:`
        + ` \`${key}: "${rest}"\`.`,
      );
    } else if (kind === 'boolean') {
      const v = items[0].toLowerCase();
      if (v !== 'true' && v !== 'false') {
        refuse(`${file}, line ${i + 2}: \`${key}\` is a switch, so it is \`true\` or \`false\` — got \`${items[0]}\`.`);
      }
      spec[key] = v === 'true';
    } else {
      // `check: none` is refused HERE, where the file and the line are in hand. It reached `hkb new`
      // as though it had been typed, so the refusal an author saw was about a flag they had not
      // used — "leave `--check` out", against a file where leaving the key out is the fix and the
      // only fix. A workflow always files a NEW Job, whose check column is already null, so there
      // is nothing for `none` to clear: it would file the literal command `none`, which exits 127.
      if (key === 'check' && items[0] === 'none') {
        refuse(
          `${file}, line ${i + 2}: \`check: none\` would file the literal shell command \`none\`, which `
          + 'exits 127 — every attempt would fail its check and burn a retry. Delete the line: a Job '
          + 'filed without a check already inherits the board\'s. For a Job that runs NO check and '
          + 'inherits nothing, write `check: ""`.',
        );
      }
      spec[key] = items[0];
    }
  }

  const brief = body.trim();
  if (!brief) {
    refuse(`${file} has frontmatter and no body — the body is the brief, and a workflow with no brief is a spec nobody can run.`);
  }
  return { name: stem, description, spec, brief, file };
}

/**
 * The line that names where a Job's standing steps came from, written into the composed prompt.
 *
 * Written and never matched back, which is the change ADR-017's review forced. It used to be both:
 * the steps were expanded into `Job.brief` at file time and `hkb show` recovered the workflow's
 * name by parsing this sentence out again. That made the brief the record — and `hkb queue <id>
 * "…"` replaces a brief wholesale, so the board's own triage → queue inbox silently dropped the
 * steps and the record of them together.
 *
 * The steps are composed at claim time now, from the board's default as it is then
 * (`src/controller.ts`), so the record is the `Board.defaultWorkflow` column and there is nothing
 * to parse. What is left is the sentence itself, which is for the WORKER: a block of instructions
 * that arrived from somewhere other than the brief should say where.
 */
const STANDING = (name: string) => `Standing steps for work on this board, from the workflow \`${name}\`:`;

/**
 * The board's default workflow, appended to a brief as **standing steps**.
 *
 * The one place a file's body and the Job's own brief both survive, and the asymmetry is the point.
 * `--from <x>` says *x is the work*, so x's body IS the brief and a `--brief` on the line replaces
 * it. A board default says *this is how work on this board finishes* — a brief still says WHAT to
 * do, and the default says what doing it ends in. Overwriting one with the other would make the
 * board's default either useless or destructive, so they compose instead.
 *
 * Appended rather than prepended, on `withResults`' rule: what follows the work is a contract to
 * satisfy at the end, and last is where a requirement reads best. The caller appends it after the
 * sandbox contract for the sharper version of the same reason — the core says how work is done
 * here, and these say what doing it ends in, and a worker given them the other way round reads two
 * reply contracts in the wrong order.
 */
export function withStandingSteps(brief: string, workflow: string, steps: string): string {
  if (!steps.trim()) return brief;
  return [
    brief.trimEnd(),
    '',
    '---',
    '',
    STANDING(workflow),
    '',
    steps.trim(),
  ].join('\n');
}

/**
 * The `{{name}}` placeholders a brief refers to.
 *
 * `renderBrief` refuses an unknown placeholder, but only for a Job that declares inputs **at all** —
 * a deliberate opt-in, so that every brief written before interpolation existed still means what it
 * says. A workflow author, though, has opted in by writing the placeholder, and a workflow filed with
 * no inputs would otherwise reach a worker with the literal text `{{page}}` in its instructions. So
 * `hkb new --from` asks this question first and refuses, naming what is missing.
 */
export function placeholders(brief: string): string[] {
  const names = new Set<string>();
  for (const m of brief.matchAll(/\{\{\s*([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9_-]+)*\s*\}\}/g)) names.add(m[1]);
  return [...names];
}
