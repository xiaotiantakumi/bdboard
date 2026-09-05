import { expect, test } from '@playwright/test';
import {
  DEFAULT_BULK_SELECTION_IDS,
  openBoardWithBulkActionBarCustomDefer,
  selectTickets,
  waitForBulkActionBar,
} from './fixtures/bulk-selection.js';

/**
 * BulkActionBar のカスタム延期行レイアウト (bdboard-h4xs.11 / bdboard-53my)。
 *
 * @media (max-width: 480px) の `flex: 1 1 100%` が効いて延期グループが独立行になること、
 * および「完了」ボタンが単独全幅行にならないことを getBoundingClientRect で検証する。
 * toHaveClass だけでは「CSS が効いていない」失敗形をすり抜けるため、この層が必要。
 */

const TICKET_TITLE = 'Fixture ticket bdboard-3tw.8';
const ROW_Y_TOLERANCE_PX = 2;
const EDGE_TOLERANCE_PX = 0.5;
const FULL_WIDTH_RATIO = 0.9;
const DEFER_ROW_FULL_WIDTH_RATIO = 0.95;
const DETAIL_COMPLETE_FULL_WIDTH_RATIO = 0.5;
const FIRST_ROW_RIGHT_GAP_MAX_PX = 8;
const NON_CUSTOM_COMPLETE_MIN_WIDTH_RATIO = 0.2;
// bdboard-rccf: コンテナ基準のはみ出し許容。clientWidth の整数丸めと
// getBoundingClientRect() の小数を混ぜるので最大 0.5px の誤差が入る。
// 対象バグは 7px なので、この許容で見逃さない。
const CONTAINER_OVERFLOW_TOLERANCE_PX = 0.5;
// bdboard-rccf: date 入力が「制約を外したときの自分の幅」の何割を保てば
// 潰れていないとみなすか。実測比 0.927 (136.203125 / 147, chromium/macOS)。
const DATE_INPUT_MIN_SHRINK_RATIO = 0.85;

interface RectSnapshot {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
}

interface ChildLayoutSnapshot {
  selectorHint: string;
  rect: RectSnapshot;
}

interface BulkButtonsLayoutMetrics {
  containerClientWidth: number;
  children: ChildLayoutSnapshot[];
  rowCount: number;
  deferGroupIndex: number;
  completeButtonIndex: number;
  deferGroupOnOwnRow: boolean;
  deferGroupWidthRatio: number;
  deferGroupSpansFullRow: boolean;
  completeButtonSharesRow: boolean;
  completeButtonWidthRatio: number;
  completeButtonNotSoloFullWidth: boolean;
  firstRowChildCount: number;
  firstRowRightGapPx: number;
  bodyScrollWidth: number;
  viewportInnerWidth: number;
  horizontalOverflow: boolean;
}

