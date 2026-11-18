/**
 * Runs the shared HarnessAdapter contract against every harness in the repository.
 */
import { describe, it, expect } from 'vitest';
import { harnessContract, type ContractScript } from './harness-contract.js';
import {
  ClaudeAgentSdkHarness,
  CopilotSdkHarness,
  type ClaudeAgentSdkModule,
  type CopilotClientLike,
  type CopilotSessionEvent,
  type HarnessAdapter,
} from '../packages/squad-sdk/src/backend/index.js';

const dispatched = new WeakMap<HarnessAdapter, { n: number }>();

/** Startup as scripted: wait for the gate, fail the first `failStarts` attempts. */
function starter(script: ContractScript) {
  let failures = script.failStarts ?? 0;
  return async () => {
    await script.gate;
    if (failures-- > 0) throw new Error('scripted startup failure');
  };
}

/** Scripted Agent SDK: requests approval for each tool in parallel, then replies. */
function scriptedClaudeSdk(script: ContractScript, count: { n: number }): ClaudeAgentSdkModule {
  return {
    query({ options = {} }) {
      count.n++;
      return (async function* () {
        yield { type: 'system', subtype: 'init', session_id: 'contract-session' };
        await Promise.all(
          (script.tools ?? []).map((t, i) =>
            options.canUseTool!(t.name, t.input, { signal: options.abortController!.signal, toolUseID: `toolu_${i}` })),
        );
        if (options.abortController?.signal.aborted) throw new Error('aborted');
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: script.reply }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: script.reply };
      })();
    },
  };
}

harnessContract('claude-agent-sdk', {
  create: (script) => {
    const count = { n: 0 };
    const start = starter(script);
    const h = new ClaudeAgentSdkHarness({ cwd: process.cwd(), loadSdk: async () => { await start(); return scriptedClaudeSdk(script, count); } });
    dispatched.set(h, count);
    return h;
  },
  dispatches: (h) => dispatched.get(h)!.n,
  settled: (h: HarnessAdapter, c, r, s) => (h as ClaudeAgentSdkHarness).settled(c, r, s),
});

/**
 * Scripted Copilot client: `send()` returns at once (as the real SDK does); permission requests for each tool
 * then run in parallel, followed by the assistant message and `session.idle`.
 */
export function scriptedCopilotClient(script: ContractScript, count: { n: number } = { n: 0 }, start = starter(script)): CopilotClientLike & { sessions: number; resumed: string[] } {
  const client = {
    sessions: 0,
    resumed: [] as string[],
    async start() { await start(); },
    async resumeSession(id: string, config: Parameters<CopilotClientLike['createSession']>[0]) {
      client.resumed.push(id);
      return client.createSession(config, id);
    },
    async createSession(config: Parameters<CopilotClientLike['createSession']>[0], id = `copilot-session-${++client.sessions}`) {
      const handlers = new Set<(e: CopilotSessionEvent) => void>();
      let aborted = false;
      const fire = (e: CopilotSessionEvent) => handlers.forEach((h) => h(e));
      return {
        sessionId: id,
        on(h: (e: CopilotSessionEvent) => void) { handlers.add(h); return () => handlers.delete(h); },
        async abort() { aborted = true; },
        async send() {
          count.n++;
          const messageId = `msg-${count.n}`;
          // As the real runtime does: our user.message, then permission requests, the reply and idle.
          queueMicrotask(() => fire({ type: 'user.message', data: { messageId } }));
          void (async () => {
            await Promise.resolve();
            const results = await Promise.all((script.tools ?? []).map((t, i) =>
              config.onPermissionRequest({ kind: 'shell', toolCallId: `call_${i}`, fullCommandText: String(t.input['command'] ?? t.name), ...t.input }, { sessionId: id })));
            if (aborted || results.some((r) => r.kind === 'reject')) { fire({ type: 'session.idle' }); return; }
            fire({ type: 'assistant.message', data: { content: script.reply } });
            fire({ type: 'session.idle' });
          })();
          return messageId;
        },
      };
    },
  };
  return client;
}

