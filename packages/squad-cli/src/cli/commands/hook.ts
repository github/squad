/**
 * `squad hook claude <Event>`: the Claude Code hook entry point (#2438 Phase 3).
 *
 * Reads the hook event JSON on stdin and prints advisory JSON output. It never blocks: any error
 * prints nothing and exits 0, so a broken hook cannot stop a session.
 */
import { resolveSquadState } from '@bradygaster/squad-sdk';
import { CLAUDE_HOOK_EVENTS, runClaudeHook } from '@bradygaster/squad-sdk/client';
import { getPackageVersion } from '../core/version.js';

const STDIN_TIMEOUT_MS = 5_000;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(done, STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      done();
    });
  });
}

export async function runHookCommand(args: string[]): Promise<number> {
  const [host, event] = args;
  if (host !== 'claude' || !event || !(CLAUDE_HOOK_EVENTS as readonly string[]).includes(event)) {
    process.stderr.write(`Usage: squad hook claude <${CLAUDE_HOOK_EVENTS.join('|')}>\n`);
    return 0;
  }
  try {
    const raw = await readStdin();
    const input = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const start = process.env['CLAUDE_PROJECT_DIR'] || (typeof input['cwd'] === 'string' ? input['cwd'] : '') || process.cwd();
    const state = resolveSquadState(start);
    if (!state) return 0;
    const out = runClaudeHook(event, input, {
      root: state.repoRoot,
      teamAbs: state.paths.teamSquadDir,
      projectAbs: state.paths.projectDir,
      version: getPackageVersion(),
    });
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (err) {
    process.stderr.write(`squad hook: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  return 0;
}
