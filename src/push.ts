/**
 * `push` — the one line of the sandbox contract that is enforced rather than asked for.
 *
 * "Never push to the default branch" was prose in `src/brief.ts`, and prose is layer 6 of
 * `docs/workflow-study.md` §4: *"guarantees nothing; measured guaranteeing nothing twice"*. The
 * study's own rule is that determinism belongs at the lowest layer that can REFUSE, and for a tool
 * call that layer is 2 — `src/admission.ts`, the `PreToolUse` hook that already reads every `Bash`
 * call a worker makes. This module is the decision it asks; the gate is what carries it out.
 *
 * **Pure, and the refusing case is the case that matters**, which is why it is a module of its own
 * rather than a regex in the hook: `src/limits.ts`, `src/liveness.ts` and `src/spec.ts` are the
 * pattern, and a guard that is only ever tested for what it ALLOWS is how this project shipped three
 * checks that did nothing.
 *
 * ## What is allowed, and it is a short list
 *
 * The worker owns exactly one branch — the attempt's own — and nothing else on the remote is its
 * business. So a push is admitted when every refspec it names targets that branch, and refused
 * otherwise: the default branch by name, some other Job's attempt branch, `--all`, `--mirror`, a
 * refspec with a glob in it, a delete. A plain `--force` is refused **even to its own branch**,
 * because `--force-with-lease` is the same operation with the one guarantee that matters (nothing
 * arrived since you last looked) and there is no case where the worker wants the version without it.
 *
 * ## Conservative, and it says so out loud
 *
 * A shell line can hide a push behind an expansion (`$(…)`, backticks), a nested shell
 * (`sh -c "git push …"`) or an alias. None of those can be understood from a string, so the answer
 * is a refusal that names the form that works rather than a guess that admits it. The cost of a
 * false refusal is one retry with a plainer command; the cost of a false admission is a force-push
 * over somebody's trunk.
 *
 * It is deliberately NOT a `git` re-implementation. It reads the argv the way `git push` documents
 * it — options, then a remote, then refspecs — and refuses anything it cannot place.
 */

/** Who this worker is, for the purpose of deciding what it may push. */
export type PushPolicy = {
  /** The attempt's own branch. The only ref on the remote this worker may write. */
  branch: string;
  /** The repository's default branch, from the same place `baseRef` reads it. */
  defaultBranch: string;
};

/** The two forms that work, named in every refusal so the next command is the right one. */
const allowed = (p: PushPolicy): string =>
  `\`git push -u origin ${p.branch}\`, or \`git push --force-with-lease origin ${p.branch}\` `
  + 'if you have rewritten your own history.';

/**
 * Split a command line into segments of tokens, or `null` when it cannot be read as one.
 *
 * `null` is not a failure to handle later — it is the answer *"this line may contain anything"*, and
 * the caller turns it into a refusal when the line mentions a push at all. Anything that can expand
 * at run time (`$`, a backtick) makes the whole line unreadable, because what a worker typed and
 * what the shell runs are then different strings.
 */
export function scan(command: string): string[][] | null {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let cur = '';
  let started = false;
  const end = () => { if (started) { tokens.push(cur); cur = ''; started = false; } };
  const cut = () => { end(); if (tokens.length) segments.push(tokens); tokens = []; };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === '\\') {
      if (i + 1 >= command.length) return null;
      cur += command[++i];
      started = true;
      continue;
    }
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) return null;
      cur += command.slice(i + 1, close);
      started = true;
      i = close;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let body = '';
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === '\\') { body += command[++j] ?? ''; continue; }
        // Inside double quotes an expansion still expands, so the same rule applies.
        if (command[j] === '$' || command[j] === '`') return null;
        body += command[j];
      }
      if (j >= command.length) return null;
      cur += body;
      started = true;
      i = j;
      continue;
    }
    // Expansion, command substitution, process substitution: unreadable by construction.
    if (c === '$' || c === '`') return null;
    if (c === ' ' || c === '\t') { end(); continue; }
    if (c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') { cut(); continue; }
    if (c === '>' || c === '<') {
      // A redirection, not a new command — but what follows it is a filename rather than a refspec,
      // so the segment ends here. The file descriptor in front of it (`2>`) goes with it, or a bare
      // `2` would be read as something this worker asked to push.
      end();
      if (tokens.length && /^\d+$/.test(tokens[tokens.length - 1])) tokens.pop();
      cut();
      continue;
    }
    cur += c;
    started = true;
  }
  cut();
  return segments;
}

/** Git's own options that sit before the subcommand and swallow the next token. */
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
/** `git push` options that swallow the next token, so it is not a refspec. */
const PUSH_OPT_WITH_VALUE = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);

