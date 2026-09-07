---
title: Declared outputs — export, result, artifact
summary: "The three declared outputs and the one rule over them: --export to the repository, --result onto the board as a value, --artifact beside the board as a file; why an undeclared output is litter, and the syntax each refuses before a checkout is ever made."
category: features
kind: explanation
audience: [dev]
read_when: "adding or changing an output kind, asking what a Job is supposed to produce, touching the collection block at the end of a run, or wondering why a succeeded Job failed with no_output"
covers:
  - path: src/results.ts
    sha: 0fc3dc145a1c515267534909aee79f034effa61b
  - path: src/artifacts.ts
    sha: b1c001d916ec6cdd8198d978bbae1d09a2d2813d
  - path: src/worktree.ts
    sha: c0875d3a1d3f1d0cbee2737ab8d5d48bd073f3b0
  - path: src/controller.ts
    sha: 41c7fbd41f65c61a80c6fcfa9ec56236d0811a7f
  - path: src/brief.ts
    sha: 2d3db74f559f4310ccd91b7117395c24ebb398bd
  - path: src/hkb.ts
    sha: 37b4de4b924ce76c8003ffec444982eebf3f4031
  - path: src/db-url.ts
    sha: 075e55c592c972b3505f106ac670a277996f0615
  - path: prisma/schema.prisma
    sha: deb0743051f8edc773e9c2abb60960b1bcb84b25
generated_at_commit: 73ac807
last_refreshed: 2026-09-07
related: [decisions/adr-008-declared-outputs, decisions/adr-011-proposals-not-board-access, features/proposals, features/worktree-includes, architecture/job-kind, architecture/the-board]
---

# Declared outputs — export, result, artifact

> A Job says in advance what it will produce, and the board is responsible for getting
> that out of the sandbox. Everything else the run leaves behind is litter. Three
> destinations implement the rule — the repository, the board's own row, and a directory
> beside the board — and the interesting parts are the ones a `--help` will not tell you:
> why the shapes differ, why the small one is capped on purpose, and why all three names
> are refused before a worktree is ever cut.

## The rule, and what it costs

The declaration is the contract: a declared output that is not produced **fails the
attempt** (`prisma/schema.prisma:265-270`, `src/controller.ts:1100-1175`). That single rule
is what the three mechanisms exist to serve, and it is what makes `succeeded` mean more
than "a session ended" — the collection block runs after `nextPhase` has already decided
the run went fine, and can still overturn it (`src/controller.ts:1267-1268`).

What it buys is twofold. The sandbox becomes disposable: once the declared outputs are
out, whatever is left in the checkout is by definition undeclared, which is the one case
where a dirty worktree is not evidence of work worth keeping and `removeWorktree` may take
it (`src/controller.ts:1388-1399`). And absence becomes legible — a Job that produced
nothing is a fact the board can state rather than a silence an operator has to notice.

What it costs is stated where the cost lands: filing a Job now carries a decision it did
not before (what should this produce?), and the set of output kinds is closed, so
extending it is a code change on purpose rather than a per-Job schema a model can satisfy
by assertion (`docs/wiki/decisions/adr-008-declared-outputs.md`).

## Three destinations, one range

They are not a list of options. They are three points on a range whose axis is *who keeps
the thing and how big it is*:

- **Export** — a repository-relative path the run wrote inside its checkout, copied out
  into `Board.repoPath` before the worktree is torn down (`src/worktree.ts:519-553`). The
  repository keeps it, which means git keeps it, which means it will be committed.
- **Result** — a small named value the board keeps on the attempt row as a JSON object
  (`prisma/schema.prisma:490`). Capped per value (below).
- **Artifact** — a file kept in a directory beside the board, uncapped; only its catalogue
  — name, kind, size — goes onto the row (`prisma/schema.prisma:514-521`,
  `src/artifacts.ts:121-150`).

The framing that matters, and the one the module states in its own words: **an artifact is
a big result, not an uncommitted export** (`src/artifacts.ts:6-33`). Between a 4 KB value
and a path the repository commits there was a gap — an output too large to be a result and
with no business in a commit at all — and an artifact fills it from the *result* end.

The rejected alternative is worth knowing because it reads so much cheaper than it is:
give `exports` a second destination. The copy already takes one (`exportOutputs(from, to,
declared)`, `src/worktree.ts:519`), so it looks like a call-site change. It is the wrong
shape. An output that must not be committed should never be *inside* the checkout in the
first place, where it is either committed by accident or shows up as untracked noise in
every `git status` a reviewer runs — the argument `resultsDir` already makes for results
(`src/results.ts:63-73`) and `artifacts.ts` reuses verbatim (`src/artifacts.ts:23-28`).
Writing to an absolute path outside every checkout has no copy step to get wrong.

