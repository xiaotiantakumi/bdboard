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
 * 対照は 2 つ置く。
 * ・押されている種別チップ (.board-filter-type-group の bug)。選択中どうしを
 *   比べるので、差分が .active ではなく missing 由来だと言える。文字色を
 *   固定できるのもこちら (missing = 二次色 / 押された生きたチップ = アクセント)。
 * ・押されていない生きたラベルチップ (.board-filter-label-group の
 *   accessibility)。対照が種別チップだけだと、セレクタのスコープが緩んで
 *   「ラベルチップ全部に取り消し線」になる退行が全アサーションを素通りする。
 */
const MISSING_LABEL = 'gxq5-not-on-board';
const CONTROL_ISSUE_TYPE = 'bug';
/**
 * ゴールデンフィクスチャ (test/fixtures/bd/bdboard.list.json) の open チケット
 * bdboard-3tw.9 が持つラベル。盤面に実在するので必ずチップになる。
 */
const CONTROL_LIVE_LABEL = 'accessibility';
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
  color: string;
  paddingLeft: string;
  paddingRight: string;
  borderLeftWidth: string;
  borderRightWidth: string;
  minHeight: string;
  height: number;
}

interface MissingStyleStability {
  classAppliedAfterMs: number;
  stableAfterMs: number;
  samples: number;
}

/**
 * missing の印が付いたことを確認したうえで、rAF をまたぐ計算後スタイルの連続
 * 2 サンプルが一致するまで待つ。期待する色や影をここで見ないので、見た目の退行は
 * 下の個別アサーションとして明瞭に失敗する。
 */
async function waitForMissingStyleStability(chip: Locator): Promise<MissingStyleStability> {
  return chip.evaluate(async (el) => {
    const startedAt = performance.now();
    const timeoutMs = 10_000;
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const hasTimedOut = () => performance.now() - startedAt >= timeoutMs;
    const snapshot = () => {
      const style = getComputedStyle(el);
      return JSON.stringify({
        textDecorationLine: style.textDecorationLine,
        boxShadow: style.boxShadow,
        color: style.color,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        borderLeftWidth: style.borderLeftWidth,
        borderRightWidth: style.borderRightWidth,
        minHeight: style.minHeight,
        height: el.getBoundingClientRect().height,
      });
    };

    while (!el.classList.contains('board-filter-label-missing')) {
      if (hasTimedOut()) {
        throw new Error('timed out waiting for the missing-label marker class');
      }
      await nextFrame();
    }

    const classAppliedAfterMs = performance.now() - startedAt;
    // class を見付けたフレームと transition がスタートするフレームを分ける。
    await nextFrame();
    let samples = 1;
    let previous = snapshot();

    while (!hasTimedOut()) {
      await nextFrame();
      samples += 1;
      const current = snapshot();
      if (current === previous) {
        return { classAppliedAfterMs, stableAfterMs: performance.now() - startedAt, samples };
      }
      previous = current;
    }

    throw new Error('timed out waiting for missing-label computed styles to stabilize');
  });
}

/** 必要な対照チップを同じ browser-side evaluation で一括採取する。 */
type ChipNames = { missing: string; pressed?: string; live?: string };
type ChipStyles<T extends ChipNames> = { [Name in keyof T]: ChipStyle };

async function chipStyles<T extends ChipNames>(
  page: Page,
  names: T,
): Promise<ChipStyles<T>> {
  return page.evaluate((chipNames) => {
    const labelGroup = document.querySelector('.board-filter-label-group');
    if (!labelGroup) {
      throw new Error('could not snapshot label chips: .board-filter-label-group was not found');
    }

    const findChip = (group: Element, name: string, groupName: string) => {
      const chip = Array.from(group.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === name,
      );
      if (!chip) {
        throw new Error(`could not snapshot chip ${name} in ${groupName}`);
      }
      const style = getComputedStyle(chip);
      return {
        textDecorationLine: style.textDecorationLine,
        boxShadow: style.boxShadow,
        color: style.color,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        borderLeftWidth: style.borderLeftWidth,
        borderRightWidth: style.borderRightWidth,
        minHeight: style.minHeight,
        height: chip.getBoundingClientRect().height,
      };
    };

    const styles: Partial<Record<keyof ChipNames, ChipStyle>> = {
      missing: findChip(labelGroup, chipNames.missing, '.board-filter-label-group'),
    };
    if (chipNames.live) {
      styles.live = findChip(labelGroup, chipNames.live, '.board-filter-label-group');
    }
    if (chipNames.pressed) {
      const typeGroup = document.querySelector('.board-filter-type-group');
      if (!typeGroup) {
        throw new Error('could not snapshot type chip: .board-filter-type-group was not found');
      }
      styles.pressed = findChip(typeGroup, chipNames.pressed, '.board-filter-type-group');
    }

    return styles;
  }, names) as Promise<ChipStyles<T>>;
}

