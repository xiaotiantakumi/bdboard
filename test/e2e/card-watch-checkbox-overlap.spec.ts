import { expect, test } from '@playwright/test';

/**
 * bdboard-1oep: card watch toggle vs bulk checkbox overlap regression.
 *
 * toBeVisible() has zero detection power for overlap — both elements can be
 * "visible" while elementFromPoint on the star glyph returns the checkbox.
 * Before the fix (375x812): toggle=[244,268], checkbox=[260,304], 8px button
 * overlap and 4px of the visible star glyph hit the checkbox (elementFromPoint
 * at x=260..303 returned checkbox).
 */

const MOBILE_VIEWPORT = { width: 375, height: 812 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const TICKET_TITLE = 'Fixture ticket bdboard-3tw.8';
const HIT_TEST_STEP_PX = 0.25;
const MIN_TAP_TARGET_PX = 44;

type GlyphHitResult = {
  found: boolean;
  sampleCount: number;
  misses: Array<{ x: number; hitDescription: string }>;
  buttonRect: { left: number; right: number; top: number; bottom: number };
  checkboxRect: { left: number; right: number; top: number; bottom: number };
  overlapPx: number;
};

type CheckboxTapResult = {
  found: boolean;
  checkboxHit: boolean;
  width: number;
  height: number;
};

type DesktopOverlapResult = {
  found: boolean;
  overlapPx: number;
  buttonRect: { left: number; right: number };
  checkboxRect: { left: number; right: number };
  paddingRight: string;
};

test.describe('card watch toggle vs bulk checkbox — bdboard-1oep', () => {
  test.use({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });

  test('375x812: every point on the star glyph hits the watch toggle, not the checkbox', async ({
    page,
  }) => {
    await page.goto('/');

    const card = page.locator('article', { hasText: TICKET_TITLE });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.evaluate((element) =>
      element.scrollIntoView({ block: 'center', inline: 'center' }),
    );
    await expect(
      card.locator('.card-bulk-checkbox'),
      'bulk checkbox must be rendered; overlap test has no meaning without it',
    ).toBeVisible();

    const result: GlyphHitResult = await card.evaluate((cardElement, step) => {
      const button = cardElement.querySelector('.card-watch-toggle');
      const icon = cardElement.querySelector('.card-watch-toggle .watch-toggle-icon');
      const checkbox = cardElement.querySelector('.card-bulk-checkbox');
      if (
        !(button instanceof HTMLElement) ||
        !(icon instanceof HTMLElement) ||
        !(checkbox instanceof HTMLElement)
      ) {
        return {
          found: false,
          sampleCount: 0,
          misses: [],
          buttonRect: { left: 0, right: 0, top: 0, bottom: 0 },
          checkboxRect: { left: 0, right: 0, top: 0, bottom: 0 },
          overlapPx: 0,
        };
      }

      const iconRect = icon.getBoundingClientRect();
      const btnRect = button.getBoundingClientRect();
      const cbRect = checkbox.getBoundingClientRect();
      const cy = iconRect.top + iconRect.height / 2;
      const misses: Array<{ x: number; hitDescription: string }> = [];
      let sampleCount = 0;

      for (let x = iconRect.left; x <= iconRect.right; x += step) {
        sampleCount += 1;
        const hit = document.elementFromPoint(x, cy);
        const isWatchHit =
          hit !== null && (hit === button || button.contains(hit));
        if (!isWatchHit) {
          const hitDescription =
            hit instanceof Element
              ? typeof hit.className === 'string' && hit.className !== ''
                ? hit.className
                : hit.tagName
              : String(hit);
          misses.push({ x, hitDescription });
          if (misses.length >= 20) break;
        }
      }

      // sampleCount must come from the loop, not rect/step — rect width can be
      // non-zero while the loop never runs, which would false-pass the guard.
      const overlapPx = Math.max(
        0,
        Math.min(btnRect.right, cbRect.right) - Math.max(btnRect.left, cbRect.left),
      );

      return {
        found: true,
        sampleCount,
        misses,
        buttonRect: {
          left: btnRect.left,
          right: btnRect.right,
          top: btnRect.top,
          bottom: btnRect.bottom,
        },
        checkboxRect: {
          left: cbRect.left,
          right: cbRect.right,
          top: cbRect.top,
          bottom: cbRect.bottom,
        },
        overlapPx,
      };
    }, HIT_TEST_STEP_PX);

    expect(result.found, 'watch toggle, star icon, and bulk checkbox must exist').toBe(true);
    expect(
      result.sampleCount,
      'star glyph must be sampled at least twice (16px width at 0.25px step)',
    ).toBeGreaterThanOrEqual(2);
    expect(
      result.misses,
      `star glyph must hit the watch toggle everywhere, but ${JSON.stringify(result.misses)}`,
    ).toHaveLength(0);
    expect(
      result.overlapPx,
      `watch toggle and bulk checkbox must not overlap (overlapPx=${result.overlapPx}, button=${JSON.stringify(result.buttonRect)}, checkbox=${JSON.stringify(result.checkboxRect)})`,
    ).toBe(0);

    console.log(
      JSON.stringify({
        case: 'card-watch-vs-bulk-checkbox',
        sampleCount: result.sampleCount,
        misses: result.misses,
        buttonRect: result.buttonRect,
        checkboxRect: result.checkboxRect,
        overlapPx: result.overlapPx,
      }),
    );
  });

  test('375x812: bulk checkbox remains tappable at 44×44', async ({ page }) => {
    await page.goto('/');

    const card = page.locator('article', { hasText: TICKET_TITLE });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.evaluate((element) =>
      element.scrollIntoView({ block: 'center', inline: 'center' }),
    );

    const result: CheckboxTapResult = await card.evaluate((cardElement) => {
      const checkbox = cardElement.querySelector('.card-bulk-checkbox');
      if (!(checkbox instanceof HTMLElement)) {
        return { found: false, checkboxHit: false, width: 0, height: 0 };
      }

      const rect = checkbox.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      const checkboxHit =
        hit instanceof Element && (hit === checkbox || checkbox.contains(hit));

      return {
        found: true,
        checkboxHit,
        width: rect.width,
        height: rect.height,
      };
    });

    expect(result.found, 'bulk checkbox must exist').toBe(true);
    expect(result.checkboxHit, 'elementFromPoint at checkbox centre must hit checkbox').toBe(true);
    expect(
      result.width >= MIN_TAP_TARGET_PX && result.height >= MIN_TAP_TARGET_PX,
      `bulk checkbox tap target too small (${result.width}x${result.height})`,
    ).toBe(true);
  });
});

test.describe('card watch toggle vs bulk checkbox — desktop must not leak mobile padding', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('1280x800: no overlap and padding-right stays 40px', async ({ page }) => {
    await page.goto('/');

    const card = page.locator('article', { hasText: TICKET_TITLE });
    await expect(card).toBeVisible({ timeout: 15_000 });

    const result: DesktopOverlapResult = await card.evaluate((cardElement) => {
      const button = cardElement.querySelector('.card-watch-toggle');
      const checkbox = cardElement.querySelector('.card-bulk-checkbox');
      if (!(button instanceof HTMLElement) || !(checkbox instanceof HTMLElement)) {
        return {
          found: false,
          overlapPx: 0,
          buttonRect: { left: 0, right: 0 },
          checkboxRect: { left: 0, right: 0 },
          paddingRight: '',
        };
      }

      const btnRect = button.getBoundingClientRect();
      const cbRect = checkbox.getBoundingClientRect();
      const overlapPx = Math.max(
        0,
        Math.min(btnRect.right, cbRect.right) - Math.max(btnRect.left, cbRect.left),
      );

      return {
        found: true,
        overlapPx,
        buttonRect: { left: btnRect.left, right: btnRect.right },
        checkboxRect: { left: cbRect.left, right: cbRect.right },
        paddingRight: getComputedStyle(cardElement).paddingRight,
      };
    });

    expect(result.found, 'watch toggle and bulk checkbox must exist on desktop').toBe(true);
    expect(
      result.overlapPx,
      `desktop watch toggle and checkbox must not overlap (overlapPx=${result.overlapPx}, button=${JSON.stringify(result.buttonRect)}, checkbox=${JSON.stringify(result.checkboxRect)})`,
    ).toBe(0);
    expect(
      result.paddingRight,
      'mobile padding-right:52px must not leak to desktop',
    ).toBe('40px');
  });
});
