/**
 * Resolve the deterministic `squad_state` MCP launch spec shared by init and
 * upgrade.
 *
 * Resolution order:
 *   1. Standalone bundle launcher.
 *   2. Direct `node <absolute dist/cli-entry.js> state-mcp` for npm global or
 *      local installs.
 *   3. Exact running package version through npx.
 *
 * Dist-tags are intentionally never written. Registry mirrors frequently omit
 * `insider` and `preview`, while an installed entry point or exact version is
 * deterministic.
 *
 * 1 and 2 are paths on this machine. Files a repository commits (`.mcp.json`,
 * host MCP configs, `.claude/settings.json` hooks) use
 * {@link resolveCommittedSquadStateMcpSpec} instead, which swaps them for a
 * portable form (#2462).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SQUAD_REPO_LAUNCHER_MARKER,
  SQUAD_REPO_LAUNCHER_PATH,
  squadRepoLauncher,
} from '@bradygaster/squad-sdk/client';

export interface SquadStateMcpSpec {
  command: string;
  args: string[];
  /**
   * `standalone`, `local-entry`: paths on this machine. `pinned`: exact-version npx.
   * `repo-launcher`: `node <squad dir>/bin/squad.mjs`, committed with the repository.
   * `path`: a bare `squad` from PATH (standalone bundle installs, which may have no Node).
   */
  source: 'standalone' | 'local-entry' | 'pinned' | 'repo-launcher' | 'path';
  /** Portable exact-version fallback recorded beside machine-local specs. */
  fallback?: {
    command: 'npx';
    args: string[];
  };
}

const PACKAGE_NAME = '@bradygaster/squad-cli';

/** Retained as the shared projection hook; direct local specs stay direct. */
export function projectSquadStateMcpSpec(
  spec: SquadStateMcpSpec,
  _platform: NodeJS.Platform = process.platform,
): SquadStateMcpSpec {
  return spec;
}

/** Environment variable exported by standalone bundle launchers. */
export const STANDALONE_HOME_ENV = 'SQUAD_STANDALONE_HOME';

export interface ResolveSquadStateMcpSpecOptions {
  standaloneCheck?: () => string | null;
  localEntryCheck?: () => string | null;
}

/** Reset internal caches (test-only compatibility helper). */
export function _resetMcpSpecCache(): void {
  // The resolver no longer probes or caches registry state.
}

