import { expect, test, type Page } from '@playwright/test';

/**
 * 横向きスマートフォンでもモバイル上書きに入ることを検証する (bdboard-gx3i)。
 *
 * `.help-panel` / `.search-palette` の全画面・単カラム上書きはもともと
 * `@media (max-width: 700px)` / `@media (max-width: 480px)` にしか無く、横向き
 * スマホ (幅が 700px を超える) はどちらにも入らなかった。`(max-height: 500px)
 * and (orientation: landscape)` を幅条件へ OR することで、代表的な横向き解像度
 * (844x390 / 932x430) だけをこの上書きに追加で拾い、縦に余裕のある iPad 横
 * (1024x768) は対象から除外する — というのが本 PR の設計判断そのものであり、
 * この境界がその通りに機能していることを viewport 幅/高さだけで機械的に検証する。
 *
 * 証明していない:
 * - dvh の実際の縮み方 (lvh/dvh/svh が固定 viewport では一致するため Playwright では
 *   検証できない。実機確認は別途)。ここで検証しているのはあくまで
 *   「media query に入るかどうか」という viewport 幅/高さだけの問題。
 */

const LANDSCAPE_PHONE_VIEWPORTS = [
  { name: 'iPhone 14 landscape', width: 844, height: 390 },
  { name: 'larger Android landscape', width: 932, height: 430 },
];

/**
 * bdboard-gx3i (議長追加): 縦持ちスマホは幅 390px なので、本 PR の OR 条件とは関係なく
 * 従来どおり `max-width: 480px` / `max-width: 700px` 側だけで上書きに入る。
 *
 * それでもここで押さえるのは、本 PR が `.search-overlay` / `.search-palette` の宣言を
 * 480px ブロックから切り出して**ファイル後方の新しいブロックへ移動**しているため。
 * 移動先までの間に同じセレクタを触る規則が無いことはレビューで確認済みだが、
 * 将来そこへ規則が挿し込まれるとカスケード順が変わって静かに壊れる。横向き条件が
 * 壊れても縦持ちは通るので、上の landscape ケースとは独立した保護になる。
 */
const PORTRAIT_PHONE_VIEWPORTS = [{ name: 'iPhone 14 portrait', width: 390, height: 844 }];

const NOT_LANDSCAPE_PHONE_VIEWPORTS = [
  { name: 'iPad landscape', width: 1024, height: 768 },
  { name: 'desktop', width: 1280, height: 800 },
];

async function openHelpPanel(page: Page) {
  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog', { name: 'コマンドパレット' });
  await expect(palette).toBeVisible({ timeout: 15_000 });

  await page.getByRole('searchbox', { name: '検索クエリ' }).fill('ヘルプ');
  await page.getByRole('option', { name: /ヘルプを開く/ }).click();

  const helpDialog = page.getByRole('dialog', { name: 'ヘルプ' });
  await expect(helpDialog).toBeVisible({ timeout: 15_000 });
  return helpDialog;
}

async function openSearchPalette(page: Page) {
  await page.keyboard.press('Meta+k');
  const palette = page.getByRole('dialog', { name: 'コマンドパレット' });
  await expect(palette).toBeVisible({ timeout: 15_000 });
  return palette;
}

async function helpPanelGridColumnCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const grid = document.querySelector('.help-panel-grid');
    if (!(grid instanceof HTMLElement)) {
      throw new Error('.help-panel-grid not found');
    }
    const columns = getComputedStyle(grid).gridTemplateColumns.trim();
    return columns.length === 0 ? 0 : columns.split(/\s+/).length;
  });
}

async function searchPaletteIsFullscreen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const palette = document.querySelector('.search-palette');
    if (!(palette instanceof HTMLElement)) {
      throw new Error('.search-palette not found');
    }
    const style = getComputedStyle(palette);
    // 全画面上書きは border-radius:0 かつ幅がビューポート全幅 (100vw) になる。
    // ベース (割合指定) は border-radius: var(--radius-lg) (非0) かつ
    // width: min(640px, 100%) でビューポート全幅より確実に狭い。
    const borderRadiusIsZero = Number.parseFloat(style.borderRadius) === 0;
    const isFullWidth = palette.getBoundingClientRect().width >= window.innerWidth - 1;
    return borderRadiusIsZero && isFullWidth;
  });
}

test.describe('landscape phone falls into mobile overrides (bdboard-gx3i)', () => {
  for (const viewport of LANDSCAPE_PHONE_VIEWPORTS) {
    test(`help panel collapses to a single column at ${viewport.name} (${viewport.width}x${viewport.height})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.locator('article').first()).toBeVisible({ timeout: 15_000 });

      await openHelpPanel(page);

      await expect
        .poll(() => helpPanelGridColumnCount(page))
        .toBe(1);
    });

    test(`search palette becomes fullscreen at ${viewport.name} (${viewport.width}x${viewport.height})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.locator('article').first()).toBeVisible({ timeout: 15_000 });

      await openSearchPalette(page);

      await expect.poll(() => searchPaletteIsFullscreen(page)).toBe(true);
    });
  }

  for (const viewport of PORTRAIT_PHONE_VIEWPORTS) {
    test(`search palette stays fullscreen at ${viewport.name} (${viewport.width}x${viewport.height})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.locator('article').first()).toBeVisible({ timeout: 15_000 });

      await openSearchPalette(page);

      await expect.poll(() => searchPaletteIsFullscreen(page)).toBe(true);
    });

    test(`help panel stays single column at ${viewport.name} (${viewport.width}x${viewport.height})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.locator('article').first()).toBeVisible({ timeout: 15_000 });

      await openHelpPanel(page);

      await expect.poll(() => helpPanelGridColumnCount(page)).toBe(1);
    });
  }

  for (const viewport of NOT_LANDSCAPE_PHONE_VIEWPORTS) {
    test(`help panel stays multi-column at ${viewport.name} (${viewport.width}x${viewport.height})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.locator('article').first()).toBeVisible({ timeout: 15_000 });

      await openHelpPanel(page);

      await expect
        .poll(() => helpPanelGridColumnCount(page))
        .toBeGreaterThan(1);
    });

    test(`search palette stays capped (not fullscreen) at ${viewport.name} (${viewport.width}x${viewport.height})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await expect(page.locator('article').first()).toBeVisible({ timeout: 15_000 });

      await openSearchPalette(page);

      await expect.poll(() => searchPaletteIsFullscreen(page)).toBe(false);
    });
  }
});
