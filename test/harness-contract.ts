/**
 * Shared HarnessAdapter contract (harness-adapters §5 SPI; §15 promotion criteria 1, 3 and 5).
 *
 * Every harness runs the same assertions through the real LocalSquadBackend. A harness supplies a driver
 * that builds an adapter whose model/tool behaviour is scripted (no network), so the protocol is checked
 * deterministically: dedupe, event identity, approvals (hash binding, replay, one at a time), cancel.
 */
import { describe, it, expect } from 'vitest';
import {
  DefaultHarnessRegistry,
  LocalSquadBackend,
  type HarnessAdapter,
  type HarnessEventEnvelope,
} from '../packages/squad-sdk/src/backend/index.js';

export interface ContractToolCall { name: string; input: Record<string, unknown> }

export interface HarnessContractDriver {
  /** Harness under test, scripted to answer `reply` and to request approval for each of `tools`, in parallel. */
  create(script: { reply: string; tools?: ContractToolCall[] }): HarnessAdapter;
  /** Wait until the harness has finished the turn. */
  settled(harness: HarnessAdapter, conversationId: string, runId: string, seq: number): Promise<void>;
}

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function harnessContract(name: string, driver: HarnessContractDriver): void {
  async function setup(script: { reply: string; tools?: ContractToolCall[] }) {
    const harness = driver.create(script);
    const harnesses = new DefaultHarnessRegistry();
    harnesses.register(harness);
    const backend = new LocalSquadBackend({ harnesses });
    await backend.createConversation({ conversationId: 'k' });
    const events: HarnessEventEnvelope[] = [];
    harness.subscribe('k', (e) => events.push(e));
    const send = (runId: string, seq: number) =>
      backend.sendMessage('k', { runId, seq, role: 'user', content: `task ${seq}`, harness: harness.id });
    const settled = (runId: string, seq: number) => driver.settled(harness, 'k', runId, seq);
    return { harness, backend, events, send, settled };
  }

  describe(`HarnessAdapter contract: ${name}`, () => {
    it('describes itself consistently', () => {
      const h = driver.create({ reply: 'x' });
      expect(h.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(h.describe()).toMatchObject({ id: h.id, capabilities: h.capabilities });
      for (const ns of h.capabilities.extensionNamespaces) expect(ns).toMatch(/^x-[a-z]/);
    });

    it('completes a turn, and every event echoes the turn identity and epoch', async () => {
      const { backend, events, send, settled } = await setup({ reply: 'contract reply' });
      const admission = await send('r1', 1);
      await settled('r1', 1);
      expect((await backend.getTurn('k', 1)).state).toBe('completed');
      expect((await backend.getTranscript('k')).map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(events.length).toBeGreaterThan(0);
      for (const e of events) expect(e).toMatchObject({ runId: 'r1', seq: 1, epoch: admission.epoch });
      expect(events.filter((e) => e.type === 'state').at(-1)).toMatchObject({ state: 'completed' });
    });

    it('treats a redelivered submission as a no-op', async () => {
      const harness = driver.create({ reply: 'once' });
      const events: HarnessEventEnvelope[] = [];
      harness.subscribe('k', (e) => events.push(e));
      const s = { conversationId: 'k', runId: 'r1', seq: 1, operationId: 'k:r1:1', messages: [{ runId: 'r1', seq: 1, role: 'user' as const, content: 'x' }] };
      await harness.submit(s);
      await harness.submit(s);
      await driver.settled(harness, 'k', 'r1', 1);
      expect(events.filter((e) => e.type === 'message')).toHaveLength(1);
    });

    it('binds an approval to its hash, honours approve, and ignores a replayed decision', async () => {
      const { harness, backend, send, settled } = await setup({ reply: 'after tool', tools: [{ name: 'Bash', input: { command: 'echo ok' } }] });
      await send('r1', 1);
      await until(async () => (await backend.getApprovals('k')).length === 1);
      const [a] = await backend.getApprovals('k');
      expect(a!.hash).toBeTruthy();
      await expect(harness.respondApproval('k', { approvalId: a!.approvalId, hash: `${a!.hash}-forged`, decision: 'approve' })).rejects.toThrow();
      await backend.respondApproval('k', { approvalId: a!.approvalId, hash: a!.hash, decision: 'approve' });
      await harness.respondApproval('k', { approvalId: a!.approvalId, hash: a!.hash, decision: 'deny' }, 'replay');
      await settled('r1', 1);
      expect((await backend.getTurn('k', 1)).state).toBe('completed');
    });

    it('offers one approval at a time, and a deny ends the turn', async () => {
      const tools = [{ name: 'Bash', input: { command: 'a' } }, { name: 'Bash', input: { command: 'b' } }];
      const { backend, send, settled } = await setup({ reply: 'never', tools });
      await send('r1', 1);
      await until(async () => (await backend.getApprovals('k')).length === 1);
      await new Promise((r) => setTimeout(r, 20));
      const pending = await backend.getApprovals('k');
      expect(pending).toHaveLength(1);
      await backend.respondApproval('k', { approvalId: pending[0]!.approvalId, hash: pending[0]!.hash, decision: 'deny' });
      await settled('r1', 1);
      expect((await backend.getTurn('k', 1)).state).toBe('cancelled');
      expect(await backend.getApprovals('k')).toHaveLength(1);
    });

    it('cancels idempotently', async () => {
      const { harness, backend, send, settled } = await setup({ reply: 'never', tools: [{ name: 'Bash', input: { command: 'sleep' } }] });
      await send('r1', 1);
      await until(async () => (await backend.getApprovals('k')).length === 1);
      await backend.cancelTurn('k', 1);
      await harness.cancel('k', 'r1', 1);
      await harness.cancel('k', 'r1', 1);
      await settled('r1', 1);
      expect((await backend.getTurn('k', 1)).state).toBe('cancelled');
    });
  });
}
