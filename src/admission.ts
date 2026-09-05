import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';

/**
 * Admission control.
 *
 * The Kubernetes piece this is named after, and the name is doing real work: an admission
 * controller validates or mutates a request *before* it is persisted, so an illegal request never
 * becomes state. Nobody enforces PodSecurityPolicy by writing "please don't run as root" in the
 * container's README.
 *
 * We learned that the hard way. A previous fan-out told its parent, in the prompt, to spawn every
 * subagent with `isolation: "worktree"`. The run reported success and the subagents were not
 * isolated at all — they read files that exist only in the main checkout's working tree. The
 * instruction was followed exactly as reliably as an instruction can be, which is to say not
 * reliably enough to be an invariant.
 *
 * So: `isolate` is not asked for. It is **injected** into the tool input at admission, on the
 * `allow` branch. And a policy may refuse a spawn outright, which the model sees as a tool error
 * and must work around rather than ignore.
 */

export type AdmissionPolicy = {
  /** Force `isolation: "worktree"` onto every Agent spawn. */
  forceIsolation?: boolean;
  /**
   * Called for every Agent spawn. Return a reason to refuse it, or null to let it through.
   * This is where a graph kind puts its dependency rule: the ordering stops being something the
   * parent is asked to respect and becomes something it cannot violate.
   */
  admitSpawn?: (input: Record<string, unknown>) => Promise<string | null> | (string | null);
  /** Tools nothing may ever call, whatever the prompt says. */
  deny?: string[];
  onDecision?: (decision: string) => void;
};

export function admissionController(policy: AdmissionPolicy = {}): CanUseTool {
  const denied = new Set(policy.deny ?? []);

  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    if (denied.has(toolName)) {
      policy.onDecision?.(`deny ${toolName} (policy)`);
      return { behavior: 'deny', message: `${toolName} is not available in this workload.` };
    }

    if (toolName !== 'Agent') return { behavior: 'allow' };

    const refusal = await policy.admitSpawn?.(input);
    if (refusal) {
      policy.onDecision?.(`deny Agent — ${refusal}`);
      return { behavior: 'deny', message: refusal };
    }

    if (policy.forceIsolation !== false && input.isolation !== 'worktree') {
      policy.onDecision?.(`mutate Agent — isolation injected (was ${JSON.stringify(input.isolation ?? null)})`);
      // Mutating admission: the spawn is allowed, but not as it was requested.
      return { behavior: 'allow', updatedInput: { ...input, isolation: 'worktree' } };
    }

    policy.onDecision?.('allow Agent');
    return { behavior: 'allow' };
  };
}
