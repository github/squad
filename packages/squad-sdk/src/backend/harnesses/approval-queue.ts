/**
 * Turn-scoped approval queue shared by the shipped harnesses (harness-adapters §5).
 *
 * The broker holds one pending approval per turn and drops a second distinct request, so concurrent tool
 * calls are queued and offered one at a time. Each request is bound to a hash of its canonical action; a
 * response with a different hash never resolves it. A deny ends the turn, as the broker marks it
 * `cancelled`: the call and every queued call are denied and `onDeny` fires so the harness can stop.
 *
 * What reaches the broker's approval record is minimized: the payload is redacted (secret-looking keys and
 * inline credentials masked, long strings truncated) and the action is a short summary. The hash is still taken
 * over the full, unredacted action, so a decision stays bound to exactly what will run.
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

const SENSITIVE_KEY = /pass(word|wd)?|secret|token|api[-_]?key|auth(orization)?|cookie|credential|private[-_]?key|session[-_]?id/i;
const INLINE_SECRET = /((?:pass(?:word|wd)?|secret|token|api[-_]?key|authorization)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const MAX_STRING = 1000;

/** Mask inline credentials (`token=…`, `Authorization: Bearer …`) in free text. */
export function redactText(text: string): string {
  // Bearer/basic tokens first, so `Authorization: Bearer <token>` loses the token rather than the scheme word.
  return text.replace(BEARER, '$1 [redacted]').replace(INLINE_SECRET, (m, key: string, value: string) => (value === 'Bearer' || value === 'Basic' || value.startsWith('[redacted]') ? m : `${key}[redacted]`));
}

/** A copy of an approval payload safe to record: secret-looking keys masked, strings truncated, depth bounded. */
export function redactApprovalPayload(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    const t = redactText(value);
    return t.length > MAX_STRING ? `${t.slice(0, MAX_STRING)}… [${t.length - MAX_STRING} chars truncated]` : t;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactApprovalPayload(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? '[redacted]' : redactApprovalPayload(v, depth + 1)]),
  );
}

/** A one-line, redacted summary of an action for the approval record. */
export function summarizeAction(label: string, detail: unknown): string {
  const text = typeof detail === 'string' ? detail : detail === undefined ? '' : JSON.stringify(redactApprovalPayload(detail));
  const flat = redactText(text).replace(/\s+/g, ' ').trim();
  return flat ? `${label}: ${flat.length > 300 ? `${flat.slice(0, 299)}…` : flat}` : label;
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
    this.offer({
      approvalId: next.approvalId,
      turnSeq: this.turnSeq,
      action: next.action,
      hash: next.hash,
      payload: redactApprovalPayload(next.payload),
    });
  }
}
