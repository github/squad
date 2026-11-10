/**
 * `copilot-sdk` HarnessAdapter (#2441): Copilot-specific behaviour beyond the shared contract
 * (test/harness-contract.ts). Deterministic tests use a scripted Copilot client; the live test runs the real
 * Copilot SDK behind `SQUAD_REAL_CLI_TESTS=1` with a signed-in Copilot user.
 */
import { describe, it, expect } from 'vitest';
import {
  CopilotSdkHarness,
  DefaultHarnessRegistry,
  LocalSquadBackend,
  type CopilotClientLike,
  type CopilotPermissionResult,
  type CopilotSessionConfig,
  type CopilotSessionEvent,
} from '../packages/squad-sdk/src/backend/index.js';

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A Copilot client whose sessions run `turn` for every send. */
function client(turn: (ctx: {
  fire: (e: CopilotSessionEvent) => void;
  ask: (r: Parameters<CopilotSessionConfig['onPermissionRequest']>[0]) => Promise<CopilotPermissionResult>;
  aborted: () => boolean;
}) => Promise<void>) {
  const log = { created: 0, resumed: [] as string[], aborts: 0, decisions: [] as CopilotPermissionResult[], started: 0 };
  const c: CopilotClientLike = {
    async start() { log.started++; },
    async resumeSession(id, config) { log.resumed.push(id); return make(config, id); },
    async createSession(config) { log.created++; return make(config, `s-${log.created}`); },
  };
  function make(config: CopilotSessionConfig, id: string) {
    const handlers = new Set<(e: CopilotSessionEvent) => void>();
    let aborted = false;
    return {
      sessionId: id,
      on(h: (e: CopilotSessionEvent) => void) { handlers.add(h); return () => handlers.delete(h); },
      async abort() { aborted = true; log.aborts++; },
      async send() {
        const messageId = `msg-${++sent}`;
        handlers.forEach((h) => h({ type: 'user.message', data: { messageId } }));
        void turn({
          fire: (e) => handlers.forEach((h) => h(e)),
          ask: async (r) => { const d = await config.onPermissionRequest(r, { sessionId: id }); log.decisions.push(d); return d; },
          aborted: () => aborted,
        });
        return messageId;
      },
    };
  }
  let sent = 0;
  return { client: c, log };
}

async function setup(c: CopilotClientLike) {
  const harness = new CopilotSdkHarness({ cwd: process.cwd(), createClient: async () => c });
  const harnesses = new DefaultHarnessRegistry();
  harnesses.register(harness);
  const backend = new LocalSquadBackend({ harnesses });
  await backend.createConversation({ conversationId: 'c' });
  const send = (runId: string, seq: number, content = `task ${seq}`) =>
    backend.sendMessage('c', { runId, seq, role: 'user', content, harness: 'copilot-sdk' });
  return { harness, backend, send };
}

