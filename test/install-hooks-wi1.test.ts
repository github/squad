/**
 * WI-1 regression test — verifies that two-layer / orphan backends install
 * pre-commit + post-commit hooks (plus the existing sync hooks) and that
 * ensureHooksForBackend re-installs hooks if any required one is missing.
 *
 * Bug evidence: .squad/files/validation/TWOLAYER-BASELINE-INSIDER3-CONSOLIDATED.md
 * - Fresh init two-layer installed pre-push / post-merge / post-rewrite / post-checkout
 *   but NOT pre-commit / post-commit.
 * - Upgrade --state-backend two-layer installed zero hooks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { commitCastingRegistryPair } from '../packages/squad-sdk/src/casting/durable-registry.js';
import {
  installGitHooks,
  ensureHooksForBackend,
} from '../packages/squad-cli/src/cli/commands/install-hooks.js';

function mkTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-wi1-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main'], { cwd: dir });
  // Required minimum git config for commits / hook installs.
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Squad WI-1 Test'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.squad'), { recursive: true });
  return dir;
}

function writeConfig(dir: string, backend: string): void {
  fs.writeFileSync(
    path.join(dir, '.squad', 'config.json'),
    JSON.stringify({ stateBackend: backend }, null, 2),
  );
}

const REQUIRED_HOOKS = [
  'pre-push',
  'post-merge',
  'post-rewrite',
  'post-checkout',
  'pre-commit',
  'post-commit',
];

describe('WI-1: install-hooks installs commit hooks on two-layer / orphan', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkTempRepo();
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('installGitHooks installs ALL required hooks (incl. pre-commit + post-commit) when backend is two-layer', () => {
    writeConfig(dir, 'two-layer');
    installGitHooks(dir, { force: false });

    for (const hook of REQUIRED_HOOKS) {
      const p = path.join(dir, '.git', 'hooks', hook);
      expect(fs.existsSync(p), `hook ${hook} should exist`).toBe(true);
      const content = fs.readFileSync(p, 'utf-8');
      expect(content).toContain('squad-sync-hook');
    }
  });

  it('installGitHooks installs ALL required hooks when backend is orphan', () => {
    writeConfig(dir, 'orphan');
    installGitHooks(dir, { force: false });

    for (const hook of REQUIRED_HOOKS) {
      expect(fs.existsSync(path.join(dir, '.git', 'hooks', hook))).toBe(true);
    }
  });

  it('installGitHooks skips hook installation for local backend', () => {
    writeConfig(dir, 'local');
    installGitHooks(dir, { force: false });

    for (const hook of REQUIRED_HOOKS) {
      expect(fs.existsSync(path.join(dir, '.git', 'hooks', hook))).toBe(false);
    }
  });

  it('ensureHooksForBackend reinstalls missing pre-commit / post-commit on existing two-layer repos', () => {
    writeConfig(dir, 'two-layer');
    // Simulate an insider.3-era install: only the four sync hooks present, no commit hooks.
    const hooksDir = path.join(dir, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    for (const h of ['pre-push', 'post-merge', 'post-rewrite', 'post-checkout']) {
      fs.writeFileSync(
        path.join(hooksDir, h),
        '#!/bin/sh\n# --- squad-sync-hook ---\nif [ -z "$SQUAD_SYNC_ACTIVE" ]; then\n  :\nfi\n',
        { mode: 0o755 },
      );
    }

    expect(fs.existsSync(path.join(hooksDir, 'pre-commit'))).toBe(false);
    expect(fs.existsSync(path.join(hooksDir, 'post-commit'))).toBe(false);

    ensureHooksForBackend(dir);

    expect(fs.existsSync(path.join(hooksDir, 'pre-commit'))).toBe(true);
    expect(fs.existsSync(path.join(hooksDir, 'post-commit'))).toBe(true);
  });

  it('pre-commit hook content guards against committing two-layer state into working tree', () => {
    writeConfig(dir, 'two-layer');
    installGitHooks(dir, { force: false });
    const preCommit = fs.readFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), 'utf-8');
    expect(preCommit).toContain('decisions');
    expect(preCommit).toContain('agents');
    expect(preCommit).toContain('history');
  });

  it('refreshes legacy and duplicate guards without deleting user hook content', { timeout: 30_000 }, () => {
    writeConfig(dir, 'orphan');
    installGitHooks(dir);
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    const current = fs.readFileSync(hook, 'utf8');
    const legacy = current.replace('memory/|identity/', 'casting/|routing/');
    fs.writeFileSync(hook, '#!/bin/sh\n# user prefix\n' + legacy.split('\n').slice(1).join('\n') +
      '# user suffix\n' + current.split('\n').slice(1).join('\n'));
    ensureHooksForBackend(dir);
    const upgraded = fs.readFileSync(hook, 'utf8');
    expect(upgraded).toContain('# user prefix');
    expect(upgraded).toContain('# user suffix');
    expect(upgraded.match(/# --- squad-sync-hook ---/g)).toHaveLength(1);
    expect(upgraded).not.toContain('casting/');
    ensureHooksForBackend(dir);
    expect(fs.readFileSync(hook, 'utf8')).toBe(upgraded);
    installGitHooks(dir, { force: true });
    expect(fs.readFileSync(hook, 'utf8')).toBe(upgraded);
  });

  it('allows atomic casting and routing commits, rejects protected state edits, and allows deletions', { timeout: 60_000 }, () => {
    writeConfig(dir, 'two-layer');
    installGitHooks(dir);
    const env = { ...process.env, SQUAD_SYNC_ACTIVE: '' };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
    const castingDir = path.join(dir, '.squad', 'casting');
    commitCastingRegistryPair(castingDir, undefined, {
      schema: 'squad-agent-provenance/v1', schema_version: 1, revision: 1,
      generated_at: '2026-09-20T00:00:00.000Z', agents: {},
    }, undefined, { assignment_cast_snapshots: {}, universe_usage_history: [] }, 1);
    fs.writeFileSync(path.join(castingDir, 'policy.json'), '{}\n');
    expect(fs.existsSync(path.join(castingDir, 'registry-history.commit.json'))).toBe(true);
    fs.writeFileSync(path.join(dir, '.squad', 'routing.md'), '# Routing\n');
    git('add', '.squad/casting', '.squad/routing.md');
    git('commit', '-qm', 'static casting pair and marker');
    for (const relative of ['decisions.md', 'agents/data/history.md', 'memory/local/record.md', 'identity/data.md']) {
      const full = path.join(dir, '.squad', relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, 'governed state\n');
      git('add', `.squad/${relative}`);
      expect(() => git('commit', '-qm', 'must reject')).toThrow();
      execFileSync('git', ['commit', '-qm', 'seed tracked state'], {
        cwd: dir, env: { ...env, SQUAD_SYNC_ACTIVE: '1' }, stdio: 'pipe',
      });
      fs.unlinkSync(full);
      git('add', `.squad/${relative}`);
      git('commit', '-qm', 'remove migrated source');
    }
  });

  it('upgrades the legacy ignore block even when all hooks are already current', { timeout: 30_000 }, () => {
    writeConfig(dir, 'orphan');
    installGitHooks(dir);
    const ignore = path.join(dir, '.gitignore');
    fs.writeFileSync(ignore, '# project rule\ncustom/\n# Squad: state owned by squad-state branch (two-layer/orphan backend)\n.squad/decisions.md\n.squad/agents/*/history.md\n# /Squad: state owned by squad-state branch\n');
    ensureHooksForBackend(dir);
    const updated = fs.readFileSync(ignore, 'utf8');
    expect(updated).toContain('.squad/memory/');
    expect(updated).toContain('.squad/identity/');
    expect(updated).toContain('custom/');
    ensureHooksForBackend(dir);
    expect(fs.readFileSync(ignore, 'utf8')).toBe(updated);
  });

  it('refuses to delete an unrecognized marked hook section', () => {
    writeConfig(dir, 'orphan');
    const hook = path.join(dir, '.git', 'hooks', 'pre-push');
    const original = '#!/bin/sh\n# --- squad-sync-hook ---\n# custom incomplete section\n';
    fs.writeFileSync(hook, original);
    expect(() => installGitHooks(dir, { force: true })).toThrow('Cannot safely replace');
    expect(fs.readFileSync(hook, 'utf8')).toBe(original);
  });
});
