import { expect, test } from '@playwright/test';

/**
 * Mobile lane horizontal snap keeps inset from scrollport left edge (bdboard-h4xs.11).
 *
 * Uses scrollLeft assignment (not scrollIntoView) to trigger mandatory scroll-snap,
 * verifying the second lane snaps to the scroll-padding-left inset.
 * Runs at 375x812 and 600x900 viewports to cover both @media (max-width:700px) and
 * (max-width:480px) scroll-padding-left rules. Both branches are guarded independently:
 * deleting the 14px rule fails only 600x900, deleting the 12px rule fails only 375x812.
 *
 * Deliberately NOT guarded: whether the snap is `mandatory` or `proximity`.
 * index.css:2720 declares `.lanes-row { scroll-snap-type: x proximity }` as the base rule and
 * index.css:5779 upgrades it to `x mandatory` on mobile, so deleting the mandatory line leaves
 * proximity snapping and this spec stays green. That is intended — the contract this spec owns is
 * "the lane snaps to the scroll-padding inset rather than the scrollport edge", which both
 * strengths satisfy at the offset used below. Replacing scroll-snap-type with `none` (i.e. really
 * removing the snap mechanism) does fail both viewports, which is what makes this spec a real
 * guard rather than the scrollIntoView version it replaced. If the mandatory-vs-proximity
 * distinction ever needs guarding, that belongs to a spec about swipe behaviour, not this one.
 *
 * Detection margin note: the 12px-rule mutation is caught by a 2px gap (14 vs 12) against a 1.5px
 * tolerance. If the two padding values ever converge, this spec quietly loses that half of its
 * detection power — re-check the mutation table in bdboard-h4xs.11 before changing either value.
 */
const VIEWPORTS: { width: number; height: number }[] = [
  { width: 375, height: 812 },
  { width: 600, height: 900 },
];

for (const viewport of VIEWPORTS) {
  test.describe(`mobile lane snap padding @ ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, isMobile: true, hasTouch: true });

    test('second lane snaps to the padding inset, not the scrollport edge', async ({ page }) => {
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

      await page.evaluate((paddingLeftPx) => {
        const row = document.querySelector('.lanes-row');
        const laneElements = document.querySelectorAll('.lanes-row .lane');
        if (!row) throw new Error('.lanes-row not found');
        if (laneElements.length < 2) throw new Error('need at least 2 lanes');
        const lane1 = laneElements[1]!;
        const target =
          row.scrollLeft +
          (lane1.getBoundingClientRect().left - row.getBoundingClientRect().left) -
          paddingLeftPx;
        row.scrollLeft = Math.max(0, target - 24);
      }, expectedPaddingPx);

      await page.waitForTimeout(150);

      const { secondLaneLeft, scrollLeftAfterSnap } = await page.evaluate(() => {
        const row = document.querySelector('.lanes-row');
        const laneElements = document.querySelectorAll('.lanes-row .lane');
        if (!row) throw new Error('.lanes-row not found');
        return {
          secondLaneLeft: laneElements[1]!.getBoundingClientRect().left,
          scrollLeftAfterSnap: row.scrollLeft,
        };
      });

      expect(
        Math.abs(secondLaneLeft - expectedPaddingPx),
        `second lane should snap to the padding inset (expected ~${expectedPaddingPx}px, measured left=${secondLaneLeft}px)`,
      ).toBeLessThanOrEqual(1.5);

      expect(
        scrollLeftAfterSnap,
        'row should have scrolled horizontally before snap settled',
      ).toBeGreaterThan(0);

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
}
