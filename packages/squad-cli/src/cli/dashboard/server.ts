/**
 * Dashboard HTTP server (#2460): serves the page and streams dashboard events over SSE.
 *
 * Local only: it listens on 127.0.0.1, answers only requests whose Host header names that address
 * (or localhost) on its own port, so a web page can't reach it through DNS rebinding, and sends a CSP
 * that allows no inline script and no other origin. Transcript text is sent as JSON data; the page
 * renders it with textContent or escapes it.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { DashboardEvent, DashboardSource } from './sources.js';

export const DASHBOARD_HOST = '127.0.0.1';

export interface DashboardMeta {
  repo: string;
  owner: string;
  /** Member name → role, from the `.squad/` roster. */
  roles: Record<string, string>;
  /** What the dashboard is reading, for the header. */
  source: string;
}

export interface DashboardServerOptions {
  /** Directory holding index.html, app.js and app.css. */
  uiDir: string;
  port: number;
  meta: () => DashboardMeta;
  /**
   * Returns the source to read. Called on every poll; returning a different object than last time
   * starts the page over (a newer Claude Code session took over).
   */
  source: () => DashboardSource | undefined;
  /** Extra fields for /health (pid, root, session). */
  health?: () => Record<string, unknown>;
  pollMs?: number;
  /** Shut down after this long without transcript events or browser clients (default: five minutes). */
  idleMs?: number;
}

export interface DashboardServer {
  url: string;
  port: number;
  close(): Promise<void>;
  /** Poll the source now (tests). */
  tick(): void;
}

const ASSETS: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};

export const DASHBOARD_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SECURITY_HEADERS = {
  'Content-Security-Policy': DASHBOARD_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

/** True when the Host header names this server: 127.0.0.1 or localhost on its port. */
export function allowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `${DASHBOARD_HOST}:${port}` || host.toLowerCase() === `localhost:${port}`;
}

export function startDashboardServer(opts: DashboardServerOptions): Promise<DashboardServer> {
  type Seq = DashboardEvent & { seq: number };
  let history: Seq[] = [];
  let seq = 0;
  let current: DashboardSource | undefined;
  const clients = new Set<http.ServerResponse>();
  let port = opts.port;
  let activeAt = Date.now();

  const send = (res: http.ServerResponse, e: Seq) => res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);

  function tick(): void {
    let src: DashboardSource | undefined;
    try {
      src = opts.source();
    } catch {
      return;
    }
    if (src !== current) {
      const reset = current !== undefined;
      current = src;
      history = [];
      if (reset) for (const c of clients) c.write('event: reset\ndata: {}\n\n');
    }
    if (!current) return;
    let events: DashboardEvent[];
    try {
      events = current.poll();
    } catch {
      return;
    }
    if (current.takeReset?.()) {
      // The source replayed its transcript from the start: the page starts over too.
      history = [];
      for (const c of clients) c.write('event: reset\ndata: {}\n\n');
    }
    for (const e of events) {
      activeAt = Date.now();
      const s = { seq: ++seq, ...e };
      history.push(s);
      for (const c of clients) send(c, s);
    }
  }

  const server = http.createServer((req, res) => {
    if (!allowedHost(req.headers.host, port)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('Forbidden\n');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS });
      res.end();
      return;
    }
    const url = new URL(req.url ?? '/', `http://${DASHBOARD_HOST}:${port}`);
    if (url.pathname !== '/health') activeAt = Date.now();
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', ...SECURITY_HEADERS });
      res.write('retry: 2000\n\n');
      for (const e of history) send(res, e);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/meta' || url.pathname === '/health') {
      const body = url.pathname === '/meta' ? opts.meta() : { ok: true, service: 'squad-dashboard', ...(opts.health?.() ?? {}) };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      res.end(JSON.stringify(body));
      return;
    }
    const asset = ASSETS[url.pathname];
    if (!asset) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('Not found\n');
      return;
    }
    let body: Buffer;
    try {
      body = fs.readFileSync(path.join(opts.uiDir, asset.file));
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      res.end('Dashboard page is missing from this install\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': asset.type, ...SECURITY_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : body);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, DASHBOARD_HOST, () => {
      server.off('error', reject);
      port = (server.address() as AddressInfo).port;
      tick();
      const close = () => new Promise<void>((done) => {
        clearInterval(timer);
        clearInterval(keepAlive);
        for (const c of clients) c.end();
        clients.clear();
        server.close(() => done());
        server.closeAllConnections?.();
      });
      const timer = setInterval(() => {
        tick();
        if (clients.size > 0) activeAt = Date.now();
        if (Date.now() - activeAt >= (opts.idleMs ?? 5 * 60_000)) void close();
      }, opts.pollMs ?? 500);
      timer.unref();
      const keepAlive = setInterval(() => {
        for (const c of clients) c.write(': keep-alive\n\n');
      }, 15_000);
      keepAlive.unref();
      resolve({
        url: `http://${DASHBOARD_HOST}:${port}/`,
        port,
        tick,
        close,
      });
    });
  });
}
