import { expect, test, type Locator, type Page } from '@playwright/test';

import { installAiQuotaRoute } from './fixtures/mobile-chrome-helpers.js';

/**
 * bdboard-gxq5: 盤面から消えたのに選択だけ残っているラベルのチップが、生きた
 * (押されている) チップと見分けられることを固定する。
 *
 * 単体テストは class と aria-describedby という DOM 契約しか見られない。実際に
 * 「見分けられる」かは index.css の .board-filter-label-missing 側にあるので、
 * ルールを消しても単体テストは緑のままになる。ここで計算後スタイルを実測する。
 *
 * 対照は同じ .toggle-btn.active である種別チップ。選択中どうしを比べるので、
 * 差分が .active ではなく missing 由来であることまで言える。
 */
const MISSING_LABEL = 'gxq5-not-on-board';
const CONTROL_ISSUE_TYPE = 'bug';
const MIN_TAP_TARGET_PX = 44;

async function seedFilterState(page: Page): Promise<void> {
  await page.addInitScript(
    ({ label, issueType }) => {
      // 盤面のどのチケットにも付いていないラベルを選択済みにする = 再現条件。
      localStorage.setItem('bdboard.ui.boardLabels', JSON.stringify([label]));
      // 対照用に「生きている」押されたチップを 1 つ確実に作る。種別チップは
      // BOARD_ISSUE_TYPES 固定なので、盤面の中身に依存せず必ず存在する。
      localStorage.setItem('bdboard.ui.boardIssueTypes', JSON.stringify([issueType]));
    },
    { label: MISSING_LABEL, issueType: CONTROL_ISSUE_TYPE },
  );
}

interface ChipStyle {
  textDecorationLine: string;
  boxShadow: string;
  minHeight: string;
  height: number;
}

/**
 * 実装の内部詳細 (class 名・title 属性) ではなくラベル文字列でチップを掴んでから
 * 計算後スタイルを読む。掴み方を fix 側の目印に寄せると、目印を消す変異が
 * 「要素が無い」ではなく「テストの前提が消えた」形になって読みにくい。
 */
async function chipStyle(chip: Locator): Promise<ChipStyle> {
  return chip.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      textDecorationLine: style.textDecorationLine,
      boxShadow: style.boxShadow,
      minHeight: style.minHeight,
      height: el.getBoundingClientRect().height,
    };
  });
}

test.describe('board filter chip for a label that left the board', () => {
  test('looks different from a live pressed chip without shrinking it', async ({ page }) => {
    await installAiQuotaRoute(page);
    await seedFilterState(page);
    await page.goto('/');
    await expect(page.locator('.board-filter-label-group')).toBeVisible({ timeout: 15_000 });

    const missing = page.getByRole('button', { name: MISSING_LABEL });
    const control = page.getByRole('button', { name: CONTROL_ISSUE_TYPE, exact: true });
    await expect(missing).toBeVisible();
    await expect(control).toBeVisible();
    // 前提の自己防衛: 差が .active の有無から出ていないことを保証する。
    await expect(missing).toHaveAttribute('aria-pressed', 'true');
    await expect(control).toHaveAttribute('aria-pressed', 'true');

    const missingStyle = await chipStyle(missing);
    const controlStyle = await chipStyle(control);

    expect(
      missingStyle.textDecorationLine,
      `missing chip must be struck through, got ${missingStyle.textDecorationLine}`,
    ).toContain('line-through');
    expect(controlStyle.textDecorationLine).not.toContain('line-through');

    expect(
      missingStyle.boxShadow,
      `missing chip must carry an inset outline, got ${missingStyle.boxShadow}`,
    ).toContain('inset');
    expect(controlStyle.boxShadow).not.toContain('inset');

    // 箱のサイズを変える指定 (border / padding) を足すとここで落ちる。
    expect(
      missingStyle.height,
      `missing chip height drifted from a live chip: ${missingStyle.height} vs ${controlStyle.height}`,
    ).toBeCloseTo(controlStyle.height, 1);
  });

  test('keeps the 44px tap target on mobile', async ({ browser }) => {
    // viewport だけ絞ると (hover: none) and (pointer: coarse) のブロックが効かず、
    // モバイル固有の寸法を測り損ねる (bdboard-rccf)。
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    try {
      await installAiQuotaRoute(page);
      await seedFilterState(page);
      await page.goto('/');
      await expect(page.locator('.board-filter-toggle')).toBeVisible({ timeout: 15_000 });
      await page.locator('.board-filter-toggle').click();

      const missing = page.getByRole('button', { name: MISSING_LABEL });
      await expect(missing).toBeVisible();
      const style = await chipStyle(missing);

      // 描画高さだけを見てはいけない。.toggle-group は align-items:stretch なので、
      // 44px の兄弟チップが 1 つでもあれば潰した指定を書いても実測は 44px のまま通る
      // (実際にこの spec で空振りした)。効いている指定そのものを見る。
      expect(
        style.minHeight,
        `missing-label chip lost the mobile 44px floor: min-height=${style.minHeight}`,
      ).toBe(`${MIN_TAP_TARGET_PX}px`);
      expect(
        style.height,
        `missing-label chip must meet WCAG 2.5.8: rendered height ${style.height}`,
      ).toBeGreaterThanOrEqual(MIN_TAP_TARGET_PX);
    } finally {
      await context.close();
    }
  });
});