## Why the cap is the feature

`RESULT_MAX_BYTES` is 4096, **per result** (`src/results.ts:24-32`). The number is
inherited from Tekton, whose 4096 is across all of a Task's results because it rides the
Kubernetes container termination message. hkb is not squeezing through that channel, so
the constraint is per value and kept anyway — deliberately, because it is small enough
that nobody mistakes a result for file storage. A handoff that can hold a megabyte becomes
a worse artifact store than the one `exports` already is; that is the failure the cap
prevents, and routing around it reinvents it.

Which makes an oversized result a spec mistake with an obvious remedy rather than a
workaround: the value is **dropped rather than truncated**, reported as its own cause, and
the operator is told in the same sentence where it belonged (`src/results.ts:138`,
`src/results.ts:158-169`). An oversized declared value is a shortfall too, and reported as
oversize rather than silently as missing (`src/results.ts:144-147`).

An artifact has no cap and the prompt says so out loud — leaving it implicit would invite
a worker to summarise something it was asked to hand over whole (`src/brief.ts:146-167`).

## The refusals, and when they fire

All three names are checked at **declaration time**, in `hkb new`, before any worktree
exists (`src/hkb.ts:493-503`). An illegal request should never become state, and finding
the fault at file time costs nothing while finding it at collection time costs a whole
run. The export check runs a second time at copy time, because a row can arrive by routes
other than the CLI (`src/worktree.ts:526`).

The three fences differ because the three names name different kinds of place:

- A **result name** must be a plain identifier — letters, digits, dash, underscore, ≤64
  characters (`src/results.ts:46-61`). It becomes two things at once: a filename the worker
  is told to write, and a key on the JSON object the board stores. Anything that could
  traverse a directory or collide as a key is refused.
- An **artifact name** is one path segment, with dots permitted *between* segments of word
  characters (`src/artifacts.ts:49-67`). Dots are allowed where a result refuses them
  because an artifact is a file somebody opens — `report.md`, `plan.json` — and the same
  rule that admits them refuses `..` and `.hidden`. It admits no separators at all, which
  is the cheap fence: the name is a destination resolved against a per-attempt directory
  that starts empty, so there is nothing to collide with and nothing to overwrite. A
  declared name may also come back as a **directory**, which is how one artifact holds more
  than one file without needing a path syntax (`src/artifacts.ts:139`).
- An **export path** is the only one that has to police anything, and it polices a lot:
  absolute paths, `..` escapes, `.` naming the whole checkout, and the two directories that
  are not outputs — `.hkb/`, where the worktrees and the board file live, and `.git/`,
  which in a worktree is a *file* pointing at the admin directory and whose copy would
  break a checkout in a way nobody would connect back to an export declaration
  (`src/worktree.ts:460-489`). The asymmetry is the point: an export names somewhere inside
  a tree that already has contents, and the copy happens with the operator's authority and
  no agent in the loop.

## Collection, and the asymmetry in it

Before the run, the controller builds a path per declared name and creates both collection
directories — always, even when nothing was declared, because a run may volunteer
something (`src/controller.ts:855-878`). Those paths go into the prompt as **absolute**
paths, and the worker is told plainly that they are outside its checkout and will not
appear in its diff (`src/brief.ts:150-199`, `src/results.ts:82-86`,
`src/artifacts.ts:91-95`). Nothing is parsed out of a transcript and nothing arrives by
tool call: the worker writes files, the controller reads the directory.

At the end of a run, all three are collected under the same two gates — the attempt
otherwise succeeded, and the holder kept its lease to the end (`src/controller.ts:1109-1115`,
`:986`, `:1012`). A crashed or capped attempt has not finished the work, so half its
outputs being absent describes the stop it already reported rather than a second finding.
Exports resolve in two passes — plan everything, then copy — so a shortfall never leaves
half a failed run's output mixed into the repository (`src/worktree.ts:514-551`).

Then the honest asymmetry. A result's **value is read back** — `readFileSync`, trimmed,
onto the row (`src/results.ts:139`). An artifact's is not: `collectArtifacts` stats,
classifies and sizes, and never opens anything (`src/artifacts.ts:109-150`). Reading an
artifact in merely to record that it exists would give back the cap by another route,
which is the one thing an artifact exists not to have. So the row gets a catalogue and the
file stays where the worker put it.

That asymmetry propagates to lifetime. The results directory is removed unconditionally
when the attempt ends, success or failure, because the values are durable by being on the
row rather than by the file surviving (`src/controller.ts:1150-1152`,
`src/results.ts:152-155`). The artifacts directory is removed **only if it is empty** —
`rmdir` refusing a non-empty directory is exactly the test that needs making — because an
artifact's value *is* the file, so nothing else holds it (`src/artifacts.ts:177-189`,
`src/controller.ts:1172-1175`). Nothing removes a non-empty one at all, which is why the
size is walked and recorded: it is the only warning an operator gets that a board is
filling up (`src/artifacts.ts:152-175`), and `hkb show` prints both the sizes and the
directory, since an artifact is the one output whose location a human has to be told
(`src/hkb.ts:782-790`).

