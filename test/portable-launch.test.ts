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
  squadRepoLauncherArgs,
  SQUAD_REPO_LAUNCHER_MARKER,
} from '@bradygaster/squad-sdk/client';
import {
  committedSquadStateMcpSpec,
  isTransientCliEntry,
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
const repoLauncher = { command: 'node', args: squadRepoLauncherArgs('.squad', 'state-mcp') };

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
    const file = path.join(root, '.squad', 'squad.mjs');
    expect(fs.readFileSync(file, 'utf8')).toContain(SQUAD_REPO_LAUNCHER_MARKER);
    // Outside any bin/ directory, which repositories often ignore (Copilot review).
    expect(path.relative(root, file).split(path.sep)).not.toContain('bin');
    expect(writeSquadRepoLauncher(root, '.squad', '9.9.9')).toBe('unchanged');
    expect(writeSquadRepoLauncher(root, '.squad', '9.9.10')).toBe('updated');
    fs.writeFileSync(file, '// mine\n');
    expect(writeSquadRepoLauncher(root, '.squad', '9.9.10')).toBe('skipped');
    expect(fs.readFileSync(file, 'utf8')).toBe('// mine\n');
  });

  it('never writes through a symlink that leaves the workspace (Copilot review)', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-outside-'));
    try {
      // The squad directory itself links outside the workspace.
      fs.symlinkSync(outside, path.join(root, '.squad'), 'dir');
      expect(writeSquadRepoLauncher(root, '.squad', '9.9.9')).toBe('skipped');
      expect(fs.readdirSync(outside)).toEqual([]);
      fs.rmSync(path.join(root, '.squad'));
      // A dangling link at the launcher path, pointing outside.
      fs.mkdirSync(path.join(root, '.squad'));
      fs.symlinkSync(path.join(outside, 'planted.mjs'), path.join(root, '.squad', 'squad.mjs'));
      expect(writeSquadRepoLauncher(root, '.squad', '9.9.9')).toBe('skipped');
      expect(fs.existsSync(path.join(outside, 'planted.mjs'))).toBe(false);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('keeps exact-version npx for a CLI running from a package runner cache (Copilot review)', () => {
    for (const entry of [
      '/home/u/.npm/_npx/0a1b2c/node_modules/@bradygaster/squad-cli/dist/cli-entry.js',
      'C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\0a1b\\node_modules\\@bradygaster\\squad-cli\\dist\\cli-entry.js',
      '/home/u/.cache/pnpm/dlx/abc/node_modules/@bradygaster/squad-cli/dist/cli-entry.js',
      '/tmp/xfs-1a2b3c/dlx-5555/node_modules/@bradygaster/squad-cli/dist/cli-entry.js',
    ]) {
      expect(isTransientCliEntry(entry), entry).toBe(true);
      expect(committedSquadStateMcpSpec({ ...localEntry, args: [entry, 'state-mcp'] }, '.squad'))
        .toEqual({ command: 'npx', args: fallback.args, source: 'pinned' });
    }
    expect(isTransientCliEntry('/usr/local/lib/node_modules/@bradygaster/squad-cli/dist/cli-entry.js')).toBe(false);
    expect(isTransientCliEntry('/home/u/src/dlxtools/squad/dist/cli-entry.js')).toBe(false);
  });

  it('keeps the machine-specific spec when the launcher path is user-owned', async () => {
    write('.squad/squad.mjs', '// mine\n');
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
      command: 'node "$CLAUDE_PROJECT_DIR/.squad/squad.mjs" hook claude Stop',
      args: [],
    });
    // The plain script form, written before the bootstrap, maps to the same hook.
    expect(claudeHookLaunch({ command: 'node', args: ['.squad/squad.mjs', 'state-mcp'] }, 'Stop'))
      .toEqual(claudeHookLaunch(repoLauncher, 'Stop'));
    // Anything else keeps the argv form.
    expect(claudeHookLaunch({ command: 'node', args: ['/abs/.squad/squad.mjs', 'state-mcp'] }, 'Stop')!.args)
      .toEqual(['/abs/.squad/squad.mjs', 'hook', 'claude', 'Stop']);
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
    expect(squad).toEqual([{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.squad/squad.mjs" hook claude Stop', timeout: 15 }]);
    expect(stripClaudeHooks(merged)).toEqual({ hooks: { Stop: [{ hooks: [user] }] } });
  });

  it('does not take a look-alike user command for Squad\'s', () => {
    expect(isSquadHookHandler({ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.squad/squad.mjs" hook claude Stop; rm -rf x' })).toBe(false);
    expect(isSquadHookHandler({ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.squad/squad.mjs" hook claude Nope' })).toBe(false);
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
    return spawnSync(process.execPath, [path.join(root, '.squad', 'squad.mjs'), ...args], {
      cwd,
      encoding: 'utf8',
      // PATH without a real squad, so the result depends only on the repository.
      env: { PATH: path.dirname(process.execPath), ...env },
    });
  }

  beforeEach(() => {
    write('.squad/squad.mjs', squadRepoLauncher('2.0.0', '.squad'));
  });

  it('starts from a subfolder of the repository, as Claude Code does in a monorepo package', () => {
    // Claude Code finds the root .mcp.json from packages/api and starts the server there.
    fakeCli(root, '2.0.1');
    fs.mkdirSync(path.join(root, '.git'));
    const api = path.join(root, 'packages', 'api');
    fs.mkdirSync(api, { recursive: true });
    const spec = committedSquadStateMcpSpec(localEntry, '.squad');
    for (const cwd of [root, api]) {
      const out = spawnSync(spec.command, [...spec.args.slice(0, -1), 'state-mcp', 'a b', '"q"'], {
        cwd, encoding: 'utf8', env: { PATH: path.dirname(process.execPath) },
      });
      expect(out.stderr, cwd).toBe('');
      expect(out.stdout.trim()).toBe('fake 2.0.1 ["state-mcp","a b","\\"q\\""]');
    }
    // It stops at the repository root: a nested repository never runs the launcher above it.
    const nested = path.join(root, 'packages', 'inner');
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
    const out = spawnSync(spec.command, spec.args, { cwd: nested, encoding: 'utf8', env: { PATH: path.dirname(process.execPath) } });
    expect(out.status).toBe(1);
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('was not found');
  });

  it('runs only the launcher at the repository root, never one in a subfolder or above the root (Copilot review)', () => {
    fakeCli(root, '2.0.1');
    fs.mkdirSync(path.join(root, '.git'));
    const env = { PATH: path.dirname(process.execPath) };
    const spec = committedSquadStateMcpSpec(localEntry, '.squad');
    // A package's own .squad/squad.mjs does not shadow the root launcher the root .mcp.json names.
    const api = path.join(root, 'packages', 'api');
    fs.mkdirSync(path.join(api, '.squad'), { recursive: true });
    fs.writeFileSync(path.join(api, '.squad', 'squad.mjs'), "console.log('PLANTED')\n");
    const fromApi = spawnSync(spec.command, spec.args, { cwd: api, encoding: 'utf8', env });
    expect(fromApi.stdout).not.toContain('PLANTED');
    expect(fromApi.stdout.trim()).toBe('fake 2.0.1 ["state-mcp"]');
    // With no .git anywhere, nothing is searched: a launcher above the working directory is never run.
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-no-git-'));
    try {
      fs.mkdirSync(path.join(loose, '.squad'));
      fs.writeFileSync(path.join(loose, '.squad', 'squad.mjs'), "console.log('PLANTED')\n");
      const sub = path.join(loose, 'sub');
      fs.mkdirSync(sub);
      const out = spawnSync(spec.command, spec.args, { cwd: sub, encoding: 'utf8', env });
      expect(out.status).toBe(1);
      expect(out.stdout).not.toContain('PLANTED');
      expect(out.stderr).toContain('was not found');
    } finally {
      fs.rmSync(loose, { recursive: true, force: true });
    }
    // A script path that leaves the root is refused.
    const escape = spawnSync(spec.command, [spec.args[0]!, spec.args[1]!, '../outside/squad.mjs', 'state-mcp'], { cwd: root, encoding: 'utf8', env });
    expect(escape.status).toBe(1);
    expect(escape.stderr).toContain('was not found');
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

  it('recognises Windows paths on any OS, and finds a bare node on PATH (Copilot review)', () => {
    write('.mcp.json', mcp('C:\\Program Files\\nodejs\\node.exe', ['C:\\Users\\u\\squad\\dist\\cli-entry.js', 'state-mcp']));
    expect(checkPortableSquadLaunch(root)).toMatchObject({ status: process.platform === 'win32' ? expect.any(String) : 'fail' });
    const entry = write('install/dist/cli-entry.js', '');
    write('.mcp.json', mcp('node', [entry, 'state-mcp']));
    expect(checkPortableSquadLaunch(root)).toMatchObject({ status: 'warn' });
  });

  it('checks Claude hooks too, and that the launcher exists', () => {
    write('.mcp.json', mcp('node', squadRepoLauncherArgs('.squad', 'state-mcp')));
    write('.claude/settings.json', JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.squad/squad.mjs" hook claude Stop' }] }] },
    }));
    expect(checkPortableSquadLaunch(root)).toMatchObject({ status: 'fail', message: expect.stringContaining('missing') });
    write('.squad/squad.mjs', squadRepoLauncher('2.0.0', '.squad'));
    expect(checkPortableSquadLaunch(root)).toMatchObject({ status: 'pass', message: '2 committed launch command(s) are portable' });
    write('.claude/settings.json', JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/nowhere/node', args: ['/nowhere/cli-entry.js', 'hook', 'claude', 'Stop'] }] }] },
    }));
    expect(checkPortableSquadLaunch(root)).toMatchObject({ status: 'fail', message: expect.stringContaining('.claude/settings.json') });
  });
});
