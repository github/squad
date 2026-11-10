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
import type { HarnessCapabilities } from '../types.js';
import { summarizeAction } from './approval-queue.js';
import { TurnHarness, type TurnRun } from './turn-harness.js';

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

/** The most telling field of a permission request, for the approval summary (the full request stays in the hash). */
function requestDetail(r: CopilotPermissionRequest): unknown {
  return r['fullCommandText'] ?? r['fileName'] ?? r['path'] ?? r['url'] ?? r['toolName'];
}

export class CopilotSdkHarness extends TurnHarness {
  readonly id = COPILOT_SDK_HARNESS_ID;
  readonly capabilities: HarnessCapabilities = {
    streaming: true,
    approvals: true,
    cancellation: true,
    tools: true,
    extensionNamespaces: ['x-copilot'],
  };
  protected readonly displayName = 'GitHub Copilot SDK';

  /** The live session per conversation, and the session id to resume when the object is gone. */
  private readonly sessions = new Map<string, Promise<CopilotSessionLike>>();
  private readonly sessionIds = new Map<string, string>();
  /** Sessions that finished creating (only these can be aborted). */
  private readonly ready = new Map<string, CopilotSessionLike>();
  /** The run currently executing per conversation (permission requests are routed to it). */
  private readonly active = new Map<string, TurnRun>();
  private client?: Promise<CopilotClientLike>;

  constructor(private readonly options: CopilotSdkHarnessOptions) {
    super();
  }

  protected async init(): Promise<void> {
    await this.getClient();
  }

  /** Abort the session's turn and wait for the runtime to acknowledge it; the next turn waits on this. */
  protected async interrupt(run: TurnRun): Promise<void> {
    if (this.active.get(run.conversationId) !== run) return;
    // A session still being created has nothing to abort; runTurn's checkpoint keeps the turn from sending.
    await this.ready.get(run.conversationId)?.abort();
  }

  protected async runTurn(run: TurnRun, prompt: string): Promise<string | undefined> {
    this.active.set(run.conversationId, run);
    let off: (() => void) | undefined;
    try {
      const session = await this.session(run.conversationId);
      this.checkpoint(run); // a cancel during session creation never reaches send()
      const finished = new Promise<string | undefined>((resolve) => {
        // Cancel ends the wait without relying on an idle event after abort.
        if (run.abort.signal.aborted) resolve(undefined);
        run.abort.signal.addEventListener('abort', () => resolve(undefined), { once: true });
        off = session.on((event) => {
          // Sub-agent events (agentId) never complete or fail the main turn, and stay out of the transcript.
          if (event.agentId) return;
          if (event.type === 'assistant.message' && !event.data?.parentToolCallId && event.data?.content) {
            this.emit(run, { type: 'message', message: { runId: run.runId, seq: run.seq, role: 'assistant', content: event.data.content } });
          } else if (event.type === 'session.idle') {
            resolve(undefined);
          } else if (event.type === 'session.error') {
            resolve(event.data?.message || event.data?.errorType || 'Copilot session error');
          }
        });
      });
      await session.send(prompt);
      return await finished;
    } finally {
      off?.();
      if (this.active.get(run.conversationId) === run) this.active.delete(run.conversationId);
    }
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
        const outcome = await run.approvals.request(toolCallId ?? `copilot-${randomUUID()}`, summarizeAction(kind, requestDetail(request)), { kind, ...detail });
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
        this.ready.set(conversationId, session);
        return session;
      })();
      this.sessions.set(conversationId, s);
      s.catch(() => this.sessions.delete(conversationId));
    }
    return s;
  }
}
