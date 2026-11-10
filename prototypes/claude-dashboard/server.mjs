// Squad team dashboard (prototype): tails Claude Code stream-json logs and streams a per-member timeline over SSE.
// Usage: node server.mjs [port] log.jsonl [log.jsonl ...]   (claude -p --output-format stream-json --verbose logs)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 4180);
const logs = process.argv.slice(3);
if (!logs.length) { console.error('usage: node server.mjs [port] log.jsonl [log.jsonl ...]'); process.exit(2); }

/** Normalized events, in order: { seq, t, lane, kind, text, extra } */
const events = [];
const clients = new Set();
const laneOf = new Map(); // tool_use_id or task_id -> lane id
const shells = new Map(); // background shell task_id -> { lane, description }
let lastT = null; // set from each log's creation time, then from message timestamps

const short = (s, n = 140) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function push(e) {
  const ev = { seq: events.length, ...e, t: e.t ?? lastT };
  events.push(ev);
  const data = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(data);
}

function toolText(b) {
  const i = b.input ?? {};
  if (b.name === 'Bash') return `$ ${short(i.command, 120)}`;
  if (i.file_path) return `${b.name} ${String(i.file_path).split('/').slice(-2).join('/')}`;
  if (b.name.startsWith('mcp__squad_state__')) return `squad_state.${b.name.slice(18)}${i.key ? ` ${i.key}` : i.dir ? ` ${i.dir}` : ''}`;
  if (b.name === 'Skill') return `skill ${i.skill}`;
  return b.name;
}

function ingest(m, run) {
  if (m.timestamp) lastT = Date.parse(m.timestamp) || lastT;
  if (m.type === 'system' && m.subtype === 'init') {
    push({ lane: 'coordinator', kind: 'session', text: `session (prompt ${run}) · ${m.model}`, extra: { run } });
  } else if (m.type === 'system' && m.subtype === 'hook_response') {
    push({ lane: 'coordinator', kind: 'hook', text: `hook ${m.hook_event ?? m.hook_name ?? ''}`.trim() });
  } else if (m.type === 'system' && m.subtype === 'task_started' && m.task_type === 'local_bash') {
    // A background shell command, not a subagent: activity on the member that owns it (or the coordinator).
    const lane = (m.parent_task_id && laneOf.get(m.parent_task_id)) || 'coordinator';
    shells.set(m.task_id, { lane, description: m.description });
    push({ lane, kind: 'tool', text: `background: ${short(m.description, 110)}` });
  } else if (m.type === 'system' && m.subtype === 'task_started') {
    const lane = m.tool_use_id;
    laneOf.set(m.tool_use_id, lane);
    laneOf.set(m.task_id, lane);
    push({ lane, kind: 'start', text: short(m.description, 120), extra: { member: m.subagent_type, background: !!m.is_backgrounded } });
  } else if (m.type === 'system' && m.subtype === 'task_progress' && shells.has(m.task_id)) {
    // shell progress: nothing to show
  } else if (m.type === 'system' && m.subtype === 'task_progress') {
    const lane = laneOf.get(m.tool_use_id) ?? laneOf.get(m.task_id);
    if (lane) push({ lane, kind: 'progress', text: short(m.description, 120), extra: { tokens: m.usage?.total_tokens } });
  } else if (m.type === 'system' && m.subtype === 'task_updated' && m.patch?.status && shells.has(m.task_id)) {
    const sh = shells.get(m.task_id);
    if (m.patch.status !== 'running') push({ lane: sh.lane, kind: 'tool', text: `${m.patch.status === 'completed' ? 'finished' : m.patch.status}: ${short(sh.description, 100)}` });
  } else if (m.type === 'system' && m.subtype === 'task_updated' && m.patch?.status) {
    const lane = laneOf.get(m.task_id);
    if (lane && m.patch.status !== 'running') push({ lane, kind: 'end', t: m.patch.end_time ?? lastT, text: m.patch.status, extra: { status: m.patch.status } });
  } else if (m.type === 'system' && m.subtype === 'task_notification' && shells.has(m.task_id)) {
    // shell completion: reported via task_updated
  } else if (m.type === 'system' && m.subtype === 'task_notification') {
    const lane = laneOf.get(m.tool_use_id) ?? laneOf.get(m.task_id);
    if (lane) push({ lane, kind: 'summary', text: short(m.summary, 600), extra: { status: m.status } });
  } else if (m.type === 'assistant') {
    const lane = m.parent_tool_use_id ? (laneOf.get(m.parent_tool_use_id) ?? m.parent_tool_use_id) : 'coordinator';
    for (const b of m.message?.content ?? []) {
      if (b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) {
        laneOf.set(b.id, b.id);
        push({ lane: 'coordinator', kind: 'dispatch', text: `→ ${b.input?.subagent_type}: ${short(b.input?.description, 90)}${b.input?.run_in_background ? ' (background)' : ''}`, extra: { member: b.input?.subagent_type, target: b.id } });
      } else if (b.type === 'tool_use') {
        push({ lane, kind: 'tool', text: toolText(b) });
      } else if (b.type === 'text' && b.text.trim()) {
        push({ lane, kind: 'say', text: short(b.text, 400) });
      }
    }
  } else if (m.type === 'result') {
    push({ lane: 'coordinator', kind: 'result', text: `${m.is_error ? 'failed' : 'done'} · ${m.num_turns} turns · ${Math.round((m.duration_ms ?? 0) / 1000)} s`, extra: { error: !!m.is_error, run } });
  }
}

// Tail each log in order (run 1, then run 2), following appends.
const state = logs.map((file, i) => ({ file, run: i + 1, offset: 0, buf: '' }));
function pump() {
  for (const s of state) {
    if (!fs.existsSync(s.file)) continue;
    const st = fs.statSync(s.file);
    const size = st.size;
    if (s.offset === 0 && size > 0) lastT = Math.max(lastT ?? 0, st.birthtimeMs || st.mtimeMs);
    if (size <= s.offset) continue;
    const fd = fs.openSync(s.file, 'r');
    const chunk = Buffer.alloc(size - s.offset);
    fs.readSync(fd, chunk, 0, chunk.length, s.offset);
    fs.closeSync(fd);
    s.offset = size;
    s.buf += chunk.toString('utf8');
    const lines = s.buf.split('\n');
    s.buf = lines.pop();
    for (const line of lines) {
      try {
        ingest(JSON.parse(line), s.run);
      } catch {
        // partial or non-JSON line
      }
    }
  }
}
pump();
setInterval(pump, 1000);

http
  .createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (const ev of events) res.write(`data: ${JSON.stringify(ev)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(here, 'index.html')));
  })
  .listen(port, '127.0.0.1', () => console.log(`squad dashboard: http://localhost:${port}/  (logs: ${logs.join(', ')})`));
