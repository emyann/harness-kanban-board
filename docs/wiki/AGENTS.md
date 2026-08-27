# docs/wiki — schema & maintenance rules

This directory is an **LLM-maintained wiki** of hkb: concepts,
architecture, feature histories, decisions, and hard-won gotchas.

It applies Karpathy's llm-wiki pattern to a codebase: the immutable source
layer is the repo itself, so provenance means **code citations + blob-SHA
drift tracking** instead of copied sources. Read this file fully before
creating or editing any page here.

## Core principle: the wiki is *derived*, the code is the source of truth

- **Code wins every conflict.** If a page disagrees with the code, the page is
  wrong — fix the page, never "fix" your understanding to match it.
- A page is a **distillation**, not a copy. Never restate code that an agent
  rediscovers in one `grep`/`glob` (file structure, signatures, line-by-line
  logic). The test: *if an agent can find it in 30 seconds, it does not belong
  here.*
- The wiki carries what is **expensive to rediscover**: the *why*, cross-cutting
  concepts no single file owns, feature histories, and non-obvious gotchas.
- **Do not store what an agent can regenerate from code in under a minute.**
  There is deliberately no `reference/` category: API references, file listings
  and signature tables are recomputed on demand, not curated.
- **No session or task state.** Active-context notes, progress logs and TODOs
  belong in your agent's native memory or the issue tracker — never here. That
  content rots fastest and poisons trust in the rest. The one sanctioned
  sibling is `FINDINGS.md` (see below): one-line pointers to suspected code
  defects, held under their own contract — never inside pages.

## This is an orientation layer — not an authority on specifics

When working anywhere in this repo, treat the wiki as a **map**: consult it for
*where to look* and *why things are the way they are*, then **verify specifics
against the code** before relying on them. A page may name a symbol or path
that has since moved. The freshness machinery (below) bounds — but does not
eliminate — that drift.

## Citation discipline (the rule that keeps the wiki trustworthy)

Every concrete claim about the codebase **must** carry an inline citation to
the file it came from, in backticks:

- `` `src/services/payment/processRefund.ts:120-145` ``
- `` `config/pipeline.yml` `` (file-level is fine for broad claims)

If you cannot cite a claim — because it is runtime behaviour you cannot read,
an assumption, or something you did not verify — **do not state it as fact**.
Either drop it, or prefix the line with:

```
> TODO-VERIFY: <claim> — <what needs checking>
```

Never narrate runtime behaviour you have not read in the code.

## Scope

The runtime the CLI ships: bin, src, the kanban skill, hooks, harness templates, release/smoke scripts and the serve dashboard. Excluded by policy: test/ (the suite documents itself), docs/ (prose, not source), board-local state (.kanban) and package plumbing.

See `wiki.config.yml` for the authoritative include/exclude globs and the page
plan. That file is machine-read by the check scripts — keep it accurate.

## Directory layout

| Item | Holds |
|---|---|
| `index.md` | **GENERATED** catalog — never hand-edit; run `node .repolore/scripts/wiki-index.mjs` |
| `log.md` | Append-only journal: one line per notable wiki operation (page added/refreshed/superseded) |
| `GLOSSARY.md` | Project vocabulary — short, alphabetical, cited where a term maps to code |
| `FINDINGS.md` | Findings inbox — one-line pointers to suspected code defects awaiting triage; outside page semantics (see below). Created on first finding, with consent |
| `architecture/` | System structure: context, components/containers, deployment topology, message flow |
| `concepts/` | Domain concepts no single file owns (cross-cutting models, invariants, naming) |
| `features/` | Feature histories — what a feature is for, what it touched, current status, known gaps |
| `flows/` | Runtime views — diagrams of how a request/job/sync actually executes |
| `decisions/` | ADR-style decision records — context, decision, consequences (see dual mutability below) |
| `gotchas/` | Hard-won, non-obvious knowledge that misled or cost someone time |
| `howto/` | Runbooks and operational procedures (deploys, manual triggers, recovery) — task knowledge not derivable from code |
| `_templates/` | Page templates — not real pages, skipped by tooling |

Trim categories you don't need; an empty folder is a standing invitation, not
an obligation. A **soft page budget** (50 pages, tuned in
`wiki.config.yml`) keeps the wiki curated — `wiki-check.mjs` warns when you
exceed it; merge or archive rather than sprawl.

## Page frontmatter schema

Every page starts with this frontmatter. Use `_templates/page.md` as the base
(`_templates/decision.md` for `decisions/`).

