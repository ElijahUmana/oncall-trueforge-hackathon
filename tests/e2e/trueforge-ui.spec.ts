import { expect, test } from '@playwright/test';

const live = process.env.LIVE_E2E === '1';

test.describe('TrueForge operator UI', () => {
  test.skip(
    !live,
    'Set LIVE_E2E=1 only when a real TrueForge server is running.',
  );

  test('loads the actual chat UI without page errors', async ({ page }) => {
    const pageErrors: Error[] = [];
    page.on('pageerror', error => pageErrors.push(error));

    const response = await page.goto('/');
    expect(response?.ok()).toBe(true);
    await expect(page.locator('#root')).toBeVisible();
    expect(pageErrors).toEqual([]);
  });
});