async function measureBulkButtonsLayout(page: import('@playwright/test').Page): Promise<BulkButtonsLayoutMetrics> {
  return page.evaluate(
    ({ rowTolerance, edgeTolerance, fullWidthRatio, deferRowFullWidthRatio }) => {
      const container = document.querySelector('.bulk-action-bar .bulk-action-bar-buttons');
      if (!(container instanceof HTMLElement)) {
        throw new Error('bulk-action-bar-buttons not found');
      }

      const childElements = Array.from(container.children).filter(
        (node): node is HTMLElement => node instanceof HTMLElement,
      );

      const children = childElements.map((element) => {
        const rect = element.getBoundingClientRect();
        const classes = typeof element.className === 'string' ? element.className : '';
        const selectorHint =
          classes.includes('quick-action-defer-group-custom')
            ? 'defer-group-custom'
            : classes.includes('quick-action-defer-group')
              ? 'defer-group'
              : element.tagName.toLowerCase() === 'button'
                ? `button:${(element.textContent ?? '').trim()}`
                : element.className || element.tagName.toLowerCase();

        return {
          selectorHint,
          rect: {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
          },
        };
      });

      const deferGroupIndex = childElements.findIndex((element) =>
        element.classList.contains('quick-action-defer-group-custom'),
      );
      const completeButtonIndex = childElements.findIndex(
        (element) =>
          element instanceof HTMLButtonElement && element.textContent?.trim() === '完了',
      );

      const deferGroup = deferGroupIndex >= 0 ? children[deferGroupIndex] : undefined;
      const completeButton =
        completeButtonIndex >= 0 ? children[completeButtonIndex] : undefined;

      let deferGroupOnOwnRow = deferGroup !== undefined;
      let deferGroupWidthRatio = 0;
      let deferGroupSpansFullRow = false;

      if (deferGroup !== undefined) {
        deferGroupWidthRatio =
          container.clientWidth > 0 ? deferGroup.rect.width / container.clientWidth : 0;
        deferGroupSpansFullRow = deferGroupWidthRatio >= deferRowFullWidthRatio;

        for (let index = 0; index < children.length; index += 1) {
          if (index === deferGroupIndex) {
            continue;
          }
          const sibling = children[index]!;
          const overlaps =
            deferGroup.rect.top < sibling.rect.bottom - edgeTolerance &&
            sibling.rect.top < deferGroup.rect.bottom - edgeTolerance;
          if (overlaps) {
            deferGroupOnOwnRow = false;
            break;
          }
        }
      } else {
        deferGroupOnOwnRow = false;
      }

      let completeButtonSharesRow = false;
      let completeButtonWidthRatio = 0;
      let completeButtonNotSoloFullWidth = false;

      if (completeButton !== undefined) {
        completeButtonWidthRatio =
          container.clientWidth > 0 ? completeButton.rect.width / container.clientWidth : 0;

        for (let index = 0; index < children.length; index += 1) {
          if (index === completeButtonIndex) {
            continue;
          }
          const sibling = children[index]!;
          const sameRow =
            Math.abs(sibling.rect.top - completeButton.rect.top) <= rowTolerance ||
            (completeButton.rect.top < sibling.rect.bottom - edgeTolerance &&
              sibling.rect.top < completeButton.rect.bottom - edgeTolerance);
          if (sameRow) {
            completeButtonSharesRow = true;
            break;
          }
        }

        completeButtonNotSoloFullWidth =
          completeButtonSharesRow ||
          completeButtonWidthRatio < fullWidthRatio;
      }

      const rowTops: number[] = [];
      for (const child of children) {
        const existing = rowTops.find(
          (top) => Math.abs(top - child.rect.top) <= rowTolerance,
        );
        if (existing === undefined) {
          rowTops.push(child.rect.top);
        }
      }

      const firstRowTop = rowTops.length > 0 ? rowTops[0]! : 0;
      const firstRowChildren = children.filter(
        (child) => Math.abs(child.rect.top - firstRowTop) <= rowTolerance,
      );
      const firstRowChildCount = firstRowChildren.length;
      const firstRowMaxRight = firstRowChildren.reduce(
        (max, child) => Math.max(max, child.rect.right),
        0,
      );

      const containerRect = container.getBoundingClientRect();
      const computedStyle = window.getComputedStyle(container);
      const paddingRight = Number.parseFloat(computedStyle.paddingRight) || 0;
      const contentBoxRight = containerRect.left + container.clientWidth - paddingRight;
      const firstRowRightGapPx = contentBoxRight - firstRowMaxRight;

      return {
        containerClientWidth: container.clientWidth,
        children,
        rowCount: rowTops.length,
        deferGroupIndex,
        completeButtonIndex,
        deferGroupOnOwnRow,
        deferGroupWidthRatio,
        deferGroupSpansFullRow,
        completeButtonSharesRow,
        completeButtonWidthRatio,
        completeButtonNotSoloFullWidth,
        firstRowChildCount,
        firstRowRightGapPx,
        bodyScrollWidth: document.body.scrollWidth,
        viewportInnerWidth: window.innerWidth,
        horizontalOverflow: document.body.scrollWidth > window.innerWidth,
      };
    },
    {
      rowTolerance: ROW_Y_TOLERANCE_PX,
      edgeTolerance: EDGE_TOLERANCE_PX,
      fullWidthRatio: FULL_WIDTH_RATIO,
      deferRowFullWidthRatio: DEFER_ROW_FULL_WIDTH_RATIO,
    },
  );
}