/** `git … push …` → the arguments after `push`, or null when this `git` is running something else. */
function pushArgs(tokens: string[], at: number): string[] | null {
  for (let j = at + 1; j < tokens.length; j++) {
    const t = tokens[j];
    if (!t.startsWith('-')) return t === 'push' ? tokens.slice(j + 1) : null;
    if (GIT_GLOBAL_WITH_VALUE.has(t)) j++;
  }
  return null;
}

/**
 * May this `Bash` command run? A reason to refuse it, or null.
 *
 * Answers `null` fast for the overwhelming majority of calls, which mention no push at all: the
 * gate runs on every tool call of every worker, so the common path is two regexes.
 */
export function checkPush(command: string, policy: PushPolicy): string | null {
  if (typeof command !== 'string' || !/\bgit\b/.test(command) || !/\bpush\b/.test(command)) return null;

  const segments = scan(command);
  if (!segments) return unreadable(policy);

  for (const tokens of segments) {
    // A push inside one token is a push inside another shell — `sh -c "git push origin main"`, or a
    // string handed to something that will run it. The quoting is gone by now, so what is left is
    // one token that contains a whole command, and it is not this module's to parse.
    if (tokens.some((t) => /(?:^|[;&|]\s*)git\s+(?:-\S+\s+)*push(?:\s|$)/.test(t))) return unreadable(policy);
    let read = false;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== 'git') continue;
      const args = pushArgs(tokens, i);
      if (!args) continue;
      read = true;
      const why = refuse(args, policy);
      if (why) return why;
    }
    // `git` and `push` in one command and no push we could read: an alias, a wrapper, a `-C` form
    // with an option we do not know. Refused rather than admitted — this is the whole conservative
    // half, and it is the half that decides whether the guard is a guard.
    if (!read && tokens.includes('git') && tokens.some((t) => t === 'push')) return unreadable(policy);
  }
  return null;
}

const unreadable = (p: PushPolicy): string =>
  'hkb cannot tell what this `git push` would push, so it is refused: a push behind a variable, a '
  + 'substitution or another shell is not something this gate can read. Write it as a plain '
  + `command — ${allowed(p)}`;

/** One `git push`, as argv. The refusal, or null. */
function refuse(args: string[], p: PushPolicy): string | null {
  const refspecs: string[] = [];
  let remote = false;
  let force = false;
  let lease = false;
  let del = false;
  let broad: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') continue;
    if (a.startsWith('-') && a !== '-') {
      if (a === '-f' || a === '--force') force = true;
      else if (a === '--force-with-lease' || a.startsWith('--force-with-lease=')) lease = true;
      else if (a === '-d' || a === '--delete') del = true;
      else if (a === '--all' || a === '--mirror' || a === '--tags' || a === '--follow-tags') broad = a;
      else if (PUSH_OPT_WITH_VALUE.has(a)) i++;
      continue;
    }
    // The first bare word is the remote; everything after it is a refspec.
    if (!remote) { remote = true; continue; }
    refspecs.push(a);
  }

  if (broad) {
    return `\`git push ${broad}\` pushes more than your own branch, and \`${p.branch}\` is the only branch `
      + `this worker may write. Push it by name: ${allowed(p)}`;
  }
  if (del) {
    return 'a worker does not delete branches on the remote — what it pushed is what a human reads. '
      + `To publish your work: ${allowed(p)}`;
  }
  if (force && !lease) {
    return 'a plain `--force` is refused, on your own branch as much as on anybody else\'s: it overwrites '
      + 'whatever arrived since you last looked, without noticing. `--force-with-lease` is the same '
      + `operation and it refuses instead — ${allowed(p)}`;
  }
  if (!refspecs.length) {
    return 'a push with no branch named pushes whatever this checkout happens to be on, which is not '
      + `something this gate can check. Name it — ${allowed(p)}`;
  }

  for (const spec of refspecs) {
    // A leading `+` is a force in refspec spelling, and it is the version with no lease in it.
    if (spec.startsWith('+')) {
      return `\`${spec}\` is a forced refspec, which is \`--force\` by another spelling and refused for the `
        + `same reason: it overwrites what arrived since you last looked. ${allowed(p)}`;
    }
    const colon = spec.indexOf(':');
    const target = colon === -1 ? spec : spec.slice(colon + 1);
    const name = target.replace(/^refs\/heads\//, '');
    if (!name || name.includes('*') || name.startsWith('refs/')) {
      return `\`${spec}\` does not name one branch this gate can check. ${allowed(p)}`;
    }
    if (name === p.defaultBranch) {
      return `\`${spec}\` pushes to \`${p.defaultBranch}\`, this repository's default branch. A worker never `
        + 'writes the trunk: it pushes its own branch and a human decides what happens to it. '
        + `${allowed(p)}`;
    }
    if (name !== p.branch) {
      return `\`${spec}\` pushes to \`${name}\`, and this attempt owns \`${p.branch}\` and nothing else — another `
        + `branch belongs to another Job, or to somebody. ${allowed(p)}`;
    }
  }
  return null;
}
