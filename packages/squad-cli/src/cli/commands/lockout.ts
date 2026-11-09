/**
 * `squad lockout`: record reviewer-lockout transitions (governance-review v0.1 §6) in
 * `<squadDir>/governance/lockouts.json`, which the Claude Code PreToolUse hook reads.
 */
import { resolveSquadState } from '@bradygaster/squad-sdk';
import {
  LockoutError,
  approveRevision,
  assignRevision,
  effectiveLocked,
  eligibleSuccessors,
  lockoutAuthorities,
  lockoutRoster,
  overrideLockout,
  readLockouts,
  rejectRevision,
  submitRevision,
  writeLockouts,
  type LockoutStore,
} from '@bradygaster/squad-sdk/client';

const USAGE = `Usage: squad lockout <command> <subject> [options]

  reject <subject> --author <id> --reviewer <id> --reason "<text>" [--paths <glob,...>]
  assign <subject> --successor <id>
  submit <subject> --author <id>
  approve <subject> --reviewer <id>
  override <subject> --author <id> --by <authority> --reason "<text>"
  status [subject] [--json]`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
}

function need(args: string[], name: string): string {
  const v = flag(args, name);
  if (!v) throw new LockoutError(`--${name} is required`);
  return v;
}

export async function runLockoutCommand(startDir: string, args: string[]): Promise<number> {
  const [cmd, subject] = args;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  const state = resolveSquadState(startDir);
  if (!state) {
    console.error('No squad found. Run `squad init` first.');
    return 1;
  }
  const team = state.paths.teamSquadDir;
  try {
    const store = readLockouts(team);
    const roster = lockoutRoster(team);
    if (cmd === 'status') {
      const shown = store.subjects.filter((s) => !subject || s.subject === subject);
      if (args.includes('--json')) console.log(JSON.stringify(shown, null, 2));
      else if (shown.length === 0) console.log('No lockout records.');
      else
        for (const r of shown) {
          const locked = effectiveLocked(r);
          console.log(`${r.subject}: ${r.state}${locked.length ? `, locked out: ${locked.join(', ')}` : ''}${r.successor ? `, successor: ${r.successor}` : ''}`);
          if (r.state === 'author-locked' || r.state === 'deadlocked') console.log(`  eligible successors: ${eligibleSuccessors(r, roster).join(', ') || '(none)'}`);
        }
      return 0;
    }
    if (!subject) throw new LockoutError('A review subject is required');
    let next: LockoutStore;
    if (cmd === 'reject') {
      const paths = flag(args, 'paths')?.split(',').map((p) => p.trim()).filter(Boolean);
      next = rejectRevision(store, { subject, author: need(args, 'author'), reviewer: need(args, 'reviewer'), reason: need(args, 'reason'), paths, roster });
    } else if (cmd === 'assign') next = assignRevision(store, { subject, successor: need(args, 'successor'), roster });
    else if (cmd === 'submit') next = submitRevision(store, { subject, author: need(args, 'author') });
    else if (cmd === 'approve') next = approveRevision(store, { subject, reviewer: need(args, 'reviewer') });
    else if (cmd === 'override')
      next = overrideLockout(store, { subject, author: need(args, 'author'), by: need(args, 'by'), reason: need(args, 'reason'), authorities: lockoutAuthorities(team), roster });
    else {
      console.error(USAGE);
      return 1;
    }
    writeLockouts(team, next);
    const r = next.subjects.find((s) => s.subject === subject)!;
    console.log(`${r.subject}: ${r.state}`);
    if (r.state === 'deadlocked') console.log('  No eligible successor remains: escalate to an authority (squad lockout override ...) or the user.');
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