interface DetailQuickButtonsLayoutMetrics {
  containerClientWidth: number;
  rowCount: number;
  completeButtonSharesRow: boolean;
  completeButtonWidthRatio: number;
  completeButtonNotSoloFullWidth: boolean;
  deferGroupOverlapsAnySibling: boolean;
  bodyScrollWidth: number;
  viewportInnerWidth: number;
  horizontalOverflow: boolean;
}

async function measureDetailQuickButtonsLayout(
  page: import('@playwright/test').Page,
): Promise<DetailQuickButtonsLayoutMetrics> {
  return page.evaluate(
    ({ rowTolerance, edgeTolerance, fullWidthRatio }) => {
      const dialog = document.querySelector('[role="dialog"]');
      const container = dialog?.querySelector('.quick-action-buttons');
      if (!(container instanceof HTMLElement)) {
        throw new Error('detail panel quick-action-buttons not found');
      }

      const childElements = Array.from(container.children).filter(
        (node): node is HTMLElement => node instanceof HTMLElement,
      );

      const children = childElements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          rect: {
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
          },
          isDeferGroup: element.classList.contains('quick-action-defer-group'),
          isCompleteButton:
            element instanceof HTMLButtonElement && element.textContent?.trim() === '完了',
        };
      });

      const deferGroupIndex = children.findIndex((child) => child.isDeferGroup);
      const completeButtonIndex = children.findIndex((child) => child.isCompleteButton);

      let deferGroupOverlapsAnySibling = false;
      if (deferGroupIndex >= 0) {
        const deferGroup = children[deferGroupIndex]!;
        for (let index = 0; index < children.length; index += 1) {
          if (index === deferGroupIndex) {
            continue;
          }
          const sibling = children[index]!;
          const overlaps =
            deferGroup.rect.top < sibling.rect.bottom - edgeTolerance &&
            sibling.rect.top < deferGroup.rect.bottom - edgeTolerance;
          if (overlaps) {
            deferGroupOverlapsAnySibling = true;
          }
        }
      }

      const completeButton =
        completeButtonIndex >= 0 ? children[completeButtonIndex] : undefined;

      let completeButtonSharesRow = false;
      let completeButtonWidthRatio = 0;
      let completeButtonNotSoloFullWidth = false;

      if (completeButton !== undefined) {
        completeButtonWidthRatio =
          container.clientWidth > 0
            ? completeButton.rect.width / container.clientWidth
            : 0;

        for (let index = 0; index < children.length; index += 1) {
          if (index === completeButtonIndex) {
            continue;
          }
          const sibling = children[index]!;
          const sameRow =
            Math.abs(sibling.rect.top - completeButton.rect.top) <= rowTolerance ||
            (completeButton.rect.top < sibling.rect.bottom - edgeTolerance &&
              sibling.rect.top < completeButton.rect.bottom - edgeTolerance);
          if (sameRow) {
            completeButtonSharesRow = true;
            break;
          }
        }

        completeButtonNotSoloFullWidth =
          completeButtonSharesRow ||
          completeButtonWidthRatio < fullWidthRatio;
      }

      const rowTops: number[] = [];
      for (const child of children) {
        const existing = rowTops.find(
          (top) => Math.abs(top - child.rect.top) <= rowTolerance,
        );
        if (existing === undefined) {
          rowTops.push(child.rect.top);
        }
      }

      return {
        containerClientWidth: container.clientWidth,
        rowCount: rowTops.length,
        completeButtonSharesRow,
        completeButtonWidthRatio,
        completeButtonNotSoloFullWidth,
        deferGroupOverlapsAnySibling,
        bodyScrollWidth: document.body.scrollWidth,
        viewportInnerWidth: window.innerWidth,
        horizontalOverflow: document.body.scrollWidth > window.innerWidth,
      };
    },
    {
      rowTolerance: ROW_Y_TOLERANCE_PX,
      edgeTolerance: EDGE_TOLERANCE_PX,
      fullWidthRatio: DETAIL_COMPLETE_FULL_WIDTH_RATIO,
    },
  );
}