describe('copilot-sdk harness', () => {
  it('reuses one Copilot session per conversation and starts the client once', async () => {
    const { client: c, log } = client(async ({ fire }) => { fire({ type: 'assistant.message', data: { content: 'hi' } }); fire({ type: 'session.idle' }); });
    const { harness, backend, send } = await setup(c);
    await send('r1', 1);
    await harness.settled('c', 'r1', 1);
    await send('r2', 2);
    await harness.settled('c', 'r2', 2);
    expect(log).toMatchObject({ created: 1, started: 1, resumed: [] });
    expect((await backend.getTranscript('c')).filter((m) => m.role === 'assistant')).toHaveLength(2);
  });

  it('keeps sub-agent output out of the transcript', async () => {
    const { client: c } = client(async ({ fire }) => {
      fire({ type: 'assistant.message', agentId: 'sub-1', data: { content: 'sub-agent chatter' } });
      fire({ type: 'assistant.message', data: { content: 'tool-call narration', parentToolCallId: 'call_9' } });
      fire({ type: 'assistant.message', data: { content: 'final answer' } });
      fire({ type: 'session.idle' });
    });
    const { harness, backend, send } = await setup(c);
    await send('r1', 1);
    await harness.settled('c', 'r1', 1);
    expect((await backend.getTranscript('c')).map((m) => m.content)).toEqual(['task 1', 'final answer']);
  });

  it('answers approve-once on approve and reject (plus abort) on deny', async () => {
    const { client: c, log } = client(async ({ fire, ask, aborted }) => {
      const d = await ask({ kind: 'write', toolCallId: 'call_w', fileName: 'src/a.ts' });
      if (d.kind === 'approve-once') await ask({ kind: 'shell', toolCallId: 'call_s', fullCommandText: 'rm -rf dist' });
      if (!aborted()) fire({ type: 'assistant.message', data: { content: 'done' } });
      fire({ type: 'session.idle' });
    });
    const { harness, backend, send } = await setup(c);
    await send('r1', 1);
    await until(async () => (await backend.getApprovals('c')).length === 1);
    const [w] = await backend.getApprovals('c');
    expect(w).toMatchObject({ approvalId: 'call_w', action: 'write: src/a.ts' });
    await backend.respondApproval('c', { approvalId: 'call_w', hash: w!.hash, decision: 'approve' });
    await until(async () => (await backend.getApprovals('c')).length === 2);
    const s = (await backend.getApprovals('c'))[1]!;
    expect(s.action).toBe('shell: rm -rf dist');
    await backend.respondApproval('c', { approvalId: 'call_s', hash: s.hash, decision: 'deny', reason: 'not that' });
    await harness.settled('c', 'r1', 1);
    expect(log.decisions).toEqual([{ kind: 'approve-once' }, { kind: 'reject', feedback: 'not that' }]);
    expect(log.aborts).toBe(1);
    expect((await backend.getTurn('c', 1)).state).toBe('cancelled');
  });

  it('gives a request without a toolCallId its own approval id', async () => {
    const { client: c } = client(async ({ fire, ask }) => { await ask({ kind: 'url', url: 'https://example.com' }); fire({ type: 'session.idle' }); });
    const { harness, backend, send } = await setup(c);
    await send('r1', 1);
    await until(async () => (await backend.getApprovals('c')).length === 1);
    const [a] = await backend.getApprovals('c');
    expect(a!.approvalId).toMatch(/^copilot-[0-9a-f-]{36}$/);
    await backend.respondApproval('c', { approvalId: a!.approvalId, hash: a!.hash, decision: 'approve' });
    await harness.settled('c', 'r1', 1);
    expect((await backend.getTurn('c', 1)).state).toBe('completed');
  });

  it('a session.error fails the turn with its message', async () => {
    const { client: c } = client(async ({ fire }) => fire({ type: 'session.error', data: { errorType: 'quota', message: 'Rate limit exceeded' } }));
    const { harness, backend, send } = await setup(c);
    await send('r1', 1);
    await harness.settled('c', 'r1', 1);
    expect(await backend.getTurn('c', 1)).toMatchObject({ state: 'failed', error: 'Rate limit exceeded' });
  });

  it('cancel aborts the session without waiting for session.idle', async () => {
    const { client: c, log } = client(async ({ ask }) => { await ask({ kind: 'shell', toolCallId: 'call_x', fullCommandText: 'sleep 99' }); /* never idles */ });
    const { harness, backend, send } = await setup(c);
    await send('r1', 1);
    await until(async () => (await backend.getApprovals('c')).length === 1);
    await backend.cancelTurn('c', 1);
    await harness.cancel('c', 'r1', 1);
    await harness.settled('c', 'r1', 1);
    expect(log.aborts).toBe(1);
    expect((await backend.getTurn('c', 1)).state).toBe('cancelled');
  });

  it('a client that cannot start fails the delivery, so the broker retries', async () => {
    const harness = new CopilotSdkHarness({ cwd: '.', createClient: async () => { throw new Error('not signed in'); } });
    await expect(harness.submit({ conversationId: 'c', runId: 'r1', seq: 1, messages: [] })).rejects.toThrow(/could not start the Copilot client: not signed in/);
  });

  it('passes a harness-only configDirectory to every session, and none by default', async () => {
    const seen: Array<string | undefined> = [];
    const make = (configDirectory?: string) => new CopilotSdkHarness({
      cwd: '.', ...(configDirectory ? { configDirectory } : {}),
      createClient: async () => ({
        async start() {},
        async resumeSession(_id, config) { return this.createSession(config); },
        async createSession(config) {
          seen.push(config.configDirectory);
          let emit: (e: CopilotSessionEvent) => void = () => undefined;
          return { sessionId: 's', on(h) { emit = h; return () => undefined; }, async abort() {}, async send() { setTimeout(() => { emit({ type: 'user.message', data: { messageId: 'm' } }); emit({ type: 'session.idle' }); }, 0); return 'm'; } };
        },
      }),
    });
    for (const h of [make('/tmp/squad-copilot-harness'), make()]) {
      await h.submit({ conversationId: 'c', runId: 'r1', seq: 1, messages: [{ runId: 'r1', seq: 1, role: 'user', content: 'x' }] });
      await h.settled('c', 'r1', 1);
    }
    expect(seen).toEqual(['/tmp/squad-copilot-harness', undefined]);
  });

  it('describes itself for capability negotiation', () => {
    expect(new CopilotSdkHarness({ cwd: '.' }).describe()).toMatchObject({ id: 'copilot-sdk', capabilities: { approvals: true, extensionNamespaces: ['x-copilot'] } });
  });
});