Both collection directories live under the board's own directory —
`boardDir()/results/<jobId>-<k>` and `boardDir()/artifacts/<jobId>-<k>`
(`src/results.ts:72-73`, `src/artifacts.ts:81-82`), where `boardDir()` is the directory
holding the board file the connection URL names (`src/db-url.ts:26-29`). Not a hardcoded
path: a board reached through `HKB_DATABASE_URL` collects beside itself.

### Two layers: declared and volunteered

Both collectors read their directory **whole** and enforce only the declared half. A
declared name is the filer's requirement and its absence fails the attempt; anything else
the run left is *volunteered* — kept, reported, never required (`src/results.ts:99-150`,
`src/artifacts.ts:109-150`). A volunteered name still has to pass the same syntax fence,
and one that does not is ignored rather than made to fail somebody else's attempt
(`src/results.ts:135`, `src/artifacts.ts:135`). The reasoning is in `collectResults`'
docblock: requiring everything means a Job cannot report something nobody thought to ask
about, and requiring nothing (freeform handoff metadata) guarantees a downstream reader
nothing at all.

## The absence signal

Two different things get called "produced nothing", and they are worth keeping apart.

**A declared output that did not arrive** ends the attempt as `no_output`, not resumable,
with the shortfall message as `lastError` and as the attempt's `reason`
(`src/controller.ts:1267-1268`, `:1099`). It outranks the gate: a run that did not produce
what it promised has nothing worth approving (`src/controller.ts:1256-1266`). Only the
first cause found is reported — export shortfall, then result, then artifact — because two
concatenated shortfalls read worse than one and mean the same thing
(`src/controller.ts:1139-1141`, `:1016-1018`). The messages are written for the person who
has to decide whose mistake it was, which is why they name the value and the remedy rather
than a code (`src/results.ts:158-169`, `src/artifacts.ts:209-215`).

**A Job that succeeded having declared nothing and opened no pull request** is the other
case, and it is not a failure. `producedNothing` is a pure predicate over a Job's already
known fields — phase, a PR on any attempt, the three declaration columns, and whether it
proposes (`src/hkb.ts:185-201`). It re-checks nothing, because a Job that reached
`succeeded` having declared any of the three produced it by construction — the collection
block would have failed it otherwise. Being pure is what lets it be tested exhaustively as
a *refusal*: the test enumerates every kind of thing that counts as having left something
behind and asserts each one turns the answer off (`test/hkb.test.ts`, `producedNothing`).
`hkb ls` renders it as a suffix on the row and one summary line, stated and not judged —
"I looked and there is nothing to change" is a real outcome; what is not acceptable is
that it reads exactly like a Job that shipped a pull request (`src/hkb.ts:628-639`).

## Known gap: the pull-request protocol is still implied by the worktree

ADR-008 decided that `isolate` returns to meaning one thing — *where* the work runs — and
that the pull-request protocol becomes one declarable output shape among several, selected
by the spec rather than implied by having a worktree
(`docs/wiki/decisions/adr-008-declared-outputs.md`). That half has not shipped. The prompt
is still assembled as: if there is a worktree, append `withProtocol` — commit, push, open a
draft PR, "work that is not pushed is work that is lost" — unless the Job proposes, in
which case it gets the sandbox note instead (`src/controller.ts:1019-1020`,
`src/brief.ts:50-100`, `src/brief.ts:286-296`).

So an isolated Job whose entire deliverable is a `--result` or an `--artifact` is told to
push work it does not have, on top of a results or artifacts contract telling it to write
somewhere outside the checkout. `withWorktree` covers only the proposing case, where the
contradiction was explicit enough to be found by printing the prompt; its own docblock
records that the general case remains open (`src/brief.ts:237-254`). Nothing about
collection depends on this — the outputs are gathered either way — but the prompt a
result-only Job reads is not the one its declaration describes.

## Related

- [ADR-008: A Job declares its outputs](../decisions/adr-008-declared-outputs.md) — the decision, and the annex on what has since been settled
- [ADR-011: Proposals, not board access](../decisions/adr-011-proposals-not-board-access.md) — the record that needed a third output kind
- [features/proposals](proposals.md) — a proposal rides the artifact channel under a name the controller fixes
- [features/worktree-includes](worktree-includes.md) — the mirror: what crosses *into* a worktree
- [architecture/the-board](../architecture/the-board.md) — the columns these declarations and catalogues live in