function assertBulkButtonsLayout(metrics: BulkButtonsLayoutMetrics, context: string): void {
  expect(
    metrics.deferGroupIndex,
    `${context}: custom defer group (.quick-action-defer-group-custom) must exist`,
  ).toBeGreaterThanOrEqual(0);

  expect(
    metrics.deferGroupOnOwnRow,
    `${context}: custom defer group must sit on its own row (no vertical overlap with siblings). ` +
      `children=${JSON.stringify(metrics.children, null, 2)}`,
  ).toBe(true);

  expect(
    metrics.deferGroupSpansFullRow,
    `${context}: custom defer group row must span the container width ` +
      `(widthRatio=${metrics.deferGroupWidthRatio.toFixed(3)}, ` +
      `containerClientWidth=${metrics.containerClientWidth})`,
  ).toBe(true);

  // 観測点1: 単独全幅行を禁止。同一行に兄弟がいるか、幅がコンテナの 90% 未満なら OK。
  expect(
    metrics.completeButtonNotSoloFullWidth,
    `${context}: complete button must not occupy a solo full-width row ` +
      `(sharesRow=${metrics.completeButtonSharesRow}, ` +
      `widthRatio=${metrics.completeButtonWidthRatio.toFixed(3)}, ` +
      `containerClientWidth=${metrics.containerClientWidth}, ` +
      `children=${JSON.stringify(metrics.children, null, 2)})`,
  ).toBe(true);

  if (!metrics.completeButtonSharesRow) {
    expect(
      metrics.completeButtonWidthRatio,
      `${context}: when complete button is alone on its row, width ratio must stay below ${FULL_WIDTH_RATIO}`,
    ).toBeLessThan(FULL_WIDTH_RATIO);
  }

  expect(
    metrics.horizontalOverflow,
    `${context}: body must not overflow horizontally ` +
      `(body.scrollWidth=${metrics.bodyScrollWidth}, innerWidth=${metrics.viewportInnerWidth})`,
  ).toBe(false);
}

const MOBILE_VIEWPORTS = [
  { width: 375, height: 812, label: '375x812' },
  { width: 480, height: 812, label: '480x812' },
] as const;

