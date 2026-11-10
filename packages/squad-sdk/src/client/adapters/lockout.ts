/**
 * Durable reviewer-lockout record (governance-review v0.1 §6), stored in
 * `<squadDir>/governance/lockouts.json`.
 *
 * Each review subject carries its own lockout set. A rejection adds the current revision author;
 * the set stays in force until a later revision is approved or an authority records an override.
 * When no eligible successor remains, the subject is `deadlocked` instead of silently readmitting
 * a locked-out author. Hosts read this record (for example the Claude Code PreToolUse hook); it
 * grants or removes no repository permission (§10).
 *
 * @module client/adapters/lockout
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveContained } from './safe-path.js';

export const LOCKOUT_FILE = 'governance/lockouts.json';

export type LockoutState = 'clear' | 'author-locked' | 'revision-assigned' | 'revision-submitted' | 'cleared' | 'deadlocked';

export interface LockoutOverride {
  /** Author readmitted for this subject. */
  author: string;
  /** Authority that recorded the override. */
  by: string;
  reason: string;
  at: string;
}

export interface LockoutRecord {
  /** Review subject: an issue, PR or artifact reference. */
  subject: string;
  /** Repository-relative paths or globs the subject covers. Empty: the whole repository. */
  paths: string[];
  state: LockoutState;
  /** Every author a rejection has locked out, in order. Overrides are recorded separately. */
  lockedAuthors: string[];
  reviewer?: string;
  successor?: string;
  /** Reason given with the latest rejection. */
  reason?: string;
  overrides: LockoutOverride[];
  updatedAt: string;
}

export interface LockoutStore {
  version: 1;
  subjects: LockoutRecord[];
}

export class LockoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockoutError';
  }
}

/**
 * Members that never author revisions: the coordinator, the bookkeeping agents, and the
 * reviewer-only built-ins whose charters exclude implementation and revision pairing.
 */
const NON_AUTHORS = new Set(['squad', 'scribe', 'ralph', 'rai', 'fact-checker']);
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function emptyLockoutStore(): LockoutStore {
  return { version: 1, subjects: [] };
}

export function readLockouts(squadAbs: string): LockoutStore {
  let raw: string;
  try {
    raw = fs.readFileSync(lockoutPath(squadAbs), 'utf8');
  } catch (err) {
    if (err instanceof LockoutError) throw err;
    return emptyLockoutStore();
  }
  const parsed = JSON.parse(raw) as Partial<LockoutStore>;
  if (parsed.version !== 1 || !Array.isArray(parsed.subjects)) {
    throw new LockoutError(`${LOCKOUT_FILE}: unsupported lockout record (expected version 1)`);
  }
  return { version: 1, subjects: parsed.subjects.map((r) => ({ ...r, paths: r.paths ?? [], overrides: r.overrides ?? [] })) };
}

