/**
 * ADR-003 option C (#2487): every non-Copilot coordinator is self-sufficient. Its digest never
 * names GitHub Copilot's `.github/agents/squad.agent.md` as an authority, never tells the model to
 * read it, and is the same whether that file is absent, stock or customized.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CLIENT_IDS,
  buildCoordinatorInstructions,
  installClients,
} from '../packages/squad-sdk/src/client/adapters/index.js';
import { CANONICAL_COORDINATOR_HEADINGS, COORDINATOR_SQUAD_VERSION } from '../packages/squad-sdk/src/client/adapters/coordinator.js';
import sdkPkg from '../packages/squad-sdk/package.json' with { type: 'json' };

const COPILOT_FILE = '.github/agents/squad.agent.md';
const NON_COPILOT = CLIENT_IDS.filter((id) => id !== 'copilot');
const MCP = { command: 'squad', args: ['state-mcp'] };

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-self-sufficient-'));
  fs.mkdirSync(path.join(root, '.squad'), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Every file the non-Copilot hosts get, keyed by path. */
function project(): Record<string, string> {
  installClients(NON_COPILOT, { root, mcp: MCP });
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (rel === '.github/agents/squad.agent.md' || rel.startsWith('.squad')) continue;
      if (e.isDirectory()) walk(abs);
      else out[rel] = fs.readFileSync(abs, 'utf8');
    }
  };
  walk(root);
  return out;
}

describe('self-sufficient coordinators (ADR-003 option C, #2487)', () => {
  it.each(NON_COPILOT)('%s: the digest is its own complete protocol and never defers to Copilot\'s file', (id) => {
    const digest = buildCoordinatorInstructions(id, '.squad', root);
    expect(digest).toContain('This file is your complete coordinator protocol.');
    expect(digest).toMatch(/do not read it for instructions/);
    expect(digest).not.toMatch(/authoritative|single source of truth|canonical coordinator/i);
    // The only mention of Copilot's file is the one telling the model not to use it.
    expect(digest.split(COPILOT_FILE).length - 1).toBe(1);
    for (const heading of CANONICAL_COORDINATOR_HEADINGS) expect(digest).toContain(heading);
    expect(Buffer.byteLength(digest, 'utf8')).toBeLessThan(24_000);
  });

  it.each(NON_COPILOT)('%s: keeps the Squad version stamp the bridge handshake compares against (Copilot review)', (id) => {
    // Item 16 requires squad_state_health's `squad-state <version>` to match this stamp. It comes from
    // the SDK package (in lockstep with the CLI that serves the bridge), not from Copilot's file.
    expect(COORDINATOR_SQUAD_VERSION).toBe(sdkPkg.version);
    expect(buildCoordinatorInstructions(id, '.squad', root))
      .toContain(`match this coordinator's stamped Squad version, \`${sdkPkg.version}\``);
  });

  it('projects the same bytes whether Copilot\'s file is absent, stock or customized', () => {
    const absent = project();
    expect(Object.keys(absent).length).toBeGreaterThan(0);

    fs.mkdirSync(path.join(root, '.github', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(root, COPILOT_FILE), '<!-- version: 9.9.9 -->\n\n### Coordinator Identity\n\n### Init Mode\n');
    expect(project()).toEqual(absent);

    fs.writeFileSync(path.join(root, COPILOT_FILE), '# Our fork\n\nALWAYS deploy on Fridays.\n');
    const customized = project();
    expect(customized).toEqual(absent);
    expect(JSON.stringify(customized)).not.toContain('deploy on Fridays');
    expect(JSON.stringify(customized)).not.toContain('9.9.9');
  });

  it('keeps the Claude coordinator\'s Init Mode essentials inline without Copilot\'s file', () => {
    const claude = project()['.claude/agents/squad.md'];
    expect(claude).toBeDefined();
    expect(claude).toContain('This file is your complete coordinator protocol.');
    expect(claude).toContain('squad cast --name <Name> --role "<Role>"');
    expect(claude).toContain('squad client sync');
  });
});
