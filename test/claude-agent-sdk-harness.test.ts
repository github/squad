/**
 * `claude-agent-sdk` HarnessAdapter (#2441).
 *
 * Deterministic tests replay scripted SDK exchanges through the real adapter and the real
 * LocalSquadBackend: the protocol rules that must hold on every PR (dedupe, hash binding, replay,
 * one-approval-at-a-time, cancel, permission isolation). The live tests run the real Agent SDK and need
 * `SQUAD_REAL_CLI_TESTS=1` plus credentials (`ANTHROPIC_API_KEY`, or Bedrock/Vertex settings).
 */
import { describe, it, expect } from 'vitest';
import {
  BACKEND_PROTOCOL_VERSION,
  ClaudeAgentSdkHarness,
  DefaultHarnessRegistry,
  LocalSquadBackend,
  MemoryStateStore,
  claudeApprovalHash,
  claudeApiCredentialsConfigured,
  type ClaudeAgentSdkModule,
  type ClaudeQueryOptions,
  type ClaudeSdkMessage,
  type HarnessEventEnvelope,
} from '../packages/squad-sdk/src/backend/index.js';

const HARNESS = 'claude-agent-sdk';
const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`harness did not settle within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

interface ToolCall { name: string; input: Record<string, unknown>; id: string }

const GOLDEN_COMMAND = 'touch squad-golden-marker.txt && exec sleep 60';
const GOLDEN_TOOL_TIMEOUT = 120_000;

function goldenToolGuard() {
  const requests = new Map<string, ToolCall>();
  return {
    wrap(sdk: ClaudeAgentSdkModule): ClaudeAgentSdkModule {
      return {
        query({ prompt, options = {} }) {
          const canUseTool = options.canUseTool!;
          return sdk.query({
            prompt,
            options: {
              ...options,
              canUseTool(name, input, context) {
                requests.set(context.toolUseID, { name, input: structuredClone(input), id: context.toolUseID });
                return canUseTool(name, input, context);
              },
            },
          });
        },
      };
    },
    async approve(client: LocalSquadBackend, conversationId: string, approval: { approvalId: string; hash: string }, decision: 'approve') {
      const request = requests.get(approval.approvalId);
      if (request?.name !== 'Bash' || request.input['command'] !== GOLDEN_COMMAND) {
        throw new Error('golden trace requires the exact Bash command input');
      }
      if (request.input['run_in_background'] !== false) {
        throw new Error('golden trace requires explicit foreground execution');
      }
      if (request.input['timeout'] !== GOLDEN_TOOL_TIMEOUT) {
        throw new Error(`golden trace requires an explicit ${GOLDEN_TOOL_TIMEOUT} ms tool timeout`);
      }
      if (approval.hash !== claudeApprovalHash(request.name, request.input)) {
        throw new Error('golden trace approval hash does not match the captured input');
      }
      return client.respondApproval(conversationId, { approvalId: approval.approvalId, hash: approval.hash, decision });
    },
  };
}

/**
 * Replays one recorded exchange: optional tool calls (each through `canUseTool`, concurrently, as Claude
 * does for parallel calls), then the assistant text and a result event.
 */
function replay(script: { text?: string; tools?: ToolCall[]; result?: Partial<ClaudeSdkMessage> } = {}) {
  const calls: Array<{ prompt: string; options: ClaudeQueryOptions }> = [];
  const decisions: Array<{ id: string; behavior: string; input?: unknown }> = [];
  const sdk: ClaudeAgentSdkModule = {
    query({ prompt, options = {} }) {
      calls.push({ prompt, options });
      return (async function* () {
        const session = `sess-${calls.length}`;
        yield { type: 'system', subtype: 'init', session_id: session };
        if (script.tools?.length) {
          const results = await Promise.all(
            script.tools.map((t) => options.canUseTool!(t.name, t.input, { signal: options.abortController!.signal, toolUseID: t.id })),
          );
          results.forEach((r, i) => decisions.push({ id: script.tools![i]!.id, behavior: r.behavior, ...(r.behavior === 'allow' ? { input: r.updatedInput } : {}) }));
        }
        if (options.abortController?.signal.aborted) throw new Error('aborted');
        yield { type: 'assistant', session_id: session, parent_tool_use_id: null, message: { content: [{ type: 'text', text: script.text ?? 'done' }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: script.text ?? 'done', session_id: session, ...script.result };
      })();
    },
  };
  return { sdk, calls, decisions };
}

async function setup(sdk: ClaudeAgentSdkModule) {
  const harness = new ClaudeAgentSdkHarness({ cwd: process.cwd(), loadSdk: async () => sdk });
  const harnesses = new DefaultHarnessRegistry();
  harnesses.register(harness);
  const backend = new LocalSquadBackend({ harnesses });
  await backend.createConversation({ conversationId: 'c' });
  const send = (runId: string, seq: number, content = `task ${seq}`) =>
    backend.sendMessage('c', { runId, seq, role: 'user', content, harness: HARNESS });
  return { harness, backend, send };
}

describe('claude-agent-sdk harness: deterministic protocol checks', () => {
  it('runs a turn end to end and resumes the Claude session on the next turn', async () => {
    const { sdk, calls } = replay({ text: 'hello from claude' });
    const { harness, backend, send } = await setup(sdk);
    await send('r1', 1, 'say hello');
    await harness.settled('c', 'r1', 1);
    expect((await backend.getTurn('c', 1)).state).toBe('completed');
    expect((await backend.getTranscript('c')).map((m) => [m.role, m.content])).toEqual([['user', 'say hello'], ['assistant', 'hello from claude']]);
    await send('r2', 2);
    await harness.settled('c', 'r2', 2);
    expect(calls[0]!.options.resume).toBeUndefined();
    expect(calls[1]!.options.resume).toBe('sess-1');
  });

  it('isolates permissions: default mode and no filesystem settings', async () => {
    const { sdk, calls } = replay();
    const { harness, send } = await setup(sdk);
    await send('r1', 1);
    await harness.settled('c', 'r1', 1);
    expect(calls[0]!.options).toMatchObject({ permissionMode: 'default', settingSources: [] });
  });

  it('deduplicates redelivered submissions', async () => {
    const { sdk, calls } = replay();
    const harness = new ClaudeAgentSdkHarness({ cwd: process.cwd(), loadSdk: async () => sdk });
    const s = { conversationId: 'c', runId: 'r1', seq: 1, operationId: 'c:r1:1', messages: [{ runId: 'r1', seq: 1, role: 'user' as const, content: 'x' }] };
    await harness.submit(s);
    await harness.submit(s);
    await harness.settled('c', 'r1', 1);
    expect(calls).toHaveLength(1);
  });

  it('approve: the request carries a hash of the action, and the original input runs', async () => {
    const input = { command: 'npm test', description: 'run tests' };
    const { sdk, decisions } = replay({ tools: [{ name: 'Bash', input, id: 'toolu_1' }] });
    const { harness, backend, send } = await setup(sdk);
    await send('r1', 1);
    await until(async () => (await backend.getApprovals('c')).length === 1);
    const [approval] = await backend.getApprovals('c');
    expect(approval).toMatchObject({ approvalId: 'toolu_1', state: 'pending', hash: claudeApprovalHash('Bash', input) });
    expect((await backend.getTurn('c', 1)).state).toBe('awaiting-approval');
    await backend.respondApproval('c', { approvalId: 'toolu_1', hash: approval!.hash, decision: 'approve' });
    await harness.settled('c', 'r1', 1);
    expect(decisions).toEqual([{ id: 'toolu_1', behavior: 'allow', input }]);
    expect((await backend.getTurn('c', 1)).state).toBe('completed');
  });

  it('deny: the tool call is denied with the reason', async () => {
    const { sdk, decisions } = replay({ tools: [{ name: 'Bash', input: { command: 'rm -rf build' }, id: 'toolu_2' }] });
    const { harness, backend, send } = await setup(sdk);
    await send('r1', 1);
    await until(async () => (await backend.getApprovals('c')).length === 1);
    const [a] = await backend.getApprovals('c');
    await backend.respondApproval('c', { approvalId: 'toolu_2', hash: a!.hash, decision: 'deny', reason: 'not now' });
    await harness.settled('c', 'r1', 1);
    expect(decisions).toEqual([{ id: 'toolu_2', behavior: 'deny' }]);
  });

  it('hash mismatch: the response is refused and the call keeps waiting', async () => {
    const { sdk, decisions } = replay({ tools: [{ name: 'Edit', input: { file_path: 'a.ts' }, id: 'toolu_3' }] });
    const harness = new ClaudeAgentSdkHarness({ cwd: process.cwd(), loadSdk: async () => sdk });
    const events: HarnessEventEnvelope[] = [];
    harness.subscribe('c', (e) => events.push(e));
    await harness.submit({ conversationId: 'c', runId: 'r1', seq: 1, messages: [{ runId: 'r1', seq: 1, role: 'user', content: 'x' }] });
    await until(() => events.some((e) => e.type === 'approval-requested'));
    await expect(harness.respondApproval('c', { approvalId: 'toolu_3', hash: 'sha256:forged', decision: 'approve' })).rejects.toThrow(/hash does not match/);
    await tick();
    expect(decisions).toEqual([]);
    const req = events.find((e) => e.type === 'approval-requested') as Extract<HarnessEventEnvelope, { type: 'approval-requested' }>;
    await harness.respondApproval('c', { approvalId: 'toolu_3', hash: req.request.hash, decision: 'approve' });
    await harness.settled('c', 'r1', 1);
    expect(decisions).toHaveLength(1);
  });

  it('replay: a redelivered decision is a no-op', async () => {
    const { sdk, decisions } = replay({ tools: [{ name: 'Bash', input: { command: 'ls' }, id: 'toolu_4' }] });
    const harness = new ClaudeAgentSdkHarness({ cwd: process.cwd(), loadSdk: async () => sdk });
    const events: HarnessEventEnvelope[] = [];
    harness.subscribe('c', (e) => events.push(e));
    await harness.submit({ conversationId: 'c', runId: 'r1', seq: 1, messages: [{ runId: 'r1', seq: 1, role: 'user', content: 'x' }] });
    await until(() => events.some((e) => e.type === 'approval-requested'));
    const hash = claudeApprovalHash('Bash', { command: 'ls' });
    await harness.respondApproval('c', { approvalId: 'toolu_4', hash, decision: 'approve' }, 'op-1');
    await harness.respondApproval('c', { approvalId: 'toolu_4', hash, decision: 'deny' }, 'op-1');
    await harness.settled('c', 'r1', 1);
    expect(decisions).toEqual([{ id: 'toolu_4', behavior: 'allow', input: { command: 'ls' } }]);
  });

  it('parallel tool calls are offered one at a time (one pending approval per turn)', async () => {
    const tools = [
      { name: 'Bash', input: { command: 'a' }, id: 'toolu_a' },
      { name: 'Bash', input: { command: 'b' }, id: 'toolu_b' },
    ];
    const { sdk, decisions } = replay({ tools });
    const { harness, backend, send } = await setup(sdk);
    await send('r1', 1);
    await until(async () => (await backend.getApprovals('c')).length === 1);
    await tick();
    expect((await backend.getApprovals('c')).map((a) => a.approvalId)).toEqual(['toolu_a']);
    await backend.respondApproval('c', { approvalId: 'toolu_a', hash: claudeApprovalHash('Bash', { command: 'a' }), decision: 'approve' });
    await until(async () => (await backend.getApprovals('c')).some((a) => a.approvalId === 'toolu_b' && a.state === 'pending'));
    await backend.respondApproval('c', { approvalId: 'toolu_b', hash: claudeApprovalHash('Bash', { command: 'b' }), decision: 'deny' });
    await harness.settled('c', 'r1', 1);
    expect(decisions.map((d) => [d.id, d.behavior])).toEqual([['toolu_a', 'allow'], ['toolu_b', 'deny']]);
    expect((await backend.getTurn('c', 1)).state).toBe('cancelled'); // a deny ends the turn
  });

  it('a deny ends the turn: queued parallel calls are denied without being offered', async () => {
    const tools = [
      { name: 'Bash', input: { command: 'a' }, id: 'toolu_x' },
      { name: 'Bash', input: { command: 'b' }, id: 'toolu_y' },
    ];
    const { sdk, decisions } = replay({ tools });
    const { harness, backend, send } = await setup(sdk);
    await send('r1', 1);
    await until(async () => (await backend.getApprovals('c')).length === 1);
    await backend.respondApproval('c', { approvalId: 'toolu_x', hash: claudeApprovalHash('Bash', { command: 'a' }), decision: 'deny' });
    await harness.settled('c', 'r1', 1);
    expect(decisions.map((d) => [d.id, d.behavior])).toEqual([['toolu_x', 'deny'], ['toolu_y', 'deny']]);
    expect((await backend.getApprovals('c')).map((a) => a.approvalId)).toEqual(['toolu_x']);
    expect((await backend.getTurn('c', 1)).state).toBe('cancelled');
  });

  it('cancel aborts the query and denies a pending approval', async () => {
    const { sdk, decisions } = replay({ tools: [{ name: 'Bash', input: { command: 'sleep 99' }, id: 'toolu_c' }] });
    const { harness, backend, send } = await setup(sdk);
    await send('r1', 1);
    await until(async () => (await backend.getApprovals('c')).length === 1);
    await backend.cancelTurn('c', 1);
    await harness.cancel('c', 'r1', 1);
    await harness.cancel('c', 'r1', 1); // idempotent
    await harness.settled('c', 'r1', 1);
    expect(decisions).toEqual([{ id: 'toolu_c', behavior: 'deny' }]);
    expect((await backend.getTurn('c', 1)).state).toBe('cancelled');
  });

  it('an error result fails the turn', async () => {
    const { sdk } = replay({ result: { subtype: 'error_max_turns', is_error: true, result: '' } });
    const { harness, backend, send } = await setup(sdk);
    await send('r1', 1);
    await harness.settled('c', 'r1', 1);
    expect(await backend.getTurn('c', 1)).toMatchObject({ state: 'failed', error: 'error_max_turns' });
  });

  it('without the SDK installed, submit fails so the broker retries, with a clear message', async () => {
    const harness = new ClaudeAgentSdkHarness({ cwd: process.cwd(), loadSdk: async () => { throw new Error('Cannot find module'); } });
    await expect(harness.submit({ conversationId: 'c', runId: 'r1', seq: 1, messages: [] })).rejects.toThrow(/@anthropic-ai\/claude-agent-sdk \(an optional peer dependency\)/);
  });

  it('describes itself for capability negotiation', () => {
    expect(new ClaudeAgentSdkHarness({ cwd: '.' }).describe()).toMatchObject({
      id: HARNESS,
      capabilities: { approvals: true, cancellation: true, streaming: true, tools: true, extensionNamespaces: ['x-claude'] },
    });
  });
});

describe('claude-agent-sdk harness: golden execution guard', () => {
  function timedTool(input: Record<string, unknown>, ignoresAbort = false) {
    const decisions: string[] = [];
    let started = false;
    const sdk: ClaudeAgentSdkModule = {
      query({ options = {} }) {
        return (async function* () {
          const result = await options.canUseTool!('Bash', input, { signal: options.abortController!.signal, toolUseID: 'golden-tool' });
          decisions.push(result.behavior);
          if (result.behavior === 'allow') {
            started = true;
            await new Promise<void>((resolve) => {
              const timeout = setTimeout(resolve, input['timeout'] as number);
              if (!ignoresAbort) {
                const stop = () => { clearTimeout(timeout); resolve(); };
                options.abortController!.signal.addEventListener('abort', stop, { once: true });
                if (options.abortController!.signal.aborted) stop();
              }
            });
          }
          yield { type: 'result', subtype: 'success', is_error: false };
        })();
      },
    };
    return { sdk, decisions, started: () => started };
  }

  it.each([
    { name: 'short timeout even when the transport ignores abort', input: { command: GOLDEN_COMMAND, timeout: 1000, run_in_background: false }, ignoresAbort: true, error: /explicit 120000 ms tool timeout/ },
    { name: 'background execution', input: { command: GOLDEN_COMMAND, timeout: GOLDEN_TOOL_TIMEOUT, run_in_background: true }, ignoresAbort: false, error: /explicit foreground/ },
    { name: 'implicit timeout defaults', input: { command: GOLDEN_COMMAND, run_in_background: false }, ignoresAbort: false, error: /explicit 120000 ms tool timeout/ },
  ])('refuses $name before approval', async ({ input, ignoresAbort, error }) => {
    const transport = timedTool(input, ignoresAbort);
    const guard = goldenToolGuard();
    const { harness, backend, send } = await setup(guard.wrap(transport.sdk));
    try {
      await send('r1', 1);
      await until(async () => (await backend.getApprovals('c')).length === 1);
      const [approval] = await backend.getApprovals('c');
      expect(approval!.action).toBe(`Bash: ${GOLDEN_COMMAND}`);
      await expect(guard.approve(backend, 'c', approval!, 'approve')).rejects.toThrow(error);
      expect((await backend.getTurn('c', 1)).state).toBe('awaiting-approval');
      expect(transport.started()).toBe(false);
    } finally {
      await harness.cancel('c', 'r1', 1);
      await harness.settled('c', 'r1', 1);
    }
    expect(transport.decisions).toEqual(['deny']);
  });

  it('approves the long foreground input and settles on cancellation, not tool timeout', async () => {
    const transport = timedTool({ command: GOLDEN_COMMAND, timeout: GOLDEN_TOOL_TIMEOUT, run_in_background: false });
    const guard = goldenToolGuard();
    const { harness, backend, send } = await setup(guard.wrap(transport.sdk));
    try {
      await send('r1', 1);
      await until(async () => (await backend.getApprovals('c')).length === 1);
      const [approval] = await backend.getApprovals('c');
      await guard.approve(backend, 'c', approval!, 'approve');
      await until(transport.started);
      await within((async () => {
        await backend.cancelRun('c', 'r1');
        await harness.settled('c', 'r1', 1);
      })(), 2000);
      expect((await backend.getTurn('c', 1)).state).toBe('cancelled');
      expect(transport.decisions).toEqual(['allow']);
    } finally {
      await harness.cancel('c', 'r1', 1);
      await harness.settled('c', 'r1', 1);
    }
  });
});

// Opting in without credentials or the optional SDK must fail, not silently skip.
const live = process.env['SQUAD_REAL_CLI_TESTS'] === '1';

describe.skipIf(!live)('claude-agent-sdk harness: live (real Agent SDK)', () => {
  it('completes a turn through the broker', async () => {
    const harness = new ClaudeAgentSdkHarness({ cwd: process.cwd(), maxTurns: 2 });
    const harnesses = new DefaultHarnessRegistry();
    harnesses.register(harness);
    const backend = new LocalSquadBackend({ harnesses });
    await backend.createConversation({ conversationId: 'live' });
    await backend.sendMessage('live', { runId: 'r1', seq: 1, role: 'user', content: 'Reply with exactly the word: pong', harness: HARNESS });
    await harness.settled('live', 'r1', 1);
    expect((await backend.getTurn('live', 1)).state).toBe('completed');
    expect((await backend.getTranscript('live')).at(-1)?.content.toLowerCase()).toContain('pong');
  }, 120_000);

  it('routes a real tool call through broker approval and honours a deny', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    // A command that writes: Claude Code runs some read-only commands (such as echo) without asking.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-claude-live-'));
    const marker = path.join(cwd, 'squad-live-marker.txt');
    const harness = new ClaudeAgentSdkHarness({ cwd, maxTurns: 4 });
    const harnesses = new DefaultHarnessRegistry();
    harnesses.register(harness);
    const backend = new LocalSquadBackend({ harnesses });
    await backend.createConversation({ conversationId: 'live2' });
    const events: unknown[] = [];
    harness.subscribe('live2', (e) => events.push(e));
    const diagnose = async () => JSON.stringify({
      turn: await backend.getTurn('live2', 1).catch((e) => String(e)),
      approvals: await backend.getApprovals('live2'),
      events,
    }, null, 2);
    try {
      await backend.sendMessage('live2', { runId: 'r1', seq: 1, role: 'user', content: 'Use the Bash tool to run exactly this command, nothing else: touch squad-live-marker.txt', harness: HARNESS });
      // Wait for the approval, or for the turn to end without one (then report what happened).
      await until(async () => {
        if ((await backend.getApprovals('live2')).some((a) => a.state === 'pending')) return true;
        const state = (await backend.getTurn('live2', 1)).state;
        if (state === 'completed' || state === 'failed' || state === 'cancelled') throw new Error(`turn ended (${state}) without an approval request:\n${await diagnose()}`);
        return false;
      }, 120_000).catch(async (err) => {
        throw new Error(`${err instanceof Error ? err.message : String(err)}\n${String(err).includes('turn ended') ? '' : await diagnose()}`);
      });
      const pending = (await backend.getApprovals('live2')).find((a) => a.state === 'pending')!;
      expect(pending.action).toMatch(/^Bash: /);
      expect(pending.action).toContain('touch');
      await backend.respondApproval('live2', { approvalId: pending.approvalId, hash: pending.hash, decision: 'deny', reason: 'live test denies tool use' });
      await harness.settled('live2', 'r1', 1);
      expect((await backend.getTurn('live2', 1)).state).toBe('cancelled'); // a broker deny ends the turn
      expect(fs.existsSync(marker), 'the denied command must not have run').toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);
});

describe.skipIf(!live)('claude-agent-sdk harness: live (real Agent SDK) golden trace', () => {
  /**
   * golden-trace.json (decoupling §14.4) on the real Claude harness: accept → a real tool approval → client
   * disconnect and reconnect from a cursor → approve (the approved command really runs) → cancel → cancelled.
   * Ids and the hash come from the harness rather than the fixture; the fixture's backend events must appear in
   * order among the real ones (a real harness adds messages and running states).
   */
  it('runs G1–G9 on claude-agent-sdk: approve after reconnect, then cancel', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const golden = JSON.parse(fs.readFileSync(path.resolve('test-fixtures/spec/suite-v0.2/golden-trace.json'), 'utf8')) as {
      conversationId: string; runId: string; expectedTerminalState: string; events: Array<Record<string, unknown> & { event: string }>;
    };
    const ev = (name: string) => golden.events.find((e) => e.event === name)!;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-claude-golden-'));
    const marker = path.join(cwd, 'squad-golden-marker.txt');
    const expectedApprovedAction = `Bash: ${GOLDEN_COMMAND}`;
    const guard = goldenToolGuard();
    const harness = new ClaudeAgentSdkHarness({
      cwd, maxTurns: 6,
      loadSdk: async () => {
        // A test-owned SDK wrapper must retain the real harness's API-only authentication guard.
        if (!claudeApiCredentialsConfigured()) throw new Error('golden trace needs API credentials, not a claude.ai login');
        const module = '@anthropic-ai/claude-agent-sdk';
        return guard.wrap(await import(module) as ClaudeAgentSdkModule);
      },
    });
    const registry = new DefaultHarnessRegistry();
    registry.register(harness);
    const state = new MemoryStateStore();
    const connect = () => new LocalSquadBackend({ state, harnesses: registry });
    let client = connect();
    const { conversationId, runId } = golden;
    const seq = ev('message.accepted')['turnSeq'] as number;
    try {
      await client.createConversation({ conversationId });
      const adm = await client.sendMessage(conversationId, {
        runId, seq, role: 'user', harness: HARNESS,
        content: `Use the Bash tool exactly once with timeout: ${GOLDEN_TOOL_TIMEOUT} and run_in_background: false. Run this single command exactly as written: ${GOLDEN_COMMAND}`,
      });
      expect(adm).toMatchObject({ runId, seq, duplicate: false });

      await until(async () => (await client.getApprovals(conversationId)).some((a) => a.state === 'pending'), 120_000);
      const requested = ev('approval.requested');
      const [v1] = await client.getApprovals(conversationId);
      expect(v1).toMatchObject({ version: requested['version'], state: requested['state'], scope: { kind: requested['scope'] } });
      expect(v1!.action).toBe(expectedApprovedAction);

      // client.disconnected: remember the cursor and drop the client; client.reconnected: resume from it
      const beforeDrop = await client.readEvents(conversationId);
      const cursorSequence = beforeDrop.events.at(-1)!.sequence!;
      client = connect();
      const resume = await client.readEvents(conversationId, { after: beforeDrop.nextCursor });
      expect(resume.resumable).toBe(ev('client.reconnected')['resumable']);
      expect(resume.lastAcceptedSeq).toBe(cursorSequence);
      expect(resume.events).toEqual([]);
      expect(resume.nextCursor).toBe(beforeDrop.nextCursor);
      const replayed = (await client.readEvents(conversationId)).events;
      expect(replayed.slice(0, beforeDrop.events.length)).toEqual(beforeDrop.events);
      expect(new Set(replayed.map((e) => e.id)).size).toBe(replayed.length);
      expect(await client.getApprovals(conversationId)).toEqual([v1]);

      const decided = ev('approval.resolved');
      const turn = await guard.approve(client, conversationId, v1!, decided['decision'] as 'approve');
      expect(turn.state).toBe('running');
      // One approved foreground command signals startup before its 60-second sleep.
      await until(() => fs.existsSync(marker), 10_000);
      expect((await client.getTurn(conversationId, seq)).state).toBe('running');
      expect(harness.activeTurns).toBe(1);

      await within((async () => {
        const cancelled = await client.cancelRun(conversationId, runId, ev('cancellation.requested')['reason'] as string);
        expect(cancelled.state).toBe(golden.expectedTerminalState);
        await harness.settled(conversationId, runId, seq);
      })(), 10_000);

      const allEvents = (await client.readEvents(conversationId)).events;
      expect(allEvents.slice(0, beforeDrop.events.length)).toEqual(beforeDrop.events);
      expect(new Set(allEvents.map((e) => e.id)).size).toBe(allEvents.length);
      const resumed = await client.readEvents(conversationId, { after: beforeDrop.nextCursor });
      expect(resumed.events.length).toBeGreaterThan(0);
      expect(resumed.events).toEqual(allEvents.filter((e) => e.sequence! > cursorSequence));
      expect(resumed.events.every((e) => e.sequence! > cursorSequence)).toBe(true);
      expect(resumed.lastAcceptedSeq).toBe(allEvents.at(-1)!.sequence);
      const history = allEvents.map((e) => e.type);
      const expected = golden.events.map((e) => e.event).filter((n) => !n.startsWith('client.'));
      let i = 0;
      for (const type of history) if (type === expected[i]) i++;
      expect(i, `golden events in order within: ${history.join(', ')}`).toBe(expected.length);
      const approvals = await client.getApprovals(conversationId);
      expect(approvals[0]).toMatchObject({ approvalId: v1!.approvalId, version: decided['version'], state: decided['state'], decision: 'approve' });
      expect((await client.getTurn(conversationId, seq)).state).toBe(golden.expectedTerminalState);
    } finally {
      await harness.cancel(conversationId, runId, seq);
      await harness.settled(conversationId, runId, seq);
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);
});

describe('claude-agent-sdk harness: state-mcp registration', () => {
  it('registers only when the SDK is installed, and SQUAD_BACKEND_HARNESSES=none turns it off', async () => {
    const { createLocalHarnesses } = await import('../packages/squad-cli/src/cli/core/backend-mcp.js');
    const key = { ANTHROPIC_API_KEY: 'test-key' };
    const yes = { claudeSdkAvailable: () => true };
    expect(createLocalHarnesses('/repo', key, yes).list().map((h) => h.id)).toEqual([HARNESS]);
    expect(createLocalHarnesses('/repo', key, { claudeSdkAvailable: () => false }).list()).toEqual([]);
    expect(createLocalHarnesses('/repo', {}, yes).list()).toEqual([]); // no API credential: never a claude.ai login
    expect(createLocalHarnesses('/repo', { CLAUDE_CODE_USE_BEDROCK: '1' }, yes).list().map((h) => h.id)).toEqual([HARNESS]);
    expect(createLocalHarnesses('/repo', { ...key, SQUAD_BACKEND_HARNESSES: 'none' }, yes).list()).toEqual([]);
    expect(createLocalHarnesses('/repo', { ...key, SQUAD_BACKEND_HARNESSES: 'other' }, yes).list()).toEqual([]);
    expect(createLocalHarnesses('/repo', { SQUAD_BACKEND_HARNESSES: 'copilot-sdk' }, yes).list().map((h) => h.id)).toEqual(['copilot-sdk']);
    expect(createLocalHarnesses('/repo', { ...key, SQUAD_BACKEND_HARNESSES: 'copilot-sdk, claude-agent-sdk' }, yes).list().map((h) => h.id)).toEqual([HARNESS, 'copilot-sdk']);
    expect(createLocalHarnesses('/repo', {}, { claudeSdkAvailable: () => false }).list()).toEqual([]); // copilot-sdk is never a default
  });

  it('createMcpBackend wires the registry into the local backend', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createMcpBackend } = await import('../packages/squad-cli/src/cli/core/backend-mcp.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-harness-reg-'));
    fs.mkdirSync(path.join(root, '.squad'));
    fs.writeFileSync(path.join(root, '.squad', 'team.md'), '# Team\n');
    try {
      let seenRoot = '';
      const { sdk } = replay({ text: 'via mcp' });
      const backend = createMcpBackend(root, {}, undefined, (repoRoot) => {
        seenRoot = repoRoot;
        const r = new DefaultHarnessRegistry();
        r.register(new ClaudeAgentSdkHarness({ cwd: repoRoot, loadSdk: async () => sdk }));
        return r;
      });
      expect(fs.realpathSync(seenRoot)).toBe(fs.realpathSync(root));
      expect((await backend.negotiate({ protocols: [BACKEND_PROTOCOL_VERSION] })).harnesses).toEqual([HARNESS]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
