/**
 * Claude Code governance hooks (#2438 Phase 3): opt-in, advisory only.
 *
 * With `"claudeHooks": "advisory"` in `<squadDir>/config.json`, the Claude projection merges a
 * Squad-owned set of hook handlers into `.claude/settings.json`. Each handler runs
 * `<squad launcher> hook claude <Event>`, the same launcher as the `squad_state` MCP server. The
 * hooks warn and add context; they never deny a tool call. User hooks in the same file are never
 * touched: Squad's handlers are recognised by their `hook claude <Event>` argument tail.
 *
 * @module client/adapters/claude-hooks
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseCharterMarkdown } from '../../agents/charter-compiler.js';
import { CLAUDE_AGENTS_DIR, readRouting } from './claude-members.js';
import { effectiveLocked, lockoutsFor, readLockouts, type LockoutRecord } from './lockout.js';
import type { ClientContext, McpLaunchSpec, ProjectionFile } from './types.js';
import { readContained } from './safe-path.js';

export const CLAUDE_SETTINGS_PATH = '.claude/settings.json';

export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'SubagentStart', 'PreToolUse', 'PostToolUse', 'Stop'] as const;
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number];

export type ClaudeHooksMode = 'off' | 'advisory';

/** Matcher per event (Claude Code exact-match lists); `undefined` matches every occurrence. */
const MATCHERS: Record<ClaudeHookEvent, string | undefined> = {
  SessionStart: undefined,
  SubagentStart: 'squad',
  PreToolUse: 'Edit|MultiEdit|Write|NotebookEdit',
  PostToolUse: 'Agent|Task',
  Stop: undefined,
};

const HOOK_TIMEOUT_SECONDS = 15;
const COORDINATOR = 'squad';
/** Claude Code caps hook context at 10,000 characters; stay well under it. */
const MAX_CONTEXT = 8000;

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** `claudeHooks` from `<squadDir>/config.json`. Anything but `"advisory"` is off. */
export function readClaudeHooksMode(squadAbs: string): ClaudeHooksMode {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(squadAbs, 'config.json'), 'utf8')) as { claudeHooks?: unknown };
    return cfg.claudeHooks === 'advisory' ? 'advisory' : 'off';
  } catch {
    return 'off';
  }
}

/**
 * The hook launch command: the MCP launcher with its trailing `state-mcp` replaced.
 *
 * No command allowlist on purpose. `mcp` is resolved by the running CLI from its own install
 * (standalone launcher, `node <abs>/cli-entry.js`, or `npx` with the exact package version), never
 * from repository content, and the same command is already projected into `.mcp.json` as the
 * `squad_state` server. Hooks therefore add no new executable.
 */
export function claudeHookLaunch(mcp: McpLaunchSpec, event: ClaudeHookEvent): McpLaunchSpec | null {
  if (mcp.args[mcp.args.length - 1] !== 'state-mcp') return null;
  return { command: mcp.command, args: [...mcp.args.slice(0, -1), 'hook', 'claude', event] };
}

/** A handler Squad wrote: a command hook whose arguments end in `hook claude <Event>`. */
export function isSquadHookHandler(h: unknown): boolean {
  if (!isObject(h) || h['type'] !== 'command' || !Array.isArray(h['args'])) return false;
  const a = h['args'] as unknown[];
  return (
    a.length >= 3 &&
    a[a.length - 3] === 'hook' &&
    a[a.length - 2] === 'claude' &&
    (CLAUDE_HOOK_EVENTS as readonly unknown[]).includes(a[a.length - 1])
  );
}

/** Remove Squad's handlers (and groups and events they leave empty). Untouched input is returned as is. */
export function stripClaudeHooks(settings: Json): Json {
  const hooks = settings['hooks'];
  if (!isObject(hooks)) return settings;
  let changed = false;
  const next: Json = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept: unknown[] = [];
    let removedHere = false;
    for (const g of groups) {
      if (!isObject(g) || !Array.isArray(g['hooks'])) {
        kept.push(g);
        continue;
      }
      const handlers = (g['hooks'] as unknown[]).filter((h) => !isSquadHookHandler(h));
      if (handlers.length === (g['hooks'] as unknown[]).length) kept.push(g);
      else {
        removedHere = true;
        if (handlers.length > 0) kept.push({ ...g, hooks: handlers });
      }
    }
    if (removedHere) changed = true;
    if (!removedHere || kept.length > 0) next[event] = removedHere ? kept : groups;
  }
  if (!changed) return settings;
  const out: Json = { ...settings };
  if (Object.keys(next).length === 0) delete out['hooks'];
  else out['hooks'] = next;
  return out;
}

