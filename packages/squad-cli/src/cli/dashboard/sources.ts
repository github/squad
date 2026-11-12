/**
 * Dashboard event sources (#2459): turn Claude Code session activity into a flat, ordered list of
 * dashboard events (one lane per member run, plus the coordinator lane).
 *
 * Primary source: the session transcript Claude Code writes for every session, interactive or
 * headless, at `<config>/projects/<encoded cwd>/<session>.jsonl`, with each subagent run in
 * `<session>/subagents/agent-<id>.jsonl` and its `agent-<id>.meta.json` (`agentType`,
 * `description`, `toolUseId`, `requestShape`, `finished`). Second source: a `claude -p
 * --output-format stream-json --verbose` log, as the prototype read.
 *
 * Only the line types below are read; every other line type (request blobs, prompt snapshots,
 * environment and account attachments, and types added by later Claude Code releases) is skipped and
 * only counted, so internal context never reaches the page. Text is passed through as data: the page
 * escapes it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type DashboardEventKind =
  | 'session'
  | 'dispatch'
  | 'start'
  | 'progress'
  | 'tool'
  | 'end'
  | 'summary'
  | 'say'
  | 'hook'
  | 'idle'
  | 'result';

export interface DashboardEvent {
  /** Milliseconds since the epoch. */
  t: number;
  /** `coordinator`, or the tool-use id of the `Agent` call that started a member run. */
  lane: string;
  kind: DashboardEventKind;
  text: string;
  extra?: Record<string, unknown>;
}

export interface DashboardSource {
  /** Read whatever was appended since the last call; events are in time order. */
  poll(): DashboardEvent[];
  /** A short description for the page header and logs. */
  readonly label: string;
  /**
   * True once after the source started over (a transcript was truncated or rewritten): the last
   * poll replayed it from the beginning, so earlier events are void and the page must start over.
   */
  takeReset?(): boolean;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function short(s: unknown, n = 140): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

const AGENT_TOOLS = new Set(['Agent', 'Task']);

/** One-line description of a tool call. */
export function toolText(name: string, input: unknown): string {
  const i = isObject(input) ? input : {};
  if (name === 'Bash') return `$ ${short(i['command'], 120)}`;
  const file = str(i['file_path']) ?? str(i['notebook_path']);
  if (file) return `${name} ${file.split(/[\\/]/).slice(-2).join('/')}`;
  const mcp = /^mcp__(?:plugin_squad_)?squad_state__(.+)$/.exec(name);
  if (mcp) {
    const arg = str(i['key']) ?? str(i['dir']) ?? str(i['path']);
    return `squad_state.${mcp[1]}${arg ? ` ${arg}` : ''}`;
  }
  if (name === 'Skill') return `skill ${str(i['skill']) ?? ''}`.trim();
  if (name === 'Grep' || name === 'Glob') return `${name} ${short(i['pattern'], 80)}`;
  return name;
}

// ── line tailing ──────────────────────────────────────────────────────────────────────────────────

/** Follows one JSONL file, returning complete lines appended since the last read. */
export class JsonlTail {
  private offset = 0;
  private buf: Buffer = Buffer.alloc(0);
  /** Set when the file shrank and reading started over from byte zero. */
  rewound = false;
  constructor(readonly file: string) {}

  read(): Json[] {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      // Truncated or replaced: start over.
      this.offset = 0;
      this.buf = Buffer.alloc(0);
      this.rewound = true;
    }
    if (size === this.offset) return [];
    const fd = fs.openSync(this.file, 'r');
    try {
      const chunk = Buffer.alloc(size - this.offset);
      const read = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
      this.offset += read;
      this.buf = Buffer.concat([this.buf, chunk.subarray(0, read)]);
    } finally {
      fs.closeSync(fd);
    }
    const out: Json[] = [];
    let start = 0;
    for (let end = this.buf.indexOf(10); end !== -1; end = this.buf.indexOf(10, start)) {
      const line = this.buf.subarray(start, end).toString('utf8');
      start = end + 1;
      if (!line.trim()) continue;
      try {
        const v: unknown = JSON.parse(line);
        if (isObject(v)) out.push(v);
      } catch {
        // a corrupt line: skip it
      }
    }
    this.buf = Buffer.from(this.buf.subarray(start));
    return out;
  }
}

// ── Claude Code session transcripts ──────────────────────────────────────────────────────────────

