import { expect, test } from '@playwright/test';

/**
 * Mobile lane horizontal snap keeps inset from scrollport left edge (bdboard-h4xs.11).
 *
 * Without scroll-padding-left matching padding-left, lanes after the first snap flush
 * to x=0 inside the scrollport.
 */
test.describe('mobile lane snap padding', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test('second lane snaps with left padding offset from scrollport edge', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.lanes-row .lane').first()).toBeVisible({
      timeout: 15_000,
    });

    const lanes = page.locator('.lanes-row .lane');
    const laneCount = await lanes.count();
    expect(laneCount, 'fixture must expose at least two lanes').toBeGreaterThanOrEqual(2);

    const paddingLeft = await page.evaluate(() => {
      const row = document.querySelector('.lanes-row');
      if (!row) throw new Error('.lanes-row not found');
      return getComputedStyle(row).paddingLeft;
    });
    const expectedPaddingPx = Number.parseFloat(paddingLeft);

    await page.evaluate(() => {
      const laneElements = document.querySelectorAll('.lanes-row .lane');
      if (laneElements.length < 2) throw new Error('need at least 2 lanes');
      laneElements[1].scrollIntoView({
        inline: 'start',
        block: 'nearest',
        behavior: 'instant',
      });
    });

    // scroll-snap の settle を待つ
    await page.waitForTimeout(150);

    const secondLaneLeft = await page.evaluate(() => {
      const laneElements = document.querySelectorAll('.lanes-row .lane');
      return laneElements[1]!.getBoundingClientRect().left;
    });

    expect(
      secondLaneLeft,
      `second lane should not stick to scrollport left edge (expected >= ${expectedPaddingPx - 1}px, measured left=${secondLaneLeft}px)`,
    ).toBeGreaterThanOrEqual(expectedPaddingPx - 1);

    const rowMetrics = await page.evaluate(() => {
      const row = document.querySelector('.lanes-row');
      if (!row) throw new Error('.lanes-row not found');
      const style = getComputedStyle(row);
      return {
        paddingLeft: style.paddingLeft,
        scrollPaddingLeft: style.scrollPaddingLeft,
      };
    });

    expect(rowMetrics.scrollPaddingLeft, 'scroll-padding-left should not be auto').not.toBe(
      'auto',
    );
    expect(rowMetrics.scrollPaddingLeft).toBe(rowMetrics.paddingLeft);
  });
});
