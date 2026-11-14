import { test, expect } from '@playwright/test';

test.describe('Blog hub', () => {
  test('search narrows the list, replaces the Latest row, and syncs to the URL', async ({ page }) => {
    await page.goto('/squad/blog/');
    await expect(page.locator('#latest-band')).toBeVisible();

    await page.locator('#post-search').fill('swe-bench');
    await expect(page.locator('#post-grid .post-card:visible')).toHaveCount(1);
    await expect(page.locator('#post-count')).toContainText('1 post');
    await expect(page.locator('#latest-band')).toBeHidden();
    await expect(page).toHaveURL(/q=swe-bench/);

    await page.reload();
    await expect(page.locator('#post-search')).toHaveValue('swe-bench');
    await expect(page.locator('#post-grid .post-card:visible')).toHaveCount(1);
  });

  test('shows a helpful empty state with working recovery actions', async ({ page }) => {
    await page.goto('/squad/blog/');
    await page.locator('#post-search').fill('zzzzqx');
    await expect(page.locator('#empty-title')).toContainText('zzzzqx');
    await expect(page.locator('#post-grid .post-card:visible')).toHaveCount(0);
    await page.getByRole('button', { name: 'skills', exact: true }).click();
    await expect(page.locator('#post-search')).toHaveValue('skills');
    await expect(page.locator('#post-grid .post-card:visible').first()).toBeVisible();
    await page.locator('#post-search').fill('zzzzqx');
    await page.getByRole('button', { name: 'Clear search and filters' }).click();
    await expect(page.locator('#post-search')).toHaveValue('');
    await expect(page.locator('#post-grid .post-card:visible')).toHaveCount(12);
  });

  test('category filters narrow results and unchecking restores them', async ({ page }) => {
    await page.goto('/squad/blog/');
    const total = await page.locator('#post-grid .post-card').count();
    await page.getByLabel('Release').check();
    const count = await page.locator('#post-grid .post-card:visible').count();
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThan(total);
    await page.getByRole('checkbox', { name: 'Release' }).uncheck();
    await expect(page.locator('#post-grid .post-card:visible')).toHaveCount(12);
  });

  test('pagination shows 12 per page, moves between pages, and respects page size', async ({ page }) => {
    await page.goto('/squad/blog/');
    const visible = page.locator('#post-grid .post-card:visible');
    await expect(visible).toHaveCount(12);
    const firstTitle = await visible.first().locator('.card-title').innerText();

    const pager = page.getByRole('navigation', { name: 'Pagination' });
    await expect(pager.getByRole('button', { name: 'Page 1' })).toHaveAttribute('aria-current', 'page');
    await pager.getByRole('button', { name: 'Next page' }).click();
    await expect(pager.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');
    expect(await visible.first().locator('.card-title').innerText()).not.toBe(firstTitle);
    await expect(page).toHaveURL(/page=2/);

    await page.locator('#post-size').click();
    await page.getByRole('option', { name: '24' }).click();
    await expect(visible).toHaveCount(24);
    await expect(page.locator('#post-count')).toContainText('Showing 1–24');
  });

  test('sort toggles order and "/" focuses search', async ({ page }) => {
    await page.goto('/squad/blog/');
    const firstTitle = () => page.locator('#post-grid .post-card:visible .card-title').first().innerText();
    const newest = await firstTitle();
    await page.locator('#post-sort').click();
    await page.getByRole('option', { name: 'Oldest' }).click();
    expect(await firstTitle()).not.toBe(newest);

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    await expect(page.locator('#post-search')).toBeFocused();
  });

  test('post page shows a single h1, breadcrumb back to the blog, and an active TOC entry', async ({ page }) => {
    await page.goto('/squad/blog/004-v020-release/');
    await expect(page.locator('h1:visible')).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Squad Blog' })).toBeVisible();
    await expect(page.locator('.article-aside .toc [aria-current="true"]')).toHaveCount(1);
  });
});