/** Claude Code's config directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude');
}

/** The per-project transcript directory name: every character other than a letter or digit becomes `-`. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export interface ClaudeSessionFile {
  id: string;
  file: string;
  mtimeMs: number;
}

/** Sessions recorded for `cwd` (and its real path), newest first. */
export function findClaudeSessions(cwd: string, env: NodeJS.ProcessEnv = process.env): ClaudeSessionFile[] {
  const dirs = new Set<string>();
  const projects = path.join(claudeConfigDir(env), 'projects');
  dirs.add(path.join(projects, encodeClaudeProjectDir(path.resolve(cwd))));
  try {
    dirs.add(path.join(projects, encodeClaudeProjectDir(fs.realpathSync(cwd))));
  } catch {
    // cwd is gone: the resolved path is enough
  }
  const out: ClaudeSessionFile[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (st.isFile()) out.push({ id: name.slice(0, -'.jsonl'.length), file, mtimeMs: st.mtimeMs });
      } catch {
        // removed while listing
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

interface Subagent {
  tail: JsonlTail;
  lane: string;
  member: string;
  background: boolean;
  description: string;
  /** Polls this run's meta file has waited for its dispatch line in the main transcript. */
  waited: number;
}

interface MemberRun {
  member: string;
  background: boolean;
  ended: boolean;
}

/** Tags inside a `<task-notification>` (Claude Code's background-task completion message). */
function tag(text: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1]!.trim() : undefined;
}

function resultText(toolUseResult: unknown, content: unknown): string {
  if (isObject(toolUseResult) && Array.isArray(toolUseResult['content'])) {
    const parts = (toolUseResult['content'] as unknown[])
      .map((b) => (isObject(b) && b['type'] === 'text' ? str(b['text']) : undefined))
      .filter((s): s is string => !!s);
    if (parts.length) return parts.join('\n');
  }
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isObject(b) && b['type'] === 'text' ? str(b['text']) ?? '' : ''))
      .join('\n');
  }
  return '';
}

/**
 * Reads one Claude Code session: its transcript plus every subagent transcript, following appends
 * (including later `--continue` / `--resume` turns, which Claude Code appends to the same file).
 */
export class ClaudeTranscriptSource implements DashboardSource {
  readonly label: string;
  private main: JsonlTail;
  private readonly subagentDir: string;
  private readonly subagents = new Map<string, Subagent>();
  private readonly runs = new Map<string, MemberRun>();
  private turn = 0;
  private pendingPrompt = false;
  private idle = false;
  private model: string | undefined;
  private lastT = 0;
  private reset = false;
  /** Line types that were skipped, with counts (diagnostics only; never shown on the page). */
  readonly skipped = new Map<string, number>();

  constructor(readonly sessionFile: string) {
    this.main = new JsonlTail(sessionFile);
    this.subagentDir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
    this.label = `Claude Code session ${path.basename(sessionFile, '.jsonl')}`;
  }

  poll(): DashboardEvent[] {
    const out = this.read();
    if (!this.main.rewound && ![...this.subagents.values()].some((s) => s.tail.rewound)) return out;
    // A transcript shrank: what was read before no longer holds (runs that ended would never end
    // again), so drop everything and read every file from the beginning.
    this.main = new JsonlTail(this.sessionFile);
    this.subagents.clear();
    this.runs.clear();
    this.turn = 0;
    this.pendingPrompt = false;
    this.idle = false;
    this.model = undefined;
    this.lastT = 0;
    this.reset = true;
    return this.read();
  }

  takeReset(): boolean {
    const r = this.reset;
    this.reset = false;
    return r;
  }

  private read(): DashboardEvent[] {
    const out: DashboardEvent[] = [];
    for (const m of this.main.read()) this.mainLine(m, out);
    this.discoverSubagents();
    for (const s of this.subagents.values()) {
      if (!this.runs.has(s.lane)) {
        // Claude Code can write a member's meta file before the dispatch line that starts it: wait one
        // poll for the dispatch, then start the run from the meta file (a dispatch older than a truncated
        // transcript never arrives).
        if (s.waited++ < 1) continue;
        this.runs.set(s.lane, { member: s.member, background: s.background, ended: false });
        out.push({ t: this.lastT, lane: s.lane, kind: 'start', text: s.description, extra: { member: s.member, background: s.background } });
      }
      for (const m of s.tail.read()) this.memberLine(m, s.lane, out);
    }
    // Stable sort: lines from different files interleave by time; ties keep file order.
    return out.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map((x) => x.e);
  }

