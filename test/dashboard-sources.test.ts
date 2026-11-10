/**
 * Dashboard sources (#2459): Claude Code session transcripts, and stream-json logs as a second source.
 *
 * The fixture under test-fixtures/claude-dashboard/ is a real Claude Code 2.1 headless session,
 * scrubbed by test-fixtures/claude-dashboard/scrub.mjs (paths, ids and account details replaced;
 * request blobs, prompt snapshots, environment and thinking blocks dropped). It covers two members
 * dispatched in parallel in the background, a `--continue` turn appended to the same file with a
 * foreground member, hook events, and one line type the reader doesn't know.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClaudeTranscriptSource,
  StreamJsonSource,
  encodeClaudeProjectDir,
  findClaudeSessions,
  type DashboardEvent,
} from '../packages/squad-cli/src/cli/dashboard/sources.js';

const FIXTURE = path.resolve(__dirname, '..', 'test-fixtures', 'claude-dashboard');
const SESSION = 'b7e1c0de-0000-4000-8000-000000000001';
const SESSION_FILE = path.join(FIXTURE, 'projects', '-work-demo', `${SESSION}.jsonl`);
const SCRIBE_BG = 'toolu_01C2RZuAWNGpjJi69ECvmx5U';
const RAI_BG = 'toolu_01QGhC1ThYvZWiPtKrsd6A9T';
const SCRIBE_FG = 'toolu_01U3jj6SASQTEoxLaMh53Y8v';

const of = (events: DashboardEvent[], lane: string, kind?: string) =>
  events.filter((e) => e.lane === lane && (!kind || e.kind === kind));

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-dash-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('Claude transcript source', () => {
  const source = new ClaudeTranscriptSource(SESSION_FILE);
  const events = source.poll();

  it('emits events in time order', () => {
    const times = events.map((e) => e.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new ClaudeTranscriptSource(SESSION_FILE).poll()).toEqual(events);
  });

  it('shows two background members running in parallel, each in its own lane', () => {
    const dispatches = of(events, 'coordinator', 'dispatch');
    expect(dispatches.slice(0, 2).map((e) => e.extra)).toEqual([
      { member: 'scribe', target: SCRIBE_BG, background: true },
      { member: 'rai', target: RAI_BG, background: true },
    ]);
    const start = (lane: string) => of(events, lane, 'start')[0]!.t;
    const end = (lane: string) => of(events, lane, 'end')[0]!.t;
    expect(start(RAI_BG)).toBeLessThan(end(SCRIBE_BG));
    expect(start(SCRIBE_BG)).toBeLessThan(end(RAI_BG));
    for (const lane of [SCRIBE_BG, RAI_BG]) {
      expect(of(events, lane, 'end').map((e) => e.text), lane).toEqual(['completed']);
      expect(of(events, lane, 'summary')[0]!.text.length, lane).toBeGreaterThan(10);
    }
    // The member's own tool calls land in its lane, read from its subagent transcript.
    expect(of(events, SCRIBE_BG, 'tool').map((e) => e.text)).toEqual(['$ ls .squad', '$ command ls .squad']);
  });

  it('reads a --continue turn appended to the same session as prompt 2, with a foreground member', () => {
    expect(of(events, 'coordinator', 'session').map((e) => e.extra?.['run'])).toEqual([1, 2]);
    expect(of(events, SCRIBE_FG, 'start')[0]!.extra).toEqual({ member: 'scribe', background: false });
    expect(of(events, SCRIBE_FG, 'summary').map((e) => e.text)).toEqual(['again']);
    expect(of(events, SCRIBE_FG, 'end')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ lane: 'coordinator', kind: 'idle', extra: { run: 2 } });
  });

  it('reports hook events', () => {
    const hooks = of(events, 'coordinator', 'hook').map((e) => e.text);
    expect(hooks[0]).toBe('hook SessionStart');
    expect(hooks.filter((h) => h === 'hook PostToolUse')).toHaveLength(3);
    expect(hooks).toContain('hook Stop');
  });

  it('skips unknown line types and never passes their content on', () => {
    expect(source.skipped.get('future-line-type')).toBe(1);
    expect(JSON.stringify(events)).not.toContain('must not be shown');
    expect(JSON.stringify(events)).not.toContain('system-reminder');
  });

  it('reads appends incrementally, including member files created later', () => {
    const dir = path.join(tmp, 'projects', '-work-demo');
    fs.cpSync(path.dirname(SESSION_FILE), dir, { recursive: true });
    const file = path.join(dir, `${SESSION}.jsonl`);
    const full = fs.readFileSync(file, 'utf8');
    const cut = full.indexOf('\n', Math.floor(full.length / 2));
    fs.writeFileSync(file, `${full.slice(0, cut + 1)}${full.slice(cut + 1, cut + 20)}`); // ends mid-line
    const subagents = path.join(dir, SESSION, 'subagents');
    const held = path.join(tmp, 'held');
    fs.renameSync(subagents, held);

    const live = new ClaudeTranscriptSource(file);
    const first = live.poll();
    expect(first.length).toBeGreaterThan(0);
    expect(live.poll()).toEqual([]);
    fs.writeFileSync(file, full);
    fs.renameSync(held, subagents);
    const rest = live.poll();

    const kinds = (es: DashboardEvent[]) => es.map((e) => `${e.lane} ${e.kind} ${e.text}`).sort();
    expect(kinds([...first, ...rest])).toEqual(kinds(events));
  });

  it('starts each member once when its meta file is written before the dispatch line', () => {
    const dir = path.join(tmp, 'projects', '-work-demo');
    fs.cpSync(path.dirname(SESSION_FILE), dir, { recursive: true });
    const file = path.join(dir, `${SESSION}.jsonl`);
    const full = fs.readFileSync(file, 'utf8');
    const dispatchAt = full.indexOf('"name":"Agent"');
    fs.writeFileSync(file, full.slice(0, full.lastIndexOf('\n', dispatchAt) + 1));

    const live = new ClaudeTranscriptSource(file);
    const before = live.poll();
    expect(before.filter((e) => e.kind === 'start')).toEqual([]);
    fs.writeFileSync(file, full);
    const all = [...before, ...live.poll(), ...live.poll()];
    for (const lane of [SCRIBE_BG, RAI_BG, SCRIBE_FG]) expect(of(all, lane, 'start'), lane).toHaveLength(1);
  });

  it('starts over when the transcript is rewritten shorter, so finished members end again', () => {
    const dir = path.join(tmp, 'projects', '-work-demo');
    fs.cpSync(path.dirname(SESSION_FILE), dir, { recursive: true });
    const file = path.join(dir, `${SESSION}.jsonl`);
    const full = fs.readFileSync(file, 'utf8');
    const live = new ClaudeTranscriptSource(file);
    const first = live.poll();
    expect(of(first, SCRIBE_FG, 'end')).toHaveLength(1);
    expect(live.takeReset()).toBe(false);

    // Rewritten shorter, keeping every dispatch and result: drop the hook attachments.
    const shorter = full.split('\n').filter((l) => !l.includes('"type":"attachment"')).join('\n');
    expect(shorter.length).toBeLessThan(full.length);
    fs.writeFileSync(file, shorter);
    const again = live.poll();
    expect(live.takeReset()).toBe(true);
    expect(live.takeReset()).toBe(false);
    for (const lane of [SCRIBE_BG, RAI_BG, SCRIBE_FG]) {
      expect(of(again, lane, 'start'), lane).toHaveLength(1);
      expect(of(again, lane, 'end'), lane).toHaveLength(1);
    }
    expect(again).toEqual(new ClaudeTranscriptSource(file).poll());
  });

  it('starts a member from its meta file when the dispatch never arrives', () => {
    const dir = path.join(tmp, 'projects', '-work-demo');
    fs.cpSync(path.dirname(SESSION_FILE), dir, { recursive: true });
    const file = path.join(dir, `${SESSION}.jsonl`);
    fs.writeFileSync(file, '');
    const live = new ClaudeTranscriptSource(file);
    expect(live.poll()).toEqual([]);
    const later = live.poll();
    expect(of(later, RAI_BG, 'start')[0]?.extra).toEqual({ member: 'rai', background: true });
    expect(of(later, RAI_BG, 'say')).toHaveLength(1);
  });
});

describe('Claude session discovery', () => {
  it('encodes the project directory the way Claude Code does', () => {
    expect(encodeClaudeProjectDir('/private/tmp/my_repo.v2')).toBe('-private-tmp-my-repo-v2');
    expect(encodeClaudeProjectDir('C:\\src\\squad')).toBe('C--src-squad');
  });

  it('finds sessions under CLAUDE_CONFIG_DIR, newest first', () => {
    const dir = path.join(tmp, 'projects', encodeClaudeProjectDir(path.resolve('/work/demo')));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'new.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'notes.txt'), '');
    fs.utimesSync(path.join(dir, 'old.jsonl'), new Date(1_000_000), new Date(1_000_000));
    const found = findClaudeSessions('/work/demo', { CLAUDE_CONFIG_DIR: tmp });
    expect(found.map((s) => s.id)).toEqual(['new', 'old']);
    expect(findClaudeSessions('/elsewhere', { CLAUDE_CONFIG_DIR: tmp })).toEqual([]);
  });
});

describe('stream-json source', () => {
  it('maps init, dispatch, member progress, notification and result', () => {
    const lines = [
      { type: 'system', subtype: 'init', model: 'claude-haiku-5-5' },
      { type: 'system', subtype: 'hook_response', hook_event: 'SessionStart' },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'scribe', description: 'log it', run_in_background: true } }] },
      },
      { type: 'system', subtype: 'task_started', task_id: 'task1', tool_use_id: 'tu1', description: 'log it', subagent_type: 'scribe', is_backgrounded: true },
      { type: 'assistant', parent_tool_use_id: 'tu1', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] } },
      { type: 'system', subtype: 'task_notification', task_id: 'task1', status: 'completed', summary: 'Logged <b>it</b>' },
      { type: 'system', subtype: 'task_updated', task_id: 'task1', patch: { status: 'completed', end_time: 5000 } },
      { type: 'result', is_error: false, num_turns: 3, duration_ms: 4200 },
      { type: 'mystery' },
    ];
    const file = path.join(tmp, 'run.jsonl');
    fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    const events = new StreamJsonSource([file]).poll();
    expect(events.map((e) => [e.lane, e.kind, e.text])).toEqual([
      ['coordinator', 'session', 'prompt 1 · claude-haiku-5-5'],
      ['coordinator', 'hook', 'hook SessionStart'],
      ['coordinator', 'dispatch', '→ scribe: log it (background)'],
      ['tu1', 'start', 'log it'],
      ['tu1', 'tool', '$ ls'],
      ['tu1', 'summary', 'Logged <b>it</b>'], // passed through as data; the page escapes it
      ['tu1', 'end', 'completed'],
      ['coordinator', 'result', 'done · 3 turns · 4 s'],
    ]);
    expect(events.find((e) => e.kind === 'end')!.t).toBe(5000);
  });
});
