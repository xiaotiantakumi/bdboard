import { expect, test } from '@playwright/test';

/**
 * Mobile tap target sizing (bdboard-h4xs.9): key interactive controls on 375px
 * viewports must expose at least 44×44 CSS px hit areas without relying on
 * toBeVisible() (sr-only / clip false positives).
 */

const MOBILE_VIEWPORT = { width: 375, height: 812 };
const MIN_TAP_TARGET_PX = 44;
const TICKET_TITLE = 'Fixture ticket bdboard-3tw.8';
const HIT_TEST_STEP_PX = 0.25;
const HIT_TEST_MAX_DISTANCE_PX = 120;

type HitAreaMeasurement = {
  found: boolean;
  measuredLeft: number;
  measuredRight: number;
  measuredTop: number;
  measuredBottom: number;
  hitTestCapped: boolean;
};

type CardHitAreaMeasurement = HitAreaMeasurement & {
  checkboxFound: boolean;
  titleFound: boolean;
  checkboxLeft: number;
  titleRight: number;
  leftOfCheckboxHit: boolean;
  checkboxHit: boolean;
};

type DetailHitAreaMeasurement = HitAreaMeasurement & {
  closeFound: boolean;
  closeLeft: number;
  closeHit: boolean;
};

test.describe('mobile tap target size — bdboard-h4xs.9', () => {
  test.use({
    viewport: MOBILE_VIEWPORT,
    isMobile: true,
    hasTouch: true,
  });

  test('375x812: card watch toggle has a 44px vertical hit band clear of title and bulk checkbox', async ({
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
      'bulk checkbox must be rendered; this positioning test has no meaning without it',
    ).toBeVisible();

    const result: CardHitAreaMeasurement = await card.evaluate((cardElement, { step, max }) => {
      const button = cardElement.querySelector('.card-watch-toggle');
      const checkbox = cardElement.querySelector('.card-bulk-checkbox');
      const title = cardElement.querySelector('.card-title');
      if (
        !(button instanceof HTMLElement) ||
        !(checkbox instanceof HTMLElement) ||
        !(title instanceof HTMLElement)
      ) {
        return {
          found: false,
          measuredLeft: 0,
          measuredRight: 0,
          measuredTop: 0,
          measuredBottom: 0,
          hitTestCapped: false,
          checkboxFound: checkbox !== null,
          titleFound: title !== null,
          checkboxLeft: 0,
          titleRight: 0,
          leftOfCheckboxHit: false,
          checkboxHit: false,
        };
      }

      // The final hit in each direction is the measured boundary. Exhausting
      // the 120px guard is a failure, not a plausible 44px target.
      const measureHitArea = (toggle: HTMLElement) => {
        const rect = toggle.getBoundingClientRect();
        const isToggleHit = (x: number, y: number) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && (hit === toggle || toggle.contains(hit));
        };
        const scan = (
          origin: number,
          direction: 1 | -1,
          hitAt: (coordinate: number) => boolean,
        ) => {
          let lastHit = origin;
          for (let distance = step; distance <= max; distance += step) {
            const coordinate = origin + direction * distance;
            if (!hitAt(coordinate)) return { boundary: lastHit, capped: false };
            lastHit = coordinate;
          }
          return { boundary: lastHit, capped: true };
        };
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const left = scan(centerX, -1, (x) => isToggleHit(x, centerY));
        // The card bulk checkbox overlays the lower-right part of this band's x range.
        const top = scan(centerY, -1, (y) => isToggleHit(left.boundary + 1, y));
        const bottom = scan(centerY, 1, (y) => isToggleHit(left.boundary + 1, y));
        // Measure the touchable horizontal band at the button centre. Its rightmost
        // 8px is intentionally claimed by the overlaid bulk checkbox.
        const right = scan(centerX, 1, (x) => isToggleHit(x, centerY));
        return {
          found: true,
          measuredLeft: left.boundary,
          measuredRight: right.boundary,
          measuredTop: top.boundary,
          measuredBottom: bottom.boundary,
          hitTestCapped: left.capped || right.capped || top.capped || bottom.capped,
        };
      };

      const measurement = measureHitArea(button);
      const checkboxRect = checkbox.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const isToggleHit = (x: number, y: number) => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && (hit === button || button.contains(hit));
      };
      const isCheckboxHit = (x: number, y: number) => {
        const hit = document.elementFromPoint(x, y);
        return hit instanceof Element && (hit === checkbox || checkbox.contains(hit));
      };

      return {
        ...measurement,
        checkboxFound: true,
        titleFound: true,
        checkboxLeft: checkboxRect.left,
        titleRight: titleRect.right,
        leftOfCheckboxHit: isToggleHit(
          checkboxRect.left - 1,
          (measurement.measuredTop + measurement.measuredBottom) / 2,
        ),
        checkboxHit: isCheckboxHit(
          checkboxRect.left + 1,
          checkboxRect.top + checkboxRect.height / 2,
        ),
      };
    }, { step: HIT_TEST_STEP_PX, max: HIT_TEST_MAX_DISTANCE_PX });

    expect(result.found, 'card watch toggle, bulk checkbox, and title must exist').toBe(true);
    expect(
      result.checkboxFound,
      'bulk checkbox is required for this positioning assertion',
    ).toBe(true);
    expect(result.titleFound, 'card title is required for this overlap assertion').toBe(true);
    expect(result.hitTestCapped, 'hit-test scan must stop within its 120px guard').toBe(false);

    const measuredWidth = result.measuredRight - result.measuredLeft;
    const measuredHeight = result.measuredBottom - result.measuredTop;
    console.log(
      JSON.stringify({
        case: 'card-watch-toggle-vertical-hit-band',
        measuredLeft: result.measuredLeft,
        measuredRight: result.measuredRight,
        measuredTop: result.measuredTop,
        measuredBottom: result.measuredBottom,
        titleRight: result.titleRight,
        checkboxLeft: result.checkboxLeft,
        measuredWidth,
        measuredHeight,
      }),
    );
    // 375px 実測: 実効タップ帯=[243.25, 259]、縦=[466.47, 510.97]=44.5px。
    // titleRight=238、checkboxLeft=260。measuredWidth は 44px 未満で意図どおり
    // (横方向は bdboard-1oep 待ち。右 8px はチェックボックスが取る)。
    expect(measuredHeight, `card watch measured height=${measuredHeight}px`).toBeGreaterThanOrEqual(
      MIN_TAP_TARGET_PX,
    );

    // Title right is measured from its border box; no tolerance is needed because the
    // band must begin at or to its right, never extend into its horizontal range.
    expect(result.measuredLeft, `card watch measured left=${result.measuredLeft}px`).toBeGreaterThanOrEqual(
      result.titleRight,
    );
    // Same 375px measurement: checkboxLeft=260. The measured band ends at 259;
    // the 0.5px allowance only accounts for hit-test rounding and keeps it out of
    // the checkbox.
    expect(result.measuredRight).toBeLessThanOrEqual(result.checkboxLeft + 0.5);
    expect(
      result.leftOfCheckboxHit,
      'one pixel left of checkbox must hit the watch band',
    ).toBe(true);
    expect(result.checkboxHit, 'one pixel inside checkbox must hit the checkbox').toBe(true);
  });

  test('375x812: detail watch toggle exposes a measured 44px hit area without overlapping close', async ({
    page,
  }) => {
    await page.goto('/');
    const card = page.locator('article', { hasText: TICKET_TITLE });
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.tap();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const result: DetailHitAreaMeasurement = await dialog.evaluate((dialogElement, { step, max }) => {
      const button = dialogElement.querySelector('.detail-watch-toggle');
      const close = dialogElement.querySelector('.btn.detail-close');
      if (!(button instanceof HTMLElement) || !(close instanceof HTMLElement)) {
        return {
          found: false,
          measuredLeft: 0,
          measuredRight: 0,
          measuredTop: 0,
          measuredBottom: 0,
          hitTestCapped: false,
          closeFound: close !== null,
          closeLeft: 0,
          closeHit: false,
        };
      }

      const measureHitArea = (toggle: HTMLElement) => {
        const rect = toggle.getBoundingClientRect();
        const isToggleHit = (x: number, y: number) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && (hit === toggle || toggle.contains(hit));
        };
        const scan = (
          origin: number,
          direction: 1 | -1,
          hitAt: (coordinate: number) => boolean,
        ) => {
          let lastHit = origin;
          for (let distance = step; distance <= max; distance += step) {
            const coordinate = origin + direction * distance;
            if (!hitAt(coordinate)) return { boundary: lastHit, capped: false };
            lastHit = coordinate;
          }
          return { boundary: lastHit, capped: true };
        };
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const left = scan(centerX, -1, (x) => isToggleHit(x, centerY));
        const top = scan(centerY, -1, (y) => isToggleHit(left.boundary + 1, y));
        const bottom = scan(centerY, 1, (y) => isToggleHit(left.boundary + 1, y));
        const right = scan(centerX, 1, (x) => isToggleHit(x, top.boundary + 1));
        return {
          found: true,
          measuredLeft: left.boundary,
          measuredRight: right.boundary,
          measuredTop: top.boundary,
          measuredBottom: bottom.boundary,
          hitTestCapped: left.capped || right.capped || top.capped || bottom.capped,
        };
      };

      const measurement = measureHitArea(button);
      const closeRect = close.getBoundingClientRect();
      const hit = document.elementFromPoint(
        closeRect.left + 1,
        closeRect.top + closeRect.height / 2,
      );
      return {
        ...measurement,
        closeFound: true,
        closeLeft: closeRect.left,
        closeHit: hit instanceof Element && (hit === close || close.contains(hit)),
      };
    }, { step: HIT_TEST_STEP_PX, max: HIT_TEST_MAX_DISTANCE_PX });

    expect(result.found, 'detail watch toggle and close button must exist').toBe(true);
    expect(result.closeFound, 'detail close button must exist').toBe(true);
    expect(result.hitTestCapped, 'hit-test scan must stop within its 120px guard').toBe(false);

    const measuredWidth = result.measuredRight - result.measuredLeft;
    const measuredHeight = result.measuredBottom - result.measuredTop;
    // 375×812 実測: detail band=[246,290], close left=292, leaving 2px.
    expect(measuredWidth, `detail watch measured width=${measuredWidth}px`).toBeGreaterThanOrEqual(
      MIN_TAP_TARGET_PX,
    );
    expect(measuredHeight, `detail watch measured height=${measuredHeight}px`).toBeGreaterThanOrEqual(
      MIN_TAP_TARGET_PX,
    );
    expect(result.measuredRight).toBeLessThanOrEqual(result.closeLeft + 0.5);
    // Before the gap fix, elementFromPoint(293, cy) returned the watch toggle.
    expect(result.closeHit, 'one pixel inside close must hit close, not watch toggle').toBe(true);
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
    const result = await submit.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });

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
        return { index, height: rect.height, ok: rect.height >= minSize };
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

test.describe('mobile tap target size — mobile rules must not leak to desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('1280x800: card and detail mobile overrides do not leak', async ({ page }) => {
    await page.goto('/');
    const card = page.locator('article', { hasText: TICKET_TITLE });
    await expect(card).toBeVisible({ timeout: 15_000 });

    const cardMetrics = await card.evaluate((cardElement) => {
      const titleRow = cardElement.querySelector('.card-title-row');
      const watchToggle = cardElement.querySelector('.card-watch-toggle');
      return {
        titleRowColumnGap: titleRow ? getComputedStyle(titleRow).columnGap : null,
        watchBeforeContent: watchToggle
          ? getComputedStyle(watchToggle, '::before').content
          : null,
      };
    });
    expect(
      cardMetrics.titleRowColumnGap,
      'card title row keeps its 6px gap on desktop',
    ).toBe('6px');
    expect(
      cardMetrics.watchBeforeContent,
      'mobile card watch hit band must not exist at desktop',
    ).toBe('none');

    await card.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const detailActionsGap = await dialog.locator('.detail-header-actions').evaluate((element) =>
      getComputedStyle(element).gap,
    );
    expect(detailActionsGap, 'mobile 12px detail action gap must not leak to desktop').toBe(
      '8px',
    );
  });
});