  private time(m: Json): number {
    const t = Date.parse(str(m['timestamp']) ?? '');
    if (Number.isFinite(t)) this.lastT = t;
    return this.lastT;
  }

  private skip(type: string): void {
    this.skipped.set(type, (this.skipped.get(type) ?? 0) + 1);
  }

  private discoverSubagents(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.subagentDir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = /^agent-(.+)\.meta\.json$/.exec(name);
      if (!m || this.subagents.has(m[1]!)) continue;
      let meta: Json;
      try {
        const v: unknown = JSON.parse(fs.readFileSync(path.join(this.subagentDir, name), 'utf8'));
        if (!isObject(v)) continue;
        meta = v;
      } catch {
        continue; // being written: try again on the next poll
      }
      const lane = str(meta['toolUseId']) ?? `agent-${m[1]}`;
      this.subagents.set(m[1]!, {
        tail: new JsonlTail(path.join(this.subagentDir, `agent-${m[1]}.jsonl`)),
        lane,
        member: str(meta['agentType']) ?? 'general-purpose',
        background: meta['requestShape'] === 'background',
        description: short(meta['description'], 120),
        waited: 0,
      });
    }
  }

  private dispatch(b: Json, lane: string, t: number, out: DashboardEvent[]): void {
    const id = str(b['id']);
    if (!id) return;
    const input = isObject(b['input']) ? b['input'] : {};
    const member = str(input['subagent_type']) ?? 'general-purpose';
    const background = input['run_in_background'] === true;
    const description = short(input['description'], 90);
    if (!this.runs.has(id)) this.runs.set(id, { member, background, ended: false });
    out.push({
      t,
      lane,
      kind: 'dispatch',
      text: `→ ${member}: ${description}${background ? ' (background)' : ''}`,
      extra: { member, target: id, background },
    });
    out.push({ t, lane: id, kind: 'start', text: description, extra: { member, background } });
  }

  private finish(lane: string, status: string, report: string, t: number, out: DashboardEvent[]): void {
    const run = this.runs.get(lane);
    if (!run) return;
    if (report.trim()) out.push({ t, lane, kind: 'summary', text: short(report, 600), extra: { status } });
    if (!run.ended) {
      run.ended = true;
      out.push({ t, lane, kind: 'end', text: status, extra: { status } });
    }
  }

  /** Tool calls and replies shared by the coordinator and member transcripts. */
  private assistant(m: Json, lane: string, t: number, out: DashboardEvent[]): void {
    const msg = isObject(m['message']) ? m['message'] : {};
    if (lane === 'coordinator') {
      const model = str(msg['model']);
      if (model && model !== '<synthetic>') this.model = model;
      if (this.pendingPrompt) {
        this.pendingPrompt = false;
        out.push({ t, lane, kind: 'session', text: `prompt ${this.turn} · ${this.model ?? 'claude'}`, extra: { run: this.turn, model: this.model } });
      }
      this.idle = false;
    }
    for (const b of Array.isArray(msg['content']) ? msg['content'] : []) {
      if (!isObject(b)) continue;
      if (b['type'] === 'tool_use' && AGENT_TOOLS.has(str(b['name']) ?? '')) this.dispatch(b, lane, t, out);
      else if (b['type'] === 'tool_use') out.push({ t, lane, kind: 'tool', text: toolText(str(b['name']) ?? 'tool', b['input']) });
      else if (b['type'] === 'text' && str(b['text'])?.trim()) out.push({ t, lane, kind: 'say', text: short(b['text'], 400) });
    }
  }

  /** Results of `Agent` calls: a finished foreground run, or a background launch acknowledgement. */
  private toolResults(m: Json, t: number, out: DashboardEvent[]): void {
    const msg = isObject(m['message']) ? m['message'] : {};
    for (const b of Array.isArray(msg['content']) ? msg['content'] : []) {
      if (!isObject(b) || b['type'] !== 'tool_result') continue;
      const id = str(b['tool_use_id']);
      if (!id || !this.runs.has(id)) continue;
      const r = m['toolUseResult'];
      const status = isObject(r) ? str(r['status']) : undefined;
      if (status === 'async_launched') continue; // still running; a task notification reports the end
      if (b['is_error'] === true) this.finish(id, 'failed', resultText(undefined, b['content']), t, out);
      else this.finish(id, status ?? 'completed', resultText(r, b['content']), t, out);
    }
  }

  private mainLine(m: Json, out: DashboardEvent[]): void {
    const type = str(m['type']) ?? '';
    const t = this.time(m);
    if (type === 'user') {
      const msg = isObject(m['message']) ? m['message'] : {};
      const content = msg['content'];
      if (typeof content === 'string') {
        const origin = isObject(m['origin']) ? str(m['origin']['kind']) : undefined;
        if (origin === 'task-notification' || content.trimStart().startsWith('<task-notification>')) {
          const lane = tag(content, 'tool-use-id');
          if (lane) this.finish(lane, tag(content, 'status') ?? 'completed', tag(content, 'result') ?? '', t, out);
          return;
        }
        if (m['isMeta'] === true || m['promptSource'] === 'system') return;
        const command = tag(content, 'command-name');
        if (!command && content.trimStart().startsWith('<')) return; // reminders, command output and other harness text
        this.turn += 1;
        this.pendingPrompt = true;
        return;
      }
      this.toolResults(m, t, out);
      return;
    }
    if (type === 'assistant') return this.assistant(m, 'coordinator', t, out);
    if (type === 'attachment') {
      const a = isObject(m['attachment']) ? m['attachment'] : {};
      const at = str(a['type']) ?? '';
      if (at.startsWith('hook_') && at !== 'hook_additional_context') {
        const event = str(a['hookEvent']) ?? str(a['hookName']) ?? 'hook';
        out.push({ t, lane: 'coordinator', kind: 'hook', text: `hook ${event}`, extra: { status: at.slice(5) } });
        return;
      }
      return this.skip(`attachment:${at}`);
    }
    if (type === 'system') {
      const sub = str(m['subtype']);
      if (sub === 'stop_hook_summary' || sub === 'turn_duration') {
        if (sub === 'stop_hook_summary' && Number(m['hookCount'] ?? 0) > 0) {
          out.push({ t, lane: 'coordinator', kind: 'hook', text: 'hook Stop', extra: { status: (m['hookErrors'] as unknown[] | undefined)?.length ? 'error' : 'success' } });
        }
        if (!this.idle && this.turn > 0) {
          this.idle = true;
          out.push({ t, lane: 'coordinator', kind: 'idle', text: `prompt ${this.turn} waiting for input`, extra: { run: this.turn } });
        }
        return;
      }
      return this.skip(`system:${sub ?? ''}`);
    }
    this.skip(type || '(none)');
  }

  private memberLine(m: Json, lane: string, out: DashboardEvent[]): void {
    const type = str(m['type']) ?? '';
    const t = this.time(m);
    if (type === 'assistant') return this.assistant(m, lane, t, out);
    if (type === 'user') {
      if (typeof (isObject(m['message']) ? m['message']['content'] : undefined) !== 'string') this.toolResults(m, t, out);
      return; // the member's prompt is the coordinator's dispatch
    }
    this.skip(type || '(none)');
  }
}

