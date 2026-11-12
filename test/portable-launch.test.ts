/**
 * Committed launch commands work on every clone (#2462): `squad init` and `squad upgrade` write
 * a repository launcher instead of `node <abs>/cli-entry.js`, Claude hooks reach it through
 * `$CLAUDE_PROJECT_DIR`, and `squad doctor` flags machine-specific commands.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  claudeHookLaunch,
  isSquadHookHandler,
  mergeClaudeHooks,
  stripClaudeHooks,
  squadRepoLauncher,
  SQUAD_REPO_LAUNCHER_MARKER,
} from '@bradygaster/squad-sdk/client';
import {
  committedSquadStateMcpSpec,
  resolveCommittedSquadStateMcpSpec,
  squadDirInRoot,
  writeSquadRepoLauncher,
  type SquadStateMcpSpec,
} from '../packages/squad-cli/src/cli/core/mcp-spec.js';
import { checkPortableSquadLaunch } from '../packages/squad-cli/src/cli/commands/doctor.js';

const fallback = { command: 'npx' as const, args: ['-y', '@bradygaster/squad-cli@9.9.9', 'state-mcp'] };
const localEntry: SquadStateMcpSpec = {
  command: '/opt/node/bin/node',
  args: ['/home/someone/squad/dist/cli-entry.js', 'state-mcp'],
  source: 'local-entry',
  fallback,
};
const repoLauncher = { command: 'node', args: ['.squad/bin/squad.mjs', 'state-mcp'] };

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-portable-launch-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, body: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

describe('committed spec (#2462)', () => {
  it('turns an installed CLI into the repository launcher and a bundle into squad from PATH', () => {
    expect(committedSquadStateMcpSpec(localEntry, '.squad')).toEqual({ ...repoLauncher, source: 'repo-launcher', fallback });
    expect(committedSquadStateMcpSpec({ ...localEntry, command: '/b/squad', args: ['state-mcp'], source: 'standalone' }, '.squad'))
      .toEqual({ command: 'squad', args: ['state-mcp'], source: 'path', fallback });
    const pinned: SquadStateMcpSpec = { ...fallback, args: [...fallback.args], source: 'pinned' };
    expect(committedSquadStateMcpSpec(pinned, '.squad')).toBe(pinned);
    // No squad directory inside the repository: no portable form.
    expect(committedSquadStateMcpSpec(localEntry, null)).toBe(localEntry);
  });

  it('finds the squad directory only inside the repository', () => {
    expect(squadDirInRoot(root, path.join(root, '.squad'))).toBe('.squad');
    expect(squadDirInRoot(root, path.join(root, 'team', '.squad'))).toBe('team/.squad');
    expect(squadDirInRoot(root, path.dirname(root))).toBeNull();
    expect(squadDirInRoot(root, root)).toBeNull();
  });

  it('writes the launcher, refreshes its own and leaves a user file alone', () => {
    expect(writeSquadRepoLauncher(root, '.squad', '9.9.9')).toBe('created');
    const file = path.join(root, '.squad', 'bin', 'squad.mjs');
    expect(fs.readFileSync(file, 'utf8')).toContain(SQUAD_REPO_LAUNCHER_MARKER);
    expect(writeSquadRepoLauncher(root, '.squad', '9.9.9')).toBe('unchanged');
    expect(writeSquadRepoLauncher(root, '.squad', '9.9.10')).toBe('updated');
    fs.writeFileSync(file, '// mine\n');
    expect(writeSquadRepoLauncher(root, '.squad', '9.9.10')).toBe('skipped');
    expect(fs.readFileSync(file, 'utf8')).toBe('// mine\n');
  });

  it('keeps the machine-specific spec when the launcher path is user-owned', async () => {
    write('.squad/bin/squad.mjs', '// mine\n');
    const spec = await resolveCommittedSquadStateMcpSpec('9.9.9', root, path.join(root, '.squad'), {
      standaloneCheck: () => null,
      localEntryCheck: () => '/home/someone/squad/dist/cli-entry.js',
    });
    expect(spec.source).toBe('local-entry');
  });

  it('read-only callers get the launcher spec without a file being written', async () => {
    const spec = await resolveCommittedSquadStateMcpSpec('9.9.9', root, path.join(root, '.squad'), {
      standaloneCheck: () => null,
      localEntryCheck: () => '/x/cli-entry.js',
      write: false,
    });
    expect(spec.source).toBe('repo-launcher');
    expect(fs.existsSync(path.join(root, '.squad'))).toBe(false);
  });
});

describe('Claude hooks through the repository launcher (#2462)', () => {
  it('runs the launcher from $CLAUDE_PROJECT_DIR as a shell command', () => {
    expect(claudeHookLaunch(repoLauncher, 'Stop')).toEqual({
      command: 'node "$CLAUDE_PROJECT_DIR/.squad/bin/squad.mjs" hook claude Stop',
      args: [],
    });
    // Anything else keeps the argv form.
    expect(claudeHookLaunch({ command: 'node', args: ['/abs/.squad/bin/squad.mjs', 'state-mcp'] }, 'Stop')!.args)
      .toEqual(['/abs/.squad/bin/squad.mjs', 'hook', 'claude', 'Stop']);
    expect(claudeHookLaunch({ command: 'node', args: ['../x/bin/squad.mjs', 'state-mcp'] }, 'Stop')!.args.length).toBe(4);
  });

  it('replaces old machine-specific handlers, keeps user hooks, and strips cleanly', () => {
    const user = { type: 'command', command: 'echo user' };
    const old = {
      type: 'command',
      command: '/opt/node/bin/node',
      args: ['/home/someone/squad/dist/cli-entry.js', 'hook', 'claude', 'Stop'],
      timeout: 15,
    };
    const merged = mergeClaudeHooks({ hooks: { Stop: [{ hooks: [user] }, { hooks: [old] }] } }, repoLauncher);
    const text = JSON.stringify(merged);
    expect(text).not.toContain('/home/someone');
    expect(text).toContain('echo user');
    const handlers = (merged['hooks'] as Record<string, { hooks: Record<string, unknown>[] }[]>)['Stop']!.flatMap(g => g.hooks);
    const squad = handlers.filter(isSquadHookHandler);
    expect(squad).toEqual([{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.squad/bin/squad.mjs" hook claude Stop', timeout: 15 }]);
    expect(stripClaudeHooks(merged)).toEqual({ hooks: { Stop: [{ hooks: [user] }] } });
  });

  it('does not take a look-alike user command for Squad\'s', () => {
    expect(isSquadHookHandler({ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.squad/bin/squad.mjs" hook claude Stop; rm -rf x' })).toBe(false);
    expect(isSquadHookHandler({ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.squad/bin/squad.mjs" hook claude Nope' })).toBe(false);
    expect(isSquadHookHandler({ type: 'command', command: 'squad hook claude Stop' })).toBe(false);
  });
});

describe('the repository launcher script (#2462)', () => {
  /** A fake CLI that prints its argv, at `<dir>/node_modules/@bradygaster/squad-cli`. */
  function fakeCli(dir: string, version: string): void {
    const pkg = path.join(dir, 'node_modules', '@bradygaster', 'squad-cli');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@bradygaster/squad-cli', version }));
    fs.writeFileSync(path.join(pkg, 'dist', 'cli-entry.js'), `console.log('fake ${version}', JSON.stringify(process.argv.slice(2)));\n`);
  }

  function run(args: string[], env: Record<string, string> = {}, cwd = os.tmpdir()) {
    return spawnSync(process.execPath, [path.join(root, '.squad', 'bin', 'squad.mjs'), ...args], {
      cwd,
      encoding: 'utf8',
      // PATH without a real squad, so the result depends only on the repository.
      env: { PATH: path.dirname(process.execPath), ...env },
    });
  }

  beforeEach(() => {
    write('.squad/bin/squad.mjs', squadRepoLauncher('2.0.0', '.squad'));
  });

  it('runs the repository\'s own install from any working directory', () => {
    fakeCli(root, '2.0.1');
    const out = run(['state-mcp']);
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('fake 2.0.1 ["state-mcp"]');
  });

  it('skips a CLI older than the version that wrote it, and says how to install', () => {
    fakeCli(root, '1.9.0');
    const out = run(['state-mcp']);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('no Squad CLI 2.0.0 or newer found');
    expect(out.stderr).toContain('npm install -g @bradygaster/squad-cli@2.0.0');
  });

  it('falls back to the CLI recorded on this machine, and skips an older one', async () => {
    const { recordSquadCli } = await import('../packages/squad-cli/src/cli/core/mcp-spec.js');
    const other = path.join(root, 'other-machine-dir');
    fakeCli(other, '2.0.2');
    const home = path.join(root, 'squad-home');
    const entry = path.join(other, 'node_modules', '@bradygaster', 'squad-cli', 'dist', 'cli-entry.js');
    recordSquadCli(entry, '2.0.2', { SQUAD_HOME: home });
    expect(JSON.parse(fs.readFileSync(path.join(home, 'cli.json'), 'utf8'))).toEqual({ entry, version: '2.0.2' });
    expect(run(['state-mcp'], { SQUAD_HOME: home }).stdout.trim()).toBe('fake 2.0.2 ["state-mcp"]');
    fs.rmSync(other, { recursive: true });
    fakeCli(other, '1.0.0');
    expect(run(['state-mcp'], { SQUAD_HOME: home }).status).toBe(1);
  });

  it('honours SQUAD_CLI', () => {
    const entry = write('elsewhere/cli.js', "console.log('override', process.argv.slice(2).join(' '));\n");
    expect(run(['--version'], { SQUAD_CLI: entry }).stdout.trim()).toBe('override --version');
  });

  it('is a no-op for hooks unless the team opted in', () => {
    write('.squad/config.json', JSON.stringify({ version: 1 }));
    const off = run(['hook', 'claude', 'Stop']);
    expect(off.status).toBe(0);
    expect(off.stdout).toBe('');
    write('.squad/config.json', JSON.stringify({ version: 1, claudeHooks: 'advisory' }));
    fakeCli(root, '2.0.0');
    expect(run(['hook', 'claude', 'Stop']).stdout.trim()).toBe('fake 2.0.0 ["hook","claude","Stop"]');
  });
});