describe.skipIf(process.env['SQUAD_REAL_CLI_TESTS'] !== '1')('copilot-sdk harness: live (real Copilot SDK)', () => {
  /** One plain turn through the broker; a short timeout so a correlation miss fails fast instead of hanging. */
  async function liveTurn(extra: Partial<ConstructorParameters<typeof CopilotSdkHarness>[0]> = {}) {
    const harness = new CopilotSdkHarness({ cwd: process.cwd(), turnTimeoutMs: 120_000, ...extra });
    const harnesses = new DefaultHarnessRegistry();
    harnesses.register(harness);
    const backend = new LocalSquadBackend({ harnesses });
    await backend.createConversation({ conversationId: 'live' });
    await backend.sendMessage('live', { runId: 'r1', seq: 1, role: 'user', content: 'Reply with exactly the word: pong', harness: 'copilot-sdk' });
    await harness.settled('live', 'r1', 1);
    const turn = await backend.getTurn('live', 1);
    expect(turn.error).toBeUndefined();
    expect(turn.state).toBe('completed');
    expect((await backend.getTranscript('live')).at(-1)?.content.toLowerCase()).toContain('pong');
  }

  it('completes a turn through the broker', async () => {
    await liveTurn();
  }, 180_000);

  it('completes a turn with a harness-only Copilot config directory (login still works)', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-copilot-config-'));
    try {
      await liveTurn({ configDirectory });
    } finally {
      fs.rmSync(configDirectory, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('copilot-sdk harness: review regressions (#2451)', () => {
  /** A client whose session creation and abort the test controls, recording every send. */
  function controlled() {
    let releaseCreate!: () => void;
    const created = new Promise<void>((r) => (releaseCreate = r));
    let releaseAbort!: () => void;
    let abortHeld = false;
    const sends: string[] = [];
    let fire: (e: CopilotSessionEvent) => void = () => undefined;
    const c: CopilotClientLike = {
      async start() {},
      async resumeSession(id, config) { return c.createSession(config); },
      async createSession() {
        await created;
        const handlers = new Set<(e: CopilotSessionEvent) => void>();
        fire = (e) => handlers.forEach((h) => h(e));
        return {
          sessionId: 's-1',
          on(h: (e: CopilotSessionEvent) => void) { handlers.add(h); return () => handlers.delete(h); },
          async send(prompt: string) { sends.push(prompt); const messageId = `m-${sends.length}`; queueMicrotask(() => fire({ type: 'user.message', data: { messageId } })); return messageId; },
          async abort() { if (abortHeld) await new Promise<void>((r) => (releaseAbort = r)); },
        };
      },
    };
    return {
      client: c, sends, releaseCreate,
      holdAbort: () => { abortHeld = true; },
      releaseAbort: () => releaseAbort(),
      fire: (e: CopilotSessionEvent) => fire(e),
    };
  }

  it('a cancel while the session is being created never reaches send()', async () => {
    const k = controlled();
    const { harness, backend, send } = await setup(k.client);
    await send('r1', 1);
    await new Promise((r) => setTimeout(r, 5));
    await backend.cancelTurn('c', 1);
    await harness.cancel('c', 'r1', 1);
    k.releaseCreate();
    await harness.settled('c', 'r1', 1);
    expect(k.sends).toEqual([]);
    expect((await backend.getTurn('c', 1)).state).toBe('cancelled');
  });

  it('the next turn waits for a slow abort, and late events from the aborted turn are not attributed to it', async () => {
    const k = controlled();
    k.releaseCreate();
    const { harness, backend, send } = await setup(k.client);
    await send('r1', 1, 'first');
    await until(() => k.sends.length === 1);
    await send('r2', 2, 'second');
    k.holdAbort();
    await backend.cancelTurn('c', 1);
    const cancelling = harness.cancel('c', 'r1', 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(k.sends).toEqual(['first']); // r2 must not start while r1 is still aborting
    k.fire({ type: 'assistant.message', data: { content: 'late answer from r1' } });
    k.fire({ type: 'session.idle' });
    k.releaseAbort();
    await cancelling;
    await until(() => k.sends.length === 2);
    k.fire({ type: 'assistant.message', data: { content: 'answer for r2' } });
    k.fire({ type: 'session.idle' });
    await harness.settled('c', 'r2', 2);
    const turn2 = await backend.getTurn('c', 2);
    expect(turn2.state).toBe('completed');
    expect(turn2.messages.map((m) => m.content)).toEqual(['second', 'answer for r2']);
    expect((await backend.getTranscript('c')).map((m) => m.content)).not.toContain('late answer from r1');
  });

  for (const childEvent of [{ type: 'session.idle' }, { type: 'session.error', data: { message: 'child failed' } }] as CopilotSessionEvent[]) {
    it(`a sub-agent's ${childEvent.type} does not end the main turn`, async () => {
      const { client: c } = client(async ({ fire }) => {
        fire({ ...childEvent, agentId: 'child-agent' });
        await new Promise((r) => setTimeout(r, 10));
        fire({ type: 'assistant.message', data: { content: 'main answer' } });
        fire({ type: 'session.idle' });
      });
      const { harness, backend, send } = await setup(c);
      await send('r1', 1);
      await harness.settled('c', 'r1', 1);
      expect((await backend.getTurn('c', 1)).state).toBe('completed');
      expect((await backend.getTranscript('c')).at(-1)?.content).toBe('main answer');
    });
  }
});