/** Locate the launcher of the standalone bundle this CLI is running from. */
export function detectStandaloneLauncher(): string | null {
  const home = process.env[STANDALONE_HOME_ENV];
  if (!home) return null;
  const candidates = process.platform === 'win32'
    ? ['squad.exe', 'squad.cmd', 'squad.ps1']
    : ['squad'];
  for (const candidate of candidates) {
    const full = path.join(home, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

/**
 * Locate the installed JavaScript entry point that launched this CLI.
 *
 * Source checkouts use their built `dist/cli-entry.js` when present. This
 * keeps init/doctor fixtures and contributor builds offline-safe without
 * teaching Node to execute the TypeScript entry directly.
 */
export function detectInstalledCliEntry(): string | null {
  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
  if (
    invoked &&
    path.basename(invoked).toLowerCase() === 'cli-entry.js' &&
    existsSync(invoked)
  ) {
    return invoked;
  }

  const currentFile = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(currentFile);
  const candidates = [
    path.resolve(moduleDir, '..', '..', 'cli-entry.js'),
    path.resolve(moduleDir, '..', '..', '..', 'dist', 'cli-entry.js'),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? null;
}

/** Resolve the squad_state launch spec for the running CLI version. */
export async function resolveSquadStateMcpSpec(
  cliVersion: string,
  options: ResolveSquadStateMcpSpecOptions = {},
): Promise<SquadStateMcpSpec> {
  const fallback = exactVersionFallback(cliVersion);

  const detectStandalone = options.standaloneCheck ?? detectStandaloneLauncher;
  const launcher = detectStandalone();
  if (launcher) {
    return {
      command: launcher,
      args: ['state-mcp'],
      source: 'standalone',
      fallback,
    };
  }

  const detectEntry = options.localEntryCheck ?? detectInstalledCliEntry;
  const entry = detectEntry();
  if (entry) {
    return {
      command: process.execPath,
      args: [entry, 'state-mcp'],
      source: 'local-entry',
      fallback,
    };
  }

  return {
    command: fallback.command,
    args: [...fallback.args],
    source: 'pinned',
  };
}

function exactVersionFallback(version: string): { command: 'npx'; args: string[] } {
  return {
    command: 'npx',
    args: ['-y', `${PACKAGE_NAME}@${version}`, 'state-mcp'],
  };
}

/** True for a spec that names a path on this machine, which must not be committed. */
export function isMachineSpecificMcpSpec(spec: SquadStateMcpSpec): boolean {
  return spec.source === 'standalone' || spec.source === 'local-entry';
}

/**
 * The portable form of `direct` for files a repository commits (#2462).
 *
 * - `local-entry` becomes `node <squadDir>/bin/squad.mjs state-mcp`, the repository launcher
 *   ({@link writeSquadRepoLauncher}), which finds a Squad CLI on whatever machine runs it.
 * - `standalone` becomes a bare `squad state-mcp`: standalone installs put `squad` on PATH and may
 *   have no Node to run the launcher.
 * - `pinned` (exact-version npx) is already portable and is kept.
 *
 * `squadDir` is the squad directory relative to the repository root, POSIX separators. A squad
 * directory outside the repository has no portable form; `direct` is returned.
 */
export function committedSquadStateMcpSpec(direct: SquadStateMcpSpec, squadDir: string | null): SquadStateMcpSpec {
  if (direct.source === 'local-entry' && squadDir) {
    return {
      command: 'node',
      args: [`${squadDir}/${SQUAD_REPO_LAUNCHER_PATH}`, 'state-mcp'],
      source: 'repo-launcher',
      ...(direct.fallback ? { fallback: direct.fallback } : {}),
    };
  }
  if (direct.source === 'standalone') {
    return { command: 'squad', args: ['state-mcp'], source: 'path', ...(direct.fallback ? { fallback: direct.fallback } : {}) };
  }
  return direct;
}

/** The squad directory relative to `root` (POSIX), or null when it is outside `root`. */
export function squadDirInRoot(root: string, squadDirAbs: string): string | null {
  const rel = path.relative(path.resolve(root), path.resolve(squadDirAbs));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Write (or refresh) `<squadDir>/bin/squad.mjs`. A file there without Squad's marker is the
 * user's and is left alone.
 */
export function writeSquadRepoLauncher(
  root: string,
  squadDir: string,
  version: string,
): 'created' | 'updated' | 'unchanged' | 'skipped' {
  const file = path.join(root, ...squadDir.split('/'), ...SQUAD_REPO_LAUNCHER_PATH.split('/'));
  const content = squadRepoLauncher(version, squadDir);
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8');
    if (existing === content) return 'unchanged';
    if (!existing.includes(SQUAD_REPO_LAUNCHER_MARKER)) return 'skipped';
    writeFileSync(file, content, { mode: 0o755 });
    return 'updated';
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, { mode: 0o755 });
  return 'created';
}

/**
 * Resolve the spec for committed files under `root`, writing the repository launcher when the
 * spec uses it (unless `write` is false, for read-only callers such as `squad client list`).
 * A launcher Squad may not overwrite (user-authored) keeps the machine-specific spec.
 */
export async function resolveCommittedSquadStateMcpSpec(
  cliVersion: string,
  root: string,
  squadDirAbs: string,
  options: ResolveSquadStateMcpSpecOptions & { write?: boolean } = {},
): Promise<SquadStateMcpSpec> {
  const direct = await resolveSquadStateMcpSpec(cliVersion, options);
  const squadDir = squadDirInRoot(root, squadDirAbs);
  const spec = committedSquadStateMcpSpec(direct, squadDir);
  if (spec.source === 'repo-launcher' && squadDir && options.write !== false) {
    if (writeSquadRepoLauncher(root, squadDir, cliVersion) === 'skipped') return direct;
  }
  return spec;
}
