---
title: Workflow templates (`.hkb/workflows/`, `hkb new --from`)
summary: "Work that recurs is a file, not a command you retype: frontmatter is the spec, the body is the brief, and the keys are the CLI flags so one vocabulary documents both. Expanded once at file time, fenced to the board's repository, and hkb's own workflow comes through the same door."
category: features
kind: explanation
audience: [dev]
read_when: "authoring a workflow, adding a flag to `hkb new`, or deciding whether something belongs in the format (machinery) or in a workflow file (content)"
covers:
  - path: src/templates.ts
    sha: 216569e82eb7ef9f240d8a87db1707d775032cbf
  - path: src/hkb.ts
    sha: 37b4de4b924ce76c8003ffec444982eebf3f4031
  - path: src/inputs.ts
    sha: ffd76fce7689fe1c9a1dc0db3756cdf343d2b623
related:
  [
    features/the-checkout-base,
    decisions/adr-015-machinery-and-consumer,
    architecture/job-kind,
    features/declared-outputs,
    concepts/ceilings,
    features/proposals,
  ]
generated_at_commit: 73ac807
last_refreshed: 2026-09-07
---

# Workflow templates (`.hkb/workflows/`, `hkb new --from`)

> A **workflow** is a markdown file in the board's repository whose frontmatter
> is a Job's spec and whose body is its brief. `hkb new --from <name>` expands
> one into a Job and then forgets it. The format is machinery; a workflow
> written in it is content — that is
> [ADR-015](../decisions/adr-015-machinery-and-consumer.md) decision 3, and this
> is the page for the machinery half.

## What it is for

ADR-015 decision 3 names the extension point that makes *"bring your own software factory"* mean
something: **a workflow is a file, not code**, so authoring one requires no hkb release and no hkb
knowledge beyond the grammar below. Everything about the primitive follows from wanting that to be
true — including the things it refuses to do.

The concrete prior art is in this repository's own history. Four Jobs drafted four wiki pages on
2026-09-06, filed by hand, each with a ~700-word brief that was ~80% identical to the other three:
the same contract paragraph, the same finishing steps, the same list of ways to get it wrong. That
duplication is not a documentation problem, it is a *correctness* problem — the four briefs had
already drifted from each other by the time they ran, and there was nowhere to fix the shared half
once.

## The format

Frontmatter is the spec; everything after the closing `---` is the brief
(`src/templates.ts:177-190`).

```markdown
---
name: draft-wiki-page
description: Draft one planned page in the code-derived wiki
model: claude-opus-5
max-turns: 60
max-budget: 2
allow-tool: [Read, Grep, Glob, Write, Edit, Bash]
guide: CLAUDE.md
plugin-dir: [.claude]
gate: does this page earn its place?
---

Draft ONE new page in this repository's wiki: `docs/wiki/{{page}}.md`…
```

### The keys are the CLI flags

`max-budget` is `--max-budget`; `allow-tool` is `--allow-tool`; `input` is `--input`. The table in
`src/templates.ts:77-95` exists only to say which keys take a list and which take a boolean — the
*names* are not a second vocabulary to learn.

That is the load-bearing decision on this page, and the argument for it is drift rather than
elegance: with one vocabulary, `hkb --help` is the reference for the file format as well as for the
command line, and it cannot fall out of date with it. A second set of names (`budget`, `tools`,
`llm`) would have needed its own documentation, kept in sync by hand with the flags it stood for.