describe('squad doctor: portable launch commands (#2462)', () => {
  const mcp = (command: string, args: string[]) => JSON.stringify({ mcpServers: { squad_state: { command, args } } });

  it('is silent when nothing is committed', () => {
    expect(checkPortableSquadLaunch(root)).toBeUndefined();
  });

  it('fails on a path from another machine and warns on this machine\'s own path', () => {
    write('.mcp.json', mcp('/nowhere/bin/node', ['/nowhere/cli-entry.js', 'state-mcp']));
    expect(checkPortableSquadLaunch(root)).toMatchObject({ status: 'fail' });
    const entry = write('install/dist/cli-entry.js', '');
    write('.mcp.json', mcp(process.execPath, [entry, 'state-mcp']));
    expect(checkPortableSquadLaunch(root)).toMatchObject({ status: 'warn' });
  });

  it('checks Claude hooks too, and that the launcher exists', () => {
    write('.mcp.json', mcp('node', ['.squad/bin/squad.mjs', 'state-mcp']));
    write('.claude/settings.json', JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.squad/bin/squad.mjs" hook claude Stop' }] }] },
    }));
    expect(checkPortableSquadLaunch(root)).toMatchObject({ status: 'fail', message: expect.stringContaining('missing') });
    write('.squad/bin/squad.mjs', squadRepoLauncher('2.0.0', '.squad'));
    expect(checkPortableSquadLaunch(root)).toMatchObject({ status: 'pass', message: '2 committed launch command(s) are portable' });
    write('.claude/settings.json', JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/nowhere/node', args: ['/nowhere/cli-entry.js', 'hook', 'claude', 'Stop'] }] }] },
    }));
    expect(checkPortableSquadLaunch(root)).toMatchObject({ status: 'fail', message: expect.stringContaining('.claude/settings.json') });
  });
});
