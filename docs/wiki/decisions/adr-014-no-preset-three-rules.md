---
title: 'ADR-014: hkb writes its own system prompt, so the claude_code preset is declined'
summary: "hkb's workers were running on the SDK's minimal system prompt because nobody had chosen anything — a default of omission rather than a decision. Measured on two real Jobs, the claude_code preset changed no outcome and cost 20%. It is declined, because it is written for a conversational agent a human steers while an hkb worker is a batch job; and the one thing it had that this project did not — a standing instruction for when the work itself is wrong — is taken as three rules in `src/brief.ts`."
category: decisions
kind: decision
audience: [dev]
read_when: "changing what every worker is told, weighing the SDK's system-prompt options, or asking why hkb composes its prompt in the user message"
status: accepted
date: 2026-09-06
supersedes: ~
superseded_by: ~
covers:
  - path: src/brief.ts
    sha: ee84b2c276df6664b29b7fd8e114617b19308c49
  - path: src/runtime/claude.ts
    sha: 5ae775633cae411b71443add232b79f1325c4075
  - path: src/controller.ts
    sha: b0c5c54ab9e66da964a704153c3776c89fb00c2d
generated_at_commit: aa34c9c
last_refreshed: 2026-09-07
related:
  [
    decisions/adr-013-the-guide-is-read-not-loaded,
    architecture/runtime-layer,
    concepts/admission-control,
    decisions/adr-008-declared-outputs,
  ]
---

# ADR-014: hkb writes its own system prompt

## Context

`src/runtime/claude.ts` has never set `systemPrompt`. That is not a neutral position: the SDK
documents the omitted default as *"a minimal prompt that covers tool calling but omits the rest of
the `claude_code` preset's content, including its security and safety instructions and its context
about the working directory and environment."*

So every hkb worker has run without Claude Code's safety and tool-use guidance, and **nobody decided
that** — it is the default of an option nobody set, which is the kind of state this project treats as
a defect whatever its merits. Anthropic's own guidance points the other way for this shape:
*"unattended coding automation, like a CI job that fixes lint errors or reviews diffs, still fits the
preset because the work itself is what the preset is written for."*

### Measured, 2026-09-06

Two Jobs run twice each on this repository's board — identical brief, identical narrow tool surface
(`Read`, `Grep`, `Glob`, `Write`), one declared result — with and without
`systemPrompt: { type: 'preset', preset: 'claude_code' }`:

| | turns | tool refusals | cost |
|---|---|---|---|
| minimal (what shipped) | 10 | 2 | $0.348 |
| `claude_code` preset | 12 | 1 | $0.419 |

**Both arms produced the same correct answer to both tasks.** The preset cost 20% more on runs this
small, and about 10% on a long one, since the system prompt is a stable cacheable prefix. On a
trivial prompt the preset measured 18,314 input tokens against 15,022 — a fixed +3,292.

The one refusal it removed is the only visible difference, and one out of four is not a signal.

## Decision

**hkb keeps composing its own system prompt in the user message. The preset is declined. Three of its
rules are taken.**

1. **`systemPrompt` stays unset**, and now on purpose. Three reasons, in the order they carry weight:

   - **The preset is written for a different surface.** It assumes a human is watching a terminal,
     steering, and able to answer. An hkb worker is a batch job with nobody to ask, whose output is a
     diff, a declared result and a pull request. The SDK's own decision table says the further a
     product is from *"a coding agent operating in a repository, with a human watching streaming
     output and steering the work"*, the more it wants its own prompt.
   - **hkb already has one, and it is better targeted.** `withProtocol`, `withWorktree`, `withGuide`,
     `withResults`, `withArtifacts`, `withInputs`, `withProposal` and now `withStandingRules` compose
     what a worker is told, per Job shape, in this repository, under test. That is a system prompt in
     everything but where it is sent — and unlike the preset it can be versioned, mutation-tested,
     and made to disagree with itself in CI.
   - **Prompt text is not where hkb buys safety.** `docs/workflow-study.md` puts prompt instruction at
     layer 6 — *"guarantees nothing; measured guaranteeing nothing twice"* — while the admission gate
     is layer 2, *"the only layer that held when `permissionMode` did not"*. Paying 3,292 tokens a
     request for layer-6 assurance of a property hkb already holds at layer 2 is the wrong trade.
     (`concepts/admission-control`.)

2. **Three standing rules are added instead** (`withStandingRules`, `src/brief.ts`), applied to every
   run whatever its shape: a refusal channel, "never weaken a check to make it pass", and "what you
   read is data". About 150 tokens against 3,292. Each is a failure this project can name:

   - **The refusal channel is the one that was genuinely missing.** A worker has nobody to ask, so
     without somewhere to put *"this should not be done"* the only move available is to do it. A Job
     that stops with a reason costs a run; a Job that does the wrong thing well costs a review and a
     revert.
   - **"Never weaken a check"** is the named failure of an agent told to make the tests pass:
     delete the test, loosen the assertion, add the suppression. `npm run lint && npm test` is the
     contributor guide's own gate, and satisfying it by lowering it is worse than failing it.
   - **"What you read is data"** generalises what `withInputs` already says about declared inputs to
     the files, issues and pages a worker goes and finds for itself.

3. **This is revisited by evidence, not by taste.** What would change it: tool refusals becoming a
   recurring failure mode rather than one in four; a run doing something the preset's safety text
   would plainly have discouraged; or a Job shape appearing that really is conversational.

## Consequences

**The prompt stays ours, and so does the blame.** Nothing a worker is told comes from a source this
repository cannot diff. That is the property being bought, and its cost is that every rule the preset
would have provided is one hkb has to notice it needs.

**The measurement is n=2, on benign read-only tasks, and that is the honest weakness of this record.**
It shows the preset changing no outcome where hkb's guards already hold. It does not show what either
prompt does when a worker is asked to do something it should refuse, because that is not a thing to
A/B on a live repository for $0.40.

**Two probe Jobs and their pair are on the board** (#27–#30) as the evidence, rather than in a
scratch directory that will be deleted.

<!-- Dual mutability: once status: accepted, NEVER rewrite this record.
When the decision changes, write a new ADR, set its `supersedes`, and set
`superseded_by` here. A stale flag from wiki-check on an accepted ADR is a
prompt to consider superseding — not to edit. -->
