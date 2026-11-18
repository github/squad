/**
 * A project linked to a team repository (remote mode: `teamRoot` in `.squad/config.json`) uses
 * that team in Claude Code (#2487 satellite scenario). `squad init` / `squad upgrade` used to give
 * it a placeholder local team (empty roster, routing, built-ins, casting), and the Claude member
 * subagents came from that empty local team instead of the linked one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { projectClaudeMembers } from '../packages/squad-sdk/src/client/adapters/claude-members.js';
import { buildCoordinatorInstructions } from '../packages/squad-sdk/src/client/adapters/coordinator.js';

let base: string;
let team: string;
let app: string;
const prevEnv = { ni: process.env['SQUAD_NONINTERACTIVE'], nc: process.env['NO_COLOR'] };

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else out[r] = fs.readFileSync(path.join(dir, r), 'utf8');
    }
  };
  walk('.');
  return out;
}

beforeEach(() => {
  process.env['SQUAD_NONINTERACTIVE'] = '1';
  process.env['NO_COLOR'] = '1';
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-linked-team-')));
  team = path.join(base, 'team');
  app = path.join(base, 'app');
  for (const d of [team, app]) {
    fs.mkdirSync(d);
    execFileSync('git', ['init', '--quiet'], { cwd: d });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env['SQUAD_NONINTERACTIVE'] = prevEnv.ni;
  process.env['NO_COLOR'] = prevEnv.nc;
  if (prevEnv.ni === undefined) delete process.env['SQUAD_NONINTERACTIVE'];
  if (prevEnv.nc === undefined) delete process.env['NO_COLOR'];
  fs.rmSync(base, { recursive: true, force: true });
});

describe('Claude Code in a project linked to a team repository', () => {
  it('init and upgrade use the linked team: no local roster, members projected from the team', async () => {
    const { runInit } = await import('../packages/squad-cli/src/cli/core/init.js');
    const { runUpgrade } = await import('../packages/squad-cli/src/cli/core/upgrade.js');
    const { runCastAdd } = await import('../packages/squad-cli/src/cli/commands/cast.js');
    const { writeRemoteConfig } = await import('../packages/squad-cli/src/cli/commands/init-remote.js');

    await runInit(team, { includeWorkflows: false, includeVscodeDefault: false });
    await runCastAdd(team, { name: 'Dallas', role: 'Backend Dev' });
    const teamBefore = snapshot(team);

    writeRemoteConfig(app, '../team');
    await runInit(app, { clients: ['claude'], includeWorkflows: false, includeVscodeDefault: false });
    // Right after init, Copilot's agent file advertises the linked team's cast.
    const agentAfterInit = fs.readFileSync(path.join(app, '.github/agents/squad.agent.md'), 'utf8');
    expect(agentAfterInit.split('<!-- SQUAD:TEAM-CAPABILITIES:BEGIN -->')[1] ?? '').toMatch(/dallas/i);
    await runUpgrade(app, { clients: ['claude'] });

    const local = path.join(app, '.squad');
    for (const f of ['team.md', 'routing.md', 'decisions.md', 'ceremonies.md', 'agents', 'casting', 'identity', 'rai']) {
      expect(fs.existsSync(path.join(local, f)), f).toBe(false);
    }
    // Project-local state and the launcher stay.
    for (const f of ['config.json', 'squad.mjs', 'decisions/inbox']) expect(fs.existsSync(path.join(local, f)), f).toBe(true);

    const dallas = fs.readFileSync(path.join(app, '.claude/agents/dallas.md'), 'utf8');
    expect(dallas).toMatch(/linked team repository/);
    // The charter travels in the file (it lives outside this project); history comes through squad_state.
    expect(dallas).toMatch(/## Your charter \(linked team repository\)\n\n# Dallas/);
    expect(dallas).toContain('`agents/dallas/history.md`');

    // `squad client list` expects the linked members too: a deleted member file is reported.
    const { listClients } = await import('../packages/squad-cli/src/cli/commands/client.js');
    fs.rmSync(path.join(app, '.claude/agents/dallas.md'));
    const claude = (await listClients(app)).clients.find((c) => c.id === 'claude')!;
    expect(claude.files.find((f) => f.path === '.claude/agents/dallas.md')).toEqual({ path: '.claude/agents/dallas.md', present: false });

    // The interactive shell finds the linked team's members.
    const { ShellLifecycle } = await import('../packages/squad-cli/src/cli/shell/lifecycle.js');
    const { SessionRegistry } = await import('../packages/squad-cli/src/cli/shell/sessions.js');
    const { ShellRenderer } = await import('../packages/squad-cli/src/cli/shell/render.js');
    const lifecycle = new ShellLifecycle({ teamRoot: app, renderer: new ShellRenderer(), registry: new SessionRegistry() });
    await lifecycle.initialize();
    expect(lifecycle.getDiscoveredAgents().map((a) => a.name)).toContain('Dallas');
    expect(fs.readFileSync(path.join(app, '.claude/agents/squad.md'), 'utf8')).toMatch(/\*\*Linked team:\*\*/);

    // The team repository is never written by the linked project's init or upgrade.
    expect(snapshot(team)).toEqual(teamBefore);
  }, 120_000);

  it('projects members from ctx.teamDir and reads charters only inside it', () => {
    const teamSquad = path.join(team, '.squad');
    fs.mkdirSync(path.join(teamSquad, 'agents', 'dallas'), { recursive: true });
    fs.writeFileSync(path.join(teamSquad, 'agents', 'dallas', 'charter.md'), '# Dallas — Backend Dev\n\n## Identity\n- **Role:** Backend Dev\n');
    fs.mkdirSync(path.join(base, 'outside'));
    fs.writeFileSync(path.join(base, 'outside', 'charter.md'), '# Evil\n');
    fs.symlinkSync(path.join(base, 'outside'), path.join(teamSquad, 'agents', 'evil'), process.platform === 'win32' ? 'junction' : 'dir');
    const files = projectClaudeMembers({ root: app, mcp: { command: 'squad', args: ['state-mcp'] }, teamDir: teamSquad }, '<!-- gen -->', 'gen');
    expect(files.map((f) => f.path)).toEqual(['.claude/agents/dallas.md']);
    // Without teamDir the (empty) project directory is used, as before.
    expect(projectClaudeMembers({ root: app, mcp: { command: 'squad', args: ['state-mcp'] } }, '<!-- gen -->', 'gen')).toEqual([]);
  });

  it('every coordinator digest reads a linked team through squad_state; `teamRoot: "."` is not linked', () => {
    for (const host of ['copilot', 'claude', 'kiro', 'opencode', 'cursor', 'codex', 'antigravity'] as const) {
      expect(buildCoordinatorInstructions(host, '.squad', app)).toMatch(/\*\*Linked team:\*\*.*sets `teamRoot` to a path other than `\.` \(`\.` means no linked team\).*squad_state_read/);
    }
  });

  it("never widens a linked member's authored tool list, and keeps the project's effort overrides", () => {
    const teamSquad = path.join(team, '.squad');
    fs.mkdirSync(path.join(teamSquad, 'agents', 'dallas'), { recursive: true });
    fs.writeFileSync(
      path.join(teamSquad, 'agents', 'dallas', 'charter.md'),
      '# Dallas — Backend Dev\n\n## Identity\n- **Role:** Backend Dev\n\n## X-squad-host-claude\n- **Tools:** Read, Grep, Glob\n',
    );
    fs.writeFileSync(path.join(teamSquad, 'config.json'), JSON.stringify({ defaultReasoningEffort: 'high' }));
    fs.mkdirSync(path.join(app, '.squad'), { recursive: true });
    fs.writeFileSync(path.join(app, '.squad', 'config.json'), JSON.stringify({ teamRoot: '../team', agentReasoningEffortOverrides: { dallas: 'low' } }));
    const [file] = projectClaudeMembers({ root: app, mcp: { command: 'squad', args: ['state-mcp'] }, teamDir: teamSquad }, '<!-- gen -->', 'gen');
    const text = (file as { content: string }).content;
    expect(text).toMatch(/^tools: Read, Grep, Glob$/m);
    expect(text).toMatch(/^effort: low$/m);
    expect(text).toMatch(/## Your charter \(linked team repository\)/);
    expect(text).toMatch(/History not readable/);
    expect(text).not.toMatch(/Read your history with/);
  });
});
