/**
 * Claude Code member subagents: one `.claude/agents/<id>.md` per Squad team member.
 *
 * Charter v0.1 §6 and Execution Preferences v0.1 §2 map onto Claude Code subagent frontmatter.
 * Host-only settings come from the charter extension `## X-squad-host-claude` (charter §8). They
 * are runtime configuration, not authorization (charter §13.1).
 *
 * @module client/adapters/claude-members
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseCharterMarkdown } from '../../agents/charter-compiler.js';
import { VALID_REASONING_EFFORTS } from '../../config/models.js';
import type { ClientContext, ProjectionFile } from './types.js';
import { readContained } from './safe-path.js';

/** Charter extension heading (charter §8: namespace `squad`, name `host-claude`). */
export const CLAUDE_HOST_EXTENSION = 'X-squad-host-claude';

export const CLAUDE_AGENTS_DIR = '.claude/agents';

/** File names in {@link CLAUDE_AGENTS_DIR} that are never member subagents. */
const RESERVED_IDS = new Set(['squad']);

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Claude Code model aliases or `claude-*` model IDs, optionally with the 1M-context suffix. */
const CLAUDE_MODEL_RE = /^(?:sonnet|opus|haiku|fable|inherit|claude-[a-z0-9][a-z0-9.-]*)(\[1m\])?$/i;
/** Tool names and permission-style patterns; anything else could break out of the frontmatter. */
const TOOL_RE = /^[A-Za-z0-9_*.:-]+(?:\([^\r\n()]*\))?$/;
const MAX_DESCRIPTION = 400;

export interface ClaudeHostSettings {
  tools?: string[];
  isolation?: 'worktree';
  /** Authored values that could not be projected, for the generated file's notes. */
  rejected: string[];
}

/** Parse `## X-squad-host-claude` fields (`- **Label:** value`) from a charter. Unknown labels are ignored. */
export function parseClaudeHostSettings(charter: string): ClaudeHostSettings {
  const out: ClaudeHostSettings = { rejected: [] };
  const lines = charter.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${CLAUDE_HOST_EXTENSION}\\s*$`, 'i').test(l));
  if (start === -1) return out;
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line)) break;
    const m = line.match(/^\s*[-*]\s+\*\*([^*]+?):?\*\*:?\s*(.*)$/);
    if (!m) continue;
    const label = m[1]!.trim().toLowerCase();
    // Strip one code span around the whole value only when it has no inner backticks, so a list of
    // individually quoted names (`Read`, `Grep`) is left for the per-token pass.
    const value = m[2]!.trim().replace(/^`([^`]*)`$/, '$1');
    if (label === 'tools') {
      const tools = value.split(',').map((t) => t.trim().replace(/^`(.*)`$/, '$1')).filter(Boolean);
      const bad = tools.filter((t) => !TOOL_RE.test(t));
      if (bad.length > 0) out.rejected.push(`Tools \`${bad.join(', ')}\` (not a tool name)`);
      else if (tools.length > 0) out.tools = tools;
    } else if (label === 'isolation') {
      if (value.toLowerCase() === 'worktree') out.isolation = 'worktree';
      else out.rejected.push(`Isolation \`${value}\` (only \`worktree\` is supported)`);
    }
  }
  return out;
}

export interface RoutingRow {
  workType: string;
  routeTo: string;
}

