/**
 * Turn lifecycle shared by the shipped harnesses (harness-adapters §5 SPI).
 *
 * A subclass supplies three things: start its runtime (`init`), run one turn (`runTurn`), and interrupt a
 * turn (`interrupt`). The base class owns everything the broker relies on:
 * - **Atomic acceptance.** Concurrent deliveries of one operation share a single acceptance promise; a failed
 *   start forgets the operation so the broker's retry runs it.
 * - **Cancellation that survives startup.** The run is registered before the runtime starts, so a cancel that
 *   arrives during startup or session creation is kept and the turn never reaches the runtime.
 * - **Order and quiescence.** Turns of one conversation run in order, and the next turn starts only after the
 *   previous one has fully stopped, including an in-flight interrupt (so late events from an aborted turn can't
 *   be attributed to the next one).
 * - **Conversation-scoped approvals** through {@link TurnApprovals}.
 * - **Durability across restarts** through {@link HarnessState}: accepted deliveries are remembered so a restarted
 *   harness doesn't re-run them, and each conversation's runtime session id is kept so it can be resumed.
 * - **Failed interrupts stay retryable**: a later cancel tries again, and the subclass hears about the failure
 *   (`interruptFailed`) so it can stop reusing a runtime session that may still be busy.
 * - **Bounded memory** for long-running bridges: a finished turn is dropped (a late cancel or decision for it is a
 *   no-op anyway), idle conversation tails are dropped, and the record of accepted deliveries keeps the most
 *   recent {@link MAX_ACCEPTED}, which is what makes redelivery of a finished turn a no-op.
 */

/** How many accepted delivery ids are remembered for deduplication. */
export const MAX_ACCEPTED = 10_000;
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
import { HarnessState } from './harness-state.js';

export interface TurnRun {
  readonly conversationId: string;
  readonly runId: string;
  readonly seq: number;
  readonly epoch?: LeaseEpoch;
  /** Aborted on cancel or deny; runtimes listen to it. */
  readonly abort: AbortController;
  readonly approvals: TurnApprovals;
  /** Settles when an interrupt has finished (the runtime is quiet). */
  quiesce: Promise<void>;
  /** The last interrupt failed; a later cancel retries it. */
  interruptFailed?: boolean;
  done: Promise<void>;
}

/** Thrown by {@link TurnHarness.checkpoint} when the turn was cancelled during an await. */
export class TurnCancelled extends Error {
  constructor() {
    super('Turn cancelled');
    this.name = 'TurnCancelled';
  }
}

export abstract class TurnHarness implements HarnessAdapter {
  abstract readonly id: string;
  abstract readonly capabilities: HarnessCapabilities;
  protected abstract readonly displayName: string;

  private readonly listeners = new Map<string, Set<(e: HarnessEventEnvelope) => void>>();
  private readonly accepted = new Map<string, Promise<void>>();
  private readonly runs = new Map<string, TurnRun>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(protected readonly state: HarnessState = new HarnessState()) {}

  /** Start the runtime (idempotent; may be called concurrently). Rejecting fails the delivery. */
  protected abstract init(): Promise<void>;
  /** Run one turn; resolves with a failure message, or undefined on success. Call `checkpoint` after awaits. */
  protected abstract runTurn(run: TurnRun, prompt: string): Promise<string | undefined>;
  /** Stop the runtime's work for this turn; resolves once it is quiet. */
  protected abstract interrupt(run: TurnRun): Promise<void>;
  /** The interrupt for this turn failed: stop reusing whatever runtime state it may still be using. */
  protected interruptFailed(_run: TurnRun, _error: unknown): void {}

  describe(): HarnessDescriptor {
    return { id: this.id, displayName: this.displayName, capabilities: this.capabilities };
  }