// ── stream-json logs (second source) ────────────────────────────────────────────────────────────

/** `claude -p --output-format stream-json --verbose` logs, read in order (one per prompt). */
export class StreamJsonSource implements DashboardSource {
  readonly label: string;
  private readonly tails: { tail: JsonlTail; run: number }[];
  private readonly laneOf = new Map<string, string>();
  private readonly shells = new Map<string, { lane: string; description: string }>();
  private lastT = 0;

  constructor(files: string[]) {
    this.tails = files.map((f, i) => ({ tail: new JsonlTail(f), run: i + 1 }));
    this.label = `stream-json ${files.map((f) => path.basename(f)).join(', ')}`;
  }

  poll(): DashboardEvent[] {
    const out: DashboardEvent[] = [];
    for (const s of this.tails) {
      if (this.lastT === 0) {
        try {
          const st = fs.statSync(s.tail.file);
          this.lastT = st.birthtimeMs || st.mtimeMs;
        } catch {
          // not created yet
        }
      }
      for (const m of s.tail.read()) this.ingest(m, s.run, out);
    }
    return out;
  }

  private ingest(m: Json, run: number, out: DashboardEvent[]): void {
    const ts = Date.parse(str(m['timestamp']) ?? '');
    if (Number.isFinite(ts)) this.lastT = ts;
    const t = this.lastT || Date.now();
    const push = (e: Omit<DashboardEvent, 't'> & { t?: number }) => out.push({ ...e, t: e.t ?? t });
    const type = m['type'];
    const sub = m['subtype'];
    const taskId = str(m['task_id']);
    const toolUseId = str(m['tool_use_id']);
    const patch = isObject(m['patch']) ? m['patch'] : undefined;
    if (type === 'system' && sub === 'init') {
      push({ lane: 'coordinator', kind: 'session', text: `prompt ${run} · ${str(m['model']) ?? 'claude'}`, extra: { run, model: m['model'] } });
    } else if (type === 'system' && sub === 'hook_response') {
      push({ lane: 'coordinator', kind: 'hook', text: `hook ${str(m['hook_event']) ?? str(m['hook_name']) ?? ''}`.trim() });
    } else if (type === 'system' && sub === 'task_started' && m['task_type'] === 'local_bash' && taskId) {
      const parent = str(m['parent_task_id']);
      const lane = (parent && this.laneOf.get(parent)) || 'coordinator';
      this.shells.set(taskId, { lane, description: str(m['description']) ?? '' });
      push({ lane, kind: 'tool', text: `background: ${short(m['description'], 110)}` });
    } else if (type === 'system' && sub === 'task_started' && toolUseId) {
      this.laneOf.set(toolUseId, toolUseId);
      if (taskId) this.laneOf.set(taskId, toolUseId);
      push({ lane: toolUseId, kind: 'start', text: short(m['description'], 120), extra: { member: m['subagent_type'], background: !!m['is_backgrounded'] } });
    } else if (type === 'system' && sub === 'task_progress' && taskId && this.shells.has(taskId)) {
      // shell progress: nothing to show
    } else if (type === 'system' && sub === 'task_progress') {
      const lane = (toolUseId && this.laneOf.get(toolUseId)) || (taskId && this.laneOf.get(taskId));
      const usage = isObject(m['usage']) ? m['usage'] : {};
      if (lane) push({ lane, kind: 'progress', text: short(m['description'], 120), extra: { tokens: usage['total_tokens'] } });
    } else if (type === 'system' && sub === 'task_updated' && patch && str(patch['status']) && taskId && this.shells.has(taskId)) {
      const sh = this.shells.get(taskId)!;
      const status = str(patch['status'])!;
      if (status !== 'running') push({ lane: sh.lane, kind: 'tool', text: `${status === 'completed' ? 'finished' : status}: ${short(sh.description, 100)}` });
    } else if (type === 'system' && sub === 'task_updated' && patch && str(patch['status'])) {
      const lane = taskId && this.laneOf.get(taskId);
      const status = str(patch['status'])!;
      const end = Number(patch['end_time']);
      if (lane && status !== 'running') push({ lane, kind: 'end', t: Number.isFinite(end) && end > 0 ? end : t, text: status, extra: { status } });
    } else if (type === 'system' && sub === 'task_notification' && taskId && this.shells.has(taskId)) {
      // shell completion: reported by task_updated
    } else if (type === 'system' && sub === 'task_notification') {
      const lane = (toolUseId && this.laneOf.get(toolUseId)) || (taskId && this.laneOf.get(taskId));
      if (lane) push({ lane, kind: 'summary', text: short(m['summary'], 600), extra: { status: m['status'] } });
    } else if (type === 'assistant') {
      const parent = str(m['parent_tool_use_id']);
      const lane = parent ? (this.laneOf.get(parent) ?? parent) : 'coordinator';
      const msg = isObject(m['message']) ? m['message'] : {};
      for (const b of Array.isArray(msg['content']) ? msg['content'] : []) {
        if (!isObject(b)) continue;
        const input = isObject(b['input']) ? b['input'] : {};
        if (b['type'] === 'tool_use' && AGENT_TOOLS.has(str(b['name']) ?? '') && str(b['id'])) {
          const id = str(b['id'])!;
          this.laneOf.set(id, id);
          const member = str(input['subagent_type']) ?? 'general-purpose';
          const background = input['run_in_background'] === true;
          push({ lane, kind: 'dispatch', text: `→ ${member}: ${short(input['description'], 90)}${background ? ' (background)' : ''}`, extra: { member, target: id, background } });
        } else if (b['type'] === 'tool_use') {
          push({ lane, kind: 'tool', text: toolText(str(b['name']) ?? 'tool', b['input']) });
        } else if (b['type'] === 'text' && str(b['text'])?.trim()) {
          push({ lane, kind: 'say', text: short(b['text'], 400) });
        }
      }
    } else if (type === 'result') {
      const secs = Math.round(Number(m['duration_ms'] ?? 0) / 1000);
      push({ lane: 'coordinator', kind: 'result', text: `${m['is_error'] ? 'failed' : 'done'} · ${m['num_turns']} turns · ${secs} s`, extra: { error: !!m['is_error'], run } });
    }
  }
}