/** Rows of the `routing.md` table: `| Work Type | Route To | Examples |`. */
export function readRouting(squadAbs: string): RoutingRow[] {
  let text: string;
  try {
    text = readContained(squadAbs, 'routing.md');
  } catch {
    return [];
  }
  const rows: RoutingRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2 || /^-+$/.test(cells[0]!.replace(/[:\s]/g, '')) || /^work type$/i.test(cells[0]!)) continue;
    rows.push({ workType: cells[0]!, routeTo: cells[1]!.replace(/`/g, '').toLowerCase() });
  }
  return rows;
}

const EFFORTS = new Set<string>(VALID_REASONING_EFFORTS);

/**
 * `agentReasoningEffortOverrides.<id>`, then `defaultReasoningEffort`, from `.squad/config.json`.
 * `auto`, invalid values and an unreadable config mean no config preference.
 */
function readEffortConfig(squadAbs: string): (id: string) => string | undefined {
  let cfg: { defaultReasoningEffort?: unknown; agentReasoningEffortOverrides?: unknown } = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(squadAbs, 'config.json'), 'utf8'));
  } catch {
    // missing or malformed config: no config preference
  }
  const valid = (v: unknown) => (typeof v === 'string' && EFFORTS.has(v.toLowerCase()) ? v.toLowerCase() : undefined);
  const overrides =
    cfg.agentReasoningEffortOverrides && typeof cfg.agentReasoningEffortOverrides === 'object'
      ? (cfg.agentReasoningEffortOverrides as Record<string, unknown>)
      : {};
  return (id) => valid(Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : undefined) ?? valid(cfg.defaultReasoningEffort);
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1)}…` : flat;
}

/** Member IDs with a charter, from `<squadDir>/agents/<id>/charter.md`. Symlinked directories are skipped. */
function memberIds(agentsAbs: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && ID_RE.test(e.name) && !RESERVED_IDS.has(e.name))
    .filter((e) => fs.existsSync(path.join(agentsAbs, e.name, 'charter.md')))
    .map((e) => e.name)
    .sort();
}

export function renderClaudeMember(
  id: string,
  charter: string,
  routing: readonly RoutingRow[],
  squadDir: string,
  generatedNote: string,
  /** Reasoning effort from `.squad/config.json`, which outranks the charter (exec-prefs §3). */
  configEffort?: string,
  /** `squad_state` tool-name prefix: `mcp__squad_state__` (project `.mcp.json`) or the plugin's. */
  mcpPrefix = 'mcp__squad_state__',
): string {
  const parsed = parseCharterMarkdown(charter);
  const host = parseClaudeHostSettings(charter);
  const name = parsed.identity.name ?? id;
  const role = parsed.identity.role;
  const notes = [...host.rejected];

  const routed = routing.filter((r) => r.routeTo === id).map((r) => r.workType);
  const summary = parsed.identity.purpose ?? (role ? `${name}, ${role.replace(/[.\s]+$/, '')}.` : `${name}, Squad team member.`);
  const description = oneLine(
    `${summary}${routed.length > 0 ? ` Owns: ${routed.join('; ')}.` : ''} Spawned by the Squad coordinator.`,
  );

  const fields: Array<[string, string]> = [
    ['name', id],
    ['description', JSON.stringify(description)],
  ];
  if (host.tools) fields.push(['tools', host.tools.join(', ')]);

  const preferred = parsed.modelPreference?.replace(/^`(.*)`$/, '$1').trim();
  const longContext = parsed.contextTier === 'long_context';
  if (preferred && preferred.toLowerCase() !== 'auto') {
    if (CLAUDE_MODEL_RE.test(preferred)) fields.push(['model', preferred]);
    else notes.push(`Model \`${preferred}\` (not a Claude model; the session model is used)`);
  }
  // Exec-prefs §6: an unsupported context tier is reported, not dropped silently.
  if (longContext && !(preferred && /\[1m\]$/i.test(preferred))) {
    notes.push('Context Tier `long_context` (name a long-context Claude model in `Preferred` to apply it)');
  }
  const effort = configEffort ?? parsed.reasoningEffort;
  if (effort) fields.push(['effort', effort]);
  if (host.isolation) fields.push(['isolation', host.isolation]);

  const charterPath = `${squadDir}/agents/${id}/charter.md`;
  const historyPath = `${squadDir}/agents/${id}/history.md`;
  const notesBlock =
    notes.length > 0
      ? `\n<!-- Charter preferences not projected to Claude Code: ${notes.join('; ').replace(/--/g, '- -')}. -->\n`
      : '';

  return (
    `---\n${fields.map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n` +
    `${generatedNote}\n${notesBlock}\n` +
    `You are **${name}**${role ? `, ${role},` : ''} on this project's Squad team.\n\n` +
    `Before you start, read your charter at \`${charterPath}\` and your history at \`${historyPath}\`. ` +
    `If the spawn prompt gives a TEAM ROOT, resolve these paths under it instead. ` +
    `Your charter is authoritative: follow its responsibilities and boundaries, and the task in the spawn prompt.\n\n` +
    `Squad dispatches specialists only from the coordinator: do not spawn subagents of your own. ` +
    `Read and write shared team state through the \`squad_state\` MCP tools (\`${mcpPrefix}*\`) when they are available.\n`
  );
}

/**
 * Project one managed subagent per member charter, plus `obsolete` entries for generated member
 * files whose charter is gone. Existing user-authored files (no `ownedMarker`) are never overwritten.
 */
export function projectClaudeMembers(
  ctx: ClientContext,
  generatedNote: string,
  ownedMarker: string,
  mcpPrefix?: string,
): ProjectionFile[] {
  const squadDir = ctx.squadDir ?? '.squad';
  const squadAbs = path.resolve(ctx.root, squadDir);
  const agentsAbs = path.join(squadAbs, 'agents');
  const routing = readRouting(squadAbs);
  const ids = memberIds(agentsAbs);
  const effortConfig = readEffortConfig(squadAbs);
  const files: ProjectionFile[] = [];
  for (const id of ids) {
    let charter: string;
    try {
      // A charter linked outside the team directory is never copied into .claude/.
      charter = readContained(squadAbs, path.join(path.relative(squadAbs, agentsAbs), id, 'charter.md'));
    } catch {
      continue;
    }
    files.push({
      kind: 'managed',
      path: `${CLAUDE_AGENTS_DIR}/${id}.md`,
      ownedMarker,
      content: renderClaudeMember(id, charter, routing, squadDir, generatedNote, effortConfig(id), mcpPrefix),
    });
  }

  const current = new Set(ids);
  let existing: fs.Dirent[] = [];
  try {
    existing = fs.readdirSync(path.join(ctx.root, CLAUDE_AGENTS_DIR), { withFileTypes: true });
  } catch {
    // no .claude/agents yet
  }
  for (const e of existing) {
    const id = e.name.replace(/\.md$/, '');
    if (!e.isFile() || !e.name.endsWith('.md') || RESERVED_IDS.has(id) || current.has(id)) continue;
    const rel = `${CLAUDE_AGENTS_DIR}/${e.name}`;
    try {
      if (fs.readFileSync(path.join(ctx.root, rel), 'utf8').includes(ownedMarker)) {
        files.push({ kind: 'obsolete', path: rel, ownedMarker });
      }
    } catch {
      // unreadable: leave it alone
    }
  }
  return files;
}
