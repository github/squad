/**
 * Accessibility + theming checks for the Primer-based docs front end.
 * Runs axe-core (WCAG 2.x A/AA) against key pages in light and dark color modes,
 * at desktop and mobile viewport sizes.
 */
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const PAGES = [
  ['home', '/squad/'],
  ['docs', '/squad/docs/get-started/installation/'],
  ['docs with code and tables', '/squad/docs/reference/cli/'],
  ['blog index', '/squad/blog/'],
  ['blog post', '/squad/blog/022-welcome-to-the-new-squad/'],
  ['404', '/squad/this-page-does-not-exist/'],
];

const MODES = ['light', 'dark'];

for (const mode of MODES) {
  test.describe(`axe: ${mode} mode`, () => {
    test.use({ colorScheme: mode, reducedMotion: 'reduce' });

    for (const [name, url] of PAGES) {
      test(`${name} has no WCAG A/AA violations`, async ({ page }) => {
        await page.addInitScript((m) => localStorage.setItem('theme', m), mode);
        await page.goto(url);
        await expect(page.locator('html')).toHaveAttribute('data-color-mode', mode);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(
          results.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`),
        ).toEqual([]);
      });
    }
  });
}

test.describe('theme toggle', () => {
  test('toggles Primer color mode, updates the label, and persists across navigation', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto('/squad/');
    const html = page.locator('html');
    const toggle = page.locator('#theme-toggle');

    await expect(html).toHaveAttribute('data-color-mode', 'auto');
    await expect(toggle).toHaveAccessibleName('Switch to dark theme');

    await toggle.click();
    await expect(html).toHaveAttribute('data-color-mode', 'dark');
    await expect(toggle).toHaveAccessibleName('Switch to light theme');

    await page.locator('header a[href$="/docs/get-started/installation/"]').first().click();
    await page.waitForURL('**/docs/get-started/installation/');
    await expect(html).toHaveAttribute('data-color-mode', 'dark');
  });

  test('follows the OS color scheme when no preference is stored', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/squad/');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = bg.match(/\d+/g).map(Number);
    expect(r + g + b).toBeLessThan(200);
  });
});

test.describe('keyboard and focus', () => {
  test('skip link is the first tab stop and moves focus to main content', async ({ page }) => {
    await page.goto('/squad/docs/get-started/installation/');
    await page.keyboard.press('Tab');
    const skip = page.locator('.skip-link');
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#main-content$/);
  });

  test('search dialog traps focus, closes on Escape, and restores focus to the trigger', async ({ page }) => {
    await page.goto('/squad/');
    const trigger = page.locator('#search-btn');
    await trigger.click();
    await expect(page.locator('#search-modal')).toBeVisible();
    await expect(page.locator('#search-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#search-modal')).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('current docs page is exposed with aria-current in the sidebar', async ({ page }) => {
    await page.goto('/squad/docs/get-started/installation/');
    await expect(page.locator('#sidebar [aria-current="page"]')).toHaveCount(1);
  });
});

test.describe('mobile layout', () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test('hamburger opens and closes the docs sidebar drawer without horizontal overflow', async ({ page }) => {
    await page.goto('/squad/docs/get-started/installation/');
    const toggle = page.locator('#mobile-nav-toggle');
    const sidebar = page.locator('#sidebar');

    await expect(sidebar).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(sidebar).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sidebar).toBeHidden();

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('home page does not scroll horizontally', async ({ page }) => {
    await page.goto('/squad/');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('docs pager', () => {
  test('a lone next link spans the full width (first page)', async ({ page }) => {
    await page.goto('/squad/docs/get-started/five-minute-start/');
    const pager = page.locator('nav.pager');
    await expect(pager.locator('a')).toHaveCount(1);
    const [pw, lw] = await Promise.all([pager.evaluate((e) => e.clientWidth), pager.locator('a').evaluate((e) => e.getBoundingClientRect().width)]);
    expect(lw).toBeGreaterThan(pw - 4);
  });
});

test.describe('breadcrumbs', () => {
  const trail = (page) => page.locator('nav[aria-label="Breadcrumb"] li').allInnerTexts();

  test('sidebar pages show Docs > section > page matching the sidebar', async ({ page }) => {
    await page.goto('/squad/docs/features/skills/');
    expect(await trail(page)).toEqual(['Docs', 'Core Features', 'Skills']);
    await expect(page.locator('nav[aria-label="Breadcrumb"] [aria-current="page"]')).toHaveText('Skills');
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Core Features' }).click();
    await page.waitForURL(/features\/team-setup/);
  });

  test('pages outside the sidebar but inside a section keep a sensible trail', async ({ page }) => {
    await page.goto('/squad/docs/features/cleanup/');
    const items = await trail(page);
    expect(items.slice(0, 2)).toEqual(['Docs', 'Features']);
    expect(items).toHaveLength(3);
  });

  test('root-level pages with no section render no breadcrumb', async ({ page }) => {
    await page.goto('/squad/docs/whatsnew/');
    await expect(page.locator('nav[aria-label="Breadcrumb"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Edit on GitHub' })).toBeVisible();
  });

  test('blog posts show Squad Blog > category > title', async ({ page }) => {
    await page.goto('/squad/blog/004-v020-release/');
    expect(await trail(page)).toEqual(['Squad Blog', 'Release', 'v0.2.0: Your Squad Comes With You']);
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Release' }).click();
    await page.waitForURL(/blog\/\?category=Release/);
    await expect(page.getByRole('checkbox', { name: 'Release' })).toBeChecked();
  });
});

test.describe('review follow-ups', () => {
  test('tablet non-docs pages show no hamburger, docs pages do', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/squad/blog/');
    await expect(page.locator('#mobile-nav-toggle')).toBeHidden();
    await page.goto('/squad/docs/features/skills/');
    await expect(page.locator('#mobile-nav-toggle')).toBeVisible();
  });

  test('blog JSON-LD is safe for titles with script-closing sequences', async ({ page }) => {
    await page.goto('/squad/blog/004-v020-release/');
    const raw = await page.locator('script[type="application/ld+json"]').first().textContent();
    expect(raw).not.toContain('<');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test('result count stays in the accessibility tree on small screens', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto('/squad/blog/');
    await page.locator('#post-search').fill('release');
    await expect(page.getByRole('status').filter({ hasText: /post/ })).toHaveCount(1);
  });

  test('opening a second dropdown resets the first trigger', async ({ page }) => {
    await page.goto('/squad/blog/');
    await page.locator('#post-sort').click();
    await page.locator('#post-size').click();
    await expect(page.locator('#post-sort')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#post-size')).toHaveAttribute('aria-expanded', 'true');
  });

  test('keyboard focus survives pagination rebuilds', async ({ page }) => {
    await page.goto('/squad/blog/');
    const pager = page.getByRole('navigation', { name: 'Pagination' });
    await pager.getByRole('button', { name: 'Next page' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#post-pager [aria-current="page"]')).toHaveAttribute('aria-label', 'Page 2');
    expect(await page.evaluate(() => document.activeElement?.closest('#post-pager') !== null)).toBe(true);
  });

  test('Enter cannot open a stale result while a new query is pending', async ({ page }) => {
    await page.goto('/squad/');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('skills');
    await expect(page.locator('#search-results a.search-result').first()).toBeVisible({ timeout: 10_000 });
    await page.keyboard.type('x');
    await expect(page.locator('#search-results a.search-result')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/squad\/$/);
  });

  test('crumbs that point at the current page are plain text, not dead links', async ({ page }) => {
    // First page of "Get Started": both "Docs" and the section link would target this very page
    await page.goto('/squad/docs/get-started/installation/');
    const nav = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(nav.getByRole('link', { name: 'Docs' })).toHaveCount(0);
    await page.goto('/squad/docs/get-started/five-minute-start/');
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Get Started' })).toHaveCount(0);
    // Every remaining breadcrumb link must navigate somewhere else
    const hrefs = await page.locator('nav[aria-label="Breadcrumb"] a').evaluateAll((as) => as.map((a) => a.pathname));
    for (const h of hrefs) expect(h).not.toBe('/squad/docs/get-started/five-minute-start/');
  });
});