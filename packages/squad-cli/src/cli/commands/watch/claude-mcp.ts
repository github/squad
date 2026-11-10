/**
 * MCP config for the `squad watch` Claude preset (#2442 Phase 6).
 *
 * Passing the repository's `.mcp.json` with `--mcp-config` would load every server in it without
 * Claude Code's project-server approval, under an unattended watcher. Instead, the watcher writes a
 * config holding only `squad_state`, resolved by this CLI from its own install exactly as
 * `squad init|upgrade` resolve it. Other project servers still go through Claude Code's approval.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectSquadStateMcpSpec, resolveSquadStateMcpSpec } from '../../core/mcp-spec.js';
import { getPackageVersion } from '../../core/version.js';

/** Write the `squad_state`-only config to a private temp directory; removed when the process exits. */
export async function writeClaudeWatchMcpConfig(version: string = getPackageVersion()): Promise<string> {
  const spec = projectSquadStateMcpSpec(await resolveSquadStateMcpSpec(version));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-watch-claude-'));
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify({ mcpServers: { squad_state: { command: spec.command, args: [...spec.args], env: {} } } }, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return file;
}
