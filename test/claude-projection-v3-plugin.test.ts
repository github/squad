/**
 * Claude projection v3 (#2443): plugin mode. With `"claudePlugin": true` in `.squad/config.json`
 * the Squad Claude Code plugin carries the coordinator, skills, hooks and squad_state MCP server, and
 * the projection keeps only per-repository files: member subagents, the CLAUDE.md block, the
 * .gitignore line and two `.claude/settings.json` keys (`agent`, `disabledMcpjsonServers`).
 *
 * Switching modes either way, and rolling back from either mode, must leave user bytes untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_PLUGIN_AGENT,
  CLAUDE_PLUGIN_MCP_PREFIX,
  claudePermissionRules,
  installClients,
  uninstallClients,
  mergeClaudePluginSettings,
  projectHasSquadHooks,
  runClaudeHook,
} from '../packages/squad-sdk/src/client/adapters/index.js';
import { JsonlTail } from '../packages/squad-cli/src/cli/dashboard/sources.js';
import { startDashboardServer } from '../packages/squad-cli/src/cli/dashboard/server.js';
import { buildClaudeCommand } from '../packages/squad-cli/src/cli/commands/watch/agent-spawn.js';
import * as watchSpawn from '../packages/squad-cli/src/cli/commands/watch/agent-spawn.js';
import { claudePreflight } from '../packages/squad-cli/src/cli/commands/watch/capabilities/execute.js';
import { runInit } from '../packages/squad-cli/src/cli/core/init.js';

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
  root = fs.mkdtempSync(path.resolve(__dirname, '../.claude-review-'));
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
    expect(readJson('.claude/settings.json')).toEqual({
      agent: CLAUDE_PLUGIN_AGENT,
      disabledMcpjsonServers: ['squad_state'],
      permissions: { allow: claudePermissionRules(null, true) },
    });
    expect(readJson('.claude/settings.json').permissions.allow[0]).toBe(`${CLAUDE_PLUGIN_MCP_PREFIX}squad_decide`);

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
      permissions: { allow: ['Bash(npm test:*)', ...claudePermissionRules(null, true)] },
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
    expect(mergeClaudePluginSettings({ agent: 'reviewer', disabledMcpjsonServers: ['squad_state'] }, false)).toEqual({
      agent: 'reviewer', disabledMcpjsonServers: ['squad_state'],
    });
    const untouched = { model: 'opus' };
    expect(mergeClaudePluginSettings(untouched, false)).toBe(untouched);
    expect(() => mergeClaudePluginSettings({ disabledMcpjsonServers: 'squad_state' }, true)).toThrow();
  });

  describe('Existing Copilot review regressions (#2463)', () => {
    it('keeps user-disabled MCP and restores a replaced project coordinator across mode switches', () => {
      const original = { agent: 'squad', disabledMcpjsonServers: ['squad_state', 'github'] };
      write('.claude/settings.json', JSON.stringify(original));
      const projected = { ...original, permissions: { allow: claudePermissionRules(null, false) } };
      installClients(['claude'], { root, mcp: MCP });
      expect(readJson('.claude/settings.json')).toEqual(projected);
      setConfig({ claudePlugin: true });
      installClients(['claude'], { root, mcp: MCP });
      installClients(['claude'], { root, mcp: MCP });
      expect(readJson('.claude/settings.json').agent).toBe(CLAUDE_PLUGIN_AGENT);
      expect([...readJson('.claude/settings.json').permissions.allow].sort()).toEqual(claudePermissionRules(null, true).sort());
      setConfig({ claudePlugin: false });
      installClients(['claude'], { root, mcp: MCP });
      // Switching back swaps the plugin's tool rules for the project server's, appended after the rest.
      const back = readJson('.claude/settings.json');
      expect({ ...back, permissions: { allow: [...back.permissions.allow].sort() } })
        .toEqual({ ...projected, permissions: { allow: [...projected.permissions.allow].sort() } });
    });

    it('removes former Claude MCP ownership while still in plugin mode, but honors kept clients', () => {
      for (const keep of [[], ['copilot']] as const) {
        setConfig({});
        installClients(['claude'], { root, mcp: MCP });
        write('.mcp.json', JSON.stringify({ ...readJson('.mcp.json'), extra: true }));
        const before = readText('.mcp.json');
        setConfig({ claudePlugin: true });
        installClients(['claude'], { root, mcp: MCP });
        expect(readText('.mcp.json')).toBe(before);
        uninstallClients(['claude'], { root, mcp: MCP }, keep);
        expect(readJson('.mcp.json').mcpServers?.squad_state !== undefined).toBe(keep.length > 0);
        expect(readJson('.mcp.json').extra).toBe(true);
      }
    });

    it('does not claim a fresh plugin install owns an existing project MCP entry', () => {
      write('.mcp.json', '{"mcpServers":{"squad_state":{"command":"mine"}}}');
      const before = readText('.mcp.json');
      setConfig({ claudePlugin: true });
      installClients(['claude'], { root, mcp: MCP });
      uninstallClients(['claude'], { root, mcp: MCP });
      expect(readText('.mcp.json')).toBe(before);
    });

    it('does not record ownership when invalid user settings prevent plugin-mode changes', () => {
      setConfig({ claudePlugin: true });
      write('.claude/settings.json', '{"disabledMcpjsonServers":"invalid"}');
      const results = installClients(['claude'], { root, mcp: MCP });
      expect(results.some((r) => r.path === '.claude/settings.json' && r.action === 'error')).toBe(true);
      expect(exists('.claude/.squad-plugin-settings.json')).toBe(false);
      expect(readText('.claude/settings.json')).toBe('{"disabledMcpjsonServers":"invalid"}');
    });

    it('deduplicates only the matching project hook event', () => {
      setConfig({ claudeHooks: 'advisory' });
      write('.claude/settings.json', JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'squad', args: ['hook', 'claude', 'SessionStart'] }] }] },
      }));
      expect(projectHasSquadHooks(root, 'SessionStart')).toBe(true);
      expect(projectHasSquadHooks(root, 'Stop')).toBe(false);
      write('.squad/decisions/inbox/pending.md', '# Pending\n');
      const output = runClaudeHook('Stop', { agent_type: 'squad' }, {
        root, teamAbs: abs('.squad'), projectAbs: abs('.squad'), version: 'test', source: 'plugin',
      });
      expect(output).not.toBeNull();
    });

    it('keeps a UTF-8 character intact across every split byte boundary', () => {
      const bytes = Buffer.from('{"text":"—😺"}\n');
      for (let split = 1; split < bytes.length; split++) {
        fs.writeFileSync(abs('tail.jsonl'), bytes.subarray(0, split));
        const tail = new JsonlTail(abs('tail.jsonl'));
        expect(tail.read()).toEqual([]);
        fs.appendFileSync(abs('tail.jsonl'), bytes.subarray(split));
        expect(tail.read()).toEqual([{ text: '—😺' }]);
        expect(tail.read()).toEqual([]);
      }
    });

    it('advances the transcript cursor by the actual short read, retaining all lines', () => {
      write('tail.jsonl', '{"one":1}\n{"two":2}\n');
      const tail = new JsonlTail(abs('tail.jsonl'));
      const read = fs.readSync.bind(fs);
      const spy = vi.spyOn(fs, 'readSync').mockImplementationOnce((fd, buffer, offset, _length, position) =>
        read(fd, buffer, offset, 5, position));
      try {
        expect(tail.read()).toEqual([]);
        expect(tail.read()).toEqual([{ one: 1 }, { two: 2 }]);
      } finally {
        spy.mockRestore();
      }
    });

    it('reloads the dashboard on reconnect before history replay can duplicate the timeline', () => {
      const node = () => ({
        classList: { add() {}, toggle() {}, contains: () => true },
        dataset: {}, addEventListener() {},
      });
      const reload = vi.fn();
      const close = vi.fn();
      let stream: { onopen?: () => void };
      const context = vm.createContext({
        document: { getElementById: node, querySelectorAll: () => [], documentElement: { dataset: {} } },
        window: { addEventListener() {} }, localStorage: { getItem: () => null },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        location: { reload }, setInterval() {}, fetch: () => Promise.reject(new Error('offline')),
        EventSource: class {
          close = close;
          constructor() { stream = this; }
          addEventListener() {}
        },
      });
      const app = path.resolve(__dirname, '../packages/squad-cli/src/dashboard-ui/app.js');
      vm.runInContext(fs.readFileSync(app, 'utf8'), context);
      stream!.onopen!();
      expect(reload).not.toHaveBeenCalled();
      stream!.onopen!();
      expect(close).toHaveBeenCalledOnce();
      expect(reload).toHaveBeenCalledOnce();
    });

    it('uses the plugin coordinator and plugin MCP without the project MCP override in watch sessions', () => {
      setConfig({ claudePlugin: true });
      const cmd = buildClaudeCommand('work', { teamRoot: root, claudeMcpConfig: 'project.json' }, { session: true });
      expect(cmd.args).toContain(CLAUDE_PLUGIN_AGENT);
      expect(cmd.args).not.toContain('--mcp-config');
      setConfig({});
      const project = buildClaudeCommand('work', { teamRoot: root, claudeMcpConfig: 'project.json' }, { session: true });
      expect(project.args).toContain('squad');
      expect(project.args).toContain('--mcp-config');
    });

    it('accepts a plugin-only watch preflight without a project coordinator file', async () => {
      const check = vi.spyOn(watchSpawn, 'checkClaudeCli').mockResolvedValue({ ok: true });
      try {
        setConfig({ claudePlugin: true });
        expect(await claudePreflight(root)).toEqual({ ok: true });
        expect(check).toHaveBeenCalledOnce();
        setConfig({});
        expect((await claudePreflight(root)).reason).toContain('.claude/agents/squad.md');
      } finally {
        check.mockRestore();
      }
    });

    it('honors direct runInit claudePlugin callers without an explicit clients list', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        expect(spawnSync('git', ['init', '--quiet', root]).status).toBe(0);
        await runInit(root, { claudePlugin: true });
        expect(readJson('.squad/config.json').claudePlugin).toBe(true);
        expect(readJson('.claude/settings.json').agent).toBe(CLAUDE_PLUGIN_AGENT);
      } finally {
        log.mockRestore();
      }
    });

    it('shuts down an idle dashboard but keeps one with a connected browser alive', async () => {
      const server = await startDashboardServer({
        uiDir: root, port: 0, pollMs: 10, idleMs: 60,
        source: () => undefined,
        meta: () => ({ repo: 'test', owner: '', source: 'fixture', roles: {} }),
      });
      const stream = await fetch(`${server.url}events`);
      const reader = stream.body!.getReader();
      await reader.read();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect((await fetch(`${server.url}health`)).ok).toBe(true);
      await reader.cancel();
      await new Promise((resolve) => setTimeout(resolve, 130));
      await expect(fetch(`${server.url}health`)).rejects.toThrow();
      await server.close();
    });

    it('skips disabled plugin hooks before resolving a CLI, including remote-team opt-in', () => {
      const launcher = path.resolve(__dirname, '../plugins/squad/scripts/squad.mjs');
      write('stub.cjs', 'process.stdout.write("started");\n');
      const run = () => spawnSync(process.execPath, [launcher, 'hook', 'claude', 'Stop', '--plugin'], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: root, SQUAD_CLI: abs('stub.cjs') },
      });
      expect(run().stdout).toBe('');
      setConfig({ version: 1, teamRoot: './remote' });
      write('remote/.squad/config.json', '{"claudeHooks":"advisory"}');
      expect(run().stdout).toBe('started');
    });

    it.skipIf(process.platform === 'win32')('does not recurse through a symlinked plugin bin on PATH', () => {
      const launcher = path.resolve(__dirname, '../plugins/squad/scripts/squad.mjs');
      const bin = path.resolve(__dirname, '../plugins/squad/bin');
      fs.symlinkSync(bin, abs('linked-bin'));
      write('fallback/npx', '#!/bin/sh\nprintf fallback\n');
      fs.chmodSync(abs('fallback/npx'), 0o755);
      const result = spawnSync(process.execPath, [launcher, 'status'], {
        cwd: root, encoding: 'utf8', timeout: 3000,
        env: { PATH: `${abs('linked-bin')}:${abs('fallback')}:/usr/bin:/bin`, CLAUDE_PROJECT_DIR: root, SQUAD_ALLOW_NPX: '1', SQUAD_HOME: abs('no-squad-home') },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('fallback');
    });

    it.skipIf(process.platform === 'win32')('runs Windows npm shim JavaScript directly, preserving literal argv', () => {
      const launcher = path.resolve(__dirname, '../plugins/squad/scripts/squad.mjs');
      write('scripts/squad.mjs', fs.readFileSync(launcher, 'utf8').replace(
        "const win = process.platform === 'win32';", 'const win = true;',
      ));
      fs.mkdirSync(abs('bin'));
      fs.mkdirSync(abs('project'));
      write('global/squad.CMD', 'this shim must not execute');
      write('global/node_modules/@bradygaster/squad-cli/dist/cli-entry.js', 'console.log(JSON.stringify(process.argv.slice(2)))');
      const args = ['two words', 'literal&token', 'literal"quote'];
      const run = () => spawnSync(process.execPath, [abs('scripts/squad.mjs'), ...args], {
        cwd: root, encoding: 'utf8', env: { PATH: abs('global'), PATHEXT: '.CMD', CLAUDE_PROJECT_DIR: abs('project'), SQUAD_ALLOW_NPX: '1', SQUAD_HOME: abs('no-squad-home') },
      });
      const global = run();
      expect(global.status, global.stderr).toBe(0);
      expect(JSON.parse(global.stdout)).toEqual(args);
      fs.rmSync(abs('global/squad.CMD'));
      write('global/npx.CMD', 'this shim must not execute');
      write('global/node_modules/npm/bin/npx-cli.js', 'console.log(JSON.stringify(process.argv.slice(2)))');
      const fallback = run();
      expect(fallback.status, fallback.stderr).toBe(0);
      expect(JSON.parse(fallback.stdout).slice(-3)).toEqual(args);
    });

    it.skipIf(process.platform === 'win32')('passes mesh URLs and authorization as data without shell reparsing', () => {
      const source = 'https://example.test/$(printf changed)?x=1&y=two';
      const target = abs('output space');
      write('mesh.json', JSON.stringify({ squads: { peer: { zone: 'remote-opaque', source, sync_to: target, auth: 'bearer' } } }));
      write('bin/curl', `#!${process.execPath}\nimport fs from 'node:fs';let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>fs.writeFileSync(${JSON.stringify(abs('curl-result.json'))},JSON.stringify({args:process.argv.slice(2),input})));\n`);
      fs.chmodSync(abs('bin/curl'), 0o755);
      const script = path.resolve(__dirname, '../.squad-templates/skills/distributed-mesh/sync-mesh.sh');
      const result = spawnSync('bash', [script, abs('mesh.json')], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, PATH: `${abs('bin')}:${process.env.PATH}`, PEER_TOKEN: 'literal-token' },
      });
      expect(result.status, result.stderr).toBe(0);
      const captured = readJson('curl-result.json');
      expect(captured.args).toContain(source);
      expect(captured.args).toContain(`${target}/SUMMARY.md`);
      expect(captured.args).not.toContain('literal-token');
      expect(captured.input).toBe('Authorization: Bearer literal-token\n');
      write('mesh.json', JSON.stringify({ squads: { peer: { zone: 'remote-opaque', source, sync_to: target } } }));
      const anonymous = spawnSync('bash', [script, abs('mesh.json')], {
        cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${abs('bin')}:${process.env.PATH}` },
      });
      expect(anonymous.status, anonymous.stderr).toBe(0);
      expect(readJson('curl-result.json').args).not.toContain('--header');
      expect(readJson('curl-result.json').args).toContain(source);
    });
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
