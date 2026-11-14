/**
 * Broad axe-core sweep: a deterministic sample of built docs and blog pages in light and dark
 * mode (WCAG 2.2 AA + best practices), plus interactive states (search dialog, open dropdown,
 * blog empty state, mobile drawer).
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

function builtPages(dir) {
  const root = path.join(DIST, dir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name === 'index.html') out.push('/squad/' + path.relative(DIST, d).replaceAll('\\', '/') + '/');
    }
  };
  walk(root);
  return out.sort();
}

const sample = [...builtPages('docs'), ...builtPages('blog')].filter((_, i) => i % 4 === 0);

async function violations(page) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
}

for (const mode of ['light', 'dark']) {
  test.describe(`axe sweep (${mode})`, () => {
    test.use({ colorScheme: mode, reducedMotion: 'reduce' });
    test.setTimeout(180_000);

    test('sampled docs and blog pages have no violations', async ({ page }) => {
      expect(sample.length).toBeGreaterThan(20);
      const failures = [];
      for (const url of sample) {
        await page.goto(url);
        const v = await violations(page);
        if (v.length) failures.push(`${url} -> ${v.join(' | ')}`);
      }
      expect(failures).toEqual([]);
    });

    test('interactive states have no violations', async ({ page }) => {
      await page.goto('/squad/blog/');
      await page.keyboard.press('Control+k');
      await page.keyboard.type('skills');
      await expect(page.locator('#search-results a.search-result').first()).toBeVisible({ timeout: 10_000 });
      expect(await violations(page)).toEqual([]);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      await page.locator('#post-sort').click();
      expect(await violations(page)).toEqual([]);
      await page.keyboard.press('Escape');

      await page.goto('/squad/blog/?q=zzzzqx');
      await expect(page.locator('#post-empty')).toBeVisible();
      expect(await violations(page)).toEqual([]);
    });
  });
}

test.describe('axe sweep (mobile)', () => {
  test.use({ viewport: { width: 390, height: 800 }, reducedMotion: 'reduce' });

  for (const url of ['/squad/', '/squad/blog/', '/squad/docs/reference/cli/']) {
    test(`${url} has no violations`, async ({ page }) => {
      await page.goto(url);
      expect(await violations(page)).toEqual([]);
    });
  }

  test('open docs drawer has no violations', async ({ page }) => {
    await page.goto('/squad/docs/reference/cli/');
    await page.locator('#mobile-nav-toggle').click();
    await expect(page.locator('#sidebar')).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
});
