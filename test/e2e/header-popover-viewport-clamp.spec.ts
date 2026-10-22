import { expect, test, type Page } from '@playwright/test';

const MOBILE_320_VIEWPORT = { width: 320, height: 568 };
const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
const BOUNDS_EPSILON_PX = 0.5;

/** ボタンを押してポップオーバーを開き、ビューポートに収まっているかを返す。 */
async function openAndMeasure(page: Page, buttonSelector: string, popoverSelector: string) {
  await page.locator(buttonSelector).click();
  await expect(page.locator(popoverSelector)).toBeVisible();
  const result = await page.evaluate((sel) => {
    const rect = document.querySelector(sel)?.getBoundingClientRect();
    return {
      found: !!rect,
      left: rect?.left ?? Number.NaN,
      right: rect?.right ?? Number.NaN,
      innerWidth: window.innerWidth,
    };
  }, popoverSelector);
  await page.keyboard.press('Escape');
  return result;
}

function expectWithinViewport(
  name: string,
  r: { found: boolean; left: number; right: number; innerWidth: number },
) {
  expect(r.found, `${name} popover must be present`).toBe(true);
  expect(
    r.left >= -BOUNDS_EPSILON_PX && r.right <= r.innerWidth + BOUNDS_EPSILON_PX,
    `${name} popover must fit within viewport ` +
      `(left=${r.left}, right=${r.right}, innerWidth=${r.innerWidth})`,
  ).toBe(true);
}

// bdboard-gyvv: ヘッダー再設計後。フィルタ(プリセットを含む)はヘッダーのボタン、
// モバイルのフィルタは ⋯ のシートの中なので、ここで見るのは 3 種のポップオーバー。
test.describe('header popovers viewport clamp at 320px (bdboard-oeh5)', () => {
  test.use({ viewport: MOBILE_320_VIEWPORT, isMobile: true, hasTouch: true });

  test('320x568: project-picker / overflow-menu popovers stay within viewport', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });

    expectWithinViewport(
      'project-picker',
      await openAndMeasure(page, '.project-picker-button', '.project-picker-popover'),
    );
    expectWithinViewport(
      'overflow-menu',
      await openAndMeasure(page, '.overflow-menu-button', '.overflow-menu-popover'),
    );
  });
});

test.describe('header popovers viewport clamp — desktop (bdboard-oeh5)', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('1280x800: popovers stay within viewport', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });

    expectWithinViewport(
      'project-picker',
      await openAndMeasure(page, '.project-picker-button', '.project-picker-popover'),
    );
    expectWithinViewport(
      'filter-menu',
      await openAndMeasure(page, '.filter-menu-button', '.filter-menu-popover'),
    );
    expectWithinViewport(
      'overflow-menu',
      await openAndMeasure(page, '.overflow-menu-button', '.overflow-menu-popover'),
    );
  });
});
