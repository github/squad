/**
 * Runs the shared HarnessAdapter contract against every harness in the repository.
 */
import { harnessContract } from './harness-contract.js';
import {
  ClaudeAgentSdkHarness,
  CopilotSdkHarness,
  type ClaudeAgentSdkModule,
  type CopilotClientLike,
  type CopilotSessionEvent,
  type HarnessAdapter,
} from '../packages/squad-sdk/src/backend/index.js';

/** Scripted Agent SDK: requests approval for each tool in parallel, then replies. */
function scriptedClaudeSdk(script: { reply: string; tools?: Array<{ name: string; input: Record<string, unknown> }> }): ClaudeAgentSdkModule {
  return {
    query({ options = {} }) {
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
  create: (script) => new ClaudeAgentSdkHarness({ cwd: process.cwd(), loadSdk: async () => scriptedClaudeSdk(script) }),
  settled: (h: HarnessAdapter, c, r, s) => (h as ClaudeAgentSdkHarness).settled(c, r, s),
});

/**
 * Scripted Copilot client: `send()` returns at once (as the real SDK does); permission requests for each tool
 * then run in parallel, followed by the assistant message and `session.idle`.
 */
export function scriptedCopilotClient(script: { reply: string; tools?: Array<{ name: string; input: Record<string, unknown> }> }): CopilotClientLike & { sessions: number; resumed: string[] } {
  const client = {
    sessions: 0,
    resumed: [] as string[],
    async start() {},
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
          void (async () => {
            const results = await Promise.all((script.tools ?? []).map((t, i) =>
              config.onPermissionRequest({ kind: 'shell', toolCallId: `call_${i}`, fullCommandText: String(t.input['command'] ?? t.name) }, { sessionId: id })));
            if (aborted || results.some((r) => r.kind === 'reject')) { fire({ type: 'session.idle' }); return; }
            fire({ type: 'assistant.message', data: { content: script.reply } });
            fire({ type: 'session.idle' });
          })();
          return 'message-id';
        },
      };
    },
  };
  return client;
}

harnessContract('copilot-sdk', {
  create: (script) => new CopilotSdkHarness({ cwd: process.cwd(), createClient: async () => scriptedCopilotClient(script) }),
  settled: (h: HarnessAdapter, c, r, s) => (h as CopilotSdkHarness).settled(c, r, s),
});