```yaml
---
title: Human-readable title
summary: One line — rendered verbatim in the generated index.md.
category: architecture | concepts | features | flows | decisions | gotchas | howto
kind: explanation        # explanation | how-to | reference-table | decision (Diátaxis mode)
audience: [dev]          # who the page serves; see "audience" below
read_when: "touching payments, refunds, or the retry queue"   # retrieval hint for agents
covers:                  # source files this page is derived from
  - path: src/services/payment/processRefund.ts
    sha: WRITTEN-BY-wiki-stamp
generated_at_commit: abc1234   # short HEAD SHA — written by wiki-stamp
last_refreshed: 2026-01-01     # written by wiki-stamp
related: [concepts/retry-model, flows/refund-flow]   # other pages, by category/slug
---
```

`related` lists other pages by `category/slug`; entries **may** reference
planned-but-unwritten pages (they double as drafting prompts) — no tooling
validates them, so prune dead ones when you touch a page.

There is **no `status:` field**. Freshness status is *computed* by
`wiki-check.mjs` on demand — committing volatile check-state only creates
dirty trees and merge conflicts. The durable, reader-visible signal is
`generated_at_commit` + `last_refreshed`, written at refresh time.

Unknown frontmatter keys are ignored by all tooling — connectors and
extensions may add their own.

### `covers` and freshness — how staleness is detected

`covers` lists the source files a page was distilled from, each with the
**git blob SHA** the file had when the page was written. `wiki-check.mjs`
re-hashes every covered file and compares: a mismatch means the source moved
on and the page is **stale**.

**Never compute SHAs by hand.** After writing or refreshing a page, run:

```bash
node .repolore/scripts/wiki-stamp.mjs <path/to/page.md>
```

It re-hashes every `covers` path and updates `generated_at_commit` /
`last_refreshed` in one step. Stamping **blesses** the page — it asserts the
prose reflects the code as it is right now — so stamp *after* refreshing
content, never instead of it.

A page with an empty `covers` list is reported `unmanaged`: its staleness
cannot be detected, which defeats the point. Pages with no meaningful code
anchor (pure domain explanations) should still cover the nearest config or
entry-point file they describe.

### Coverage — the freshness blind spot, and the new-page trigger

Freshness only re-hashes files a page *already lists*. It is blind to source
files **no page covers at all** — a whole feature can ship with no page and
nothing flags it. `node .repolore/scripts/wiki-coverage.mjs` inverts the
question: it enumerates in-scope source files (from `scope:` in
`wiki.config.yml`) and reports which ones no page covers, grouped by
directory, flagging «page-worthy» clusters (routes/, services/, functions/…).

The rule: **a new feature gets a new page (or extends an existing one).** When
you ship a capability, add or extend the page that owns it and list its files
in `covers`, so freshness can track it from then on.

Both checks can run automatically after every commit — a non-blocking nudge
that prints only when something needs attention:
`node .repolore/scripts/wiki-install-hook.mjs` (once per contributor; hooks are
not cloned with repos; `--uninstall` to remove).

### `index.md` is generated

Page summaries live in exactly one place: the page's own frontmatter. After
adding, removing, retitling or re-summarising a page, run:

```bash
node .repolore/scripts/wiki-index.mjs
```

Never edit `index.md` by hand; `wiki-index.mjs --check` reports drift.

### `log.md` — the wiki's journal

Append one line per notable wiki operation, newest last:

```
## 2026-01-01 — added features/refund-pipeline (new refund feature shipped)
```

It gives future sessions recency awareness for free. Append-only; never
rewrite history. Verbs: added / refreshed / superseded / archived /
**audited** / triage departures. The `audited` verb is also a machine
signal — the audit workflow's due-list and the check workflow's dust line
parse `## YYYY-MM-DD — audited <category/slug> (N claims: …)` — so audited
lines are strict: ONE page per line, never batched, and appending one
asserts every claim on that page was individually verdicted (audit-by-rote
erodes the same trust refresh-by-rote does).

### `GLOSSARY.md` — the vocabulary layer, and its feeding rule

One line per term, alphabetical, cited where the term maps to a symbol,
table, or config key. The feeding rule: **coin no term without recording
it** — every domain term a page defines or leans on either already has a
glossary line or gains one in the same change. A term that outgrows one
line gets a `concepts/` page, and its glossary line links there. An empty
glossary in a wiki with written pages means terms are being coined without
being recorded — the check workflow reports it as a smell.

### `FINDINGS.md` — the findings inbox (relay buffer, not a tracker)

