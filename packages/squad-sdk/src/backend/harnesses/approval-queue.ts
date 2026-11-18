/**
 * Turn-scoped approval queue shared by the shipped harnesses (harness-adapters §5).
 *
 * The broker holds one pending approval per turn and drops a second distinct request, so concurrent tool
 * calls are queued and offered one at a time. Each request is bound to a hash of its canonical action; a
 * response with a different hash never resolves it. A deny ends the turn, as the broker marks it
 * `cancelled`: the call and every queued call are denied and `onDeny` fires so the harness can stop.
 *
 * What reaches the broker's approval record is minimal: the approval id, a short redacted summary of the action,
 * and the hash. The tool input itself is never sent (no `payload`), so no redaction pattern has to be complete for
 * a secret in it to stay out of backend state. The hash is taken over the full input, so a decision stays bound to
 * exactly what will run.
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

const SENSITIVE_KEY = /pass(word|wd)?|secret|token|api[-_]?key|access[-_]?key|auth(orization)?|cookie|credential|private[-_]?key|session[-_]?id/i;
/**
 * A credential name in free text: optional prefix segments (`X-`, `GITHUB_`, `AWS_SECRET_`) and then a sensitive
 * word, so `X-API-Key`, `X-Auth-Token`, `Cookie`, `GITHUB_TOKEN` and `AWS_SECRET_ACCESS_KEY` all match, while
 * words that merely start the same way (`author`, `tokenizer`) don't.
 */
const SECRET_NAME =
  '(?:[A-Za-z0-9]+[-_])*(?:pass(?:word|wd)?|secret(?:[-_]access)?(?:[-_]?key)?|access[-_]?key|api[-_]?key|apikey|token|auth[-_]?token|authorization|cookie|credentials?|private[-_]?key|session[-_]?id)';
/**
 * Characters that make a value executable (expansion, command substitution, chaining, redirection, grouping). A
 * masked value stops at the first of them, and a quoted value containing any of them is not masked at all: the
 * approver must always see code that would run (`TOKEN="$(rm -rf ./src)"` stays readable).
 */
const SHELL_SYNTAX = /[$`;|&<>(){}\\]/;
const PLAIN_VALUE = '[^\\s"\'`$;|&<>(){}\\\\]+';
/** `name: value`, `name=value`, and JSON-style `"name": "value"`. */
const INLINE_SECRET = new RegExp(`(\\b${SECRET_NAME}["']?\\s*[=:]\\s*)("[^"]*"|'[^']*'|${PLAIN_VALUE})`, 'gi');
/** `--password x`, `--token=x`, `--client-secret x` (a flag name ending in a credential word). */
const SECRET_FLAG = new RegExp(`(--(?:[a-z0-9]+-)*(?:password|passwd|secret|token|api-?key|access-?key|auth-token|client-secret)(?:=|\\s+))(${PLAIN_VALUE})`, 'gi');
/** `curl -u name:password` / `--user name:password`. */
const USER_PASSWORD = new RegExp(`((?:^|\\s)(?:-u|--user)(?:=|\\s+)[^\\s:"']+:)(${PLAIN_VALUE})`, 'g');
/** `Authorization: <scheme> <value>` for any scheme (`token`, `Bearer`, `Basic`, …). */
const AUTH_HEADER = new RegExp(`(\\b(?:proxy-)?authorization["']?\\s*:\\s*[A-Za-z][A-Za-z0-9-]*\\s+)(${PLAIN_VALUE})`, 'gi');
const BEARER = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/**
 * Secrets with no name in front of them (positional arguments such as `gh auth login --with-token ghp_…`):
 * well-known vendor token formats and JWTs. Plain hex (git SHAs, checksums), UUIDs and paths are deliberately
 * left readable, since the approver needs to see what they're approving.
 */
const BARE_TOKEN = new RegExp(
  [
    'gh[pousr]_[A-Za-z0-9]{20,}',
    'github_pat_[A-Za-z0-9_]{20,}',
    'sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}',
    'xox[abposr]-[A-Za-z0-9-]{10,}',
    '(?:AKIA|ASIA)[0-9A-Z]{16}',
    'AIza[0-9A-Za-z_-]{30,}',
    'glpat-[A-Za-z0-9_-]{16,}',
    'npm_[A-Za-z0-9]{30,}',
    'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
  ].map((p) => `(?<![A-Za-z0-9_-])${p}`).join('|'),
  'g',
);
/** A long opaque base64-looking token: 40+ characters with upper and lower case and a digit, no path separator. */
const OPAQUE = /(?<![A-Za-z0-9+/=_-])(?=[A-Za-z0-9+=_-]*[a-z])(?=[A-Za-z0-9+=_-]*[A-Z])(?=[A-Za-z0-9+=_-]*\d)[A-Za-z0-9+=_-]{40,}(?![A-Za-z0-9+/=_-])/g;
/** The password in `scheme://user:password@host`. */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
const MAX_STRING = 1000;

/**
 * Mask credentials in free text: named (`token=…`, `X-API-Key: …`, JSON keys), `Authorization` schemes, credential
 * flags, `-u user:password`, URL passwords and bare tokens. Executable syntax is never masked.
 */
export function redactText(text: string): string {
  const keep = (value: string) => value.startsWith('[redacted]') || SHELL_SYNTAX.test(value);
  // Scheme-aware forms first, so `Authorization: Bearer <token>` loses the token rather than the scheme word.
  return text
    .replace(URL_PASSWORD, '$1[redacted]@')
    .replace(BARE_TOKEN, '[redacted]')
    .replace(OPAQUE, '[redacted]')
    .replace(AUTH_HEADER, (m, head: string, value: string) => (keep(value) ? m : `${head}[redacted]`))
    .replace(BEARER, '$1 [redacted]')
    .replace(SECRET_FLAG, (m, head: string, value: string) => (keep(value) ? m : `${head}[redacted]`))
    .replace(USER_PASSWORD, (m, head: string, value: string) => (keep(value) ? m : `${head}[redacted]`))
    .replace(INLINE_SECRET, (m, key: string, value: string) => {
      const inner = value.replace(/^["']|["']$/g, '');
      // Scheme words are left for AUTH_HEADER/BEARER; quoted values with executable syntax stay visible.
      return /^(bearer|basic|token)$/i.test(inner) || keep(inner) ? m : `${key}[redacted]`;
    });
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

  /**
   * Drop one request whose call was aborted by the runtime itself. A request the broker already holds as pending
   * can't be withdrawn from it, so dropping an offered request ends the turn instead of offering the next one into
   * an occupied slot (the broker would discard it and the call would wait forever).
   */
  drop(approvalId: string, reason: string): void {
    const i = this.queue.findIndex((p) => p.approvalId === approvalId);
    if (i === -1) return;
    const [p] = this.queue.splice(i, 1);
    p!.resolve({ approved: false, reason });
    if (p!.offered) {
      this.close(reason);
      this.onDeny();
      return;
    }
    this.offerNext();
  }

  private offerNext(): void {
    if (this.queue.some((p) => p.offered)) return;
    const next = this.queue[0];
    if (!next) return;
    next.offered = true;
    // No payload: the raw input stays in this process; the hash binds the decision to it.
    this.offer({ approvalId: next.approvalId, turnSeq: this.turnSeq, action: next.action, hash: next.hash });
  }
}
