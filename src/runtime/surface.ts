import type { AdmissionPolicy } from '../admission.ts';
import type { WorkerSpec } from './index.ts';

/**
 * The default tool surface, and the admission policy a driver builds from it.
 *
 * A pure module for the reason `src/limits.ts` and `src/liveness.ts` are: it is a decision with no
 * I/O in it, and the case worth testing is the refusing one. It used to live inside the Agent SDK
 * driver, where the only way to exercise the SHIPPED DEFAULT was to buy a session — so every test
 * of the gate supplied its own `allow` list and proved the code rather than the product, which is
 * the failure CLAUDE.md names. `src/runtime/fake.ts` now builds the same policy from these same two
 * functions, so "what may a Job that named no surface call" is a question a free test can ask.
 */

/**
 * A worker's whole tool surface. Paired with `permissionMode: 'dontAsk'` this is a real allowlist:
 * anything not here is denied outright rather than prompted, which is the documented pairing for a
 * headless agent ("a fixed, explicit tool surface … a hard deny over silent reliance"). The
 * admission gate enforces the same list a second time, because the mode is not always in our hands.
 *
 * **`Skill` is here, and admitting it widens nothing.** Invoking a skill is a prompt expansion —
 * layer 6 of `docs/workflow-study.md` §4, the layer that guarantees nothing — so every tool the
 * skill then reaches for arrives back at this gate at layer 2 and is judged against this same list.
 * It changes what a worker KNOWS, not what it may DO, which is ADR-012's own argument for granting
 * a plugin directory at all.
 *
 * Until it was added, no worker had ever invoked a skill — built-in, repository or user. ADR-012
 * measured that a granted plugin directory puts skills in FRONT of a worker (the init message's
 * tool count went 17 → 26); it never measured one being called, and it could not have been: `Skill`
 * was absent here, so the gate denied it and every plugin grant on every board was inert — the
 * "declaration that reads as load-bearing and does nothing" the contributor guide warns about.
 *
 * `Agent` is deliberately absent. Phase 1 runs one agent against one brief; a worker that could
 * fan out would spawn work nothing has claimed. A skill that spawns subagents (`/code-review`) is
 * the exception, and it is `Agent`'s question rather than `Skill`'s: the spawn is a tool call and
 * this list is what refuses it. The admission gate's isolation rule stays wired and tested for the
 * kind that allows it, and it reads `spec.isolated` rather than a constant — so adding `Agent` to a
 * kind's tool surface is the whole change, not the change plus the discovery that the rule was only
 * ever right for isolated Jobs.
 */
export const DEFAULT_TOOLS: readonly string[] = Object.freeze([
  'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill',
]);

/**
 * What this run may call: the surface the Job resolved to, or the shipped default.
 *
 * `undefined` is "nobody named one" and `[]` is "this Job may call nothing" — the distinction
 * `src/spec.ts` protects, and `??` is what keeps it: an empty list must NOT fall through to the
 * default.
 */
export function toolSurface(spec: Pick<WorkerSpec, 'allowedTools'>): string[] {
  // A COPY, and the constant is frozen. Both halves matter: this array is handed to the SDK, to the
  // admission gate and to the fake, and returning the module-level reference meant one `push`
  // anywhere permanently rewrote the shipped default for every later Job in the process — with no
  // board write and nothing in `hkb show` to explain it.
  return [...(spec.allowedTools ?? DEFAULT_TOOLS)];
}

/**
 * The policy the gate is built from — admission control, not instruction.
 *
 * Isolation follows the PARENT's own rather than being a constant: an isolated workload gets
 * `isolation: "worktree"` injected onto every Agent spawn, so a parent that forgets to ask for it
 * still cannot skip it, while a workload running in the operator's checkout has no worktree to
 * bring a subagent's work back to and so refuses a spawn that asks for one.
 *
 * **`spec.admission` is spread FIRST, and the two derived keys are set after it.** It used to be
 * spread last, which read as "a per-run field wins" and was wrong in the one way that matters:
 * `subagentIsolation` is already a field on `AdmissionPolicy`, so the day `WorkerSpec.admission`
 * gains it, a caller could silently override the rule computed from `spec.isolated` and an isolated
 * Job's subagents would stop getting `isolation: "worktree"` injected — their work landing in the
 * parent's worktree, or in a throwaway one, which is the failure the rule exists to prevent. The
 * surface is not a per-run override either: it is the resolved spec, and nothing may widen it.
 */
export function admissionPolicy(
  spec: Pick<WorkerSpec, 'allowedTools' | 'isolated' | 'admission'>,
): AdmissionPolicy {
  return {
    ...spec.admission,
    subagentIsolation: spec.isolated === false ? 'forbid' : 'force',
    allow: toolSurface(spec),
  };
}

/**
 * Which skills this run may invoke, as `Options.skills` — and it is a **fence**, not a convenience.
 *
 * ADR-012's rule is that nothing reaches a worker the operator did not grant it, and admitting
 * `Skill` to the surface above broke it in a way the first implementation did not measure. ADR-012's
 * own Consequences section records what a worker is advertised with `settingSources: []` and no
 * grant at all: *"17 user-level skills, 5 agents, 4 claude.ai MCP connectors and 52 slash commands,
 * none of them permitted"*. **"None of them permitted" was true only because `Skill` was off the
 * surface.** Put it on, leave this unset, and every ordinary Job — no `--plugin-dir` anywhere near
 * it — can invoke the operator's own `~/.claude` skills: content nobody granted, on a repository
 * hkb is running an agent against precisely because nobody has read it yet.
 *
 * **ADR-012 measurement 7 says this option narrows nothing, and that is no longer true.** At the
 * pinned 0.3.261 the SDK documents the opposite (`sdk.d.ts`): a `string[]` enables *only* the listed
 * skills, and *"unlisted skills are hidden from the model's listing and rejected by the Skill
 * tool"*. The measurement and the shipped contract disagree; the contract is what runs. That record
 * wants a fresh measurement and probably a superseding one — this is a note, not a quiet edit to it.
 *
 * ## Two spellings per skill, and why that is not belt-and-braces
 *
 * `sdk.d.ts` again: an entry matches *"the exact canonical name (e.g. `my-plugin:my-skill`) or a
 * `:name` suffix of it"*. Whether a granted skill is canonically `prisma-cli` or
 * `<plugin>:prisma-cli` depends on how the SDK names a local plugin, which hkb does not control and
 * has not measured. Emitting both `name` and `:name` matches either, so the fence does not depend
 * on the answer — and no guess here can fail open, because a name that matches nothing enables
 * nothing.
 *
 * `[]` when the surface does not carry `Skill`: an operator who narrowed with `--allow-tool
 * Read,Bash` has said no, and the SDK must hear it too rather than only the gate.
 *
 * The SDK's own caveat, restated because it bounds the claim: *"This is a context filter, not a
 * sandbox: unlisted skills are hidden from the model's listing and rejected by the Skill tool, but
 * their files remain on disk and are reachable via Read/Bash."* That is a property of granting
 * `Bash` at all, not something this fence undoes.
 */
export function skillFilter(granted: string[], surface: string[]): string[] {
  if (!surface.includes('Skill')) return [];
  const names = [...new Set(granted.map((n) => n.trim()).filter(Boolean))].sort();
  return names.flatMap((n) => [n, `:${n}`]);
}
