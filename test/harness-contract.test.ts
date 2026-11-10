/**
 * Runs the shared HarnessAdapter contract against every harness in the repository.
 */
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
          void (async () => {
            const results = await Promise.all((script.tools ?? []).map((t, i) =>
              config.onPermissionRequest({ kind: 'shell', toolCallId: `call_${i}`, fullCommandText: String(t.input['command'] ?? t.name), ...t.input }, { sessionId: id })));
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
