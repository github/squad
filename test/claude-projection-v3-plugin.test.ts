/**
 * Claude projection v3 (#2443): plugin mode. With `"claudePlugin": true` in `.squad/config.json`
 * the Squad Claude Code plugin carries the coordinator, skills, hooks and squad_state MCP server, and
 * the projection keeps only per-repository files: member subagents, the CLAUDE.md block, the
 * .gitignore line and two `.claude/settings.json` keys (`agent`, `disabledMcpjsonServers`).
 *
 * Switching modes either way, and rolling back from either mode, must leave user bytes untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_PLUGIN_AGENT,
  CLAUDE_PLUGIN_MCP_PREFIX,
  installClients,
  uninstallClients,
  mergeClaudePluginSettings,
} from '../packages/squad-sdk/src/client/adapters/index.js';

const MCP = { command: 'squad', args: ['state-mcp'] };
let root: string;

const abs = (rel: string) => path.join(root, rel);
const exists = (rel: string) => fs.existsSync(abs(rel));
const readText = (rel: string) => fs.readFileSync(abs(rel), 'utf8');
const readJson = (rel: string) => JSON.parse(readText(rel));

function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
  fs.writeFileSync(abs(rel), content);
}

function setConfig(config: Record<string, unknown>): void {
  write('.squad/config.json', `${JSON.stringify(config, null, 2)}\n`);
}

function snapshot(): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isDirectory()) {
        files[`${rel}/`] = 'dir';
        walk(p);
      } else files[rel] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(root);
  return files;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-claude-v3-'));
  write('.squad/team.md', '# Team\n');
  write('.squad/agents/dallas/charter.md', '# Dallas — Backend Dev\n\n## Identity\n- **ID:** `dallas`\n');
  write('.squad/agents/scribe/charter.md', '# Scribe\n\n## Identity\n- **ID:** `scribe`\n');
  write('.squad/templates/skills/git-workflow/SKILL.md', '---\nname: "git-workflow"\ndescription: "Branching"\n---\n\nUse branches.\n');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('Claude projection v3: plugin mode install', () => {
  it('writes members, CLAUDE.md, .gitignore and the settings keys; no coordinator, skills, hooks or .mcp.json', () => {
    setConfig({ claudePlugin: true, claudeHooks: 'advisory' });
    installClients(['claude'], { root, mcp: MCP });

    expect(exists('.claude/agents/squad.md')).toBe(false);
    expect(exists('.claude/skills')).toBe(false);
    expect(exists('.mcp.json')).toBe(false);
    expect(readJson('.claude/settings.json')).toEqual({ agent: CLAUDE_PLUGIN_AGENT, disabledMcpjsonServers: ['squad_state'] });

    const dallas = readText('.claude/agents/dallas.md');
    expect(dallas).toContain('Claude projection v3.');
    expect(dallas).toContain(`${CLAUDE_PLUGIN_MCP_PREFIX}*`);
    expect(dallas).not.toContain('`mcp__squad_state__*`');
    expect(readText('CLAUDE.md')).toMatch(/plugin/i);
    expect(readText('.gitignore')).toContain('.claude/worktrees/');
  });

  it('is idempotent', () => {
    setConfig({ claudePlugin: true });
    installClients(['claude'], { root, mcp: MCP });
    const once = snapshot();
    const again = installClients(['claude'], { root, mcp: MCP });
    expect(again.filter((r) => r.action !== 'unchanged' && r.action !== 'skipped')).toEqual([]);
    expect(snapshot()).toEqual(once);
  });

  it('rolls a fresh repo back to exactly its pre-install tree', () => {
    setConfig({ claudePlugin: true });
    const before = snapshot();
    installClients(['claude'], { root, mcp: MCP });
    uninstallClients(['claude'], { root, mcp: MCP });
    expect(snapshot()).toEqual(before);
  });

  it("keeps the user's settings, agent choice and disabled servers, and restores their bytes on rollback", () => {
    setConfig({ claudePlugin: true });
    write('CLAUDE.md', '# Mine\r\n\r\nUse pnpm.');
    write('.mcp.json', `${JSON.stringify({ mcpServers: { github: { command: 'gh-mcp' } } }, null, 2)}\n`);
    write(
      '.claude/settings.json',
      `${JSON.stringify({ model: 'opus', disabledMcpjsonServers: ['github'], permissions: { allow: ['Bash(npm test:*)'] } }, null, 2)}\n`,
    );
    const before = snapshot();

    installClients(['claude'], { root, mcp: MCP });
    expect(readJson('.claude/settings.json')).toEqual({
      model: 'opus',
      disabledMcpjsonServers: ['github', 'squad_state'],
      permissions: { allow: ['Bash(npm test:*)'] },
      agent: CLAUDE_PLUGIN_AGENT,
    });
    expect(readText('.mcp.json')).toBe(Buffer.from(before['.mcp.json']!, 'base64').toString());
    installClients(['claude'], { root, mcp: MCP });
    uninstallClients(['claude'], { root, mcp: MCP });
    expect(snapshot()).toEqual(before);
  });

  it('never replaces a different agent the user chose', () => {
    expect(mergeClaudePluginSettings({ agent: 'reviewer' }, true)).toEqual({ agent: 'reviewer', disabledMcpjsonServers: ['squad_state'] });
    expect(mergeClaudePluginSettings({ agent: 'squad' }, true)).toMatchObject({ agent: CLAUDE_PLUGIN_AGENT });
    expect(mergeClaudePluginSettings({ agent: 'reviewer', disabledMcpjsonServers: ['squad_state'] }, false)).toEqual({ agent: 'reviewer' });
    const untouched = { model: 'opus' };
    expect(mergeClaudePluginSettings(untouched, false)).toBe(untouched);
    expect(() => mergeClaudePluginSettings({ disabledMcpjsonServers: 'squad_state' }, true)).toThrow();
  });
});

describe('Claude projection v3: switching modes', () => {
  it('project → plugin removes the coordinator, Squad skills and hooks, and keeps user files', () => {
    setConfig({ claudeHooks: 'advisory' });
    write('.claude/settings.json', '{\n  "model": "opus"\n}\n');
    write('.claude/skills/mine/SKILL.md', '---\nname: mine\n---\nMine.\n');
    const before = snapshot();
    installClients(['claude'], { root, mcp: MCP });
    expect(exists('.claude/agents/squad.md')).toBe(true);
    expect(exists('.claude/skills/git-workflow/SKILL.md')).toBe(true);
    expect(readJson('.claude/settings.json').hooks).toBeDefined();

    setConfig({ claudeHooks: 'advisory', claudePlugin: true });
    installClients(['claude'], { root, mcp: MCP });
    expect(exists('.claude/agents/squad.md')).toBe(false);
    expect(exists('.claude/skills/git-workflow')).toBe(false);
    expect(readText('.claude/skills/mine/SKILL.md')).toContain('Mine.');
    const settings = readJson('.claude/settings.json');
    expect(settings.hooks).toBeUndefined();
    expect(settings).toMatchObject({ model: 'opus', agent: CLAUDE_PLUGIN_AGENT, disabledMcpjsonServers: ['squad_state'] });
    // The project .mcp.json entry stays (Copilot uses it); Claude ignores it through disabledMcpjsonServers.
    expect(readJson('.mcp.json').mcpServers.squad_state).toBeDefined();

    setConfig({ claudeHooks: 'advisory' });
    uninstallClients(['claude'], { root, mcp: MCP });
    expect(snapshot()).toEqual({ ...before });
  });

  it('plugin → project restores the coordinator, skills and hooks and drops the plugin keys', () => {
    setConfig({ claudeHooks: 'advisory', claudePlugin: true });
    installClients(['claude'], { root, mcp: MCP });
    setConfig({ claudeHooks: 'advisory', claudePlugin: false });
    installClients(['claude'], { root, mcp: MCP });
    expect(readText('.claude/agents/squad.md')).toContain('Claude projection v3.');
    expect(exists('.claude/skills/git-workflow/SKILL.md')).toBe(true);
    const settings = readJson('.claude/settings.json');
    expect(settings.agent).toBeUndefined();
    expect(settings.disabledMcpjsonServers).toBeUndefined();
    expect(settings.hooks).toBeDefined();
    expect(readText('.claude/agents/dallas.md')).toContain('`mcp__squad_state__*`');
  });
});
