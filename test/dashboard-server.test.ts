/**
 * Dashboard server and `squad dashboard` (#2460): local-only binding, Host check, CSP, SSE replay
 * and session switching, page escaping, argument parsing and the roster.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  startDashboardServer,
  allowedHost,
  DASHBOARD_CSP,
  type DashboardServer,
} from '../packages/squad-cli/src/cli/dashboard/server.js';
import type { DashboardEvent, DashboardSource } from '../packages/squad-cli/src/cli/dashboard/sources.js';
import { parseDashboardArgs, readRoster, dashboardStatePath, claimDashboardStart } from '../packages/squad-cli/src/cli/commands/dashboard.js';
import { spawn, spawnSync } from 'node:child_process';

const UI = path.resolve(__dirname, '..', 'packages', 'squad-cli', 'src', 'dashboard-ui');
const CLI = path.resolve(__dirname, '..', 'packages', 'squad-cli', 'dist', 'cli-entry.js');

class FakeSource implements DashboardSource {
  readonly label = 'fake';
  queue: DashboardEvent[] = [];
  resetNext = false;
  takeReset() {
    const r = this.resetNext;
    this.resetNext = false;
    return r;
  }
  poll() {
    const q = this.queue;
    this.queue = [];
    return q;
  }
}

function get(port: number, p: string, host = `127.0.0.1:${port}`): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (p === '/events' && body.includes('\n\n') && body.split('\n\n').length > 3) req.destroy();
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on('close', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e)));
  });
}

/** Reads SSE frames until `count` data events (or a reset) arrive. */
function events(port: number, count: number): Promise<{ data: any[]; reset: boolean }> {
  return new Promise((resolve, reject) => {
    const data: any[] = [];
    let reset = false;
    let buf = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        buf += c;
        let i: number;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (frame.startsWith('event: reset')) reset = true;
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line && !frame.startsWith('event:')) data.push(JSON.parse(line.slice(6)));
          if (data.length >= count || reset) {
            req.destroy();
            resolve({ data, reset });
          }
        }
      });
    });
    req.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e)));
  });
}

describe('dashboard server', () => {
  let server: DashboardServer;
  let src: DashboardSource | undefined;
  const fake = new FakeSource();

  beforeEach(async () => {
    src = fake;
    fake.queue = [{ t: 1, lane: 'coordinator', kind: 'say', text: '<img src=x onerror=alert(1)>' }];
    server = await startDashboardServer({
      uiDir: UI,
      port: 0,
      pollMs: 60_000,
      meta: () => ({ owner: 'o', repo: 'r', roles: { dallas: 'Backend' }, source: 'fake' }),
      source: () => src,
      health: () => ({ pid: 42 }),
    });
  });
  afterEach(() => server.close());

  it('listens on 127.0.0.1 only', () => {
    expect(server.url).toBe(`http://127.0.0.1:${server.port}/`);
  });

  it('rejects other Host headers (DNS rebinding)', async () => {
    expect((await get(server.port, '/', `evil.example:${server.port}`)).status).toBe(403);
    expect((await get(server.port, '/events', 'evil.example')).status).toBe(403);
    expect((await get(server.port, '/', `localhost:${server.port}`)).status).toBe(200);
    expect(allowedHost(`127.0.0.1:${server.port + 1}`, server.port)).toBe(false);
    expect(allowedHost(undefined, server.port)).toBe(false);
  });

  it('serves the page with a CSP that allows no inline script, and nothing outside the page', async () => {
    const page = await get(server.port, '/');
    expect(page.headers['content-security-policy']).toBe(DASHBOARD_CSP);
    expect(DASHBOARD_CSP).toContain("script-src 'self'");
    expect(DASHBOARD_CSP).not.toContain('unsafe-inline');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.body).toContain('<script src="/app.js" defer></script>');
    expect(page.body).not.toMatch(/<script\b[^>]*>(?!<\/script>)|<style\b|style="/i);
    expect((await get(server.port, '/app.js')).headers['content-type']).toContain('javascript');
    expect((await get(server.port, '/../package.json')).status).toBe(404);
    expect((await get(server.port, '/server.ts')).status).toBe(404);
  });

  it('serves meta and health', async () => {
    expect(JSON.parse((await get(server.port, '/meta')).body)).toMatchObject({ repo: 'r', roles: { dallas: 'Backend' } });
    expect(JSON.parse((await get(server.port, '/health')).body)).toEqual({ ok: true, service: 'squad-dashboard', pid: 42 });
  });

  it('replays history to new clients and streams new events, passing text through as data', async () => {
    fake.queue.push({ t: 2, lane: 'tu1', kind: 'start', text: 'go', extra: { member: 'dallas' } });
    server.tick();
    const first = await events(server.port, 2);
    expect(first.data.map((e) => e.seq)).toEqual([1, 2]);
    expect(first.data[0].text).toBe('<img src=x onerror=alert(1)>');
  });

  it('tells clients to start over when the source changes', async () => {
    const pending = events(server.port, 99);
    await new Promise((r) => setTimeout(r, 50));
    src = new FakeSource();
    server.tick();
    expect((await pending).reset).toBe(true);
  });

  it('starts over when the source replays its transcript, keeping only the replay', async () => {
    const pending = events(server.port, 99);
    await new Promise((r) => setTimeout(r, 50));
    fake.queue.push({ t: 1, lane: 'coordinator', kind: 'say', text: 'replayed' });
    fake.resetNext = true;
    server.tick();
    expect((await pending).reset).toBe(true);
    const after = await events(server.port, 1);
    expect(after.data.map((e) => e.text)).toEqual(['replayed']);
  });
});

