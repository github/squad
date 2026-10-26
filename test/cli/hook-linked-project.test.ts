/**
 * `squad hook claude PreToolUse` in a linked project on a git state backend (#2320).
 *
 * The team repo holds the state branch, but the edits happen in the project repo, so the
 * hook must keep checking reviewer lockouts against project paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { clearResolveSquadCache } from '@bradygaster/squad-sdk';
import { emptyLockoutStore, rejectRevision, writeLockouts } from '../../packages/squad-sdk/src/client/adapters/lockout.js';
import { runHookCommand } from '../../packages/squad-cli/src/cli/commands/hook.js';

let root: string;

const git = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test', ...args], {
    cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

function initRepo(dir: string): void {
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(dir, ['init']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'init']);
}

/** Run the hook command with `input` on stdin and return what it printed. */
async function runHook(event: string, input: Record<string, unknown>): Promise<string> {
  const stdin = Readable.from([Buffer.from(JSON.stringify(input))]);
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
  const printed: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    printed.push(String(chunk));
    return true;
  });
  await runHookCommand(['claude', event]);
  return printed.join('');
}

beforeEach(() => {
  // Outside this checkout: anywhere under it, `git rev-parse` would find the Squad repo itself.
  root = mkdtempSync(join(tmpdir(), 'squad-hook-linked-'));
  clearResolveSquadCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearResolveSquadCache();
  rmSync(root, { recursive: true, force: true });
});

describe('squad hook claude in a linked project on a git state backend (#2320)', () => {
  it.each(['orphan', 'two-layer'])('PreToolUse still warns a locked-out member editing the project on %s', async (stateBackend) => {
    const team = join(root, 'team');
    const teamSquad = join(team, '.squad');
    mkdirSync(teamSquad, { recursive: true });
    writeFileSync(join(teamSquad, 'team.md'), '# Team\n');
    writeFileSync(join(teamSquad, 'config.json'), '{ "claudeHooks": "advisory" }\n');
    writeLockouts(teamSquad, rejectRevision(emptyLockoutStore(), {
      subject: 'issue-42', author: 'dallas', reviewer: 'ripley', reason: 'missing tests',
      paths: ['src/auth/**'], roster: ['dallas', 'lambert', 'ripley'], at: '2026-11-10T12:00:00.000Z',
    }));
    initRepo(team);

    const project = join(root, 'project');
    mkdirSync(join(project, '.squad'), { recursive: true });
    writeFileSync(join(project, '.squad', 'config.json'), JSON.stringify({ version: 1, teamRoot: '../team', stateBackend }));
    initRepo(project);
    vi.stubEnv('CLAUDE_PROJECT_DIR', project);

    const printed = await runHook('PreToolUse', {
      hook_event_name: 'PreToolUse',
      agent_type: 'dallas',
      tool_name: 'Edit',
      tool_input: { file_path: join(project, 'src', 'auth', 'login.ts') },
      cwd: project,
    });

    expect(printed).toMatch(/dallas is locked out of issue-42/);
    expect(printed).toContain('src/auth/login.ts');
  });
});
