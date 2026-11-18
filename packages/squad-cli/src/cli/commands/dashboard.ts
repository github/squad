/**
 * `squad dashboard` (#2460): a local web page showing the team's Claude Code activity live.
 *
 * It reads the Claude Code session transcripts for this directory (see dashboard/sources.ts) and
 * follows the newest session, moving to a new one when it starts; `--session` pins one, and
 * `--stream` reads stream-json logs instead. One dashboard runs per directory: starting it again
 * reuses the running one, through a state file under the Squad home checked against /health, and
 * a lock file makes the check-and-start one step.
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClaudeTranscriptSource,
  StreamJsonSource,
  findClaudeSessions,
  type DashboardSource,
} from '../dashboard/sources.js';
import { startDashboardServer, DASHBOARD_HOST, type DashboardMeta } from '../dashboard/server.js';

export const DASHBOARD_USAGE = `Usage: squad dashboard [start|stop|status] [options]

  start (default)     Serve the dashboard for this directory, or show the running one
  stop                Stop this directory's dashboard
  status              Show whether this directory's dashboard is running

Options:
  --port <n>          Port on 127.0.0.1 (default: first free from 4280)
  --session <id>      Follow one Claude Code session (default: the newest)
  --stream <file>     Read claude -p stream-json logs instead (repeatable)
  --detach            Run in the background and return
  --open              Open the page in the browser (not when SQUAD_DASHBOARD_NO_OPEN is set)
  --json              Print the result as JSON`;

const DEFAULT_PORT = 4280;
const PORT_TRIES = 20;

interface Options {
  action: 'start' | 'stop' | 'status';
  port?: number;
  session?: string;
  streams: string[];
  detach: boolean;
  open: boolean;
  json: boolean;
}

export interface DashboardState {
  pid: number;
  port: number;
  url: string;
  root: string;
  startedAt: string;
}

class UsageError extends Error {}

export function parseDashboardArgs(args: string[]): Options {
  const o: Options = { action: 'start', streams: [], detach: false, open: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const value = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === 'start' || a === 'stop' || a === 'status') o.action = a;
    else if (a === '--port') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new UsageError('--port must be a port number');
      o.port = n;
    } else if (a === '--session') o.session = value();
    else if (a === '--stream') o.streams.push(path.resolve(value()));
    else if (a === '--detach') o.detach = true;
    else if (a === '--open') o.open = true;
    else if (a === '--json') o.json = true;
    else throw new UsageError(`Unknown argument: ${a}`);
  }
  return o;
}

/**
 * The state file for the dashboard serving `root`, under the Squad home (`SQUAD_HOME`, else
 * `~/.squad`). Not the temp directory: Claude Code gives its Bash tool a TMPDIR of its own, and
 * `/squad:dashboard` and a terminal `squad dashboard` must find the same dashboard.
 */
export function dashboardStatePath(root: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = crypto.createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 16);
  const home = env['SQUAD_HOME'] ? path.resolve(env['SQUAD_HOME']) : path.join(os.homedir(), '.squad');
  return path.join(home, 'dashboards', `${key}.json`);
}

interface Health {
  service?: string;
  pid?: number;
  root?: string;
}

