import { query, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Runtime, RunStatus, RuntimeEvent, WorkerOutcome, WorkerSpec } from './index.ts';
import { admissionHooks } from '../admission.ts';
import { discoverSkills } from '../plugins.ts';
import { admissionPolicy, skillFilter, toolSurface } from './surface.ts';

/**
 * The Claude Agent SDK driver.
 *
 * The whole worker is one `for await` loop. That is the part worth noticing, because of what it
 * deletes from the old design: there is no pid to record, no background-job id to reconcile on
 * the next tick, and no worktree path to recover the worker's identity from. The loop either
 * yields or it throws, so liveness is the promise — not a heartbeat column and a 180-second
 * reclaim timer.
 *
 * That simplification is real but bounded, and the bound is why the session id is captured from
 * the `init` message rather than at the end: it holds only while THIS process lives. If the
 * runtime dies mid-run the iterator dies with it, and `resume: <sessionId>` is the only way back
 * to the work. The session id must be in hand before the run ends, not after it.
 */

/** How long an interrupted turn is given to wind down and report before the transport is killed. */
const INTERRUPT_GRACE_MS = 20_000;

/**
 * Map the SDK's terminal states onto ours. The three resumable ones are the point.
 *
 * `terminal_reason` is read FIRST and it is not decoration. An interrupted turn can come back with
 * `subtype: 'success'` — which would be recorded as `completed`, the worst failure available on a
 * board whose entire claim is that `succeeded` means something. `aborted_streaming` / `aborted_tools`
 * are how the SDK says "this ended because somebody stopped it".
 */
function statusOf(result: SDKResultMessage | null, threw: boolean, timedOut: boolean): RunStatus {
  const aborted = result && 'terminal_reason' in result
    && (result.terminal_reason === 'aborted_streaming' || result.terminal_reason === 'aborted_tools');
  if (aborted || timedOut) return 'timeout';
  if (!result) return 'error';
  if (result.subtype === 'success') {
    return 'stop_reason' in result && result.stop_reason === 'refusal' ? 'refused' : 'completed';
  }
  if (result.subtype === 'error_max_turns') return 'max_turns';
  if (result.subtype === 'error_max_budget_usd') return 'max_budget';
  void threw;
  return 'error';
}

/**
 * Everything the SDK is told, as a value — so it can be asserted without buying a session.
 *
 * Extracted for the reason `./surface.ts` was, one step further along. That module made the shipped
 * tool surface testable; this makes the fact that the surface REACHES the SDK testable, which is a
 * different claim and was the one still resting on a paid, out-of-CI measurement. Deleting
 * `allowedTools` from this object used to leave the whole suite green, because the only importer of
 * `claudeRuntime` is a live test that skips without an API key.
 *
 * `abortController` is a parameter rather than built here: it is the one field that is a live object
 * the caller has to keep hold of, and a function that made its own would hand back an options bag
 * whose cancellation nothing could reach.
 */