Drafting and refreshing pages means reading code attentively — and that
reading surfaces suspected defects (bugs, security gaps, inconsistencies) as
a by-product. Pages must never carry them as task state; losing them is
worse. They go to `FINDINGS.md`, a sibling of `GLOSSARY.md`: committed and
team-visible, but **outside page semantics** — no frontmatter, no `covers`,
ignored by freshness, coverage, the index and the page budget.

A finding asserts something no page may assert: that the code is wrong
relative to intent. Treat every item as a **claim to re-verify**, not a fact.
One line per item (the v2 grammar — a superset of v1; one regex,
line-parseable):

```
- [sec|bug|cleanup] **headline** — evidence `path:lines` <!-- repolore:sha=<blob7> captured=YYYY-MM-DD --> → category/slug
```

- The HTML comment is the **per-item anchor**: the evidence file's short
  blob SHA when the item was last affirmed, invisible on GitHub so the
  10-second human jot survives — humans may omit it entirely; the next
  triage backfills it (a lint, never a gate). `captured` means "last
  affirmed against code", not "first observed" (first observation lives in
  git history).
- Backfill anchors from the **recording commit**
  (`git rev-parse <commit>:<path>`), never from today's blob — a today-blob
  backfill erases the source-moved triage signal.
- **Absence findings** ("no X anywhere") carry
  `<!-- repolore:unanchored captured=YYYY-MM-DD -->` — no file to hash is a
  label, not a hole. Triage vocabulary for anchors: *source-moved /
  anchor-intact / unanchored / legacy* (never fresh/stale/unmanaged — those
  are page words). v1 lines and checkbox lines parse as *legacy*; triage
  converts them.
- The `→` backlink names the page that carries the full, cited context. The
  inbox line is a pointer; the page is the evidence — never duplicate.
- Claims not verified in the code carry `(unverified — <what needs
  checking>)`, mirroring `> TODO-VERIFY:`.
- Page≠code wrongness NEVER enters the inbox — the audit workflow fixes the
  page, demotes the claim, or files the page into the page plan; the inbox
  asserts code≠intent only.
- **Writes are consented.** Agents append findings inside the same
  reviewable commit as the page work that surfaced them; humans jot
  one-liners anytime. Check scripts and hooks never write here, and nothing
  ever blocks on untriaged findings.
- **Triage deletes, never checks off.** Each item leaves through one of four
  exits — fix it now, promote it into the owning page or a gotcha, file it
  in the issue tracker, or dismiss it with a reason — and the departure gets
  one `log.md` line. An item that survives triage must be re-affirmed
  against the current code, not skipped. The moment an item needs an
  assignee, a status, or discussion, its exit is the issue tracker.

Create the file with consent the first time a finding has nowhere to go —
an empty inbox should not exist.

### `decisions/` — dual mutability

Every other page is **living** (refreshed in place). Decision records are
**immutable-with-supersession**: once `status: accepted`, never rewrite the
decision — write a new record and link them via `superseded_by` / `supersedes`.
When `wiki-check.mjs` flags an accepted decision stale (its covered files
changed), that is a prompt to *consider a superseding record*, not to edit the
old one.

### `flows/` — generated diagrams, verified edges

A flow page is **structured data** (`flow_*` frontmatter) from which the Mermaid
diagram and step/edge/branch tables are *generated* by
`.repolore/scripts/wiki-flow-render.mjs` into a delimited `FLOW-RENDER` region —
**never hand-author the diagram**. `flow_render:` picks the projection of that
one model: `flowchart` (default) or `sequence`. The tier (structural → anchored →
edge-cited → branch-audited → set-validated) is computed by `wiki-flow-check.mjs`
on every run, never written to the page.

**Verified vs inferred — the honest line.** Mark an edge `verified` only when you
can cite the **call site in the caller's own code** (`call_anchor_path` equals the
from-step's `anchor_path`), within ≤40 lines, naming the callee (`callee_token`) —
this proves the from→to hop, not just that bytes exist somewhere. When the hop is
real but uncitable that way (dynamic dispatch, plain statement sequence,
cross-file indirection), mark it `inferred` — an honest claim, like `> TODO-VERIFY:`.
A sub-50% verified ratio caps the tier at `structural`.

**Authoring loop** (one named scenario per page, schematic not exhaustive; flows
are never seeded at init — born only when explicitly drafted):

1. Copy `_templates/flow.md` (the full field schema lives there); write the
   `flow_*` steps/edges/branches against real code, including error paths.
