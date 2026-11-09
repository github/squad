/**
 * Regression guards for host-specific work (epic #2438, Claude Code as a first-class host).
 *
 * Every PR under that epic must keep these green:
 *  1. The Copilot projection written by `squad init` + `squad upgrade` is byte-identical to the
 *     snapshot (only the package version, which changes on every build, and CRLF line endings
 *     are normalized).
 *  2. `squad upgrade` on a steady-state repo without `claude` in `clients[]` changes no file.
 *  3. `squad upgrade --client copilot` changes only `.squad/config.json` and writes no Claude files.
 *  4. Adding Claude and then removing it (`uninstallClients`) leaves the Copilot projection untouched.
 *  5. `squad upgrade --client claude` on an existing Claude install with user content in the shared
 *     files changes only Squad-managed content, and removing Claude restores the user's bytes.
 *
 * The squad_state MCP launch spec is pinned to the exact-version `npx` form for this suite: the real
 * resolver writes machine-specific paths (node binary, checkout location) once the CLI is built, which
 * would make the snapshot depend on where and whether the checkout was built.
 *
 * Byte-exact rollback of pre-existing user files for every host through `installClients` is also
 * covered in test/clients.test.ts ("Reviewer gate ... byte-exact rollback across all 7 hosts").
 *
 * If guard 1 fails in a PR that intentionally changes Copilot output (outside #2438), review the
 * listed files and update the snapshot with `npx vitest run test/host-projection-regression-guards.test.ts -u`.
 * PRs under #2438 must not change Copilot output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInit } from '../packages/squad-cli/src/cli/core/init.js';
import { runUpgrade } from '../packages/squad-cli/src/cli/core/upgrade.js';
import { uninstallClients } from '../packages/squad-sdk/src/client/adapters/index.js';

// Deterministic launch spec: the pinned exact-version fallback, never a local binary or checkout path.
vi.mock('../packages/squad-cli/src/cli/core/mcp-spec.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/squad-cli/src/cli/core/mcp-spec.js')>();
  return {
    ...actual,
    resolveSquadStateMcpSpec: (cliVersion: string) =>
      actual.resolveSquadStateMcpSpec(cliVersion, { standaloneCheck: () => null, localEntryCheck: () => null }),
  };
});

const CLI_VERSION: string = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../packages/squad-cli/package.json'), 'utf8'),
).version;

/** Claude Code paths that must never appear unless `claude` is opted in. */
const CLAUDE_PATHS = ['.claude', 'CLAUDE.md'];

let root: string;
let restoreEnv: () => void;

/** sha256 of every file under `root` (except `.git/`), keyed by POSIX-style relative path. */
function hashTree(opts: { excludeSquadDir?: boolean; normalizeVersion?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (e.name === '.git') continue;
        if (opts.excludeSquadDir && rel === '.squad') continue;
        walk(abs);
        continue;
      }
      let bytes = fs.readFileSync(abs);
      // Normalize the build-stamped version and line endings (Windows checkouts may carry CRLF templates).
      if (opts.normalizeVersion) {
        bytes = Buffer.from(bytes.toString('utf8').split(CLI_VERSION).join('<VERSION>').replace(/\r\n/g, '\n'), 'utf8');
      }
      out[rel] = crypto.createHash('sha256').update(bytes).digest('hex');
    }
  };
  walk(root);
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function changedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();
}

/** `squad init` followed by one `squad upgrade`: the state an existing Copilot-only user is in. */
async function steadyStateCopilotRepo(): Promise<void> {
  await runInit(root, { includeWorkflows: false, includeVscodeDefault: false });
  await runUpgrade(root, {});
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-host-guards-'));
  const prev = {
    SQUAD_NONINTERACTIVE: process.env['SQUAD_NONINTERACTIVE'],
    NO_COLOR: process.env['NO_COLOR'],
    SQUAD_STANDALONE_HOME: process.env['SQUAD_STANDALONE_HOME'],
  };
  process.env['SQUAD_NONINTERACTIVE'] = '1';
  process.env['NO_COLOR'] = '1';
  delete process.env['SQUAD_STANDALONE_HOME'];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  restoreEnv = () => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
});

