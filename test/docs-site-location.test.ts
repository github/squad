/**
 * Docs site location guard.
 *
 * The repository moved from bradygaster/squad to github/squad. GitHub Pages does not
 * redirect after a transfer, so https://bradygaster.github.io/squad/ returns 404 and the
 * docs site is served from https://github.github.com/squad/. These checks keep the Astro
 * build, the RSS feed, the robots sitemap, the site's GitHub links, and the docs,
 * samples, READMEs and contributor guides on the new location.
 *
 * docs/tests/astro-features.test.mjs carries the same guard for `node --test`; this copy
 * runs in CI with the rest of test/.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SITE = 'https://github.github.com';
const BASE = '/squad/';
const EDIT_URL = 'https://github.com/github/squad/edit/dev/docs/src/content/docs/${currentSlug}.md';

// The implementation-provenance schema ID is a versioned identifier, not a link.
const RETIRED_SITE_LINK =
  /(?:https?:)?\/\/bradygaster\.github\.io\/squad(?![\w-])(?!\/schemas\/implementation-provenance\/v\d)[^\s)"'`<>\]]*/gi;
const OLD_REPO_LINK = /(?<![\w.-])github\.com\/bradygaster\/squad(?![\w-])[^\s)"'`<>\]]*/gi;

const SCANNED_PATHS = [
  'docs',
  'samples',
  'README.md',
  'README.zh.md',
  'CONTRIBUTING.md',
  'CONTRIBUTORS.md',
  'SUPPORT.md',
  'packages/squad-cli/README.md',
  'packages/squad-sdk/README.md',
  '.copilot/skills/pr-lifecycle/SKILL.md',
];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.astro', '.git', 'coverage']);
const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.astro', '.mjs', '.cjs', '.js', '.ts', '.tsx', '.json', '.yml', '.yaml', '.txt', '.xml', '.html',
]);

interface ScannedFile {
  path: string;
  text: string;
}

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** First capture of `pattern` (compiled with the `d` flag) in `path`, with its file:line. */
function setting(path: string, pattern: RegExp): { value: string | undefined; at: string } {
  const text = read(path);
  const match = pattern.exec(text);
  if (!match) return { value: undefined, at: `${path} (setting not found)` };
  const start = match.indices?.[1]?.[0] ?? match.index;
  return { value: match[1], at: `${path}:${lineAt(text, start)}` };
}

function collect(path: string, out: string[]): string[] {
  const abs = join(ROOT, path);
  if (!existsSync(abs)) return out;
  if (statSync(abs).isFile()) {
    if (TEXT_EXTENSIONS.has(extname(path))) out.push(path);
    return out;
  }
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    collect(`${path}/${entry.name}`, out);
  }
  return out;
}

function findLinks(files: ScannedFile[], pattern: RegExp): string[] {
  const offenders: string[] = [];
  for (const { path, text } of files) {
    text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(pattern)) offenders.push(`${path}:${index + 1}: ${match[0]}`);
    });
  }
  return offenders;
}

describe('docs site location (https://github.github.com/squad/)', () => {
  it('Astro builds the site for https://github.github.com under /squad/', () => {
    const site = setting('docs/astro.config.mjs', /^[ \t]*site:[ \t]*['"`]([^'"`]*)['"`]/dm);
    const base = setting('docs/astro.config.mjs', /^[ \t]*base:[ \t]*['"`]([^'"`]*)['"`]/dm);

    expect(site.value, `${site.at}: Astro site`).toBe(SITE);
    expect(base.value, `${base.at}: Astro base`).toBe(BASE);
  });

  it('the RSS feed falls back to https://github.github.com/squad/', () => {
    const fallback = setting('docs/src/pages/rss.xml.js', /context\.site\s*\?\?\s*['"`]([^'"`]*)['"`]/d);

    expect(fallback.value, `${fallback.at}: RSS site fallback`).toBe(`${SITE}${BASE}`);
  });

  it('robots.txt points at the deployed sitemap', () => {
    const sitemap = setting('docs/public/robots.txt', /^Sitemap:[ \t]*(\S+)/dm);

    expect(sitemap.value, `${sitemap.at}: robots.txt Sitemap`).toBe(`${SITE}${BASE}sitemap-index.xml`);
  });

  it('"Edit this page" opens the page source on github/squad', () => {
    const edit = setting('docs/src/layouts/DocsLayout.astro', /const editUrl\s*=\s*currentSlug\s*\?\s*`([^`]*)`/d);

    expect(edit.value, `${edit.at}: edit-page URL`).toBe(EDIT_URL);
  });

  it('site chrome links to the github/squad repository', () => {
    const chrome = [
      'docs/src/components/Header.astro',
      'docs/src/components/Footer.astro',
      'docs/src/pages/index.astro',
      'docs/src/layouts/DocsLayout.astro',
      'docs/src/plugins/remark-rewrite-links.mjs',
    ].map((path) => ({ path, text: read(path) }));

    const offenders = findLinks(chrome, OLD_REPO_LINK);

    expect(offenders, `Site chrome links to bradygaster/squad; use https://github.com/github/squad:\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('docs, samples, READMEs and contributor guides do not link to bradygaster.github.io/squad', () => {
    const paths = SCANNED_PATHS.flatMap((path) => collect(path, []));
    const unscanned = [
      'README.md',
      'packages/squad-cli/README.md',
      'docs/astro.config.mjs',
      'docs/src/content/docs/guide/gh-aw.md',
      'docs/src/content/blog/028-new-docs-site.md',
    ].filter((path) => !paths.includes(path));
    expect(unscanned, 'files the scan should have reached').toEqual([]);

    const offenders = findLinks(paths.map((path) => ({ path, text: read(path) })), RETIRED_SITE_LINK);

    expect(offenders, `Links to the retired docs site; use https://github.github.com/squad/...:\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('the retired-site scan names file:line and exempts only the provenance schema ID', () => {
    const text = [
      'See [Model Selection](https://bradygaster.github.io/squad/docs/features/model-selection/).',
      'Schema: `https://bradygaster.github.io/squad/schemas/implementation-provenance/v1`.',
      'Visit the docs at [bradygaster.github.io/squad](https://github.github.com/squad/).',
      '<a href="//bradygaster.github.io/squad/">Docs</a>',
      'Another project: https://bradygaster.github.io/squadcaster/',
    ].join('\r\n');

    expect(findLinks([{ path: 'docs/example.md', text }], RETIRED_SITE_LINK)).toEqual([
      'docs/example.md:1: https://bradygaster.github.io/squad/docs/features/model-selection/',
      'docs/example.md:4: //bradygaster.github.io/squad/',
    ]);
  });
});
