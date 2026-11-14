/**
 * What Squad's Claude Code allowlist pre-approves must be safe without a prompt (#2496 review):
 * the allowlisted squad_state tools match what state-mcp serves (minus backend tools), and an
 * allowlisted `squad cast --force` never writes through a symlink out of the team directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SQUAD_STATE_PERMISSION_TOOLS } from '../packages/squad-sdk/src/client/adapters/claude-hooks.js';
import { MCP_TOOL_ALIASES } from '../packages/squad-cli/src/cli/commands/state-mcp.js';
import { runCastAdd, symlinkUnder } from '../packages/squad-cli/src/cli/commands/cast.js';

describe('allowlisted squad_state tools', () => {
  it("are exactly state-mcp's squad_* tools: never a backend tool, and memory.* stays behind a prompt", () => {
    // The coordinator protocol never calls the memory.* tools, so they are not pre-approved.
    const served = Object.keys(MCP_TOOL_ALIASES).filter((t) => !t.startsWith('memory.'));
    expect([...SQUAD_STATE_PERMISSION_TOOLS].sort()).toEqual(served.sort());
    expect(SQUAD_STATE_PERMISSION_TOOLS.some((t) => t.startsWith('squad_backend'))).toBe(false);
  });
});

describe('squad cast refuses to write through a symlink', () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-cast-link-')));
    root = path.join(base, 'repo');
    outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(root, '.squad', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(root, '.squad', 'casting'), { recursive: true });
    fs.mkdirSync(outside);
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    fs.writeFileSync(path.join(root, '.squad', 'team.md'), '# Team\n\n## Members\n\n| Name | Role | Charter | Status |\n|---|---|---|---|\n');
    fs.writeFileSync(path.join(root, '.squad', 'routing.md'), '# Routing\n');
  });
  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it('a linked charter file is refused with --force, and its target is untouched', async () => {
    const target = path.join(outside, 'victim.txt');
    fs.writeFileSync(target, 'keep\n');
    fs.mkdirSync(path.join(root, '.squad', 'agents', 'evil'));
    fs.symlinkSync(target, path.join(root, '.squad', 'agents', 'evil', 'charter.md'));
    await expect(runCastAdd(root, { name: 'Evil', role: 'Tester', force: true })).rejects.toThrow(/symbolic link/);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep\n');
  });

  it('a linked agent directory or team.md is refused', async () => {
    fs.symlinkSync(outside, path.join(root, '.squad', 'agents', 'evil'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(runCastAdd(root, { name: 'Evil', role: 'Tester' })).rejects.toThrow(/symbolic link/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('symlinkUnder allows a linked root but finds a link below it', () => {
    const link = path.join(base, 'team-link');
    fs.symlinkSync(path.join(root, '.squad'), link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(symlinkUnder(link, path.join(link, 'agents', 'new', 'charter.md'))).toBeNull();
    fs.symlinkSync(outside, path.join(root, '.squad', 'agents', 'x'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(symlinkUnder(link, path.join(link, 'agents', 'x', 'charter.md'))).toBe(path.join(link, 'agents', 'x'));
  });
});

describe('a denied action stays denied (live first run, 2026-11-13)', () => {
  it('every coordinator digest forbids retrying a denied command or write another way', async () => {
    const { buildCoordinatorInstructions } = await import('../packages/squad-sdk/src/client/adapters/coordinator.js');
    for (const host of ['copilot', 'claude', 'kiro', 'opencode', 'cursor', 'codex', 'antigravity'] as const) {
      const text = buildCoordinatorInstructions(host, '.squad');
      expect(text, host).toMatch(/\*\*A denied action stays denied\.\*\*/);
      expect(text, host).toMatch(/do NOT retry it or reach the same result another way \(another tool, path or launcher, shell redirection, a script/);
    }
  });
});
