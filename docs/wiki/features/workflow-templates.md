---
title: Workflow templates (`.hkb/workflows/`, `hkb new --from`)
summary: "Work that recurs is a file, not a command you retype: frontmatter is the spec, the body is the brief, and the keys are the CLI flags so one vocabulary documents both. Expanded once at file time, fenced to the board's repository, and hkb's own workflows come through the same door — including the board's default one, whose frontmatter fills the spec when a Job is filed and whose body is appended as standing steps when it runs."
category: features
kind: explanation
audience: [dev]
read_when: "authoring a workflow, setting a board's default one, adding a flag to `hkb new`, or deciding whether something belongs in the format (machinery) or in a workflow file (content)"
covers:
  - path: src/templates.ts
    sha: 169ac395a4b608e231beeb978952da3adfc8c82c
  - path: src/hkb.ts
    sha: eb759e566ef71b11caa34cc0945a6e2ae30958cf
  - path: src/inputs.ts
    sha: 6ed576d25bf9db5f8b76e3752c17a250725df3b6
  - path: src/filing.ts
    sha: a3c67c49d8fc5b46e0caac0894bc52d10ca22a17
  - path: prisma/schema.prisma
    sha: 364793f9a1174875c3bf644257b6d0cbdf94d25e
related:
  [
    decisions/adr-015-machinery-and-consumer,
    decisions/adr-017-the-workflow-is-content,
    decisions/adr-018-the-boundary,
    architecture/job-kind,
    features/declared-outputs,
    concepts/ceilings,
    features/proposals,
  ]
generated_at_commit: ebf564a
last_refreshed: 2026-09-10
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
(`split`, `src/templates.ts:190-202`).

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
`src/templates.ts:77-105` exists only to say which keys take a list and which take a boolean — the
*names* are not a second vocabulary to learn.

That is the load-bearing decision on this page, and the argument for it is drift rather than
elegance: with one vocabulary, `hkb --help` is the reference for the file format as well as for the
command line, and it cannot fall out of date with it. A second set of names (`budget`, `tools`,
`llm`) would have needed its own documentation, kept in sync by hand with the flags it stood for.