/** 幅方向の箱の寸法。ここが対照と一致していれば横並びを動かしていない。 */
function horizontalBox(style: ChipStyle) {
  return {
    paddingLeft: style.paddingLeft,
    paddingRight: style.paddingRight,
    borderLeftWidth: style.borderLeftWidth,
    borderRightWidth: style.borderRightWidth,
  };
}

function liveLabelChip(page: Page): Locator {
  // .board-filter-label-group に閉じて掴む。ラベル群の中の生きたチップである
  // ことまで込みで対照にしたいので、ページ全体から名前で拾わない。
  return page
    .locator('.board-filter-label-group')
    .getByRole('button', { name: CONTROL_LIVE_LABEL, exact: true });
}

test.describe('board filter chip for a label that left the board', () => {
  test('looks different from a live pressed chip without shrinking it', async ({ page }, testInfo) => {
    await installAiQuotaRoute(page);
    // 「盤面に無い」の印が付くのは盤面データが届いた後で、.toggle-btn は color と
    // box-shadow に 0.15s の transition を持つ。素で測ると補間中の値を掴む
    // (実測 rgb(37, 117, 205) = アクセント→二次色の途中)。reduced-motion の横断
    // ブロックで 0.01ms へ潰す。ここで見る色・影・余白の確定値は変わらない。
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seedFilterState(page);
    await page.goto('/');
    await expect(page.locator('.board-filter-label-group')).toBeVisible({ timeout: 15_000 });

    const missing = page.getByRole('button', { name: MISSING_LABEL });
    const pressedControl = page.getByRole('button', { name: CONTROL_ISSUE_TYPE, exact: true });
    const liveControl = liveLabelChip(page);
    await expect(missing).toBeVisible();
    await expect(pressedControl).toBeVisible();
    await expect(liveControl).toBeVisible();
    // 前提の自己防衛: 3 つの状態を取り違えていないことを先に固定する。
    await expect(missing).toHaveAttribute('aria-pressed', 'true');
    await expect(pressedControl).toHaveAttribute('aria-pressed', 'true');
    await expect(liveControl).toHaveAttribute('aria-pressed', 'false');

    const stability = await waitForMissingStyleStability(missing);
    testInfo.annotations.push({
      type: 'missing-label-style-stability',
      description: `${stability.samples} samples; class=${stability.classAppliedAfterMs.toFixed(1)}ms; stable=${stability.stableAfterMs.toFixed(1)}ms`,
    });
    const { missing: missingStyle, pressed: pressedStyle, live: liveStyle } = await chipStyles(
      page,
      { missing: MISSING_LABEL, pressed: CONTROL_ISSUE_TYPE, live: CONTROL_LIVE_LABEL },
    );

    expect(
      missingStyle.textDecorationLine,
      `missing chip must be struck through, got ${missingStyle.textDecorationLine}`,
    ).toContain('line-through');
    expect(pressedStyle.textDecorationLine).not.toContain('line-through');
    // セレクタが .board-filter-label-group .toggle-btn まで緩むと、盤面にある
    // ラベルまで「消えた」見た目になる。それを捕まえるのはこの 1 行だけ。
    expect(
      liveStyle.textDecorationLine,
      `a live label chip must not be struck through, got ${liveStyle.textDecorationLine}`,
    ).not.toContain('line-through');

    expect(
      missingStyle.boxShadow,
      `missing chip must carry an inset outline, got ${missingStyle.boxShadow}`,
    ).toContain('inset');
    expect(pressedStyle.boxShadow).not.toContain('inset');
    // リングの色まで固定する。--color-border-strong 相当の薄い色に戻すと地の
    // --color-bg-elevated に対して 1.5:1 前後しか出ず、inset があるのに見えない
    // (bdboard-gxq5 の A10)。取り消し線と同じ色で描かれていることを言う。
    expect(
      missingStyle.boxShadow,
      `the inset ring must be drawn in the chip's own dimmed colour (${missingStyle.color}), got ${missingStyle.boxShadow}`,
    ).toContain(missingStyle.color);
    expect(
      liveStyle.boxShadow,
      `a live label chip must not carry the inset outline, got ${liveStyle.boxShadow}`,
    ).not.toContain('inset');

    // 取り消し線とリングだけを見ていると color: の宣言を消しても両方緑のままになる。
    // 押された生きたチップはアクセント色、消えたチップは二次色。
    expect(
      missingStyle.color,
      `missing chip must be dimmed, not the pressed accent (${missingStyle.color})`,
    ).not.toBe(pressedStyle.color);
    // 議長裁定 (2026-09-05): 二次色のままにする。0 件しか出さないチップは機能的に
    // 空振りなので、アクセントより「これが 0 件の理由」を伝える方を採る。
    // 3 状態は 未選択(薄い) / 選択中で生存(アクセント) / 選択中で消滅(薄い+線+リング)。
    expect(missingStyle.color).toBe(liveStyle.color);

    // 幅方向の箱を変えていないこと。高さだけを見ていると padding: 0 4px のような
    // 「横だけ広げる」指定が素通りする (.board-filter-label-group は overflow-x
    // スクローラなので、1 チップの幅が変わると並びが動く)。
    expect(
      horizontalBox(missingStyle),
      `missing chip changed its horizontal box metrics: ${JSON.stringify(
        horizontalBox(missingStyle),
      )} vs ${JSON.stringify(horizontalBox(liveStyle))}`,
    ).toEqual(horizontalBox(liveStyle));

    // 縦は別グループの対照と比べる。同じ .toggle-group 内の兄弟と比べると
    // align-items: stretch に引き伸ばされて差が消えるため (下の 44px の件と同型)。
    expect(
      missingStyle.height,
      `missing chip height drifted from a live chip: ${missingStyle.height} vs ${pressedStyle.height}`,
    ).toBeCloseTo(pressedStyle.height, 1);
  });

  test('keeps the 44px tap target on mobile', async ({ browser }, testInfo) => {
    // viewport だけ絞ると (hover: none) and (pointer: coarse) のブロックが効かず、
    // モバイル固有の寸法を測り損ねる (bdboard-rccf)。
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      isMobile: true,
      hasTouch: true,
      // desktop 側と同じ理由 (印が付くのは盤面到着後、色と影に 0.15s の transition)。
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    try {
      await installAiQuotaRoute(page);
      await seedFilterState(page);
      await page.goto('/');
      await expect(page.locator('.board-filter-toggle')).toBeVisible({ timeout: 15_000 });
      await page.locator('.board-filter-toggle').click();

      const missing = page.getByRole('button', { name: MISSING_LABEL });
      const liveControl = liveLabelChip(page);
      await expect(missing).toBeVisible();
      await expect(liveControl).toBeVisible();
      const stability = await waitForMissingStyleStability(missing);
      testInfo.annotations.push({
        type: 'missing-label-style-stability',
        description: `mobile: ${stability.samples} samples; class=${stability.classAppliedAfterMs.toFixed(1)}ms; stable=${stability.stableAfterMs.toFixed(1)}ms`,
      });
      const { missing: style, live: liveStyle } = await chipStyles(page, {
        missing: MISSING_LABEL,
        live: CONTROL_LIVE_LABEL,
      });

      // 描画高さを見てはいけない。.toggle-group は align-items:stretch なので、
      // 44px の兄弟チップが 1 つでもあれば潰した指定を書いても実測は 44px のまま
      // 通る (この spec で実際に 2 度空振りした)。効いている指定そのものを見る。
      expect(
        style.minHeight,
        `missing-label chip lost the mobile 44px floor: min-height=${style.minHeight}`,
      ).toBe(`${MIN_TAP_TARGET_PX}px`);
      // 幅方向は 480px 以下のブロックで別途足される可能性があるので、desktop 側と
      // 同じ比較をこの幅でもやる。375px の横スクロールが伸びる退行がここに出る。
      expect(
        horizontalBox(style),
        `missing chip changed its horizontal box metrics at 375px: ${JSON.stringify(
          horizontalBox(style),
        )} vs ${JSON.stringify(horizontalBox(liveStyle))}`,
      ).toEqual(horizontalBox(liveStyle));
    } finally {
      await context.close();
    }
  });
});
