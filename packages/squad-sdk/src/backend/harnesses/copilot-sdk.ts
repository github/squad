/**
 * `copilot-sdk` HarnessAdapter (#2441): runs admitted turns on the GitHub Copilot SDK (`@github/copilot-sdk`).
 *
 * Mapping (harness-adapters §5, backend `types.ts`):
 * - One Copilot session per conversation, created on the first turn and reused (or resumed by id) for
 *   later turns. A turn is `send()` followed by waiting for `session.idle` (completed) or `session.error`
 *   (failed). Submissions are deduplicated by `operationId` (or `(conversationId, runId, seq)`).
 * - Main-agent `assistant.message` content becomes `message` events; sub-agent output stays out of the
 *   transcript.
 * - `onPermissionRequest` → `approval-requested` through the shared {@link TurnApprovals} queue (one pending
 *   per turn, hash-bound, a deny ends the turn). `approvalId` is the request's `toolCallId` when present.
 *   Approve answers `approve-once`; deny answers `reject` and aborts the session's turn.
 * - `cancel` aborts the turn; queued approvals resolve as denied.
 *
 * Like `claude-agent-sdk`, a pending approval lives in process memory and is lost if the harness restarts.
 */
import { randomUUID } from 'node:crypto';
import type {
  ApprovalResponse,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessDescriptor,
  HarnessEventEnvelope,
  HarnessSubmission,
  LeaseEpoch,
} from '../types.js';
import { partsToText } from '../types.js';
import { TurnApprovals } from './approval-queue.js';

export const COPILOT_SDK_HARNESS_ID = 'copilot-sdk';

// ── The slice of the Copilot SDK this adapter uses ──────────────────────────────────────────────

export interface CopilotPermissionRequest {
  kind: string;
  toolCallId?: string;
  [field: string]: unknown;
}

export type CopilotPermissionResult = { kind: 'approve-once' } | { kind: 'reject'; feedback?: string };

export interface CopilotSessionEvent {
  type: string;
  agentId?: string;
  data?: { content?: string; parentToolCallId?: string; message?: string; errorType?: string };
}

export interface CopilotSessionLike {
  readonly sessionId: string;
  send(prompt: string): Promise<string>;
  on(handler: (event: CopilotSessionEvent) => void): () => void;
  abort(): Promise<void>;
}

export interface CopilotSessionConfig {
  workingDirectory?: string;
  model?: string;
  onPermissionRequest: (request: CopilotPermissionRequest, invocation: { sessionId: string }) => Promise<CopilotPermissionResult>;
}

export interface CopilotClientLike {
  start(): Promise<void>;
  createSession(config: CopilotSessionConfig): Promise<CopilotSessionLike>;
  resumeSession(sessionId: string, config: CopilotSessionConfig): Promise<CopilotSessionLike>;
}

export interface CopilotSdkHarnessOptions {
  /** Working directory for every session (the repository root). */
  cwd: string;
  model?: string;
  /** Builds the client. Defaults to `new CopilotClient({ workingDirectory: cwd })` from `@github/copilot-sdk`. */
  createClient?: () => Promise<CopilotClientLike>;
}

interface Run {
  conversationId: string;
  runId: string;
  seq: number;
  epoch?: LeaseEpoch;
  cancelled: boolean;
  approvals: TurnApprovals;
  done: Promise<void>;
  /** Ends the wait for `session.idle` (cancel doesn't rely on the runtime sending one after abort). */
  wake?: () => void;
}

/** A short, readable description of a permission request for the broker's approval record. */
function describeRequest(r: CopilotPermissionRequest): string {
  const detail = r['fullCommandText'] ?? r['fileName'] ?? r['path'] ?? r['url'] ?? r['toolName'] ?? '';
  return `${r.kind}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`;
}

export class CopilotSdkHarness implements HarnessAdapter {
  readonly id = COPILOT_SDK_HARNESS_ID;
  readonly capabilities: HarnessCapabilities = {
    streaming: true,
    approvals: true,
    cancellation: true,
    tools: true,
    extensionNamespaces: ['x-copilot'],
  };

  private readonly listeners = new Map<string, Set<(e: HarnessEventEnvelope) => void>>();
  private readonly seen = new Set<string>();
  private readonly runs = new Map<string, Run>();
  /** The live session per conversation, and the session id to resume when the object is gone. */
  private readonly sessions = new Map<string, Promise<CopilotSessionLike>>();
  private readonly sessionIds = new Map<string, string>();
  /** The run currently executing per conversation (permission requests are routed to it). */
  private readonly active = new Map<string, Run>();
  private readonly tails = new Map<string, Promise<void>>();
  private client?: Promise<CopilotClientLike>;

  constructor(private readonly options: CopilotSdkHarnessOptions) {}

  describe(): HarnessDescriptor {
    return { id: this.id, displayName: 'GitHub Copilot SDK', capabilities: this.capabilities };
  }

