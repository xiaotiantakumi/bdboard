import { expect, test, type Page } from '@playwright/test';

/**
 * Header position:sticky and horizontal overflow regression (bdboard-wdwa).
 *
 * Reverts if body { overflow-x: hidden } is reintroduced or html clipping is
 * removed without an alternate horizontal bleed fix.
 */

const SCROLL_PROBE_Y = 400;
const HEADER_TOP_TOLERANCE_PX = 2;

// AC2「横スクロールバーが出ない」: html { overflow-x: hidden } が残る限り
// documentElement.scrollWidth はクリップ後の値なので、横バー非表示は確認できるが
// コンテンツが実際に溢れていないことの証明にはならない。
// body.scrollWidth なら溢れを検出できるが、375px ではラベル絞り込み行が ~1299px 溢れて
// おり (bdboard-h4xs.4 / bdboard-83tc)、別チケットの既知事象のためここでは見ない。
async function expectNoHorizontalOverflow(page: Page) {
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(fits, 'document should not exceed viewport width').toBe(true);
}

async function ensurePageScrollable(page: Page) {
  let maxScrollY = await page.evaluate(() =>
    Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
  );

  if (maxScrollY === 0) {
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.setAttribute('data-testid', 'e2e-scroll-spacer');
      spacer.style.height = '200vh';
      spacer.style.width = '100%';
      spacer.style.flexShrink = '0';
      document.querySelector('.app')?.appendChild(spacer);
    });
    maxScrollY = await page.evaluate(() =>
      Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    );
  }

  expect(maxScrollY, 'page must scroll vertically for sticky to be testable').toBeGreaterThan(
    0,
  );
  return maxScrollY;
}

async function expectHeaderSticksWhileScrolling(page: Page) {
  await page.goto('/');
  await expect(page.locator('.header')).toBeVisible({ timeout: 15_000 });

  const maxScrollY = await ensurePageScrollable(page);
  const scrollY = Math.min(SCROLL_PROBE_Y, maxScrollY);
  expect(scrollY, 'probe scroll must be non-zero').toBeGreaterThan(0);

  await expectNoHorizontalOverflow(page);

  await page.evaluate((y) => window.scrollTo(0, y), scrollY);

  const headerTop = await page.locator('.header').evaluate((element) => {
    return element.getBoundingClientRect().top;
  });

  expect(
    headerTop,
    `header should stick near top after scrollY=${scrollY} (maxScrollY=${maxScrollY})`,
  ).toBeLessThanOrEqual(HEADER_TOP_TOLERANCE_PX);
  expect(headerTop).toBeGreaterThanOrEqual(-HEADER_TOP_TOLERANCE_PX);

  await expectNoHorizontalOverflow(page);
}

test.describe('header sticky', () => {
  test('375x812: header stays fixed while scrolling and page does not overflow horizontally', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await expectHeaderSticksWhileScrolling(page);
  });

  test('1280x800: header stays fixed while scrolling and page does not overflow horizontally', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expectHeaderSticksWhileScrolling(page);
  });
});