afterEach(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('host projection regression guards (#2438)', () => {
  it('guard 1: the Copilot projection is byte-identical to the snapshot', async () => {
    await steadyStateCopilotRepo();
    const projection = hashTree({ excludeSquadDir: true, normalizeVersion: true });
    expect(Object.keys(projection)).toContain('.github/agents/squad.agent.md');
    for (const p of CLAUDE_PATHS) expect(fs.existsSync(path.join(root, p)), p).toBe(false);
    expect(projection).toMatchSnapshot();
  }, 60_000);

  it('guard 2: squad upgrade on a steady-state repo without claude changes no file', async () => {
    await steadyStateCopilotRepo();
    const before = hashTree();
    await runUpgrade(root, {});
    expect(changedPaths(before, hashTree()), 'squad upgrade').toEqual([]);
    await runUpgrade(root, { force: true });
    expect(changedPaths(before, hashTree()), 'squad upgrade --force').toEqual([]);
  }, 60_000);

  it('guard 3: squad upgrade --client copilot changes only .squad/config.json', async () => {
    await steadyStateCopilotRepo();
    const before = hashTree();
    await runUpgrade(root, { clients: ['copilot'] });
    expect(changedPaths(before, hashTree())).toEqual(['.squad/config.json']);
    for (const p of CLAUDE_PATHS) expect(fs.existsSync(path.join(root, p)), p).toBe(false);
  }, 60_000);

  it('guard 4: adding and then removing Claude leaves the Copilot projection untouched', async () => {
    await steadyStateCopilotRepo();
    const before = hashTree({ excludeSquadDir: true });
    await runUpgrade(root, { clients: ['copilot', 'claude'] });
    expect(fs.existsSync(path.join(root, '.claude/agents/squad.md'))).toBe(true);
    // Claude may only add its own files and merge into the shared ones; Copilot-only files stay byte-identical.
    const shared = new Set(['.mcp.json', '.gitignore']);
    const withClaude = hashTree({ excludeSquadDir: true });
    for (const p of changedPaths(before, withClaude)) {
      const ownedByClaude = CLAUDE_PATHS.some((c) => p === c || p.startsWith(`${c}/`));
      expect(ownedByClaude || shared.has(p), `claude install touched ${p}`).toBe(true);
    }
    uninstallClients(['claude'], { root, mcp: { command: 'squad', args: ['state-mcp'] } }, ['copilot']);
    expect(changedPaths(before, hashTree({ excludeSquadDir: true })), 'after uninstalling claude').toEqual([]);
  }, 60_000);

  it('guard 5: upgrading an existing Claude install keeps user content, and removing Claude restores it', async () => {
    await steadyStateCopilotRepo();
    // User-owned content in every file Claude shares with the user or with Copilot.
    const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    mcp.mcpServers.user_srv = { command: 'user-mcp', args: ['--flag'] };
    fs.writeFileSync(path.join(root, '.mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`);
    fs.appendFileSync(path.join(root, '.gitignore'), 'user-build/\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# User Claude notes\n\nKeep this paragraph.\n');
    const userBytes = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
    const original = Object.fromEntries(['.mcp.json', '.gitignore', 'CLAUDE.md'].map((p) => [p, userBytes(p)]));
    const before = hashTree({ excludeSquadDir: true });

    await runUpgrade(root, { clients: ['copilot', 'claude'] });
    const installed = hashTree({ excludeSquadDir: true });
    expect(JSON.parse(userBytes('.mcp.json')).mcpServers.user_srv).toEqual({ command: 'user-mcp', args: ['--flag'] });
    expect(userBytes('.gitignore')).toContain('user-build/');
    expect(userBytes('CLAUDE.md')).toContain('Keep this paragraph.');

    // Upgrading the existing Claude install is a no-op for every file once it is current.
    await runUpgrade(root, { clients: ['copilot', 'claude'] });
    expect(changedPaths(installed, hashTree({ excludeSquadDir: true })), 'squad upgrade --client claude').toEqual([]);
    await runUpgrade(root, { clients: ['copilot', 'claude'], force: true });
    expect(changedPaths(installed, hashTree({ excludeSquadDir: true })), 'squad upgrade --client claude --force').toEqual([]);

    uninstallClients(['claude'], { root, mcp: { command: 'squad', args: ['state-mcp'] } }, ['copilot']);
    for (const [p, bytes] of Object.entries(original)) expect(userBytes(p), `rollback of ${p}`).toBe(bytes);
    expect(changedPaths(before, hashTree({ excludeSquadDir: true })), 'after uninstalling claude').toEqual([]);
  }, 60_000);
});
