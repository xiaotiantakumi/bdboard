import { expect, test, type Page } from '@playwright/test';

/**
 * Help panel navigation (bdboard-h4xs.16).
 *
 * 375px で折りたたみ + 目次により、初期 scrollHeight を大幅に抑え、
 * 末尾セクションへ目次からジャンプできることを検証する。
 */
test.describe('help panel navigation', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  // 折りたたみ後の実測は約 2.0 画面 (scrollHeight ≈ 1450, clientHeight ≈ 716)。
  // 折りたたみ無しのベースラインは 25.36 画面。6 画面は実測の 3 倍弱で、
  // 折りたたみが消えれば必ず落ちるが、フォント/OS 差の余裕も確保する。
  const MAX_INITIAL_SCROLL_SCREENS = 6;

  async function openHelpFromPalette(page: Page) {
    await page.keyboard.press('Meta+k');
    const palette = page.getByRole('dialog', { name: 'コマンドパレット' });
    await expect(palette).toBeVisible({ timeout: 15_000 });

    await page.getByRole('searchbox', { name: '検索クエリ' }).fill('ヘルプ');
    await page.getByRole('option', { name: /ヘルプを開く/ }).click();

    const helpDialog = page.getByRole('dialog', { name: 'ヘルプ' });
    await expect(helpDialog).toBeVisible({ timeout: 15_000 });
    return helpDialog;
  }

  test('opens from command palette and keeps collapsed body height manageable', async ({
    page,
  }) => {
    await page.goto('/');

    const card = page.locator('article').first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    await openHelpFromPalette(page);

    const scrollMetrics = await page.evaluate(() => {
      const body = document.querySelector('.help-panel-body');
      if (!(body instanceof HTMLElement)) {
        return null;
      }
      const clientHeight = body.clientHeight;
      const scrollHeight = body.scrollHeight;
      return {
        clientHeight,
        scrollHeight,
        screens: clientHeight > 0 ? scrollHeight / clientHeight : Number.NaN,
      };
    });

    expect(scrollMetrics).not.toBeNull();
    expect(scrollMetrics!.clientHeight).toBeGreaterThan(0);
    expect(scrollMetrics!.screens).toBeLessThanOrEqual(MAX_INITIAL_SCROLL_SCREENS);
  });

  test('table of contents count matches section headings and jumps to the last section', async ({
    page,
  }) => {
    await page.goto('/');

    const card = page.locator('article').first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    await openHelpFromPalette(page);

    const counts = await page.evaluate(() => {
      const tocItems = document.querySelectorAll('.help-panel-toc-item');
      const headings = document.querySelectorAll('.help-panel-section h3');
      return {
        tocCount: tocItems.length,
        headingCount: headings.length,
      };
    });

    expect(counts.tocCount).toBeGreaterThan(0);
    expect(counts.tocCount).toBe(counts.headingCount);

    const lastTocItem = page.locator('.help-panel-toc-item').last();
    const lastTitle = (await lastTocItem.textContent())?.trim() ?? '';
    expect(lastTitle.length).toBeGreaterThan(0);

    await lastTocItem.click();

    const lastHeading = page.getByRole('heading', { name: lastTitle, exact: true });
    await expect(lastHeading).toBeVisible();
    await expect(
      page.locator('.help-panel-section', { has: lastHeading }),
    ).toHaveAttribute('open');

    await expect
      .poll(async () =>
        lastHeading.evaluate((heading) => {
          const body = document.querySelector('.help-panel-body');
          if (!(body instanceof HTMLElement) || !(heading instanceof HTMLElement)) {
            return false;
          }
          const bodyRect = body.getBoundingClientRect();
          const headingRect = heading.getBoundingClientRect();
          return (
            headingRect.top >= bodyRect.top &&
            headingRect.bottom <= bodyRect.bottom
          );
        }),
      )
      .toBe(true);
  });

  test('keeps focus inside the help dialog when tabbing from the last section summary', async ({
    page,
  }) => {
    await page.goto('/');

    const card = page.locator('article').first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    const helpDialog = await openHelpFromPalette(page);

    const lastSummary = helpDialog.locator('.help-panel-section-summary').last();
    await lastSummary.click();
    await expect(lastSummary).toBeFocused();

    await page.keyboard.press('Tab');

    const focusStayedInside = await page.evaluate(() => {
      const panel = document.querySelector('.help-panel[role="dialog"]');
      return panel !== null && panel.contains(document.activeElement);
    });
    expect(focusStayedInside).toBe(true);
  });
});
