#!/usr/bin/env node
/**
 * Captures screenshots of every layout page on mobile, tablet, and desktop in light and dark mode,
 * and writes a browsable gallery (index.html) so maintainers can review rendering at a glance.
 *
 * Usage (from docs/):
 *   npm run build && npm run screenshots
 *   npm run screenshots -- --out visual-review --base http://localhost:4321 --full-height 3200
 *
 * Options:
 *   --base         Site origin to capture (default http://localhost:4321). If nothing is listening
 *                  there, `astro preview` is started automatically and stopped afterwards.
 *   --out          Output directory, relative to docs/ (default visual-review). Gitignored; only files this script generates are replaced.
 *   --full-height  Max captured page height in px for full-page shots (default 3200).
 *   --only         Comma-separated layout ids to capture (e.g. home,blog-post).
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
    return acc;
  }, []),
);
const BASE = (args.base ?? 'http://localhost:4321').replace(/\/$/, '');
const OUT = path.resolve(args.out ?? 'visual-review');
const MAX_H = Number(args['full-height'] ?? 3200);
const ONLY = args.only ? new Set(args.only.split(',')) : null;

const DEVICES = [
  { id: 'mobile', label: 'Mobile', viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { id: 'tablet', label: 'Tablet', viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { id: 'desktop', label: 'Desktop', viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
];
const THEMES = ['light', 'dark'];

// Each layout gets one representative URL. `before` prepares interactive states.
const LAYOUTS = [
  { id: 'home', title: 'Landing page', url: '/squad/' },
  { id: 'blog-index', title: 'Blog index (hub)', url: '/squad/blog/' },
  { id: 'blog-filtered', title: 'Blog index, filtered by category', url: '/squad/blog/?category=Release' },
  { id: 'blog-empty', title: 'Blog index, empty search', url: '/squad/blog/?q=%40%40%40%40' },
  { id: 'blog-post', title: 'Blog post', url: '/squad/blog/004-v020-release/' },
  { id: 'docs-page', title: 'Docs page (sidebar section, breadcrumb, pager)', url: '/squad/docs/features/skills/' },
  { id: 'docs-first', title: 'Docs page, first in section (single pager link)', url: '/squad/docs/get-started/five-minute-start/' },
  { id: 'docs-root', title: 'Docs root page (no breadcrumb)', url: '/squad/docs/whatsnew/' },
  { id: 'docs-reference', title: 'Docs reference (tables and code)', url: '/squad/docs/reference/cli/' },
  { id: 'not-found', title: '404 page', url: '/squad/this-page-does-not-exist/' },
  {
    id: 'search-empty',
    title: 'Site search dialog, suggestions',
    url: '/squad/',
    viewportOnly: true,
    before: async (page) => {
      await page.evaluate(() => document.getElementById('search-btn')?.click());
      await page.locator('#search-modal').waitFor({ state: 'visible' });
    },
  },
  {
    id: 'search-results',
    title: 'Site search dialog, results',
    url: '/squad/',
    viewportOnly: true,
    before: async (page) => {
      await page.evaluate(() => document.getElementById('search-btn')?.click());
      await page.locator('#search-input').fill('skills');
      await page.locator('#search-results a.search-result').first().waitFor({ state: 'visible', timeout: 15000 });
    },
  },
  {
    id: 'nav-drawer',
    title: 'Docs sidebar drawer (mobile and tablet)',
    url: '/squad/docs/features/skills/',
    viewportOnly: true,
    devices: ['mobile', 'tablet'],
    before: async (page) => {
      await page.locator('#mobile-nav-toggle').click();
      await page.locator('#sidebar').waitFor({ state: 'visible' });
    },
  },
].filter((l) => !ONLY || ONLY.has(l.id));

async function reachable(url) {
  try {
    const r = await fetch(url + '/squad/');
    return r.ok;
  } catch {
    return false;
  }
}

let server;
async function ensureServer() {
  if (await reachable(BASE)) return;
  const port = new URL(BASE).port || '4321';
  console.log(`No server at ${BASE}; starting astro preview on :${port}`);
  server = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['astro', 'preview', '--port', port], { stdio: 'ignore', shell: process.platform === 'win32' });
  for (let i = 0; i < 40; i++) {
    if (await reachable(BASE)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Preview server did not start. Run `npm run build` first.');
}

async function settle(page) {
  await page.evaluate(() => document.fonts?.ready);
  // Reveal scroll-triggered sections so full-page shots are complete
  await page.evaluate(() => document.querySelectorAll('.reveal').forEach((e) => e.classList.add('visible')));
  await page.waitForTimeout(250);
}

async function main() {
  await ensureServer();
  // Only clear files this script generates so a custom --out never deletes unrelated files
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) {
    if (/__(mobile|tablet|desktop)__(light|dark)\.png$/.test(f) || f === 'index.html') fs.rmSync(path.join(OUT, f));
  }

  const browser = await chromium.launch();
  const manifest = [];
  let count = 0;

  for (const theme of THEMES) {
    for (const device of DEVICES) {
      const { id: _id, label: _label, ...ctxOptions } = device;
      const context = await browser.newContext({ ...ctxOptions, colorScheme: theme, reducedMotion: 'reduce' });
      await context.addInitScript((t) => localStorage.setItem('theme', t), theme);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => {
        // The 404 route intentionally returns HTTP 404, which the browser logs as a resource error
        if (m.type() === 'error' && !/status of 404/.test(m.text())) errors.push(m.text());
      });

      for (const layout of LAYOUTS) {
        if (layout.devices && !layout.devices.includes(device.id)) continue;
        await page.goto(BASE + layout.url, { waitUntil: 'load' });
        if (layout.before) await layout.before(page);
        await settle(page);
        const file = `${layout.id}__${device.id}__${theme}.png`;
        const target = path.join(OUT, file);
        if (layout.viewportOnly) {
          await page.screenshot({ path: target });
        } else {
          const height = await page.evaluate(() => document.documentElement.scrollHeight);
          if (height > MAX_H) {
            await page.screenshot({ path: target, clip: { x: 0, y: 0, width: device.viewport.width, height: MAX_H }, fullPage: true });
          } else {
            await page.screenshot({ path: target, fullPage: true });
          }
        }
        manifest.push({ layout: layout.id, title: layout.title, url: layout.url, device: device.id, theme, file, errors: [...errors] });
        errors.length = 0;
        count++;
        process.stdout.write(`\r${count} screenshots`);
      }
      await context.close();
    }
  }
  await browser.close();
  console.log();

  writeGallery(manifest);
  const withErrors = manifest.filter((m) => m.errors.length);
  console.log(`Saved ${count} screenshots to ${OUT}`);
  console.log(`Gallery: ${path.join(OUT, 'index.html')}`);
  if (withErrors.length) {
    console.log(`Console/page errors on ${withErrors.length} captures:`);
    withErrors.forEach((m) => console.log(`  ${m.file}: ${m.errors.join(' | ').slice(0, 160)}`));
    process.exitCode = 1;
  }
}

function writeGallery(manifest) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const layouts = [...new Set(manifest.map((m) => m.layout))];
  const sections = layouts
    .map((id) => {
      const items = manifest.filter((m) => m.layout === id);
      const title = items[0].title;
      const rows = THEMES.map((theme) => {
        const cells = DEVICES.map((d) => {
          const m = items.find((i) => i.theme === theme && i.device === d.id);
          return m
            ? `<figure class="${d.id}"><a href="${esc(m.file)}"><img loading="lazy" src="${esc(m.file)}" alt="${esc(`${title}, ${d.label}, ${theme} theme`)}"></a><figcaption>${d.label} · ${theme}${m.errors.length ? ' · errors logged' : ''}</figcaption></figure>`
            : '';
        }).join('');
        return `<div class="row">${cells}</div>`;
      }).join('');
      return `<section id="${esc(id)}"><h2>${esc(title)} <small><code>${esc(items[0].url)}</code></small></h2>${rows}</section>`;
    })
    .join('\n');
  const toc = layouts.map((id) => `<a href="#${esc(id)}">${esc(manifest.find((m) => m.layout === id).title)}</a>`).join('');
  fs.writeFileSync(
    path.join(OUT, 'index.html'),
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Squad docs screenshots</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#0b0d12;color:#e6e9ef}
  header{position:sticky;top:0;background:#0b0d12ee;backdrop-filter:blur(8px);padding:12px 24px;border-bottom:1px solid #222836;z-index:2}
  nav{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:6px;font-size:13px}
  a{color:#7cc4ff}
  main{padding:24px}
  section{margin:0 0 56px}
  h2{font-size:18px;margin:0 0 12px}
  h2 small{font-weight:400;opacity:.7}
  .row{display:flex;gap:16px;align-items:flex-start;margin-bottom:16px;overflow-x:auto}
  figure{margin:0;flex:none}
  figure img{display:block;border:1px solid #2a3142;border-radius:8px;max-height:640px;width:auto;background:#fff}
  figure.mobile img{max-width:240px}figure.tablet img{max-width:360px}figure.desktop img{max-width:720px}
  figcaption{font-size:12px;opacity:.75;margin-top:4px}
</style>
<header><strong>Squad docs screenshots</strong> — ${manifest.length} captures · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC<nav>${toc}</nav></header>
<main>${sections}</main></html>`,
  );
}

try {
  await main();
} finally {
  if (server) server.kill();
}