for (const viewport of MOBILE_VIEWPORTS) {
  test.describe(`bulk action bar custom defer row @ ${viewport.label}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: true,
      hasTouch: true,
    });

    test('custom defer group occupies its own row without breaking sibling rows', async ({
      page,
    }) => {
      test.setTimeout(60_000);

      await openBoardWithBulkActionBarCustomDefer(page);
      const metrics = await measureBulkButtonsLayout(page);

      assertBulkButtonsLayout(metrics, viewport.label);
    });
  });
}

// 320px カスタム状態について (履歴と現状):
// bdboard-53my の時点で 延期グループ実幅=277px / コンテナ .bulk-action-bar-buttons の
// clientWidth=270 となり、グループ右端 302 がコンテナの内容領域右端 295 を 7px
// はみ出していた (別チケット bdboard-rccf として切り出し)。bdboard-rccf で修正。
// 下の "custom defer group must not overflow" がその回帰ガード。
//
// 計測時の注意: isMobile: true を付けないと別のレイアウトになり、はみ出しが
// 再現しない。必ず test.use({ viewport, isMobile: true, hasTouch: true }) で測ること
// (議長が isMobile 無しの probe で「解消済み」と誤判定した。2026-09-05)。
// 機構: web/src/index.css:7904 の @media (hover: none) and (pointer: coarse) が
// select / input[type=date] を font-size:16px に上げ、これが date 入力を 147px へ
// 押し上げている。**幅のメディアクエリではないので、isMobile 無しでは 320px でも
// 発火しない。**
//
// 重要: body.scrollWidth=320 = innerWidth なので horizontalOverflow は false のまま。
// 理由は2つあり、決定的なのは後者:
//   1. バー自体が左右 25px インセットされており、この 7px はバーの右パディング
//      (12px) に収まってビューポート端に届かない。
//   2. web/src/index.css:158 の body { overflow-x: clip }。body は非スクロールの
//      クリップコンテナなので、**はみ出しがどれだけ大きくても body.scrollWidth は
//      body 幅を超えない**。つまり「もっと大きくはみ出せば horizontalOverflow で
//      捕まる」わけではなく、原理的に捕まらない。
// したがって本ファイルの既存 horizontalOverflow アサーションは、この種のはみ出しに
// 対しては構造的にほぼ vacuous である。「horizontalOverflow=false だから問題なし」と
// 読まないこと。コンテナ基準で測る必要がある。
// index.css コメントの 289px はより広いビューポートでの値。
// この直下の describe は :has() narrowing 用に非カスタム状態だけを見る。
// カスタム状態の回帰ガードはファイル末尾の
// 'bulk action bar custom defer group @ 320x812' describe。
test.describe('bulk action bar non-custom defer row @ 320x812', () => {
  test.use({
    viewport: { width: 320, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test('first row fills container width without trailing gap when defer is not custom', async ({
    page,
  }) => {
    test.setTimeout(60_000);

    await page.goto('/');
    const firstCard = page.locator('article').first();
    await expect(firstCard).toBeVisible({ timeout: 15_000 });

    await selectTickets(page, DEFAULT_BULK_SELECTION_IDS);
    await waitForBulkActionBar(page);

    const metrics = await measureBulkButtonsLayout(page);

    expect(
      metrics.firstRowRightGapPx,
      `320x812 non-custom: first row must not leave trailing gap ` +
        `(firstRowRightGapPx=${metrics.firstRowRightGapPx.toFixed(1)}, ` +
        `firstRowChildCount=${metrics.firstRowChildCount}, ` +
        `containerClientWidth=${metrics.containerClientWidth})`,
    ).toBeLessThanOrEqual(FIRST_ROW_RIGHT_GAP_MAX_PX);

    expect(
      metrics.completeButtonWidthRatio,
      `320x812 non-custom: complete button should grow to fill available row space ` +
        `(widthRatio=${metrics.completeButtonWidthRatio.toFixed(3)})`,
    ).toBeGreaterThanOrEqual(NON_CUSTOM_COMPLETE_MIN_WIDTH_RATIO);

    expect(
      metrics.horizontalOverflow,
      `320x812 non-custom: body must not overflow horizontally ` +
        `(body.scrollWidth=${metrics.bodyScrollWidth}, innerWidth=${metrics.viewportInnerWidth})`,
    ).toBe(false);
  });
});

for (const viewport of MOBILE_VIEWPORTS) {
  // bdboard-53my 条件4: 詳細パネル側を実測した結果、症状は無かった。
  // この describe はその状態を固定する回帰ガード。
  test.describe(`ticket detail quick actions custom defer @ ${viewport.label}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: true,
      hasTouch: true,
    });

    test('detail panel defer controls remain readable without solo full-width complete row', async ({
      page,
    }) => {
      test.setTimeout(60_000);

      // 詳細パネル (.quick-action-buttons) は BulkActionBar と異なり flex: 1 1 auto が無く、
      // 完了ボタンが単独全幅行になる症状は再現しなかった (bdboard-53my 実測済み)。
      await page.goto('/');

      const card = page.locator('article', { hasText: TICKET_TITLE });
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('#comment-text')).toBeVisible({ timeout: 15_000 });

      const deferSelect = dialog.locator('select[aria-label="延期期間"]');
      await expect(deferSelect).toBeVisible();
      await deferSelect.selectOption('custom');
      await expect(dialog.locator('input[type="date"]')).toBeVisible();

      const metrics = await measureDetailQuickButtonsLayout(page);

      // 実測 (2026-09-05): 375px → rowCount=3 / 480px → rowCount=2。行数そのものは
      // ボタン本数とフォント次第で動くのでアサートしない。attach したメトリクスは
      // 将来この画面のレイアウトを追うときの基準値。
      await test.info().attach(`detail-panel-metrics-${viewport.label}`, {
        body: JSON.stringify(metrics, null, 2),
        contentType: 'application/json',
      });

      expect(
        metrics.horizontalOverflow,
        `${viewport.label} detail panel: body must not overflow horizontally ` +
          `(body.scrollWidth=${metrics.bodyScrollWidth}, innerWidth=${metrics.viewportInnerWidth})`,
      ).toBe(false);

      // 詳細パネル側には BulkActionBar のような `.btn { flex: 1 1 auto }` が無いため、
      // 完了ボタンは伸長せず単独全幅行にならない (実測: 375px で widthRatio=0.158 /
      // 480px で 0.121、いずれも同一行に兄弟あり)。閾値 0.5 は実測の 3 倍以上の
      // マージンを残し、「詳細パネルにも flex 伸長が入った」級の退行を捕まえる。
      //
      // 注意: BulkActionBar 側と違い取り除くべき CSS 規則がそもそも存在しないため、
      // 等価な変異実験は作れない。閾値 0.5 でも実測 0.158/0.121 と余裕があるが、
      // 旧 0.9 よりは検出力が高い (bdboard-53my 議長裁定 2026-09-05)。
      expect(
        metrics.completeButtonNotSoloFullWidth,
        `${viewport.label} detail panel: complete button must not occupy a solo full-width row ` +
          `(sharesRow=${metrics.completeButtonSharesRow}, ` +
          `widthRatio=${metrics.completeButtonWidthRatio.toFixed(3)}, ` +
          `containerClientWidth=${metrics.containerClientWidth})`,
      ).toBe(true);
    });
  });
}

