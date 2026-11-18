/**
 * Regressions for review round 4 on github/squad#2451 (Copilot review of the execution harnesses).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClaudeAgentSdkHarness,
  CopilotSdkHarness,
  DefaultHarnessRegistry,
  LocalSquadBackend,
  TurnApprovals,
  claudeDenyRules,
  redactText,
  type ClaudeAgentSdkModule,
  type ClaudeQueryOptions,
  type CopilotClientLike,
  type CopilotPermissionResult,
  type CopilotSessionConfig,
  type CopilotSessionEvent,
  type HarnessApprovalRequest,
} from '../packages/squad-sdk/src/backend/index.js';

const tmpDirs: string[] = [];
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const submission = (runId: string, seq: number, operationId = `c:${runId}:${seq}`) => ({
  conversationId: 'c', runId, seq, operationId, messages: [{ runId, seq, role: 'user' as const, content: `task ${seq}` }],
});

/** Scripted Agent SDK that records every query's options. */
function claudeSdk() {
  const calls: ClaudeQueryOptions[] = [];
  const sdk: ClaudeAgentSdkModule = {
    query({ options = {} }) {
      calls.push(options);
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: `sess-${calls.length}` };
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'ok' }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
      })();
    },
  };
  return { sdk, calls };
}

/** Scripted Copilot client: each session runs `turn` per send, after emitting our user.message. */
function copilotClient(turn: (ctx: {
  fire: (e: CopilotSessionEvent) => void;
  ask: (r: Parameters<CopilotSessionConfig['onPermissionRequest']>[0]) => Promise<CopilotPermissionResult>;
}) => Promise<void> = async ({ fire }) => { fire({ type: 'assistant.message', data: { content: 'ok' } }); fire({ type: 'session.idle' }); },
opts: { failAbort?: () => boolean; failSend?: () => boolean; silentUserMessage?: boolean } = {}) {
  const log = { created: [] as string[], resumed: [] as string[], aborts: 0, sends: 0 };
  const c: CopilotClientLike = {
    async start() {},
    async createSession(config) { const id = `s-${log.created.length + 1}`; log.created.push(id); return make(config, id); },
    async resumeSession(id, config) { log.resumed.push(id); return make(config, id); },
  };
  function make(config: CopilotSessionConfig, id: string) {
    const handlers = new Set<(e: CopilotSessionEvent) => void>();
    const fire = (e: CopilotSessionEvent) => handlers.forEach((h) => h(e));
    return {
      sessionId: id,
      on(h: (e: CopilotSessionEvent) => void) { handlers.add(h); return () => handlers.delete(h); },
      async abort() { log.aborts++; if (opts.failAbort?.()) throw new Error('abort RPC failed'); },
      async send() {
        log.sends++;
        if (opts.failSend?.()) throw new Error('transport closed');
        const messageId = `m-${log.sends}`;
        queueMicrotask(() => {
          if (!opts.silentUserMessage) fire({ type: 'user.message', data: { messageId } });
          void turn({ fire, ask: (r) => config.onPermissionRequest(r, { sessionId: id }) });
        });
        return messageId;
      },
    };
  }
  return { client: c, log };
}

describe('durability across harness restarts (submit dedupe, session ids)', () => {
  it('claude-agent-sdk: a restarted harness neither re-runs an accepted turn nor loses the session', async () => {
    const stateDir = tmp('squad-harness-state-');
    const { sdk, calls } = claudeSdk();
    const first = new ClaudeAgentSdkHarness({ cwd: '.', stateDir, loadSdk: async () => sdk });
    await first.submit(submission('r1', 1));
    await first.settled('c', 'r1', 1);
    expect(calls).toHaveLength(1);

    const restarted = new ClaudeAgentSdkHarness({ cwd: '.', stateDir, loadSdk: async () => sdk });
    await restarted.submit(submission('r1', 1)); // redelivery after restart
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toHaveLength(1);
    await restarted.submit(submission('r2', 2));
    await restarted.settled('c', 'r2', 2);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.resume).toBe('sess-1');
  });

  it('copilot-sdk: a restarted harness resumes the conversation session and skips accepted turns', async () => {
    const stateDir = tmp('squad-harness-state-');
    const a = copilotClient();
    const first = new CopilotSdkHarness({ cwd: '.', stateDir, createClient: async () => a.client });
    await first.submit(submission('r1', 1));
    await first.settled('c', 'r1', 1);
    const b = copilotClient();
    const restarted = new CopilotSdkHarness({ cwd: '.', stateDir, createClient: async () => b.client });
    await restarted.submit(submission('r1', 1));
    await restarted.submit(submission('r2', 2));
    await restarted.settled('c', 'r2', 2);
    expect(b.log.sends).toBe(1); // only r2
    expect(b.log.resumed).toEqual(['s-1']);
    expect(b.log.created).toEqual([]);
  });
});

