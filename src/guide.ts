import fs from 'node:fs';
import path from 'node:path';

import { resolveInRepo } from './inputs.ts';

/**
 * `guide` — the contributor guide a worker was never given, and the cost ADR-012 named.
 *
 * ADR-012 refused `settingSources: ['project']` and was right to: that flag loads
 * `.claude/settings.json`, whose hooks are `{ type: 'command', command: string }` — shell commands
 * the repository's author wrote, run on the operator's machine at every tool call. **The refusal is
 * not reconsidered here.** What is reconsidered is the conclusion drawn from it, that a worker
 * therefore cannot have the repository's `CLAUDE.md` either.
 *
 * ## Measured, 2026-09-06, at SDK 0.3.261
 *
 * There is no purpose-built escape hatch. The SDK's documentation is explicit — *"CLAUDE.md loading
 * is controlled by setting sources, not by the `claude_code` preset"*, and it is *"not loaded if you
 * pass an empty `settingSources` array"*. Probed both ways to be sure: with `settingSources: []` a
 * worker asked this project's Node floor answers `UNKNOWN`; with `['project']` it answers
 * `>=22.18.0`. So the file really is unreachable through the SDK on the terms ADR-012 set.
 *
 * But nothing about that requires **hkb** not to read it. The SDK's own route for CLAUDE.md is to
 * read the file and inject its content *into the conversation* rather than the system prompt, which
 * is a thing this project can do for itself with `fs.readFileSync` — and doing it here rather than
 * through a flag has three properties the flag does not:
 *
 * 1. **It is a document, not an executable.** The whole of ADR-012's argument is that `settings.json`
 *    is a program; a markdown file cannot be one.
 * 2. **It resolves against `Board.repoPath`, never the worktree** — the same fence as a plugin grant
 *    and a `file:` input, so a worker cannot write the guide its own next attempt is steered by.
 *    A human merge is the boundary.
 * 3. **It is portable** (value 1). A guide hkb reads and puts in the prompt reaches any runtime; one
 *    the Agent SDK loads reaches only the Agent SDK.
 *
 * ## Why it is a grant rather than a default
 *
 * A repository's own prose steering a worker is the same *kind* of thing as a repository's own
 * skills, and ADR-012 decision 2 made that a path the operator names. So this is a path too:
 * `Board.defaultGuide` turns it on for a board, `Job.guide` overrides, and neither is set by
 * default. The friction is one command per board, and it buys an operator who can see, in
 * `hkb show`, exactly which document is being put in front of a model with their authority.
 */

/**
 * The cap. Generous next to an input's 64 KB because a guide is *the* thing worth paying for on
 * every request — but a cap all the same: a 200 KB CLAUDE.md is a document nobody wrote for a model
 * to read, and silently truncating it would leave the half that got through looking authoritative.
 */
export const GUIDE_MAX_BYTES = 128 * 1024;

/** How many `@import` lines deep this follows. One: enough for `CLAUDE.md` → `AGENTS.md`. */
export const GUIDE_IMPORT_DEPTH = 1;

/** A bare `@path` on its own line — CLAUDE.md's import syntax, and the only line form it has. */
const IMPORT = /^@([^\s]+)\s*$/;

export type Guide = { text: string; files: string[] };

/**
 * One file, with the guide's own cap rather than an input's.
 *
 * Checked per file as well as on the whole, so a single enormous import is refused where it is
 * rather than as a mysterious total — and so a guide cannot be assembled out of pieces that each
 * pass a check nothing applies to the sum.
 */
function read(repoPath: string, rel: string): { text: string } | { why: string } {
  const found = resolveInRepo(repoPath, rel);
  if ('why' in found) return found;
  if (found.bytes > GUIDE_MAX_BYTES) {
    return { why: `${rel} is ${found.bytes} bytes, over the ${GUIDE_MAX_BYTES}-byte cap` };
  }
  return { text: fs.readFileSync(found.path, 'utf8') };
}

/**
 * Read a guide out of the board's repository, following its imports one level, or say why not.
 *
 * Returns `{ why }` rather than throwing for the same reason `readFileInput` does: the caller is the
 * controller, and a guide that cannot be read is an attempt that fails before anything is spent —
 * not an exception that unwinds a reconcile pass.
 *
 * **An import that cannot be read is dropped, not fatal.** The distinction is between what the
 * operator named and what the document happened to reference: the named file is the grant and its
 * absence is a fault in the spec, while a stale `@some-file.md` inside it is the repository's own
 * business and no reason to refuse the rest. The dropped ones are named in `files` by omission, and
 * `hkb show` prints what was actually read.
 */
export function readGuide(repoPath: string, rel: string): Guide | { why: string } {
  const first = read(repoPath, rel);
  if ('why' in first) return { why: `the guide ${rel} could not be read: ${first.why}` };

  const files = [rel];
  const seen = new Set([path.normalize(rel)]);
  let text = first.text;

  for (let depth = 0; depth < GUIDE_IMPORT_DEPTH; depth++) {
    const out: string[] = [];
    let grew = false;
    for (const line of text.split('\n')) {
      const m = IMPORT.exec(line.trim());
      // `@` also begins an npm scope and an email address, so only a whole line counts, and only one
      // that resolves to a file in this repository. Anything else is prose and stays prose.
      if (!m) { out.push(line); continue; }
      const target = path.normalize(path.join(path.dirname(rel), m[1]));
      if (seen.has(target)) { out.push(line); continue; }
      const got = read(repoPath, target);
      if ('why' in got) { out.push(line); continue; }
      seen.add(target);
      files.push(target);
      out.push(`<!-- ${target} -->`, got.text.trimEnd());
      grew = true;
    }
    text = out.join('\n');
    if (!grew) break;
  }

  const bytes = Buffer.byteLength(text);
  if (bytes > GUIDE_MAX_BYTES) {
    return {
      why: `the guide ${rel} is ${bytes} bytes once its imports are followed, over the ${GUIDE_MAX_BYTES}-byte cap`
        + ' — a guide is paid for on every request of every run, so it has to stay something a model can hold',
    };
  }
  return { text, files };
}

/** What `hkb show` prints, and what a Job that named a guide it cannot read owes the operator. */
export function missingGuide(id: number, why: string): string {
  return `#${id} ${why}, so the attempt failed before it started: a Job told to read a guide that is not there `
    + 'would run without the rules it was supposed to follow, which is worse than not running.';
}
