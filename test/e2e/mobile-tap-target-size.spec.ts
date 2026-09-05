import { expect, test } from '@playwright/test';

/**
 * Mobile tap target sizing (bdboard-h4xs.9): key interactive controls on 375px
 * viewports must expose at least 44×44 CSS px hit areas without relying on
 * toBeVisible() (sr-only / clip false positives).
 */

const MOBILE_VIEWPORT = { width: 375, height: 812 };
const MIN_TAP_TARGET_PX = 44;
const TICKET_TITLE = 'Fixture ticket bdboard-3tw.8';
/** Matches index.css .card-watch-toggle::before translate(calc(-50% - 18px), -50%). */
const CARD_WATCH_TOGGLE_PSEUDO_SHIFT_X_PX = 18;
const HIT_TEST_INSET_PX = 2;

type HitTest = { label: string; ok: boolean; hitClass: string };

type WatchToggleEvaluateResult = {
  found: boolean;
  width: number;
  height: number;
  hitTests: HitTest[];
  rightEdgeOk: boolean;
  rightEdgeHitClass: string;
};

test.describe('mobile tap target size — bdboard-h4xs.9', () => {
  test.use({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });

  test('375x812: card watch toggle exposes 44px pseudo hit area', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.card').first()).toBeVisible({ timeout: 15_000 });

    const watchToggle = page.locator('.card-watch-toggle').first();
    await watchToggle.scrollIntoViewIfNeeded();

    const result = await page.evaluate<
      WatchToggleEvaluateResult,
      { selector: string; shiftX: number; inset: number }
    >(({ selector, shiftX, inset }) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) {
          return {
            found: false,
            width: 0,
            height: 0,
            hitTests: [] as HitTest[],
            rightEdgeOk: false,
            rightEdgeHitClass: 'null',
          };
        }

        const before = getComputedStyle(element, '::before');
        const width = Number.parseFloat(before.width);
        const height = Number.parseFloat(before.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
          return {
            found: true,
            width: element.getBoundingClientRect().width,
            height: element.getBoundingClientRect().height,
            hitTests: [] as HitTest[],
            rightEdgeOk: false,
            rightEdgeHitClass: 'null',
          };
        }

        const rect = element.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2 - shiftX;
        const centerY = rect.top + rect.height / 2;
        const halfW = width / 2 - inset;
        const halfH = height / 2 - inset;

        const points: Array<{ label: string; x: number; y: number }> = [
          { label: 'center', x: centerX, y: centerY },
          { label: 'left', x: centerX - halfW, y: centerY },
          { label: 'right', x: centerX + halfW, y: centerY },
          { label: 'top', x: centerX, y: centerY - halfH },
          { label: 'bottom', x: centerX, y: centerY + halfH },
        ];

        const hitTests = points.map(({ label, x, y }) => {
          const hit = document.elementFromPoint(x, y);
          const ok = hit !== null && (hit === element || element.contains(hit));
          const hitClass =
            hit instanceof Element ? hit.className || hit.tagName.toLowerCase() : 'null';
          return { label, ok, hitClass };
        });

        const rightEdgeInnerX = centerX + halfW;
        const rightEdgeHit = document.elementFromPoint(rightEdgeInnerX, centerY);
        const rightEdgeOk =
          rightEdgeHit !== null &&
          (rightEdgeHit === element || element.contains(rightEdgeHit)) &&
          !(rightEdgeHit instanceof Element && rightEdgeHit.classList.contains('card-bulk-checkbox'));

        return {
          found: true,
          width,
          height,
          hitTests,
          rightEdgeOk,
          rightEdgeHitClass:
            rightEdgeHit instanceof Element
              ? rightEdgeHit.className || rightEdgeHit.tagName.toLowerCase()
              : 'null',
        };
      },
      {
        selector: '.card-watch-toggle',
        shiftX: CARD_WATCH_TOGGLE_PSEUDO_SHIFT_X_PX,
        inset: HIT_TEST_INSET_PX,
      },
    );

    expect(result.found, 'card watch toggle must exist').toBe(true);
    expect(
      result.width >= MIN_TAP_TARGET_PX && result.height >= MIN_TAP_TARGET_PX,
      `card watch toggle pseudo hit area too small (${result.width}x${result.height})`,
    ).toBe(true);

    for (const hitTest of result.hitTests) {
      expect(
        hitTest.ok,
        `elementFromPoint at ${hitTest.label} must hit the watch toggle button (got ${hitTest.hitClass})`,
      ).toBe(true);
    }

    expect(
      result.rightEdgeOk,
      `::before right edge must hit watch toggle, not bulk checkbox (got ${result.rightEdgeHitClass})`,
    ).toBe(true);
  });

  test('375x812: comment submit in detail panel meets 44px', async ({ page }) => {
    await page.goto('/');

    const card = page.locator('article', { hasText: TICKET_TITLE });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.tap();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const submit = dialog.locator('.comment-form-submit');
    await expect(submit).toBeVisible();

    const result = await page.evaluate((selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        return { found: false, width: 0, height: 0 };
      }
      const rect = element.getBoundingClientRect();
      return { found: true, width: rect.width, height: rect.height };
    }, '.comment-form-submit');

    expect(result.found, 'comment submit button must exist').toBe(true);
    expect(
      result.width >= MIN_TAP_TARGET_PX && result.height >= MIN_TAP_TARGET_PX,
      `comment submit tap target too small (${result.width}x${result.height})`,
    ).toBe(true);
  });

  test('375x812: overflow menu items meet 44px height', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });

    await page.locator('.overflow-menu-button').click();
    await expect(page.locator('.overflow-menu-popover')).toBeVisible();

    const results = await page.evaluate((minSize) => {
      const items = Array.from(document.querySelectorAll('.overflow-menu-item'));
      return items.map((item, index) => {
        const rect = item.getBoundingClientRect();
        return {
          index,
          height: rect.height,
          ok: rect.height >= minSize,
        };
      });
    }, MIN_TAP_TARGET_PX);

    expect(results.length, 'overflow menu must expose at least one item').toBeGreaterThan(0);
    for (const item of results) {
      expect(
        item.ok,
        `overflow-menu-item[${item.index}] height=${item.height}px (min=${MIN_TAP_TARGET_PX}px)`,
      ).toBe(true);
    }
  });
});