describe('copilot-sdk: event correlation and recovery', () => {
  async function broker(client: CopilotClientLike, extra: Partial<ConstructorParameters<typeof CopilotSdkHarness>[0]> = {}) {
    const harness = new CopilotSdkHarness({ cwd: '.', createClient: async () => client, ...extra });
    const harnesses = new DefaultHarnessRegistry();
    harnesses.register(harness);
    const backend = new LocalSquadBackend({ harnesses });
    await backend.createConversation({ conversationId: 'c' });
    const send = (runId: string, seq: number) => backend.sendMessage('c', { runId, seq, role: 'user', content: `task ${seq}`, harness: 'copilot-sdk' });
    return { harness, backend, send };
  }

  it('ignores an idle and an answer that arrive before its own user.message (from an earlier turn)', async () => {
    let fireOutside: ((e: CopilotSessionEvent) => void) | undefined;
    const { client } = copilotClient(async ({ fire }) => {
      fireOutside = fire;
      await new Promise((r) => setTimeout(r, 10));
      fire({ type: 'assistant.message', data: { content: 'the real answer' } });
      fire({ type: 'session.idle' });
    }, { silentUserMessage: true });
    const { harness, backend, send } = await broker(client);
    const sending = send('r1', 1);
    await until(() => fireOutside !== undefined);
    await sending;
    fireOutside!({ type: 'assistant.message', data: { content: 'stale answer from before' } });
    fireOutside!({ type: 'session.idle' });
    fireOutside!({ type: 'user.message', data: { messageId: 'm-1' } });
    await harness.settled('c', 'r1', 1);
    expect((await backend.getTurn('c', 1)).state).toBe('completed');
    expect((await backend.getTranscript('c')).map((m) => m.content)).toEqual(['task 1', 'the real answer']);
  });

  it('a failed interrupt stays retryable and the next turn gets a fresh session', async () => {
    let abortFails = true;
    const { client, log } = copilotClient(async () => { /* never idles */ }, { failAbort: () => abortFails });
    const { harness, backend, send } = await broker(client);
    await send('r1', 1);
    await until(() => log.sends === 1);
    await backend.cancelTurn('c', 1);
    await harness.cancel('c', 'r1', 1);
    await harness.settled('c', 'r1', 1);
    expect(log.aborts).toBe(1);
    abortFails = false;
    await harness.cancel('c', 'r1', 1); // retried
    await send('r2', 2);
    await until(() => log.sends === 2);
    expect(log.resumed).toEqual(['s-1']); // the old session object was dropped
  });

  it('a send that fails drops the session, and the next turn resumes it', async () => {
    let failNext = true;
    const { client, log } = copilotClient(undefined, { failSend: () => { const f = failNext; failNext = false; return f; } });
    const { harness, backend, send } = await broker(client);
    await send('r1', 1);
    await harness.settled('c', 'r1', 1);
    expect((await backend.getTurn('c', 1)).state).toBe('failed');
    await send('r2', 2);
    await harness.settled('c', 'r2', 2);
    expect((await backend.getTurn('c', 2)).state).toBe('completed');
    expect(log.resumed).toEqual(['s-1']);
  });

  it('a turn with no terminal event times out, fails, and drops its session', async () => {
    const { client, log } = copilotClient(async () => { /* silent */ });
    const { harness, backend, send } = await broker(client, { turnTimeoutMs: 30 });
    await send('r1', 1);
    await harness.settled('c', 'r1', 1);
    expect(await backend.getTurn('c', 1)).toMatchObject({ state: 'failed', error: expect.stringContaining('timed out') });
    await send('r2', 2);
    await until(() => log.sends === 2);
    expect(log.resumed).toEqual(['s-1']);
  });

  it('gives each permission request of one tool call its own approval id', async () => {
    const { client } = copilotClient(async ({ fire, ask }) => {
      await ask({ kind: 'url', toolCallId: 'call_f', url: 'https://example.com' });
      await ask({ kind: 'shell', toolCallId: 'call_f', fullCommandText: 'sandbox escalation' });
      fire({ type: 'assistant.message', data: { content: 'fetched' } });
      fire({ type: 'session.idle' });
    });
    const { harness, backend, send } = await broker(client);
    await send('r1', 1);
    for (const id of ['call_f', 'call_f#2']) {
      await until(async () => (await backend.getApprovals('c')).some((a) => a.approvalId === id && a.state === 'pending'));
      const a = (await backend.getApprovals('c')).find((x) => x.approvalId === id)!;
      await backend.respondApproval('c', { approvalId: id, hash: a.hash, decision: 'approve' });
    }
    await harness.settled('c', 'r1', 1);
    expect((await backend.getTurn('c', 1)).state).toBe('completed');
  });
});

describe('approval queue: dropping an offered request', () => {
  it('ends the turn instead of offering the next request into the occupied slot', async () => {
    const offered: HarnessApprovalRequest[] = [];
    let denied = 0;
    const q = new TurnApprovals(1, (r) => offered.push(r), () => undefined, () => denied++);
    const first = q.request('a', 'Bash: a', { tool: 'Bash', input: { command: 'a' } });
    const second = q.request('b', 'Bash: b', { tool: 'Bash', input: { command: 'b' } });
    q.drop('a', 'tool call aborted');
    await expect(first).resolves.toMatchObject({ approved: false });
    await expect(second).resolves.toMatchObject({ approved: false });
    expect(offered.map((r) => r.approvalId)).toEqual(['a']);
    expect(denied).toBe(1);
  });
});

