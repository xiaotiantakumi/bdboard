import { expect, test } from '@playwright/test';

const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const MOBILE_VIEWPORT = { width: 375, height: 812 };

test.describe('board filter breakpoint behavior (bdboard-qxt1)', () => {
  test('filter panel follows the viewport across a mobile expand and desktop return', async ({
    page,
  }) => {
    const toggle = page.getByRole('button', { name: /^絞り込み/ });
    const labelGroup = page.locator('.board-filter-label-group');

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await page.goto('/');
    await expect(labelGroup).toBeVisible({ timeout: 15_000 });
    await expect(toggle).toBeHidden();

    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(labelGroup).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(labelGroup).toBeVisible();

    await page.setViewportSize(DESKTOP_VIEWPORT);
    await expect(labelGroup).toBeVisible();
    await expect(toggle).toBeHidden();
  });
});
