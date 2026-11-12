/**
 * `squad init` tells the user to run the host they chose, not always Copilot (#2453).
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initNextSteps, runInit } from '../packages/squad-cli/src/cli/core/init.js';

const plain = (clients: Parameters<typeof initNextSteps>[0], plugin?: boolean) => {
  const next = initNextSteps(clients, plugin);
  return { lines: next.lines.map(line => line('', '')), tips: next.tips };
};

describe('initNextSteps (#2453)', () => {
  it('defaults to Copilot when no client is chosen', () => {
    for (const clients of [undefined, []]) {
      const { lines, tips } = plain(clients);
      expect(lines).toEqual(["Run copilot --agent squad and tell it what you're building."]);
      expect(tips).toEqual(['"squad:copilot": "copilot --agent squad --additional-mcp-config @.mcp.json"']);
    }
  });

  it('tells a Claude-only user to run Claude Code, never Copilot', () => {
    const { lines, tips } = plain(['claude']);
    expect(lines).toEqual(["Run claude --agent squad --mcp-config .mcp.json and tell it what you're building."]);
    expect(tips).toEqual(['"squad:claude": "claude -p --agent squad --mcp-config .mcp.json"']);
    expect([...lines, ...tips].join('\n')).not.toMatch(/copilot/i);
  });

  it('uses the plugin coordinator in plugin mode', () => {
    const { lines, tips } = plain(['claude'], true);
    expect(lines).toEqual(["Run claude; the Squad plugin's coordinator starts by default in this repository."]);
    expect(tips).toEqual(['"squad:claude": "claude -p --agent squad:squad"']);
    // --claude-plugin without --client keeps Copilot, the default host, beside Claude Code.
    expect(plain(undefined, true).lines).toEqual([
      "GitHub Copilot: Run copilot --agent squad and tell it what you're building.",
      "Claude Code: Run claude; the Squad plugin's coordinator starts by default in this repository.",
    ]);
  });

  it('lists every chosen host, each with its name', () => {
    const { lines, tips } = plain(['copilot', 'claude', 'kiro', 'claude']);
    expect(lines).toEqual([
      "GitHub Copilot: Run copilot --agent squad and tell it what you're building.",
      "Claude Code: Run claude --agent squad --mcp-config .mcp.json and tell it what you're building.",
      'Kiro: Open Kiro in this repository and ask for the squad agent.',
    ]);
    expect(tips).toHaveLength(2);
  });

  it('wraps the command, and only the command, in the styling', () => {
    expect(initNextSteps(['claude']).lines[0]!('<', '>')).toBe(
      "Run <claude --agent squad --mcp-config .mcp.json> and tell it what you're building.",
    );
  });

  it('re-running init without flags follows what .squad/config.json records (Copilot review)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-init-next-'));
    const prev = { ni: process.env['SQUAD_NONINTERACTIVE'], nc: process.env['NO_COLOR'] };
    process.env['SQUAD_NONINTERACTIVE'] = '1';
    process.env['NO_COLOR'] = '1';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await runInit(root, { clients: ['claude'], claudePlugin: true, includeWorkflows: false, includeVscodeDefault: false });
      log.mockClear();
      await runInit(root, { includeWorkflows: false, includeVscodeDefault: false });
      const out = log.mock.calls.map(c => String(c[0])).join('\n');
      expect(out).toContain("the Squad plugin's coordinator starts by default");
      expect(out).not.toContain('--mcp-config .mcp.json and tell it');
    } finally {
      log.mockRestore();
      warn.mockRestore();
      if (prev.ni === undefined) delete process.env['SQUAD_NONINTERACTIVE']; else process.env['SQUAD_NONINTERACTIVE'] = prev.ni;
      if (prev.nc === undefined) delete process.env['NO_COLOR']; else process.env['NO_COLOR'] = prev.nc;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