describe('dashboard page', () => {
  const app = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');

  it('builds markup only from constants or escaped values', () => {
    for (const line of app.split('\n').filter((l) => l.includes('innerHTML'))) {
      const interpolated = [...line.slice(line.indexOf('innerHTML')).matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]!);
      for (const expr of interpolated) {
        expect(/^(esc\(|clock\(|inner$|T\.number|toolItem\.n|ICON)/.test(expr.trim()) || expr.includes("=== 1 ? ''"), `${expr} in: ${line.trim()}`).toBe(true);
      }
    }
    expect(app).not.toMatch(/squad-e2e-arcade|bradygaster|blinky/);
  });

  it('escapes all five HTML-significant characters', () => {
    const esc = new Function(`${/const esc = .*;/.exec(app)![0]} return esc;`)() as (s: string) => string;
    expect(esc(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });
});

describe('squad dashboard command', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-dash-cmd-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('parses actions and options', () => {
    expect(parseDashboardArgs([])).toMatchObject({ action: 'start', detach: false, streams: [] });
    expect(parseDashboardArgs(['stop'])).toMatchObject({ action: 'stop' });
    expect(parseDashboardArgs(['--port', '0', '--session', 'abc', '--detach', '--open'])).toMatchObject({ port: 0, session: 'abc', detach: true, open: true });
    expect(parseDashboardArgs(['--stream', 'a.jsonl', '--stream', 'b.jsonl']).streams).toEqual([path.resolve('a.jsonl'), path.resolve('b.jsonl')]);
    expect(() => parseDashboardArgs(['--port', 'x'])).toThrow();
    expect(() => parseDashboardArgs(['--port'])).toThrow();
    expect(() => parseDashboardArgs(['--bogus'])).toThrow();
  });

  it('keys one state file per directory', () => {
    expect(dashboardStatePath('/a/b')).toBe(dashboardStatePath('/a/b/'));
    expect(dashboardStatePath('/a/b')).not.toBe(dashboardStatePath('/a/c'));
    // Not in the temp directory: Claude Code's Bash tool has its own TMPDIR.
    expect(path.dirname(dashboardStatePath('/a/b', { SQUAD_HOME: '/h' }))).toBe(path.resolve('/h/dashboards'));
    expect(dashboardStatePath('/a/b', {})).toContain(path.join(os.homedir(), '.squad', 'dashboards'));
  });

  it('reads member roles from the charters', () => {
    const write = (rel: string, c: string) => {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmp, rel), c);
    };
    write('.squad/agents/dallas/charter.md', '# Dallas — Backend Dev\n');
    write('.squad/agents/scribe/charter.md', '# Scribe\n');
    write('.squad/agents/rai/charter.md', 'intro\n# Rai - Responsible AI\n');
    expect(readRoster(tmp)).toEqual({ dallas: 'Backend Dev', rai: 'Responsible AI' });
    expect(readRoster(path.join(tmp, 'none'))).toEqual({});
  });
});

describe('dashboard start lock', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-dash-lock-'));
    process.env['SQUAD_HOME'] = home;
  });
  afterEach(() => {
    delete process.env['SQUAD_HOME'];
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('lets one start through at a time, and takes over a lock whose holder died', async () => {
    const lock = dashboardStatePath('/w').replace(/\.json$/, '.lock');
    const release = await claimDashboardStart('/w');
    let second = false;
    const waiting = claimDashboardStart('/w').then((r) => ((second = true), r));
    await new Promise((r) => setTimeout(r, 200));
    expect(second).toBe(false);
    release();
    (await waiting)();
    expect(fs.existsSync(lock)).toBe(false);

    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
    fs.writeFileSync(lock, `${dead}\n`);
    const took = await claimDashboardStart('/w', 1000);
    expect(fs.readFileSync(lock, 'utf8').trim()).toBe(String(process.pid));
    took();
  });
});

describe.skipIf(!fs.existsSync(CLI) || process.platform === 'win32')('squad dashboard, started twice at once', () => {
  let cwd: string;
  let home: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-dash-race-'));
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-dash-home-'));
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  const env = () => ({ ...process.env, SQUAD_HOME: home, SQUAD_DASHBOARD_NO_OPEN: '1' });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** Starts `squad dashboard --port 0 --json` and resolves with the first JSON line it prints. */
  const start = () =>
    new Promise<{ pid: number; port: number; child: ReturnType<typeof spawn> }>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'dashboard', '--port', '0', '--json'], { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout!.on('data', (c) => {
        out += c;
        const line = out.split('\n').find((l) => l.startsWith('{'));
        if (line) resolve({ ...(JSON.parse(line) as { pid: number; port: number }), child });
      });
      child.on('exit', (code) => (out.includes('{') ? undefined : reject(new Error(`exited ${code}: ${out}`))));
    });

  it('serves one dashboard, and one stop leaves none running', async () => {
    const [a, b] = await Promise.all([start(), start()]);
    try {
      expect(a.pid).toBe(b.pid);
      expect(a.port).toBe(b.port);
      const server = a.child.pid === a.pid ? a.child : b.child;
      const other = server === a.child ? b.child : a.child;
      await new Promise((r) => (other.exitCode !== null ? r(undefined) : other.on('exit', r)));
      expect(other.exitCode).toBe(0);

      const stop = spawnSync(process.execPath, [CLI, 'dashboard', 'stop', '--json'], { cwd, env: env(), encoding: 'utf8' });
      expect(JSON.parse(stop.stdout)).toMatchObject({ running: false });
      for (let i = 0; i < 30 && alive(a.pid); i++) await new Promise((r) => setTimeout(r, 100));
      expect(alive(a.pid)).toBe(false);
    } finally {
      a.child.kill();
      b.child.kill();
    }
  }, 30_000);
});
