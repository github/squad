/**
 * Containment for files Squad reads from, or writes to, a team directory that the repository
 * controls. A symlink anywhere on the path (a directory component or the file itself) may not
 * lead outside `root`; links that stay inside are fine.
 *
 * @module client/adapters/safe-path
 */

import fs from 'node:fs';
import path from 'node:path';

export class OutsideRootError extends Error {
  constructor(rel: string) {
    super(`Refusing ${rel}: it resolves outside the team directory`);
    this.name = 'OutsideRootError';
  }
}

function inside(abs: string, root: string): boolean {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve `rel` under `root` through any symlinks, following the deepest existing ancestor for a
 * path that does not exist yet. Throws {@link OutsideRootError} when the result leaves `root`.
 */
export function resolveContained(root: string, rel: string): string {
  const rootReal = fs.realpathSync(root);
  let dir = path.resolve(root, rel);
  const rest: string[] = [];
  for (;;) {
    let real: string | undefined;
    try {
      real = fs.realpathSync(dir);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) throw new OutsideRootError(rel);
      rest.unshift(path.basename(dir));
      dir = parent;
      continue;
    }
    const full = path.join(real, ...rest);
    if (!inside(full, rootReal)) throw new OutsideRootError(rel);
    return full;
  }
}

/** Read a UTF-8 file under `root`, refusing one that resolves outside it. */
export function readContained(root: string, rel: string): string {
  return fs.readFileSync(resolveContained(root, rel), 'utf8');
}
