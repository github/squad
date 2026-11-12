/**
 * Claude Code governance hooks and the durable reviewer-lockout record (#2442 Phase 3).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  installClients,
  uninstallClients,
} from '../packages/squad-sdk/src/client/adapters/index.js';
import {
  CLAUDE_SETTINGS_PATH,
  isSquadHookHandler,
  mergeClaudeHooks,
  runClaudeHook,
  stripClaudeHooks,
  type ClaudeHookEnv,
} from '../packages/squad-sdk/src/client/adapters/claude-hooks.js';
import {
  LockoutError,
  approveRevision,
  assignRevision,
  effectiveLocked,
  eligibleSuccessors,
  emptyLockoutStore,
  overrideLockout,
  readLockouts,
  rejectRevision,
  submitRevision,
  subjectCovers,
  writeLockouts,
  type LockoutStore,
} from '../packages/squad-sdk/src/client/adapters/lockout.js';

const MCP = { command: 'squad', args: ['state-mcp'] };
const ROSTER = ['dallas', 'lambert', 'ripley'];
const AT = '2026-11-09T12:00:00.000Z';

const reject = (store: LockoutStore, author = 'dallas', reviewer = 'ripley', roster: readonly string[] = ROSTER) =>
  rejectRevision(store, { subject: 'issue-42', author, reviewer, reason: 'missing tests for the auth path', paths: ['src/auth/**'], roster, at: AT });
const subject = (s: LockoutStore) => s.subjects.find((r) => r.subject === 'issue-42')!;

describe('reviewer lockout record (governance-review §6)', () => {
  it('a REJECT locks the author out, scoped to the subject paths', () => {
    const s = reject(emptyLockoutStore());
    expect(subject(s)).toMatchObject({ state: 'author-locked', lockedAuthors: ['dallas'], reviewer: 'ripley' });
    expect(eligibleSuccessors(subject(s), ROSTER)).toEqual(['lambert']);
    expect(subjectCovers(subject(s), 'src/auth/login.ts')).toBe(true);
    expect(subjectCovers(subject(s), 'src/billing/pay.ts')).toBe(false);
  });

  it('rejects self-review, a locked-out successor, and the reviewer as successor', () => {
    expect(() => reject(emptyLockoutStore(), 'ripley', 'ripley')).toThrow(LockoutError);
    const s = reject(emptyLockoutStore());
    expect(() => assignRevision(s, { subject: 'issue-42', successor: 'dallas' })).toThrow(/locked out/);
    expect(() => assignRevision(s, { subject: 'issue-42', successor: 'ripley' })).toThrow(/blocking reviewer/);
  });

  it('runs reject → assign → submit → approve, and approval clears the lockout', () => {
    let s = reject(emptyLockoutStore());
    s = assignRevision(s, { subject: 'issue-42', successor: 'lambert', roster: ROSTER });
    expect(() => submitRevision(s, { subject: 'issue-42', author: 'dallas' })).toThrow(/not the assigned successor/);
    s = submitRevision(s, { subject: 'issue-42', author: 'lambert' });
    expect(() => approveRevision(s, { subject: 'issue-42', reviewer: 'lambert' })).toThrow(/Self-approval/);
    s = approveRevision(s, { subject: 'issue-42', reviewer: 'ripley' });
    expect(subject(s).state).toBe('cleared');
    expect(effectiveLocked(subject(s))).toEqual([]);
  });

  it('records a deadlock when no eligible successor remains, instead of readmitting an author', () => {
    let s = reject(emptyLockoutStore(), 'dallas', 'ripley', ['dallas', 'lambert', 'ripley']);
    s = rejectRevision(s, { subject: 'issue-42', author: 'lambert', reviewer: 'ripley', reason: 'still no tests', roster: ['dallas', 'lambert', 'ripley'], at: AT });
    expect(subject(s)).toMatchObject({ state: 'deadlocked', lockedAuthors: ['dallas', 'lambert'] });
    expect(() => assignRevision(s, { subject: 'issue-42', successor: 'dallas' })).toThrow(/deadlocked/);
  });

  it('an override needs an authority and a reason; it readmits the author and resolves a deadlock', () => {
    let s = reject(emptyLockoutStore(), 'dallas', 'ripley', ['dallas', 'ripley']);
    expect(subject(s).state).toBe('deadlocked');
    const base = { subject: 'issue-42', author: 'dallas', reason: 'only backend dev; pairing with Ripley', authorities: ['user', 'ripley'], roster: ['dallas', 'ripley'] };
    expect(() => overrideLockout(s, { ...base, by: 'lambert' })).toThrow(/not an authority/);
    expect(() => overrideLockout(s, { ...base, by: 'dallas', authorities: ['user', 'dallas'] })).toThrow(/own lockout/);
    expect(() => overrideLockout(s, { ...base, by: 'user', reason: ' ' })).toThrow(/reason/);
    s = overrideLockout(s, { ...base, by: 'user', at: AT });
    expect(subject(s)).toMatchObject({ state: 'author-locked', overrides: [{ author: 'dallas', by: 'user', at: AT }] });
    expect(effectiveLocked(subject(s))).toEqual([]);
    expect(() => assignRevision(s, { subject: 'issue-42', successor: 'dallas' })).not.toThrow();
  });

  it('persists to <squadDir>/governance/lockouts.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-lockout-'));
    try {
      writeLockouts(dir, reject(emptyLockoutStore()));
      expect(readLockouts(dir)).toEqual(reject(emptyLockoutStore()));
      expect(fs.existsSync(path.join(dir, 'governance/lockouts.json'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Claude hooks in .claude/settings.json', () => {
  let root: string;
  const settingsAbs = () => path.join(root, CLAUDE_SETTINGS_PATH);
  const config = (cfg: Record<string, unknown>) => fs.writeFileSync(path.join(root, '.squad/config.json'), `${JSON.stringify(cfg, null, 2)}\n`);

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-claude-hooks-'));
    fs.mkdirSync(path.join(root, '.squad'), { recursive: true });
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('is off by default: no settings file is written', () => {
    installClients(['claude'], { root, mcp: MCP });
    expect(fs.existsSync(settingsAbs())).toBe(false);
  });

  it('opted in, adds one Squad handler per event that runs the MCP launcher with `hook claude <Event>`', () => {
    config({ claudeHooks: 'advisory' });
    installClients(['claude'], { root, mcp: { command: 'npx', args: ['-y', '@bradygaster/squad-cli@1.2.3', 'state-mcp'] } });
    const hooks = JSON.parse(fs.readFileSync(settingsAbs(), 'utf8')).hooks;
    expect(Object.keys(hooks)).toEqual(['SessionStart', 'SubagentStart', 'PreToolUse', 'PostToolUse', 'Stop']);
    expect(hooks.PreToolUse).toEqual([
      {
        matcher: 'Edit|MultiEdit|Write|NotebookEdit',
        hooks: [{ type: 'command', command: 'npx', args: ['-y', '@bradygaster/squad-cli@1.2.3', 'hook', 'claude', 'PreToolUse'], timeout: 15 }],
      },
    ]);
    expect(JSON.stringify(hooks)).not.toContain('permissionDecision');
    expect(installClients(['claude'], { root, mcp: MCP }).find((r) => r.path === CLAUDE_SETTINGS_PATH)?.action).toBe('updated');
    expect(installClients(['claude'], { root, mcp: MCP }).find((r) => r.path === CLAUDE_SETTINGS_PATH)?.action).toBe('unchanged');
  });

  it('keeps user hooks and settings, and rollback restores the user bytes exactly', () => {
    const user = `${JSON.stringify(
      {
        permissions: { allow: ['Bash(npm test)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './.claude/hooks/no-rm.sh' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
        },
      },
      null,
      2,
    )}\n`;
    fs.mkdirSync(path.dirname(settingsAbs()), { recursive: true });
    fs.writeFileSync(settingsAbs(), user);
    config({ claudeHooks: 'advisory' });
    installClients(['claude'], { root, mcp: MCP });
    const merged = JSON.parse(fs.readFileSync(settingsAbs(), 'utf8'));
    expect(merged.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(merged.hooks.PreToolUse[0]).toEqual({ matcher: 'Bash', hooks: [{ type: 'command', command: './.claude/hooks/no-rm.sh' }] });
    expect(merged.hooks.PreToolUse).toHaveLength(2);
    expect(merged.hooks.Stop).toHaveLength(2);
    uninstallClients(['claude'], { root, mcp: MCP });
    expect(fs.readFileSync(settingsAbs(), 'utf8')).toBe(user);
  });

  it('turning hooks off removes only Squad handlers on the next upgrade', () => {
    const user = '{\n  "model": "opus"\n}\n';
    fs.mkdirSync(path.dirname(settingsAbs()), { recursive: true });
    fs.writeFileSync(settingsAbs(), user);
    config({ claudeHooks: 'advisory' });
    installClients(['claude'], { root, mcp: MCP });
    config({ claudeHooks: 'off' });
    installClients(['claude'], { root, mcp: MCP });
    expect(fs.readFileSync(settingsAbs(), 'utf8')).toBe(user);
  });

  it('rollback deletes a settings file that held only Squad hooks, and prunes .claude', () => {
    config({ claudeHooks: 'advisory' });
    installClients(['claude'], { root, mcp: MCP });
    expect(fs.existsSync(settingsAbs())).toBe(true);
    uninstallClients(['claude'], { root, mcp: MCP });
    expect(fs.existsSync(path.join(root, '.claude'))).toBe(false);
  });

  it('never matches a user handler, even one that also runs a `hook` subcommand', () => {
    const userHandler = { type: 'command', command: 'tool', args: ['hook', 'pre-tool-use'] };
    expect(isSquadHookHandler(userHandler)).toBe(false);
    const settings = { hooks: { PreToolUse: [{ hooks: [userHandler] }] } };
    expect(stripClaudeHooks(settings)).toBe(settings);
    expect(stripClaudeHooks(mergeClaudeHooks(settings, MCP))).toEqual(settings);
  });

  it('refuses to clobber a malformed hooks value', () => {
    expect(() => mergeClaudeHooks({ hooks: [] as unknown as Record<string, unknown> }, MCP)).toThrow(/Refusing/);
    expect(() => mergeClaudeHooks({ hooks: { Stop: 'x' } }, MCP)).toThrow(/Refusing/);
  });
});

describe('Claude hook runtime (advisory)', () => {
  let root: string;
  let env: ClaudeHookEnv;
  const squad = () => path.join(root, '.squad');

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-claude-hook-run-'));
    fs.mkdirSync(path.join(squad(), 'decisions/inbox'), { recursive: true });
    fs.writeFileSync(path.join(squad(), 'config.json'), '{ "claudeHooks": "advisory" }\n');
    fs.writeFileSync(path.join(squad(), 'team.md'), '# Team\n');
    fs.writeFileSync(path.join(squad(), 'routing.md'), '| Work Type | Route To | Examples |\n|---|---|---|\n| API | dallas | REST |\n');
    for (const [id, role] of [['dallas', 'Backend Dev'], ['lambert', 'Backend Dev'], ['ripley', 'Lead']]) {
      fs.mkdirSync(path.join(squad(), 'agents', id!), { recursive: true });
      fs.writeFileSync(path.join(squad(), 'agents', id!, 'charter.md'), `# ${id} — ${role}\n\n## Identity\n- **Role:** ${role}\n`);
    }
    writeLockouts(squad(), reject(emptyLockoutStore()));
    env = { root, teamAbs: squad(), projectAbs: squad(), version: '9.9.9' };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const edit = (agent: string | undefined, file: string) =>
    runClaudeHook('PreToolUse', { hook_event_name: 'PreToolUse', agent_type: agent, tool_name: 'Edit', tool_input: { file_path: path.join(root, file) }, cwd: root }, env);

  it('PreToolUse warns when a locked-out member edits a subject file, and never denies', () => {
    const out = edit('dallas', 'src/auth/login.ts')!;
    expect(out.systemMessage).toMatch(/dallas is locked out of issue-42/);
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: 'PreToolUse' });
    expect(JSON.stringify(out)).not.toMatch(/permissionDecision|"deny"/);
  });

  it('PreToolUse is silent for other paths, other members, the coordinator, and after approval', () => {
    expect(edit('dallas', 'src/billing/pay.ts')).toBeNull();
    expect(edit('lambert', 'src/auth/login.ts')).toBeNull();
    expect(edit('squad', 'src/auth/login.ts')).toBeNull();
    expect(edit(undefined, 'src/auth/login.ts')).toBeNull();
    let s = readLockouts(squad());
    s = approveRevision(submitRevision(assignRevision(s, { subject: 'issue-42', successor: 'lambert' }), { subject: 'issue-42', author: 'lambert' }), { subject: 'issue-42', reviewer: 'ripley' });
    writeLockouts(squad(), s);
    expect(edit('dallas', 'src/auth/login.ts')).toBeNull();
  });

  it('PreToolUse matches through a symlinked project path, including a file that does not exist yet', () => {
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'squad-claude-hook-link-')), 'repo');
    fs.symlinkSync(root, link);
    try {
      const real = fs.realpathSync(root);
      const input = { agent_type: 'dallas', tool_name: 'Write', tool_input: { file_path: path.join(link, 'src/auth/new/file.ts') }, cwd: link };
      expect(runClaudeHook('PreToolUse', input, { ...env, root: real })!.systemMessage).toContain('src/auth/new/file.ts');
      expect(runClaudeHook('PreToolUse', { ...input, tool_input: { file_path: path.join(os.tmpdir(), 'elsewhere.ts') } }, { ...env, root: real })).toBeNull();
    } finally {
      fs.rmSync(path.dirname(link), { recursive: true, force: true });
    }
  });

  it('PreToolUse is silent after an authority override', () => {
    writeLockouts(squad(), overrideLockout(readLockouts(squad()), { subject: 'issue-42', author: 'dallas', by: 'user', reason: 'hotfix', authorities: ['user'] }));
    expect(edit('dallas', 'src/auth/login.ts')).toBeNull();
  });

  it('does nothing when hooks are off, even if the handlers are still installed', () => {
    fs.writeFileSync(path.join(squad(), 'config.json'), '{}\n');
    expect(edit('dallas', 'src/auth/login.ts')).toBeNull();
    expect(runClaudeHook('SessionStart', { agent_type: 'squad' }, env)).toBeNull();
  });

  it('SessionStart for the coordinator injects health, roster, routing and active lockouts', () => {
    const ctx = runClaudeHook('SessionStart', { agent_type: 'squad', source: 'startup' }, env)!.hookSpecificOutput!.additionalContext;
    expect(ctx).toContain('squad-state 9.9.9');
    expect(ctx).toMatch(/Roster: dallas \(Backend Dev\).*ripley \(Lead\)/);
    expect(ctx).toContain('"API" → dallas');
    expect(ctx).toMatch(/issue-42 \(author-locked\) on src\/auth\/\*\*: dallas locked out after ripley's REJECT/);
    expect(runClaudeHook('SessionStart', { source: 'startup' }, env)).toBeNull();
    expect(runClaudeHook('SubagentStart', { agent_type: 'squad' }, env)!.hookSpecificOutput!.hookEventName).toBe('SubagentStart');
  });

  it('the plugin coordinator squad:squad gets the same context as the project squad agent', () => {
    const plugin = { ...env, source: 'plugin' as const };
    const ctx = runClaudeHook('SessionStart', { agent_type: 'squad:squad', source: 'startup' }, plugin)!.hookSpecificOutput!.additionalContext;
    expect(ctx).toContain('Roster:');
    expect(runClaudeHook('SubagentStart', { agent_type: 'squad:squad' }, plugin)!.hookSpecificOutput!.hookEventName).toBe('SubagentStart');
    expect(edit('dallas', 'src/auth/login.ts')).not.toBeNull();
  });

  it('plugin hooks defer when the project settings already run the Squad handlers', () => {
    const settings = path.join(env.root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'squad', args: ['hook', 'claude', 'SessionStart'] }] }] } }));
    try {
      expect(runClaudeHook('SessionStart', { agent_type: 'squad:squad' }, { ...env, source: 'plugin' })).toBeNull();
      expect(runClaudeHook('SessionStart', { agent_type: 'squad' }, { ...env, source: 'project' })).not.toBeNull();
    } finally {
      fs.rmSync(settings);
    }
  });

  it('SessionStart reports a missing team instead of injecting context', () => {
    fs.rmSync(path.join(squad(), 'team.md'));
    expect(runClaudeHook('SessionStart', { agent_type: 'squad' }, env)).toEqual({ systemMessage: expect.stringMatching(/no team found/) });
  });

  it('PostToolUse on a member spawn adds a coordination-handoff result envelope', () => {
    const out = runClaudeHook('PostToolUse', { agent_type: 'squad', tool_name: 'Agent', tool_use_id: 'toolu_1', tool_input: { subagent_type: 'lambert', description: 'Fix auth tests' } }, env)!;
    const ctx = out.hookSpecificOutput!.additionalContext;
    expect(ctx).toContain('"profile":"squad-coordination-handoff/v0.1"');
    expect(ctx).toContain('"type":"result"');
    expect(ctx).toContain('"sender":"lambert"');
    // The tool call's free-text description is not reflected back into coordinator context.
    expect(ctx).not.toContain('Fix auth tests');
    expect(ctx).not.toContain('"task"');
    expect(runClaudeHook('PostToolUse', { tool_name: 'Agent', tool_input: { subagent_type: 'Explore' } }, env)).toBeNull();
  });

  it('Stop asks for Scribe once when the decisions inbox is non-empty, and reports an open Ralph circuit', () => {
    expect(runClaudeHook('Stop', { agent_type: 'squad', stop_hook_active: false }, env)).toBeNull();
    fs.writeFileSync(path.join(squad(), 'decisions/inbox/dallas-auth.md'), '# decision\n');
    const now = Date.parse(AT);
    fs.writeFileSync(
      path.join(squad(), 'ralph-circuit-breaker.json'),
      JSON.stringify({ state: 'open', preferredModel: 'claude-sonnet-5', fallbackChain: ['gpt-5.4-mini'], currentFallbackIndex: 0, cooldownMinutes: 10, openedAt: new Date(now - 60_000).toISOString() }),
    );
    const out = runClaudeHook('Stop', { agent_type: 'squad', stop_hook_active: false }, env, now)!;
    expect(out.hookSpecificOutput!.additionalContext).toMatch(/1 unmerged entry.*Spawn Scribe/);
    expect(out.systemMessage).toMatch(/circuit breaker is OPEN.*gpt-5\.4-mini/);
    expect(runClaudeHook('Stop', { agent_type: 'squad', stop_hook_active: true }, env, now)).toBeNull();
    // Cooldown over: the breaker no longer reports open.
    expect(runClaudeHook('Stop', { agent_type: 'squad', stop_hook_active: false }, env, now + 11 * 60_000)!.systemMessage).toBeUndefined();
  });
});

describe('squad lockout CLI', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-lockout-cli-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    for (const id of ['dallas', 'lambert', 'ripley']) {
      fs.mkdirSync(path.join(root, '.squad/agents', id), { recursive: true });
      fs.writeFileSync(path.join(root, '.squad/agents', id, 'charter.md'), `# ${id}\n`);
    }
    fs.writeFileSync(path.join(root, '.squad/team.md'), '# Team\n');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('records reject, assign, submit and approve; refuses an invalid transition', async () => {
    const { runLockoutCommand } = await import('../packages/squad-cli/src/cli/commands/lockout.js');
    const run = (...a: string[]) => runLockoutCommand(root, a);
    expect(await run('reject', 'pr-7', '--author', 'dallas', '--reviewer', 'ripley', '--reason', 'no tests', '--paths', 'src/**')).toBe(0);
    expect(await run('assign', 'pr-7', '--successor', 'dallas')).toBe(1);
    expect(await run('assign', 'pr-7', '--successor', 'lambert')).toBe(0);
    expect(await run('submit', 'pr-7', '--author', 'lambert')).toBe(0);
    expect(await run('approve', 'pr-7', '--reviewer', 'ripley')).toBe(0);
    const rec = readLockouts(path.join(root, '.squad')).subjects[0]!;
    expect(rec).toMatchObject({ subject: 'pr-7', state: 'cleared', lockedAuthors: ['dallas'], successor: 'lambert', paths: ['src/**'] });
  });
});
