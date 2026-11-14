import { test, expect } from '@playwright/test';

test.describe('Site search dialog', () => {
  test('shows suggestions, supports arrow-key navigation, and Enter opens the first result', async ({ page }) => {
    await page.goto('/squad/');
    await page.keyboard.press('Control+k');
    await expect(page.locator('#search-modal')).toBeVisible();
    await expect(page.getByText('Suggested')).toBeVisible();

    await page.keyboard.type('skills');
    const results = page.locator('#search-results a.search-result');
    await expect(results.first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('#search-empty')).toBeHidden();

    await page.keyboard.press('ArrowDown');
    await expect(results.nth(0)).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(results.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('#search-input')).toBeFocused();

    await page.keyboard.press('Enter');
    await page.waitForURL(/\/squad\/(docs|blog)\//, { timeout: 10_000 });
    await expect(page.locator('#search-modal')).toBeHidden();
  });

  test('a single Escape closes the dialog even with a query typed', async ({ page }) => {
    await page.goto('/squad/');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('agent');
    await page.keyboard.press('Escape');
    await expect(page.locator('#search-modal')).toBeHidden();
  });

  test('the clear button appears with text, clears the query, and keeps the dialog open', async ({ page }) => {
    await page.goto('/squad/');
    await page.keyboard.press('Control+k');
    const clear = page.getByRole('button', { name: 'Clear search' });
    await expect(clear).toBeHidden();
    await page.keyboard.type('agent');
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(page.locator('#search-input')).toHaveValue('');
    await expect(page.locator('#search-input')).toBeFocused();
    await expect(clear).toBeHidden();
    await expect(page.locator('#search-modal')).toBeVisible();
    await expect(page.getByText('Suggested')).toBeVisible();
  });
  test('scrolling the results does not scroll the page behind the dialog', async ({ page }) => {
    await page.goto('/squad/blog/');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('skills');
    await expect(page.locator('#search-results a.search-result').first()).toBeVisible({ timeout: 10_000 });
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 4000);
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expect(page.locator('html')).toHaveCSS('overflow', 'hidden');
  });

  test('quickly reopening after Escape starts with an empty field', async ({ page }) => {
    await page.goto('/squad/');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('agent');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('worktrees');
    await expect(page.locator('#search-input')).toHaveValue('worktrees');
  });

  test('a query with no matches shows the no-results message', async ({ page }) => {
    await page.goto('/squad/');
    await page.keyboard.press('Control+k');
    await page.keyboard.type('@@@@@@');
    await expect(page.locator('.search-none')).toContainText('No results for');
  });
});