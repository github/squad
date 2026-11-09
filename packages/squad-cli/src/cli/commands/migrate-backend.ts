/**
 * Backend migration — upgrades state backend across allowed transitions.
 *
 * Supported migrations:
 * - local → orphan
 * - local → two-layer
 * - worktree → orphan
 * - worktree → two-layer
 * - orphan ↔ two-layer (both write to the squad-state orphan branch via different layers)
 *
 * In addition to flipping the `stateBackend` key in `.squad/config.json`, this
 * function MIGRATES pre-existing working-tree state (`decisions.md`,
 * `agents/<name>/history.md`, governed memory and decision inbox records) onto the squad-state orphan branch when moving
 * from a working-tree backend to an orphan-storage backend, so post-upgrade
 * agents can read pre-upgrade content (UPGRADE-NO-MIGRATION fix).
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { installGitHooks, ensureHooksForBackend } from './install-hooks.js';
import { FSStorageProvider } from '@bradygaster/squad-sdk';
import { addSquadStateGitignoreBlock, removeSquadStateGitignoreBlock } from '@bradygaster/squad-sdk';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const VALID_TARGETS = ['local', 'worktree', 'orphan', 'two-layer'];
const ORPHAN_BACKENDS = new Set(['orphan', 'two-layer']);
const WORKTREE_BACKENDS = new Set(['local', 'worktree']);
type StateFile = { relPath: string; content: Buffer };

/** Paths inside .squad/ that should be carried over to the orphan branch on migration. */
const MIGRATABLE_PATHS = [
  'decisions.md',
];