/** Refresh Squad's handlers: strip the old ones, then append one group per event when `mcp` is given. */
export function mergeClaudeHooks(settings: Json, mcp: McpLaunchSpec | null): Json {
  const stripped = stripClaudeHooks(settings);
  if (!mcp) return stripped;
  if (stripped['hooks'] !== undefined && !isObject(stripped['hooks'])) {
    throw new Error('Refusing to overwrite "hooks" in .claude/settings.json: expected a JSON object');
  }
  const hooks: Json = { ...((stripped['hooks'] as Json | undefined) ?? {}) };
  for (const event of CLAUDE_HOOK_EVENTS) {
    const launch = claudeHookLaunch(mcp, event);
    if (!launch) return stripped;
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new Error(`Refusing to overwrite "hooks.${event}" in .claude/settings.json: expected an array`);
    const handler = { type: 'command', command: launch.command, args: launch.args, timeout: HOOK_TIMEOUT_SECONDS };
    const matcher = MATCHERS[event];
    hooks[event] = [...groups, matcher ? { matcher, hooks: [handler] } : { hooks: [handler] }];
  }
  return { ...stripped, hooks };
}

/**
 * The `.claude/settings.json` entry. Emitted while hooks are on, and while the file exists (so
 * turning hooks off, or rolling Claude back, removes Squad's handlers). Never creates the file
 * just to leave it empty.
 */
export function projectClaudeHooks(ctx: ClientContext): ProjectionFile[] {
  const squadAbs = path.resolve(ctx.root, ctx.squadDir ?? '.squad');
  const on = readClaudeHooksMode(squadAbs) === 'advisory' && claudeHookLaunch(ctx.mcp, 'Stop') !== null;
  if (!on && !fs.existsSync(path.join(ctx.root, CLAUDE_SETTINGS_PATH))) return [];
  return [
    {
      kind: 'json',
      path: CLAUDE_SETTINGS_PATH,
      update: (existing) => mergeClaudeHooks(existing, on ? ctx.mcp : null),
      remove: stripClaudeHooks,
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Hook runtime: `squad hook claude <Event>` reads the event JSON on stdin and prints advisory output.
// ---------------------------------------------------------------------------------------------

export interface ClaudeHookEnv {
  /** Repository root (Claude Code's `CLAUDE_PROJECT_DIR`). */
  root: string;
  /** Team squad directory (team.md, agents/, config.json). */
  teamAbs: string;
  /** Project-local squad directory (decisions inbox). Equals `teamAbs` in local mode. */
  projectAbs: string;
  /** Squad CLI version, for the health line. */
  version: string;
}

/** Claude Code hook output (the subset Squad uses). `null`: print nothing. */
export type ClaudeHookOutput = {
  systemMessage?: string;
  hookSpecificOutput?: { hookEventName: ClaudeHookEvent; additionalContext: string };
} | null;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Real path of `abs`, resolved through its nearest existing ancestor (a Write target may not exist
 * yet). Claude Code and the resolved team root can disagree on symlinks, such as macOS `/var`.
 */
function realish(abs: string): string {
  let dir = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest.reverse());
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs;
      rest.push(path.basename(dir));
      dir = parent;
    }
  }
}

const MEMBER_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function cap(s: string): string {
  return s.length > MAX_CONTEXT ? `${s.slice(0, MAX_CONTEXT - 1)}…` : s;
}

