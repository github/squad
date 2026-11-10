/**
 * Turn-scoped approval queue shared by the shipped harnesses (harness-adapters §5).
 *
 * The broker holds one pending approval per turn and drops a second distinct request, so concurrent tool
 * calls are queued and offered one at a time. Each request is bound to a hash of its canonical action; a
 * response with a different hash never resolves it. A deny ends the turn, as the broker marks it
 * `cancelled`: the call and every queued call are denied and `onDeny` fires so the harness can stop.
 */
import { createHash } from 'node:crypto';
import type { ApprovalResponse, HarnessApprovalRequest } from '../types.js';

export type ApprovalOutcome = { approved: true } | { approved: false; reason: string };

/** sha256 over canonical JSON (sorted keys): the approval's bound payload. */
export function canonicalApprovalHash(payload: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
        : v;
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(payload))).digest('hex')}`;
}

interface Pending {
  approvalId: string;
  hash: string;
  action: string;
  payload: unknown;
  resolve: (outcome: ApprovalOutcome) => void;
  offered: boolean;
}

export class TurnApprovals {
  private readonly queue: Pending[] = [];
  private closed?: string;

  constructor(
    private readonly turnSeq: number,
    /** Emits `approval-requested` for the turn. */
    private readonly offer: (request: HarnessApprovalRequest) => void,
    /** Called after a decision lets the turn continue (`state: running`). */
    private readonly onApprove: () => void,
    /** Called after a deny: the harness stops the turn. */
    private readonly onDeny: () => void,
  ) {}

  /** Ask the broker; resolves when it decides, or as denied once the turn is closed. */
  request(approvalId: string, action: string, payload: unknown): Promise<ApprovalOutcome> {
    if (this.closed) return Promise.resolve({ approved: false, reason: this.closed });
    return new Promise((resolve) => {
      this.queue.push({ approvalId, hash: canonicalApprovalHash(payload), action, payload, resolve, offered: false });
      this.offerNext();
    });
  }

  has(approvalId: string): boolean {
    return this.queue.some((p) => p.approvalId === approvalId);
  }

  /**
   * Apply a broker decision. Returns false when the id isn't pending here (unknown, or already decided: a
   * redelivered decision is then a no-op). Throws when the hash doesn't match; the call keeps waiting.
   */
  respond(response: ApprovalResponse): boolean {
    const i = this.queue.findIndex((p) => p.approvalId === response.approvalId);
    if (i === -1) return false;
    const pending = this.queue[i]!;
    if (response.hash !== pending.hash) {
      throw new Error(`Approval ${response.approvalId}: hash does not match the requested action`);
    }
    this.queue.splice(i, 1);
    if (response.decision === 'approve') {
      pending.resolve({ approved: true });
      this.onApprove();
      this.offerNext();
      return true;
    }
    const reason = response.reason ?? 'Denied by the Squad approval policy';
    pending.resolve({ approved: false, reason });
    this.close(reason);
    this.onDeny();
    return true;
  }

  /** Deny everything still queued and refuse new requests (cancel, deny, or end of turn). */
  close(reason: string): void {
    this.closed ??= reason;
    for (const p of this.queue.splice(0)) p.resolve({ approved: false, reason });
  }

  /** Drop one request whose call was aborted by the runtime itself. */
  drop(approvalId: string, reason: string): void {
    const i = this.queue.findIndex((p) => p.approvalId === approvalId);
    if (i === -1) return;
    const [p] = this.queue.splice(i, 1);
    p!.resolve({ approved: false, reason });
    this.offerNext();
  }

  private offerNext(): void {
    if (this.queue.some((p) => p.offered)) return;
    const next = this.queue[0];
    if (!next) return;
    next.offered = true;
    this.offer({ approvalId: next.approvalId, turnSeq: this.turnSeq, action: next.action, hash: next.hash, payload: next.payload });
  }
}
