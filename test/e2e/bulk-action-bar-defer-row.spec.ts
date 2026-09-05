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

// 320px カスタム状態は実測済み (2026-09-05, chromium, isMobile): body.scrollWidth=320,
// innerWidth=320, 延期グループ実幅=277px, horizontalOverflow=false。index.css コメントの
// 289px はより広いビューポートでの値で、320px では date 入力が縮んで収まる。
// この describe は :has() narrowing 用に非カスタム状態だけを見る。
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