describe('claude-agent-sdk: credentials and deny rules', () => {
  it('refuses to start the real SDK without an API credential (no claude.ai login fallback)', async () => {
    const h = new ClaudeAgentSdkHarness({ cwd: '.', env: {} });
    await expect(h.submit(submission('r1', 1))).rejects.toThrow(/ANTHROPIC_API_KEY.*does not use a claude\.ai login/);
  });

  it('carries user, project and local deny rules into disallowedTools', async () => {
    const home = tmp('squad-home-');
    const cwd = tmp('squad-proj-');
    const write = (f: string, deny: string[]) => {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ permissions: { allow: ['Bash(*)'], deny } }));
    };
    write(path.join(home, '.claude', 'settings.json'), ['Read(~/.ssh/**)']);
    write(path.join(cwd, '.claude', 'settings.json'), ['Read(./.env)']);
    write(path.join(cwd, '.claude', 'settings.local.json'), ['Bash(rm *)', 'Read(./.env)']);
    expect(claudeDenyRules(cwd, home).sort()).toEqual(['Bash(rm *)', 'Read(./.env)', 'Read(~/.ssh/**)']);

    const { sdk, calls } = claudeSdk();
    const h = new ClaudeAgentSdkHarness({ cwd, homeDir: home, loadSdk: async () => sdk });
    await h.submit(submission('r1', 1));
    await h.settled('c', 'r1', 1);
    expect(calls[0]).toMatchObject({ settingSources: [], permissionMode: 'default' });
    expect([...calls[0]!.disallowedTools!].sort()).toEqual(['Bash(rm *)', 'Read(./.env)', 'Read(~/.ssh/**)']); // allow rules are not carried
  });
});

describe('state-mcp bridge setup', () => {
  it('runs turns in the worktree-aware repoRoot and keeps harness state beside the backend', async () => {
    const { createMcpBackend, createLocalHarnesses, harnessStateDir } = await import('../packages/squad-cli/src/cli/core/backend-mcp.js');
    const main = tmp('squad-main-');
    fs.mkdirSync(path.join(main, '.squad'));
    const worktree = tmp('squad-worktree-');
    let seen: { root: string; stateDir: string } | undefined;
    createMcpBackend(worktree, {}, () => ({
      paths: { teamSquadDir: path.join(main, '.squad'), projectDir: path.join(main, '.squad') } as never,
      backend: { name: 'local' } as never,
      repoRoot: worktree,
    }), (root, stateDir) => {
      seen = { root, stateDir };
      return new DefaultHarnessRegistry();
    });
    expect(seen).toEqual({ root: worktree, stateDir: path.join(main, '.squad', 'backend', 'harnesses') });
    expect(harnessStateDir({ paths: { teamSquadDir: '/t/.squad' }, backend: { name: 'git-notes' } })).toContain(path.join('.cache', 'squad', 'harnesses'));

    const registry = createLocalHarnesses(worktree, { SQUAD_BACKEND_HARNESSES: 'copilot-sdk' }, { stateDir: '/state' });
    const copilot = registry.get('copilot-sdk') as unknown as { options: { configDirectory?: string; stateDir?: string } };
    expect(copilot.options).toMatchObject({ stateDir: path.join('/state', 'copilot-sdk'), configDirectory: path.join('/state', 'copilot-sdk', 'copilot-config') });
  });
});

describe('redaction: more credential forms, never hiding executable syntax', () => {
  it('masks JSON keys, Authorization schemes, credential flags and -u passwords', () => {
    expect(redactText('{"password":"fixture-db-password","user":"app"}')).toBe('{"password":[redacted],"user":"app"}');
    expect(redactText('curl -H "Authorization: token ghx0123456789" x')).toBe('curl -H "Authorization: token [redacted]" x');
    expect(redactText('mysql --password hunter2 db')).toBe('mysql --password [redacted] db');
    expect(redactText('psql --password=hunter2 db')).toBe('psql --password=[redacted] db');
    expect(redactText('curl --user alice:wonderland https://x')).toBe('curl --user alice:[redacted] https://x');
    expect(redactText('curl -u alice:wonderland https://x')).toBe('curl -u alice:[redacted] https://x');
  });

  it('keeps executable content visible to the approver', () => {
    expect(redactText('TOKEN="$(rm -rf ./src)" npm test')).toBe('TOKEN="$(rm -rf ./src)" npm test');
    expect(redactText('token=x;touch${IFS}/tmp/pwned')).toBe('token=[redacted];touch${IFS}/tmp/pwned');
    expect(redactText('export API_KEY=`cat /etc/passwd`')).toBe('export API_KEY=`cat /etc/passwd`');
    expect(redactText('gh pr create --token-file ./t.txt')).toBe('gh pr create --token-file ./t.txt');
  });
});