harnessContract('copilot-sdk', {
  create: (script) => {
    const count = { n: 0 };
    const start = starter(script); // one startup script across retries
    const h = new CopilotSdkHarness({ cwd: process.cwd(), createClient: async () => scriptedCopilotClient(script, count, start) });
    dispatched.set(h, count);
    return h;
  },
  dispatches: (h) => dispatched.get(h)!.n,
  settled: (h: HarnessAdapter, c, r, s) => (h as CopilotSdkHarness).settled(c, r, s),
});

describe('approval record redaction (TurnApprovals)', () => {
  it('masks header-style and env-style credentials, keeping the surrounding syntax', async () => {
    const { redactText } = await import('../packages/squad-sdk/src/backend/index.js');
    expect(redactText('curl -H "X-API-Key: abc123secret" https://x')).toBe('curl -H "X-API-Key: [redacted]" https://x');
    expect(redactText('curl -H "X-Auth-Token: tok987654321" https://x')).toBe('curl -H "X-Auth-Token: [redacted]" https://x');
    expect(redactText('curl -H "Cookie: session=deadbeefcafe" https://x')).toBe('curl -H "Cookie: [redacted]" https://x');
    expect(redactText('curl -H "Authorization: Bearer sk-live-0123456789abcdef" x')).toBe('curl -H "Authorization: Bearer [redacted]" x');
    expect(redactText('curl -H "Proxy-Authorization: Basic dXNlcjpwYXNzd29yZA==" x')).toBe('curl -H "Proxy-Authorization: Basic [redacted]" x');
    expect(redactText('export GITHUB_TOKEN=ghp_abcdefghijklmnop')).toBe('export GITHUB_TOKEN=[redacted]');
    expect(redactText('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG aws s3 ls')).toBe('AWS_SECRET_ACCESS_KEY=[redacted] aws s3 ls');
    expect(redactText('https://api.example.com?token=s3cr3t&page=2')).toBe('https://api.example.com?token=[redacted]&page=2');
  });

  it('masks bare token-shaped secrets and URL passwords', async () => {
    const { redactText } = await import('../packages/squad-sdk/src/backend/index.js');
    expect(redactText('gh auth login --with-token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')).toBe('gh auth login --with-token [redacted]');
    expect(redactText('curl https://bob:hunter2pass@api.example.com/v1')).toBe('curl https://bob:[redacted]@api.example.com/v1');
    expect(redactText('node deploy.js sk-ant-api03-AbCdEfGhIjKlMnOpQrSt')).toBe('node deploy.js [redacted]');
    expect(redactText('aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE')).toBe('aws configure set aws_access_key_id [redacted]');
    expect(redactText('call --jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U')).toBe('call --jwt [redacted]');
    expect(redactText('slack-notify xoxb-1234567890-abcdefghij')).toBe('slack-notify [redacted]');
    expect(redactText('run --secret Zm9vYmFyQmF6UXV4MTIzNDU2Nzg5MEFCQ0RFRkdISUpLTE1O')).toBe('run --secret [redacted]');
  });

  it('keeps hashes, ids and paths readable for the approver', async () => {
    const { redactText } = await import('../packages/squad-sdk/src/backend/index.js');
    for (const s of [
      'git checkout 9273a84c84ff51eb990d909b96c2e96b4c647c5a',
      'sha256sum: 5f2b4c1e9a7d3f6b8e0c2a4d6f8b0e2c4a6d8f0b2e4c6a8d0f2b4e6c8a0d2f4b',
      'rm -rf node_modules/@anthropic-ai/claude-agent-sdk/dist/ConfigurationManagerFactoryImplementation.js',
      'id 3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      'npm install @github/copilot-sdk@1.0.19',
      'git push origin squad/2441-claude-agent-sdk-harness',
    ]) expect(redactText(s)).toBe(s);
  });

  it('leaves look-alike words alone', async () => {
    const { redactText } = await import('../packages/squad-sdk/src/backend/index.js');
    for (const s of ['git log --author=brady --since=1.week', 'mkdir -p build/out', 'python tokenizer.py --input a.txt', 'npm test -- --run', 'session: started']) {
      expect(redactText(s)).toBe(s);
    }
  });
});