2. `node .repolore/scripts/wiki-flow-render.mjs <page>` — fills the region + a JSON sidecar.
3. `node .repolore/scripts/wiki-stamp.mjs <page>` — writes the blob SHAs.
4. `node .repolore/scripts/wiki-flow-check.mjs <page>` — must reach at least `anchored`.
5. Add the page to the plan (`pages:` in `wiki.config.yml`) and `log.md`.

**Stale flow pages refresh diff-scoped.** When a covered file moves, run
`node .repolore/scripts/wiki-flow-refresh.mjs <page> --apply` first: it fixes
every citation whose cited bytes are provably unchanged (identical or merely
shifted) and leaves the rest at their old SHA, so `wiki-flow-check.mjs` then
fails on exactly the citations that still need re-verification. Re-verify those
against the diff, re-render, and only then stamp.

The deep reference — two-anchor `async`/`queue`/`event` edges, diff-scoped
refresh, and the user-space set-equality extractor contract — is
`references/flow.md` (not needed for basic authoring).

## `audience` and per-audience sections

`audience` records who a page serves. Default is `[dev]` — developers working
in the repo. Projects that serve other readers (operators, support staff,
admins) configure extra audiences at init; a page serving `[dev, ops]` carries
a short, clearly-bounded `## For ops` section near the end: what that reader
sees, where it surfaces, what to check first when it misbehaves. The developer
content stays primary — never build a separate parallel wiki (it doubles
maintenance and can't be freshness-tracked).

## Workflow: writing a new page

1. Copy `_templates/page.md` into the right category folder. Filename is a
   kebab-case slug (`refund-pipeline.md`).
2. Research the topic **from the code**, not from memory or other docs.
3. Write the distillation. Every concrete claim gets a citation; unverified
   claims get `> TODO-VERIFY:`.
4. Fill `covers` with every source file you drew from (paths only), then run
   `node .repolore/scripts/wiki-stamp.mjs <page>` to write the SHAs.
5. Add or update `GLOSSARY.md` lines for every domain term the page defines
   or leans on (cited; link the page for terms it owns).
6. If researching the page surfaced suspected code defects, record each as
   one `FINDINGS.md` line in the same change (creating the file with consent
   if absent) — the page's gap note or `> TODO-VERIFY:` carries the
   evidence; the inbox line is the pointer.
7. Run `node .repolore/scripts/wiki-index.mjs` to regenerate the index, and
   append a line to `log.md`.
8. Run `node .repolore/scripts/wiki-check.mjs` — the new page must report `fresh`.
9. If the page isn't in the page plan (`pages:` in `wiki.config.yml`), add it.

## Workflow: refreshing a stale page

1. Run `node .repolore/scripts/wiki-check.mjs` to list stale pages and which
   covered files changed.
2. For each stale page, diff what actually changed — the recorded SHA gives an
   exact baseline: `git diff <old-sha> <new-sha>` (or `git log --follow -p
   <path>` since `generated_at_commit`). Then triage:
   - **No-op** — cosmetic churn (formatting, comments, renames that don't touch
     the page's claims): just re-stamp.
   - **Targeted edit** — update the affected prose and citations; re-verify
     every citation you touch; demote unconfirmable claims to `> TODO-VERIFY:`.
   - **Rewrite** — the feature changed shape; re-research from the code.
3. Add newly-relevant files to `covers`; drop deleted ones.
4. If re-verifying citations surfaced new suspected defects, append them to
   `FINDINGS.md` in the same change (one line each, per the inbox rules).
5. Run `wiki-stamp.mjs <page>`, regenerate the index if title/summary changed,
   append to `log.md`. Update glossary lines whose terms the refresh renamed
   or retired.
6. Re-run `wiki-check.mjs` — the page must return to `fresh`. Commit the
   refresh as a normal reviewable change.

## What NOT to do

- Do not copy whole code files or doc files in here. Distil.
- Do not write specifics (symbol names, line numbers) without a citation.
- Do not hand-edit `index.md`, or hand-compute `covers` SHAs.
- Do not re-stamp a stale page without re-reading the diff ("refresh-by-rote"
  erodes every citation's trust).
- Do not add `status:` / `last_checked:` fields — status is computed.
- Do not store session state, TODOs, or auto-generatable reference here.
- Do not put checkboxes, severity ranks, or remediation directives inside
  pages — one `FINDINGS.md` line plus a descriptive gap note in the page is
  the split.
- Do not let the page plan (`pages:` in `wiki.config.yml`) drift from reality — `wiki-check.mjs` flags the drift.