/** Best-effort: ensure the squad-state orphan branch exists. Returns true on success. */
export function ensureOrphanBranch(dest: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'refs/heads/squad-state'], {
      cwd: dest, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    try {
      const readmeContent = '# Squad State\n\nThis orphan branch stores mutable squad state.\nIt is managed automatically and should not be edited by hand.\n';
      const blobHash = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: dest, encoding: 'utf-8', input: readmeContent, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const treeInput = `100644 blob ${blobHash}\tREADME.md\n`;
      const treeHash = execFileSync('git', ['mktree'], {
        cwd: dest, encoding: 'utf-8', input: treeInput, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const commitHash = execFileSync('git', ['commit-tree', treeHash, '-m', 'init: squad-state orphan branch'], {
        cwd: dest, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      execFileSync('git', ['update-ref', 'refs/heads/squad-state', commitHash, '0000000000000000000000000000000000000000'], {
        cwd: dest, stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch (err) {
      console.log(`${YELLOW}⚠ Could not create squad-state branch: ${err instanceof Error ? err.message : err}${RESET}`);
      return false;
    }
  }
}

/**
 * Collect existing working-tree state files that should be migrated to the orphan branch.
 * Returns array of {path, content} pairs (paths are relative to .squad/).
 */
function collectWorktreeState(dest: string): StateFile[] {
  const squadDir = path.join(dest, '.squad');
  const collected: StateFile[] = [];

  for (const p of MIGRATABLE_PATHS) {
    const full = path.join(squadDir, p);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      collected.push({ relPath: p, content: fs.readFileSync(full) });
    }
  }

  // agents/<name>/history.md
  const agentsDir = path.join(squadDir, 'agents');
  if (fs.existsSync(agentsDir) && fs.statSync(agentsDir).isDirectory()) {
    for (const agentName of fs.readdirSync(agentsDir)) {
      const histPath = path.join(agentsDir, agentName, 'history.md');
      if (fs.existsSync(histPath) && fs.statSync(histPath).isFile()) {
        collected.push({
          relPath: path.posix.join('agents', agentName, 'history.md'),
          content: fs.readFileSync(histPath),
        });
      }
    }
  }

  // DECISION memories live outside memory/, in decisions/inbox.
  const collectDirectory = (relative: string): void => {
    const full = path.join(squadDir, relative);
    if (!fs.existsSync(full)) return;
    if (fs.lstatSync(full).isSymbolicLink()) {
      throw new Error(`Cannot migrate symbolic link .squad/${relative}; source was retained.`);
    }
    if (!fs.statSync(full).isDirectory()) {
      throw new Error(`Expected .squad/${relative} to be a directory; source was retained.`);
    }
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const relPath = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) collectDirectory(relPath);
      else if (entry.isFile()) collected.push({ relPath, content: fs.readFileSync(path.join(squadDir, relPath)) });
      else throw new Error(`Cannot migrate non-regular file .squad/${relPath}; source was retained.`);
    }
  };
  collectDirectory('memory');
  collectDirectory('decisions/inbox');

  return collected;
}

/**
 * Write a set of files onto the squad-state orphan branch via git plumbing.
 * Preserves any files already on the branch (merges trees by path).
 * Returns the number imported (including identical files); throws on failure.
 */
function writeFilesToOrphanBranch(dest: string, files: StateFile[]): number {
  if (files.length === 0) return 0;
  let indexDir: string | undefined;
  try {
    // Load the current squad-state tree into the index using a temporary index file
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: dest, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    indexDir = fs.mkdtempSync(path.resolve(dest, gitDir, 'squad-migrate-'));
    const indexFile = path.join(indexDir, 'index');

    const env = { ...process.env, GIT_INDEX_FILE: indexFile };
    const parentSha = execFileSync('git', ['rev-parse', 'refs/heads/squad-state'], {
      cwd: dest, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const existing = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', parentSha], {
      cwd: dest, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).split('\0').filter(Boolean));

    // Seed index with existing squad-state tree
    execFileSync('git', ['read-tree', parentSha], {
      cwd: dest, env, stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Add each migrated file
    for (const f of files) {
      if (existing.has(f.relPath)) {
        const content = execFileSync('git', ['show', `${parentSha}:${f.relPath}`], {
          cwd: dest, stdio: ['pipe', 'pipe', 'pipe'],
        });
        if (!content.equals(f.content)) {
          throw new Error(`Conflicting state at ${f.relPath}. Reconcile the source and squad-state copies before retrying; neither copy was changed.`);
        }
        continue;
      }
      const blobHash = execFileSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: dest, env, encoding: 'utf-8', input: f.content, stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blobHash},${f.relPath}`], {
        cwd: dest, env, stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    const treeHash = execFileSync('git', ['write-tree'], {
      cwd: dest, env, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const parentTree = execFileSync('git', ['rev-parse', `${parentSha}^{tree}`], {
      cwd: dest, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (treeHash === parentTree) return files.length;

    const commitHash = execFileSync(
      'git',
      ['commit-tree', treeHash, '-p', parentSha, '-m', `migrate: import working-tree state on backend upgrade (${files.length} file(s))`],
      { cwd: dest, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    execFileSync('git', ['update-ref', 'refs/heads/squad-state', commitHash, parentSha], {
      cwd: dest, stdio: ['pipe', 'pipe', 'pipe'],
    });

    return files.length;
  } catch (err) {
    throw new Error(`Could not migrate state onto squad-state branch: ${err instanceof Error ? err.message : err}`, { cause: err });
  } finally {
    if (indexDir) fs.rmSync(indexDir, { recursive: true, force: true });
  }
}

/**
 * Migrate the state backend for an existing squad project.
 *
 * Fixes:
 *   - UPGRADE-FLAG-IGNORED: writes the new `stateBackend` value into config.json
 *     via JSON-aware merge (never textual append → avoids Bug E duplicates).
 *   - UPGRADE-NO-MIGRATION: when moving from a working-tree backend to an
 *     orphan-storage backend, carries existing decisions.md and agent histories
 *     onto the squad-state orphan branch so post-upgrade agents see prior state.
 *   - WI-1: re-installs the full hook set (including new pre-commit/post-commit).
 */
export async function migrateStateBackend(dest: string, target: string): Promise<void> {
  if (!VALID_TARGETS.includes(target)) {
    console.log(`${YELLOW}⚠ Invalid backend target '${target}'. Supported: ${VALID_TARGETS.join(', ')}${RESET}`);
    return;
  }

  const configPath = path.join(dest, '.squad', 'config.json');
  let config: Record<string, unknown> = {};

  try {
    if (fs.existsSync(configPath)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Expected a config object.');
      }
      config = parsed as Record<string, unknown>;
    }
  } catch (err) {
    throw new Error('Cannot read squad config; backend migration was not started.', { cause: err });
  }

  const current = config['stateBackend'] ?? 'local';
  if (typeof current !== 'string' || !VALID_TARGETS.includes(current)) {
    throw new Error(`Unsupported source backend '${String(current)}'; backend was not switched.`);
  }

  if (current === target) {
    console.log(`${YELLOW}⚠ Backend is already '${target}'. Ensuring hooks + config are consistent.${RESET}`);
    if (ORPHAN_BACKENDS.has(target)) {
      if (!ensureOrphanBranch(dest)) throw new Error('Cannot initialize squad-state; backend was not switched.');
      ensureHooksForBackend(dest);
      addSquadStateGitignoreBlock(path.join(dest, '.gitignore'), new FSStorageProvider());
    }
    return;
  }

  console.log(`\n${BOLD}Migrating state backend: ${current} → ${target}${RESET}\n`);

  // Step 1: Ensure orphan branch exists when the target needs it
  if (ORPHAN_BACKENDS.has(target)) {
    if (!ensureOrphanBranch(dest)) throw new Error('Cannot initialize squad-state; backend was not switched.');
    console.log(`  ${GREEN}✓${RESET} squad-state branch ready`);
  }

  let migratedFiles: StateFile[] = [];
  // Step 2 (UPGRADE-NO-MIGRATION): move working-tree state onto the orphan branch
  // when transitioning from a worktree backend to an orphan-storage backend.
  if (WORKTREE_BACKENDS.has(current) && ORPHAN_BACKENDS.has(target)) {
    const files = collectWorktreeState(dest);
    if (files.length > 0) {
      const wrote = writeFilesToOrphanBranch(dest, files);
      if (wrote > 0) {
        migratedFiles = files;
        console.log(`  ${GREEN}✓${RESET} migrated ${wrote} state file(s) onto squad-state branch:`);
        for (const f of files) {
          console.log(`      ${DIM}.squad/${f.relPath}${RESET}`);
        }

      } else {
        console.log(`  ${DIM}no working-tree state files to migrate${RESET}`);
      }
    } else {
      console.log(`  ${DIM}no migratable state in working tree${RESET}`);
    }
  }

  // Recheck the snapshot before switching authority. A retry can reuse the
  // identical imported tree after a failed config write without losing source.
  if (WORKTREE_BACKENDS.has(current) && ORPHAN_BACKENDS.has(target)) {
    const snapshot = new Map(collectWorktreeState(dest).map(file => [file.relPath, file.content]));
    if (snapshot.size !== migratedFiles.length || migratedFiles.some(file => !snapshot.get(file.relPath)?.equals(file.content))) {
      throw new Error('Source changed during migration. Backend was not switched; reconcile before retrying.');
    }
  }
  config['stateBackend'] = target;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const configTempDir = fs.mkdtempSync(path.join(path.dirname(configPath), '.config-migrate-'));
  try {
    const configTempPath = path.join(configTempDir, 'config.json');
    fs.writeFileSync(configTempPath, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(configTempPath, configPath);
  } finally {
    fs.rmSync(configTempDir, { recursive: true, force: true });
  }
  console.log(`  ${GREEN}✓${RESET} config.json updated: stateBackend = ${target}`);

  if (migratedFiles.length > 0) {
    // Only remove the imported snapshot, never a concurrent local edit.
    const squadDir = path.join(dest, '.squad');
    const removed: string[] = [];
    const removeFailed: string[] = [];
    for (const f of migratedFiles) {
      const full = path.join(squadDir, f.relPath);
      try {
        if (fs.existsSync(full)) {
          if (!fs.readFileSync(full).equals(f.content)) throw new Error('Source changed after migration');
          fs.unlinkSync(full);
        }
        removed.push(f.relPath);
      } catch {
        removeFailed.push(f.relPath);
      }
    }
    const agentsDir = path.join(squadDir, 'agents');
    if (fs.existsSync(agentsDir) && fs.statSync(agentsDir).isDirectory()) {
      for (const agentName of fs.readdirSync(agentsDir)) {
        const agentDir = path.join(agentsDir, agentName);
        try {
          if (fs.statSync(agentDir).isDirectory() && fs.readdirSync(agentDir).length === 0) {
            fs.rmdirSync(agentDir);
          }
        } catch { /* best-effort empty-directory cleanup */ }
      }
    }
    if (removed.length > 0) {
      console.log(`  ${GREEN}✓${RESET} removed ${removed.length} stale working-tree file(s) (now sourced from squad-state):`);
      for (const r of removed) console.log(`      ${DIM}.squad/${r}${RESET}`);
    }
    if (removeFailed.length > 0) {
      console.log(`  ${YELLOW}⚠${RESET} source retained (changed or could not be removed): ${removeFailed.join(', ')}. Reconcile these files with squad-state.`);
    }
  }

  // Step 4 (WI-1): re-install hooks (force so new pre-commit/post-commit land)
  if (ORPHAN_BACKENDS.has(target)) {
    installGitHooks(dest, { force: true });
  }

  // Step 5: Manage .gitignore marker block for squad-state files.
  // When migrating TO an orphan/two-layer backend: add the marker block so
  // git add . / IDE "stage all" cannot accidentally stage state files.
  // When migrating TO a local/worktree backend: remove the block so those
  // files are committable again.
  const gitignorePath = path.join(dest, '.gitignore');
  const storage = new FSStorageProvider();
  if (ORPHAN_BACKENDS.has(target)) {
    // Also upgrade older marker blocks during orphan/two-layer transitions.
    const added = addSquadStateGitignoreBlock(gitignorePath, storage);
    if (added) {
      console.log(`  ${GREEN}✓${RESET} updated .gitignore protections for decisions, histories, memory and identity`);
    }
  } else if (WORKTREE_BACKENDS.has(target) && ORPHAN_BACKENDS.has(current)) {
    // Transitioning FROM orphan/two-layer BACK TO a local backend — remove block
    const removed = removeSquadStateGitignoreBlock(gitignorePath, storage);
    if (removed) {
      console.log(`  ${GREEN}✓${RESET} removed squad-state .gitignore block — local state is committable again`);
    }
  }

  console.log(`\n${GREEN}${BOLD}✓ Migration complete.${RESET} Backend is now '${target}'.\n`);
}

/**
 * INSIDER3-INIT-LEAK fix: when `squad init --state-backend orphan|two-layer`
 * runs, the SDK still hand-writes mutable state files (decisions.md and each
 * agent's history.md) into the working tree because it has no knowledge of the
 * future backend choice. This helper, invoked by the CLI immediately after the
 * orphan branch is created, lifts those mutable files onto the squad-state
 * orphan branch and removes them from the working tree so post-init agents
 * read state exclusively through the runtime bridge.
 *
 * Source-of-truth hierarchy preserved: static files (team.md, charters,
 * ceremonies.md, casting/*, templates/*) are NEVER touched — only mutable
 * state (decisions.md, agents/<n>/history.md, memory/ and decisions/inbox/) migrates.
 *
 * Returns the relative paths of files that were migrated + removed.
 */
export function liftInitMutableStateOntoOrphan(dest: string): string[] {
  const files = collectWorktreeState(dest);
  if (files.length === 0) return [];
  const wrote = writeFilesToOrphanBranch(dest, files);
  if (wrote <= 0) return [];
  const removed: string[] = [];
  const squadDir = path.join(dest, '.squad');
  for (const f of files) {
    const full = path.join(squadDir, f.relPath);
    try {
      if (fs.existsSync(full)) {
        if (!fs.readFileSync(full).equals(f.content)) throw new Error('Source changed after import');
        fs.unlinkSync(full);
      }
      removed.push(f.relPath);
    } catch (err) {
      console.warn(`Could not remove imported .squad/${f.relPath}; source was retained: ${err instanceof Error ? err.message : err}`);
    }
  }
  return removed;
}