/** Member IDs (directories under `agents/` with a charter); names outside `a-z0-9-` are ignored. */
function memberIdsWithCharters(teamAbs: string): string[] {
  try {
    return fs
      .readdirSync(path.join(teamAbs, 'agents'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && MEMBER_ID_RE.test(e.name) && fs.existsSync(path.join(teamAbs, 'agents', e.name, 'charter.md')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Lockout fields come from a file in the repository and from free text typed with `squad lockout`,
 * so they reach the coordinator as inert data: one line, no markup or code delimiters, bounded.
 */
function inert(value: unknown, max = 120): string {
  const flat = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ')
    .replace(/[`<>{}[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Member IDs only (`a-z0-9-`); anything else in the file is dropped. */
function ids(values: readonly unknown[]): string[] {
  return values.filter((v): v is string => typeof v === 'string' && MEMBER_ID_RE.test(v));
}

function describeLockout(r: LockoutRecord): string {
  const scope = r.paths.length > 0 ? ` on ${r.paths.slice(0, 10).map((p) => inert(p, 80)).join(', ')}` : '';
  const who = ids(effectiveLocked(r)).join(', ');
  const [reviewer] = ids([r.reviewer]);
  const [successor] = ids([r.successor]);
  const next = successor ? `; revision assigned to ${successor}` : '';
  // The reason is quoted as data (JSON string), so it reads as the reviewer's words, not as instructions.
  const reason = r.reason ? ` (reason, as recorded: ${JSON.stringify(inert(r.reason, 200))})` : '';
  return `${inert(r.subject, 80)} (${inert(r.state, 24)})${scope}: ${who} locked out${reviewer ? ` after ${reviewer}'s REJECT` : ''}${reason}${next}`;
}

function activeLockouts(teamAbs: string): LockoutRecord[] {
  try {
    return readLockouts(teamAbs).subjects.filter((r) => effectiveLocked(r).length > 0);
  } catch {
    return [];
  }
}

/** `open` Ralph circuit breaker still in cooldown (templates/ralph-circuit-breaker.md). */
function openCircuit(projectAbs: string, now: number): string | undefined {
  try {
    const cb = JSON.parse(fs.readFileSync(path.join(projectAbs, 'ralph-circuit-breaker.json'), 'utf8')) as Json;
    if (cb['state'] !== 'open') return undefined;
    const opened = Date.parse(String(cb['openedAt'] ?? ''));
    const minutes = typeof cb['cooldownMinutes'] === 'number' ? (cb['cooldownMinutes'] as number) : 10;
    if (Number.isFinite(opened) && now - opened >= minutes * 60_000) return undefined;
    const chain = Array.isArray(cb['fallbackChain']) ? (cb['fallbackChain'] as unknown[]).map(String) : [];
    const idx = typeof cb['currentFallbackIndex'] === 'number' ? (cb['currentFallbackIndex'] as number) : 0;
    const fallback = chain[Math.min(idx, chain.length - 1)];
    const until = Number.isFinite(opened) ? ` until ${new Date(opened + minutes * 60_000).toISOString()}` : '';
    // Model names come from a repository file: inert, as for lockout fields.
    const preferred = inert(cb['preferredModel'] ?? 'the preferred model', 60);
    return `Ralph circuit breaker is OPEN${until}: spawn with ${fallback ? `the fallback model ${JSON.stringify(inert(fallback, 60))}` : 'a fallback model'} instead of ${JSON.stringify(preferred)}.`;
  } catch {
    return undefined;
  }
}

function inboxCount(projectAbs: string): number {
  try {
    return fs.readdirSync(path.join(projectAbs, 'decisions', 'inbox')).filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

function sessionContext(env: ClaudeHookEnv, now: number): { additionalContext?: string; systemMessage?: string } {
  const squadDir = path.relative(realish(env.root), realish(env.teamAbs)).split(path.sep).join('/') || '.';
  if (!fs.existsSync(path.join(env.teamAbs, 'team.md'))) {
    return { systemMessage: `Squad: no team found at ${squadDir}/team.md. Run \`squad init\` to cast a team.` };
  }
  const lines = [
    `Squad session context (advisory hooks, squad CLI ${env.version}). Team root: \`${squadDir}\`. ` +
      `The squad_state bridge must report \`squad-state ${env.version}\` and this team dir in \`squad_state_health\`.`,
  ];
  const members = memberIdsWithCharters(env.teamAbs).map((id) => {
    try {
      const c = parseCharterMarkdown(readContained(env.teamAbs, path.join('agents', id, 'charter.md')));
      const sub = fs.existsSync(path.join(env.root, CLAUDE_AGENTS_DIR, `${id}.md`)) ? '' : ' (no subagent file)';
      const role = c.identity.role ? inert(c.identity.role, 60) : '';
      return `${id}${role ? ` (${role})` : ''}${sub}`;
    } catch {
      return id;
    }
  });
  if (members.length > 0) lines.push(`Roster: ${members.join(', ')}.`);
  const routing = readRouting(env.teamAbs);
  // routing.md is repository text: each work type is quoted as data, and only roster members route.
  const known = new Set(memberIdsWithCharters(env.teamAbs));
  const routes = routing
    .slice(0, 40)
    .map((r) => ({
      work: inert(r.workType, 80),
      to: [...new Set(ids(r.routeTo.toLowerCase().split(/[\s,/&+]+/).map((t) => t.replace(/^@/, ''))).filter((id) => known.has(id)))],
    }))
    .filter((r) => r.work && r.to.length > 0);
  if (routes.length > 0) lines.push(`Routing (work type, as written → member): ${routes.map((r) => `${JSON.stringify(r.work)} → ${r.to.join(', ')}`).join('; ')}.`);
  const locks = activeLockouts(env.teamAbs);
  if (locks.length > 0) lines.push(`Active reviewer lockouts (governance-review §6): ${locks.map(describeLockout).join('; ')}.`);
  const circuit = openCircuit(env.projectAbs, now);
  if (circuit) lines.push(circuit);
  return { additionalContext: cap(lines.join('\n')) };
}

/** Run one hook event. Advisory: the result only adds context or a warning, never a permission decision. */
export function runClaudeHook(event: string, input: Json, env: ClaudeHookEnv, now = Date.now()): ClaudeHookOutput {
  if (readClaudeHooksMode(env.teamAbs) !== 'advisory') return null;
  const agent = str(input['agent_type'])?.toLowerCase();

  if (event === 'SessionStart' || event === 'SubagentStart') {
    if (agent !== COORDINATOR) return null;
    const ctx = sessionContext(env, now);
    if (!ctx.additionalContext) return { systemMessage: ctx.systemMessage };
    return { hookSpecificOutput: { hookEventName: event, additionalContext: ctx.additionalContext } };
  }

  if (event === 'PreToolUse') {
    if (!agent || agent === COORDINATOR) return null;
    const toolInput = isObject(input['tool_input']) ? input['tool_input'] : {};
    const file = str(toolInput['file_path']) ?? str(toolInput['notebook_path']);
    if (!file) return null;
    const target = realish(path.resolve(str(input['cwd']) ?? env.root, file));
    const rel = path.relative(realish(env.root), target).split(path.sep).join('/');
    if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return null;
    let hits: LockoutRecord[];
    try {
      hits = lockoutsFor(readLockouts(env.teamAbs), agent, rel);
    } catch {
      return null;
    }
    if (hits.length === 0) return null;
    const subjects = hits.map(describeLockout).join('; ');
    const next = ids(hits.map((h) => h.successor));
    const warning =
      `Squad reviewer lockout (advisory): ${agent} is locked out of ${subjects}. ` +
      `Under governance-review §6 a locked-out author may not revise the rejected work. ` +
      `Stop editing \`${rel}\` and hand back to the coordinator${next.length > 0 ? `; the revision belongs to ${[...new Set(next)].join(', ')}` : ' to reassign the revision'}.`;
    return { systemMessage: warning, hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: warning } };
  }

  if (event === 'PostToolUse') {
    if (agent && agent !== COORDINATOR) return null;
    const toolInput = isObject(input['tool_input']) ? input['tool_input'] : {};
    const member = str(toolInput['subagent_type'])?.toLowerCase();
    if (!member || !memberIdsWithCharters(env.teamAbs).includes(member)) return null;
    // Structured fields only: free text from the tool call (its `description`) is not reflected
    // back into the coordinator's context, so the hook cannot become an instruction channel.
    // A background Agent call returns at launch (`status: "async_launched"`), before the member has
    // finished. Claude Code gives no parent-side hook for the later completion (SubagentStop context
    // goes to the subagent), so a launch is reported as an acknowledgement, never as a result.
    const response = isObject(input['tool_response']) ? input['tool_response'] : {};
    const launched = response['status'] === 'async_launched';
    const envelope = {
      profile: 'squad-coordination-handoff/v0.1',
      type: launched ? 'acknowledgement' : 'result',
      messageId: str(input['tool_use_id']) ?? null,
      correlationId: str(input['session_id']) ?? null,
      sender: member,
      recipient: COORDINATOR,
      createdAt: new Date(now).toISOString(),
    };
    const locks = activeLockouts(env.teamAbs).filter((r) => r.successor === member || effectiveLocked(r).includes(member));
    const review =
      locks.length > 0 ? ` Lockout state for this member: ${locks.map(describeLockout).join('; ')}.` : '';
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: cap(
          launched
            ? `Squad handoff acknowledgement: ${JSON.stringify(envelope)}. ${member} is running in the background and has not finished; ` +
                `wait for its completion notification, then record any verdict with \`squad_decide\` and run the reviewer gate.${review}`
            : `Squad handoff result envelope: ${JSON.stringify(envelope)}. Record any verdict or decision with \`squad_decide\`, ` +
                `and run the reviewer gate before declaring the work done.${review}`,
        ),
      },
    };
  }

  if (event === 'Stop') {
    if (agent !== COORDINATOR || input['stop_hook_active'] === true) return null;
    const circuit = openCircuit(env.projectAbs, now);
    const inbox = inboxCount(env.projectAbs);
    if (inbox === 0) return circuit ? { systemMessage: circuit } : null;
    return {
      ...(circuit ? { systemMessage: circuit } : {}),
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext:
          `The decisions inbox has ${inbox} unmerged ${inbox === 1 ? 'entry' : 'entries'}. ` +
          'Spawn Scribe (background) to merge it into decisions.md per the Scribe spawn protocol, then finish.',
      },
    };
  }

  return null;
}
