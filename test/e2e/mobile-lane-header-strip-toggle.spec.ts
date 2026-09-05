import { expect, test, type Page } from '@playwright/test';

/**
 * bdboard-6y5b: モバイルで `.lane-header` (レーン名・件数・折りたたみトグル) を
 * 丸ごと描画せず、`.lane-indicator-strip` (レーンスクロールインジケータ) 側に
 * 折りたたみトグルを移す方式の回帰ガード。
 *
 * 背景 (bdboard-knrx / bdboard-t0hx): モバイルでページを最下端まで送ると、レーン箱の
 * 上端が sticky な `.lane-indicator-strip` の下に潜り込み、`.lane-header` が隠れて
 * 折りたたみトグルに指が届かなくなる問題があった。PR #392 (`.lane` の高さ上限リテラルを
 * 実ヘッダー高へ追従させる案) はカード密度を 10.1% 悪化させたため不採用となり、
 * 本チケットではストリップに既にあるレーン名・件数と重複する `.lane-header` を
 * モバイルで描画しないことにした (index.css の `@media (max-width: 700px)` 内
 * `.lane-header { display: none; }`)。
 *
 * 証明している:
 * - モバイル幅の統合ビュー・分割ビュー双方で `.lane-header` のラベル部が描画されない
 *   (描画されない = そもそも隠れようがなく、症状が構造的に起きえないことの根拠)
 * - 折りたたみトグルがストリップ側 (`.lane-indicator-collapse-toggle`) に存在し、
 *   実際に押して開閉が効く (到達性)
 * - デスクトップ幅では従来どおり `.lane-header` にラベル部・件数・トグルがある
 *
 * 証明していない:
 * - ストリップの sticky 挙動そのもの (kanban-mobile-lanes.spec.ts が担当)
 * - `.lane` の高さ上限 (`260px` の減算式) — 本チケットは触っていない
 */

const MOBILE_VIEWPORT = { width: 375, height: 812 };
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

async function gotoBoard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.lanes-row .lane').first()).toBeVisible({ timeout: 15_000 });
}

test.describe('mobile: lane-header suppressed, toggle moved to the strip (bdboard-6y5b)', () => {
  test.use({ viewport: MOBILE_VIEWPORT, isMobile: true, hasTouch: true });

  test('merged view: .lane-header label part is not rendered', async ({ page }) => {
    await gotoBoard(page);

    // .lane-header 自体 (ラベル部・件数・トグルを含む全体) が描画されない。
    await expect(page.locator('.lane-header').first()).toBeHidden();
    await expect(page.locator('.lane-header-label').first()).toBeHidden();
    await expect(page.locator('.lane-count').first()).toBeHidden();
  });

  test('merged view: even at the page bottom, nothing is hidden because .lane-header never renders', async ({
    page,
  }) => {
    await gotoBoard(page);

    // 症状の再現条件 (ページ最下端までスクロール) を再現しても、.lane-header は
    // そもそも描画されていないので「隠れる」ことが起こりようがないことを確認する。
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(page.locator('.lane-header').first()).toBeHidden();
    await expect(page.locator('.lane-indicator-strip')).toBeVisible();
  });

  test('merged view: the collapse toggle lives in the strip and actually opens/closes the lane', async ({
    page,
  }) => {
    await gotoBoard(page);

    const strip = page.locator('.lane-indicator-strip');
    await expect(strip).toBeVisible();

    const toggle = strip.locator('.lane-indicator-collapse-toggle').first();
    await expect(toggle).toBeVisible();

    const firstLane = page.locator('.lanes-row .lane').first();
    await expect(firstLane).not.toHaveClass(/lane-collapsed/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await toggle.click();
    await expect(firstLane).toHaveClass(/lane-collapsed/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // 到達性: 折りたたんだ後も同じボタンが押せて、再展開できる
    // (レーンヘッダー無しでも操作が行き止まりにならないことの確認)。
    await toggle.click();
    await expect(firstLane).not.toHaveClass(/lane-collapsed/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  test('split view: same lane-header suppression and working strip toggle', async ({ page }) => {
    await gotoBoard(page);

    await page.getByRole('button', { name: '分割' }).click();
    await expect(page.locator('.board-section .lane').first()).toBeVisible({
      timeout: 15_000,
    });

    // 分割ビューでも同じ症状 (bdboard-knrx notes の分割ビュー 28.23px 残存) が消えていること。
    // 本方式は .lane の減算式に触れないため、.board-section の margin-bottom は無関係になる —
    // .lane-header 自体が描画されないので、そもそも潜り込む対象が無い。
    await expect(page.locator('.board-section .lane-header').first()).toBeHidden();

    const firstSection = page.locator('.board-section').first();
    const toggle = firstSection.locator('.lane-indicator-collapse-toggle').first();
    await expect(toggle).toBeVisible();

    const firstLane = firstSection.locator('.lane').first();
    await expect(firstLane).not.toHaveClass(/lane-collapsed/);

    await toggle.click();
    await expect(firstLane).toHaveClass(/lane-collapsed/);

    await toggle.click();
    await expect(firstLane).not.toHaveClass(/lane-collapsed/);
  });
});

test.describe('desktop: lane-header keeps its label, count and toggle (bdboard-6y5b)', () => {
  test.use({ viewport: DESKTOP_VIEWPORT });

  test('lane-header is unchanged and the strip does not add a duplicate toggle', async ({ page }) => {
    await gotoBoard(page);

    const header = page.locator('.lane-header').first();
    await expect(header).toBeVisible();
    await expect(header.locator('.lane-header-label')).toBeVisible();
    await expect(header.locator('.lane-count')).toBeVisible();

    // デスクトップ幅ではストリップ自体が描画されない
    // (LaneScrollIndicator は useMatchMedia(MOBILE_LAYOUT_MEDIA_QUERY) が false だと null を返す)。
    await expect(page.locator('.lane-indicator-strip')).toHaveCount(0);

    // 既存どおり、レーンヘッダー自身のクリックで折りたたみが効く。
    await header.click();
    await expect(page.locator('.lanes-row .lane').first()).toHaveClass(/lane-collapsed/);
  });
});