async function health(port: number, timeoutMs: number): Promise<Health | undefined> {
  try {
    const r = await fetch(`http://${DASHBOARD_HOST}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return (await r.json()) as Health;
  } catch {
    return undefined;
  }
}

function readState(root: string): DashboardState | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(dashboardStatePath(root), 'utf8')) as DashboardState;
    return typeof s.pid === 'number' && typeof s.port === 'number' ? s : undefined;
  } catch {
    return undefined;
  }
}

function writeState(root: string, state: DashboardState): void {
  const file = dashboardStatePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state)}\n`);
}

function removeState(root: string, pid?: number): void {
  const s = readState(root);
  if (pid !== undefined && s && s.pid !== pid) return;
  fs.rmSync(dashboardStatePath(root), { force: true });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Claims the right to start `root`'s dashboard: a lock file beside the state file, created with
 * `wx` so only one process gets it. A second start waits for the holder to finish (it then finds
 * the dashboard running), and takes over a lock whose holder has died. Returns the release function.
 */
export async function claimDashboardStart(root: string, timeoutMs = 15_000): Promise<() => void> {
  const lock = dashboardStatePath(root).replace(/\.json$/, '.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx' });
      return () => {
        try {
          if (Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.rmSync(lock, { force: true });
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    let holder = NaN;
    try {
      holder = Number.parseInt(fs.readFileSync(lock, 'utf8'), 10);
    } catch {
      continue; // released between our attempt and the read
    }
    if (!Number.isInteger(holder) || !alive(holder) || Date.now() > deadline) {
      // A dead holder (or one stuck past the deadline) left the lock behind: take it over.
      fs.rmSync(lock, { force: true });
      continue;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The running dashboard for `root`, confirmed through its /health endpoint. */
export async function runningDashboard(root: string): Promise<DashboardState | undefined> {
  const want = path.resolve(root);
  const s = readState(root);
  if (s) {
    const h = await health(s.port, 1500);
    if (h?.service === 'squad-dashboard' && h.pid === s.pid && h.root === want) return s;
    removeState(root);
  }
  // No state file (removed, or written by an older build): look on the default ports.
  const ports = Array.from({ length: PORT_TRIES }, (_, i) => DEFAULT_PORT + i);
  const found = await Promise.all(ports.map(async (port) => ({ port, h: await health(port, 500) })));
  const hit = found.find(({ h }) => h?.service === 'squad-dashboard' && h.root === want && typeof h.pid === 'number');
  if (!hit) return undefined;
  const state: DashboardState = { pid: hit.h!.pid!, port: hit.port, url: `http://${DASHBOARD_HOST}:${hit.port}/`, root: want, startedAt: '' };
  writeState(root, state);
  return state;
}

function uiDir(): string {
  // dist/cli/commands/dashboard.js → dist/dashboard-ui (src/… → src/dashboard-ui when run from source).
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dashboard-ui');
}

/** `# Name — Role` from each charter in `.squad/agents/`. */
export function readRoster(root: string): Record<string, string> {
  const roles: Record<string, string> = {};
  const agents = path.join(root, '.squad', 'agents');
  let names: string[];
  try {
    names = fs.readdirSync(agents);
  } catch {
    return roles;
  }
  for (const name of names) {
    let heading: string | undefined;
    try {
      heading = fs.readFileSync(path.join(agents, name, 'charter.md'), 'utf8').split('\n').find((l) => l.startsWith('# '));
    } catch {
      continue;
    }
    const role = heading?.replace(/^#\s+/, '').split(/\s+[—–-]\s+/)[1]?.trim();
    if (role) roles[name] = role.slice(0, 40);
  }
  return roles;
}

function readMeta(root: string, source: () => string): () => DashboardMeta {
  let owner = '';
  let repo = path.basename(root);
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
    if (m) [owner, repo] = [m[1]!, m[2]!];
  } catch {
    // not a git checkout, or no origin
  }
  return () => ({ owner, repo, roles: readRoster(root), source: source() });
}

/** Chooses what to read: stream-json logs, a pinned session, or the newest session (moving to new ones). */
class SessionFollower {
  private current: { id: string; source: DashboardSource } | undefined;
  private readonly known = new Set<string>();
  private checkedAt = 0;
  private stream: DashboardSource | undefined;

  constructor(
    private readonly root: string,
    private readonly opts: Options,
  ) {
    if (opts.streams.length) this.stream = new StreamJsonSource(opts.streams);
  }

  get sessionId(): string | undefined {
    return this.current?.id;
  }

  get label(): string {
    if (this.stream) return 'stream-json';
    return this.current ? `Session ${this.current.id.slice(0, 8)}` : 'Waiting for a Claude Code session';
  }

  source = (): DashboardSource | undefined => {
    if (this.stream) return this.stream;
    const now = Date.now();
    if (this.current && now - this.checkedAt < 2000) return this.current.source;
    this.checkedAt = now;
    const sessions = findClaudeSessions(this.root);
    let pick: (typeof sessions)[number] | undefined;
    if (this.opts.session) {
      pick = sessions.find((s) => s.id === this.opts.session) ?? sessions.find((s) => s.id.startsWith(this.opts.session!));
    } else if (!this.current) {
      pick = sessions[0];
    } else {
      // Move only to a session that appeared since: two sessions writing at once must not flip the page.
      pick = sessions.find((s) => !this.known.has(s.id));
    }
    for (const s of sessions) this.known.add(s.id);
    if (pick && pick.id !== this.current?.id) this.current = { id: pick.id, source: new ClaudeTranscriptSource(pick.file) };
    return this.current?.source;
  };
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // no browser opener: the URL is printed anyway
  }
}

function report(o: Options, state: DashboardState, note: string): void {
  if (o.json) console.log(JSON.stringify({ running: true, url: state.url, pid: state.pid, port: state.port }));
  else console.log(`${note}: ${state.url}`);
  if (o.open && !process.env['SQUAD_DASHBOARD_NO_OPEN']) openBrowser(state.url);
}

async function serve(root: string, o: Options): Promise<number> {
  // Checking for a running dashboard and starting one must be one step: two starts at once in
  // one directory would otherwise both serve, and `stop` would find only one of them.
  const release = await claimDashboardStart(root);
  try {
    const running = await runningDashboard(root);
    if (running) {
      if (!o.detach) report(o, running, 'Squad dashboard already running');
      return 0;
    }
    return await listen(root, o, release);
  } finally {
    release();
  }
}

async function listen(root: string, o: Options, release: () => void): Promise<number> {
  const follower = new SessionFollower(root, o);
  const ports = o.port !== undefined ? [o.port] : [...Array.from({ length: PORT_TRIES }, (_, i) => DEFAULT_PORT + i), 0];
  let server: Awaited<ReturnType<typeof startDashboardServer>> | undefined;
  for (const port of ports) {
    try {
      server = await startDashboardServer({
        uiDir: uiDir(),
        port,
        meta: readMeta(root, () => follower.label),
        source: follower.source,
        health: () => ({ pid: process.pid, root, session: follower.sessionId ?? null }),
      });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || o.port !== undefined) throw err;
    }
  }
  if (!server) throw new Error('No free port for the dashboard');
  const state: DashboardState = { pid: process.pid, port: server.port, url: server.url, root, startedAt: new Date().toISOString() };
  writeState(root, state);
  release();
  const stop = () => {
    removeState(root, process.pid);
    void server!.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (!o.detach) report(o, state, 'Squad dashboard (Ctrl+C to stop)');
  return new Promise<number>(() => {}); // runs until stopped
}

async function startDetached(root: string, o: Options, argv: string[]): Promise<number> {
  const entry = process.argv[1];
  if (!entry) throw new Error('Cannot find the squad CLI entry point to start the dashboard');
  const childArgs = [entry, 'dashboard', ...argv.filter((a) => a !== '--detach' && a !== '--open' && a !== '--json'), '--detach'];
  const child = spawn(process.execPath, childArgs, { cwd: root, detached: true, stdio: 'ignore', env: process.env, windowsHide: true });
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    // Usually our child; another start that won the race serves instead, and ours exits.
    const s = readState(root);
    if (s && (await runningDashboard(root))) {
      report(o, s, s.pid === child.pid ? 'Squad dashboard running in the background' : 'Squad dashboard already running');
      return 0;
    }
    if (child.exitCode !== null && !readState(root)) break;
  }
  console.error('The dashboard did not start. Run `squad dashboard` without --detach to see why.');
  return 1;
}

export async function runDashboardCommand(cwd: string, argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(DASHBOARD_USAGE);
    return 0;
  }
  let o: Options;
  try {
    o = parseDashboardArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n\n${DASHBOARD_USAGE}`);
    return 2;
  }
  const root = path.resolve(cwd);
  const running = await runningDashboard(root);

  if (o.action === 'status') {
    if (o.json) console.log(JSON.stringify(running ? { running: true, url: running.url, pid: running.pid, port: running.port } : { running: false }));
    else console.log(running ? `Squad dashboard running: ${running.url}` : 'Squad dashboard is not running for this directory.');
    return 0;
  }
  if (o.action === 'stop') {
    if (!running) {
      console.log(o.json ? JSON.stringify({ running: false }) : 'Squad dashboard is not running for this directory.');
      return 0;
    }
    try {
      process.kill(running.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    for (let i = 0; i < 30 && (await runningDashboard(root)); i++) await new Promise((r) => setTimeout(r, 100));
    removeState(root, running.pid);
    console.log(o.json ? JSON.stringify({ running: false, stopped: running.url }) : `Stopped the Squad dashboard at ${running.url}`);
    return 0;
  }
  if (running) {
    report(o, running, 'Squad dashboard already running');
    return 0;
  }
  // The background child (started below) serves with --detach set, so it prints nothing.
  if (o.detach && !process.env['SQUAD_DASHBOARD_CHILD']) {
    process.env['SQUAD_DASHBOARD_CHILD'] = '1';
    return startDetached(root, o, argv);
  }
  return serve(root, o);
}
