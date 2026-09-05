import type { HookCallbackMatcher, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

/**
 * Admission control.
 *
 * The Kubernetes piece this is named after, and the name does real work: an admission controller
 * validates or mutates a request *before* it is persisted, so an illegal request never becomes
 * state. Nobody enforces PodSecurityPolicy by writing "please don't run as root" in the
 * container's README.
 *
 * ---
 *
 * **Why this is a `PreToolUse` hook and not `canUseTool`.**
 *
 * `canUseTool` is the obvious home for this and it does not work. Measured, twice, with the SDK
 * saying so itself:
 *
 *   1. Under `permissionMode: 'bypassPermissions'` the SDK warns
 *      `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED: canUseTool will not be invoked` — every call is
 *      auto-approved before the callback is consulted.
 *   2. Under `permissionMode: 'default'`, any **bare name in `allowedTools`** shadows the callback
 *      for that tool, with the same warning naming each one.
 *
 * Both warnings end with the same instruction: *"To gate every tool call, use a PreToolUse hook."*
 * A probe with no `allowedTools` at all and a deny-everything `canUseTool` still ran `Read` and
 * never invoked the callback, so the hook is not a stylistic preference — it is the mechanism that
 * fires.
 *
 * The hook's `hookSpecificOutput` carries both halves we need: `permissionDecision: 'deny'` is the
 * validating gate, and `updatedInput` is the mutating one.
 */

export type AdmissionPolicy = {
  /**
   * What happens to `isolation` on an Agent spawn. It has to follow the PARENT's isolation,
   * because a subagent worktree is only worth anything if there is a parent worktree to bring it
   * back to:
   *
   *   - `'force'` (the default, and what an isolated workload wants): `isolation: "worktree"` is
   *     injected onto every spawn, so a parent that forgets to ask for it still cannot skip it.
   *   - `'forbid'`: the workload is running in the operator's own checkout — it has no worktree,
   *     so a spawn that asks for one would do its work in a throwaway checkout that nothing reads
   *     and nothing merges. The spawn is refused rather than quietly sent there. Spawns that ask
   *     for nothing are left alone: they inherit the parent's cwd, which is where the work belongs.
   */
  subagentIsolation?: 'force' | 'forbid';
  /**
   * Called for every Agent spawn. Return a reason to refuse it, or null to let it through.
   * This is where a graph kind puts its dependency rule: ordering stops being something the
   * parent is asked to respect and becomes something it cannot violate.
   */
  admitSpawn?: (input: Record<string, unknown>) => Promise<string | null> | (string | null);
  /** Tools nothing may ever call, whatever the prompt says. */
  deny?: string[];
  /**
   * The whole tool surface. A tool not on this list is denied *by the hook*, not by the permission
   * mode — because the mode is not always in our hands. Measured: in a session nested inside another
   * Claude Code process, `permissionMode: 'dontAsk'` with `Agent` absent from `allowedTools` still
   * ran `Agent`. Hooks run first in the evaluation order and are client-side, so this is the one
   * layer that held. Leave undefined to enforce nothing here and let the mode decide.
   */
  allow?: string[];
  onDecision?: (decision: string) => void;
};

const allow = (): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
});

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
  },
});

const mutate = (input: Record<string, unknown>): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: input },
});

/** The policy, as a callback. Exported for tests — production wires it via `admissionHooks`. */
export function admissionCallback(policy: AdmissionPolicy = {}) {
  const denied = new Set(policy.deny ?? []);

  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const tool = input.tool_name;
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

    if (denied.has(tool)) {
      policy.onDecision?.(`deny ${tool} (policy)`);
      return deny(`${tool} is not available in this workload.`);
    }

    if (policy.allow && !policy.allow.includes(tool)) {
      policy.onDecision?.(`deny ${tool} (not on the allowlist)`);
      return deny(`${tool} is not part of this workload's tool surface. Available: ${policy.allow.join(', ')}.`);
    }

    if (tool !== 'Agent') return allow();

    const refusal = await policy.admitSpawn?.(toolInput);
    if (refusal) {
      policy.onDecision?.(`deny Agent — ${refusal}`);
      return deny(refusal);
    }

    if ((policy.subagentIsolation ?? 'force') === 'forbid') {
      if (toolInput.isolation === 'worktree') {
        policy.onDecision?.('deny Agent — isolation requested by a workload that has none');
        return deny(
          'This workload runs in the operator\'s own checkout, so a subagent worktree would leave its '
          + 'work in a throwaway checkout nobody reads. Spawn it again without `isolation` — it will '
          + 'run where this session is running. If the work needs a branch of its own, the Job has to '
          + 'ask for one: file it with `kb new` and without `--no-isolate`.',
        );
      }
    } else if (toolInput.isolation !== 'worktree') {
      policy.onDecision?.(`mutate Agent — isolation injected (was ${JSON.stringify(toolInput.isolation ?? null)})`);
      return mutate({ ...toolInput, isolation: 'worktree' });
    }

    policy.onDecision?.('allow Agent');
    return allow();
  };
}

/** What goes in `Options.hooks`. One matcher, every tool, because a gate with holes is not a gate. */
export function admissionHooks(policy: AdmissionPolicy = {}): { PreToolUse: HookCallbackMatcher[] } {
  const cb = admissionCallback(policy);
  return { PreToolUse: [{ hooks: [(input) => cb(input)] }] };
}
