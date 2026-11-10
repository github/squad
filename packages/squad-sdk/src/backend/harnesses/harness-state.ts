/**
 * Durable harness state (harness-adapters §5: `submit` deduplication must hold across restarts).
 *
 * Remembers which deliveries were accepted (the most recent {@link MAX_REMEMBERED}) and which runtime session
 * belongs to each conversation, so a restarted harness neither re-runs an accepted turn nor starts a
 * conversation over with no context. With no directory it is in-memory only, which keeps tests and embedded
 * uses simple; `squad state-mcp` always passes one.
 */
import fs from 'node:fs';
import path from 'node:path';

export const MAX_REMEMBERED = 10_000;
const FILE = 'harness-state.json';

interface Stored {
  version: 1;
  accepted: string[];
  sessions: Record<string, string>;
}

export class HarnessState {
  private readonly accepted: string[] = [];
  private readonly acceptedSet = new Set<string>();
  private readonly sessions = new Map<string, string>();
  private readonly file?: string;

  constructor(dir?: string) {
    if (!dir) return;
    this.file = path.join(dir, FILE);
    let stored: Partial<Stored> | undefined;
    try {
      stored = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Stored>;
    } catch {
      stored = undefined; // no state yet, or unreadable: start empty rather than refuse to run
    }
    for (const key of Array.isArray(stored?.accepted) ? stored!.accepted : []) {
      if (typeof key === 'string') this.remember(key);
    }
    for (const [conversationId, sessionId] of Object.entries(stored?.sessions ?? {})) {
      if (typeof sessionId === 'string') this.sessions.set(conversationId, sessionId);
    }
  }

  hasAccepted(key: string): boolean {
    return this.acceptedSet.has(key);
  }

  addAccepted(key: string): void {
    if (this.acceptedSet.has(key)) return;
    this.remember(key);
    this.save();
  }

  session(conversationId: string): string | undefined {
    return this.sessions.get(conversationId);
  }

  setSession(conversationId: string, sessionId: string): void {
    if (this.sessions.get(conversationId) === sessionId) return;
    this.sessions.set(conversationId, sessionId);
    this.save();
  }

  private remember(key: string): void {
    this.accepted.push(key);
    this.acceptedSet.add(key);
    while (this.accepted.length > MAX_REMEMBERED) this.acceptedSet.delete(this.accepted.shift()!);
  }

  private save(): void {
    if (!this.file) return;
    const stored: Stored = { version: 1, accepted: this.accepted, sessions: Object.fromEntries(this.sessions) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