// bdboard-rccf: カスタム延期状態でのコンテナ基準はみ出し回帰ガード。
// 上のコメントのとおり body 基準では検出できないので、コンテナの
// scrollWidth/clientWidth と、グループおよびその各子の右端とコンテナ内容領域右端の
// 差で測る。

test.describe('bulk action bar custom defer group @ 320x812', () => {
  test.use({
    viewport: { width: 320, height: 812 },
    isMobile: true,
    hasTouch: true,
  });

  test('custom defer group must not overflow its container', async ({ page }) => {
    test.setTimeout(60_000);

    const bar = await openBoardWithBulkActionBarCustomDefer(page);
    // 実利用に近い状態で測るために日付を入れる。**幅は値の有無で変わらない**
    // (実測 2026-09-05: 空でも入力後でも 136.203125px)。Chromium の date 入力は
    // 年4桁/月2桁/日2桁 + ピッカーアイコンのフィールドテンプレートで固有幅が
    // 決まるため。min 属性 (todayLocalDateInputValue) を下回ると :invalid になる
    // ので、固定日ではなく当日基準で作る。
    const deferDate = await page.evaluate(() => {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    });
    await bar.locator('input[type="date"]').fill(deferDate);

    const metrics = await page.evaluate(() => {
      const container = document.querySelector('.bulk-action-bar .bulk-action-bar-buttons');
      if (container === null) {
        throw new Error('.bulk-action-bar .bulk-action-bar-buttons not found');
      }
      const group = container.querySelector(
        '.quick-action-defer-group.quick-action-defer-group-custom',
      );
      if (group === null) {
        throw new Error('.quick-action-defer-group-custom not found');
      }
      const containerRect = container.getBoundingClientRect();
      const groupRect = group.getBoundingClientRect();
      const style = window.getComputedStyle(container);
      // getBoundingClientRect() は border box、clientWidth は padding box なので
      // left + clientWidth は border-left の分だけずれる。右端から border-right と
      // padding-right を引くほうが border の有無に依らず正しく、小数のまま扱える
      // (clientWidth は整数丸め)。現状このコンテナは border も padding も 0。
      const contentBoxRight =
        containerRect.right -
        (Number.parseFloat(style.borderRightWidth) || 0) -
        (Number.parseFloat(style.paddingRight) || 0);

      const date = group.querySelector('input[type="date"]') as HTMLElement | null;
      if (date === null) {
        throw new Error('custom defer date input not found');
      }

      // date 入力が「縮み過ぎていない」ことを、固定の px 閾値ではなく
      // 素の date 入力の自然幅との比で測る。CI (Linux) とローカル (macOS) で
      // フォントが違い実寸が動くため、絶対値の閾値は脆い。
      //
      // 参照値はコンテナを広げて測り直すのでは**不十分**。max-width / width の
      // ような幅を直接止めるルールは広げた側にも効くので比が 1.0 のままになり、
      // 潰れを検出できない (実測 2026-09-05: max-width:90px を入れても
      // この方式では通ってしまった)。そこでグループの外に素の date 入力を
      // 一時的に置いて自然幅を採る。position:absolute + visibility:hidden で
      // 本体のレイアウトを乱さず、font-size は同じ
      // @media (hover:none) and (pointer:coarse) を受ける。
      const constrainedDateWidth = date.getBoundingClientRect().width;
      const probe = document.createElement('input');
      probe.type = 'date';
      probe.style.position = 'absolute';
      probe.style.left = '0';
      probe.style.top = '0';
      probe.style.visibility = 'hidden';
      document.body.append(probe);
      const unconstrainedDateWidth = probe.getBoundingClientRect().width;
      probe.remove();

      return {
        containerClientWidth: container.clientWidth,
        containerScrollWidth: container.scrollWidth,
        contentBoxRight,
        groupRight: groupRect.right,
        groupWidth: groupRect.width,
        overflowPx: groupRect.right - contentBoxRight,
        // グループ自身が収まっていても、子だけがはみ出す退行がありうる
        // (実測 2026-09-05: 子側の min-width:0 だけを外すと overflowPx は 0 のまま
        //  で、container の scrollWidth 側だけが 277 になって落ちた)。犯人を
        //  失敗メッセージで名指しできるよう子ごとに測る。
        childOverflow: Array.from(group.children).map((el) => ({
          tag: el.tagName.toLowerCase(),
          overflowPx: el.getBoundingClientRect().right - contentBoxRight,
        })),
        constrainedDateWidth,
        unconstrainedDateWidth,
        dateShrinkRatio: constrainedDateWidth / unconstrainedDateWidth,
        bodyScrollWidth: document.body.scrollWidth,
        viewportInnerWidth: window.innerWidth,
      };
    });

    await test.info().attach('custom-defer-group-metrics', {
      body: JSON.stringify(metrics, null, 2),
      contentType: 'application/json',
    });

    expect(
      metrics.overflowPx,
      `320x812 custom: defer group must not overflow the container content box ` +
        `(groupRight=${metrics.groupRight.toFixed(2)}, ` +
        `contentBoxRight=${metrics.contentBoxRight.toFixed(2)}, ` +
        `overflowPx=${metrics.overflowPx.toFixed(2)}, ` +
        `groupWidth=${metrics.groupWidth.toFixed(2)})`,
    ).toBeLessThanOrEqual(CONTAINER_OVERFLOW_TOLERANCE_PX);

    const worstChild = metrics.childOverflow.reduce((worst, c) =>
      c.overflowPx > worst.overflowPx ? c : worst,
    );
    expect(
      worstChild.overflowPx,
      `320x812 custom: no child of the defer group may overflow the container ` +
        `content box (worst=<${worstChild.tag}> ${worstChild.overflowPx.toFixed(2)}px; ` +
        `all=${JSON.stringify(metrics.childOverflow)})`,
    ).toBeLessThanOrEqual(CONTAINER_OVERFLOW_TOLERANCE_PX);

    expect(
      metrics.containerScrollWidth,
      `320x812 custom: container must not scroll horizontally ` +
        `(scrollWidth=${metrics.containerScrollWidth}, ` +
        `clientWidth=${metrics.containerClientWidth}). ` +
        `body.scrollWidth=${metrics.bodyScrollWidth} innerWidth=${metrics.viewportInnerWidth} ` +
        `— body 基準では検出できないので、この2つで測ること。`,
    ).toBeLessThanOrEqual(metrics.containerClientWidth);

    // min-width: 0 を入れた以上、date 入力が際限なく縮む方向の退行がありうる。
    // **input[type=date].scrollWidth で測ってはいけない** — Chromium の date 入力は
    // shadow DOM の ::-webkit-datetime-edit に overflow:hidden を持つため、
    // 幅をいくら縮めても scrollWidth は clientWidth と等しいままで、
    // scrollWidth <= clientWidth のアサーションは常に真になる (実測 2026-09-05:
    // 幅を 30px に潰しても clientWidth=26 / scrollWidth=26)。
    // 代わりにグループ外に置いた素の date 入力の自然幅との比で測る。実測の比は
    // 0.927 (136.203125 / 147) なので、0.85 はフォント差を吸収しつつ実際の潰れを
    // 捕まえる。max-width:90px を入れるミューテーションで赤くなることを確認済み。
    expect(
      metrics.dateShrinkRatio,
      `320x812 custom: date input must keep most of the natural width of a bare ` +
        `date input ` +
        `(constrained=${metrics.constrainedDateWidth.toFixed(2)}, ` +
        `unconstrained=${metrics.unconstrainedDateWidth.toFixed(2)}, ` +
        `ratio=${metrics.dateShrinkRatio.toFixed(3)})`,
    ).toBeGreaterThanOrEqual(DATE_INPUT_MIN_SHRINK_RATIO);
  });
});
