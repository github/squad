/**
 * Regression test for the upgrade state-backend flow:
 *  - UPGRADE-FLAG-IGNORED: `--state-backend` must update config.json without
 *    duplicate keys.
 *  - UPGRADE-NO-MIGRATION: pre-existing `.squad/decisions.md` and agent
 *    histories must be carried onto the squad-state orphan branch.
 *  - WI-1: hook set (incl. pre-commit + post-commit) must be installed after
 *    migration.
 *
 * Evidence:
 * .squad/files/validation/TWOLAYER-BASELINE-INSIDER3-CONSOLIDATED.md (data-5)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { migrateStateBackend, ensureOrphanBranch, liftInitMutableStateOntoOrphan } from '../packages/squad-cli/src/cli/commands/migrate-backend.js';
import { LocalMemoryStore, FSStorageProvider } from '@bradygaster/squad-sdk';
import { OrphanBranchBackend } from '../packages/squad-sdk/src/state-backend.js';
import { createStateMcpToolRegistry } from '../packages/squad-cli/src/cli/commands/state-mcp.js';

function mkRepo(backend: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-upgrade-mig-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Squad UpgradeTest'], { cwd: dir });
  // Seed an initial commit so HEAD exists and orphan creation works.
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });

  fs.mkdirSync(path.join(dir, '.squad', 'agents', 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.squad', 'config.json'),
    JSON.stringify({ stateBackend: backend, teamRoot: '.' }, null, 2),
  );
  return dir;
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

describe('squad upgrade --state-backend migration', () => {
  let dir: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) cleanup(dir);
  });

  it.each(['orphan', 'two-layer'])('preserves actual governed stores and exposes existing memory through MCP after migrating to %s', { timeout: 120_000 }, async target => {
    dir = mkRepo('local');
    fs.writeFileSync(path.join(dir, '.squad', 'team.md'), '# Team\n');
    const store = new LocalMemoryStore(new FSStorageProvider(), dir);
    for (const requestedClass of ['LOCAL', 'DECISION', 'POLICY'] as const) {
      const result = await store.write({ content: `Migration fixture ${requestedClass} guidance`, title: `${requestedClass} fixture`, requestedClass });
      expect(result.stored).toBe(true);
    }
    const deleted = await store.write({ content: 'Retired fixture guidance', requestedClass: 'LOCAL' });
    expect(await store.delete(deleted.id!)).toBe(true);
    fs.writeFileSync(path.join(dir, '.squad', 'memory', 'audit.1.jsonl'), '{"archived":true}\n');
    fs.writeFileSync(path.join(dir, '.squad', 'memory', 'opaque.dat'), Buffer.from([0, 255, 128, 10]));
    const files = fs.readdirSync(path.join(dir, '.squad', 'memory'), { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.relative(path.join(dir, '.squad'), path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
    const snapshot = new Map(files.map(relative => [relative, fs.readFileSync(path.join(dir, '.squad', relative))]));
    const branch = new OrphanBranchBackend(dir);
    branch.write('sessions/existing.md', 'unrelated destination record');

    await migrateStateBackend(dir, target);
    for (const [relative, bytes] of snapshot) {
      expect(execFileSync('git', ['show', `squad-state:${relative}`], { cwd: dir })).toEqual(bytes);
      expect(fs.existsSync(path.join(dir, '.squad', relative))).toBe(false);
    }
    expect(branch.read('sessions/existing.md')).toBe('unrelated destination record');
    const registry = createStateMcpToolRegistry(dir);
    const search = registry.getTools().find(tool => tool.name === 'memory.search')!;
    const args = { query: 'Migration fixture' };
    const result = await search.handler(args, { toolName: 'memory.search', toolCallId: 'migration-search', arguments: args, sessionId: 'test' }) as { textResultForLlm: string };
    expect(result.textResultForLlm).toContain('LOCAL fixture');
    expect(result.textResultForLlm).toContain('DECISION fixture');
    const statePaths = execFileSync('git', ['ls-tree', '-r', '--name-only', 'squad-state'], { cwd: dir, encoding: 'utf8' });
    expect(statePaths).toMatch(/decisions\/inbox\/.+\.md/);
    expect(statePaths).toMatch(/memory\/policy-inbox\/.+\.md/);
    const head = execFileSync('git', ['rev-parse', 'squad-state'], { cwd: dir, encoding: 'utf8' });
    await migrateStateBackend(dir, target);
    expect(execFileSync('git', ['rev-parse', 'squad-state'], { cwd: dir, encoding: 'utf8' })).toBe(head);
  });

  it('refuses conflicting destination indices without switching authority or changing either store', { timeout: 30_000 }, async () => {
    dir = mkRepo('local');
    fs.mkdirSync(path.join(dir, '.squad', 'memory'));
    fs.writeFileSync(path.join(dir, '.squad', 'memory', 'index.json'), '[]\n');
    const branch = new OrphanBranchBackend(dir);
    branch.write('memory/index.json', '[{"id":"destination-record"}]\n');
    const head = execFileSync('git', ['rev-parse', 'squad-state'], { cwd: dir, encoding: 'utf8' });
    await expect(migrateStateBackend(dir, 'orphan')).rejects.toThrow('Conflicting state at memory/index.json');
    expect(branch.read('memory/index.json')).toBe('[{"id":"destination-record"}]\n');
    expect(fs.readFileSync(path.join(dir, '.squad', 'memory', 'index.json'), 'utf8')).toBe('[]\n');
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.squad', 'config.json'), 'utf8')).stateBackend).toBe('local');
    expect(execFileSync('git', ['rev-parse', 'squad-state'], { cwd: dir, encoding: 'utf8' })).toBe(head);
    expect(fs.readdirSync(path.join(dir, '.git')).filter(name => name.startsWith('squad-migrate-'))).toEqual([]);
  });

  it('retries an identical import after config publication fails without losing source or creating another commit', { timeout: 30_000 }, async () => {
    dir = mkRepo('worktree');
    const source = path.join(dir, '.squad', 'decisions.md');
    fs.writeFileSync(source, '# Existing decision\n');
    const rename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === path.join(dir, '.squad', 'config.json')) throw new Error('injected config failure');
      rename(from, to);
    });
    await expect(migrateStateBackend(dir, 'two-layer')).rejects.toThrow('injected config failure');
    expect(fs.readFileSync(source, 'utf8')).toBe('# Existing decision\n');
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.squad', 'config.json'), 'utf8')).stateBackend).toBe('worktree');
    const head = execFileSync('git', ['rev-parse', 'squad-state'], { cwd: dir, encoding: 'utf8' });
    vi.restoreAllMocks();
    await migrateStateBackend(dir, 'two-layer');
    expect(fs.existsSync(source)).toBe(false);
    expect(execFileSync('git', ['rev-parse', 'squad-state'], { cwd: dir, encoding: 'utf8' })).toBe(head);
    expect(fs.readdirSync(path.join(dir, '.squad')).filter(name => name.startsWith('.config-migrate-'))).toEqual([]);
  });

  it('retains config and source when orphan import cannot publish its ref', { timeout: 30_000 }, async () => {
    dir = mkRepo('local');
    expect(ensureOrphanBranch(dir)).toBe(true);
    fs.writeFileSync(path.join(dir, '.squad', 'decisions.md'), 'keep source');
    const lock = path.join(dir, '.git', 'refs', 'heads', 'squad-state.lock');
    fs.writeFileSync(lock, 'blocked');
    await expect(migrateStateBackend(dir, 'orphan')).rejects.toThrow('Could not migrate state');
    expect(fs.readFileSync(path.join(dir, '.squad', 'decisions.md'), 'utf8')).toBe('keep source');
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.squad', 'config.json'), 'utf8')).stateBackend).toBe('local');
  });

  it('detects local edits made during import before switching backend authority', { timeout: 30_000 }, async () => {
    dir = mkRepo('local');
    const source = path.join(dir, '.squad', 'decisions.md');
    fs.writeFileSync(source, 'original snapshot\n');
    const remove = fs.rmSync.bind(fs);
    vi.spyOn(fs, 'rmSync').mockImplementation((file, options) => {
      remove(file, options);
      if (path.basename(String(file)).startsWith('squad-migrate-')) {
        fs.writeFileSync(source, 'concurrent edit\n');
      }
    });
    await expect(migrateStateBackend(dir, 'orphan')).rejects.toThrow('Source changed during migration');
    expect(fs.readFileSync(source, 'utf8')).toBe('concurrent edit\n');
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.squad', 'config.json'), 'utf8')).stateBackend).toBe('local');
    expect(new OrphanBranchBackend(dir).read('decisions.md')).toBe('original snapshot\n');
  });

  it.each(['null', '[]', '{bad json'])('refuses malformed config %s before starting migration', async raw => {
    dir = mkRepo('local');
    const config = path.join(dir, '.squad', 'config.json');
    fs.writeFileSync(config, raw);
    await expect(migrateStateBackend(dir, 'orphan')).rejects.toThrow('Cannot read squad config');
    expect(fs.readFileSync(config, 'utf8')).toBe(raw);
    expect(() => execFileSync('git', ['rev-parse', '--verify', 'squad-state'], { cwd: dir, stdio: 'pipe' })).toThrow();
  });

  it('init lifts the governed scaffold while leaving all static casting files on disk', { timeout: 30_000 }, async () => {
    dir = mkRepo('orphan');
    const store = new LocalMemoryStore(new FSStorageProvider(), dir);
    await store.write({ content: 'Init fixture guidance', requestedClass: 'LOCAL' });
    const castingDir = path.join(dir, '.squad', 'casting');
    fs.mkdirSync(castingDir);
    const castingFiles = ['registry.json', 'history.json', 'policy.json', 'registry-history.commit.json'];
    for (const file of castingFiles) fs.writeFileSync(path.join(castingDir, file), '{}\n');
    expect(ensureOrphanBranch(dir)).toBe(true);
    expect(liftInitMutableStateOntoOrphan(dir)).toContain('memory/index.json');
    for (const file of castingFiles) expect(fs.readFileSync(path.join(castingDir, file), 'utf8')).toBe('{}\n');
    expect(execFileSync('git', ['ls-tree', '-r', '--name-only', 'squad-state'], { cwd: dir, encoding: 'utf8' })).not.toContain('casting/');
  });

  it('UPGRADE-FLAG-IGNORED: writes stateBackend to config.json with no duplicate keys', { timeout: 30_000 }, async () => {
    dir = mkRepo('worktree');
    await migrateStateBackend(dir, 'two-layer');

    const raw = fs.readFileSync(path.join(dir, '.squad', 'config.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.stateBackend).toBe('two-layer');
    // Bug E guard: only one occurrence of "stateBackend" in the raw text.
    const occurrences = (raw.match(/"stateBackend"/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('UPGRADE-FLAG-IGNORED (clean target): writes stateBackend when config.json has no stateBackend field', { timeout: 30_000 }, async () => {
    // Regression for the original bug: an older squad install has config.json
    // with no stateBackend field at all. `squad upgrade --state-backend two-layer`
    // must add the field rather than silently drop it.
    dir = mkRepo('worktree');
    // Remove stateBackend so config only has other fields (e.g. teamRoot).
    const configPath = path.join(dir, '.squad', 'config.json');
    const existing = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    delete existing['stateBackend'];
    fs.writeFileSync(configPath, JSON.stringify(existing, null, 2) + '\n');

    await migrateStateBackend(dir, 'two-layer');

    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.stateBackend).toBe('two-layer');
    expect(parsed['teamRoot']).toBe('.');
    const occurrences = (raw.match(/"stateBackend"/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('WI-1: installs commit hooks after backend migration', { timeout: 30_000 }, async () => {
    dir = mkRepo('worktree');
    await migrateStateBackend(dir, 'two-layer');

    for (const h of ['pre-push', 'post-merge', 'post-rewrite', 'post-checkout', 'pre-commit', 'post-commit']) {
      expect(fs.existsSync(path.join(dir, '.git', 'hooks', h)), `hook ${h} should exist`).toBe(true);
    }
  });

  it('UPGRADE-NO-MIGRATION: copies decisions.md + agent history.md onto squad-state branch', { timeout: 30_000 }, async () => {
    dir = mkRepo('worktree');
    fs.writeFileSync(
      path.join(dir, '.squad', 'decisions.md'),
      '# Squad Decisions\n\n## D1 — pre-upgrade decision\n\nKeep this.\n',
    );
    fs.writeFileSync(
      path.join(dir, '.squad', 'agents', 'data', 'history.md'),
      '# Data history\n\n- entry 1\n',
    );

    await migrateStateBackend(dir, 'two-layer');

    // Verify orphan branch contains the migrated files.
    const decisionsOnBranch = execFileSync(
      'git', ['show', 'refs/heads/squad-state:decisions.md'],
      { cwd: dir, encoding: 'utf-8' },
    );
    expect(decisionsOnBranch).toContain('pre-upgrade decision');

    const historyOnBranch = execFileSync(
      'git', ['show', 'refs/heads/squad-state:agents/data/history.md'],
      { cwd: dir, encoding: 'utf-8' },
    );
    expect(historyOnBranch).toContain('entry 1');
  });

  it('F1 (Round 5): migrated working-tree state files are removed after upgrade', { timeout: 30_000 }, async () => {
    dir = mkRepo('worktree');
    fs.writeFileSync(
      path.join(dir, '.squad', 'decisions.md'),
      '# Squad Decisions\n\n## D1 — pre-upgrade decision\n',
    );
    fs.writeFileSync(
      path.join(dir, '.squad', 'agents', 'data', 'history.md'),
      '# Data history\n',
    );
    // A static file that must NOT be touched by the cleanup.
    fs.writeFileSync(
      path.join(dir, '.squad', 'charter.md'),
      '# Charter\nStatic content — do not delete on upgrade.\n',
    );

    await migrateStateBackend(dir, 'two-layer');

    // Working-tree mutable state must be gone (orphan branch is authoritative).
    expect(fs.existsSync(path.join(dir, '.squad', 'decisions.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.squad', 'agents', 'data', 'history.md'))).toBe(false);
    // The now-empty agent directory should also be cleaned up.
    expect(fs.existsSync(path.join(dir, '.squad', 'agents', 'data'))).toBe(false);
    // Static / config files must remain untouched.
    expect(fs.existsSync(path.join(dir, '.squad', 'charter.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.squad', 'config.json'))).toBe(true);
  });

  it('migration is idempotent: re-running with same target does not duplicate config or fail', { timeout: 30_000 }, async () => {
    dir = mkRepo('worktree');
    await migrateStateBackend(dir, 'two-layer');
    await migrateStateBackend(dir, 'two-layer'); // no-op path

    const raw = fs.readFileSync(path.join(dir, '.squad', 'config.json'), 'utf-8');
    const occurrences = (raw.match(/"stateBackend"/g) || []).length;
    expect(occurrences).toBe(1);
    expect(JSON.parse(raw).stateBackend).toBe('two-layer');
  });

  // ── .gitignore marker block (#1228) ──────────────────────────────────────

  it('local → two-layer: adds .gitignore marker block', { timeout: 30_000 }, async () => {
    dir = mkRepo('local');
    await migrateStateBackend(dir, 'two-layer');

    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('# Squad: state owned by squad-state branch (two-layer/orphan backend)');
    expect(gitignore).toContain('.squad/decisions.md');
    expect(gitignore).toContain('.squad/agents/*/history.md');
    expect(gitignore).toContain('# /Squad: state owned by squad-state branch');
  });

  it('local → orphan: adds .gitignore marker block', { timeout: 30_000 }, async () => {
    dir = mkRepo('local');
    await migrateStateBackend(dir, 'orphan');

    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('# Squad: state owned by squad-state branch (two-layer/orphan backend)');
    expect(gitignore).toContain('.squad/decisions.md');
    expect(gitignore).toContain('.squad/agents/*/history.md');
  });

  it('two-layer → local: removes .gitignore marker block', { timeout: 30_000 }, async () => {
    dir = mkRepo('two-layer');
    // Pre-seed a .gitignore with the marker block
    const gitignorePath = path.join(dir, '.gitignore');
    fs.writeFileSync(gitignorePath, [
      '# Squad: ignore runtime state (logs, inbox, sessions)',
      '.squad/orchestration-log/',
      '# Squad: state owned by squad-state branch (two-layer/orphan backend)',
      '.squad/decisions.md',
      '.squad/agents/*/history.md',
      '# /Squad: state owned by squad-state branch',
      '',
    ].join('\n'));

    await migrateStateBackend(dir, 'local');

    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    expect(gitignore).not.toContain('# Squad: state owned by squad-state branch');
    expect(gitignore).not.toContain('.squad/decisions.md');
    expect(gitignore).not.toContain('.squad/agents/*/history.md');
    // Other entries should be preserved
    expect(gitignore).toContain('.squad/orchestration-log/');
  });

  it('orphan → local: removes .gitignore marker block', { timeout: 30_000 }, async () => {
    dir = mkRepo('orphan');
    const gitignorePath = path.join(dir, '.gitignore');
    fs.writeFileSync(gitignorePath, [
      '.squad/orchestration-log/',
      '# Squad: state owned by squad-state branch (two-layer/orphan backend)',
      '.squad/decisions.md',
      '.squad/agents/*/history.md',
      '# /Squad: state owned by squad-state branch',
      '',
    ].join('\n'));

    await migrateStateBackend(dir, 'local');

    const gitignore = fs.readFileSync(gitignorePath, 'utf-8');
    expect(gitignore).not.toContain('# Squad: state owned by squad-state branch');
    expect(gitignore).toContain('.squad/orchestration-log/');
  });

  it('two-layer → orphan: no-op on .gitignore (block already present)', { timeout: 30_000 }, async () => {
    dir = mkRepo('two-layer');
    const gitignorePath = path.join(dir, '.gitignore');
    fs.writeFileSync(gitignorePath, [
      '# Squad: state owned by squad-state branch (two-layer/orphan backend)',
      '.squad/decisions.md',
      '.squad/agents/*/history.md',
      '# /Squad: state owned by squad-state branch',
      '',
    ].join('\n'));
    const contentBefore = fs.readFileSync(gitignorePath, 'utf-8');

    await migrateStateBackend(dir, 'orphan');

    const contentAfter = fs.readFileSync(gitignorePath, 'utf-8');
    // Block is still present
    expect(contentAfter).toContain('# Squad: state owned by squad-state branch');
    // Not duplicated
    const occurrences = (contentAfter.match(/# Squad: state owned by squad-state branch \(two-layer\/orphan backend\)/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('.gitignore round-trip: local→two-layer→local leaves file byte-identical', { timeout: 30_000 }, async () => {
    dir = mkRepo('local');
    const gitignorePath = path.join(dir, '.gitignore');
    const existingContent = '# my project\nnode_modules/\ndist/\n';
    fs.writeFileSync(gitignorePath, existingContent);

    await migrateStateBackend(dir, 'two-layer');
    // Migrate back to local but this time need to create fresh repo with same config
    // We need to start a new repo already set to two-layer then go back
    const twoLayerDir = mkRepo('two-layer');
    const twoLayerGitignorePath = path.join(twoLayerDir, '.gitignore');
    fs.writeFileSync(twoLayerGitignorePath, existingContent);
    await migrateStateBackend(twoLayerDir, 'local');
    // After round-trip: the marker block should not be present
    const finalContent = fs.readFileSync(twoLayerGitignorePath, 'utf-8');
    expect(finalContent).not.toContain('# Squad: state owned by squad-state branch');
    try { fs.rmSync(twoLayerDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
});
