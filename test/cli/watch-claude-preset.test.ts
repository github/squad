/**
 * Built-in Claude Code runner for `squad watch --execute` (#2442 Phase 6).
 *
 * The execute tests put a fake `claude` executable on PATH that records its argv and prints a
 * stream-json `result` event, so the real capability, preflight and spawn path are exercised.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecuteCapability } from '../../packages/squad-cli/src/cli/commands/watch/capabilities/execute.js';
import { loadWatchConfig, CLAUDE_DEFAULT_EXECUTE_FLAGS } from '../../packages/squad-cli/src/cli/commands/watch/config.js';
import {
  buildAgentCommand,
  buildCopilotCommand,
  parseClaudeStreamResult,
  spawnWithTimeout,
} from '../../packages/squad-cli/src/cli/commands/watch/agent-spawn.js';
import { writeClaudeWatchMcpConfig } from '../../packages/squad-cli/src/cli/commands/watch/claude-mcp.js';
import type { WatchContext } from '../../packages/squad-cli/src/cli/commands/watch/types.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

let tmp: string;
let binDir: string;
const originalPath = process.env['PATH'];

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-watch-claude-'));
  binDir = path.join(tmp, 'bin');
  fs.mkdirSync(binDir);
  const fake = path.join(binDir, 'claude');
  fs.writeFileSync(
    fake,
    [
      '#!/usr/bin/env node',
      "const fs = require('fs');",
      "if (process.argv[2] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }",
      "fs.writeFileSync(process.env.FAKE_CLAUDE_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));",
      "console.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet-5' }));",
      "const failed = process.env.FAKE_CLAUDE_MODE === 'error';",
      "console.log(JSON.stringify({ type: 'result', subtype: failed ? 'error_max_turns' : 'success', is_error: failed, result: failed ? '' : 'done' }));",
    ].join('\n'),
  );
  fs.chmodSync(fake, 0o755);
});

afterAll(() => {
  process.env['PATH'] = originalPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

afterEach(() => {
  process.env['PATH'] = originalPath;
  delete process.env['FAKE_CLAUDE_RECORD'];
  delete process.env['FAKE_CLAUDE_MODE'];
  vi.restoreAllMocks();
});

function team(name: string, opts: { mcp?: boolean; coordinator?: boolean } = {}): string {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, '.squad', 'agents', 'ralph'), { recursive: true });
  fs.writeFileSync(path.join(root, '.squad', 'agents', 'ralph', 'charter.md'), '# Ralph — Work Monitor\n');
  if (opts.mcp !== false) fs.writeFileSync(path.join(root, '.mcp.json'), '{"mcpServers":{}}\n');
  if (opts.coordinator !== false) {
    fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'agents', 'squad.md'), '---\nname: squad\n---\n');
  }
  return root;
}

function context(teamRoot: string, overrides: Partial<WatchContext> = {}): WatchContext {
  return {
    teamRoot,
    stateRoot: path.join(teamRoot, '.squad'),
    adapter: {
      type: 'github',
      listWorkItems: vi.fn(async () => [
        { id: 7, title: 'Fix login redirect', state: 'open', tags: ['squad', 'squad:eecom'], url: 'https://github.com/acme/w/issues/7' },
      ]),
    } as unknown as WatchContext['adapter'],
    round: 1,
    roster: [],
    config: { timeout: 1 },
    agentPreset: 'claude',
    claudeFlags: CLAUDE_DEFAULT_EXECUTE_FLAGS,
    claudeMcpConfig: path.join(teamRoot, 'squad-state-mcp.json'),
    ...overrides,
  };
}

describe('Claude preset: command shape', () => {
  it('execute and wave-dispatch run the projected coordinator with the squad_state-only MCP config', () => {
    const root = team('shape');
    const { cmd, args } = buildCopilotCommand('Ralph, Go!', context(root));
    expect(cmd).toBe('claude');
    expect(args).toEqual([
      '-p', 'Ralph, Go!',
      '--agent', 'squad',
      '--mcp-config', path.join(root, 'squad-state-mcp.json'),
      '--output-format', 'stream-json', '--verbose',
      '--permission-mode', 'bypassPermissions',
    ]);
  });

  it('monitor and hygiene prompts run in a plain Claude Code session', () => {
    const root = team('plain');
    const { cmd, args } = buildAgentCommand('scan the inbox', context(root, { claudeFlags: '--model haiku' }));
    expect(cmd).toBe('claude');
    expect(args).not.toContain('--agent');
    expect(args.slice(-2)).toEqual(['--model', 'haiku']);
  });

  it('never passes the repository .mcp.json, and warns when no squad_state config was written', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const root = team('no-mcp');
    const { args } = buildCopilotCommand('x', context(root, { claudeMcpConfig: undefined }));
    expect(args).not.toContain('--mcp-config');
    expect(args.join(' ')).not.toContain('.mcp.json');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('squad_state tools will NOT be available'));
  });

  it('writes a private MCP config with only squad_state, resolved by the CLI, not the repository', async () => {
    const file = await writeClaudeWatchMcpConfig('1.2.3');
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(Object.keys(cfg.mcpServers)).toEqual(['squad_state']);
    expect(cfg.mcpServers.squad_state!.args.at(-1)).toBe('state-mcp');
    expect(path.relative(os.tmpdir(), file).startsWith('..')).toBe(false);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('an explicit agentCmd still wins over the preset', () => {
    expect(buildCopilotCommand('x', context(team('override'), { agentCmd: 'my-agent {prompt}' }))).toEqual({ cmd: 'my-agent', args: ['x'] });
  });

  it('reads failure from the final stream-json result event', () => {
    const ok = '{"type":"system"}\n{"type":"result","subtype":"success","is_error":false,"result":"done"}\n';
    expect(parseClaudeStreamResult(ok)).toBeUndefined();
    expect(parseClaudeStreamResult('{"type":"result","subtype":"error_max_turns","is_error":true}\n')).toMatch(/error_max_turns/);
    expect(parseClaudeStreamResult('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API overloaded"}')).toMatch(/API overloaded/);
    expect(parseClaudeStreamResult('not json\n')).toBeUndefined();
  });
});

describe('Claude preset: monitor, retro and hygiene runs', () => {
  posixOnly('fail on an error result event even when claude exits 0', async () => {
    process.env['PATH'] = `${binDir}${path.delimiter}${originalPath}`;
    const root = team('generic');
    process.env['FAKE_CLAUDE_RECORD'] = path.join(root, 'argv.json');
    const { cmd, args, checkStdout } = buildAgentCommand('scan the inbox', context(root));
    expect(checkStdout).toBe(parseClaudeStreamResult);
    await expect(spawnWithTimeout(cmd, args, root, 20_000, checkStdout)).resolves.toBeUndefined();
    process.env['FAKE_CLAUDE_MODE'] = 'error';
    await expect(spawnWithTimeout(cmd, args, root, 20_000, checkStdout)).rejects.toThrow(/error_max_turns/);
  }, 30_000);
});

describe('Claude preset: watch config', () => {
  const withConfig = (name: string, watch: Record<string, unknown>) => {
    const root = path.join(tmp, `cfg-${name}`);
    fs.mkdirSync(path.join(root, '.squad'), { recursive: true });
    fs.writeFileSync(path.join(root, '.squad', 'config.json'), JSON.stringify({ watch }));
    return root;
  };

  it('defaults execute mode to bypassPermissions, the counterpart of the Copilot --yolo default', () => {
    expect(loadWatchConfig(withConfig('default', { agentPreset: 'claude', execute: true }), {})).toMatchObject({
      agentPreset: 'claude',
      claudeFlags: '--permission-mode bypassPermissions',
    });
  });

  it('keeps caller flags, adds no default without execute or with agentCmd, and lets the CLI win', () => {
    const root = withConfig('flags', { agentPreset: 'claude', claudeFlags: '--permission-mode acceptEdits' });
    expect(loadWatchConfig(root, { execute: true }).claudeFlags).toBe('--permission-mode acceptEdits');
    expect(loadWatchConfig(withConfig('noexec', { agentPreset: 'claude' }), {}).claudeFlags).toBeUndefined();
    expect(loadWatchConfig(withConfig('cmd', { agentPreset: 'claude', agentCmd: 'x' }), { execute: true }).claudeFlags).toBeUndefined();
    expect(loadWatchConfig(root, { agentPreset: 'copilot' }).agentPreset).toBe('copilot');
  });

  it('limits watch.claudeFlags from the repository file to safe flags; the CLI flag is unrestricted', () => {
    for (const bad of ['--mcp-config .mcp.json', '--model sonnet --mcp-config=.mcp.json', '--settings x.json', '--agent other', '--add-dir /', '--plugin-dir p', '--dangerously-skip-permissions', '--allowedTools Bash', '--disallowed-tools=WebFetch', '--permission-mode yolo', '--max-turns 0']) {
      expect(() => loadWatchConfig(withConfig(`bad-${bad.replace(/\W+/g, '')}`, { agentPreset: 'claude', claudeFlags: bad }), {}), bad).toThrow(/watch\.claudeFlags/);
    }
    const ok = '--permission-mode acceptEdits --model claude-sonnet-5-5 --effort high --max-turns=40';
    expect(loadWatchConfig(withConfig('good-flags', { agentPreset: 'claude', claudeFlags: ok }), {}).claudeFlags).toBe(ok);
    expect(loadWatchConfig(withConfig('cli-flags', { agentPreset: 'claude' }), { claudeFlags: '--mcp-config extra.json' }).claudeFlags).toBe('--mcp-config extra.json');
  });

  it('rejects an unknown preset instead of silently using Copilot', () => {
    expect(() => loadWatchConfig(withConfig('bad', { agentPreset: 'gemini' }), {})).toThrow(/agentPreset must be "copilot" or "claude"/);
  });

  it('leaves the default Copilot runner unchanged', () => {
    expect(loadWatchConfig(withConfig('copilot', {}), { execute: true })).toMatchObject({ copilotFlags: '--yolo' });
    expect(loadWatchConfig(withConfig('copilot2', {}), { execute: true }).agentPreset).toBeUndefined();
  });
});

describe('Claude preset: execute capability', () => {
  posixOnly('preflight needs the projected coordinator and the claude CLI', async () => {
    process.env['PATH'] = `${binDir}${path.delimiter}${originalPath}`;
    expect(await new ExecuteCapability().preflight(context(team('pre-ok')))).toEqual({ ok: true });
    const missing = await new ExecuteCapability().preflight(context(team('pre-missing', { coordinator: false })));
    expect(missing).toMatchObject({ ok: false, reason: expect.stringContaining('squad upgrade --client claude') });
    process.env['PATH'] = path.join(tmp, 'empty-bin');
    expect(await new ExecuteCapability().preflight(context(team('pre-nocli')))).toMatchObject({ ok: false });
  });

  posixOnly('dispatches the issues to `claude -p --agent squad` with the Ralph-mode prompt and no charter prefix', async () => {
    process.env['PATH'] = `${binDir}${path.delimiter}${originalPath}`;
    const root = team('run');
    process.env['FAKE_CLAUDE_RECORD'] = path.join(root, 'argv.json');
    const result = await new ExecuteCapability().execute(context(root));
    expect(result.success).toBe(true);
    const { argv, cwd } = JSON.parse(fs.readFileSync(path.join(root, 'argv.json'), 'utf8')) as { argv: string[]; cwd: string };
    expect(fs.realpathSync(cwd)).toBe(fs.realpathSync(root));
    expect(argv.slice(2, 4)).toEqual(['--agent', 'squad']);
    expect(argv).toContain('--mcp-config');
    expect(argv).toContain('bypassPermissions');
    const prompt = argv[1]!;
    expect(prompt).toMatch(/^You are Ralph|^Ralph, Go!/);
    expect(prompt).toContain('#7');
    expect(prompt).not.toContain('YOUR CHARTER');
  }, 30_000);

  posixOnly('reports a session whose stream-json result is an error as failed, even on exit 0', async () => {
    process.env['PATH'] = `${binDir}${path.delimiter}${originalPath}`;
    const root = team('run-error');
    process.env['FAKE_CLAUDE_RECORD'] = path.join(root, 'argv.json');
    process.env['FAKE_CLAUDE_MODE'] = 'error';
    const result = await new ExecuteCapability().execute(context(root));
    expect(JSON.stringify(result)).toMatch(/error_max_turns/);
  }, 30_000);
});