  subscribe(conversationId: string, listener: (event: HarnessEventEnvelope) => void): () => void {
    let set = this.listeners.get(conversationId);
    if (!set) this.listeners.set(conversationId, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }

  async submit(submission: HarnessSubmission): Promise<void> {
    const key = submission.operationId ?? `${submission.conversationId}:${submission.runId}:${submission.seq}`;
    if (this.seen.has(key)) return;
    await this.getClient(); // a client that can't start fails the delivery, so the broker retries
    this.seen.add(key);
    const run: Run = {
      conversationId: submission.conversationId,
      runId: submission.runId,
      seq: submission.seq,
      epoch: submission.epoch,
      cancelled: false,
      approvals: undefined as unknown as TurnApprovals,
      done: Promise.resolve(),
    };
    run.approvals = new TurnApprovals(
      run.seq,
      (request) => this.emit(run, { type: 'approval-requested', request }),
      () => this.emit(run, { type: 'state', state: 'running' }),
      () => void this.stop(run),
    );
    this.runs.set(this.runKey(run.conversationId, run.runId, run.seq), run);
    const prompt = submission.messages
      .filter((m) => m.role === 'user')
      .map((m) => (m.parts?.length ? partsToText(m.parts) : m.content))
      .join('\n\n');
    const previous = this.tails.get(run.conversationId) ?? Promise.resolve();
    run.done = previous.then(() => this.execute(run, prompt));
    this.tails.set(run.conversationId, run.done.catch(() => undefined));
  }

  async cancel(conversationId: string, runId: string, seq: number): Promise<void> {
    const run = this.runs.get(this.runKey(conversationId, runId, seq));
    if (!run || run.cancelled) return;
    await this.stop(run);
  }

  async respondApproval(_conversationId: string, response: ApprovalResponse): Promise<void> {
    for (const run of this.runs.values()) if (run.approvals.respond(response)) return;
    // Unknown or already decided: a redelivered decision is a no-op.
  }

  /** Waits for a submitted turn to finish (tests and orderly shutdown). */
  async settled(conversationId: string, runId: string, seq: number): Promise<void> {
    await this.runs.get(this.runKey(conversationId, runId, seq))?.done.catch(() => undefined);
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────

  private runKey(conversationId: string, runId: string, seq: number): string {
    return `${conversationId}\u0000${runId}\u0000${seq}`;
  }

  private getClient(): Promise<CopilotClientLike> {
    this.client ??= (async () => {
      const client = this.options.createClient
        ? await this.options.createClient()
        : (new (await import('@github/copilot-sdk')).CopilotClient({ workingDirectory: this.options.cwd }) as unknown as CopilotClientLike);
      await client.start();
      return client;
    })().catch((err) => {
      this.client = undefined;
      throw new Error(`The ${COPILOT_SDK_HARNESS_ID} harness could not start the Copilot client: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.client;
  }

  private sessionConfig(conversationId: string): CopilotSessionConfig {
    return {
      workingDirectory: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      onPermissionRequest: async (request) => {
        const run = this.active.get(conversationId);
        if (!run) return { kind: 'reject', feedback: 'No Squad turn is running' };
        const { kind, toolCallId, ...detail } = request;
        const outcome = await run.approvals.request(toolCallId ?? `copilot-${randomUUID()}`, describeRequest(request), { kind, ...detail });
        return outcome.approved ? { kind: 'approve-once' } : { kind: 'reject', feedback: outcome.reason };
      },
    };
  }

  private session(conversationId: string): Promise<CopilotSessionLike> {
    let s = this.sessions.get(conversationId);
    if (!s) {
      s = (async () => {
        const client = await this.getClient();
        const id = this.sessionIds.get(conversationId);
        const session = id
          ? await client.resumeSession(id, this.sessionConfig(conversationId))
          : await client.createSession(this.sessionConfig(conversationId));
        this.sessionIds.set(conversationId, session.sessionId);
        return session;
      })();
      this.sessions.set(conversationId, s);
      s.catch(() => this.sessions.delete(conversationId));
    }
    return s;
  }

  private emit(run: Run, event: Record<string, unknown>): void {
    const envelope = { ...event, runId: run.runId, seq: run.seq, ...(run.epoch !== undefined ? { epoch: run.epoch } : {}) } as HarnessEventEnvelope;
    for (const l of this.listeners.get(run.conversationId) ?? []) l(envelope);
  }

  private async stop(run: Run): Promise<void> {
    run.cancelled = true;
    run.approvals.close('Turn cancelled');
    run.wake?.();
    if (this.active.get(run.conversationId) === run) {
      const session = await this.sessions.get(run.conversationId)?.catch(() => undefined);
      await session?.abort().catch(() => undefined);
    }
  }

  private async execute(run: Run, prompt: string): Promise<void> {
    if (run.cancelled) {
      this.emit(run, { type: 'state', state: 'cancelled' });
      return;
    }
    this.emit(run, { type: 'state', state: 'running' });
    this.active.set(run.conversationId, run);
    let off: (() => void) | undefined;
    try {
      const session = await this.session(run.conversationId);
      const finished = new Promise<string | undefined>((resolve) => {
        run.wake = () => resolve(undefined);
        off = session.on((event) => {
          if (event.type === 'assistant.message' && !event.agentId && !event.data?.parentToolCallId && event.data?.content) {
            this.emit(run, { type: 'message', message: { runId: run.runId, seq: run.seq, role: 'assistant', content: event.data.content } });
          } else if (event.type === 'session.idle') {
            resolve(undefined);
          } else if (event.type === 'session.error') {
            resolve(event.data?.message || event.data?.errorType || 'Copilot session error');
          }
        });
      });
      await session.send(prompt);
      const failure = await finished;
      if (run.cancelled) this.emit(run, { type: 'state', state: 'cancelled' });
      else if (failure) this.emit(run, { type: 'state', state: 'failed', error: failure.slice(0, 500) });
      else this.emit(run, { type: 'state', state: 'completed' });
    } catch (err) {
      if (run.cancelled) this.emit(run, { type: 'state', state: 'cancelled' });
      else this.emit(run, { type: 'state', state: 'failed', error: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
    } finally {
      off?.();
      run.approvals.close('Turn ended');
      if (this.active.get(run.conversationId) === run) this.active.delete(run.conversationId);
    }
  }
}