export function queryOptions(spec: WorkerSpec, abortController: AbortController): Options {
  const tools = toolSurface(spec);
  // The gate's list and the SDK's list are deliberately NOT the same value. `Skill` stays on the
  // gate's surface — it is a tool call and admission judges it — while `Options.allowedTools` must
  // not carry it: `sdk.d.ts` deprecates that spelling twice and points at `Options.skills`, which
  // is "the single place to turn skills on". Leaving it here would work today and stop working on
  // the SDK bump that drops the deprecated handling, silently, with no failing test — which is the
  // exact bug this card was filed to fix, returning by another door.
  const advertised = tools.filter((t) => t !== 'Skill');
  return {
      cwd: spec.cwd,
      // ---- the workspace, provisioned by the harness rather than by us.
      //
      // `Options` has no worktree field, but `extraArgs` is documented as "Additional CLI arguments
      // to pass to Claude Code" and the SDK spawns that executable — so the flag is reachable, and
      // it was measured to be rather than assumed: through the SDK, `extraArgs: { worktree }`
      // created `.claude/worktrees/<name>` on branch `worktree-<name>`, took a `git worktree lock`
      // on it for the run, and reported the path back on the `init` message.
      //
      // **This is an untyped escape hatch**, and that is the one thing to know about it: a flag
      // renamed upstream fails silently rather than at compile time. `test/runtime-workspace.test.ts`
      // is the answer — it asserts a worktree actually appears, which is the only kind of proof
      // this arrangement admits.
      //
      // What it buys is everything `src/worktree.ts` used to do by hand: creation, the base kept
      // current, `.worktreeinclude` for gitignored files, the lock against a concurrent sweep, and
      // a periodic sweep that keeps anything still holding work.
      ...(spec.workspace ? { extraArgs: { worktree: spec.workspace.name } } : {}),
      model: spec.model,
      maxTurns: spec.maxTurns,
      // The runaway-cost stop, and it covers subagent spend too. Without it an open-ended
      // card ("improve this codebase") has no ceiling but the turn count.
      maxBudgetUsd: spec.maxBudgetUsd,
      effort: spec.effort,
      // Auto-approved without consulting the gate. `Agent` is deliberately absent: a spawn is
      // exactly the call admission exists to mutate, so it must reach the callback.
      allowedTools: advertised,
      // The fence, and the reason `Skill` is not in `allowedTools` above (`skillFilter`). Only the
      // skills the operator actually granted, in both spellings the SDK accepts — `[]` when nothing
      // was granted, which is what closes the door ADR-012 says must be shut by default.
      skills: skillFilter(discoverSkills(spec.plugins ?? []), tools),
      resume: spec.resume,
      abortController,
      // Admission control, not instruction — and it follows the parent's own isolation rather
      // than being a constant. An isolated workload gets `isolation: "worktree"` injected onto
      // every Agent spawn, so a parent that forgets to ask for it still cannot skip it. A
      // workload running in the operator's checkout has no worktree to bring a subagent's work
      // back to, so there the gate refuses a spawn that asks for one instead of forcing every
      // spawn into a checkout that would be thrown away with its work still in it. The policy
      // itself is `./surface.ts`, and `src/runtime/fake.ts` builds it from the same function.
      hooks: admissionHooks(admissionPolicy(spec)),
      // **`dontAsk`, not `bypassPermissions`.** A worker has nobody to answer a prompt, so both
      // modes avoid prompting — but they are not equivalent:
      //
      //   - `allowedTools` does NOT constrain `bypassPermissions`. The docs are explicit: listing
      //     Read alongside bypass "still approves every tool, including Bash, Write, and Edit".
      //     The allowlist above would be decoration.
      //   - Subagents inherit the parent's mode, and a definition cannot override `bypassPermissions`
      //     — so bypass would hand every future subagent full autonomous system access.
      //   - `dontAsk` denies anything unlisted instead of prompting, which is the documented
      //     pairing for a headless agent and what a denial should look like: visible in
      //     `permission_denials`, not a silent approval.
      //
      // The gate is unaffected either way: hooks run FIRST in the evaluation order, before deny
      // rules, ask rules, the mode and allow rules.
      permissionMode: 'dontAsk',
      // The repository's own skills, granted rather than assumed (ADR-012). This is the half of
      // `settingSources: ['project']` that is wanted, without the half that is not: measured at
      // 0.3.261, a local plugin reaches the same skills with `settingSources` still empty, and a
      // settings file would additionally hand the repository a shell command to run here.
      ...(spec.plugins?.length ? { plugins: spec.plugins.map((p) => ({ type: 'local' as const, path: p })) } : {}),
      // Do not inherit the operator's CLAUDE.md / settings into a worker: the card is the brief.
      // The cost of that choice is real and worth knowing — compaction summarises older history,
      // so on a long card the acceptance criteria in the opening prompt can be summarised away,
      // whereas CLAUDE.md is re-injected on every request. If cards start running long, this is
      // the line to revisit.
      //
      // It is no longer the line that decides SKILLS, though, and that is ADR-012: the two were
      // believed coupled and are not. What it still decides is CLAUDE.md — the SDK requires
      // `'project'` for it — so this repository's contributor guide reaches a worker only
      // insofar as `src/brief.ts` restates it. That cost is named in ADR-012 and unsolved.
      settingSources: [],
      // **Nothing reaches a worker that the operator did not grant it**, which is the whole of
      // ADR-012 — and `settingSources: []` above turns out not to be enough to say it.
      //
      // Measured 2026-09-06 by reading the session's own `init` message: with `settingSources: []`
      // a worker was offered four **claude.ai MCP connectors** — the operator's Gmail, Drive and
      // Calendar among them. They ride the login rather than the filesystem, so no setting source
      // excludes them, and the SDK's own documentation says `mcpServers: {}` does not suppress
      // them either. A repository's `.mcp.json` IS gated by `settingSources` and was absent; the
      // operator's own connectors were not.
      //
      // The allowlist and the admission gate would have refused the calls — an `mcp__…` tool is
      // not in `DEFAULT_TOOLS` — so this was never an open door. It was a set of tool definitions
      // in every worker's context that nobody chose, on a Job that could widen `--allow-tool` and
      // reach them. With this flag the init message lists no servers at all.
      strictMcpConfig: true,
      // **Attribution off, as a setting rather than as a sentence.** Every worker used to be
      // asked in prose not to add a `Co-Authored-By` trailer, a `Claude-Session:` URL or a
      // "Generated with" line, and prose is layer 6 of `docs/workflow-study.md` §4 — the one that
      // guarantees nothing. It matters more than most prose does: these are public repositories,
      // and a session URL published in a commit leaks a private transcript link that cannot be
      // unpublished by amending the commit.
      //
      // The SDK owns the behaviour, so the SDK is where it is turned off. An empty string is the
      // documented "hide it" value for both fields, and `sessionUrl: false` drops the trailer a
      // web or Remote Control session would otherwise append. A worker that adds one by hand can
      // still do so; what is gone is the default that added it without being asked.
      settings: { attribution: { commit: '', pr: '', sessionUrl: false } },
  };
}