/** The lockout file, refusing a `governance/` directory or file link that leads outside the team. */
function lockoutPath(squadAbs: string): string {
  try {
    return resolveContained(squadAbs, LOCKOUT_FILE);
  } catch (err) {
    throw new LockoutError(err instanceof Error ? err.message : String(err));
  }
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read, transform and write the store under an interprocess lock, so concurrent `squad lockout`
 * commands (for example two coordinator sessions rejecting different subjects) keep both
 * transitions. A lock older than 30 s is treated as abandoned.
 */
export function updateLockouts(squadAbs: string, transition: (store: LockoutStore) => LockoutStore): LockoutStore {
  const abs = lockoutPath(squadAbs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const lock = `${abs}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch {
        // released meanwhile
      }
      if (Date.now() > deadline) throw new LockoutError(`${LOCKOUT_FILE} is locked by another squad lockout command; try again`);
      sleepSync(50);
    }
  }
  try {
    const next = transition(readLockouts(squadAbs));
    writeLockouts(squadAbs, next);
    return next;
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export function writeLockouts(squadAbs: string, store: LockoutStore): void {
  const abs = lockoutPath(squadAbs);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // Rename replaces a link at `abs` instead of following it.
  const tmp = `${abs}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(tmp, abs);
}

/** Authors who may revise: member IDs with a charter, minus the coordinator and the non-authoring built-ins. */
export function lockoutRoster(squadAbs: string): string[] {
  try {
    return fs
      .readdirSync(path.join(squadAbs, 'agents'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && ID_RE.test(e.name) && !NON_AUTHORS.has(e.name))
      .filter((e) => fs.existsSync(path.join(squadAbs, 'agents', e.name, 'charter.md')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Who may record an override: the human user, plus `governance.authorities` from config.json. */
export function lockoutAuthorities(squadAbs: string): string[] {
  let cfg: { governance?: { authorities?: unknown } } = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(squadAbs, 'config.json'), 'utf8'));
  } catch {
    // no config: only the user
  }
  const listed = Array.isArray(cfg.governance?.authorities)
    ? cfg.governance!.authorities.filter((a): a is string => typeof a === 'string').map((a) => a.toLowerCase())
    : [];
  return ['user', ...listed.filter((a) => a !== 'user')];
}

/** Authors currently locked out of the subject (none once it is clear or cleared). */
export function effectiveLocked(record: LockoutRecord): string[] {
  if (record.state === 'clear' || record.state === 'cleared') return [];
  const readmitted = new Set(record.overrides.map((o) => o.author));
  return record.lockedAuthors.filter((a) => !readmitted.has(a));
}

/** Roster members who may author the next revision: not locked out, and not the blocking reviewer. */
export function eligibleSuccessors(record: LockoutRecord, roster: readonly string[]): string[] {
  const locked = new Set(effectiveLocked(record));
  return roster.filter((m) => !locked.has(m) && m !== record.reviewer);
}

function norm(id: string, what: string): string {
  const v = id.trim().toLowerCase();
  if (!v) throw new LockoutError(`${what} is required`);
  return v;
}

function find(store: LockoutStore, subject: string): LockoutRecord {
  const r = store.subjects.find((s) => s.subject === subject);
  if (!r) throw new LockoutError(`No lockout record for ${subject}`);
  return r;
}

function put(store: LockoutStore, record: LockoutRecord): LockoutStore {
  return { version: 1, subjects: [...store.subjects.filter((s) => s.subject !== record.subject), record] };
}

function settle(record: LockoutRecord, roster: readonly string[] | undefined): LockoutRecord {
  if (roster && roster.length > 0 && eligibleSuccessors(record, roster).length === 0) return { ...record, state: 'deadlocked' };
  return record;
}

export interface RejectInput {
  subject: string;
  /** Current revision author, who is locked out. */
  author: string;
  reviewer: string;
  reason: string;
  paths?: string[];
  /** Eligible-author pool; when given, an empty eligible set records `deadlocked`. */
  roster?: readonly string[];
  at?: string;
}

/** A blocking REJECT: lock the current revision author out of the subject. */
export function rejectRevision(store: LockoutStore, input: RejectInput): LockoutStore {
  const author = norm(input.author, 'author');
  const reviewer = norm(input.reviewer, 'reviewer');
  if (author === reviewer) throw new LockoutError(`Self-review: ${author} cannot review their own revision`);
  if (!input.reason.trim()) throw new LockoutError('A rejection needs a reason (the violated requirement and clearing condition)');
  const prev = store.subjects.find((s) => s.subject === input.subject);
  const active = prev && prev.state !== 'cleared' && prev.state !== 'clear' ? prev : undefined;
  const record: LockoutRecord = {
    subject: input.subject,
    paths: input.paths ?? active?.paths ?? [],
    state: 'author-locked',
    lockedAuthors: [...new Set([...(active?.lockedAuthors ?? []), author])],
    reviewer,
    reason: input.reason.trim(),
    // An override readmits an author for one cycle; a new rejection of the same author locks them again.
    overrides: (active?.overrides ?? []).filter((o) => o.author !== author),
    updatedAt: input.at ?? new Date().toISOString(),
  };
  return put(store, settle(record, input.roster));
}

/** Assign the next revision to a successor from the eligible set. */
export function assignRevision(
  store: LockoutStore,
  input: { subject: string; successor: string; roster?: readonly string[]; at?: string },
): LockoutStore {
  const record = find(store, input.subject);
  const successor = norm(input.successor, 'successor');
  if (record.state !== 'author-locked' && record.state !== 'revision-assigned') {
    throw new LockoutError(`${input.subject} is ${record.state}; only a locked subject can be reassigned`);
  }
  if (effectiveLocked(record).includes(successor)) throw new LockoutError(`${successor} is locked out of ${input.subject}`);
  if (successor === record.reviewer) throw new LockoutError(`${successor} is the blocking reviewer and cannot author the revision`);
  if (input.roster && input.roster.length > 0 && !input.roster.includes(successor)) {
    throw new LockoutError(`${successor} is not on the roster`);
  }
  return put(store, { ...record, state: 'revision-assigned', successor, updatedAt: input.at ?? new Date().toISOString() });
}

/** The successor submits the revision for re-review. */
export function submitRevision(store: LockoutStore, input: { subject: string; author: string; at?: string }): LockoutStore {
  const record = find(store, input.subject);
  const author = norm(input.author, 'author');
  if (record.state !== 'revision-assigned') throw new LockoutError(`${input.subject} is ${record.state}; nothing is assigned`);
  if (author !== record.successor) throw new LockoutError(`${author} is not the assigned successor (${record.successor})`);
  return put(store, { ...record, state: 'revision-submitted', updatedAt: input.at ?? new Date().toISOString() });
}

/** Re-review approved the later revision: the lockout ends. */
export function approveRevision(store: LockoutStore, input: { subject: string; reviewer: string; at?: string }): LockoutStore {
  const record = find(store, input.subject);
  const reviewer = norm(input.reviewer, 'reviewer');
  if (record.state !== 'revision-submitted') throw new LockoutError(`${input.subject} is ${record.state}; no revision awaits review`);
  if (reviewer === record.successor) throw new LockoutError(`Self-approval: ${reviewer} authored the revision`);
  return put(store, { ...record, state: 'cleared', reviewer, updatedAt: input.at ?? new Date().toISOString() });
}

/** An authority readmits a locked-out author for this subject. */
export function overrideLockout(
  store: LockoutStore,
  input: { subject: string; author: string; by: string; reason: string; authorities: readonly string[]; roster?: readonly string[]; at?: string },
): LockoutStore {
  const record = find(store, input.subject);
  const author = norm(input.author, 'author');
  const by = norm(input.by, 'authority');
  if (!input.authorities.includes(by)) throw new LockoutError(`${by} is not an authority (authorities: ${input.authorities.join(', ')})`);
  if (by === author) throw new LockoutError(`${author} cannot override their own lockout`);
  if (!input.reason.trim()) throw new LockoutError('An override needs a reason');
  if (!effectiveLocked(record).includes(author)) throw new LockoutError(`${author} is not locked out of ${input.subject}`);
  const at = input.at ?? new Date().toISOString();
  const next: LockoutRecord = {
    ...record,
    overrides: [...record.overrides, { author, by, reason: input.reason.trim(), at }],
    updatedAt: at,
  };
  // A deadlock resolved by readmitting an author goes back to waiting for a successor.
  if (next.state === 'deadlocked') next.state = 'author-locked';
  return put(store, settle(next, input.roster));
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Does a repository-relative POSIX path fall under one of the subject's paths? */
export function subjectCovers(record: LockoutRecord, relPath: string): boolean {
  if (record.paths.length === 0) return true;
  const p = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return record.paths.some((raw) => {
    const g = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (/[*?]/.test(g)) return globToRegExp(g).test(p);
    return p === g || p.startsWith(`${g}/`);
  });
}

/** Active lockouts that cover `relPath` for `author`. */
export function lockoutsFor(store: LockoutStore, author: string, relPath: string): LockoutRecord[] {
  const a = author.toLowerCase();
  return store.subjects.filter((r) => effectiveLocked(r).includes(a) && subjectCovers(r, relPath));
}
