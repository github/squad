/**
 * Playwright e2e tests for docs sidebar behavior.
 */
import { test, expect } from '@playwright/test';

const DEEP = '/squad/docs/scenarios/ci-cd-integration/';

test.describe('Docs sidebar', () => {
  test('starts collapsed except for the section holding the current page', async ({ page }) => {
    await page.goto(DEEP);
    const toggles = page.locator('#sidebar .sidebar-toggle');
    const states = await toggles.evaluateAll((els) => els.map((e) => [e.textContent.trim(), e.getAttribute('aria-expanded')]));
    const expanded = states.filter(([, s]) => s === 'true').map(([n]) => n);
    expect(expanded).toEqual(['Scenarios']);
    await expect(page.locator('#sidebar [aria-current="page"]')).toBeVisible();
  });

  test('deep links scroll the current page into view in the sidebar', async ({ page }) => {
    await page.goto('/squad/docs/reference/glossary/');
    await expect(page.locator('#sidebar [aria-current="page"]')).toBeInViewport();
    const inside = await page.evaluate(() => {
      const s = document.getElementById('sidebar').getBoundingClientRect();
      const a = document.querySelector('#sidebar [aria-current="page"]').getBoundingClientRect();
      return a.top >= s.top && a.bottom <= s.bottom;
    });
    expect(inside).toBe(true);
  });

  test('navigating via the sidebar re-centers the new current page and collapses the old section', async ({ page }) => {
    await page.goto('/squad/docs/get-started/five-minute-start/');
    await page.getByRole('button', { name: 'Scenarios' }).click();
    await page.locator('#sidebar a[href$="/docs/scenarios/ci-cd-integration/"]').click();
    await page.waitForURL(/ci-cd-integration/);
    await expect(page.getByRole('button', { name: 'Scenarios' })).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('button', { name: 'Get Started' })).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#sidebar [aria-current="page"]')).toBeInViewport();
  });

  test('chevron toggles a section open and closed', async ({ page }) => {
    await page.goto(DEEP);
    const toggle = page.getByRole('button', { name: 'Concepts' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#sidebar a[href$="/docs/concepts/architecture/"]')).toBeVisible();
    await toggle.click();
    await expect(page.locator('#sidebar a[href$="/docs/concepts/architecture/"]')).toBeHidden();
  });
});