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
 *   per turn, hash-bound, a deny ends the turn). `approvalId` is the request's `toolCallId` (with `#2`, `#3` …
 *   when one tool call asks for several permissions).
 * - A turn only reacts to events after its own `user.message` (matched to the id `send()` returns), so a late idle
 *   or answer from an aborted turn can't complete or join the next one. A session whose turn failed to send, failed
 *   to interrupt or timed out is dropped and resumed fresh for the next turn.
 *   Approve answers `approve-once`; deny answers `reject` and aborts the session's turn.
 * - `cancel` aborts the turn; queued approvals resolve as denied.
 *
 * Like `claude-agent-sdk`, a pending approval lives in process memory and is lost if the harness restarts.
 */
import { randomUUID } from 'node:crypto';
import type { HarnessCapabilities } from '../types.js';
import { summarizeAction } from './approval-queue.js';
import { HarnessState } from './harness-state.js';
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
  data?: { content?: string; parentToolCallId?: string; message?: string; errorType?: string; messageId?: string };
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
  configDirectory?: string;
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
  /**
   * Copilot config directory for harness sessions. The runtime can remember approvals across sessions there
   * ("approve permanently", URL prompts only), so a session sharing the user's default directory may fetch a
   * URL the user once approved in their own Copilot CLI without the broker being asked. Point this at a
   * harness-only directory to rule that out. The harness itself only ever answers `approve-once`.
   */
  configDirectory?: string;
  /** Where accepted deliveries and session ids survive restarts (see HarnessState). In-memory when unset. */
  stateDir?: string;
  /** A turn with no terminal event after this long fails and its session is dropped (default 30 minutes). */
  turnTimeoutMs?: number;
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
  /** Sessions that finished creating (only these can be aborted). */
  private readonly ready = new Map<string, CopilotSessionLike>();
  /** The run currently executing per conversation (permission requests are routed to it). */
  private readonly active = new Map<string, TurnRun>();
  private client?: Promise<CopilotClientLike>;

  constructor(private readonly options: CopilotSdkHarnessOptions) {
    super(new HarnessState(options.stateDir));
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

  protected override interruptFailed(run: TurnRun): void {
    this.dropSession(run.conversationId); // it may still be busy; resume a fresh session next time
  }

  protected async runTurn(run: TurnRun, prompt: string): Promise<string | undefined> {
    this.active.set(run.conversationId, run);
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const session = await this.session(run.conversationId);
      this.checkpoint(run); // a cancel during session creation never reaches send()
      let myMessageId: string | undefined;
      let started = false;
      const early: CopilotSessionEvent[] = [];
      let resolveFinished!: (failure: string | undefined) => void;
      const finished = new Promise<string | undefined>((resolve) => (resolveFinished = resolve));
      // Cancel ends the wait without relying on an idle event after abort.
      if (run.abort.signal.aborted) resolveFinished(undefined);
      run.abort.signal.addEventListener('abort', () => resolveFinished(undefined), { once: true });
      const handle = (event: CopilotSessionEvent) => {
        if (event.type === 'assistant.message' && !event.data?.parentToolCallId && event.data?.content) {
          this.emit(run, { type: 'message', message: { runId: run.runId, seq: run.seq, role: 'assistant', content: event.data.content } });
        } else if (event.type === 'session.idle') {
          resolveFinished(undefined);
        } else if (event.type === 'session.error') {
          resolveFinished(event.data?.message || event.data?.errorType || 'Copilot session error');
        }
      };
      /** Start at our own user.message; events before it belong to an earlier (possibly aborted) turn. */
      const tryStart = () => {
        if (started || myMessageId === undefined) return;
        const i = early.findIndex((e) => e.type === 'user.message' && (e.data?.messageId === myMessageId || e.data?.messageId === undefined));
        if (i === -1) return;
        started = true;
        for (const e of early.splice(0).slice(i + 1)) handle(e);
      };
      off = session.on((event) => {
        // Sub-agent events (agentId) never complete or fail the main turn, and stay out of the transcript.
        if (event.agentId) return;
        if (started) return handle(event);
        early.push(event);
        tryStart();
      });
      try {
        myMessageId = await session.send(prompt);
      } catch (err) {
        this.dropSession(run.conversationId); // a failed send may mean a dead transport: resume fresh next time
        throw err;
      }
      tryStart();
      const timeoutMs = this.options.turnTimeoutMs ?? 30 * 60_000;
      const timedOut = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(`Copilot turn timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
      });
      const failure = await Promise.race([finished, timedOut]);
      if (failure?.startsWith('Copilot turn timed out')) this.dropSession(run.conversationId);
      return failure;
    } finally {
      if (timer) clearTimeout(timer);
      off?.();
      if (this.active.get(run.conversationId) === run) this.active.delete(run.conversationId);
    }
  }

  /** Forget the live session object; the next turn resumes the conversation's session id afresh. */
  private dropSession(conversationId: string): void {
    this.sessions.delete(conversationId);
    this.ready.delete(conversationId);
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
      ...(this.options.configDirectory ? { configDirectory: this.options.configDirectory } : {}),
      onPermissionRequest: async (request) => {
        const run = this.active.get(conversationId);
        if (!run) return { kind: 'reject', feedback: 'No Squad turn is running' };
        const { kind, toolCallId, ...detail } = request;
        const outcome = await run.approvals.request(this.approvalId(run, toolCallId), summarizeAction(kind, requestDetail(request)), { kind, toolCallId, ...detail });
        return outcome.approved ? { kind: 'approve-once' } : { kind: 'reject', feedback: outcome.reason };
      },
    };
  }

  /** One approval id per permission request: a tool call asking several times gets `#2`, `#3` … */
  private readonly requestCounts = new WeakMap<TurnRun, Map<string, number>>();
  private approvalId(run: TurnRun, toolCallId: string | undefined): string {
    if (!toolCallId) return `copilot-${randomUUID()}`;
    let counts = this.requestCounts.get(run);
    if (!counts) this.requestCounts.set(run, (counts = new Map()));
    const n = (counts.get(toolCallId) ?? 0) + 1;
    counts.set(toolCallId, n);
    return n === 1 ? toolCallId : `${toolCallId}#${n}`;
  }

  private session(conversationId: string): Promise<CopilotSessionLike> {
    let s = this.sessions.get(conversationId);
    if (!s) {
      s = (async () => {
        const client = await this.getClient();
        const id = this.state.session(conversationId);
        const session = id
          ? await client.resumeSession(id, this.sessionConfig(conversationId))
          : await client.createSession(this.sessionConfig(conversationId));
        this.state.setSession(conversationId, session.sessionId);
        this.ready.set(conversationId, session);
        return session;
      })();
      this.sessions.set(conversationId, s);
      s.catch(() => this.sessions.delete(conversationId));
    }
    return s;
  }
}