  subscribe(conversationId: string, listener: (event: HarnessEventEnvelope) => void): () => void {
    let set = this.listeners.get(conversationId);
    if (!set) this.listeners.set(conversationId, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }

  submit(submission: HarnessSubmission): Promise<void> {
    const key = submission.operationId ?? `${submission.conversationId}:${submission.runId}:${submission.seq}`;
    const existing = this.accepted.get(key);
    if (existing) return existing; // at-least-once delivery, including concurrent duplicates
    // Accepted before a restart: never run it again.
    if (this.state.hasAccepted(key)) return Promise.resolve();
    const runKey = this.runKey(submission.conversationId, submission.runId, submission.seq);
    const run = this.runs.get(runKey) ?? this.createRun(submission);
    this.runs.set(runKey, run);
    const acceptance = (async () => {
      try {
        await this.init();
      } catch (err) {
        this.accepted.delete(key); // the broker's retry must run it
        if (!run.abort.signal.aborted) this.runs.delete(runKey);
        throw err;
      }
      this.state.addAccepted(key);
      this.schedule(run, submission);
    })();
    this.accepted.set(key, acceptance);
    while (this.accepted.size > MAX_ACCEPTED) this.accepted.delete(this.accepted.keys().next().value!);
    return acceptance;
  }

  /**
   * Acknowledges once the stop is requested. It doesn't wait for the runtime to go quiet (the broker awaits this
   * call); ordering is kept because the conversation's next turn waits for the interrupt to finish.
   */
  async cancel(conversationId: string, runId: string, seq: number): Promise<void> {
    const run = this.runs.get(this.runKey(conversationId, runId, seq));
    if (run) this.stop(run);
  }

  async respondApproval(conversationId: string, response: ApprovalResponse): Promise<void> {
    for (const run of this.runs.values()) {
      if (run.conversationId === conversationId && run.approvals.respond(response)) return;
    }
    // Unknown or already decided in this conversation: a redelivered decision is a no-op.
  }

  /** Waits for a submitted turn to finish (tests and orderly shutdown); resolves at once for a finished turn. */
  async settled(conversationId: string, runId: string, seq: number): Promise<void> {
    await this.runs.get(this.runKey(conversationId, runId, seq))?.done.catch(() => undefined);
  }

  /** Turns currently held in memory (diagnostics and tests). */
  get activeTurns(): number {
    return this.runs.size;
  }

  protected emit(run: TurnRun, event: Record<string, unknown>): void {
    const envelope = { ...event, runId: run.runId, seq: run.seq, ...(run.epoch !== undefined ? { epoch: run.epoch } : {}) } as HarnessEventEnvelope;
    for (const l of this.listeners.get(run.conversationId) ?? []) l(envelope);
  }

  /** Throw {@link TurnCancelled} if the turn was cancelled; call after every await before touching the runtime. */
  protected checkpoint(run: TurnRun): void {
    if (run.abort.signal.aborted) throw new TurnCancelled();
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────────

  private runKey(conversationId: string, runId: string, seq: number): string {
    return `${conversationId}\u0000${runId}\u0000${seq}`;
  }

  private createRun(s: HarnessSubmission): TurnRun {
    const run: TurnRun = {
      conversationId: s.conversationId,
      runId: s.runId,
      seq: s.seq,
      ...(s.epoch !== undefined ? { epoch: s.epoch } : {}),
      abort: new AbortController(),
      approvals: undefined as unknown as TurnApprovals,
      quiesce: Promise.resolve(),
      done: Promise.resolve(),
    };
    (run as { approvals: TurnApprovals }).approvals = new TurnApprovals(
      run.seq,
      (request) => this.emit(run, { type: 'approval-requested', request }),
      () => this.emit(run, { type: 'state', state: 'running' }),
      () => this.stop(run), // a deny ends the turn, as the broker marks it cancelled
    );
    return run;
  }

  private stop(run: TurnRun): void {
    if (run.abort.signal.aborted && !run.interruptFailed) return;
    run.abort.abort();
    run.approvals.close('Turn cancelled');
    run.interruptFailed = false;
    run.quiesce = this.interrupt(run).catch((err) => {
      // Not quiet: keep the cancel retryable and let the subclass stop reusing the runtime state.
      run.interruptFailed = true;
      this.interruptFailed(run, err);
    });
  }

  private schedule(run: TurnRun, s: HarnessSubmission): void {
    const prompt = s.messages
      .filter((m) => m.role === 'user')
      .map((m) => (m.parts?.length ? partsToText(m.parts) : m.content))
      .join('\n\n');
    const previous = this.tails.get(run.conversationId) ?? Promise.resolve();
    run.done = previous.then(() => this.execute(run, prompt));
    const tail = run.done.catch(() => undefined).then(() => {
      // Finished: forget the run, and the conversation's tail if no later turn was queued behind it.
      this.runs.delete(this.runKey(run.conversationId, run.runId, run.seq));
      if (this.tails.get(run.conversationId) === tail) this.tails.delete(run.conversationId);
    });
    this.tails.set(run.conversationId, tail);
  }

  private async execute(run: TurnRun, prompt: string): Promise<void> {
    try {
      if (run.abort.signal.aborted) {
        this.emit(run, { type: 'state', state: 'cancelled' });
        return;
      }
      this.emit(run, { type: 'state', state: 'running' });
      let failure: string | undefined;
      try {
        failure = await this.runTurn(run, prompt);
      } catch (err) {
        if (!(err instanceof TurnCancelled) && !run.abort.signal.aborted) {
          failure = err instanceof Error ? err.message : String(err);
        }
      }
      if (run.abort.signal.aborted) this.emit(run, { type: 'state', state: 'cancelled' });
      else if (failure) this.emit(run, { type: 'state', state: 'failed', error: failure.slice(0, 500) });
      else this.emit(run, { type: 'state', state: 'completed' });
    } finally {
      run.approvals.close('Turn ended');
      // The next turn of this conversation starts only once an interrupt has finished.
      await run.quiesce;
    }
  }
}