The claim is checked rather than asserted: a test walks every key in `TEMPLATE_KEYS` and requires a
matching option in `hkb new`'s `parseArgs` table, so a key nobody could have filed by hand cannot
survive in the format (`test/templates.test.ts`, *"the keys a workflow may set are all flags `hkb
new` parses"*).

Two keys are not flags and are allowed anyway — `name` and `description` (`src/templates.ts:104`).
`name` is *checked, not used*: `--from` finds a workflow by its filename, so a `name:` that
disagrees is a file somebody copied and never renamed, and it is refused
(`src/templates.ts:262-267`). `description` is the line a person reads when choosing between
workflows, and `hkb new` prints it back (`src/hkb.ts:657`).

### The grammar is two lines long

`key: value` and `key: [a, b]`. That is all of it (`src/templates.ts:240-308`). There are no block
lists, no nesting, no anchors and no continuation lines. Blank lines and `#` comments are skipped
(`src/templates.ts:243`); a value's first `:` is the separator, so `gate: is this right: yes or no?`
holds together; a matched pair of surrounding quotes is stripped (`src/templates.ts:192-196`).

**No YAML dependency**, and the habit that rule protects is the point (`CLAUDE.md`). The nearest
prior art is in this repository already: `.repolore/scripts/lib.mjs` parses exactly the controlled
frontmatter schema the wiki uses, stdlib-only, for the same reason. The constraint that keeps the
grammar honest is that a person *and a model* have to be able to write one without a schema in front
of them, which is what rules out every construct an author can get subtly wrong.

### What it refuses

The refusals are the feature, not the parsing — the same posture as `src/proposals.ts`, where an
unknown key on a proposed Job is named rather than dropped. A silently ignored `timeout:` reads to
its author as though it had been honoured, and the only place that shows up is in what the Job then
does.

| Refusal | Why it is not a warning |
|---|---|
| a key that is not a flag | named, with the list of ones that are and a pointer to `hkb --help` (`src/templates.ts:279-285`) |
| `brief:`, `brief-file:` | the *body* is the brief; each gets its own message rather than "unknown key" (`src/templates.ts:110-116`) |
| `board:` | which board work is filed on is the operator's answer, not the file's — a workflow that could redirect a Job would be choosing its budget and its repository too |
| a key set twice | both values were meant; picking one silently is how a Job runs on a model nobody chose (`src/templates.ts:258`) |
| a key with no value | absence is how a workflow says nothing about a key; an empty one is a different, unsayable thing (`src/templates.ts:286`) |
| `allow-tool: []` | same reason. On the *command line* an empty list is meaningful ("no tools at all"); in a file it is indistinguishable from a line the author was halfway through |
| a list where a scalar belongs, or a non-`true`/`false` switch | (`src/templates.ts:298-305`) |
| no frontmatter, or frontmatter never closed | (`src/templates.ts:179-188`) |
| frontmatter with no body | a workflow with no brief is a spec nobody can run (`src/templates.ts:311-314`) |
| over `TEMPLATE_MAX_BYTES` (64 KB) | the body becomes a brief, and a brief is paid for on every request of every attempt — the same argument as an input's cap, and the same number. The message points at `--guide`, which is the flag for a document a whole repository shares (`src/templates.ts:64`, `src/templates.ts:227-237`) |

Every refusal names its file and, where a line is at fault, its line number, and carries the fix.

## Where a workflow lives, and why that is not negotiable

`.hkb/workflows/<name>.md` under **`Board.repoPath`** — never the process's cwd and never the
worktree an attempt runs in. The containment is `resolveInRepo` (`src/inputs.ts:304-322`), the same
function that fences a `--guide` (`src/guide.ts`) and a `file:` input, reused rather than
reimplemented.

There are two fences, and the first one is cheaper than the second. `workflowPath`
(`src/templates.ts:146-156`) refuses anything that is not `[A-Za-z0-9][A-Za-z0-9_-]*` *before a path
is built*, so `--from ../../etc/passwd` never reaches the filesystem at all; `resolveInRepo` then
realpaths the result and refuses a symlink that leaves the repository, which is the half a syntax
rule cannot make.

The reason it is the repository and not the worktree is the same one ADR-012 and ADR-013 turn on: a
worker that could author the workflow its own successor is filed from would be choosing that
successor's model, budget, tool surface and plugin grants. **A human merge is the boundary.**

> Note the deliberate asymmetry with `--input`: `checkInputPath` refuses any path inside `.hkb/`,
> because the board's own directory is *"not a Job's to read"* (`src/inputs.ts:194-196`). A workflow
> is read from `.hkb/` by the *operator's* command, not by a running Job, so the two rules do not
> conflict — but a change to either should be made knowing about the other.

`.hkb/` is otherwise gitignored as local runtime state (worktrees, a stray board file), so
`.gitignore` un-ignores exactly `.hkb/workflows/`. It is written `.hkb/*` plus `!.hkb/workflows/`
because **git will not re-include a path underneath an excluded directory** — the negation only
works if the directory itself was never excluded.

## Expanded at file time, then gone

`hkb new --from` reads and validates the workflow **before the board is upserted and before a name
is settled** (`src/hkb.ts:519`), so a workflow that is not there fails naming the path it looked for
with nothing created. It then fills in every flag the command line did not set
(`src/hkb.ts:520-529`), and the Job is created by the ordinary `hkb new` path — same validation, same
columns, same events.

**Nothing downstream knows a file was involved.** The controller, the runtime and `hkb show` see a
Job with values on it. Two consequences worth stating:

1. Editing a workflow cannot retroactively change a Job already filed from it. This is the same
   discipline `renderBrief` follows — what the board stores is what the run is given, so `hkb show`
   cannot disagree with the prompt.
2. `hkb show`'s spec trace reports every templated value as coming from `job`, because it did: the
   expansion happened at file time, and `resolveSpec` (`src/spec.ts`) resolves what is on the row.
   The workflow's name is printed by `hkb new` (`src/hkb.ts:657`) and carried in its `--json` as
   `from` (`src/hkb.ts:652`), which is the only place the two are ever seen together.

### Precedence: the flag you typed wins

An explicit flag outranks the file, which is `src/spec.ts`'s grain — the more specific value wins —
one level further out.

It is implemented as *"fill what is absent"* rather than as a merge, and that matters most for the
list-valued flags: **`--allow-tool` on the command line replaces the workflow's list rather than
appending to it**. Appending would make a workflow's grant impossible to *narrow*, so a Job could
only ever widen the surface its template chose, which is the wrong direction for a guard.

The workflow's own `name:` becomes the Job's name when none is given
(`src/hkb.ts:532`), so `hkb new --from draft-wiki-page` is a whole command; a name typed on the line
still wins, being the more specific value. `--brief` likewise overrides the body
(`src/hkb.ts:537-542`).

### Placeholders, and the hole that had to be closed explicitly

A workflow body may carry `{{name}}`, rendered from the Job's `value:` inputs and *only* from those —
because the brief is instruction and a fetched source reaches the run as data (`src/inputs.ts:342`,
and the argument in its docblock).

`renderBrief` deliberately leaves a brief alone when a Job declares no inputs at all
(`src/inputs.ts:356`): interpolation is opt-in, so that every brief written before the feature
existed still means what it says. That opt-in is exactly wrong for a workflow, whose author opted in
by writing `{{page}}` — without a check, `hkb new --from` with no `--input` would file a Job with the
literal text `{{page}}` in its instructions and nothing would ever say so. So `hkb new` asks first
and refuses, naming the placeholders and the flags that supply them (`src/hkb.ts:581-590`,
`placeholders` at `src/templates.ts:327`).

## The dogfood

ADR-015 decision 4: **hkb's own workflows are ordinary workflows.** No privileged path, no
`templates/` inside the package, no second mechanism.

`.hkb/workflows/draft-wiki-page.md` in this repository is the one that exists — the four 2026-09-06
briefs, reconstructed with their shared 80% as the body and their per-page half as four
placeholders (`page`, `cover`, `sources`, `wrong`). It is read by exactly the `readTemplate` a user's
workflow is read by, and it ships in no tarball: `files` in `package.json` does not name `.hkb`, and
a test asserts it does not (`test/templates.test.ts`, *"this repository's own workflows parse, and
come through the user door"*).

That test is the guard the rule actually needs. Decision 4 exists because *"if we ship ours through a
different door than the one we hand users, the user door will be second-class and we will not notice,
because we never walk through it"* — and a declaration nothing enforces is a failure this project has
had five times under that name. So the check is not that the file exists but that it **parses through
the shipped reader**, which is the thing that would rot.

One detail in that file is worth keeping: it sets `max-turns: 60`. The built-in is 20
(`src/spec.ts`), and the first of the four Jobs it is reconstructed from stopped on `max_turns` at 20
having spent $1.56 and produced nothing. A workflow is where that lesson can be written down once.

## Known gaps

- **A proposing Job cannot file from a workflow.** `src/proposals.ts` allows a proposal to set only
  `name`, `brief` and a `maxBudgetUsd` that may go down, and `--from`/`--input` are not on that
  allowlist. This is the intended reading of ADR-011 rather than an oversight — a proposal that could
  name a workflow would be a worker choosing its successor's tool surface, which is the thing the
  allowlist is short in order to prevent — but it does mean decomposition and templating do not
  currently compose.
- **There is no verb that lists workflows.** `readTemplate` lists what is available inside the
  refusal for a workflow that is not there (`src/templates.ts:159-168`, `src/templates.ts:217-226`),
  which is where a person actually needs it, but discovering the set means typing a wrong name or
  listing the directory.
- **One workflow per Job.** `--from` is not repeatable, deliberately: two workflows would need a rule
  for which one wins per key, and "the flag you typed wins over the file" is the only precedence
  worth asking anyone to hold (`src/hkb.ts:445-449`).
