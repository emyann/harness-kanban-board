import fs from 'node:fs';
import path from 'node:path';

/**
 * Plugin grants — how a repository's own skills reach a worker (ADR-012).
 *
 * A worker runs with `settingSources: []` (`src/runtime/claude.ts`), which is why it sees none of
 * the skills the repository it is working in carries. The obvious fix is `settingSources:
 * ['project']`, and it is the wrong one: that flag loads `.claude/settings.json` too, and a hook in
 * a settings file is a **shell command** the repository author wrote and hkb would run on the
 * operator's machine. Loading a repository's settings is not trusting a document, it is executing
 * the repository.
 *
 * Measured at SDK `0.3.261`: `plugins: [{ type: 'local', path: '<repo>/.claude' }]` puts exactly the
 * same skills in front of a worker with `settingSources` still empty. So the two are separable, and
 * hkb takes the half it wants.
 *
 * **Called `plugins` and not `skills`, because that is what it grants.** A plugin directory was
 * measured to load commands as well as skills, and the SDK documents plugins as providing "custom
 * commands, agents, skills, and hooks". A column named `skills` would say less than it does, which
 * is the shape of the five inert declarations this project has already had to delete.
 */

/** A grant, off the `Json?` column, defensively. Repo-relative paths; anything else is dropped. */
export function pluginList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim());
}

/**
 * A grant path, normalised — or a refusal.
 *
 * Repo-relative, and checked at file time for the reason `checkExportPath` is: a grant is a thing
 * the board acts on with the operator's authority, and it is resolved into an absolute path with no
 * agent in the loop. Stored relative rather than absolute so a board survives being moved, and so
 * the containment rule has something to be relative *to*.
 */
export function checkPluginPath(raw: string): string {
  const rel = String(raw ?? '').trim();
  const refuse = (why: string): never => {
    const e = new Error(
      `${why} Grant a directory inside the repository, as in \`--plugin-dir .claude\`.`,
    ) as Error & { exitCode: number };
    e.exitCode = 2;
    throw e;
  };
  if (!rel) refuse('a plugin path is empty — there is no directory it could name.');
  if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel)) {
    refuse(`the plugin path ${JSON.stringify(raw)} is absolute. A grant is relative to the board's repository, so that moving the board does not silently point it somewhere else.`);
  }
  const norm = path.normalize(rel).replace(/[\\/]+$/, '');
  if (!norm || norm === '.') {
    refuse(`the plugin path ${JSON.stringify(raw)} names the whole repository. The directory to grant is the one that CONTAINS \`skills/\` — \`.claude\`, not the repository root, which was measured to load nothing.`);
  }
  if (/^\.\.([\\/]|$)/.test(norm)) {
    refuse(`the plugin path ${JSON.stringify(raw)} escapes the repository — a grant is not a licence to load from anywhere.`);
  }
  if (norm === '.git' || norm.startsWith(`.git${path.sep}`)) {
    refuse(`the plugin path ${JSON.stringify(raw)} is inside .git — the repository's plumbing, not a plugin.`);
  }
  if (norm === '.hkb' || norm.startsWith(`.hkb${path.sep}`)) {
    refuse(`the plugin path ${JSON.stringify(raw)} is inside .hkb/ — the board's own directory, and never a place a Job reads from.`);
  }
  return norm.split(path.sep).join('/');
}

/**
 * Resolve the grants against the repository they are relative to, dropping any that no longer hold.
 *
 * **Against `Board.repoPath` and never the worktree**, which is the whole security property. A
 * worker writes in its worktree; if a grant resolved there, a Job could write `.claude/hooks/` and
 * have its own next attempt execute it, with no human in between. Resolved against the repository,
 * the only way to change what a grant loads is a merge — a review boundary rather than a mechanical
 * one, which is exactly why it should be the only one and should be explicit (ADR-012).
 *
 * The syntax fence in `checkPluginPath` is half the check; this is the half a syntax rule cannot
 * make. A symlinked grant is resolved and refused if what it points at is outside the repository,
 * the same question `refuseOutside` asks of an export.
 *
 * A grant that does not exist is **dropped, not thrown**: a board outlives the directories it names,
 * and a Job that cannot run because a skill directory was deleted is a worse failure than one that
 * runs without it. The caller reports what it dropped.
 */
export function resolvePlugins(repoPath: string, granted: string[] | null): { paths: string[]; dropped: string[] } {
  const out = { paths: [] as string[], dropped: [] as string[] };
  if (!granted?.length) return out;
  let root: string;
  try {
    root = fs.realpathSync(repoPath);
  } catch {
    return { paths: [], dropped: [...granted] };
  }
  for (const rel of granted) {
    const abs = path.resolve(root, rel);
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      out.dropped.push(rel);
      continue;
    }
    // Outside the repository once the links are followed, or not a directory at all.
    if (real !== root && !real.startsWith(root + path.sep)) { out.dropped.push(rel); continue; }
    if (!fs.statSync(real).isDirectory()) { out.dropped.push(rel); continue; }
    out.paths.push(real);
  }
  return out;
}