export const claudeRuntime: Runtime = {
  name: 'claude',

  async run(spec: WorkerSpec, onEvent?: (e: RuntimeEvent) => void): Promise<WorkerOutcome> {
    let sessionId: string | null = null;
    let timedOut = false;
    let announced = false;
    let result: SDKResultMessage | null = null;
    let error: string | null = null;

    // The wall-clock stop, in two stages: ask, then insist.
    //
    // Aborting alone kills the transport before any result arrives, so `total_cost_usd` is never
    // reported and a stalled thirty-minute run contributed **nothing** to the board's spend
    // ceiling — a hole in the exact guard that exists for it. An interrupt ends the turn properly:
    // a result comes back, with real cost and a resumable session id.
    //
    // `interrupt()` is attempted, never depended on. The SDK's own comment says control requests
    // are "only supported when streaming input/output is used", but it was measured working on a
    // string prompt (stdin closes only at the first result, so the control channel stays writable).
    // Either way the abort still lands after the grace window, so an SDK that stops honouring this
    // degrades to exactly today's behaviour rather than to a hang.
    //
    // The operator's stop (`spec.signal`, from `hkb down`) takes the same two stages, for the same
    // reason: a shutdown that abandons the transport loses the cost of everything the worker just
    // did, and loses it from the ceiling as well as from the record.
    const abortController = new AbortController();
    let insist: ReturnType<typeof setTimeout> | null = null;
    let stopping = false;
    const stopNow = (why: string) => {
      if (stopping) return;
      stopping = true;
      onEvent?.({ kind: 'text', taskId: spec.taskId, text: `${why} — interrupting` });
      void Promise.resolve()
        .then(() => stream.interrupt())
        .catch(() => { /* unsupported, or the turn already ended */ })
        .finally(() => {
          insist = setTimeout(() => abortController.abort(), INTERRUPT_GRACE_MS);
          if (typeof insist.unref === 'function') insist.unref();
        });
    };
    const timer = spec.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          stopNow('wall clock reached');
        }, spec.timeoutMs)
      : null;
    const onStop = () => stopNow('stopped by the operator');
    if (spec.signal?.aborted) queueMicrotask(onStop);
    else spec.signal?.addEventListener('abort', onStop, { once: true });
    let workspacePath: string | null = null;
    const stream = query({
      prompt: spec.prompt,
      options: queryOptions(spec, abortController),
    });

    // `query()` yields the error result and THEN throws. Catching outside the loop would lose
    // the result we already have — including the session id, which is exactly what a resumable
    // failure needs. So the throw is caught and kept beside the result, not instead of it.
    try {
      for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id;
          // Where the session really landed. Asked for by name, answered with a path — so a
          // workspace the harness placed somewhere we did not predict is still the place the
          // declared outputs are collected from. Read off the same message the session id is.
          if (spec.workspace && typeof message.cwd === 'string') workspacePath = message.cwd;
        }
        else if (!sessionId && 'session_id' in message && message.session_id) sessionId = message.session_id;

        if (!announced && sessionId) {
          announced = true;
          onEvent?.({ kind: 'started', taskId: spec.taskId, sessionId });
        }
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'tool_use') onEvent?.({ kind: 'tool', taskId: spec.taskId, name: block.name });
            if (block.type === 'text' && block.text.trim()) {
              onEvent?.({ kind: 'text', taskId: spec.taskId, text: block.text.trim().slice(0, 160) });
            }
          }
        }
        // Do not break here: a few trailing system events arrive after the result.
        if (message.type === 'result') result = message;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      if (timer) clearTimeout(timer);
      if (insist) clearTimeout(insist);
      // The caller's signal outlives this run — a daemon reuses one for its whole shutdown — so the
      // listener has to come off, or every Job of a long-lived process leaks one onto it.
      spec.signal?.removeEventListener('abort', onStop);
    }

    const status = statusOf(result, error !== null, timedOut);
    onEvent?.({ kind: 'ended', taskId: spec.taskId, status });

    return {
      status,
      ok: status === 'completed',
      sessionId,
      // `result` is only present on the success variant.
      text: result && result.subtype === 'success' ? String(result.result ?? '') : '',
      costUsd: result?.total_cost_usd ?? 0,
      turns: result?.num_turns ?? 0,
      durationMs: result?.duration_ms ?? 0,
      stopReason: result && 'stop_reason' in result ? (result.stop_reason ?? null) : null,
      denials: result?.permission_denials?.length ?? 0,
      // A timed-out run that still reported keeps its real cost, which is the point of interrupting
      // rather than aborting: `costUsd` above comes from the result, and that is what reaches the
      // board's spend ceiling.
      error: timedOut ? `wall clock: ${spec.timeoutMs}ms${result ? ' (interrupted, reported)' : ' (aborted)'}` : error,
      workspacePath,
    };
  },
};