The claim is checked rather than asserted: a test walks every key in `TEMPLATE_KEYS` and requires a
matching option in `hkb new`'s `parseArgs` table, so a key nobody could have filed by hand cannot
survive in the format (`test/templates.test.ts`, *"the keys a workflow may set are all flags `hkb
new` parses"*).

Two keys are not flags and are allowed anyway — `name` and `description` (`META_KEYS`, `src/templates.ts:114`).
`name` is *checked, not used*: `--from` finds a workflow by its filename, so a `name:` that
disagrees is a file somebody copied and never renamed, and it is refused
(`src/templates.ts:274-282`). `description` is the line a person reads when choosing between
workflows, and `hkb new` prints it back (`src/hkb.ts:771`).

### The grammar is two lines long

`key: value` and `key: [a, b]`. That is all of it (the parse loop, `src/templates.ts:253-368`). There are no block
lists, no nesting, no anchors and no continuation lines. Blank lines and `#` comments are skipped
(`src/templates.ts:255-256`); a value's first `:` is the separator, so `gate: is this right: yes or no?`
holds together; a matched pair of surrounding quotes is stripped (`unquote`, `src/templates.ts:205-209`).

One exemption, and it is this grammar meeting a shell: a **scalar** key whose value starts with
`[ `, ends with ` ]` **and contains no comma** is a value, not a list (`src/templates.ts`).
`check: [ -f dist/index.js ]` is the POSIX spelling of `test -f dist/index.js`, and the generic
bracket rule refused it with a suggested fix — `check: -f dist/index.js` — that would have filed a
command exiting 127 on every attempt of that Job.

The comma is not decoration: without it the exemption covered **all thirteen scalar keys** and every
mistake shaped like inner spaces. `model: [ opus, sonnet ]` was filed as that literal string, and
`check: [ a, b ]` as a command exiting 2 on every attempt — an exemption written for one shape
swallowing its whole neighbourhood. A shell `[ … ]` test is one command with one argument list and
no commas in it; a list is exactly the thing with commas. What is left over — brackets and commas
genuinely meant as a value — is reachable by quoting, which has always worked here and is now named
in the refusal as something that *does* work rather than as a hope: the bracket test runs on the raw
line, before the surrounding quotes are stripped.

`check: none` is refused where it is written, with the file and the line (`src/templates.ts`). It
used to reach `hkb new` as though it had been typed, so the author of a workflow file was told to
"leave `--check` out" — about a flag they had not used, on a verb where deleting the *line* is the
only fix there is.

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
| a key that is not a flag | named, with the list of ones that are and a pointer to `hkb --help` (`src/templates.ts:291-298`) |
| `brief:`, `brief-file:` | the *body* is the brief; each gets its own message rather than "unknown key" (`REFUSED`, `src/templates.ts:120-126`, refused at `:288-290`) |
| `board:` | which board work is filed on is the operator's answer, not the file's — a workflow that could redirect a Job would be choosing its budget and its repository too |
| a key set twice | both values were meant; picking one silently is how a Job runs on a model nobody chose (`src/templates.ts:271`) |
| a key with no value | absence is how a workflow says nothing about a key; an empty one is a different, unsayable thing (`src/templates.ts:299`) |
| `allow-tool: []` | same reason. On the *command line* an empty list is meaningful ("no tools at all"); in a file it is indistinguishable from a line the author was halfway through |
| a list where a scalar belongs, or a non-`true`/`false` switch | (`src/templates.ts:339-360`) — and the refusal names quoting as the other fix, because for a value whose brackets are real, stripping them is the wrong repair |
| no frontmatter, or frontmatter never closed | (`src/templates.ts:193-200`) |
| frontmatter with no body | a workflow with no brief is a spec nobody can run (`src/templates.ts:369-371`) |
| over `TEMPLATE_MAX_BYTES` (64 KB) | the body becomes a brief, and a brief is paid for on every request of every attempt — the same argument as an input's cap, and the same number. The message points at `--guide`, which is the flag for a document a whole repository shares (`src/templates.ts:64`, `src/templates.ts:240-246`) |

Every refusal names its file and, where a line is at fault, its line number, and carries the fix.

## Where a workflow lives, and why that is not negotiable

`.hkb/workflows/<name>.md` under **`Board.repoPath`** — never the process's cwd and never the
workspace an attempt runs in. The containment is `resolveInRepo` (`src/inputs.ts:309-330`), the same
function that fences a `--guide` (`src/guide.ts`) and a `file:` input, reused rather than
reimplemented.

There are two fences, and the first one is cheaper than the second. `workflowPath`
(`src/templates.ts:156-169`) refuses anything that is not `[A-Za-z0-9][A-Za-z0-9_-]*` *before a path
is built*, so `--from ../../etc/passwd` never reaches the filesystem at all; `resolveInRepo` then
realpaths the result and refuses a symlink that leaves the repository, which is the half a syntax
rule cannot make.

The reason it is the repository and not the workspace is the same one ADR-012 and ADR-013 turn on: a
worker that could author the workflow its own successor is filed from would be choosing that
successor's model, budget, tool surface and plugin grants. **A human merge is the boundary.**

> Note the deliberate asymmetry with `--input`: `checkInputPath` refuses any path inside `.hkb/`,
> because the board's own directory is *"not a Job's to read"* (`src/inputs.ts:188-216`). A workflow
> is read from `.hkb/` by the *operator's* command, not by a running Job, so the two rules do not
> conflict — but a change to either should be made knowing about the other.

`.hkb/` is otherwise gitignored as local runtime state (a stray board file when
`HKB_DATABASE_URL` points at one here), so `.gitignore` un-ignores exactly `.hkb/workflows/`.
Workspaces are no longer among what it hides — the harness puts them under `.claude/worktrees/`,
which `.gitignore` excludes on its own line. It is written `.hkb/*` plus `!.hkb/workflows/`
because **git will not re-include a path underneath an excluded directory** — the negation only
works if the directory itself was never excluded.

## Expanded at file time, then gone

`hkb new --from` reads and validates the workflow **before the board is upserted and before a name
is settled** (`createJob`, `src/filing.ts:130`), so a workflow that is not there fails naming the path it looked for
with nothing created. It then fills in every flag the command line did not set
(`src/filing.ts:198-201`), and the Job is created by the ordinary `hkb new` path — same validation, same
columns, same events.

**Nothing downstream knows a file was involved.** The controller, the runtime and `hkb show` see a
Job with values on it. Two consequences worth stating:

1. Editing a workflow cannot retroactively change a Job already filed from it. This is the same
   discipline `renderBrief` follows — what the board stores is what the run is given, so `hkb show`
   cannot disagree with the prompt.
2. `hkb show`'s spec trace reports every templated value as coming from `job`, because it did: the
   expansion happened at file time, and `resolveSpec` (`src/spec.ts`) resolves what is on the row.
   The workflow's name is printed by `hkb new` (`src/hkb.ts:771`) and carried in its `--json` as
   `from` (`src/filing.ts:423`), which is the only place the two are ever seen together.

### Precedence: the flag you typed wins

An explicit flag outranks the file, which is `src/spec.ts`'s grain — the more specific value wins —
one level further out.

It is implemented as *"fill what is absent"* rather than as a merge, and that matters most for the
list-valued flags: **`--allow-tool` on the command line replaces the workflow's list rather than
appending to it**. Appending would make a workflow's grant impossible to *narrow*, so a Job could
only ever widen the surface its template chose, which is the wrong direction for a guard.

The workflow's own `name:` becomes the Job's name when none is given
(`src/filing.ts:215`), so `hkb new --from draft-wiki-page` is a whole command; a name typed on the line
still wins, being the more specific value. `--brief` likewise overrides the body
(`src/filing.ts:343-347`).

### A board's default workflow: how work here FINISHES

`Board.defaultWorkflow` names a workflow in the same `.hkb/workflows/`, set with
`hkb boards set <slug> --workflow <name>|none` and printed beside the board's other defaults
(`describeDefaults`, `src/hkb.ts`). It exists because of what left the core:
[ADR-017](../decisions/adr-017-the-workflow-is-content.md) decision 5 moved *push, open a draft pull
request, a human merges* out of `src/brief.ts`, and a Job filed by hand — `hkb new --brief …`, no
`--from` — then had nowhere to get those steps from. Decision 1 says where: **a board's default
workflow is a file, not code.**

It composes **differently from `--from`, deliberately**:

| | `--from <x>` | `Board.defaultWorkflow` |
|---|---|---|
| the frontmatter | fills what the line did not say | the same, one level further out (line, then file, then the board's `default*` columns) |
| the body | **is** the brief; `--brief` replaces it | is **appended as standing steps**, straight after the brief |
| when the body is read | at file time, into `Job.brief` | **at claim time**, from the board as it is then |
| both at once | the default is not applied at all — `x` governs | — |

The asymmetry is the whole design. `--from` says *this workflow is the work*, so its body is the
brief. A board default says *this is how work on this board finishes* — a hand-written brief still
says WHAT to do, and the default says what doing it ends in — so overwriting one with the other would
make the default either useless or destructive. It is the one place a file's body and the line's
brief both survive (`withStandingSteps`, `src/templates.ts`).

#### The frontmatter is expanded at file time; the body is composed at CLAIM time

This is the one place a workflow breaks the "expanded once, then gone" rule above, and it is the
correction the first implementation needed. The steps were baked into `Job.brief` by `hkb new`, and
that was wrong three ways at once:

1. **`hkb queue <id> "…"` replaces a brief wholesale**, and so does `hkb job set --brief`. That path
   is the board's own inbox — how a triage note becomes work — so the steps and the record of them
   were dropped every single time, silently.
2. **They reached `--no-isolate` Jobs**, which get no workspace and no branch, and told them to push
   one.
3. **They landed before the core's own sandbox contract** — commit, rebase, push — so a worker read
   *"open the PR, reply with the URL"* and then *"1. commit, 2. rebase, 3. push, 4. reply with the
   branch"*: two reply contracts, in the wrong order. ADR-018 has since deleted that contract
   outright, so the ordering hazard is gone with it and this workflow file is where **all** of those
   steps now live.

So the *body* is read by the controller when the attempt is claimed and appended after the brief,
the way the guide and the check line are (`withStandingSteps`, `src/controller.ts:1287-1292`). Nothing is stored on the Job. The
*frontmatter* still expands at file time, because those are columns and a column filled later is a
column `hkb show` could not print.

It also makes the default behave like a default: editing the workflow changes the next attempt,
including the next attempt of a Job filed last week.

Three refusals and two exclusions, each with a reason that is not tidiness:

- **A default workflow that is not in the repository is refused at `hkb new`, by name**, with nothing
  created and the fix in the message (`hkb boards set <slug> --workflow <name>|none`) — the operator
  is standing there, and that is the cheapest place to find it.
- **And refused again at claim time, the same way**, because the file can be deleted after the Job is
  filed. The attempt fails without spending anything and says the same sentence. A Job silently
  missing the steps every other Job on the board got is worse than either refusal.
- **The name is checked at `hkb boards set`; the file's existence is not.** The usual way to set this
  is in the pull request that *adds* the workflow, so requiring it to be merged already would refuse
  the one command anybody runs. `--guide` on the same verb makes the same call, for the same reason:
  `boards set` may run on a host that is not the one the daemon runs on.
- **A default workflow may not use `{{placeholders}}`.** Its body is appended to somebody else's
  brief, so there is nothing to fill them from; the alternative is the literal text `{{page}}` in a
  worker's instructions.
- **A `--propose` Job gets none, and neither does a `--no-isolate` one.** A proposer's whole output is
  one JSON file, so a brief ending in "open a pull request" is not an instruction a worker can
  follow (`features/proposals`). A `--no-isolate` Job has no workspace for the steps to be about at
  all — the condition is `wantSteps && workspace && !job.proposes` (`src/controller.ts:1255`).

The record is `Board.defaultWorkflow` itself, and `hkb show` reads it there — printing
`steps  standing steps from workflow <name>`, for the two populations above excepted. It used to be
recovered by parsing the appended block back out of the stored brief, which made the brief the
record; that is precisely the coupling `hkb queue` broke.

### Placeholders, and the hole that had to be closed explicitly

A workflow body may carry `{{name}}`, rendered from the Job's `value:` inputs and *only* from those —
because the brief is instruction and a fetched source reaches the run as data (`src/inputs.ts:347`,
and the argument in its docblock).

`renderBrief` deliberately leaves a brief alone when a Job declares no inputs at all
(`src/inputs.ts:347-406`): interpolation is opt-in, so that every brief written before the feature
existed still means what it says. That opt-in is exactly wrong for a workflow, whose author opted in
by writing `{{page}}` — without a check, `hkb new --from` with no `--input` would file a Job with the
literal text `{{page}}` in its instructions and nothing would ever say so. So `hkb new` asks first
and refuses, naming the placeholders and the flags that supply them (`src/filing.ts:348-357`,
`placeholders` at `src/templates.ts:428`).

## The dogfood

ADR-015 decision 4: **hkb's own workflows are ordinary workflows.** No privileged path, no
`templates/` inside the package, no second mechanism.

There are two. `.hkb/workflows/implement.md` is this board's **default**, and ADR-018 made it much
larger: it now carries **the whole git protocol** — commit what you have, rebase onto the trunk,
push the branch, open a draft pull request, a human reviews and merges, reply with the URL. Every
one of those lines used to be split between the core (`withSandbox`: commit, rebase, push) and this
file (the pull request); the core says none of it now, so the file says all of it. That is ADR-018's
test doing its work: a line belongs in the core only while the machinery makes it true afterwards,
and the machinery stopped.

Two deletions inside it are worth noticing, because they are the change paying for itself. It no
longer passes `--base` to `gh pr create`, and it no longer declares `input: [base=self:base]` to get
the value — `Job.base` is gone, `self:base` is not a field a Job has any more (`JOB_FIELDS`,
`src/inputs.ts:79`), and a workspace is cut from the repository's default branch, which is what
`gh pr create` already defaults to. The declaration the page used to say "belongs on a `--from`
workflow instead" now belongs nowhere, because there is nothing to declare.

`.hkb/workflows/draft-wiki-page.md` is the other — the four 2026-09-06
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

## A workflow is now also a step's identity

`hkb new "the parser" --steps implement,review` cuts a `Run` whose `Step` rows are named
`implement` and `review` — and those names *are* these filenames. The Run controller files each
step's Job with `--from <step name>` when its predecessor succeeds (`src/runs.ts`,
*features/runs-and-steps*).

That is why sequencing needed no file format of its own. Everything a step is — its model, its
budget, its tool surface, its gate, its whole instruction — was already expressible here, in a file
whose 21 frontmatter keys are `hkb new`'s flags. The only thing this format could not say is *what
comes after what*, and that is the one thing that became a column.

Two consequences worth knowing before writing a workflow that a run will use:

- **The board's default workflow is still appended.** `--from` does not exclude it (`src/filing.ts`),
  so a `review` step on a board whose default is `implement` is told to commit, push and open a pull
  request. That is a known gap awaiting the Job's lineage column, not a decision about reviews.
- **A placeholder in the body refuses the step.** A run supplies no `--input`, so `{{page}}` cannot be
  filled, and the step is reported stalled by name rather than filed with the literal text. Nothing
  flows along an edge yet, deliberately — *features/runs-and-steps* has the reason, and it is a
  safety one.

## Known gaps

- **A proposing Job cannot file from a workflow.** `src/proposals.ts` allows a proposal to set only
  `name`, `brief` and a `maxBudgetUsd` that may go down, and `--from`/`--input` are not on that
  allowlist. This is the intended reading of ADR-011 rather than an oversight — a proposal that could
  name a workflow would be a worker choosing its successor's tool surface, which is the thing the
  allowlist is short in order to prevent — but it does mean decomposition and templating do not
  currently compose.
- **There is no verb that lists workflows.** `readTemplate` lists what is available inside the
  refusal for a workflow that is not there (`available`, `src/templates.ts:171-183`; used at `src/templates.ts:231-238`),
  which is where a person actually needs it, but discovering the set means typing a wrong name or
  listing the directory.
- ~~**Re-briefing a triage item drops its standing steps.**~~ **Closed**, and by the claim-time
  composition above rather than by a change to `queue`: `queueJob` writes only `Job.brief`
  (`src/transitions.ts:160-166`), and the standing steps are read from `Board.defaultWorkflow` when
  the attempt is claimed, so a re-briefed triage item gets them like any other Job. The gap was real
  while the steps were baked into the brief at file time.
- **One workflow per Job.** `--from` is not repeatable, deliberately: two workflows would need a rule
  for which one wins per key, and "the flag you typed wins over the file" is the only precedence
  worth asking anyone to hold (`src/hkb.ts:518-521`).
