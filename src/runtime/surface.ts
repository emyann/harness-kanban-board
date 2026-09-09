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
export const DEFAULT_TOOLS = [
  'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill',
];

/**
 * What this run may call: the surface the Job resolved to, or the shipped default.
 *
 * `undefined` is "nobody named one" and `[]` is "this Job may call nothing" — the distinction
 * `src/spec.ts` protects, and `??` is what keeps it: an empty list must NOT fall through to the
 * default.
 */
export function toolSurface(spec: Pick<WorkerSpec, 'allowedTools'>): string[] {
  return spec.allowedTools ?? DEFAULT_TOOLS;
}

/**
 * The policy the gate is built from — admission control, not instruction.
 *
 * Isolation follows the PARENT's own rather than being a constant: an isolated workload gets
 * `isolation: "worktree"` injected onto every Agent spawn, so a parent that forgets to ask for it
 * still cannot skip it, while a workload running in the operator's checkout has no worktree to
 * bring a subagent's work back to and so refuses a spawn that asks for one.
 *
 * `spec.admission` is spread last, but it carries no `allow` — the surface is not a per-run
 * override, it is the resolved spec.
 */
export function admissionPolicy(
  spec: Pick<WorkerSpec, 'allowedTools' | 'isolated' | 'admission'>,
): AdmissionPolicy {
  return {
    subagentIsolation: spec.isolated === false ? 'forbid' : 'force',
    allow: toolSurface(spec),
    ...spec.admission,
  };
}
